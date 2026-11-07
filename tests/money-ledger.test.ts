import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simulateCashflow as typedSimulateCashflow } from "../lib/money/ledger";
import { InputError } from "../lib/money/validate";

// 不正な入力も確かめるので、入力の型を外す。
const simulateCashflow = typedSimulateCashflow as (
  input: unknown,
) => ReturnType<typeof typedSimulateCashflow>;

// 検証仕様（docs/validation/hospital-preparation.md）の架空例。
// 入力式の試作（docs/prototypes/hospital-preparation.html）と同じ数字になることを確かめる。
interface ExampleOptions {
  windowCap: boolean;
  benefitDate: string | null;
  extraCount: number;
}

function events({ windowCap, benefitDate, extraCount }: ExampleOptions) {
  const extraDates = ['2026-12-10', '2027-01-10', '2027-02-10'].slice(0, extraCount);
  return [
    {
      date: '2026-11-16', label: '入院費（保険診療分）', direction: 'out',
      amount_low: windowCap ? 92_940 : 300_000, amount_high: windowCap ? 92_940 : 300_000, certainty: 'estimate',
    },
    {
      date: '2026-11-16', label: '保険の対象外の費用', direction: 'out',
      amount_low: 30_000, amount_high: 70_000, certainty: 'assumption',
    },
    {
      date: '2026-11-30', label: 'その他の支払い', direction: 'out',
      amount_low: 150_000, amount_high: 150_000, certainty: 'confirmed',
    },
    ...(benefitDate === null ? [] : [{
      date: benefitDate, label: '給付金', direction: 'in',
      amount_low: 200_000, amount_high: 200_000, certainty: 'assumption',
    }]),
    ...extraDates.map((date) => ({
      date, label: '退院後の支払い', direction: 'out', amount_low: 10_000, amount_high: 10_000, certainty: 'assumption',
    })),
  ];
}

function run(options: ExampleOptions, cash: number | null = 300_000) {
  const result = simulateCashflow({
    start_date: '2026-11-05',
    cash_on_hand: cash,
    scenarios: [{ name: '試算', events: events(options) }],
  });
  return result.scenarios[0];
}

test('窓口で上限が適用され、給付が 12/9 に入る場合', () => {
  const scenario = run({ windowCap: true, benefitDate: '2026-12-09', extraCount: 1 });
  assert.equal(scenario.low_case.shortfall, 0);
  assert.equal(scenario.low_case.first_shortfall_date, null);
  assert.equal(scenario.high_case.shortfall, 12_940);
  assert.equal(scenario.high_case.first_shortfall_date, '2026-11-30');
  assert.equal(scenario.high_case.need, 312_940);
  assert.equal(scenario.high_case.need_date, '2026-11-30');
  assert.equal(scenario.high_case.end_balance, 177_060);
});

test('窓口で上限が適用されない場合は、不足が大きくなる', () => {
  const scenario = run({ windowCap: false, benefitDate: '2026-12-09', extraCount: 1 });
  assert.equal(scenario.low_case.shortfall, 180_000);
  assert.equal(scenario.high_case.shortfall, 220_000);
});

test('給付が 12/23 に遅れると、先に来る支払いのぶん不足が増える', () => {
  const scenario = run({ windowCap: true, benefitDate: '2026-12-23', extraCount: 1 });
  assert.equal(scenario.high_case.shortfall, 22_940);
  assert.equal(scenario.high_case.end_balance, 177_060);
});

test('給付が入らず、退院後の支払いが 3 回ある場合', () => {
  const scenario = run({ windowCap: true, benefitDate: null, extraCount: 3 });
  assert.equal(scenario.high_case.shortfall, 42_940);
  assert.equal(scenario.high_case.need_date, '2027-02-10');
  assert.equal(scenario.totals.out_high, 342_940);
});

test('確認できていない入金は、別の欄で「数えない場合」を出す', () => {
  const scenario = run({ windowCap: true, benefitDate: '2026-12-09', extraCount: 1 });
  const withoutBenefit = run({ windowCap: true, benefitDate: null, extraCount: 1 });
  assert.equal(scenario.high_case_without_unconfirmed_income.shortfall, 22_940);
  assert.equal(scenario.high_case_without_unconfirmed_income.shortfall, withoutBenefit.high_case.shortfall);
  assert.equal(scenario.totals.unconfirmed_in_high, 200_000);
});

