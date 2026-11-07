import test from "node:test";
import assert from "node:assert/strict";
import { exampleWorkspace } from "../lib/example";
import {
  simulateCashflow,
  type CashflowInput,
  type LedgerEvent,
} from "../lib/money/ledger";
import type { WhatToConfirm } from "../lib/money/schema";

// 「まず確かめる 1 つ」の順位づけ。数字はすべて架空。

const START = "2026-11-06";

function event(
  label: string,
  direction: "out" | "in",
  low: number,
  high: number,
  certainty: "confirmed" | "estimate" | "assumption" = "estimate",
  date = "2026-11-30",
): LedgerEvent {
  return {
    date,
    label,
    direction,
    amount_low: low,
    amount_high: high,
    certainty,
  };
}

function rank(
  scenarios: { name: string; events: LedgerEvent[] }[],
  cash: number | null = null,
): WhatToConfirm {
  const result = simulateCashflow({
    start_date: START,
    cash_on_hand: cash,
    scenarios,
  }).what_to_confirm;
  assert.ok(result);
  return result;
}

function exampleInput(): CashflowInput {
  const card = exampleWorkspace().cards.find((item) => item.kind === "money");
  const found = card?.money?.calculations.find(
    (item) => item.name === "simulate_cashflow",
  );
  assert.ok(found);
  return structuredClone(found.input) as unknown as CashflowInput;
}

const confirmOf = (input: CashflowInput): WhatToConfirm => {
  const result = simulateCashflow(input).what_to_confirm;
  assert.ok(result);
  return result;
};

test("体験例では、窓口で上限が適用されるか（筋書き）を、入院費の額より先に確かめる", () => {
  const confirm = confirmOf(exampleInput());
  assert.equal(confirm.need_low, 115_690);
  assert.equal(confirm.need_high, 324_750);
  assert.equal(confirm.width, 209_060);
  assert.equal(confirm.shortfall_low, null);
  assert.equal(confirm.shortfall_high, null);
  assert.equal(confirm.combinations, 4);
  assert.equal(confirm.omitted_factors, 0);
  assert.deepEqual(
    confirm.factors.map((factor) => [
      factor.kind,
      factor.name,
      factor.width_if_resolved,
      factor.shrink,
    ]),
    [
      ["scenario", "『窓口で上限が適用される場合』か『いったん 3 割を払う場合』か", 60_000, 149_060],
      ["amount", "入院費（保険診療分）の額", 207_060, 2_000],
    ],
  );
  const [scenario, amount] = confirm.factors;
  assert.equal(scenario.label, null);
  assert.deepEqual(scenario.branches, [
    { name: "窓口で上限が適用される場合", need_low: 115_690, need_high: 117_690 },
    { name: "いったん 3 割を払う場合", need_low: 264_750, need_high: 324_750 },
  ]);
  assert.equal(amount.label, "入院費（保険診療分）");
  assert.deepEqual(
    amount.branches.map((branch) => branch.name),
    ["少なめ", "多め"],
  );
  // 食事代は幅が無いので、不明点にならない。
  assert.ok(confirm.factors.every((factor) => factor.label !== "入院中の食事代"));
  assert.ok(confirm.reading_guide.some((line) => line.includes("確率ではない")));
});

test("筋書きの不明点の名前は、2 本なら筋書きの名前から作り、3 本以上ならまとめて呼ぶ", () => {
  const scenarios = ["上限が適用される場合", "3 割を払う場合", "入院が延びる場合"].map(
    (name, index) => ({
      name,
      events: [event("入院費", "out", 100_000 * (index + 1), 100_000 * (index + 1))],
    }),
  );
  const two = rank(scenarios.slice(0, 2));
  assert.equal(two.factors[0].kind, "scenario");
  assert.equal(two.factors[0].name, "『上限が適用される場合』か『3 割を払う場合』か");
  assert.equal(two.factors[0].label, null);
  const three = rank(scenarios);
  assert.equal(three.factors[0].name, "どの筋書きになるか");
  assert.equal(rank(scenarios.slice(0, 1)).factors.length, 0);
});

