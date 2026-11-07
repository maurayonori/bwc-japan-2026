import { yenRange } from "./money/format";
import type { Calculation, Money } from "./money/schema";
import type { Card, Message } from "./workspace";

// 画面は「話す」「見通し」「渡すもの」の 3 つ。URL の # で切り替えるので、ブラウザの戻るでも戻れる。
export const VIEWS = ["talk", "outlook", "hand"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_HASH: Record<View, string> = {
  talk: "#talk",
  outlook: "#outlook",
  hand: "#hand",
};

// 知らない # や # 無しは、最初の画面（話す）にする。
export function viewFromHash(hash: string): View {
  const name = hash.replace(/^#/, "");
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : "talk";
}

export const isHandCard = (card: Card): boolean => card.kind !== "money";

export interface ResultLink {
  view: View;
  label: string;
}

// お金のカードにある、一番あとに計算した見通しの「要る額の幅」。順位の無い前の保存データでは null。
export function needRangeOf(
  card: Card,
): { low: number; high: number; checks: number } | null {
  const cashflow = card.money?.calculations.findLast(
    (calculation) => calculation.name === "simulate_cashflow",
  );
  if (cashflow?.name !== "simulate_cashflow") return null;
  const range = cashflow.output.what_to_confirm;
  return range
    ? {
        low: range.need_low,
        high: range.need_high,
        // 幅を縮める不明点の数。0 なら「まず確かめる 1 つ」は出ない。
        checks: range.width > 0 ? range.factors.length : 0,
      }
    : null;
}

// 返答の下に出す移動のリンク。その返答で作ったり直したりしたカードが、いまも残っているときだけ出す。
// 金額は道具の出力だけから組み立てる。カードはあとの返答で直されることがあるので、
// 金額を入れるのは、そのお金のカードを最後に扱った返答だけにする（withAmount）。
export function resultLinks(
  message: Message,
  cards: readonly Card[],
  withAmount: boolean,
): ResultLink[] {
  if (message.role !== "assistant" || !message.cardIds?.length) return [];
  const ids = new Set(message.cardIds);
  const touched = cards.filter((card) => ids.has(card.id));
  const money = touched.find((card) => !isHandCard(card));
  const hand = touched.filter(isHandCard);
  const range = money && withAmount ? needRangeOf(money) : null;
  return [
    ...(money
      ? [
          {
            view: "outlook" as const,
            label: !range
              ? "要る額の幅と、まず確かめる 1 つを見る"
              : range.checks > 0
                ? `要る額 ${yenRange(range.low, range.high)}と、まず確かめる 1 つを見る`
                : `要る額 ${yenRange(range.low, range.high)}の見通しを見る`,
          },
        ]
      : []),
    ...(hand.length > 0
      ? [{ view: "hand" as const, label: `渡すものを見る（${hand.length} 件）` }]
      : []),
  ];
}

// 金額を入れてよい返答: お金のカードを扱った返答のうち、一番あとのもの。
export function latestMoneyMessageId(
  messages: readonly Message[],
  cards: readonly Card[],
): string | null {
  const moneyIds = new Set(
    cards.filter((card) => !isHandCard(card)).map((card) => card.id),
  );
  return (
    messages.findLast(
      (message) =>
        message.role === "assistant" &&
        (message.cardIds ?? []).some((id) => moneyIds.has(id)),
    )?.id ?? null
  );
}

// 「病院の会計に、このまま聞く」から、聞く相手の名前だけを取り出す。
export function askWhom(title: string): string {
  return title.replace(/に、?\s*このまま聞く$/, "") || title;
}

// 「まず確かめる 1 つ」で見せる質問文のカード（#48）。
// カードの並び順では選ばない。直したカードは元の位置に残るので、並びの最後が今の確認の質問文とは限らない。
// 今の見通しを作った返答（お金のカードを最後に扱った返答）で、いっしょに作ったり直したりした「確かめる・頼む」の文章だけを使う。
// 2 枚以上あれば、その返答の「まず確かめる」の行に聞く相手が出てくる 1 枚に絞る。決まらなければ出さない（質問文を作ってもらう）。
export function questionCard(
  messages: readonly Message[],
  cards: readonly Card[],
): Card | null {
  const messageId = latestMoneyMessageId(messages, cards);
  const message = messages.find((item) => item.id === messageId);
  if (!message) return null;
  const ids = new Set(message.cardIds ?? []);
  const contacts = cards.filter(
    (card) => card.kind === "contact" && ids.has(card.id),
  );
  if (contacts.length <= 1) return contacts[0] ?? null;
  const confirmLines = message.text
    .split("\n")
    .filter((line) => line.includes("まず確かめる"))
    .join("\n");
  const named = contacts.filter((card) =>
    confirmLines.includes(askWhom(card.title)),
  );
  return named.length === 1 ? named[0] : null;
}

// ---- 支払日に要るお金（窓口で上限を使う場合と、使わずにあとで還付を受ける場合） ----
// 見通しの筋書きのどちらが「上限を使う」かは、Claude が付けた名前では決めない。
// 高額療養費の計算の出力（pay_with_cap と copay_without_cap）と、見通しの各行の額が一致するかで見分ける。
// 金額はすべて計算の出力から選んで並べる。ここで新しい額は作らない（足し算も引き算もしない）。

type CashflowCalc = Extract<Calculation, { name: "simulate_cashflow" }>;
type KougakuCalc = Extract<Calculation, { name: "kougaku_gendo" }>;
type Scenario = CashflowCalc["output"]["scenarios"][number];
type LedgerPath = Scenario["low_case"];
type KougakuCase = KougakuCalc["output"]["cases"][number];

export interface Pair {
  low: number;
  high: number;
}

// 手元のお金と比べた結果。足りなければ shortfall（計算の出力）、足りれば一番少ないときの手元の残り。
export type CashResult =
  | { kind: "short"; amount: number }
  | { kind: "remain"; amount: number };

export interface PaydayRow {
  label: string;
  direction: string;
  amount: Pair;
  certainty: string;
}

export interface PaydayColumn {
  scenario: string;
  need: Pair;
  // 一番きつくなる日（支払日）。少なめと多めで違うときは、多めの場合の日。
  needDate: string | null;
  cash: { low: CashResult; high: CashResult } | null;
  // 確かめていない入金を数えない場合（その入金があるときだけ）。
  withoutUnconfirmedIncome: { need: number; cash: CashResult | null } | null;
  rows: PaydayRow[];
}

export interface Payday {
  startDate: string;
  cashOnHand: number | null;
  cap: PaydayColumn | null;
  nocap: PaydayColumn | null;
  // 高額療養費の計算が 1 か月・1 区分だけのときの、入院費の額（月をまたぐと月ごとに分かれるので出さない）。
  kougaku: {
    month: string;
    payWithCap: Pair;
    copayWithoutCap: Pair;
    refundLater: Pair;
  } | null;
  // 2 つの筋書きの、支払日に要るお金の差（comparison_with_first）。どちらかが一番上の筋書きのときだけ。
  needDifference: Pair | null;
}

const samePair = (a: Pair, b: Pair): boolean =>
  a.low === b.low && a.high === b.high;

// 上限で窓口負担が減る、1 区分の計算だけを使う（区分が分からず 5 つ並べた計算では見分けられない）。
function capCases(calculations: readonly Calculation[]): KougakuCase[] {
  return calculations.flatMap((calculation) =>
    calculation.name === "kougaku_gendo" &&
    calculation.output.cases.length === 1 &&
    calculation.output.cases[0].low.cap_reduces_payment &&
    calculation.output.cases[0].high.cap_reduces_payment
      ? [calculation.output.cases[0]]
      : [],
  );
}

// 筋書きの支払いの行を、少なめと多めの場合で突き合わせる（同じ入出金を同じ順に並べている）。
function rowsOf(scenario: Scenario): PaydayRow[] {
  const low = scenario.low_case.rows;
  const high = scenario.high_case.rows;
  if (low.length !== high.length) return [];
  return low.map((row, index) => ({
    label: row.label,
    direction: row.direction,
    amount: { low: row.amount, high: high[index].amount },
    certainty: row.certainty,
  }));
}

function classify(
  scenario: Scenario,
  cases: readonly KougakuCase[],
): "cap" | "nocap" | null {
  let cap = 0;
  let nocap = 0;
  for (const row of rowsOf(scenario)) {
    if (row.direction !== "out") continue;
    for (const item of cases) {
      if (
        samePair(row.amount, {
          low: item.low.pay_with_cap,
          high: item.high.pay_with_cap,
        })
      )
        cap += 1;
      if (
        samePair(row.amount, {
          low: item.low.copay_without_cap,
          high: item.high.copay_without_cap,
        })
      )
        nocap += 1;
    }
  }
  if (cap > 0 && nocap === 0) return "cap";
  if (nocap > 0 && cap === 0) return "nocap";
  return null;
}

function cashOf(path: LedgerPath, cash: number | null): CashResult | null {
  if (cash === null) return null;
  if (path.shortfall !== null && path.shortfall > 0)
    return { kind: "short", amount: path.shortfall };
  // 足りるときは、手元が一番少なくなったときの残り（始まりの手元か、各行の残りのうち一番小さい値）。
  const balances = path.rows.flatMap((row) =>
    row.balance === null ? [] : [row.balance],
  );
  return { kind: "remain", amount: Math.min(cash, ...balances) };
}

function columnOf(scenario: Scenario, cash: number | null): PaydayColumn {
  const { low_case: low, high_case: high } = scenario;
  const without = scenario.high_case_without_unconfirmed_income;
  const lowCash = cashOf(low, cash);
  const highCash = cashOf(high, cash);
  return {
    scenario: scenario.name,
    need: { low: low.need, high: high.need },
    needDate: high.need_date ?? low.need_date,
    cash: lowCash && highCash ? { low: lowCash, high: highCash } : null,
    withoutUnconfirmedIncome:
      scenario.totals.unconfirmed_in_high > 0
        ? { need: without.need, cash: cashOf(without, cash) }
        : null,
    rows: rowsOf(scenario),
  };
}

function only<T>(items: readonly T[]): T | null {
  return items.length === 1 ? items[0] : null;
}

// 支払日に要るお金を、窓口で上限を使う場合と使わない場合に分けて並べる。見分けられなければ null。
export function paydayOf(money: Money | undefined): Payday | null {
  const calculations = money?.calculations ?? [];
  const cashflow = calculations.findLast(
    (calculation): calculation is CashflowCalc =>
      calculation.name === "simulate_cashflow",
  );
  const cases = capCases(calculations);
  if (!cashflow || cases.length === 0) return null;
  const { output } = cashflow;
  const kinds = output.scenarios.map((scenario) => classify(scenario, cases));
  const capIndexes = kinds.flatMap((kind, i) => (kind === "cap" ? [i] : []));
  const nocapIndexes = kinds.flatMap((kind, i) =>
    kind === "nocap" ? [i] : [],
  );
  // 同じ側の筋書きが 2 本以上（月をまたぐときの内訳の違いなど）は、どれを出すか決められないので出さない。
  if (capIndexes.length > 1 || nocapIndexes.length > 1) return null;
  const capIndex = only(capIndexes);
  const nocapIndex = only(nocapIndexes);
  if (capIndex === null && nocapIndex === null) return null;

  const cash = output.cash_on_hand;
  const differenceOf = (index: number | null) =>
    index === null
      ? undefined
      : output.comparison_with_first.find(
          (item) => item.name === output.scenarios[index].name,
        );
  const compared =
    capIndex === 0
      ? differenceOf(nocapIndex)
      : nocapIndex === 0
        ? differenceOf(capIndex)
        : undefined;
  const single = only(cases);
  const kougakuCalc = only(
    calculations.filter(
      (calculation): calculation is KougakuCalc =>
        calculation.name === "kougaku_gendo",
    ),
  );
  return {
    startDate: output.start_date,
    cashOnHand: cash,
    cap: capIndex === null ? null : columnOf(output.scenarios[capIndex], cash),
    nocap:
      nocapIndex === null ? null : columnOf(output.scenarios[nocapIndex], cash),
    kougaku:
      single && kougakuCalc
        ? {
            month: kougakuCalc.output.treatment_month,
            payWithCap: {
              low: single.low.pay_with_cap,
              high: single.high.pay_with_cap,
            },
            copayWithoutCap: {
              low: single.low.copay_without_cap,
              high: single.high.copay_without_cap,
            },
            refundLater: {
              low: single.low.refund_later,
              high: single.high.refund_later,
            },
          }
        : null,
    // 差は、上限を使わないほうが多い向きで読む（一番上の筋書きがどちらでも、差の大きさは同じ）。
    needDifference:
      compared && capIndex !== null && nocapIndex !== null
        ? {
            low: Math.abs(compared.need_low_difference),
            high: Math.abs(compared.need_high_difference),
          }
        : null,
  };
}

// 支払日のお金の欄に添える、出典つきの事実。文は持っている事実（lib/money/facts.ts）の番号の本文に沿う。
export const PAYDAY_FACTS = [
  {
    id: "F05",
    text: "あとで還付を受ける場合、払い戻しまで、協会けんぽは「診療月から 3 か月以上」と案内しています。",
  },
  {
    id: "F02",
    text: "窓口の支払いを上限までにできるのは、マイナ保険証で限度額の情報を確かめられる場合か、限度額適用認定証を出した場合です。食事代や差額ベッド代は上限の対象外です。",
  },
] as const;
