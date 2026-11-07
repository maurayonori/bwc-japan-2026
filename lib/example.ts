import { calcDate } from "./money/business-days";
import { showDate, yen } from "./money/format";
import { kougakuGendo } from "./money/kougaku";
import { simulateCashflow, type CashflowInput } from "./money/ledger";
import { mealCost } from "./money/meals";
import type { Calculation, CashflowOutput } from "./money/schema";
import {
  mergeCards,
  type Message,
  type Proposal,
  type Workspace,
} from "./workspace";

// 架空の体験例（#55）。人物・金額・日付はすべて架空。
// 2026 年 12 月、協会けんぽ、70 歳未満、所得区分ウ（仮定）、1 か月・1 つの医療機関、保険診療の総額 80 万円、
// 入院のために使えるお金 20 万円（生活費は別）。病院の会計の答えを話すと、見通しが更新される。
// 数字は手で書かず、本番と同じ計算関数で作る。文章の数字も、その結果を埋める。

export const EXAMPLE_TODAY = "2026-11-24";
const ADMISSION = "2026-12-14";
const DISCHARGE = "2026-12-28";
const TOTAL = 800_000;
const CASH = 200_000;
const CAP = "窓口で上限を使う場合";
const NO_CAP = "上限を使わず、あとで還付を受ける場合";
const HOSPITAL_LABEL = "入院費（保険診療分）";
const MEAL_LABEL = "入院中の食事代";

// デモの発言に合わせる（docs/submission/demo-script.md）。
export const EXAMPLE_FIRST =
  "12月14日に入院して、28日に退院する予定です。病院の見積もりだと、医療費は総額で80万円くらい。協会けんぽで、給料は月35万円くらいです。入院のために使えるお金は20万円で、生活費は別にしてあります。窓口でいくら払うことになるのか分かりません。入院中、朝の子どもの支度は夫に頼みたい。7時に起こして、着替えは寝室の白い棚、8時10分に家を出ます。";
export const EXAMPLE_ANSWER =
  "病院に聞いたら、マイナ保険証で窓口の上限は効くと言われました。";
const COST_QUOTE = "病院の見積もりだと、医療費は総額で80万円くらい。";
const CASH_QUOTE = "入院のために使えるお金は20万円で、生活費は別にしてあります。";
const MORNING_QUOTE =
  "7時に起こして、着替えは寝室の白い棚、8時10分に家を出ます。";

const kougakuInput = {
  treatment_month: "2026-12",
  // 給料の額から当てはめた仮の区分。加入している健康保険に確かめるもの。
  income_category: "ウ",
  amount_basis: "total",
  amount_low: TOTAL,
  amount_high: TOTAL,
  copay_percent: 30,
};
const dateInput = { start_date: ADMISSION, steps: [], until_date: DISCHARGE };

function baseCalculations() {
  const kougaku = kougakuGendo(kougakuInput);
  const stay = calcDate(dateInput);
  const days = stay.until?.days_inclusive ?? 1;
  const mealInput = { days_low: days, days_high: days };
  const meals = mealCost(mealInput);
  const [item] = kougaku.cases;
  // 支払いは退院の日と仮に置く。食事代は 1 日 3 食で数えた額で、仮定として扱う。
  const meal = {
    date: DISCHARGE,
    label: MEAL_LABEL,
    direction: "out",
    amount_low: meals.low.cost_max,
    amount_high: meals.high.cost_max,
    certainty: "assumption",
  };
  const hospital = (amount: number) => ({
    date: DISCHARGE,
    label: HOSPITAL_LABEL,
    direction: "out",
    amount_low: amount,
    amount_high: amount,
    certainty: "estimate",
  });
  const capScenario = {
    name: CAP,
    events: [hospital(item.low.pay_with_cap), meal],
  };
  const noCapScenario = {
    name: NO_CAP,
    events: [hospital(item.low.copay_without_cap), meal],
  };
  const calculations: Calculation[] = [
    { name: "kougaku_gendo", input: kougakuInput, output: kougaku },
    { name: "meal_cost", input: mealInput, output: meals },
    { name: "calc_date", input: dateInput, output: stay },
  ];
  return { calculations, capScenario, noCapScenario, meals };
}

function cashflowCalc(input: CashflowInput): {
  calculation: Calculation;
  output: CashflowOutput;
} {
  const output = simulateCashflow(input);
  return {
    calculation: { name: "simulate_cashflow", input: { ...input }, output },
    output,
  };
}

// 病院に聞く前（窓口で上限を使うかを、まだ確かめていない）。
export function exampleBeforeCalculations(): Calculation[] {
  const { calculations, capScenario, noCapScenario } = baseCalculations();
  const { calculation } = cashflowCalc({
    start_date: EXAMPLE_TODAY,
    cash_on_hand: CASH,
    scenarios: [capScenario, noCapScenario],
  });
  return [...calculations, calculation];
}

