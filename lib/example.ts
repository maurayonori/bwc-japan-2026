import { calcDate } from "./money/business-days";
import { cashGapText, showDate, yen, yenRange } from "./money/format";
import { kougakuGendo } from "./money/kougaku";
import { simulateCashflow } from "./money/ledger";
import type { Calculation, CashflowOutput } from "./money/schema";
import { mealCost } from "./money/meals";
import { type Proposal, type Workspace } from "./workspace";

// 架空の体験例（#55）。2026 年 12 月の 2 週間の入院、協会けんぽ、区分ウ、医療費の総額 80 万円、手元 20 万円。
// 1 回目の返答で、窓口で上限が使える場合と使えない場合を並べ、まず確かめる 1 つを出す。
// 2 回目は、病院の会計で上限が使えると確かめた答えを話し、筋書きが 1 本になって幅が無くなるところまで。
// 数字は手で書かず、本番と同じ計算関数で作る。文章の数字も、その結果を埋める。
export const EXAMPLE_TODAY = "2026-11-30";
const ADMISSION = "2026-12-14";
const DISCHARGE = "2026-12-28";
const TOTAL_COST = 800_000;
const CASH_ON_HAND = 200_000;
const CAP_NAME = "窓口で上限が使える場合";
const FULL_NAME = "上限が使えず、いったん 3 割を払う場合";

interface Turn {
  calculations: Calculation[];
  cashflow: CashflowOutput;
}

