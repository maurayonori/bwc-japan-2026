import { calcDate } from "./money/business-days";
import { showDate, yen, yenRange } from "./money/format";
import { kougakuGendo } from "./money/kougaku";
import { simulateCashflow } from "./money/ledger";
import type { WhatToConfirm } from "./money/schema";
import { mealCost } from "./money/meals";
import { type Proposal, type Workspace } from "./workspace";

const TODAY = "2026-11-06";
const ADMISSION = "2026-11-16";
const DISCHARGE = "2026-11-30";
const COPAY_LOW = 240_000;
const COPAY_HIGH = 300_000;

// 数字は手で書かず、本番と同じ計算関数で作る。文章の数字も、その結果を埋める。
function exampleMoney(
  messageId: string,
  quote: string,
): { card: Proposal; confirm: WhatToConfirm } {
  const kougakuInput = {
    treatment_month: "2026-11",
    income_category: "ウ",
    amount_basis: "copay",
    amount_low: COPAY_LOW,
    amount_high: COPAY_HIGH,
    copay_percent: 30,
  };
  const kougaku = kougakuGendo(kougakuInput);
  const dateInput = { start_date: ADMISSION, steps: [], until_date: DISCHARGE };
  const stay = calcDate(dateInput);
  const days = stay.until?.days_inclusive ?? 1;
  const mealInput = { days_low: days, days_high: days };
  const meals = mealCost(mealInput);
  const { low, high } = kougaku.cases[0];
  const mealEvent = {
    date: DISCHARGE,
    label: "入院中の食事代",
    direction: "out",
    amount_low: meals.low.cost_max,
    amount_high: meals.high.cost_max,
    certainty: "estimate",
  };
  const capName = "窓口で上限が適用される場合";
  const fullName = "いったん 3 割を払う場合";
  const cashflowInput = {
    start_date: TODAY,
    cash_on_hand: null,
    scenarios: [
      {
        name: capName,
        events: [
          {
            date: DISCHARGE,
            label: "入院費（保険診療分）",
            direction: "out",
            amount_low: low.pay_with_cap,
            amount_high: high.pay_with_cap,
            certainty: "estimate",
          },
          mealEvent,
        ],
      },
      {
        name: fullName,
        events: [
          {
            date: DISCHARGE,
            label: "入院費（保険診療分）",
            direction: "out",
            amount_low: low.copay_without_cap,
            amount_high: high.copay_without_cap,
            certainty: "estimate",
          },
          mealEvent,
        ],
      },
    ],
  };
  const cashflow = simulateCashflow(cashflowInput);
  const [withCap, withoutCap] = cashflow.scenarios;
  if (!cashflow.what_to_confirm) throw new Error("no-what-to-confirm");
  const card: Proposal = {
    id: "hospital-money",
    kind: "money",
    title: "退院の日までに、手元に要る額",
    body: [
      `窓口で上限が適用されれば、${showDate(DISCHARGE)}に手元に要る額は ${yenRange(withCap.low_case.need, withCap.high_case.need)} です。上限が適用されず、いったん 3 割を払うなら ${yenRange(withoutCap.low_case.need, withoutCap.high_case.need)} です。`,
      "幅を一番大きく動かすのは、窓口で上限が適用されるかです。[F02]",
      "給付金は、まだ数えていません。",
    ].join("\n"),
    nextStep: "病院の会計で、窓口で上限を適用できるかを聞く。",
    uncertainty:
      "入院費は病院の概算です。保険の給付金が出るか、いつ入るかは、契約先への確認が必要です。",
    evidence: [{ messageId, quote }],
    money: {
      calculations: [
        { name: "kougaku_gendo", input: kougakuInput, output: kougaku },
        { name: "meal_cost", input: mealInput, output: meals },
        { name: "calc_date", input: dateInput, output: stay },
        {
          name: "simulate_cashflow",
          input: cashflowInput,
          output: cashflow,
        },
      ],
    },
  };
  return { card, confirm: cashflow.what_to_confirm };
}

const HOSPITAL_DESK_QUOTE = "病院からは3割負担で24万〜30万円と聞いた。";

