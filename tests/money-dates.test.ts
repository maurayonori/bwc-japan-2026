import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, daysBetween, isDateString, todayInJapan, weekdayOf } from "../lib/money/dates";
import { divideRoundHalfUp } from "../lib/money/validate";

test('実在する日付だけを受け付ける', () => {
  assert.equal(isDateString('2026-11-06'), true);
  assert.equal(isDateString('2028-02-29'), true);
  assert.equal(isDateString('2027-02-29'), false);
  assert.equal(isDateString('2026-11-31'), false);
  assert.equal(isDateString('2026-1-6'), false);
  assert.equal(isDateString('2026/11/06'), false);
  assert.equal(isDateString(20261106), false);
  assert.equal(isDateString(null), false);
});

test('日数を足す・引く。月と年をまたいでも合う', () => {
  assert.equal(addDays('2026-11-16', 14), '2026-11-30');
  assert.equal(addDays('2026-12-25', 10), '2027-01-04');
  assert.equal(addDays('2026-11-16', -7), '2026-11-09');
  assert.equal(daysBetween('2026-11-09', '2026-11-16'), 7);
  assert.equal(daysBetween('2026-11-16', '2026-11-09'), -7);
});

test('曜日を返す', () => {
  assert.equal(weekdayOf('2026-11-06'), '金');
  assert.equal(weekdayOf('2026-11-16'), '月');
  assert.equal(weekdayOf('2027-01-01'), '金');
});

test('月を足すときは、行き先の月に無い日を月末に寄せる', () => {
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addMonths('2026-11-16', 3), '2027-02-16');
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2027-03-31', -1), '2027-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
});

test('今日の日付は、日本時間で数える', () => {
  assert.equal(todayInJapan(new Date('2026-11-05T15:00:00Z')), '2026-11-06');
  assert.equal(todayInJapan(new Date('2026-11-05T14:59:59Z')), '2026-11-05');
});

test('整数の割り算は、ちょうど半分を切り上げる', () => {
  assert.equal(divideRoundHalfUp(5, 10), 1);
  assert.equal(divideRoundHalfUp(49, 100), 0);
  assert.equal(divideRoundHalfUp(50, 100), 1);
  assert.equal(divideRoundHalfUp(0, 3), 0);
  assert.equal(divideRoundHalfUp(13_420_000, 3_000), 4_473);
});
