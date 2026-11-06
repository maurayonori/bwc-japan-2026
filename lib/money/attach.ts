import type { Card, Message, Proposal } from "../workspace";
import { validateEvidence } from "../workspace";
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

export const SYNTHETIC_BODY =
  "計算の結果を表にしました。説明は会話の返答を見てください。";
const SYNTHETIC_NEXT_STEP = "表の前提を読み、違うところを会話で伝える。";
const SYNTHETIC_UNCERTAINTY =
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

// 今回の計算を優先し、今回呼ばなかった道具の前回の結果は残す（出典や内訳が表から消えないように）。
function combine(
  fresh: readonly Calculation[],
  prior: readonly Calculation[],
): Calculation[] {
  const names = new Set(fresh.map((calculation) => calculation.name));
  const kept = fresh.slice(-MAX_CALCULATIONS);
  return [
    ...prior.filter((calculation) => !names.has(calculation.name)),
    ...kept,
  ].slice(-MAX_CALCULATIONS);
}

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
  messages,
  forceTable = false,
}: {
  proposals: readonly Proposal[];
  events: readonly ToolEvent[];
  existing: readonly ExistingCard[];
  prior: ReadonlyMap<string, readonly Calculation[]>;
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
      if (hasValidEvidence(proposal, messages)) cards.push(proposal);
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
        money: {
          calculations: combine(fresh, prior.get(proposal.id) ?? []),
        },
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
    const money = {
      calculations: combine(fresh, base ? (prior.get(base.id) ?? []) : []),
    };
    cards.push({
      id,
      kind: "money",
      title: "お金の見通し",
      body: SYNTHETIC_BODY,
      nextStep: SYNTHETIC_NEXT_STEP,
      uncertainty: SYNTHETIC_UNCERTAINTY,
      evidence: citeLastUser(lastUser),
      money,
    });
  }

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
