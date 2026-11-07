import type { Card, Message, Proposal } from "../workspace";
import { asMemory, validateEvidence } from "../workspace";
import {
  MAX_CALCULATIONS,
  calculationSchema,
  type Calculation,
  type MoneyWarning,
} from "./schema";

// 道具の結果をカードに紐づける。表に出す金額と日付は、ここで渡す結果だけ。
// Claude の出力には表の項目が無いので、Claude が書いた数字は表に入らない。

export interface ToolEvent {
  name: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
  crashed?: boolean;
}

type ExistingCard = Omit<Card, "money">;

// 計算だけで見通しになる道具。日付だけの計算では、カードを新しく作らない。
const TABLE_TOOLS = new Set(["kougaku_gendo", "meal_cost", "simulate_cashflow"]);

export const SYNTHETIC_TITLE = "お金の見通し";
export const SYNTHETIC_BODY =
  "計算の結果を表にしました。説明は会話の返答を見てください。";
export const SYNTHETIC_NEXT_STEP = "表の前提を読み、違うところを会話で伝える。";
export const SYNTHETIC_UNCERTAINTY =
  "表の額には、見積もりや仮に置いた値が入っています。";

const isProtected = (card: ExistingCard): boolean =>
  card.edited || card.done || card.included;

function cashflowKeys(calculation: Calculation): string[] {
  if (calculation.name !== "simulate_cashflow") return [];
  const { start_date, cash_on_hand, scenarios } = calculation.output;
  const inputs = (calculation.input as { scenarios?: unknown[] }).scenarios;
  return scenarios.map((_, index) =>
    JSON.stringify([start_date, cash_on_hand, inputs?.[index]]),
  );
}

// 同じターンで、別の見通しに含まれる筋書きだけを計算し直したものは、表に重ねない。
function withoutRepeatedCashflow(calculations: Calculation[]): Calculation[] {
  return calculations.filter((calculation, index) => {
    const keys = cashflowKeys(calculation);
    return !(
      keys.length > 0 &&
      calculations.some((other, otherIndex) => {
        if (otherIndex === index) return false;
        const otherKeys = cashflowKeys(other);
        return (
          otherKeys.length > keys.length &&
          keys.every((key) => otherKeys.includes(key))
        );
      })
    );
  });
}

export function toCalculations(events: readonly ToolEvent[]): Calculation[] {
  const seen = new Set<string>();
  return withoutRepeatedCashflow(
    events.flatMap((event) => {
      const key = JSON.stringify([event.name, event.input]);
      if (!event.ok || seen.has(key)) return [];
      seen.add(key);
      return [
        calculationSchema.parse({
          name: event.name,
          input: event.input,
          output: event.output,
        }),
      ];
    }),
  );
}

// 置き換えの単位。高額療養費は診療月ごとに計算するので、道具の名前と診療月で区別する（#59 の指摘 6）。
function replaceKey(calculation: Calculation): string {
  if (calculation.name !== "kougaku_gendo") return calculation.name;
  const month = (calculation.input as { treatment_month?: unknown })
    .treatment_month;
  return `${calculation.name}:${String(month)}`;
}

// 今回の計算を優先し、今回呼ばなかった道具（と診療月）の前回の結果は残す（出典や内訳が表から消えないように）。
function combine(
  fresh: readonly Calculation[],
  prior: readonly Calculation[],
): Calculation[] {
  const keys = new Set(fresh.map(replaceKey));
  const kept = fresh.slice(-MAX_CALCULATIONS);
  return [
    ...prior.filter((calculation) => !keys.has(replaceKey(calculation))),
    ...kept,
  ].slice(-MAX_CALCULATIONS);
}

// 金額の内訳を出す道具。これが成功したあとに見通しが成功していなければ、残っている見通しは前の条件での計算になる。
const BREAKDOWN_TOOLS = new Set(["kougaku_gendo", "meal_cost"]);

// 見通しが前の条件での計算か（#77）。
// - その回で、内訳の計算が成功したあとに simulate_cashflow が無いか失敗した（時間切れを含む）なら、印を付ける
// - その回で、最後の内訳のあとに simulate_cashflow が成功したなら、印を外す
// - その回に内訳も見通しも成功しなければ、前の回の印をそのまま引き継ぐ（日付だけの計算では外さない）
// どの場合も、表に見通しが残っていなければ印は要らない。
export function cashflowIsStale(
  events: readonly ToolEvent[],
  calculations: readonly Calculation[],
  inherited = false,
): boolean {
  if (!calculations.some((calculation) => calculation.name === "simulate_cashflow"))
    return false;
  const lastOk = (match: (name: string) => boolean) =>
    events.findLastIndex((event) => event.ok && match(event.name));
  const breakdown = lastOk((name) => BREAKDOWN_TOOLS.has(name));
  const cashflow = lastOk((name) => name === "simulate_cashflow");
  if (breakdown > cashflow) return true;
  if (cashflow > breakdown) return false;
  return inherited;
}

function moneyOf(
  calculations: Calculation[],
  events: readonly ToolEvent[],
  inherited: boolean,
): { calculations: Calculation[]; stale_cashflow?: true } {
  return cashflowIsStale(events, calculations, inherited)
    ? { calculations, stale_cashflow: true }
    : { calculations };
}

