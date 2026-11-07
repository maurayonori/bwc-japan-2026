import test from "node:test";
import assert from "node:assert/strict";
import { attachMoney, type ToolEvent } from "../lib/money/attach";
import { cashGapText, moneyToText, paydayTable, showDate, yen } from "../lib/money/format";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import { mealCost } from "../lib/money/meals";
import { calculationSchema, type Calculation } from "../lib/money/schema";
import { needRangeOf } from "../lib/views";

// 支払日の表と、計算し直しが途中で止まったときの扱い（Codex の点検、#77）。

// 再現 1: 手元 0 円、11/8 に確かめていない給付金 100,000 円、11/10 に確かめた支払い 100,000 円。
// 給付金を数えると要る額は 0 円になるが、入らなければ 100,000 円が要る。両方を支払日の表に並べる（CLAUDE.md）。
function unconfirmedIncomeOutput(certainty: "assumption" | "estimate") {
  return simulateCashflow({
    start_date: "2026-11-07",
    cash_on_hand: 0,
    scenarios: [
      {
        name: "見通し",
        events: [
          {
            date: "2026-11-08",
            label: "給付金",
            direction: "in",
            amount_low: 100_000,
            amount_high: 100_000,
            certainty,
          },
          {
            date: "2026-11-10",
            label: "入院費",
            direction: "out",
            amount_low: 100_000,
            amount_high: 100_000,
            certainty: "confirmed",
          },
        ],
      },
    ],
  });
}

test("支払日の表は、確かめていない入金を数えない場合の行を、その筋書きのすぐ下に並べる", () => {
  const output = unconfirmedIncomeOutput("assumption");
  const { headers, rows } = paydayTable(output);
  assert.deepEqual(headers, ["筋書き", "要る額", "いつ", "手元のお金との差", "確かさ"]);
  assert.equal(rows.length, 2);
  const without = output.scenarios[0].high_case_without_unconfirmed_income;
  assert.equal(without.need, 100_000);
  assert.deepEqual(rows[1], [
    "見通し・確かめていない入金を数えない場合",
    yen(without.need),
    showDate("2026-11-10", 2026),
    cashGapText(0, without.need, without.need),
    "確かめた額",
  ]);
});

test("支払日の表の確かさの列には、数えた入金の確かさも入る", () => {
  for (const [certainty, text] of [
    ["assumption", "確かめた額・仮定"],
    ["estimate", "確かめた額・見積もり"],
  ] as const) {
    const [counted] = paydayTable(unconfirmedIncomeOutput(certainty)).rows;
    assert.equal(counted[0], "見通し");
    assert.equal(counted[4], text);
  }
});

test("確かめていない入金が無い筋書きには、行を足さない", () => {
  const output = simulateCashflow({
    start_date: "2026-11-07",
    cash_on_hand: 200_000,
    scenarios: [
      {
        name: "見通し",
        events: [
          {
            date: "2026-11-10",
            label: "入院費",
            direction: "out",
            amount_low: 100_000,
            amount_high: 100_000,
            certainty: "estimate",
          },
        ],
      },
    ],
  });
  assert.equal(paydayTable(output).rows.length, 1);
});

// 再現 2: 区分ウ・総額 80 万円・食事代 24,750 円で見通しを作り、総額を 160 万円に変える。
// 新しい kougaku_gendo が成功したあと、simulate_cashflow の前に時間切れになった（chat.ts の catch で forceTable）。
const KOUGAKU_INPUT = (total: number) => ({
  treatment_month: "2026-12",
  income_category: "ウ",
  amount_basis: "total",
  amount_low: total,
  amount_high: total,
  copay_percent: 30,
});
const MEAL_INPUT = { days_low: 15, days_high: 15 };

function cashflowInput(hospital: number, meals: number) {
  const event = (label: string, amount: number) => ({
    date: "2026-12-28",
    label,
    direction: "out",
    amount_low: amount,
    amount_high: amount,
    certainty: "estimate",
  });
  return {
    start_date: "2026-11-30",
    cash_on_hand: 200_000,
    scenarios: [
      { name: "窓口で上限が使える場合", events: [event("入院費（保険診療分）", hospital), event("入院中の食事代", meals)] },
    ],
  };
}

