import { calcDate } from './business-days.mjs';
import { kougakuGendo } from './kougaku.mjs';
import { simulateCashflow } from './ledger.mjs';
import { mealCost } from './meals.mjs';
import { InputError, deepFreeze, requireObject } from './validate.mjs';

// Claude に渡す道具（tool）の定義。金額と日付は、ここにある計算だけが出す。
// strict: true なので、すべての項目を required に入れ、additionalProperties を false にする。
// 数値や文字数の範囲は JSON Schema に書けないので、各計算の入口で確かめる。

const dateProperty = (description) => ({ type: 'string', format: 'date', description });
const yenProperty = (description) => ({ type: 'integer', description });

function objectSchema(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export const TOOLS = deepFreeze([
  {
    name: 'kougaku_gendo',
    description: [
      '入院の保険診療分について、高額療養費の自己負担限度額（1 か月の上限）と、病院の窓口で払う額を計算する。',
      '窓口で上限が適用される場合と、適用されずにいったん 3 割などを払って後から払い戻しを受ける場合の両方を返す。',
      '入院費の話が出て、費用の見積もり（病院の概算でも、仮に置いた幅でもよい）があるときは、自分で計算せずに必ずこれを呼ぶ。',
      '持っている表は、70 歳未満・協会けんぽ・2026 年 8 月〜2027 年 7 月の診療分だけ。',
      '所得区分が分からないときは「不明」を渡すと、5 つの区分を並べて返す。月をまたぐ入院は、月ごとに分けて呼ぶ。',
      '食事代や差額ベッド代は含まれない。',
    ].join(''),
    strict: true,
    input_schema: objectSchema({
      treatment_month: { type: 'string', description: '診療を受ける月。YYYY-MM の形（例: 2026-11）。' },
      income_category: {
        type: 'string',
        enum: ['ア', 'イ', 'ウ', 'エ', 'オ', '不明'],
        description: '高額療養費の所得区分。利用者が区分を言っていないときは「不明」にする。推測で決めない。',
      },
      amount_basis: {
        type: 'string',
        enum: ['total', 'copay'],
        description: 'amount_low と amount_high が何の額かを示す。total は保険診療の総医療費（10 割）。copay は窓口負担の額（病院から「3 割負担で約○万円」と聞いた概算など）。',
      },
      amount_low: yenProperty('金額の下限（円）。1 つの額しか無いときは、amount_high と同じ値にする。'),
      amount_high: yenProperty('金額の上限（円）。'),
      copay_percent: {
        type: 'integer',
        enum: [30, 20],
        description: '窓口負担の割合（%）。70 歳未満は 30。小学校に入る前の子どもは 20。',
      },
    }),
  },
  {
    name: 'meal_cost',
    description: [
      '入院中の食事代（1 食ごとに決まっている自己負担）を、入院日数から多めに見積もる。',
      '入院日数が分かったとき、または仮の日数を置いたときに呼ぶ。食事代を自分で掛け算しない。',
      '一般の区分の額だけを持っている。食事代は高額療養費の対象外なので、kougaku_gendo の結果とは別に足す。',
    ].join(''),
    strict: true,
    input_schema: objectSchema({
      days_low: { type: 'integer', description: '入院日数の下限。入院する日と退院する日を含む日数で、泊数ではない（calc_date の days_inclusive に当たる）。' },
      days_high: { type: 'integer', description: '入院日数の上限。1 つの日数しか無いときは、days_low と同じ値にする。' },
    }),
  },
  {
    name: 'calc_date',
    description: [
      '日付を計算する。使い方は 2 つ。',
      '(1) 始まりの日から、段取りを順につないで、それぞれの日付と曜日を出す（例: 診断書の完成まで 2 週間 → 郵送に 1 日 → 翌日から 5 営業日目に送金）。',
      '(2) 2 つの日付のあいだの日数を出す（入院日数、入院までの残り日数など）。',
      '日付・曜日・日数・営業日は、自分で数えずに必ずこれを呼ぶ。',
      '営業日は、土日・祝日・12/31〜1/3 を除いて数える（2026 年と 2027 年だけ）。',
    ].join(''),
    strict: true,
    input_schema: objectSchema({
      start_date: dateProperty('始まりの日。YYYY-MM-DD の形。'),
      steps: {
        type: 'array',
        description: '順につなぐ段取り。それぞれ、前の段取りで出た日付から数える。日数だけを知りたいときは空の配列にする。',
        items: objectSchema({
          label: { type: 'string', description: '段取りの名前（例: 診断書の完成、保険会社に到着、送金）。' },
          unit: {
            type: 'string',
            enum: ['day', 'week', 'business_day', 'month'],
            description: '数える単位。day は暦の日、week は週、month は月（行き先の月に同じ日が無ければ月末）、business_day は「翌日から数えて count 営業日目」。',
          },
          count: { type: 'integer', description: '進める数。day・week・month は、負の数にすると前へさかのぼる。business_day は 0 以上（0 は、その日が休みなら次の営業日）。' },
        }),
      },
      until_date: {
        anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
        description: '始まりの日からこの日までの日数を知りたいときに指定する。要らないときは null。',
      },
    }),
  },
  {
    name: 'simulate_cashflow',
    description: [
      '支払いと入金を日付順に並べ、始まりの日に手元に要る額、不足する額、不足が始まる日を計算する。',
      '筋書きを 4 つまで並べて比べられる（例: 窓口で上限が適用される／されない、給付が早く入る／遅れる／入らない、退院後の支払いが 0 回／3 回）。',
      '見通しを示すとき、条件が変わったとき（入院が長引いたら、給付が遅れたら、通う回数が増えたら）、合計や差額が要るときは、自分で足し引きせずに必ずこれを呼ぶ。',
      '金額に幅があるときは、amount_low と amount_high に分けて渡す。確認できていない入金を除いた場合も、あわせて返す。',
      '家計簿ではない。渡した入出金だけを比べる。',
    ].join(''),
    strict: true,
    input_schema: objectSchema({
      start_date: dateProperty('見通しを始める日。ふつうは今日。YYYY-MM-DD の形。'),
      cash_on_hand: {
        anyOf: [{ type: 'integer' }, { type: 'null' }],
        description: 'この支払いに使える手元のお金（円）。利用者が言っていないときは null にする。推測で入れない。',
      },
      scenarios: {
        type: 'array',
        description: '比べる筋書き。1 つ以上 4 つまで。1 つ目を基準にして、2 つ目以降との差も返す。',
        items: objectSchema({
          name: { type: 'string', description: '筋書きの名前（例: 窓口で上限が適用される場合）。ほかの筋書きと重ならない名前にする。' },
          events: {
            type: 'array',
            description: 'この筋書きに置く支払いと入金。1 つ以上 30 個まで。筋書きごとに、共通の入出金も含めてすべて書く。',
            items: objectSchema({
              date: dateProperty('支払う日、または入金される日。YYYY-MM-DD の形。見通しを始める日より前は置けない。'),
              label: { type: 'string', description: '何の支払い・入金か（例: 入院費の保険診療分、差額ベッド代、給付金）。' },
              direction: { type: 'string', enum: ['out', 'in'], description: 'out は支払い、in は入金。' },
              amount_low: yenProperty('金額の下限（円）。1 つの額しか無いときは、amount_high と同じ値にする。'),
              amount_high: yenProperty('金額の上限（円）。'),
              certainty: {
                type: 'string',
                enum: ['confirmed', 'estimate', 'assumption'],
                description: '確かさ。confirmed は、病院・保険会社・保険者などに利用者が確かめた額と日付。estimate は、見積もりや概算として聞いた額。assumption は、まだ分からないので仮に置いたもの。迷ったら assumption にする。',
              },
            }),
          },
        }),
      },
    }),
  },
]);

const HANDLERS = Object.freeze({
  kougaku_gendo: kougakuGendo,
  meal_cost: mealCost,
  calc_date: calcDate,
  simulate_cashflow: simulateCashflow,
});

// 道具を実行する。入力が受け付けられないときは例外にせず、理由を返す（モデルが呼び方を直せるように）。
// 計算そのものの不具合は握りつぶさず、そのまま投げる。
export function executeTool(name, input) {
  if (!Object.hasOwn(HANDLERS, name)) {
    return {
      ok: false,
      error: `「${name}」という道具はありません。使える名前は ${Object.keys(HANDLERS).join('、')} です。大文字と小文字も合わせてください。`,
    };
  }
  try {
    requireObject(input, '入力');
    return { ok: true, output: HANDLERS[name](input) };
  } catch (error) {
    if (error instanceof InputError) return { ok: false, error: error.message };
    throw error;
  }
}
