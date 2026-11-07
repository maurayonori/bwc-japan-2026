import type { CashflowInput, LedgerEvent } from "./ledger";
import type { WhatToConfirm } from "./schema";

// 「まず確かめる 1 つ」を、入力の幅だけから決める。
// 不明点（どの筋書きになるか・確かめていない支払いの幅・確かめていない入金）ごとに取りうる枝を置き、
// すべての組み合わせで手元に要る額を計算する。ある不明点を確かめたとき、答えがどの枝でも
// 残る幅（width_if_resolved）が一番小さくなるものを先頭にする。
// 順位は額の幅の縮み方だけで決める。治療の重さや、給付の判断ではない。

// 入出金の不明点は 6 つまで。筋書き 4 本 × 枝 3 つの 6 乗で、組み合わせは 2,916 通りまでに収まる。
const MAX_EVENT_FACTORS = 6;
const KIND_ORDER = ["scenario", "income", "amount"] as const;
const SCENARIO_FACTOR_NAME = "どの筋書きになるか";

// 画面の「読み方」にもそのまま出すので、項目名を使わずに書く。
const READING_GUIDE = [
  "不明点は、要る額の幅を一番縮めるものから並べた。先頭が「まず確かめる 1 つ」。",
  "幅は、置いた仮定の下限と上限の差。確率ではない。",
  "確かめると残る幅は、その不明点だけが分かったとき、答えがどちらでも残る幅のうち大きいほう。",
  "答えごとの要る額は、ほかの不明点がまだ分からないときの幅。",
  "確かめた額は不明点に数えない。確かめていない入金は、入らない場合も数えている。",
  "同じ向き・同じ名前の入出金は、筋書きをまたいでも 1 つの不明点として一緒に動かしている。",
  "順位は額の幅の縮み方だけで決めている。治療や給付の判断ではない。",
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
const isUnconfirmed = (event: LedgerEvent): boolean =>
  event.certainty !== "confirmed";
const isUnconfirmedIncome = (event: LedgerEvent): boolean =>
  event.direction === "in" && isUnconfirmed(event);
const isUncertainAmount = (event: LedgerEvent): boolean =>
  event.direction === "out" &&
  isUnconfirmed(event) &&
  event.amount_low !== event.amount_high;

const AMOUNT_BRANCHES: Branch[] = [
  { name: "少なめ", amountOf: (event) => event.amount_low },
  { name: "多め", amountOf: (event) => event.amount_high },
];

// 入金は「入らない」を必ず枝に入れる。どれかの筋書きで額に幅があれば、少なめと多めに分ける。
function incomeBranches(events: readonly LedgerEvent[]): Branch[] {
  const hasRange = events.some(
    (event) => event.amount_low !== event.amount_high,
  );
  return [
    { name: "入らない", amountOf: () => 0 },
    ...(hasRange
      ? AMOUNT_BRANCHES
      : [{ name: "入る", amountOf: (event: LedgerEvent) => event.amount_high }]),
  ];
}

// 同じ向き・同じ名前の入出金は 1 つの不明点にまとめる（筋書きをまたいでも同じ）。
// 確かめた額（confirmed）は、同じ名前でも不明点に入れない。
function eventFactors(input: CashflowInput): EventFactor[] {
  const found = new Map<string, EventFactor>();
  const members = new Map<string, LedgerEvent[]>();
  for (const scenario of input.scenarios) {
    const perScenario = new Map<string, number>();
    for (const event of scenario.events) {
      const income = isUnconfirmedIncome(event);
      if (!income && !isUncertainAmount(event)) continue;
      const spread = income
        ? event.amount_high
        : event.amount_high - event.amount_low;
      // 0 円の入金は、入っても入らなくても要る額を動かさない。
      if (spread <= 0) continue;
      const key = keyOf(event);
      perScenario.set(key, (perScenario.get(key) ?? 0) + spread);
      if (!found.has(key))
        found.set(key, {
          kind: income ? "income" : "amount",
          key,
          name: income ? `${event.label}が入るか` : `${event.label}の額`,
          label: event.label,
          branches: AMOUNT_BRANCHES,
          spread: 0,
          order: found.size,
        });
    }
    for (const [key, spread] of perScenario) {
      const factor = found.get(key);
      if (factor) factor.spread = Math.max(factor.spread, spread);
    }
  }
  for (const scenario of input.scenarios)
    for (const event of scenario.events)
      if (isUnconfirmed(event) && found.has(keyOf(event)))
        members.set(keyOf(event), [
          ...(members.get(keyOf(event)) ?? []),
          event,
        ]);
  return [...found.values()].map((factor) =>
    factor.kind === "income"
      ? { ...factor, branches: incomeBranches(members.get(factor.key) ?? []) }
      : factor,
  );
}

function pin(event: LedgerEvent, choice: ReadonlyMap<string, Branch>): LedgerEvent {
  const branch = isUnconfirmed(event) ? choice.get(keyOf(event)) : undefined;
  if (branch) {
    const amount = branch.amountOf(event);
    return { ...event, amount_low: amount, amount_high: amount };
  }
  // 順位に入れなかった確かめていない入金も、入らない場合を幅に入れる。
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

interface Ranked extends Factor {
  order: number;
}

function toFactor(
  kind: Kind,
  name: string,
  label: string | null,
  order: number,
  branches: { name: string; results: Evaluated[] }[],
  width: number,
): Ranked {
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
    order,
  };
}

// 縮む幅の大きい順。同じなら、筋書き → 入金 → 支払いの額 → 入力に出てきた順。
function inRankOrder(factors: readonly Ranked[]): Factor[] {
  return [...factors]
    .sort(
      (a, b) =>
        b.shrink - a.shrink ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.order - b.order,
    )
    .map(({ order: _order, ...factor }) => factor);
}

export function rankUncertainties(
  input: CashflowInput,
  needRange: NeedRangeOf,
): WhatToConfirm {
  const all = eventFactors(input).sort(
    (a, b) => b.spread - a.spread || a.order - b.order,
  );
  const kept = all.slice(0, MAX_EVENT_FACTORS);
  const results = evaluateAll(input, kept, needRange);
  const overall = rangeOf(results);
  const width = overall.need_high - overall.need_low;

  const scenarioFactor =
    input.scenarios.length >= 2
      ? [
          toFactor(
            "scenario",
            SCENARIO_FACTOR_NAME,
            null,
            -1,
            input.scenarios.map((scenario, index) => ({
              name: scenario.name,
              results: results.filter((item) => item.scenario === index),
            })),
            width,
          ),
        ]
      : [];
  const ranked = kept.map((factor, factorIndex) =>
    toFactor(
      factor.kind,
      factor.name,
      factor.label,
      factor.order,
      factor.branches.map((branch, branchIndex) => ({
        name: branch.name,
        results: results.filter(
          (item) => item.choice[factorIndex] === branchIndex,
        ),
      })),
      width,
    ),
  );
  const cash = input.cash_on_hand;
  return {
    need_low: overall.need_low,
    need_high: overall.need_high,
    width,
    shortfall_low: cash === null ? null : Math.max(0, overall.need_low - cash),
    shortfall_high:
      cash === null ? null : Math.max(0, overall.need_high - cash),
    combinations: results.length,
    omitted_factors: all.length - kept.length,
    factors: inRankOrder([...scenarioFactor, ...ranked]),
    reading_guide: READING_GUIDE,
  };
}
