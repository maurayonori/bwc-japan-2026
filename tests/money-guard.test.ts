import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReply } from "../lib/money/guard";
import { executeTool } from "../lib/money/tools";
import { legacyCashflowInput } from "./helpers/legacy-cashflow";

const today = '2026-11-06';

function eventOf(name: string, input: unknown) {
  return { id: 'toolu_1', name, input, ...executeTool(name, input) };
}

const kougaku = eventOf('kougaku_gendo', {
  treatment_month: '2026-11', income_category: 'ウ', amount_basis: 'copay',
  amount_low: 300_000, amount_high: 300_000, copay_percent: 30,
});

const cashflow = eventOf('simulate_cashflow', {
  start_date: today,
  cash_on_hand: null,
  scenarios: [{
    name: '窓口で上限が適用される場合',
    events: [
      { date: '2026-11-16', label: '入院費', direction: 'out', amount_low: 92_940, amount_high: 92_940, certainty: 'estimate' },
      { date: '2026-11-16', label: '保険の対象外の費用', direction: 'out', amount_low: 30_000, amount_high: 70_000, certainty: 'assumption' },
      { date: '2026-11-30', label: '家賃', direction: 'out', amount_low: 150_000, amount_high: 150_000, certainty: 'confirmed' },
    ],
  }],
});

const dates = eventOf('calc_date', {
  start_date: '2026-12-25', steps: [{ label: '送金', unit: 'business_day', count: 5 }], until_date: null,
});

const check = (reply: string | null, overrides = {}) => checkReply({
  reply, toolEvents: [kougaku, cashflow, dates], userTexts: ['手元には 30 万円くらいあります。入院は 11/9 からです。'], today, ...overrides,
});

test('道具の結果にある金額と日付だけなら、何も指摘しない', () => {
  const reply = '窓口で払う保険診療分は 92,940 円です。11/30（月）までに、少なくとも 272,940 円、多ければ 312,940 円が要ります。';
  assert.deepEqual(check(reply), []);
});

test('どこにも無い金額を指摘する', () => {
  const warnings = check('合計で 123,456 円ほどになります。');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'amount');
  assert.match(warnings[0].message, /123,456 円/);
});

test('「万円」の書き方でも、同じ額として照らす', () => {
  assert.deepEqual(check('見積もりの 30 万円のうち、戻るのは 207,060 円です。'), []);
  assert.equal(check('ざっと 31 万円です。').length, 1);
});

test('「A〜B 円」の幅は、両端を照らす', () => {
  assert.deepEqual(check('要る額は 272,940〜312,940 円です。'), []);
  assert.deepEqual(check('対象外の費用は 3〜7 万円と仮に置きました。'), []);
  const warnings = check('要る額は 250,000〜312,940 円です。');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /250,000/);
});

test('利用者が言った金額と、道具に渡した仮の金額は、書いてよい', () => {
  assert.deepEqual(check('手元の 300,000 円と比べます。家賃の 150,000 円は確かめた額として置きました。'), []);
});

test('「持っている事実」にある金額は、書いてよい', () => {
  assert.deepEqual(check('食事代は 1 食 550 円です。診断書は 5,830 円の例があります。平均は 18.7 万円です。', { toolEvents: [] }), []);
});

test('累計や差額のように、結果では負の値になっている額は、符号なしで書いてよい', () => {
  // 11/16 までの支払いの累計は、道具の結果では −122,940（cumulative_net）としてだけ出ている。
  assert.deepEqual(check('11/16（月）までの支払いは、少なめの場合で 122,940 円です。'), []);
  assert.deepEqual(check('累計は −122,940 円です。'), []);
});

test('道具の結果の説明文にある金額（区分の条件など）は、書いてよい', () => {
  // 実際の会話で出た書き方。「28 万〜50 万円」は、道具の結果の condition（文字列）にだけある。
  assert.deepEqual(check('標準報酬月額が 30 万円なら、所得の区分は「ウ」（28 万〜50 万円）です。'), []);
});

test('全角の数字と区切りも読む', () => {
  assert.deepEqual(check('窓口では ９２，９４０円 です。'), []);
  assert.equal(check('窓口では ９９，９９９円 です。').length, 1);
});

test('道具の結果にある日付は、書き方が違っても通す', () => {
  assert.deepEqual(check('11/16（月）に払い、11 月 30 日に家賃、送金は 2027-01-05 です。'), []);
});

