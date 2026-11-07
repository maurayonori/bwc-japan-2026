import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exampleMoneyTurns, exampleWorkspace } from "../lib/example";
import { calcDate } from "../lib/money/business-days";
import { cashGapText, yen } from "../lib/money/format";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow, type CashflowInput } from "../lib/money/ledger";
import { mealCost } from "../lib/money/meals";
import { KOUGAKU_UNDER_70, MEAL_COPAY } from "../lib/money/rules";

// README と提出文の架空の例の金額が、本番と同じ計算関数の結果と一致することを確かめる（#55）。
// 条件: 2026 年 12 月 14 日〜28 日、協会けんぽ、区分ウ、医療費の総額 80 万円、手元 20 万円。
// 月をまたぐ 3 行は、1 週間延びて 2027 年 1 月 4 日に退院する場合。上限は月ごとに掛かるので、12 月と 1 月に分けて計算する。

const ROOT = join(__dirname, "..");
const CASH_ON_HAND = 200_000;
const TOTAL_COST = 800_000;
const ADMISSION = "2026-12-14";
const DISCHARGE = "2026-12-28";
const DISCHARGE_EXTENDED = "2027-01-04";
const START = "2026-11-30";

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

// 表から 1 列目が label の行を探し、「要る額」と「手元との差」の列を返す。prettier の詰め物は trim で消える。
function tableRow(markdown: string, label: string): [string, string] {
  const cellsOf = (line: string) => line.split("|").map((cell) => cell.trim());
  const line = markdown.split("\n").find((item) => cellsOf(item)[1] === label);
  assert.ok(line, `表に「${label}」の行が無い`);
  const cells = cellsOf(line);
  return [cells[2], cells[3]];
}

function capOf(month: string, total: number) {
  return kougakuGendo({
    treatment_month: month,
    income_category: "ウ",
    amount_basis: "total",
    amount_low: total,
    amount_high: total,
    copay_percent: 30,
  }).cases[0].low;
}

const payment = (label: string, amount: number) => ({
  date: DISCHARGE_EXTENDED,
  label,
  direction: "out",
  amount_low: amount,
  amount_high: amount,
  certainty: "estimate",
});

function daysOf(until: string): number {
  const stay = calcDate({ start_date: ADMISSION, steps: [], until_date: until });
  assert.ok(stay.until);
  return stay.until.days_inclusive ?? 0;
}

// 月をまたぐ 3 つの筋書き: 費用が 12 月に寄る（80 万・0）、半々（40 万・40 万）、上限が使えない。
function extendedStay() {
  const days = daysOf(DISCHARGE_EXTENDED);
  const meals = mealCost({ days_low: days, days_high: days }).low.cost_max;
  const december = capOf("2026-12", TOTAL_COST);
  const halfDecember = capOf("2026-12", TOTAL_COST / 2);
  const halfJanuary = capOf("2027-01", TOTAL_COST / 2);
  const input: CashflowInput = {
    start_date: START,
    cash_on_hand: CASH_ON_HAND,
    scenarios: [
      {
        name: "費用が 12 月に寄る",
        events: [payment("入院費（12 月分）", december.pay_with_cap), payment("食事代", meals)],
      },
      {
        name: "費用が半々",
        events: [
          payment("入院費（12 月分）", halfDecember.pay_with_cap),
          payment("入院費（1 月分）", halfJanuary.pay_with_cap),
          payment("食事代", meals),
        ],
      },
      {
        name: "上限が使えない",
        events: [payment("入院費（3 割）", december.copay_without_cap), payment("食事代", meals)],
      },
    ],
  };
  const output = simulateCashflow(input);
  const [skewed, half, withoutCap] = output.scenarios;
  // 窓口で上限が使えると確かめたあとの、月またぎの見通し（デモの 3 回目と同じ 2 つの筋書き）。
  const capConfirm = simulateCashflow({
    ...input,
    scenarios: input.scenarios.slice(0, 2),
  }).what_to_confirm;
  return { days, meals, skewed, half, withoutCap, capConfirm };
}

const needText = (scenario: { low_case: { need: number }; high_case: { need: number } }) => {
  assert.equal(scenario.low_case.need, scenario.high_case.need);
  return [yen(scenario.low_case.need), cashGapText(CASH_ON_HAND, scenario.low_case.need, scenario.high_case.need)];
};

