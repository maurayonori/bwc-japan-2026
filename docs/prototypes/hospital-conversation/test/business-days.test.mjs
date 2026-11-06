import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcDate, isBusinessDay, nthBusinessDayAfter } from '../src/business-days.mjs';
import { InputError } from '../src/validate.mjs';

test('土日・祝日・12/31〜1/3 は営業日に数えない', () => {
  assert.equal(isBusinessDay('2026-11-06'), true);
  assert.equal(isBusinessDay('2026-11-07'), false);
  assert.equal(isBusinessDay('2026-11-08'), false);
  assert.equal(isBusinessDay('2026-11-23'), false);
  assert.equal(isBusinessDay('2026-12-30'), true);
  assert.equal(isBusinessDay('2026-12-31'), false);
  assert.equal(isBusinessDay('2027-01-01'), false);
  assert.equal(isBusinessDay('2027-01-02'), false);
  assert.equal(isBusinessDay('2027-01-03'), false);
  assert.equal(isBusinessDay('2027-01-04'), true);
});

test('翌日から数えて n 営業日目を返す（docs/problem.md の B2 と同じ日付になる）', () => {
  assert.equal(nthBusinessDayAfter('2026-12-01', 5), '2026-12-08');
  assert.equal(nthBusinessDayAfter('2026-12-08', 1), '2026-12-09');
  assert.equal(nthBusinessDayAfter('2026-12-15', 5), '2026-12-22');
  assert.equal(nthBusinessDayAfter('2026-12-22', 1), '2026-12-23');
});

test('祝日と年末年始をまたぐと、そのぶん後ろへずれる', () => {
  assert.equal(nthBusinessDayAfter('2026-11-20', 1), '2026-11-24');
  assert.equal(nthBusinessDayAfter('2026-12-25', 5), '2027-01-05');
});

test('0 営業日は、その日が営業日ならその日、休みなら次の営業日', () => {
  assert.equal(nthBusinessDayAfter('2026-11-20', 0), '2026-11-20');
  assert.equal(nthBusinessDayAfter('2026-11-21', 0), '2026-11-24');
});

test('祝日を持っていない年にかかる営業日の計算は断る', () => {
  assert.throws(() => nthBusinessDayAfter('2027-12-30', 5), InputError);
  assert.throws(() => nthBusinessDayAfter('2025-12-30', 1), InputError);
});

test('段取りを順につないで日付を出す（退院日に診断書を依頼できた場合）', () => {
  const result = calcDate({
    start_date: '2026-11-16',
    steps: [
      { label: '診断書の完成', unit: 'week', count: 2 },
      { label: '保険会社に到着', unit: 'day', count: 1 },
      { label: '送金', unit: 'business_day', count: 5 },
      { label: '着金', unit: 'business_day', count: 1 },
    ],
    until_date: null,
  });
  assert.deepEqual(result.start, { date: '2026-11-16', weekday: '月' });
  assert.deepEqual(result.steps.map((step) => step.date), ['2026-11-30', '2026-12-01', '2026-12-08', '2026-12-09']);
  assert.deepEqual(result.steps.map((step) => step.weekday), ['月', '火', '火', '水']);
  assert.deepEqual(result.steps[2].skipped_non_business_days, [
    { date: '2026-12-05', reason: '土曜日' },
    { date: '2026-12-06', reason: '日曜日' },
  ]);
  assert.deepEqual(result.steps[0].skipped_non_business_days, []);
  assert.equal(result.until, null);
  assert.match(result.business_day_rule, /土日/);
  assert.ok(result.sources.length >= 2);
});

test('依頼が 2 週間遅れた場合は、着金も 2 週間遅れる', () => {
  const result = calcDate({
    start_date: '2026-11-30',
    steps: [
      { label: '診断書の完成', unit: 'week', count: 2 },
      { label: '保険会社に到着', unit: 'day', count: 1 },
      { label: '送金', unit: 'business_day', count: 5 },
      { label: '着金', unit: 'business_day', count: 1 },
    ],
    until_date: null,
  });
  assert.deepEqual(result.steps.map((step) => step.date), ['2026-12-14', '2026-12-15', '2026-12-22', '2026-12-23']);
});

test('休みの理由に、祝日の名前と年末年始を出す', () => {
  const result = calcDate({
    start_date: '2026-12-25',
    steps: [{ label: '送金', unit: 'business_day', count: 5 }],
    until_date: null,
  });
  assert.equal(result.steps[0].date, '2027-01-05');
  assert.deepEqual(result.steps[0].skipped_non_business_days, [
    { date: '2026-12-26', reason: '土曜日' },
    { date: '2026-12-27', reason: '日曜日' },
    { date: '2026-12-31', reason: '年末年始（12/31〜1/3）' },
    { date: '2027-01-01', reason: '祝日（元日）' },
    { date: '2027-01-02', reason: '年末年始（12/31〜1/3）' },
    { date: '2027-01-03', reason: '年末年始（12/31〜1/3）' },
  ]);
});

test('前へさかのぼる・月を足す', () => {
  const result = calcDate({
    start_date: '2026-11-30',
    steps: [
      { label: '3 か月後', unit: 'month', count: 3 },
      { label: 'その 1 週間前', unit: 'week', count: -1 },
    ],
    until_date: null,
  });
  assert.deepEqual(result.steps.map((step) => step.date), ['2027-02-28', '2027-02-21']);
  assert.equal(result.business_day_rule, null);
  assert.deepEqual(result.sources, []);
});

test('2 つの日付のあいだの日数を返す（入院日と退院日なら、日数と泊数が分かる）', () => {
  const result = calcDate({ start_date: '2026-11-09', steps: [], until_date: '2026-11-16' });
  assert.deepEqual(result.until, { date: '2026-11-16', weekday: '月', days_after_start: 7, days_inclusive: 8 });
});

test('比べる日が始まりより前なら、両端を含む日数は出さない', () => {
  const result = calcDate({ start_date: '2026-11-16', steps: [], until_date: '2026-11-09' });
  assert.equal(result.until.days_after_start, -7);
  assert.equal(result.until.days_inclusive, null);
});

test('受け付けられない入力は断る', () => {
  const valid = { start_date: '2026-11-16', steps: [{ label: '完成', unit: 'day', count: 1 }], until_date: null };
  const invalid = [
    { start_date: '2026-02-30' },
    { until_date: '2026-13-01' },
    { steps: [{ label: '完成', unit: 'year', count: 1 }] },
    { steps: [{ label: '', unit: 'day', count: 1 }] },
    { steps: [{ label: '完成', unit: 'day', count: 1.5 }] },
    { steps: [{ label: '完成', unit: 'day', count: 5000 }] },
    { steps: [{ label: '送金', unit: 'business_day', count: -1 }] },
    { steps: Array.from({ length: 13 }, () => ({ label: '完成', unit: 'day', count: 1 })) },
    { steps: 'なし' },
  ];
  for (const patch of invalid) {
    assert.throws(() => calcDate({ ...valid, ...patch }), InputError, JSON.stringify(patch));
  }
});
