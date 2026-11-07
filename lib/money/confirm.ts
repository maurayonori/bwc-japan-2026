import type { CashflowInput, LedgerEvent } from "./ledger";
import type { WhatToConfirm } from "./schema";

// 「まず確かめる 1 つ」を、入力の幅だけから決める。
// 不明点（どの筋書きになるか・確かめていない支払いの幅・確かめていない入金）ごとに、
// それを確かめたとき、答えがどの額でも残る幅（width_if_resolved）を測り、一番小さくなるものを先頭にする。
// 順位は額の幅の縮み方だけで決める。治療の重さや、給付の判断ではない。
//
// 要る額は、支払いが増えれば増え、入金が増えれば減る。だから、ある不明点を決めたときの要る額の上限と下限は、
// ほかの不明点を「要る額が一番大きくなる端」と「一番小さくなる端」に置いた 2 通りで決まる（#59）。
// ある不明点を少なめと多めのあいだの額にしたとき、要る額を決める支払いの時点が切り替わる境目があるので、
// 端だけでなく、その境目の額でも残る幅を測る。

// 枝の表に出す入出金の不明点は 6 つまで。筋書き 4 本 × 枝 3 つの 6 乗で、組み合わせは 2,916 通りまでに収まる。
// 6 つを選ぶのは、生の金額の幅ではなく、要る額の幅への効き方（確かめたときに縮む額）の大きい順（#59）。
const MAX_EVENT_FACTORS = 6;
const KIND_ORDER = ["scenario", "income", "amount"] as const;
// 筋書きが 3 本以上のときの呼び名。2 本のときは、筋書きの名前から作る（scenarioFactorName）。
const SCENARIO_FACTOR_NAME = "どの筋書きになるか";