test("README の金額の表の 5 行は、計算関数の結果と一致する", () => {
  const readme = read("README.md");
  const { first } = exampleMoneyTurns();
  const [withCap, withoutCap] = first.cashflow.scenarios;
  const days = daysOf(DISCHARGE);
  const extended = extendedStay();
  const rows: [string, { low_case: { need: number }; high_case: { need: number } }][] = [
    [`12 月 14 日〜28 日の ${days} 日間。窓口で上限が使える`, withCap],
    [`同じ ${days} 日間。上限が使えず、いったん 3 割を払う`, withoutCap],
    [
      `1 週間延びて 1 月 4 日に退院（${extended.days} 日間）。費用が 12 月に寄る（80 万・0）、上限が使える`,
      extended.skewed,
    ],
    [`同じ ${extended.days} 日間。費用が半々（40 万・40 万）、上限が使える`, extended.half],
    [`同じ ${extended.days} 日間。上限が使えず、いったん 3 割を払う`, extended.withoutCap],
  ];
  for (const [label, scenario] of rows) {
    assert.deepEqual(tableRow(readme, label), needText(scenario), label);
  }
});

test("README の内訳と差の数字は、計算関数の結果と一致する", () => {
  const readme = read("README.md");
  const { first } = exampleMoneyTurns();
  const kougaku = first.calculations.find((item) => item.name === "kougaku_gendo");
  const meals = first.calculations.find((item) => item.name === "meal_cost");
  assert.ok(kougaku?.name === "kougaku_gendo" && meals?.name === "meal_cost");
  const { formula, low } = kougaku.output.cases[0];
  assert.ok(readme.includes(`保険診療分 ${yen(low.pay_with_cap)}`));
  assert.ok(readme.includes(`${yen(formula.base)} ＋（${yen(TOTAL_COST)} − ${yen(formula.threshold)}）× ${formula.rate_percent}%`));
  assert.ok(readme.includes(`食事代 ${yen(meals.output.low.cost_max)}`));
  assert.ok(readme.includes(`${yen(meals.output.yen_per_meal)} × ${meals.output.meals_per_day_max} 食 × ${meals.output.low.days} 日`));
  assert.ok(readme.includes(`差の ${yen(first.cashflow.comparison_with_first[0].need_low_difference)}`));
  assert.equal(first.cashflow.what_to_confirm?.width, first.cashflow.comparison_with_first[0].need_low_difference);
});

test("README の試す文の例は、架空の体験例の発言と同じ", () => {
  const readme = read("README.md");
  const [first, , , answer] = exampleWorkspace().messages;
  assert.ok(readme.includes(first.text));
  assert.ok(readme.includes(answer.text.split("。")[0] + "。"));
});

test("提出文の架空の例の金額は、計算関数の結果と一致する", () => {
  const form = read("docs/submission/form.md");
  const { first, second } = exampleMoneyTurns();
  const [withCap, withoutCap] = first.cashflow.scenarios;
  const [confirmed] = second.cashflow.scenarios;
  const extended = extendedStay();
  const expected = [
    `上限が使えれば ${yen(withCap.low_case.need)}`,
    `${yen(withoutCap.low_case.need)}で、差は ${yen(first.cashflow.comparison_with_first[0].need_low_difference)}`,
    `${cashGapText(CASH_ON_HAND, withCap.low_case.need, withCap.high_case.need).replace("残る", "残り")}`,
    `${cashGapText(CASH_ON_HAND, withoutCap.low_case.need, withoutCap.high_case.need).replace("足りない", "足りません")}`,
    `要る額は ${yen(confirmed.low_case.need)}の 1 つ`,
    `12 月に寄れば ${yen(extended.skewed.low_case.need)}`,
    `半々なら ${yen(extended.half.low_case.need)}`,
    `上限が使えなければ ${yen(extended.withoutCap.low_case.need)}`,
  ];
  for (const text of expected) assert.ok(form.includes(text), text);
  assert.equal(confirmed.high_case.rows[0].certainty, "confirmed");
});

// 体験例の条件（日付・区分・総額・手元）を、exampleMoneyTurns の計算の入力から作る（#62）。
// 文書に手で書いた値を正としない。
function exampleFacts() {
  const { first, second } = exampleMoneyTurns();
  const kougaku = first.calculations.find((item) => item.name === "kougaku_gendo");
  const stay = first.calculations.find((item) => item.name === "calc_date");
  assert.ok(kougaku?.name === "kougaku_gendo" && stay?.name === "calc_date");
  const { start_date: start, until_date: until } = stay.input;
  const { amount_low: amount, income_category: category } = kougaku.input;
  assert.ok(typeof start === "string" && typeof until === "string");
  assert.ok(typeof amount === "number" && typeof category === "string");
  assert.ok(stay.output.until);
  const cashOnHand = first.cashflow.cash_on_hand;
  assert.ok(cashOnHand !== null);
  const [y, m, d] = start.split("-").map(Number);
  const [, , d2] = until.split("-").map(Number);
  return {
    first,
    second,
    y,
    m,
    d,
    d2,
    days: stay.output.until.days_inclusive,
    category,
    amountMan: amount / 10_000,
    cashMan: cashOnHand / 10_000,
  };
}

