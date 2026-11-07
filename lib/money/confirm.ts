import type { CashflowInput, LedgerEvent } from "./ledger";
import type { WhatToConfirm } from "./schema";

// 「まず確かめる 1 つ」を、入力の不確かさだけから決める。
// 不明点（どの筋書きになるか・未確認の支払いの幅・未確認の入金）ごとに取りうる枝を置き、
// 全部の組み合わせで手元に要る額を計算する。ある不明点を確かめたとき、答えがどの枝でも
// 残る幅（width_if_resolved）が一番小さくなるものを先頭にする。
// 順位は金額の幅の縮み方だけで決める。医学的な重要度や、給付の判断ではない。

const MAX_EVENT_FACTORS = 6;
const KIND_ORDER = ["scenario", "income", "amount"] as const;

const READING_GUIDE = [
  "factors は、幅を一番縮める不明点から並べた。先頭が「まず確かめる 1 つ」。",
  "width は、いまの手元に要る額の幅（need_high − need_low）。width_if_resolved は、その不明点を確かめたとき、答えがどの枝でも残る幅の大きいほう。shrink はその差。",
  "枝ごとの need_low と need_high は、ほかの不明点が決まっていないときの幅。",
  "確かめていない入金は、入らない場合も枝に入れた。筋書きが 2 つ以上あるときは、どの筋書きになるかも 1 つの不明点として数えた。",
  "幅は、置いた仮定の下限と上限。確率ではない。順位は金額の幅の縮み方だけで決めていて、治療や給付の判断ではない。",
];

type Kind = (typeof KIND_ORDER)[number];
type Factor = WhatToConfirm["factors"][number];

export interface NeedRange {
  need_low: number;
  need_high: number;
}

// 支払いを下限・入金を上限で置いたときの要る額が need_low、支払いを上限・入金を下限で置いたときが need_high。
// 台帳の計算をそのまま使うため、関数で受け取る（ledger.ts がこのモジュールを読むので、逆向きには読まない）。
export type NeedRangeOf = (events: LedgerEvent[]) => NeedRange;

interface Branch {
  name: string;
  amountOf: (event: LedgerEvent) => number;
}

interface EventFactor {
  kind: Exclude<Kind, "scenario">;
  key: string;
  name: string;
  label: string;
  branches: Branch[];
  spread: number;
  order: number;
}

interface Evaluated {
  scenario: number;
  choice: number[];
  need: NeedRange;
}

const keyOf = (event: LedgerEvent): string =>
  `${event.direction}\u0000${event.label}`;
const isUnconfirmedIncome = (event: LedgerEvent): boolean =>
  event.direction === "in" && event.certainty !== "confirmed";
const isUncertainAmount = (event: LedgerEvent): boolean =>
  event.direction === "out" &&
  event.certainty !== "confirmed" &&
  event.amount_low !== event.amount_high;

function incomeBranches(events: LedgerEvent[]): Branch[] {
  const hasRange = events.some(
    (event) => event.amount_low !== event.amount_high,
  );
  return [
    { name: "入らない", amountOf: () => 0 },
    ...(hasRange
      ? [
          { name: "少なめ", amountOf: (event: LedgerEvent) => event.amount_low },
          { name: "多め", amountOf: (event: LedgerEvent) => event.amount_high },
        ]
      : [{ name: "入る", amountOf: (event: LedgerEvent) => event.amount_high }]),
  ];
}

const AMOUNT_BRANCHES: Branch[] = [
  { name: "少なめ", amountOf: (event) => event.amount_low },
  { name: "多め", amountOf: (event) => event.amount_high },
];

// 同じ向き・同じ名前の入出金は 1 つの不明点にまとめる（筋書きをまたいでも同じ）。
function eventFactors(input: CashflowInput): EventFactor[] {
  const found = new Map<string, EventFactor>();
  input.scenarios.forEach((scenario) => {
    const perScenario = new Map<string, number>();
    scenario.events.forEach((event) => {
      const income = isUnconfirmedIncome(event);
      if (!income && !isUncertainAmount(event)) return;
      const key = keyOf(event);
      const spread = income
        ? event.amount_high
        : event.amount_high - event.amount_low;
      if (spread <= 0) return;
      perScenario.set(key, (perScenario.get(key) ?? 0) + spread);
      if (!found.has(key)) {
        found.set(key, {
          kind: income ? "income" : "amount",
          key,
          name: income ? `${event.label}が入るか` : `${event.label}の額`,
          label: event.label,
          branches: income ? incomeBranches([event]) : AMOUNT_BRANCHES,
          spread: 0,
          order: found.size,
        });
      }
    });
    perScenario.forEach((spread, key) => {
      const factor = found.get(key);
      if (factor) factor.spread = Math.max(factor.spread, spread);
    });
  });
  // 入金は、どれかの筋書きで幅があれば 3 つの枝にする。
  return [...found.values()].map((factor) =>
    factor.kind === "income"
      ? {
          ...factor,
          branches: incomeBranches(
            input.scenarios.flatMap((scenario) =>
              scenario.events.filter((event) => keyOf(event) === factor.key),
            ),
          ),
        }
      : factor,
  );
}

