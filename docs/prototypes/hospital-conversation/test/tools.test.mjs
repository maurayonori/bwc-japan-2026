import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, executeTool } from '../src/tools.mjs';

// strict: true の道具で使えない JSON Schema の語（数値・文字列・配列の制約）。
const UNSUPPORTED_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
];

function walk(schema, path, visit) {
  visit(schema, path);
  for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, `${path}.${key}`, visit);
  if (schema.items) walk(schema.items, `${path}[]`, visit);
  for (const [index, child] of (schema.anyOf ?? []).entries()) walk(child, `${path}|${index}`, visit);
}

test('道具は 4 つで、どれも strict と日本語の説明を持つ', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['kougaku_gendo', 'meal_cost', 'calc_date', 'simulate_cashflow']);
  for (const tool of TOOLS) {
    assert.equal(tool.strict, true, tool.name);
    assert.match(tool.description, /[ぁ-ん]/, tool.name);
    assert.ok(tool.description.length >= 80, `${tool.name} の説明が短い`);
    assert.equal(tool.input_schema.type, 'object', tool.name);
  }
});

test('スキーマは strict の条件を満たす（全項目が必須・余分な項目なし・使えない制約なし）', () => {
  for (const tool of TOOLS) {
    walk(tool.input_schema, tool.name, (schema, path) => {
      for (const keyword of UNSUPPORTED_KEYWORDS) assert.equal(keyword in schema, false, `${path} に ${keyword}`);
      if (schema.type === 'object') {
        assert.equal(schema.additionalProperties, false, `${path} の additionalProperties`);
        assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} の required`);
        for (const [key, property] of Object.entries(schema.properties)) {
          assert.match(property.description ?? '', /[ぁ-ん]/, `${path}.${key} の説明`);
        }
      }
    });
  }
});

test('道具の定義は書き換えられない', () => {
  assert.throws(() => { TOOLS[0].name = 'x'; }, TypeError);
  assert.throws(() => { TOOLS[0].input_schema.properties.extra = {}; }, TypeError);
});

test('高額療養費の道具を実行できる', () => {
  const result = executeTool('kougaku_gendo', {
    treatment_month: '2026-11', income_category: 'ウ', amount_basis: 'total',
    amount_low: 1_000_000, amount_high: 1_000_000, copay_percent: 30,
  });
  assert.equal(result.ok, true);
  assert.equal(result.output.cases[0].low.cap, 92_940);
});

test('食事代・日付・資金繰りの道具を実行できる', () => {
  assert.equal(executeTool('meal_cost', { days_low: 8, days_high: 8 }).output.low.cost_max, 13_200);
  assert.equal(
    executeTool('calc_date', { start_date: '2026-11-09', steps: [], until_date: '2026-11-16' }).output.until.days_inclusive,
    8,
  );
  const cashflow = executeTool('simulate_cashflow', {
    start_date: '2026-11-06',
    cash_on_hand: null,
    scenarios: [{
      name: '試算',
      events: [{ date: '2026-11-16', label: '入院費', direction: 'out', amount_low: 92_940, amount_high: 92_940, certainty: 'estimate' }],
    }],
  });
  assert.equal(cashflow.ok, true);
  assert.equal(cashflow.output.scenarios[0].high_case.need, 92_940);
});

test('受け付けられない入力は、失敗として日本語の理由を返す（例外にしない）', () => {
  const result = executeTool('meal_cost', { days_low: 0, days_high: 8 });
  assert.equal(result.ok, false);
  assert.match(result.error, /入院日数/);
});

test('入力の項目が欠けていても、例外にせず理由を返す', () => {
  for (const name of TOOLS.map((tool) => tool.name)) {
    const result = executeTool(name, {});
    assert.equal(result.ok, false, name);
    assert.match(result.error, /[ぁ-ん]/, name);
  }
});

test('入力がオブジェクトでないときも、理由を返す', () => {
  for (const input of [null, 'text', 12, [1, 2]]) {
    assert.equal(executeTool('meal_cost', input).ok, false);
  }
});

test('無い道具の名前には、使える名前を添えて断る', () => {
  for (const name of ['unknown', 'constructor', '__proto__', 'toString', 'Kougaku_Gendo']) {
    const result = executeTool(name, {});
    assert.equal(result.ok, false, name);
    assert.match(result.error, /kougaku_gendo/, name);
  }
});