test("筋書きが 1 本で、額に幅が無ければ、不明点は無く幅も 0", () => {
  const confirm = rank([
    {
      name: "試算",
      events: [
        event("入院費", "out", 92_940, 92_940),
        event("食事代", "out", 24_750, 24_750),
      ],
    },
  ]);
  assert.deepEqual(confirm.factors, []);
  assert.equal(confirm.width, 0);
  assert.equal(confirm.need_low, 117_690);
  assert.equal(confirm.combinations, 1);
});

test("確かめた額は不明点にならず、その幅は残る幅として width に残る", () => {
  const confirm = rank(
    [
      {
        name: "試算",
        events: [
          event("入院費", "out", 100_000, 150_000, "confirmed"),
          event("給付金", "in", 50_000, 50_000, "confirmed", "2026-11-20"),
        ],
      },
    ],
    80_000,
  );
  assert.deepEqual(confirm.factors, []);
  assert.equal(confirm.need_low, 50_000);
  assert.equal(confirm.need_high, 100_000);
  assert.equal(confirm.width, 50_000);
  assert.equal(confirm.shortfall_low, 0);
  assert.equal(confirm.shortfall_high, 20_000);
});

test("確かめていない入金は、入らない・少なめ・多めの 3 つの枝にする（額に幅が無ければ 2 つ）", () => {
  const confirm = rank(
    [
      {
        name: "試算",
        events: [
          event("給付金", "in", 50_000, 100_000, "assumption", "2026-11-10"),
          event("入院費", "out", 200_000, 200_000, "confirmed", "2026-11-20"),
        ],
      },
    ],
    120_000,
  );
  assert.equal(confirm.factors.length, 1);
  const [income] = confirm.factors;
  assert.equal(income.kind, "income");
  assert.equal(income.name, "給付金が入るか");
  assert.deepEqual(income.branches, [
    { name: "入らない", need_low: 200_000, need_high: 200_000 },
    { name: "少なめ", need_low: 150_000, need_high: 150_000 },
    { name: "多め", need_low: 100_000, need_high: 100_000 },
  ]);
  assert.equal(confirm.width, 100_000);
  assert.equal(income.width_if_resolved, 0);
  assert.equal(income.shrink, 100_000);
  assert.equal(confirm.shortfall_low, 0);
  assert.equal(confirm.shortfall_high, 80_000);

  const flat = rank([
    {
      name: "試算",
      events: [
        event("給付金", "in", 50_000, 50_000, "assumption", "2026-11-10"),
        event("入院費", "out", 200_000, 200_000, "confirmed", "2026-11-20"),
      ],
    },
  ]);
  assert.deepEqual(
    flat.factors[0].branches.map((branch) => branch.name),
    ["入らない", "入る"],
  );
});

test("入出金の不明点は 6 つまで。残りは数だけを返し、組み合わせは 2,916 通りまで", () => {
  const ten = Array.from({ length: 10 }, (_, index) =>
    event(`支払い${index + 1}`, "out", 0, (index + 1) * 1_000),
  );
  const one = rank([{ name: "試算", events: ten }]);
  assert.equal(one.factors.length, 6);
  assert.equal(one.omitted_factors, 4);
  assert.equal(one.combinations, 2 ** 6);
  // 広がりの大きい 6 つを残す。
  assert.deepEqual(
    one.factors.map((factor) => factor.label).sort(),
    ["支払い10", "支払い5", "支払い6", "支払い7", "支払い8", "支払い9"],
  );
  assert.equal(one.need_low, 0);
  assert.equal(one.need_high, 55_000);

  // 一番多い場合: 筋書き 4 本 × 入金 6 つ（各 3 つの枝）。
  const incomes = Array.from({ length: 10 }, (_, index) =>
    event(`給付${index + 1}`, "in", 1_000, 2_000 + index, "assumption", "2026-11-10"),
  );
  const most = rank(
    Array.from({ length: 4 }, (_, index) => ({
      name: `筋書き${index + 1}`,
      events: [
        ...incomes,
        event("入院費", "out", 100_000 * (index + 1), 100_000 * (index + 1), "confirmed"),
      ],
    })),
  );
  assert.equal(most.combinations, 2_916);
  // 筋書きが 3 本以上なら、名前を並べずにまとめて呼ぶ。
  assert.equal(most.factors.find((factor) => factor.kind === "scenario")?.name, "どの筋書きになるか");
  assert.ok(most.combinations <= 2_916);
  assert.equal(most.omitted_factors, 4);
  assert.equal(most.factors.length, 7);
  assert.ok(most.factors.every((factor) => factor.branches.length <= 4));
});