// 画面の「読み方」にもそのまま出すので、項目名を使わずに書く。
const READING_GUIDE = [
  "不明点は、要る額の幅を一番縮めるものから並べた。先頭が「まず確かめる 1 つ」。",
  "幅は、置いた仮定の下限と上限の差。確率ではない。",
  "確かめると残る幅は、その不明点だけが分かったとき、答えがどの額でも残る幅のうち大きいほう（少なめと多めのあいだの額も含めて測った）。",
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

type Mode = "high" | "low";
interface Line {
  a: number;
  b: number;
}

// ほかの不明点の置き方。high は要る額が一番大きくなる端（支払いは多め・入金は入らない）、low は一番小さくなる端。
function cornerAmount(
  event: LedgerEvent,
  candidates: ReadonlySet<string>,
  mode: Mode,
): number {
  const out = event.direction === "out";
  if (isUnconfirmed(event) && candidates.has(keyOf(event)))
    return mode === "high"
      ? out
        ? event.amount_high
        : 0
      : out
        ? event.amount_low
        : event.amount_high;
  if (mode === "high")
    return out
      ? event.amount_high
      : isUnconfirmedIncome(event)
        ? 0
        : event.amount_low;
  return out ? event.amount_low : event.amount_high;
}

const fixed = (event: LedgerEvent, amount: number): LedgerEvent => ({
  ...event,
  amount_low: amount,
  amount_high: amount,
});

// 不明点 key を amountOf の額に決め、ほかを mode の端に置いた要る額（台帳の計算そのもの）。
function needAt(
  events: readonly LedgerEvent[],
  key: string | null,
  amountOf: ((event: LedgerEvent) => number) | null,
  candidates: ReadonlySet<string>,
  mode: Mode,
  needRange: NeedRangeOf,
): number {
  const pinned = events.map((event) =>
    key !== null && amountOf && isUnconfirmed(event) && keyOf(event) === key
      ? fixed(event, amountOf(event))
      : fixed(event, cornerAmount(event, candidates, mode)),
  );
  const range = needRange(pinned);
  return mode === "high" ? range.need_high : range.need_low;
}

const DIRECTION_ORDER = ["out", "in"];

// 不明点 key の各回の額を「少なめ + t ×（多め − 少なめ）」としたときの、日付順の累計（の符号を変えたもの）を、
// t の一次式 a + b t の並びにする。要る額は、この並びと 0 のうちの最大。台帳と同じく、同じ日は支払いを先に置く。
function linesOf(
  events: readonly LedgerEvent[],
  key: string,
  candidates: ReadonlySet<string>,
  mode: Mode,
): Line[] {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort(
      (x, y) =>
        x.event.date.localeCompare(y.event.date) ||
        DIRECTION_ORDER.indexOf(x.event.direction) -
          DIRECTION_ORDER.indexOf(y.event.direction) ||
        x.index - y.index,
    );
  const lines: Line[] = [{ a: 0, b: 0 }];
  let a = 0;
  let b = 0;
  for (const { event } of ordered) {
    const member = isUnconfirmed(event) && keyOf(event) === key;
    const low = member ? event.amount_low : cornerAmount(event, candidates, mode);
    const high = member ? event.amount_high : low;
    const sign = event.direction === "out" ? 1 : -1;
    a += sign * low;
    b += sign * (high - low);
    lines.push({ a, b });
  }
  return lines;
}

const valueAt = (lines: readonly Line[], t: number): number =>
  Math.max(...lines.map((line) => line.a + line.b * t));

// 一番上の線が入れ替わる t（0 と 1 のあいだ）。要る額を決める支払いの時点が切り替わる境目。
function switchPoints(lines: readonly Line[]): number[] {
  const points: number[] = [];
  for (let i = 0; i < lines.length; i += 1)
    for (let j = i + 1; j < lines.length; j += 1) {
      const slope = lines[i].b - lines[j].b;
      if (slope === 0) continue;
      const t = (lines[j].a - lines[i].a) / slope;
      if (!(t > 0 && t < 1)) continue;
      const top = valueAt(lines, t);
      if (Math.abs(lines[i].a + lines[i].b * t - top) < 1e-6) points.push(t);
    }
  return points;
}

interface Resolution {
  branches: NeedRange[];
  widthIfResolved: number;
}

// 不明点 factor を確かめたときに残る幅。枝（少なめ・多め・入らない）の額と、少なめと多めのあいだの境目の額で測る。
function resolve(
  input: CashflowInput,
  factor: EventFactor,
  candidates: ReadonlySet<string>,
  needRange: NeedRangeOf,
): Resolution {
  const at = (amountOf: (event: LedgerEvent) => number): NeedRange => ({
    need_low: Math.min(
      ...input.scenarios.map((scenario) =>
        needAt(scenario.events, factor.key, amountOf, candidates, "low", needRange),
      ),
    ),
    need_high: Math.max(
      ...input.scenarios.map((scenario) =>
        needAt(scenario.events, factor.key, amountOf, candidates, "high", needRange),
      ),
    ),
  });
  const branches = factor.branches.map((branch) => at(branch.amountOf));
  const atEnds = Math.max(
    ...branches.map((branch) => branch.need_high - branch.need_low),
  );
  const low = factor.branches.find((branch) => branch.name === "少なめ");
  const high = factor.branches.find((branch) => branch.name === "多め");
  if (!low || !high) return { branches, widthIfResolved: atEnds };
  const sets = input.scenarios.map((scenario) => ({
    high: linesOf(scenario.events, factor.key, candidates, "high"),
    low: linesOf(scenario.events, factor.key, candidates, "low"),
  }));
  const widthAt = (t: number): number =>
    Math.max(...sets.map((set) => valueAt(set.high, t))) -
    Math.min(...sets.map((set) => valueAt(set.low, t)));
  // 一次式の組み立てが台帳の計算と合っているかを、両端（少なめ・多め）で確かめる。合わなければ境目は使わない。
  const lowRange = at(low.amountOf);
  const highRange = at(high.amountOf);
  if (
    Math.abs(widthAt(0) - (lowRange.need_high - lowRange.need_low)) > 0.5 ||
    Math.abs(widthAt(1) - (highRange.need_high - highRange.need_low)) > 0.5
  )
    return { branches, widthIfResolved: atEnds };
  const between = sets
    .flatMap((set) => [...switchPoints(set.high), ...switchPoints(set.low)])
    .map((t) => Math.round(widthAt(t)));
  return { branches, widthIfResolved: Math.max(atEnds, ...between) };
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

// 何を確かめるのかが読んで分かるよう、筋書きが 2 本なら名前をそのまま並べる（例:『A』か『B』か）。
// 3 本以上は並べると長くなるので、まとめて呼ぶ。名前はプログラムが作り、Claude には作らせない。
function scenarioFactorName(scenarios: CashflowInput["scenarios"]): string {
  return scenarios.length === 2
    ? `『${scenarios[0].name}』か『${scenarios[1].name}』か`
    : SCENARIO_FACTOR_NAME;
}

export function rankUncertainties(
  input: CashflowInput,
  needRange: NeedRangeOf,
): WhatToConfirm {
  const candidates = eventFactors(input);
  const keys = new Set(candidates.map((factor) => factor.key));
  // すべての候補で、確かめたときに残る幅を先に測る。ほかの候補は両端に置くので、上限で落とす前の値になる。
  const resolutions = new Map(
    candidates.map((factor) => [
      factor.key,
      resolve(input, factor, keys, needRange),
    ]),
  );
  const cornerWidth =
    Math.max(
      ...input.scenarios.map((scenario) =>
        needAt(scenario.events, null, null, keys, "high", needRange),
      ),
    ) -
    Math.min(
      ...input.scenarios.map((scenario) =>
        needAt(scenario.events, null, null, keys, "low", needRange),
      ),
    );
  const effect = (factor: EventFactor) =>
    cornerWidth - (resolutions.get(factor.key)?.widthIfResolved ?? cornerWidth);
  // 生の金額の幅ではなく、要る額の幅への効き方の大きい順に選ぶ。同じなら幅の大きい順、入力の順。
  const all = [...candidates].sort(
    (a, b) => effect(b) - effect(a) || b.spread - a.spread || a.order - b.order,
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
            scenarioFactorName(input.scenarios),
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
  const ranked = kept.map((factor, factorIndex) => {
    const ranges = toFactor(
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
    );
    // 残る幅は、枝の端に加えて、少なめと多めのあいだの境目も測った値を使う。
    const widthIfResolved = Math.max(
      ranges.width_if_resolved,
      resolutions.get(factor.key)?.widthIfResolved ?? 0,
    );
    return {
      ...ranges,
      width_if_resolved: widthIfResolved,
      shrink: width - widthIfResolved,
    };
  });
  const omitted = all.length - kept.length;
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
    factors: inRankOrder([...scenarioFactor, ...ranked]),
    // 上限で表に入れなかった不明点があるあいだは、「一番」と言い切らない。
    reading_guide:
      omitted > 0
        ? [
            `不明点は、要る額の幅を縮める順に並べた。ほかに ${omitted} 件の不明点があり、表には入れていない。先頭が「まず確かめる 1 つ」。`,
            ...READING_GUIDE.slice(1),
          ]
        : READING_GUIDE,
  };
}