test('どこにも無い日付を指摘する', () => {
  const warnings = check('給付金は 12/20 に入ります。');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'date');
  assert.match(warnings[0].message, /12\/20/);
});

test('今日の日付、利用者が言った日付、道具の説明文にある日付は通す', () => {
  assert.deepEqual(check('今日（11/6）から数えます。入院は 11/9 ですね。営業日は 12/31〜1/3 を除いて数えました。'), []);
});

test('同じ指摘は 1 回にまとめる', () => {
  assert.equal(check('123,456 円です。もう一度言うと 123,456 円です。').length, 1);
});

test('返答が無いときは、何も指摘しない', () => {
  assert.deepEqual(check(null), []);
  assert.deepEqual(check(''), []);
});

test('割合や回数など、円でも日付でもない数字は見ない', () => {
  assert.deepEqual(check('3 割負担で、5 営業日、2 回の通院、67.6% の人が使っています。'), []);
});

test('「まず確かめる 1 つ」の前後の幅は、資金繰りの計算結果だけで通る', () => {
  const input = legacyCashflowInput(); // 幅 209,060 円。先頭を確かめると 60,000 円残る
  const args = { toolEvents: [eventOf('simulate_cashflow', input)], userTexts: [], today };
  assert.deepEqual(checkReply({ reply: '要る額の幅は 209,060 円から 60,000 円に縮みます。', ...args }), []);
  const warnings = checkReply({ reply: '要る額の幅は 209,060 円から 59,000 円に縮みます。', ...args });
  assert.deepEqual(warnings.map((warning) => warning.shown), ['59,000 円']);
});

// #46 の再現（架空）。窓口で上限が適用されるかが分からず、適用されても所得の区分で幅が残る場合。
// 手元に要る額は 60,000〜263,100 円で、先頭の確認をしても幅は 203,100 円のまま（shrink が 0）。
const hospitalEvent = (label: string, low: number, high: number, certainty = 'estimate') => ({
  date: '2026-12-23', label, direction: 'out', amount_low: low, amount_high: high, certainty,
});
const NO_SHRINK_INPUT = {
  start_date: today,
  cash_on_hand: null,
  scenarios: [
    {
      name: '窓口で上限が適用される場合（区分が不明なので幅）',
      events: [hospitalEvent('入院費（保険診療分）', 36_900, 240_000, 'assumption'), hospitalEvent('入院中の食事代', 23_100, 23_100)],
    },
    {
      name: 'いったん 3 割を払う場合',
      events: [hospitalEvent('入院費（保険診療分）', 240_000, 240_000), hospitalEvent('入院中の食事代', 23_100, 23_100)],
    },
  ],
};
const noShrink = eventOf('simulate_cashflow', NO_SHRINK_INPUT);
const checkNoShrink = (reply: string, toolEvents: unknown[] = [noShrink]) =>
  checkReply({ reply, toolEvents: toolEvents as Parameters<typeof checkReply>[0]['toolEvents'], userTexts: [], today });

test('#46 の計算は、いまの幅も確かめると残る幅も 203,100 円（先頭の shrink が 0）', () => {
  const confirm = (noShrink as { output?: { what_to_confirm?: { need_low: number; need_high: number; width: number; factors: { shrink: number; width_if_resolved: number }[] } } }).output?.what_to_confirm;
  assert.ok(confirm);
  assert.deepEqual([confirm.need_low, confirm.need_high, confirm.width], [60_000, 263_100, 203_100]);
  assert.equal(confirm.factors[0].shrink, 0);
  assert.equal(confirm.factors[0].width_if_resolved, 203_100);
});

test('幅が縮まない確認なのに「縮みます」と書いた文は、数字が合っていても指摘する', () => {
  const warnings = checkNoShrink('まず確かめる 1 つは、窓口で上限が適用されるかです。病院の会計に聞くと、要る額の幅は 203,100 円に縮みます。');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'amount');
  assert.equal(warnings[0].shown, '病院の会計に聞くと、要る額の幅は 203,100 円に縮みます');
  assert.match(warnings[0].message, /縮みません/);
  assert.match(warnings[0].message, /いまの幅 203,100 円、確かめると残る幅 203,100 円/);
  // カードの本文も同じように照らす（返答とカードはまとめて渡される）。
  assert.equal(checkNoShrink('窓口で聞けば、幅は縮められます。').length, 1);
});