// 1 回目: 上限が使えるかが分からないので、2 つの筋書きを並べる。
// 2 回目: 上限が使えると確かめたので、その筋書きだけを「確かめた額」で計算し直す。
export function exampleMoneyTurns(): { first: Turn; second: Turn } {
  const kougakuInput = {
    treatment_month: "2026-12",
    income_category: "ウ",
    amount_basis: "total",
    amount_low: TOTAL_COST,
    amount_high: TOTAL_COST,
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
  const hospitalEvent = (
    amountLow: number,
    amountHigh: number,
    certainty: string,
  ) => ({
    date: DISCHARGE,
    label: "入院費（保険診療分）",
    direction: "out",
    amount_low: amountLow,
    amount_high: amountHigh,
    certainty,
  });
  const firstInput = {
    start_date: EXAMPLE_TODAY,
    cash_on_hand: CASH_ON_HAND,
    scenarios: [
      {
        name: CAP_NAME,
        events: [
          hospitalEvent(low.pay_with_cap, high.pay_with_cap, "estimate"),
          mealEvent,
        ],
      },
      {
        name: FULL_NAME,
        events: [
          hospitalEvent(
            low.copay_without_cap,
            high.copay_without_cap,
            "estimate",
          ),
          mealEvent,
        ],
      },
    ],
  };
  const secondInput = {
    start_date: EXAMPLE_TODAY,
    cash_on_hand: CASH_ON_HAND,
    scenarios: [
      {
        name: CAP_NAME,
        events: [
          // 確かめたのは「窓口で上限が使える」という条件だけ。総額は病院の見積もりのままなので、額は見積もり（#68）。
          hospitalEvent(low.pay_with_cap, high.pay_with_cap, "estimate"),
          mealEvent,
        ],
      },
    ],
  };
  const shared: Calculation[] = [
    { name: "kougaku_gendo", input: kougakuInput, output: kougaku },
    { name: "meal_cost", input: mealInput, output: meals },
    { name: "calc_date", input: dateInput, output: stay },
  ];
  const first = simulateCashflow(firstInput);
  const second = simulateCashflow(secondInput);
  return {
    first: {
      calculations: [
        ...shared,
        { name: "simulate_cashflow", input: firstInput, output: first },
      ],
      cashflow: first,
    },
    second: {
      calculations: [
        ...shared,
        { name: "simulate_cashflow", input: secondInput, output: second },
      ],
      cashflow: second,
    },
  };
}

const MONEY_QUOTE =
  "12月14日に入院して、28日に退院する予定です。病院の見積もりだと、医療費は総額で80万円くらい。協会けんぽで、給料は月35万円くらいです。すぐ使えるお金は20万円。";
const MORNING_QUOTE =
  "朝はいつも私が子どもの支度をしています。7時に起こして、着替えは寝室の白い棚、水筒はかばんの横、8時10分に家を出ます。";
const INSURANCE_QUOTE =
  "保険にも入っていて書類は青いファイルにあるけど、給付金がいつ入るのか分かりません。";
const MEMORY_QUOTE =
  "今朝、子どもが「おかあさん、がんばってね」と言ってくれた。";
const ANSWER_QUOTE =
  "病院に聞いたら、マイナ保険証で窓口の上限は使えると言われました。";

// 架空の体験例。AIがその場で生成した回答としては表示しない。
export function exampleWorkspace(): Workspace {
  const first = `${MONEY_QUOTE}${INSURANCE_QUOTE}${MORNING_QUOTE}夫に頼みたいけど、何をどう伝えればいいか。`;
  const second = `残しておきたいこともある。${MEMORY_QUOTE}これをそのままメモに残したい。`;
  const third = `${ANSWER_QUOTE}食事代や差額ベッド代のことは、まだ聞いていません。`;
  const turns = exampleMoneyTurns();
  const [withCap, withoutCap] = turns.first.cashflow.scenarios;
  const [confirmed] = turns.second.cashflow.scenarios;
  const firstConfirm = turns.first.cashflow.what_to_confirm;
  const firstDifference = turns.first.cashflow.comparison_with_first[0];
  if (!firstConfirm || !firstDifference) throw new Error("no-what-to-confirm");
  const money: Proposal = {
    id: "hospital-money",
    kind: "money",
    title: "支払日までに、手元に要る額",
    body: [
      `病院の会計で、窓口で上限が使えると確かめました。${showDate(DISCHARGE)}に手元に要る額は ${yenRange(confirmed.low_case.need, confirmed.high_case.need)}で、手元の ${yen(CASH_ON_HAND)}から ${cashGapText(CASH_ON_HAND, confirmed.low_case.need, confirmed.high_case.need)}見込みです。`,
      "筋書きは 1 本になり、幅は無くなりました。食事代は 1 食 550 円を 1 日 3 食で数えた多めの見積もりです。[F07]",
      "給付金は、まだ数えていません。",
    ].join("\n"),
    nextStep: "見積もりに入っていない費用（食事代や差額ベッド代）を、病院の会計に聞く。",
    uncertainty:
      "入院費は病院の概算です。保険の給付金が出るか、いつ入るかは、契約先への確認が必要です。",
    evidence: [
      { messageId: "example-1", quote: MONEY_QUOTE },
      { messageId: "example-3", quote: ANSWER_QUOTE },
    ],
    money: { calculations: turns.second.calculations },
  };
  return {
    version: 2,
    mode: "example",
    messages: [
      { id: "example-1", role: "user", text: first },
      { id: "example-2", role: "user", text: second },
      {
        id: "example-reply",
        role: "assistant",
        text: [
          `入院のお金を、窓口で上限が使える場合と、使えずにいったん 3 割を払う場合で並べました。${showDate(DISCHARGE)}に手元に要る額は ${yenRange(withCap.low_case.need, withCap.high_case.need)}か ${yenRange(withoutCap.low_case.need, withoutCap.high_case.need)}で、手元の ${yen(CASH_ON_HAND)}だと、後者では ${cashGapText(CASH_ON_HAND, withoutCap.low_case.need, withoutCap.high_case.need)}計算です。差の ${yen(firstDifference.need_low_difference)}は、あとから払い戻される見込みの額です。払い戻しを受けられるか、いつになるかは加入している健康保険に確かめる必要があり、診療月から 3 か月以上かかることがあります。[F05]`,
          `まず確かめる 1 つは、窓口で上限が使えるかです。病院の会計に聞くと、要る額の幅 ${yen(firstConfirm.width)}は無くなり、どちらか 1 つの額に決まります。`,
          "朝の支度の引き継ぎと、保険会社への質問文も用意しました。残しておきたい言葉は、話した言葉のまま残しています。",
        ].join("\n"),
        tools: ["kougaku_gendo", "meal_cost", "calc_date", "simulate_cashflow"],
        cardIds: [
          "morning",
          "insurance",
          "memory",
          "hospital-money",
          "hospital-desk",
        ],
      },
      { id: "example-3", role: "user", text: third },
      {
        id: "example-reply-2",
        role: "assistant",
        text: [
          `窓口で上限が使えると分かったので、その筋書きだけで計算し直しました。${showDate(DISCHARGE)}に手元に要る額は ${yenRange(confirmed.low_case.need, confirmed.high_case.need)}に決まり、手元の ${yen(CASH_ON_HAND)}から ${cashGapText(CASH_ON_HAND, confirmed.low_case.need, confirmed.high_case.need)}見込みです。確かめたのは窓口で上限が使えることで、入院費の総額と食事代は見積もりのままです。`,
          "病院の会計への質問文は、聞いた答えを添えて残しました。次に聞くなら、見積もりに入っていない費用です。",
        ].join("\n"),
        tools: ["simulate_cashflow"],
        cardIds: ["hospital-money", "hospital-desk"],
      },
    ],
    cards: [
      {
        id: "morning",
        kind: "daily",
        title: "朝の支度を、ひと目で",
        body: "7:00　起こす\n着替え：寝室の白い棚\n水筒：かばんの横\n8:10　家を出る",
        nextStep: "朝の流れに抜けがないか読み返し、夫に見せる。",
        uncertainty: "夫が担当できるかは、まだ相談していません。",
        evidence: [{ messageId: "example-1", quote: MORNING_QUOTE }],
        edited: false,
        done: false,
        included: false,
      },
      {
        id: "insurance",
        kind: "contact",
        title: "保険会社に、このまま聞く",
        body: "12月14日から28日まで入院する予定です。\n加入している契約で、今回の入院は給付の対象になりますか。\n対象の場合、請求に必要な書類、退院前に病院へ依頼しておくもの、請求できる時期と、入金までの目安の日数を教えてください。\n自分で手続きできない間に家族が請求するための準備があれば、あわせて教えてください。\n\n契約の書類の場所：青いファイル",
        nextStep: "青いファイルで契約先と問い合わせ先を確かめる。",
        uncertainty:
          "給付の対象・必要書類・入金時期は、契約先への確認が必要です。",
        evidence: [
          { messageId: "example-1", quote: "12月14日に入院して、28日に退院する予定です。" },
          { messageId: "example-1", quote: INSURANCE_QUOTE },
        ],
        edited: false,
        done: false,
        included: false,
      },
      {
        id: "memory",
        kind: "memory",
        title: "今朝のひと言",
        body: MEMORY_QUOTE,
        nextStep: "この言葉を残しておくか、自分で選ぶ。",
        uncertainty: "",
        evidence: [{ messageId: "example-2", quote: MEMORY_QUOTE }],
        edited: false,
        done: false,
        included: false,
      },
      {
        ...money,
        edited: false,
        done: false,
        included: false,
      },
      // 「まず確かめる 1 つ」を聞く相手に見せた質問文。cards[3] がお金のカードのままになるよう、末尾に置く。
      {
        id: "hospital-desk",
        kind: "contact",
        title: "病院の会計に、このまま聞く",
        body: "12月14日から28日まで入院する予定です。病院からは、医療費は総額で80万円くらいと聞いています。\n入院費の支払いで、高額療養費の上限を窓口で使えますか。\n使うために、入院の前に用意しておくもの（マイナ保険証や限度額適用認定証など）があれば教えてください。\nこの見積もりに含まれない費用（食事代や差額ベッド代など）があれば、あわせて教えてください。\n\n聞いた答え：マイナ保険証で、窓口の上限は使える。",
        nextStep: "見積もりに含まれない費用の答えを、同じファイルに残す。",
        uncertainty:
          "食事代や差額ベッド代など、見積もりに含まれない費用があるかは、まだ聞いていません。",
        evidence: [
          { messageId: "example-1", quote: MONEY_QUOTE },
          { messageId: "example-3", quote: ANSWER_QUOTE },
        ],
        edited: false,
        done: false,
        included: false,
      },
    ],
  };
}
