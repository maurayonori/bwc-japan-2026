import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kougakuGendo } from '../src/kougaku.mjs';
import { InputError } from '../src/validate.mjs';

const base = {
  treatment_month: '2026-11',
  income_category: 'ウ',
  amount_basis: 'total',
  amount_low: 1_000_000,
  amount_high: 1_000_000,
  copay_percent: 30,
};

test('区分ウ・総医療費 100 万円は、docs/problem.md の B1 と同じ 92,940 円になる', () => {
  const result = kougakuGendo(base);
  assert.equal(result.cases.length, 1);
  const { low, high } = result.cases[0];
  assert.deepEqual(low, high);
  assert.equal(low.total_medical_cost, 1_000_000);
  assert.equal(low.copay_without_cap, 300_000);
  assert.equal(low.cap, 92_940);
  assert.equal(low.pay_with_cap, 92_940);
  assert.equal(low.refund_later, 207_060);
  assert.equal(low.cap_reduces_payment, true);
});

test('病院の概算（3 割負担の額）から入れても、同じ結果になる', () => {
  const result = kougakuGendo({ ...base, amount_basis: 'copay', amount_low: 300_000, amount_high: 300_000 });
  const { low } = result.cases[0];
  assert.equal(low.total_medical_cost, 1_000_000);
  assert.equal(low.copay_without_cap, 300_000);
  assert.equal(low.cap, 92_940);
  assert.equal(low.refund_later, 207_060);
});

test('3 割で割り切れない概算でも、端数を持ったまま計算してから丸める', () => {
  const result = kougakuGendo({ ...base, amount_basis: 'copay', amount_low: 220_000, amount_high: 220_000 });
  const { low } = result.cases[0];
  // 総医療費 733,333.33…円。85,800 + (733,333.33… − 286,000) × 1% = 90,273.33…
  assert.equal(low.total_medical_cost, 733_333);
  assert.equal(low.copay_without_cap, 220_000);
  assert.equal(low.cap, 90_273);
  assert.equal(low.pay_with_cap, 90_273);
  assert.equal(low.refund_later, 129_727);
});

test('5 つの区分の式を、協会けんぽの表のとおりに計算する', () => {
  const expected = { ア: 271_290, イ: 183_130, ウ: 92_940, エ: 61_500, オ: 36_900 };
  for (const [category, cap] of Object.entries(expected)) {
    const result = kougakuGendo({ ...base, income_category: category });
    assert.equal(result.cases[0].category, category);
    assert.equal(result.cases[0].low.cap, cap, `区分${category}`);
  }
});

test('総医療費が式の基準額より小さいときは、1% の加算を 0 にする', () => {
  const result = kougakuGendo({ ...base, amount_low: 200_000, amount_high: 200_000 });
  const { low } = result.cases[0];
  assert.equal(low.cap, 85_800);
  assert.equal(low.copay_without_cap, 60_000);
  assert.equal(low.pay_with_cap, 60_000);
  assert.equal(low.refund_later, 0);
  assert.equal(low.cap_reduces_payment, false);
});

test('1 円未満は、50 銭以上を切り上げ、50 銭未満を切り捨てる', () => {
  const up = kougakuGendo({ ...base, amount_low: 286_050, amount_high: 286_050 });
  assert.equal(up.cases[0].low.cap, 85_801);
  const down = kougakuGendo({ ...base, amount_low: 286_049, amount_high: 286_049 });
  assert.equal(down.cases[0].low.cap, 85_800);
});

test('見積もりに幅があるときは、下限と上限をそれぞれ計算する', () => {
  const result = kougakuGendo({ ...base, amount_low: 800_000, amount_high: 1_200_000 });
  const { low, high } = result.cases[0];
  assert.equal(low.cap, 90_940);
  assert.equal(high.cap, 94_940);
  assert.equal(low.copay_without_cap, 240_000);
  assert.equal(high.copay_without_cap, 360_000);
});

test('区分が分からないときは 5 区分を並べ、窓口で払う額の幅を返す', () => {
  const result = kougakuGendo({ ...base, income_category: '不明' });
  assert.deepEqual(result.cases.map((item) => item.category), ['ア', 'イ', 'ウ', 'エ', 'オ']);
  assert.deepEqual(result.range_if_category_unknown, { pay_with_cap_low: 36_900, pay_with_cap_high: 271_290 });
});

test('上限の式に使った値を、結果に付ける', () => {
  assert.deepEqual(kougakuGendo(base).cases[0].formula, { base: 85_800, threshold: 286_000, rate_percent: 1 });
  assert.deepEqual(kougakuGendo({ ...base, income_category: 'エ' }).cases[0].formula, { base: 61_500, threshold: null, rate_percent: 1 });
});

test('区分が分かっているときは、区分不明の幅を返さない', () => {
  assert.equal(kougakuGendo(base).range_if_category_unknown, null);
});

test('小学校入学前の 2 割負担でも計算できる', () => {
  const result = kougakuGendo({ ...base, copay_percent: 20 });
  assert.equal(result.cases[0].low.copay_without_cap, 200_000);
  assert.equal(result.cases[0].low.pay_with_cap, 92_940);
});

test('結果に、前提・含まれない費用・出典と確認日を付ける', () => {
  const result = kougakuGendo(base);
  assert.ok(result.assumptions.length >= 3);
  assert.ok(result.not_included.some((line) => line.includes('差額ベッド')));
  assert.ok(result.sources.length >= 2);
  for (const source of result.sources) {
    assert.match(source.url, /^https:\/\//);
    assert.match(source.checked_on, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('表を持っていない診療月は、計算せずに断る', () => {
  assert.throws(() => kougakuGendo({ ...base, treatment_month: '2026-07' }), InputError);
  assert.throws(() => kougakuGendo({ ...base, treatment_month: '2027-08' }), InputError);
  assert.doesNotThrow(() => kougakuGendo({ ...base, treatment_month: '2026-08' }));
  assert.doesNotThrow(() => kougakuGendo({ ...base, treatment_month: '2027-07' }));
});

test('受け付けられない入力は、日本語の理由を付けて断る', () => {
  const invalid = [
    { treatment_month: '2026-13' },
    { treatment_month: '2026/11' },
    { income_category: 'カ' },
    { amount_basis: 'unknown' },
    { copay_percent: 10 },
    { amount_low: -1 },
    { amount_low: 1.5 },
    { amount_low: 2_000_000, amount_high: 1_000_000 },
    { amount_high: 2_000_000_000 },
  ];
  for (const patch of invalid) {
    assert.throws(
      () => kougakuGendo({ ...base, ...patch }),
      (error) => error instanceof InputError && /[ぁ-ん]/.test(error.message),
      JSON.stringify(patch),
    );
  }
});

test('入力を書き換えない', () => {
  const input = Object.freeze({ ...base });
  assert.doesNotThrow(() => kougakuGendo(input));
});