test('答えごとに何が決まるかを書いた文と、縮まないと書いた文は通す', () => {
  assert.deepEqual(
    checkNoShrink('まず確かめる 1 つは、窓口で上限が適用されるかです。適用されないなら 263,100 円に決まります。適用されるなら、所得の区分によって 60,000〜263,100 円の幅が残ります。'),
    [],
  );
  assert.deepEqual(checkNoShrink('この確認だけでは、答えによっては幅が縮みません。'), []);
  assert.deepEqual(checkNoShrink('確かめても、幅が縮むとは限りません。区分が分からないと、幅は縮まないままです。'), []);
});

test('先頭の shrink が 0 より大きければ、「A 円から B 円に縮みます」はそのまま通す', () => {
  // 2 ターン目に当たる計算: 窓口で上限が適用されないと分かり、区分の幅だけが残る場合ではなく、確かめれば幅が 0 になる場合。
  const shrinks = eventOf('simulate_cashflow', {
    start_date: today,
    cash_on_hand: null,
    scenarios: [{ name: '窓口で上限が適用される場合', events: [hospitalEvent('入院費（保険診療分）', 36_900, 240_000), hospitalEvent('入院中の食事代', 23_100, 23_100)] }],
  });
  const confirm = (shrinks as { output?: { what_to_confirm?: { width: number; factors: { shrink: number }[] } } }).output?.what_to_confirm;
  assert.equal(confirm?.width, 203_100);
  assert.equal(confirm?.factors[0].shrink, 203_100);
  assert.deepEqual(checkNoShrink('所得の区分を聞くと、要る額の幅は 203,100 円から 0 円に縮みます。', [shrinks]), []);
});

test('答えを反映したターンで、前の計算の幅から今の幅まで縮んだと伝える文は通す', () => {
  const input = legacyCashflowInput();
  const before = eventOf('simulate_cashflow', input); // 幅 209,060 円
  assert.deepEqual(checkNoShrink('答えを入れると、要る額の幅は 209,060 円から 203,100 円に縮みました。', [before, noShrink]), []);
  // 前の計算が無ければ、同じ「縮みました」でも見当たらない金額として指摘が出る。
  assert.ok(checkNoShrink('答えを入れると、要る額の幅は 209,060 円から 203,100 円に縮みました。').length >= 1);
  // 確かめて幅が無くなった（今の見通しに不明点が無い）ときは、縮んだと伝えてよい。
  const settled = eventOf('simulate_cashflow', { ...NO_SHRINK_INPUT, scenarios: [NO_SHRINK_INPUT.scenarios[1]] });
  assert.deepEqual(checkNoShrink('窓口で上限が適用されないと分かったので、要る額の幅は 203,100 円から 0 円に縮みました。', [noShrink, settled]), []);
});

// 11/8 の実 API の評価で、英語の発言の「350,000 yen」を Claude が「35万円」と書き、照らせない金額として伏せられた。
test('英語の発言の「yen」「JPY」の額も、利用者が言った額として照らす', () => {
  const userTexts = ['My salary is about 350,000 yen a month, and I have JPY 200,000 in cash.'];
  assert.deepEqual(check('月給35万円で、手元は20万円です。', { userTexts }), []);
  assert.equal(check('月給36万円です。', { userTexts }).length, 1);
});

// 11/8 の実 API の評価で、発言の「12月5日から15日まで」の「15日」を Claude が「12/15」と書き、照らせない日付としてカードが落ちた（3 回中 1 回）。
test('発言の「12月5日から15日まで」の後ろの日は、前の月を借りて日付として照らす', () => {
  const said = (text: string, reply: string) => check(reply, { userTexts: [text] });
  assert.deepEqual(said('12月5日から15日まで入院です。', '12/15 の退院までに聞きます。'), []);
  assert.deepEqual(said('12月14日に入院して、28日に退院する予定です。', '12/28 に払います。'), []);
  // 後ろの日が小さければ、次の月とも読む
  assert.deepEqual(said('12月24日から5日まで入院です。', '1/5 に退院します。'), []);
  // 話していない日と、日数の「15日間」は借りない
  assert.equal(said('12月5日から15日まで入院です。', '12/16 に払います。').length, 1);
  assert.equal(said('12月5日から15日間入院です。', '12/15 に払います。').length, 1);
});
