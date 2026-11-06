import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACTS } from '../src/facts.mjs';
import { buildSystem } from '../src/prompt.mjs';
import { TOOLS } from '../src/tools.mjs';

test('システムプロンプトは、変わらない部分と今日の日付の 2 ブロックに分かれる', () => {
  const system = buildSystem('2026-11-06');
  assert.equal(system.length, 2);
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
  assert.equal('cache_control' in system[1], false);
  assert.match(system[1].text, /2026-11-06（金曜日）/);
});

test('変わらない部分は、日付が違っても同じ文字列になる（キャッシュと思考ブロックのため）', () => {
  assert.equal(buildSystem('2026-11-06')[0].text, buildSystem('2027-01-15')[0].text);
  assert.doesNotMatch(buildSystem('2026-11-06')[0].text, /2026-11-06/);
});

test('セッションのあいだ書き換えられない', () => {
  const system = buildSystem('2026-11-06');
  assert.throws(() => { system[0].text = 'x'; }, TypeError);
  assert.throws(() => { system.push({}); }, TypeError);
});

test('ADR 0007 の約束が入っている', () => {
  const text = buildSystem('2026-11-06')[0].text;
  for (const phrase of [
    '項目を埋めてもらう道具ではありません',
    '最初の返答から見通しを出す',
    '1 回の返答で 1 つまで',
    '必ず道具を呼ぶ',
    '確かめていない入金',
    '医学的な見通しや確率を言わない',
    '言い切らない',
    '代わりに行ったとは言わない',
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test('すべての道具の名前と、すべての事実の番号が入っている', () => {
  const text = buildSystem('2026-11-06')[0].text;
  for (const tool of TOOLS) assert.ok(text.includes(tool.name), tool.name);
  for (const fact of FACTS) assert.ok(text.includes(`[${fact.id}]`), fact.id);
});

test('事実は、番号が重ならず、出典の URL と確認日を持つ', () => {
  assert.equal(new Set(FACTS.map((fact) => fact.id)).size, FACTS.length);
  for (const fact of FACTS) {
    assert.match(fact.id, /^F\d{2}$/);
    assert.ok(fact.sources.length >= 1, fact.id);
    for (const item of fact.sources) assert.match(item.url, /^https:\/\//, fact.id);
    assert.match(fact.checked_on, /^2026-11-0[56]$/, fact.id);
    assert.ok(['primary', 'transcribed'].includes(fact.verified), fact.id);
  }
});
