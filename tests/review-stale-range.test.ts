import test from "node:test";
import assert from "node:assert/strict";
import {
  attachMoney,
  cashflowIsStale,
  toCalculations,
  type ToolEvent,
} from "../lib/money/attach";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import { mealCost } from "../lib/money/meals";

// 見通しのあとに、下限は同じで上限だけが増えた内訳が来たとき（Codex の最終の点検の高、#107。関連 #77）。
// 下限が見通しの入出金と一致するだけで「反映済み」とみなし、古い額に印が付かなかった。

const KOUGAKU_INPUT = (low: number, high: number) => ({
  treatment_month: "2026-12",
  income_category: "ウ",
  amount_basis: "total",
  amount_low: low,
  amount_high: high,
  copay_percent: 30,
});
const MEALS_15 = { days_low: 15, days_high: 15 };
const MEALS_15_22 = { days_low: 15, days_high: 22 };
const MEALS_22 = { days_low: 22, days_high: 22 };

type Range = [low: number, high: number];

function cashflowInput(hospital: Range, meals: Range) {
  const event = (label: string, [low, high]: Range) => ({
    date: "2026-12-28",
    label,
    direction: "out",
    amount_low: low,
    amount_high: high,
    certainty: "estimate",
  });
  return {
    start_date: "2026-11-30",
    cash_on_hand: 120_000,
    scenarios: [
      {
        name: "窓口で上限が使える場合",
        events: [
          event("入院費（保険診療分）", hospital),
          event("入院中の食事代", meals),
        ],
      },
    ],
  };
}

const ok = (name: string, input: unknown, output: unknown): ToolEvent => ({
  name,
  input,
  ok: true,
  output,
});

function cashflowEvent(hospital: Range, meals: Range): ToolEvent {
  const input = cashflowInput(hospital, meals);
  return ok("simulate_cashflow", input, simulateCashflow(input as never));
}

const stale = (events: ToolEvent[]) =>
  cashflowIsStale(events, toCalculations(events));

const hospital800k = () =>
  kougakuGendo(KOUGAKU_INPUT(800_000, 800_000)).cases[0].low.pay_with_cap;

// 再現: 食事代 15 日 → 見通し → 食事代 15〜22 日。
function reproduction(): ToolEvent[] {
  const hospital = hospital800k();
  const meals15 = mealCost(MEALS_15);
  return [
    ok("meal_cost", MEALS_15, meals15),
    cashflowEvent(
      [hospital, hospital],
      [meals15.low.cost_max, meals15.high.cost_max],
    ),
    ok("meal_cost", MEALS_15_22, mealCost(MEALS_15_22)),
  ];
}

test("再現の数字: 保険診療分 90,940 円・食事代 24,750 円で要る額 115,690 円・4,310 円残る。食事代の上限は 36,300 円", () => {
  const hospital = hospital800k();
  assert.equal(hospital, 90_940);
  const range = mealCost(MEALS_15_22);
  assert.equal(range.low.cost_max, 24_750);
  assert.equal(range.high.cost_max, 36_300);
  const output = simulateCashflow(
    cashflowInput([hospital, hospital], [24_750, 24_750]) as never,
  );
  assert.equal(output.scenarios[0].low_case.need, 115_690);
  assert.equal(120_000 - output.scenarios[0].low_case.need, 4_310);
});

test("見通しのあとに下限だけが見通しと同じ範囲の食事代が来たら、印を付ける", () => {
  assert.equal(stale(reproduction()), true);
});

test("再現を attachMoney に通すと、カードに印が付き、計算し直すよう頼む", () => {
  const { cards, warnings } = attachMoney({
    proposals: [],
    events: reproduction(),
    existing: [],
    prior: new Map(),
    messages: [
      {
        id: "u1",
        role: "user",
        text: "退院が延びて、15日から22日になるかもしれません",
      },
    ],
    forceTable: true,
  });
  const [card] = cards;
  assert.ok(card?.money);
  assert.equal(card.money.stale_cashflow, true);
  assert.ok(
    warnings.some(
      (warning) =>
        warning.message.includes("前の条件") &&
        warning.message.includes("計算し直"),
    ),
  );
});

test("見通しの食事代が 24,750〜36,300 円なら、あとの食事代 15〜22 日に印を付けない", () => {
  const events = reproduction();
  const hospital = hospital800k();
  events[1] = cashflowEvent([hospital, hospital], [24_750, 36_300]);
  assert.equal(stale(events), false);
});