// 病院の会計の答えのあと。筋書きは答えに合う「窓口で上限を使う場合」だけを残す。
// 入院費の額は見積もりの総額からの計算なので、確かさは「見積もり」のまま。
export function exampleAfterCalculations(): Calculation[] {
  const { calculations, capScenario } = baseCalculations();
  const { calculation } = cashflowCalc({
    start_date: EXAMPLE_TODAY,
    cash_on_hand: CASH,
    scenarios: [capScenario],
  });
  return [...calculations, calculation];
}

function cashflowOf(calculations: readonly Calculation[]): CashflowOutput {
  const found = calculations.findLast(
    (calculation) => calculation.name === "simulate_cashflow",
  );
  if (found?.name !== "simulate_cashflow") throw new Error("no-cashflow");
  return found.output;
}

// 体験例と README・台本が使う数字。すべて計算の出力から読む。
export function exampleNumbers() {
  const before = cashflowOf(exampleBeforeCalculations());
  const after = cashflowOf(exampleAfterCalculations());
  const { meals } = baseCalculations();
  const [withCap, withoutCap] = before.scenarios;
  const [kougaku] = exampleBeforeCalculations().flatMap((calculation) =>
    calculation.name === "kougaku_gendo" ? [calculation.output.cases[0]] : [],
  );
  const confirm = before.what_to_confirm;
  const [top] = confirm?.factors ?? [];
  if (!confirm || !top || !after.what_to_confirm)
    throw new Error("no-what-to-confirm");
  return {
    cash: CASH,
    total: kougaku.low.total_medical_cost,
    cap: kougaku.low.cap,
    payWithCap: kougaku.low.pay_with_cap,
    copayWithoutCap: kougaku.low.copay_without_cap,
    refundLater: kougaku.low.refund_later,
    meals: meals.low.cost_max,
    mealDays: meals.low.days,
    needWithCap: withCap.low_case.need,
    needWithoutCap: withoutCap.low_case.need,
    remainWithCap: withCap.low_case.end_balance,
    shortWithoutCap: withoutCap.low_case.shortfall,
    difference: Math.abs(before.comparison_with_first[0].need_low_difference),
    widthBefore: confirm.width,
    widthIfResolved: top.width_if_resolved,
    widthAfter: after.what_to_confirm.width,
    needAfter: after.scenarios[0].low_case.need,
    remainAfter: after.scenarios[0].low_case.end_balance,
  };
}

function moneyCardBefore(): Proposal {
  const n = exampleNumbers();
  return {
    id: "hospital-money",
    kind: "money",
    title: "12 月の入院のお金",
    body: [
      `窓口で上限を使えば、${showDate(DISCHARGE)}に要るのは ${yen(n.needWithCap)}で、手元の ${yen(n.cash)}から ${yen(n.remainWithCap)}残ります。上限を使わずにあとで還付を受けるなら ${yen(n.needWithoutCap)}で、${yen(n.shortWithoutCap)}足りません。`,
      "差を生んでいるのは、窓口で上限を使えるかです。[F02]",
      "食事代は 1 日 3 食で数えた仮定です。",
    ].join("\n"),
    nextStep: "病院の会計で、窓口で上限を使えるかを聞く。",
    uncertainty:
      "医療費の総額は病院の見積もりです。所得の区分は、給料の額からウと仮に置きました。支払いは退院の日と仮に置いています。差額ベッド代などは入っていません。",
    evidence: [
      { messageId: "example-1", quote: COST_QUOTE },
      { messageId: "example-1", quote: CASH_QUOTE },
    ],
    money: { calculations: exampleBeforeCalculations() },
  };
}

function moneyCardAfter(id: string): Proposal {
  const n = exampleNumbers();
  return {
    id,
    kind: "money",
    title: "12 月の入院のお金",
    body: [
      `病院の会計の答えから、窓口で上限を使う見通しにしました。${showDate(DISCHARGE)}に要るのは ${yen(n.needAfter)}で、手元の ${yen(n.cash)}から ${yen(n.remainAfter)}残ります。`,
      "入院費は、見積もりの総額 80 万円からの計算です。実際の請求とは違うことがあります。",
      "食事代は 1 日 3 食で数えた仮定です。",
    ].join("\n"),
    nextStep: `${showDate(ADMISSION)}の入院の受付で、マイナ保険証を出す。`,
    uncertainty:
      "所得の区分は、給料の額からウと仮に置いたままです。加入している健康保険に確かめられます。受付でマイナ保険証の限度額の情報を確かめられないときは、限度額適用認定証が要ります。[F02]",
    evidence: [
      { messageId: "example-2", quote: EXAMPLE_ANSWER },
      { messageId: "example-1", quote: COST_QUOTE },
    ],
    money: { calculations: exampleAfterCalculations() },
  };
}