test("縮む幅が同じなら、筋書き → 入金 → 支払いの額 → 入力の順に並べる", () => {
  // 筋書きと支払いの額が同点。
  const scenarioFirst = rank([
    { name: "少ない場合", events: [event("入院費", "out", 0, 1_000)] },
    { name: "多い場合", events: [event("入院費", "out", 1_000, 2_000)] },
  ]);
  assert.deepEqual(
    scenarioFirst.factors.map((factor) => [factor.kind, factor.shrink]),
    [
      ["scenario", 1_000],
      ["amount", 1_000],
    ],
  );

  // 入金と支払いの額が同点。入力では支払いが先でも、入金を先にする。
  const incomeFirst = rank([
    {
      name: "試算",
      events: [
        event("差額ベッド代", "out", 0, 1_000),
        event("入院費", "out", 2_000, 2_000, "confirmed"),
        event("給付金", "in", 1_000, 1_000, "assumption", "2026-11-10"),
      ],
    },
  ]);
  assert.deepEqual(
    incomeFirst.factors.map((factor) => [factor.kind, factor.shrink]),
    [
      ["income", 1_000],
      ["amount", 1_000],
    ],
  );

  // 支払いの額どうしが同点なら、入力に出てきた順。
  const inputOrder = rank([
    {
      name: "試算",
      events: [event("通院費", "out", 0, 1_000), event("入院費", "out", 0, 1_000)],
    },
  ]);
  assert.deepEqual(
    inputOrder.factors.map((factor) => factor.label),
    ["通院費", "入院費"],
  );
});

test("先頭の不明点を確かめて計算し直すと、幅は前の「確かめると残る幅」以下になる", () => {
  const before = confirmOf(exampleInput());
  const [top] = before.factors;
  assert.equal(top.kind, "scenario");
  for (const branch of top.branches) {
    const input = exampleInput();
    const after = confirmOf({
      ...input,
      scenarios: input.scenarios.filter(
        (scenario) => scenario.name === branch.name,
      ),
    });
    assert.ok(after.width <= top.width_if_resolved, branch.name);
    assert.equal(after.width, branch.need_high - branch.need_low);
  }
  // 窓口で上限が適用されると分かれば、幅は 209,060 円から 2,000 円に縮む。
  const input = exampleInput();
  const resolved = confirmOf({ ...input, scenarios: [input.scenarios[0]] });
  assert.equal(resolved.width, 2_000);

  // 支払いの額を確かめた額にしたときも、同じく前の残る幅以下になる。
  const amount = before.factors[1];
  for (const pick of ["amount_low", "amount_high"] as const) {
    const changed = exampleInput();
    for (const scenario of changed.scenarios)
      for (const item of scenario.events)
        if (item.label === amount.label) {
          item.amount_low = item.amount_high = item[pick];
          item.certainty = "confirmed";
        }
    const after = confirmOf(changed);
    assert.ok(after.width <= amount.width_if_resolved, pick);
    assert.ok(after.factors.every((factor) => factor.kind === "scenario"));
  }
});

test("同じ向き・同じ名前の入出金は、1 つの不明点として一緒に動く", () => {
  const confirm = rank([
    {
      name: "試算",
      events: [
        event("退院後の支払い", "out", 0, 10_000, "assumption", "2026-12-10"),
        event("退院後の支払い", "out", 0, 10_000, "assumption", "2027-01-10"),
        // 同じ名前でも、確かめた額は動かさない。
        event("退院後の支払い", "out", 5_000, 5_000, "confirmed", "2027-02-10"),
      ],
    },
  ]);
  assert.equal(confirm.factors.length, 1);
  assert.equal(confirm.combinations, 2);
  assert.deepEqual(confirm.factors[0].branches, [
    { name: "少なめ", need_low: 5_000, need_high: 5_000 },
    { name: "多め", need_low: 25_000, need_high: 25_000 },
  ]);
  assert.equal(confirm.width, 20_000);
  assert.equal(confirm.factors[0].shrink, 20_000);
});

test("順位づけは入力を書き換えない", () => {
  const input = exampleInput();
  const before = JSON.stringify(input);
  confirmOf(input);
  assert.equal(JSON.stringify(input), before);
});