function staleCase(freshEvents: (calc: ReturnType<typeof calcs>) => ToolEvent[]) {
  const calc = calcs();
  const prior: Calculation[] = [
    calculationSchema.parse({ name: "kougaku_gendo", input: KOUGAKU_INPUT(800_000), output: calc.oldKougaku }),
    calculationSchema.parse({ name: "meal_cost", input: MEAL_INPUT, output: calc.meals }),
    calculationSchema.parse({ name: "simulate_cashflow", input: calc.oldCashflowInput, output: calc.oldCashflow }),
  ];
  const existing = [
    {
      id: "money-1",
      kind: "money" as const,
      title: "お金の見通し",
      body: "計算の結果を表にしました。",
      nextStep: "表を読む。",
      uncertainty: "",
      evidence: [{ messageId: "u1", quote: "総額は160万円でした" }],
      edited: false,
      done: false,
      included: false,
    },
  ];
  const messages = [
    { id: "u1", role: "user" as const, text: "総額は160万円でした" },
  ];
  return attachMoney({
    proposals: [],
    events: freshEvents(calc),
    existing,
    prior: new Map([["money-1", prior]]),
    messages,
    forceTable: true,
  });
}

function calcs() {
  const oldKougaku = kougakuGendo(KOUGAKU_INPUT(800_000));
  const newKougaku = kougakuGendo(KOUGAKU_INPUT(1_600_000));
  const meals = mealCost(MEAL_INPUT);
  const oldCashflowInput = cashflowInput(oldKougaku.cases[0].low.pay_with_cap, meals.low.cost_max);
  const newCashflowInput = cashflowInput(newKougaku.cases[0].low.pay_with_cap, meals.low.cost_max);
  return {
    oldKougaku,
    newKougaku,
    meals,
    oldCashflowInput,
    oldCashflow: simulateCashflow(oldCashflowInput),
    newCashflowInput,
    newCashflow: simulateCashflow(newCashflowInput),
  };
}

test("再現の数字: 新しい保険診療分は 98,940 円、古い要る額は 115,690 円、正しい要る額は 123,690 円", () => {
  const calc = calcs();
  assert.equal(calc.newKougaku.cases[0].low.pay_with_cap, 98_940);
  assert.equal(calc.oldCashflow.scenarios[0].low_case.need, 115_690);
  assert.equal(calc.newCashflow.scenarios[0].low_case.need, 123_690);
});

test("内訳の計算のあとに見通しが無いとき、残った見通しに「前の条件での計算」の印を付け、計算し直すよう頼む", () => {
  const { cards, warnings } = staleCase((calc) => [
    { name: "kougaku_gendo", input: KOUGAKU_INPUT(1_600_000), ok: true, output: calc.newKougaku },
  ]);
  const [card] = cards;
  assert.ok(card?.money);
  const names = card.money.calculations.map((item) => item.name);
  assert.ok(names.includes("simulate_cashflow"));
  assert.equal(card.money.stale_cashflow, true);
  assert.ok(warnings.some((warning) => warning.message.includes("前の条件") && warning.message.includes("計算し直")));
  const full = { ...card, edited: false, done: false, included: false };
  // 返答の下のリンクに、古い要る額を今の額として書かない。
  assert.equal(needRangeOf(full), null);
  // 持ち出しの文にも、前の条件での計算だと書く。
  assert.ok(moneyToText(card.money, "").includes("前の条件での計算"));
});

test("失敗した見通しも、成功した見通しが無いのと同じに扱う", () => {
  const { cards } = staleCase((calc) => [
    { name: "kougaku_gendo", input: KOUGAKU_INPUT(1_600_000), ok: true, output: calc.newKougaku },
    { name: "simulate_cashflow", input: calc.newCashflowInput, ok: false, error: "時間切れ" },
  ]);
  assert.equal(cards[0]?.money?.stale_cashflow, true);
});

test("内訳のあとに見通しも計算し直したときは、印を付けず、新しい要る額を出す", () => {
  const { cards, warnings } = staleCase((calc) => [
    { name: "kougaku_gendo", input: KOUGAKU_INPUT(1_600_000), ok: true, output: calc.newKougaku },
    { name: "simulate_cashflow", input: calc.newCashflowInput, ok: true, output: calc.newCashflow },
  ]);
  const [card] = cards;
  assert.ok(card?.money);
  assert.equal(card.money.stale_cashflow, undefined);
  assert.ok(!warnings.some((warning) => warning.message.includes("前の条件")));
  assert.deepEqual(needRangeOf({ ...card, edited: false, done: false, included: false }), { low: 123_690, high: 123_690 });
});