test("見通しの食事代が 36,300 円だけ（多めに見た）なら、あとの食事代 15〜22 日に印を付けない", () => {
  const events = reproduction();
  const hospital = hospital800k();
  events[1] = cashflowEvent([hospital, hospital], [36_300, 36_300]);
  assert.equal(stale(events), false);
});

test("見通しの入出金が保険診療分と食事代の上限の合計なら、あとの食事代 15〜22 日に印を付けない", () => {
  const hospital = hospital800k();
  const combined = {
    start_date: "2026-11-30",
    cash_on_hand: 120_000,
    scenarios: [
      {
        name: "窓口で上限が使える場合",
        events: [
          {
            date: "2026-12-28",
            label: "入院費（保険診療分と食事代）",
            direction: "out",
            amount_low: hospital + 24_750,
            amount_high: hospital + 36_300,
            certainty: "estimate",
          },
        ],
      },
    ],
  };
  const events = [
    ok(
      "kougaku_gendo",
      KOUGAKU_INPUT(800_000, 800_000),
      kougakuGendo(KOUGAKU_INPUT(800_000, 800_000)),
    ),
    ok("simulate_cashflow", combined, simulateCashflow(combined as never)),
    ok("meal_cost", MEALS_15_22, mealCost(MEALS_15_22)),
  ];
  assert.equal(stale(events), false);
});

// 11/8 のデモと同じ形（下限と上限が同じ内訳）。今までどおり、見通しに入っている額なら印を付けない。
test("デモと同じ形: 見通し（食事代 36,300 円）のあとに食事代 22 日が来ても、印を付けない", () => {
  const hospital = hospital800k();
  const events = [
    ok("meal_cost", MEALS_22, mealCost(MEALS_22)),
    cashflowEvent([hospital, hospital], [36_300, 36_300]),
    ok("meal_cost", MEALS_22, mealCost(MEALS_22)),
    ok(
      "kougaku_gendo",
      KOUGAKU_INPUT(800_000, 800_000),
      kougakuGendo(KOUGAKU_INPUT(800_000, 800_000)),
    ),
  ];
  assert.equal(stale(events.filter((_, index) => index !== 2)), false);
  assert.equal(stale([events[1], events[2]]), false);
  assert.equal(stale(events), false);
});

test("下限と上限が同じ内訳で、額が見通しに無ければ、今までどおり印を付ける", () => {
  const hospital = hospital800k();
  const events = [
    cashflowEvent([hospital, hospital], [24_750, 24_750]),
    ok("meal_cost", MEALS_22, mealCost(MEALS_22)),
  ];
  assert.equal(stale(events), true);
});

test("高額療養費の範囲（総額 80 万〜120 万円）: 見通しが 80 万円の額だけなら印を付け、120 万円の額も入っていれば付けない", () => {
  const range = kougakuGendo(KOUGAKU_INPUT(800_000, 1_200_000));
  const [item] = range.cases;
  assert.notEqual(item.low.pay_with_cap, item.high.pay_with_cap);
  const after = ok("kougaku_gendo", KOUGAKU_INPUT(800_000, 1_200_000), range);
  const lowOnly = cashflowEvent(
    [item.low.pay_with_cap, item.low.pay_with_cap],
    [24_750, 24_750],
  );
  assert.equal(stale([lowOnly, after]), true);
  const both = cashflowEvent(
    [item.low.pay_with_cap, item.high.pay_with_cap],
    [24_750, 24_750],
  );
  assert.equal(stale([both, after]), false);
});

test("高額療養費の範囲: 見通しの入出金が 120 万円の額と食事代の合計なら、印を付けない", () => {
  const range = kougakuGendo(KOUGAKU_INPUT(800_000, 1_200_000));
  const [item] = range.cases;
  const meals15 = mealCost(MEALS_15);
  const combined = {
    start_date: "2026-11-30",
    cash_on_hand: 120_000,
    scenarios: [
      {
        name: "窓口で上限が使える場合",
        events: [
          {
            date: "2026-12-28",
            label: "入院費（保険診療分と食事代）",
            direction: "out",
            amount_low: item.low.pay_with_cap + meals15.low.cost_max,
            amount_high: item.high.pay_with_cap + meals15.high.cost_max,
            certainty: "estimate",
          },
        ],
      },
    ],
  };
  const events = [
    ok("meal_cost", MEALS_15, meals15),
    ok("simulate_cashflow", combined, simulateCashflow(combined as never)),
    ok("kougaku_gendo", KOUGAKU_INPUT(800_000, 1_200_000), range),
  ];
  assert.equal(stale(events), false);
});