// 文書ごとの、体験例の条件を書いた文。文全体で照らすので、どれか 1 つの値を書き違えると落ちる。
function conditionSentences(f: ReturnType<typeof exampleFacts>): [string, string][] {
  const total = `${f.amountMan} 万円`;
  const cash = `${f.cashMan} 万円`;
  return [
    ["README.md", `条件は架空で、協会けんぽ・区分${f.category}・医療費の総額 ${total}・手元 ${cash}です。`],
    [
      "docs/submission/form.md",
      `${f.m} 月 ${f.d} 日から ${f.d2} 日まで ${f.days} 日間入院し、協会けんぽで区分${f.category}、医療費の総額が ${total}、手元に ${cash}ある人の場合です。`,
    ],
    [
      "docs/family-preparation.md",
      `体験例は ${f.y} 年 ${f.m} 月 ${f.d} 日〜${f.d2} 日の ${f.days} 日間、協会けんぽ、区分${f.category}、医療費の総額 ${total}、手元 ${cash}で、`,
    ],
    [
      "docs/adr/0016-pay-day-story-display-and-example.md",
      `${f.y} 年 ${f.m} 月 ${f.d} 日〜${f.d2} 日の ${f.days} 日間、協会けんぽ、区分${f.category}、医療費の総額 ${total}、手元 ${cash}。`,
    ],
  ];
}

test("README・提出文・仕様・ADR 0016 の体験例の条件の文は、計算の入力と一致する", () => {
  for (const [path, sentence] of conditionSentences(exampleFacts())) {
    assert.ok(read(path).includes(sentence), `${path}: ${sentence}`);
  }
});

test("4 つの文書に出てくる総額・手元・区分は、すべて体験例の計算の入力と同じ", () => {
  const f = exampleFacts();
  const patterns: [RegExp, string][] = [
    [/総額(?:が)? ?(\d+) 万円/g, String(f.amountMan)],
    [/手元(?:に|の)? ?(\d+) 万円/g, String(f.cashMan)],
    [/区分([アイウエオ])/g, f.category],
  ];
  for (const [path] of conditionSentences(f)) {
    const text = read(path);
    for (const [pattern, expected] of patterns) {
      const found = [...text.matchAll(pattern)].map((match) => match[1]);
      assert.ok(found.length > 0, `${path}: ${pattern}`);
      for (const value of found) assert.equal(value, expected, `${path}: ${pattern}`);
    }
  }
});

test("仕様の体験例の金額は、計算関数の結果と一致する", () => {
  const spec = read("docs/family-preparation.md");
  const { first, second } = exampleFacts();
  const [withCap, withoutCap] = first.cashflow.scenarios;
  const [answered] = second.cashflow.scenarios;
  const expected = [
    `窓口で上限が使えれば ${yen(withCap.low_case.need)}`,
    `使えなければ ${yen(withoutCap.low_case.need)}`,
    `差は ${yen(first.cashflow.comparison_with_first[0].need_low_difference)}`,
    `要る額は ${yen(answered.low_case.need)}の 1 つ`,
  ];
  for (const text of expected) assert.ok(spec.includes(text), text);
  assert.equal(withCap.low_case.need, withCap.high_case.need);
  assert.equal(answered.low_case.need, withCap.low_case.need);
});

test("README の計算例の制度の値には、制度表と同じ出典と確認日が付いている", () => {
  const readme = read("README.md");
  for (const source of [KOUGAKU_UNDER_70.sources[0], MEAL_COPAY.sources[0]]) {
    assert.ok(readme.includes(`[${source.name}](${source.url})（確認 ${source.checked_on}）`), source.name);
  }
  const category = KOUGAKU_UNDER_70.categories.find((item) => item.key === "ウ");
  assert.ok(category?.threshold);
  assert.ok(readme.includes(`${yen(category.base)} ＋（${yen(TOTAL_COST)} − ${yen(category.threshold)}）× ${KOUGAKU_UNDER_70.rate_percent}%`));
  assert.ok(readme.includes(`${yen(MEAL_COPAY.yen_per_meal)} × ${MEAL_COPAY.meals_per_day_max} 食`));
});

test("月またぎの「まず確かめる 1 つ」は、12 月と 1 月の内訳で、幅 82,940 円が 0 円になる", () => {
  const { skewed, half, capConfirm } = extendedStay();
  assert.ok(capConfirm);
  assert.equal(capConfirm.need_low, skewed.low_case.need);
  assert.equal(capConfirm.need_high, half.low_case.need);
  assert.equal(capConfirm.width, 82_940);
  const [top] = capConfirm.factors;
  assert.equal(top.kind, "scenario");
  assert.equal(top.name, "『費用が 12 月に寄る』か『費用が半々』か");
  assert.equal(top.width_if_resolved, 0);
  assert.equal(top.shrink, 82_940);
});
