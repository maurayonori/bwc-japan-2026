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
// 見通しの筋書きのどちらが「上限を使う」かは、Claude が付けた筋書きの名前では決めない。
// 高額療養費の計算（1 つだけ・1 区分）の pay_with_cap と copay_without_cap に、医療費の支払いの行の額が
// ちょうど 1 行だけ一致するかで見分ける。結び付けが一意でなければ、欄を丸ごと出さない（ADR 0016）。
// 金額はすべて計算の出力から選んで並べる。ここで新しい額は作らない（足し算も引き算もしない。向きをそろえる符号の反転だけ）。

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
  date: string;
  label: string;
  direction: string;
  // 少なめの場合と多めの場合の額を、小さい順に並べたもの（入金は少なめの場合に多く置かれるため）。
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
  // 結び付けた高額療養費の計算（1 か月・1 区分）の、入院費の額。
  kougaku: {
    month: string;
    payWithCap: Pair;
    copayWithoutCap: Pair;
    refundLater: Pair;
  };
  // 上限を使うと、支払日に要るお金がいくら少ないか（還付側 − 上限側。負なら上限側のほうが多い）。
  // comparison_with_first の値で、上限側が一番上なら還付側の差をそのまま、還付側が一番上なら上限側の差の符号を反転して使う。
  // 両側がそろうときだけ。
  capSaves: Pair | null;
  // 両側の筋書きで、医療費の行のほかの出入り（名前・日付・向き・額・確かさ）がすべて同じか。
  sameOtherRows: boolean;
}

// 医療費の支払いの行とみなす名前。偶然同じ額になった家賃などを、医療費と結び付けないため。
// 名前で決めるのは「医療費の行かどうか」の足切りだけで、上限側か還付側かは額で決める。
const MEDICAL_LABEL_WORDS = ["入院", "医療", "診療", "病院", "窓口"];

const samePair = (a: Pair, b: Pair): boolean =>
  a.low === b.low && a.high === b.high;

const ordered = (a: number, b: number): Pair => ({
  low: Math.min(a, b),
  high: Math.max(a, b),
});

// 結び付ける高額療養費の計算。ちょうど 1 つで、1 区分で、上限で窓口負担が減るときだけ。
// 区分が分からず 5 つ並べた計算、区分の違う計算が 2 つ以上（区分の比べ合い・月ごとの計算）は、結び付けが一意でない。
function onlyKougaku(
  calculations: readonly Calculation[],
): { calc: KougakuCalc; item: KougakuCase } | null {
  const found = calculations.filter(
    (calculation): calculation is KougakuCalc =>
      calculation.name === "kougaku_gendo",
  );
  if (found.length !== 1) return null;
  const [calc] = found;
  if (calc.output.cases.length !== 1) return null;
  const [item] = calc.output.cases;
  if (!item.low.cap_reduces_payment || !item.high.cap_reduces_payment)
    return null;
  return { calc, item };
}

// 筋書きの行を、少なめと多めの場合で突き合わせる（同じ入出金を同じ順に並べている）。並びが違えば null。
function rowsOf(scenario: Scenario): PaydayRow[] | null {
  const low = scenario.low_case.rows;
  const high = scenario.high_case.rows;
  if (low.length !== high.length) return null;
  const rows: PaydayRow[] = [];
  for (const [index, row] of low.entries()) {
    const other = high[index];
    if (
      other.label !== row.label ||
      other.date !== row.date ||
      other.direction !== row.direction
    )
      return null;
    rows.push({
      date: row.date,
      label: row.label,
      direction: row.direction,
      amount: ordered(row.amount, other.amount),
      certainty: row.certainty,
    });
  }
  return rows;
}

interface Classified {
  side: "cap" | "nocap";
  rows: PaydayRow[];
  medical: number;
}

// 上限の額か上限なしの額に一致する支払いの行が、ちょうど 1 行で、医療費の名前のときだけ分類する。
function classify(scenario: Scenario, item: KougakuCase): Classified | null {
  const rows = rowsOf(scenario);
  if (!rows) return null;
  const withCap = { low: item.low.pay_with_cap, high: item.high.pay_with_cap };
  const withoutCap = {
    low: item.low.copay_without_cap,
    high: item.high.copay_without_cap,
  };
  const matches: { side: Classified["side"]; index: number }[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.direction !== "out") continue;
    if (samePair(row.amount, withCap)) matches.push({ side: "cap", index });
    else if (samePair(row.amount, withoutCap))
      matches.push({ side: "nocap", index });
  }
  if (matches.length !== 1) return null;
  const [{ side, index }] = matches;
  const label = rows[index].label;
  if (!MEDICAL_LABEL_WORDS.some((word) => label.includes(word))) return null;
  return { side, rows, medical: index };
}

const sameRow = (a: PaydayRow, b: PaydayRow): boolean =>
  a.date === b.date &&
  a.label === b.label &&
  a.direction === b.direction &&
  a.certainty === b.certainty &&
  samePair(a.amount, b.amount);

const otherRows = ({ rows, medical }: Classified): PaydayRow[] =>
  rows.filter((_, index) => index !== medical);

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

function columnOf(
  scenario: Scenario,
  rows: PaydayRow[],
  cash: number | null,
): PaydayColumn {
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
    rows,
  };
}

