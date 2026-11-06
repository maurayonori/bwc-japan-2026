import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mealCost as typedMealCost } from "../lib/money/meals";
import { InputError } from "../lib/money/validate";

// 不正な入力も確かめるので、入力の型を外す。
const mealCost = typedMealCost as (
  input: unknown,
) => ReturnType<typeof typedMealCost>;

test('8 日間の入院なら、多くても 24 食・13,200 円', () => {
  const result = mealCost({ days_low: 8, days_high: 8 });
  assert.deepEqual(result.low, { days: 8, meals_max: 24, cost_max: 13_200 });
  assert.deepEqual(result.high, result.low);
  assert.equal(result.yen_per_meal, 550);
  assert.equal(result.meals_per_day_max, 3);
});

test('入院日数に幅があるときは、下限と上限をそれぞれ出す', () => {
  const result = mealCost({ days_low: 8, days_high: 15 });
  assert.equal(result.low.cost_max, 13_200);
  assert.deepEqual(result.high, { days: 15, meals_max: 45, cost_max: 24_750 });
});

test('多めの見積もりであること、対象の区分、出典と確認日を付ける', () => {
  const result = mealCost({ days_low: 8, days_high: 8 });
  assert.ok(result.notes.some((line) => line.includes('3 食')));
  assert.ok(result.notes.some((line) => line.includes('住民税非課税')));
  assert.match(result.sources[0].url, /^https:\/\//);
  assert.match(result.sources[0].checked_on, /^\d{4}-\d{2}-\d{2}$/);
});

test('受け付けられない日数は断る', () => {
  assert.throws(() => mealCost({ days_low: 0, days_high: 8 }), InputError);
  assert.throws(() => mealCost({ days_low: 8, days_high: 400 }), InputError);
  assert.throws(() => mealCost({ days_low: 9, days_high: 8 }), InputError);
  assert.throws(() => mealCost({ days_low: 8.5, days_high: 9 }), InputError);
});
