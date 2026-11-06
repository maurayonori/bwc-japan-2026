import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.mjs';
import { TOOLS } from '../src/tools.mjs';

function run(args) {
  const out = [];
  const err = [];
  const code = runCli(args, { out: (line) => out.push(line), err: (line) => err.push(line), today: () => '2026-11-06' });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const kougakuInput = {
  treatment_month: '2026-11', income_category: 'ウ', amount_basis: 'copay', amount_low: 300_000, amount_high: 300_000, copay_percent: 30,
};

test('道具を 1 回実行して、結果を JSON で出す', () => {
  const { code, out, err } = run(['tool', 'kougaku_gendo', JSON.stringify(kougakuInput)]);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(JSON.parse(out).cases[0].low.cap, 92_940);
});

test('道具が受け付けない入力は、理由を出して失敗で終わる', () => {
  const { code, out, err } = run(['tool', 'kougaku_gendo', JSON.stringify({ ...kougakuInput, treatment_month: '2026-07' })]);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /[ぁ-ん]/);
});

test('JSON として読めない入力と、入力の無い呼び出しは、失敗で終わる', () => {
  const broken = run(['tool', 'kougaku_gendo', '{"treatment_month":']);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /JSON/);
  const missing = run(['tool', 'kougaku_gendo']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /使い方/);
});

test('道具の名前を省くと、使える道具を並べる', () => {
  const { code, out } = run(['tool']);
  assert.equal(code, 0);
  for (const tool of TOOLS) assert.ok(out.includes(tool.name), tool.name);
});

test('prompt は、Claude に渡す指示を、今日の日付を入れて出す', () => {
  const { code, out } = run(['prompt']);
  assert.equal(code, 0);
  assert.match(out, /金額と日付は、必ず道具で計算する/);
  assert.match(out, /今日は 2026-11-06（金曜日）です/);
});

test('知らない命令と、命令の無い呼び出しには、使い方を出す', () => {
  for (const args of [[], ['unknown']]) {
    const { code, err } = run(args);
    assert.equal(code, 1);
    assert.match(err, /使い方/);
  }
});