test('確認済みの入金は、数えない場合の欄でも入金として扱う', () => {
  const list = events({ windowCap: true, benefitDate: '2026-12-09', extraCount: 1 })
    .map((event) => (event.direction === 'in' ? { ...event, certainty: 'confirmed' } : event));
  const result = simulateCashflow({ start_date: '2026-11-05', cash_on_hand: 300_000, scenarios: [{ name: '確認済み', events: list }] });
  assert.equal(result.scenarios[0].high_case_without_unconfirmed_income.shortfall, 12_940);
  assert.equal(result.scenarios[0].totals.unconfirmed_in_high, 0);
});

test('手元資金が分からないときは、必要になる額だけを返し、不足は判定しない', () => {
  const scenario = run({ windowCap: true, benefitDate: '2026-12-09', extraCount: 1 }, null);
  assert.equal(scenario.low_case.need, 272_940);
  assert.equal(scenario.high_case.need, 312_940);
  assert.equal(scenario.high_case.shortfall, null);
  assert.equal(scenario.high_case.first_shortfall_date, null);
  assert.equal(scenario.high_case.end_balance, null);
  assert.equal(scenario.high_case.rows[0].balance, null);
});

test('同じ日の入金と支払いは、支払いを先に置く', () => {
  const result = simulateCashflow({
    start_date: '2026-11-05',
    cash_on_hand: 100,
    scenarios: [{
      name: '同じ日',
      events: [
        { date: '2026-11-16', label: '入金', direction: 'in', amount_low: 200, amount_high: 200, certainty: 'confirmed' },
        { date: '2026-11-16', label: '支払い', direction: 'out', amount_low: 150, amount_high: 150, certainty: 'confirmed' },
      ],
    }],
  });
  const path = result.scenarios[0].high_case;
  assert.deepEqual(path.rows.map((row) => row.label), ['支払い', '入金']);
  assert.equal(path.shortfall, 50);
  assert.equal(path.first_shortfall_date, '2026-11-16');
  assert.equal(path.end_balance, 150);
});

test('入金に幅があるときは、多めの場合に少ない入金、少なめの場合に多い入金を使う', () => {
  const result = simulateCashflow({
    start_date: '2026-11-05',
    cash_on_hand: null,
    scenarios: [{
      name: '入金の幅',
      events: [
        { date: '2026-11-10', label: '入金', direction: 'in', amount_low: 100_000, amount_high: 200_000, certainty: 'confirmed' },
        { date: '2026-11-16', label: '支払い', direction: 'out', amount_low: 250_000, amount_high: 300_000, certainty: 'estimate' },
      ],
    }],
  });
  assert.equal(result.scenarios[0].low_case.need, 50_000);
  assert.equal(result.scenarios[0].high_case.need, 200_000);
});

test('行には、日付順の累計と残高を付ける', () => {
  const scenario = run({ windowCap: true, benefitDate: '2026-12-09', extraCount: 1 });
  assert.deepEqual(
    scenario.high_case.rows.map((row) => [row.date, row.weekday, row.direction, row.amount, row.cumulative_net, row.balance]),
    [
      ['2026-11-16', '月', 'out', 92_940, -92_940, 207_060],
      ['2026-11-16', '月', 'out', 70_000, -162_940, 137_060],
      ['2026-11-30', '月', 'out', 150_000, -312_940, -12_940],
      ['2026-12-09', '水', 'in', 200_000, -112_940, 187_060],
      ['2026-12-10', '木', 'out', 10_000, -122_940, 177_060],
    ],
  );
});

test('2 つ目以降の筋書きには、1 つ目との必要額の差を付ける', () => {
  const result = simulateCashflow({
    start_date: '2026-11-05',
    cash_on_hand: 300_000,
    scenarios: [
      { name: '窓口で上限が適用される', events: events({ windowCap: true, benefitDate: null, extraCount: 0 }) },
      { name: '適用されず、後から払い戻し', events: events({ windowCap: false, benefitDate: null, extraCount: 0 }) },
    ],
  });
  assert.deepEqual(result.comparison_with_first, [
    { name: '適用されず、後から払い戻し', need_low_difference: 207_060, need_high_difference: 207_060 },
  ]);
});

test('支払いが無く入金だけなら、必要額は 0', () => {
  const result = simulateCashflow({
    start_date: '2026-11-05',
    cash_on_hand: 0,
    scenarios: [{
      name: '入金だけ',
      events: [{ date: '2026-11-10', label: '入金', direction: 'in', amount_low: 1_000, amount_high: 1_000, certainty: 'confirmed' }],
    }],
  });
  assert.equal(result.scenarios[0].high_case.need, 0);
  assert.equal(result.scenarios[0].high_case.need_date, null);
  assert.equal(result.scenarios[0].high_case.shortfall, 0);
});