// 架空の体験例。AIがその場で生成した回答としては表示しない。
export function exampleWorkspace(): Workspace {
  const first =
    "再来週から2週間、検査のために家を空けます。家ではいつも自分が子どもの朝の支度とごみ出しをしています。家族には一度にいろいろ頼まず、朝のことから渡せるメモを作りたい。";
  const second =
    "朝は7時に起きて、着替えは寝室の白い棚。水筒をかばんの横に置き、8時10分に家を出ます。保険の書類は青いファイルにあるけど、今回の検査入院が対象かまだ確認していない。";
  const third =
    "残しておきたいこともある。今日、一緒にホットケーキを焼いた。ひっくり返せて、ふたりで拍手した。これをそのままメモに残したい。";
  const moneyQuote =
    "11/16から11/30まで入院の予定で、協会けんぽ、標準報酬月額は34万円。病院からは3割負担で24万〜30万円と聞いた。";
  const fourth = `${moneyQuote}給付金はまだ数えないで、手元にいくら要るかを見たい。`;
  const money = exampleMoney("example-4", moneyQuote);
  const [top] = money.confirm.factors;
  return {
    version: 2,
    mode: "example",
    messages: [
      { id: "example-1", role: "user", text: first },
      { id: "example-2", role: "user", text: second },
      { id: "example-3", role: "user", text: third },
      { id: "example-4", role: "user", text: fourth },
      {
        id: "example-reply",
        role: "assistant",
        text: [
          "朝の引き継ぎメモと、保険会社と病院の会計へ聞く文章を用意しました。今日の出来事は、話した言葉のまま残しています。手元に要る額は、話してくれた概算で計算して表にしました。",
          `まず確かめる 1 つは、窓口で上限が適用されるかです。病院の会計に聞くと、要る額の幅は ${yen(money.confirm.width)}から ${yen(top.width_if_resolved)}に縮みます。`,
        ].join("\n"),
        tools: ["kougaku_gendo", "meal_cost", "calc_date", "simulate_cashflow"],
      },
    ],
    cards: [
      {
        id: "morning",
        kind: "daily",
        title: "朝の支度を、ひと目で",
        body: "7:00　起きる\n着替え：寝室の白い棚\n水筒：かばんの横に置く\n8:10　家を出る",
        nextStep: "朝の流れに抜けがないか読み返す。",
        uncertainty: "家族の誰が担当できるかは、まだ相談していません。",
        evidence: [
          {
            messageId: "example-2",
            quote:
              "朝は7時に起きて、着替えは寝室の白い棚。水筒をかばんの横に置き、8時10分に家を出ます。",
          },
        ],
        edited: false,
        done: false,
        included: false,
      },
      {
        id: "insurance",
        kind: "contact",
        title: "保険会社に、このまま聞く",
        body: "検査のため、再来週から2週間入院する予定です。\n加入している契約で、今回の検査入院は給付の対象になりますか。\n対象の場合、請求に必要な書類、退院前に病院へ依頼しておくもの、請求できる時期を教えてください。\n自分で手続きできない間に家族が請求するための準備があれば、あわせて教えてください。\n\n契約の書類の場所：青いファイル",
        nextStep: "青いファイルで契約先と問い合わせ先を確かめる。",
        uncertainty:
          "給付の対象・必要書類・入金時期は、契約先への確認が必要です。",
        evidence: [
          {
            messageId: "example-1",
            quote: "再来週から2週間、検査のために家を空けます。",
          },
          {
            messageId: "example-2",
            quote:
              "保険の書類は青いファイルにあるけど、今回の検査入院が対象かまだ確認していない。",
          },
        ],
        edited: false,
        done: false,
        included: false,
      },
      {
        id: "pancake",
        kind: "memory",
        title: "今日のホットケーキ",
        body: "今日、一緒にホットケーキを焼いた。ひっくり返せて、ふたりで拍手した。",
        nextStep: "この言葉を残しておくか、自分で選ぶ。",
        uncertainty: "",
        evidence: [
          {
            messageId: "example-3",
            quote:
              "今日、一緒にホットケーキを焼いた。ひっくり返せて、ふたりで拍手した。",
          },
        ],
        edited: false,
        done: false,
        included: false,
      },
      {
        ...money.card,
        edited: false,
        done: false,
        included: false,
      },
      // 「まず確かめる 1 つ」を聞く相手に見せる質問文。cards[3] がお金のカードのままになるよう、末尾に置く。
      {
        id: "hospital-desk",
        kind: "contact",
        title: "病院の会計に、このまま聞く",
        body: "11/16から11/30まで入院する予定です。病院からは、3割負担で24万〜30万円と聞いています。\n入院費の支払いで、高額療養費の上限を窓口で適用してもらえますか。\n適用してもらうために、入院の前に用意しておくもの（マイナ保険証や限度額適用認定証など）があれば教えてください。\nこの概算に含まれない費用（食事代や差額ベッド代など）があれば、あわせて教えてください。",
        nextStep: "病院の会計で、この質問文を見せて聞く。",
        uncertainty:
          "窓口で上限が適用されるかは、マイナ保険証で限度額の情報を確かめられるか、限度額適用認定証があるかで変わります。[F02]",
        evidence: [{ messageId: "example-4", quote: HOSPITAL_DESK_QUOTE }],
        edited: false,
        done: false,
        included: false,
      },
    ],
  };
}
