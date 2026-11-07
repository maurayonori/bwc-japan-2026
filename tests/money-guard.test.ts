import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReply } from "../lib/money/guard";
import { executeTool } from "../lib/money/tools";
import { exampleWorkspace } from "../lib/example";

const today = '2026-11-06';

function eventOf(name: string, input: unknown) {
  return { id: 'toolu_1', name, input, ...executeTool(name, input) };
}

const kougaku = eventOf('kougaku_gendo', {
  treatment_month: '2026-11', income_category: 'ウ', amount_basis: 'copay',
  amount_low: 300_000, amount_high: 300_000, copay_percent: 30,
});

const cashflow = eventOf('simulate_cashflow', {
  start_date: today,
  cash_on_hand: null,
  scenarios: [{
    name: '窓口で上限が適用される場合',
    events: [
      { date: '2026-11-16', label: '入院費', direction: 'out', amount_low: 92_940, amount_high: 92_940, certainty: 'estimate' },
      { date: '2026-11-16', label: '保険の対象外の費用', direction: 'out', amount_low: 30_000, amount_high: 70_000, certainty: 'assumption' },
      { date: '2026-11-30', label: '家賃', direction: 'out', amount_low: 150_000, amount_high: 150_000, certainty: 'confirmed' },
    ],
  }],
});

const dates = eventOf('calc_date', {
  start_date: '2026-12-25', steps: [{ label: '送金', unit: 'business_day', count: 5 }], until_date: null,
});

const check = (reply: string | null, overrides = {}) => checkReply({
  reply, toolEvents: [kougaku, cashflow, dates], userTexts: ['手元には 30 万円くらいあります。入院は 11/9 からです。'], today, ...overrides,
});

test('道具の結果にある金額と日付だけなら、何も指摘しない', () => {
  const reply = '窓口で払う保険診療分は 92,940 円です。11/30（月）までに、少なくとも 272,940 円、多ければ 312,940 円が要ります。';
  assert.deepEqual(check(reply), []);
});

test('どこにも無い金額を指摘する', () => {
  const warnings = check('合計で 123,456 円ほどになります。');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'amount');
  assert.match(warnings[0].message, /123,456 円/);
});

test('「万円」の書き方でも、同じ額として照らす', () => {
  assert.deepEqual(check('見積もりの 30 万円のうち、戻るのは 207,060 円です。'), []);
  assert.equal(check('ざっと 31 万円です。').length, 1);
});

test('「A〜B 円」の幅は、両端を照らす', () => {
  assert.deepEqual(check('要る額は 272,940〜312,940 円です。'), []);
  assert.deepEqual(check('対象外の費用は 3〜7 万円と仮に置きました。'), []);
  const warnings = check('要る額は 250,000〜312,940 円です。');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /250,000/);
});

test('利用者が言った金額と、道具に渡した仮の金額は、書いてよい', () => {
  assert.deepEqual(check('手元の 300,000 円と比べます。家賃の 150,000 円は確かめた額として置きました。'), []);
});

test('「持っている事実」にある金額は、書いてよい', () => {
  assert.deepEqual(check('食事代は 1 食 550 円です。診断書は 5,830 円の例があります。平均は 18.7 万円です。', { toolEvents: [] }), []);
});

test('累計や差額のように、結果では負の値になっている額は、符号なしで書いてよい', () => {
  // 11/16 までの支払いの累計は、道具の結果では −122,940（cumulative_net）としてだけ出ている。
  assert.deepEqual(check('11/16（月）までの支払いは、少なめの場合で 122,940 円です。'), []);
  assert.deepEqual(check('累計は −122,940 円です。'), []);
});

test('道具の結果の説明文にある金額（区分の条件など）は、書いてよい', () => {
  // 実際の会話で出た書き方。「28 万〜50 万円」は、道具の結果の condition（文字列）にだけある。
  assert.deepEqual(check('標準報酬月額が 30 万円なら、所得の区分は「ウ」（28 万〜50 万円）です。'), []);
});

test('全角の数字と区切りも読む', () => {
  assert.deepEqual(check('窓口では ９２，９４０円 です。'), []);
  assert.equal(check('窓口では ９９，９９９円 です。').length, 1);
});

test('道具の結果にある日付は、書き方が違っても通す', () => {
  assert.deepEqual(check('11/16（月）に払い、11 月 30 日に家賃、送金は 2027-01-05 です。'), []);
});

test('どこにも無い日付を指摘する', () => {
  const warnings = check('給付金は 12/20 に入ります。');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'date');
  assert.match(warnings[0].message, /12\/20/);
});

test('今日の日付、利用者が言った日付、道具の説明文にある日付は通す', () => {
  assert.deepEqual(check('今日（11/6）から数えます。入院は 11/9 ですね。営業日は 12/31〜1/3 を除いて数えました。'), []);
});

test('同じ指摘は 1 回にまとめる', () => {
  assert.equal(check('123,456 円です。もう一度言うと 123,456 円です。').length, 1);
});

test('返答が無いときは、何も指摘しない', () => {
  assert.deepEqual(check(null), []);
  assert.deepEqual(check(''), []);
});

test('割合や回数など、円でも日付でもない数字は見ない', () => {
  assert.deepEqual(check('3 割負担で、5 営業日、2 回の通院、67.6% の人が使っています。'), []);
});

test('「まず確かめる 1 つ」の前後の幅は、資金繰りの計算結果だけで通る', () => {
  const card = exampleWorkspace().cards.find((item) => item.kind === 'money');
  const input = card?.money?.calculations.find((item) => item.name === 'simulate_cashflow')?.input;
  assert.ok(input);
  const args = { toolEvents: [eventOf('simulate_cashflow', input)], userTexts: [], today };
  assert.deepEqual(checkReply({ reply: '要る額の幅は 209,060 円から 60,000 円に縮みます。', ...args }), []);
  const warnings = checkReply({ reply: '要る額の幅は 209,060 円から 59,000 円に縮みます。', ...args });
  assert.deepEqual(warnings.map((warning) => warning.shown), ['59,000 円']);
});