export const STALE_CASHFLOW_WARNING =
  "内訳は新しい条件で計算し直しましたが、支払日に要るお金と要る額の幅は、前の条件での計算のままです。今の額として使わず、「計算し直して」と送ってください。";

function unusedId(used: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const id = `money-${n}`;
    if (!used.has(id)) return id;
  }
}

function hasValidEvidence(card: Proposal, messages: readonly Message[]): boolean {
  try {
    validateEvidence({ reply: "検査", cards: [card] }, [...messages]);
    return true;
  } catch {
    return false;
  }
}

function citeLastUser(lastUser: Message): Proposal["evidence"] {
  return [{ messageId: lastUser.id, quote: lastUser.text.slice(0, 2000) }];
}

const dropped = (title: string, why: string): MoneyWarning => ({
  kind: "card",
  shown: title.slice(0, 80),
  message: `「${title.slice(0, 80)}」のメモは、${why}`,
});

export function attachMoney({
  proposals,
  events,
  existing,
  prior,
  priorStale = new Set<string>(),
  messages,
  forceTable = false,
}: {
  proposals: readonly Proposal[];
  events: readonly ToolEvent[];
  existing: readonly ExistingCard[];
  prior: ReadonlyMap<string, readonly Calculation[]>;
  // 前の回に「前の条件での計算」の印が付いていたお金のカードの id（#77）。
  priorStale?: ReadonlySet<string>;
  messages: readonly Message[];
  forceTable?: boolean;
}): { cards: Proposal[]; warnings: MoneyWarning[] } {
  const fresh = toCalculations(events);
  const lastUser = messages.findLast((message) => message.role === "user");
  if (!lastUser) throw new Error("no-user-message");

  const usedIds = new Set(
    [...existing, ...proposals].map((card) => card.id),
  );
  const warnings: MoneyWarning[] = [];
  const cards: Proposal[] = [];
  const seenIds = new Set<string>();
  let attached = false;

  for (const proposal of proposals) {
    if (seenIds.has(proposal.id)) {
      warnings.push(dropped(proposal.title, "同じ番号のメモと重なったので、出しませんでした。"));
      continue;
    }
    seenIds.add(proposal.id);

    if (proposal.kind !== "money") {
      if (hasValidEvidence(proposal, messages))
        cards.push(proposal.kind === "memory" ? asMemory(proposal) : proposal);
      else
        warnings.push(
          dropped(proposal.title, "話した内容と照らせなかったので、出しませんでした。もう一度送ると、作り直せます。"),
        );
      continue;
    }

    // 根拠の引用が合わなくても、計算の表は捨てない。最後の発言を根拠に置き換える。
    const repaired: Proposal = hasValidEvidence(proposal, messages)
      ? proposal
      : { ...proposal, evidence: citeLastUser(lastUser) };
    const base = existing.find((card) => card.id === proposal.id);

    if (!attached && fresh.length > 0) {
      attached = true;
      const id =
        base && isProtected(base) ? unusedId(usedIds) : proposal.id;
      usedIds.add(id);
      cards.push({
        ...repaired,
        id,
        money: moneyOf(
          combine(fresh, prior.get(proposal.id) ?? []),
          events,
          priorStale.has(proposal.id),
        ),
      });
    } else if (base) {
      // money の項目を付けない。mergeCards が前の表を残す。
      cards.push(repaired);
    } else {
      warnings.push(
        dropped(proposal.title, "計算の結果が無いので、出しませんでした。もう一度送ると、計算からやり直せます。"),
      );
    }
  }

  const wantsTable =
    forceTable || fresh.some((calculation) => TABLE_TOOLS.has(calculation.name));
  if (!attached && fresh.length > 0 && wantsTable) {
    const base = existing.findLast((card) => card.kind === "money");
    const id = base && !isProtected(base) ? base.id : unusedId(usedIds);
    const money = moneyOf(
      combine(fresh, base ? (prior.get(base.id) ?? []) : []),
      events,
      base ? priorStale.has(base.id) : false,
    );
    cards.push({
      id,
      kind: "money",
      title: SYNTHETIC_TITLE,
      body: SYNTHETIC_BODY,
      nextStep: SYNTHETIC_NEXT_STEP,
      uncertainty: SYNTHETIC_UNCERTAINTY,
      evidence: citeLastUser(lastUser),
      money,
    });
  }

  // 付け直したカードに印があるか、前の回の印が付いたカードを今回は付け直さなかった（画面に印が残る）なら、頼み続ける。
  const staleNow =
    cards.some((card) => card.money?.stale_cashflow) ||
    [...priorStale].some((id) => !cards.some((card) => card.id === id));
  if (staleNow)
    warnings.push({
      kind: "calc",
      shown: "前の条件での計算",
      message: STALE_CASHFLOW_WARNING,
    });
  for (const event of events) {
    if (event.crashed)
      warnings.push({
        kind: "calc",
        shown: event.name,
        message:
          "計算の途中で想定外のエラーが起きました。その計算の結果は、表に入っていません。",
      });
  }
  if (fresh.length > MAX_CALCULATIONS)
    warnings.push({
      kind: "calc",
      shown: String(fresh.length),
      message: `計算の回数が多かったので、最後の ${MAX_CALCULATIONS} 件だけを表にしました。`,
    });

  return { cards, warnings };
}