// 支払日に要るお金を、窓口で上限を使う場合と使わない場合に分けて並べる。見分けられなければ null。
export function paydayOf(money: Money | undefined): Payday | null {
  const calculations = money?.calculations ?? [];
  const cashflow = calculations.findLast(
    (calculation): calculation is CashflowCalc =>
      calculation.name === "simulate_cashflow",
  );
  const linked = onlyKougaku(calculations);
  if (!cashflow || !linked) return null;
  const { output } = cashflow;
  const classified = output.scenarios.map((scenario) =>
    classify(scenario, linked.item),
  );
  // 分類できない筋書きが 1 本でもあれば、比べる相手が欠けて見えるので、欄を丸ごと出さない。
  if (classified.some((item) => item === null)) return null;
  const sides = classified as Classified[];
  const capIndexes = sides.flatMap((item, i) => (item.side === "cap" ? [i] : []));
  const nocapIndexes = sides.flatMap((item, i) =>
    item.side === "nocap" ? [i] : [],
  );
  // 同じ側の筋書きが 2 本以上あれば、どれを出すか決められない。
  if (capIndexes.length > 1 || nocapIndexes.length > 1) return null;
  const [capIndex] = capIndexes;
  const [nocapIndex] = nocapIndexes;
  const capSide = capIndex === undefined ? null : sides[capIndex];
  const nocapSide = nocapIndex === undefined ? null : sides[nocapIndex];
  // 両側の医療費の行は、同じ名前・同じ日付のときだけ結び付ける（同じ支払いの、上限あり・なし）。
  if (capSide && nocapSide) {
    const a = capSide.rows[capSide.medical];
    const b = nocapSide.rows[nocapSide.medical];
    if (a.label !== b.label || a.date !== b.date) return null;
  }

  const differenceOf = (index: number) =>
    output.comparison_with_first.find(
      (item) => item.name === output.scenarios[index].name,
    );
  const fromFirst =
    capIndex === 0 && nocapIndex !== undefined
      ? differenceOf(nocapIndex)
      : undefined;
  const toFirst =
    nocapIndex === 0 && capIndex !== undefined
      ? differenceOf(capIndex)
      : undefined;
  const capSaves: Pair | null = fromFirst
    ? {
        low: fromFirst.need_low_difference,
        high: fromFirst.need_high_difference,
      }
    : toFirst
      ? {
          low: -toFirst.need_low_difference,
          high: -toFirst.need_high_difference,
        }
      : null;
  const otherCap = capSide ? otherRows(capSide) : [];
  const otherNocap = nocapSide ? otherRows(nocapSide) : [];
  const { calc, item } = linked;
  const cash = output.cash_on_hand;
  return {
    startDate: output.start_date,
    cashOnHand: cash,
    cap:
      capSide && capIndex !== undefined
        ? columnOf(output.scenarios[capIndex], capSide.rows, cash)
        : null,
    nocap:
      nocapSide && nocapIndex !== undefined
        ? columnOf(output.scenarios[nocapIndex], nocapSide.rows, cash)
        : null,
    kougaku: {
      month: calc.output.treatment_month,
      payWithCap: { low: item.low.pay_with_cap, high: item.high.pay_with_cap },
      copayWithoutCap: {
        low: item.low.copay_without_cap,
        high: item.high.copay_without_cap,
      },
      refundLater: { low: item.low.refund_later, high: item.high.refund_later },
    },
    capSaves: capSide && nocapSide ? capSaves : null,
    sameOtherRows:
      Boolean(capSide && nocapSide) &&
      otherCap.length === otherNocap.length &&
      otherCap.every((row, index) => sameRow(row, otherNocap[index])),
  };
}

// 2 つの欄の下に出す、差の行。
// - avoidable: 両側があり、医療費のほかの出入りが同じで、上限側が少なく、その差が還付まで立て替える額と同じとき。「避けられる一時立替」と呼ぶ
// - difference: 両側があり、少なめと多めで差の向きがそろうとき。向きを保って「支払日に要るお金の差」と呼ぶ（立替の説明は付けない）
// - refund: 片側だけのとき。高額療養費の計算の、還付まで立て替える額（上限を使えば立て替えずに済む額）
// 両側があっても差が取れない・向きが分かれるときは null（還付の額に置き換えない）。
export type PaydayDifference =
  | { kind: "avoidable"; amount: Pair }
  | { kind: "difference"; direction: "cap-less" | "cap-more"; amount: Pair }
  | { kind: "refund"; amount: Pair };

export function paydayDifference(payday: Payday): PaydayDifference | null {
  const { cap, nocap, capSaves, sameOtherRows, kougaku } = payday;
  if (!cap || !nocap)
    return cap || nocap ? { kind: "refund", amount: kougaku.refundLater } : null;
  if (!capSaves) return null;
  if (capSaves.low > 0 && capSaves.high > 0)
    return sameOtherRows && samePair(capSaves, kougaku.refundLater)
      ? { kind: "avoidable", amount: capSaves }
      : { kind: "difference", direction: "cap-less", amount: capSaves };
  if (capSaves.low < 0 && capSaves.high < 0)
    return {
      kind: "difference",
      direction: "cap-more",
      amount: ordered(-capSaves.low, -capSaves.high),
    };
  return null;
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