test('受け付けられない入力は、日本語の理由を付けて断る', () => {
  const event = { date: '2026-11-16', label: '支払い', direction: 'out', amount_low: 100, amount_high: 100, certainty: 'confirmed' };
  const valid = { start_date: '2026-11-05', cash_on_hand: null, scenarios: [{ name: '試算', events: [event] }] };
  const invalid = [
    { start_date: '2026-11-31' },
    { cash_on_hand: -1 },
    { cash_on_hand: 1.5 },
    { scenarios: [] },
    { scenarios: Array.from({ length: 5 }, (_, index) => ({ name: `筋書き${index}`, events: [event] })) },
    { scenarios: [{ name: '同じ', events: [event] }, { name: '同じ', events: [event] }] },
    { scenarios: [{ name: '', events: [event] }] },
    { scenarios: [{ name: '試算', events: [] }] },
    { scenarios: [{ name: '試算', events: Array.from({ length: 31 }, () => event) }] },
    { scenarios: [{ name: '試算', events: [{ ...event, date: '2026-11-04' }] }] },
    { scenarios: [{ name: '試算', events: [{ ...event, date: '2026-02-30' }] }] },
    { scenarios: [{ name: '試算', events: [{ ...event, direction: 'both' }] }] },
    { scenarios: [{ name: '試算', events: [{ ...event, certainty: 'maybe' }] }] },
    { scenarios: [{ name: '試算', events: [{ ...event, amount_low: 200 }] }] },
    { scenarios: [{ name: '試算', events: [{ ...event, label: '' }] }] },
    { scenarios: [{ name: '試算', events: [null] }] },
  ];
  for (const patch of invalid) {
    assert.throws(
      () => simulateCashflow({ ...valid, ...patch }),
      (error) => error instanceof InputError && /[ぁ-ん]/.test(error.message),
      JSON.stringify(patch).slice(0, 120),
    );
  }
});

test('凍結した入力でも計算でき、入力の並びを書き換えない', () => {
  const list = events({ windowCap: true, benefitDate: '2026-12-09', extraCount: 3 }).reverse();
  const before = JSON.stringify(list);
  const input = { start_date: '2026-11-05', cash_on_hand: 300_000, scenarios: [{ name: '試算', events: list }] };
  const frozen = JSON.parse(JSON.stringify(input), (key, value) => (value && typeof value === 'object' ? Object.freeze(value) : value));
  assert.doesNotThrow(() => simulateCashflow(frozen));
  simulateCashflow(input);
  assert.equal(JSON.stringify(list), before);
});

// 試作は公開の配置物に入らないので、無いときは飛ばす。
const PROTOTYPE_LEDGER = new URL('../docs/prototypes/hospital-conversation/src/ledger.mjs', import.meta.url);
const noPrototype = !existsSync(fileURLToPath(PROTOTYPE_LEDGER));

test('戻り値は、既存の項目のあとに what_to_confirm を足しただけ', () => {
  const result = simulateCashflow({
    start_date: '2026-11-05',
    cash_on_hand: 300_000,
    scenarios: [{ name: '試算', events: events({ windowCap: true, benefitDate: '2026-12-09', extraCount: 1 }) }],
  });
  assert.deepEqual(Object.keys(result), [
    'start_date', 'cash_on_hand', 'scenarios', 'comparison_with_first', 'reading_guide', 'what_to_confirm',
  ]);
  assert.match(result.reading_guide[0], /^low_case は/);
});

test('順位を同梱しても、既存の項目は同梱前（試作）と同じ値のまま', { skip: noPrototype }, async () => {
  const prototype = await import(PROTOTYPE_LEDGER.href);
  const inputs = [
    { start_date: '2026-11-05', cash_on_hand: 300_000, scenarios: [{ name: '試算', events: events({ windowCap: true, benefitDate: '2026-12-09', extraCount: 1 }) }] },
    { start_date: '2026-11-05', cash_on_hand: null, scenarios: [{ name: '試算', events: events({ windowCap: false, benefitDate: null, extraCount: 3 }) }] },
    {
      start_date: '2026-11-05',
      cash_on_hand: 300_000,
      scenarios: [
        { name: '窓口で上限が適用される', events: events({ windowCap: true, benefitDate: '2026-12-23', extraCount: 2 }) },
        { name: '適用されず、後から払い戻し', events: events({ windowCap: false, benefitDate: '2026-12-23', extraCount: 2 }) },
      ],
    },
  ];
  for (const input of inputs) {
    const { what_to_confirm: ranking, ...existing } = simulateCashflow(input);
    assert.ok(ranking);
    assert.deepEqual(existing, prototype.simulateCashflow(input));
  }
});