function firstReply(): string {
  const n = exampleNumbers();
  return [
    "支払日に要るお金を、窓口で上限を使う場合と、使わずにあとで還付を受ける場合で並べました。高額療養費は、1 か月の医療費の自己負担に上限を設ける制度です。",
    `窓口で上限を使えば、${showDate(DISCHARGE)}に要るのは ${yen(n.needWithCap)}で、手元の ${yen(n.cash)}から ${yen(n.remainWithCap)}残ります。使わずにあとで還付を受けるなら ${yen(n.needWithoutCap)}で、${yen(n.shortWithoutCap)}足りません。還付は、協会けんぽの案内では診療月から 3 か月以上かかります。[F05]`,
    `まず確かめる 1 つは、窓口で上限を使えるかです。病院の会計に聞くと、要る額の幅は ${yen(n.widthBefore)}から ${yen(n.widthIfResolved)}に縮みます。`,
    "朝の支度のメモも作りました。",
  ].join("\n");
}

function answerReply(): string {
  const n = exampleNumbers();
  return [
    `病院の会計の答えから、窓口で上限を使う見通しに絞りました。${showDate(DISCHARGE)}に要るのは ${yen(n.needAfter)}で、手元の ${yen(n.cash)}から ${yen(n.remainAfter)}残ります。要る額の幅は ${yen(n.widthBefore)}から ${yen(n.widthAfter)}に縮みました。`,
    `窓口で上限までの支払いになれば、${yen(n.refundLater)}を還付まで立て替えずに済みます。${showDate(ADMISSION)}の入院の受付で、マイナ保険証を出してください。[F02]`,
    `食事代 ${yen(n.meals)}は、1 日 3 食で数えた仮定です。`,
  ].join("\n");
}

const TOOLS = ["kougaku_gendo", "meal_cost", "calc_date", "simulate_cashflow"];

// 架空の体験例の最初の状態（病院に聞く前）。AI がその場で生成した回答としては表示しない。
export function exampleWorkspace(): Workspace {
  return {
    version: 2,
    mode: "example",
    messages: [
      { id: "example-1", role: "user", text: EXAMPLE_FIRST },
      {
        id: "example-reply",
        role: "assistant",
        text: firstReply(),
        tools: TOOLS,
        cardIds: ["hospital-money", "hospital-desk", "morning"],
      },
    ],
    cards: [
      { ...moneyCardBefore(), edited: false, done: false, included: false },
      // 「まず確かめる 1 つ」を聞く相手に見せる質問文。
      {
        id: "hospital-desk",
        kind: "contact",
        title: "病院の会計に、このまま聞く",
        body: "12月14日から28日まで入院する予定です。医療費は総額で80万円くらいと見積もりをいただきました。\n入院費の支払いで、高額療養費の上限を窓口で適用してもらえますか。\nマイナ保険証で限度額の情報を確かめてもらえますか。使えない場合は、入院の前に限度額適用認定証を用意したほうがよいですか。\nこの見積もりに含まれない費用（食事代や差額ベッド代など）があれば、あわせて教えてください。",
        nextStep: "病院の会計で、この質問文を見せて聞く。",
        uncertainty:
          "窓口の支払いが上限までになるかは、マイナ保険証で限度額の情報を確かめられるか、限度額適用認定証があるかで変わります。[F02]",
        evidence: [{ messageId: "example-1", quote: COST_QUOTE }],
        edited: false,
        done: false,
        included: false,
      },
      {
        id: "morning",
        kind: "daily",
        title: "朝の支度を、ひと目で",
        body: "7:00　子どもを起こす\n着替え：寝室の白い棚\n8:10　家を出る",
        nextStep: "夫に渡す前に、抜けがないか読み返す。",
        uncertainty: "夫が引き受けられるかは、まだ話していません。",
        evidence: [{ messageId: "example-1", quote: MORNING_QUOTE }],
        edited: false,
        done: false,
        included: false,
      },
    ],
  };
}

export const EXAMPLE_ANSWER_ID = "example-2";

export const exampleAnswered = (workspace: Workspace): boolean =>
  workspace.messages.some((message) => message.id === EXAMPLE_ANSWER_ID);

// 病院の会計の答えを話した続き。画面の会話と同じ mergeCards で重ねるので、
// 自分で直したり、準備できた・渡すと選んだりしたカードは上書きしない。
// お金のカードが守られているときは、本番と同じく別の番号の新しいカードにする。
export function answerExample(workspace: Workspace): Workspace {
  if (exampleAnswered(workspace)) return workspace;
  const current = workspace.cards.find((card) => card.id === "hospital-money");
  const id =
    current && (current.edited || current.done || current.included)
      ? "hospital-money-2"
      : "hospital-money";
  const messages: Message[] = [
    { id: EXAMPLE_ANSWER_ID, role: "user", text: EXAMPLE_ANSWER },
    {
      id: "example-reply-2",
      role: "assistant",
      text: answerReply(),
      tools: ["simulate_cashflow"],
      cardIds: [id],
    },
  ];
  return {
    ...workspace,
    messages: [...workspace.messages, ...messages],
    cards: mergeCards(workspace.cards, [moneyCardAfter(id)]),
  };
}

// 病院の答えまで進めた体験例（テストとブラウザの検査で使う）。
export function exampleAnsweredWorkspace(): Workspace {
  return answerExample(exampleWorkspace());
}