function pin(event: LedgerEvent, choice: Map<string, Branch>): LedgerEvent {
  const branch = choice.get(keyOf(event));
  if (branch) {
    const amount = branch.amountOf(event);
    return { ...event, amount_low: amount, amount_high: amount };
  }
  // 決めていない未確認の入金は、下限を 0（入らない）にして幅に入れる。
  return isUnconfirmedIncome(event) ? { ...event, amount_low: 0 } : event;
}

function combinations(factors: readonly EventFactor[]): number[][] {
  return factors.reduce<number[][]>(
    (done, factor) =>
      done.flatMap((choice) =>
        factor.branches.map((_, index) => [...choice, index]),
      ),
    [[]],
  );
}

function evaluateAll(
  input: CashflowInput,
  factors: readonly EventFactor[],
  needRange: NeedRangeOf,
): Evaluated[] {
  const choices = combinations(factors);
  return input.scenarios.flatMap((scenario, scenarioIndex) =>
    choices.map((choice) => {
      const pinned = new Map(
        factors.map((factor, index) => [
          factor.key,
          factor.branches[choice[index]],
        ]),
      );
      return {
        scenario: scenarioIndex,
        choice,
        need: needRange(scenario.events.map((event) => pin(event, pinned))),
      };
    }),
  );
}

function rangeOf(results: readonly Evaluated[]): NeedRange {
  return results.reduce(
    (range, { need }) => ({
      need_low: Math.min(range.need_low, need.need_low),
      need_high: Math.max(range.need_high, need.need_high),
    }),
    { need_low: Infinity, need_high: -Infinity },
  );
}

function toFactor(
  kind: Kind,
  name: string,
  label: string | null,
  branches: { name: string; results: Evaluated[] }[],
  width: number,
): Factor {
  const ranges = branches.map((branch) => ({
    name: branch.name,
    ...rangeOf(branch.results),
  }));
  const widthIfResolved = Math.max(
    ...ranges.map((branch) => branch.need_high - branch.need_low),
  );
  return {
    kind,
    name,
    label,
    branches: ranges,
    width_if_resolved: widthIfResolved,
    shrink: width - widthIfResolved,
  };
}

function orderFactors(factors: readonly Factor[], inputOrder: Map<string, number>): Factor[] {
  return [...factors].sort(
    (a, b) =>
      b.shrink - a.shrink ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (inputOrder.get(a.name) ?? 0) - (inputOrder.get(b.name) ?? 0),
  );
}

export function rankUncertainties(
  input: CashflowInput,
  needRange: NeedRangeOf,
): WhatToConfirm {
  const all = eventFactors(input).sort(
    (a, b) => b.spread - a.spread || a.order - b.order,
  );
  const kept = all.slice(0, MAX_EVENT_FACTORS);
  const omitted = all.slice(MAX_EVENT_FACTORS).map((factor) => factor.name);
  const results = evaluateAll(input, kept, needRange);
  const overall = rangeOf(results);
  const width = overall.need_high - overall.need_low;

  const scenarioFactor: Factor[] =
    input.scenarios.length >= 2
      ? [
          toFactor(
            "scenario",
            "どの筋書きになるか",
            null,
            input.scenarios.map((scenario, index) => ({
              name: scenario.name,
              results: results.filter((item) => item.scenario === index),
            })),
            width,
          ),
        ]
      : [];
  const eventFactorsRanked = kept.map((factor, factorIndex) =>
    toFactor(
      factor.kind,
      factor.name,
      factor.label,
      factor.branches.map((branch, branchIndex) => ({
        name: branch.name,
        results: results.filter(
          (item) => item.choice[factorIndex] === branchIndex,
        ),
      })),
      width,
    ),
  );
  const inputOrder = new Map<string, number>([
    ["どの筋書きになるか", -1],
    ...kept.map((factor): [string, number] => [factor.name, factor.order]),
  ]);
  const cash = input.cash_on_hand;
  return {
    need_low: overall.need_low,
    need_high: overall.need_high,
    width,
    shortfall_low: cash === null ? null : Math.max(0, overall.need_low - cash),
    shortfall_high:
      cash === null ? null : Math.max(0, overall.need_high - cash),
    combinations: results.length,
    omitted_factors: omitted,
    factors: orderFactors([...scenarioFactor, ...eventFactorsRanked], inputOrder),
    reading_guide: READING_GUIDE,
  };
}
