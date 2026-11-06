import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/conversation.mjs';
import { executeTool } from '../src/tools.mjs';

const request = Object.freeze({ model: 'claude-opus-5-5', max_tokens: 16000, system: Object.freeze([]), tools: Object.freeze([]) });
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

const text = (value) => ({ type: 'text', text: value });
const thinking = (signature) => ({ type: 'thinking', thinking: '', signature });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const response = (stopReason, content, extra = {}) => ({ stop_reason: stopReason, content, usage, model: 'claude-opus-5-5', ...extra });

// 用意した応答を順に返す、Claude API の代役。呼ばれたときの引数を、その時点の写しで残す。
function scripted(responses) {
  const calls = [];
  const queue = [...responses];
  const createMessage = async (params) => {
    calls.push(structuredClone(params));
    if (queue.length === 0) throw new Error('用意した応答が尽きた');
    return queue.shift();
  };
  return { createMessage, calls };
}

const kougakuInput = {
  treatment_month: '2026-11', income_category: 'ウ', amount_basis: 'total',
  amount_low: 1_000_000, amount_high: 1_000_000, copay_percent: 30,
};

function turn(responses, overrides = {}) {
  const api = scripted(responses);
  const promise = runTurn({
    createMessage: api.createMessage, request, history: [], userText: '来月入院します', executeTool, ...overrides,
  });
  return { api, promise };
}

test('道具を使わない返答は、1 回の呼び出しで終わる', async () => {
  const { api, promise } = turn([response('end_turn', [text('状況を教えてください。')])]);
  const result = await promise;
  assert.equal(result.reply, '状況を教えてください。');
  assert.equal(result.outcome, 'answered');
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].messages, [{ role: 'user', content: '来月入院します' }]);
  assert.equal(api.calls[0].model, 'claude-opus-5-5');
  assert.deepEqual(result.history, [
    { role: 'user', content: '来月入院します' },
    { role: 'assistant', content: [text('状況を教えてください。')] },
  ]);
  assert.deepEqual(result.toolEvents, []);
});

test('道具の呼び出しを実行し、結果を 1 つの user メッセージで返してから続ける', async () => {
  const first = [thinking('sig-1'), toolUse('toolu_1', 'kougaku_gendo', kougakuInput)];
  const { api, promise } = turn([
    response('tool_use', first),
    response('end_turn', [text('窓口で払う額は 92,940 円です。')]),
  ]);
  const result = await promise;

  assert.equal(api.calls.length, 2);
  const second = api.calls[1].messages;
  assert.equal(second.length, 3);
  assert.deepEqual(second[1], { role: 'assistant', content: first });
  assert.equal(second[2].role, 'user');
  assert.equal(second[2].content.length, 1);
  assert.equal(second[2].content[0].type, 'tool_result');
  assert.equal(second[2].content[0].tool_use_id, 'toolu_1');
  assert.equal('is_error' in second[2].content[0], false);
  assert.equal(JSON.parse(second[2].content[0].content).cases[0].low.cap, 92_940);

  assert.equal(result.reply, '窓口で払う額は 92,940 円です。');
  assert.equal(result.history.length, 4);
  assert.equal(result.toolEvents.length, 1);
  assert.equal(result.toolEvents[0].name, 'kougaku_gendo');
  assert.equal(result.toolEvents[0].ok, true);
  assert.deepEqual(result.toolEvents[0].input, kougakuInput);
  assert.equal(result.toolEvents[0].output.cases[0].low.cap, 92_940);
});

test('思考ブロックを含む応答を、1 文字も変えずに履歴へ足す', async () => {
  const first = [thinking('sig-keep'), text('計算します。'), toolUse('toolu_1', 'meal_cost', { days_low: 8, days_high: 8 })];
  const { api, promise } = turn([response('tool_use', first), response('end_turn', [thinking('sig-2'), text('13,200 円です。')])]);
  const result = await promise;
  assert.deepEqual(api.calls[1].messages[1].content, first);
  assert.deepEqual(result.history[3].content, [thinking('sig-2'), text('13,200 円です。')]);
  assert.equal(result.reply, '13,200 円です。');
});

test('同時に呼ばれた複数の道具の結果は、同じ user メッセージに順番どおり入れる', async () => {
  const { api, promise } = turn([
    response('tool_use', [
      toolUse('toolu_a', 'meal_cost', { days_low: 8, days_high: 8 }),
      toolUse('toolu_b', 'calc_date', { start_date: '2026-11-09', steps: [], until_date: '2026-11-16' }),
    ]),
    response('end_turn', [text('まとめました。')]),
  ]);
  const result = await promise;
  const results = api.calls[1].messages[2].content;
  assert.deepEqual(results.map((block) => block.tool_use_id), ['toolu_a', 'toolu_b']);
  assert.equal(api.calls[1].messages.length, 3);
  assert.deepEqual(result.toolEvents.map((event) => event.name), ['meal_cost', 'calc_date']);
});

test('道具が入力を受け付けなかったら、is_error を付けて理由を返し、会話を続ける', async () => {
  const { api, promise } = turn([
    response('tool_use', [toolUse('toolu_1', 'meal_cost', { days_low: 0, days_high: 8 })]),
    response('end_turn', [text('日数を確かめさせてください。')]),
  ]);
  const result = await promise;
  const block = api.calls[1].messages[2].content[0];
  assert.equal(block.is_error, true);
  assert.match(block.content, /入院日数/);
  assert.equal(result.toolEvents[0].ok, false);
  assert.equal(result.outcome, 'answered');
});

test('道具の中で想定外の例外が出ても、会話は止めず、知らせとして残す', async () => {
  const crashing = () => { throw new TypeError('不具合'); };
  const { api, promise } = turn([
    response('tool_use', [toolUse('toolu_1', 'meal_cost', { days_low: 8, days_high: 8 })]),
    response('end_turn', [text('計算できませんでした。')]),
  ], { executeTool: crashing });
  const result = await promise;
  const block = api.calls[1].messages[2].content[0];
  assert.equal(block.is_error, true);
  assert.doesNotMatch(block.content, /不具合/);
  assert.equal(result.toolEvents[0].ok, false);
  assert.ok(result.notices.some((notice) => notice.kind === 'tool_crash'));
  assert.ok(result.errors.some((error) => error instanceof TypeError));
});

test('返答を断られたら、この往復を無かったことにして、履歴を元のまま返す', async () => {
  const history = Object.freeze([
    Object.freeze({ role: 'user', content: '前の質問' }),
    Object.freeze({ role: 'assistant', content: Object.freeze([text('前の答え')]) }),
  ]);
  const { promise } = turn([response('refusal', [], { stop_details: { type: 'refusal', category: null } })], { history });
  const result = await promise;
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reply, null);
  assert.deepEqual(result.history, history);
  assert.ok(result.notices.some((notice) => notice.kind === 'refused'));
});

test('返答が上限で切れたら、文章だけなら残して知らせる', async () => {
  const { promise } = turn([response('max_tokens', [text('途中まで')])]);
  const result = await promise;
  assert.equal(result.outcome, 'truncated');
  assert.equal(result.reply, '途中まで');
  assert.equal(result.history.length, 2);
  assert.ok(result.notices.some((notice) => notice.kind === 'truncated'));
});

test('道具の呼び出しの途中で切れたら、実行せずに、この往復を無かったことにする', async () => {
  let executed = 0;
  const { promise } = turn(
    [response('max_tokens', [toolUse('toolu_1', 'meal_cost', { days_low: 8 })])],
    { executeTool: () => { executed += 1; return { ok: true, output: {} }; } },
  );
  const result = await promise;
  assert.equal(executed, 0);
  assert.equal(result.outcome, 'truncated');
  assert.equal(result.reply, null);
  assert.deepEqual(result.history, []);
});

test('文章の無い返答で終わったら、この往復を無かったことにする', async () => {
  const { promise } = turn([response('end_turn', [thinking('sig-only')])]);
  const result = await promise;
  assert.equal(result.outcome, 'empty');
  assert.equal(result.reply, null);
  assert.deepEqual(result.history, []);
});

test('道具の往復が上限に達したら、そこで止めて知らせる', async () => {
  const loop = Array.from({ length: 3 }, (_, index) => response('tool_use', [
    toolUse(`toolu_${index}`, 'meal_cost', { days_low: 8, days_high: 8 }),
  ]));
  const { api, promise } = turn(loop, { maxIterations: 3 });
  const result = await promise;
  assert.equal(api.calls.length, 3);
  assert.equal(result.outcome, 'iteration_limit');
  assert.equal(result.reply, null);
  assert.equal(result.history.at(-1).role, 'user');
  assert.equal(result.history.at(-1).content[0].type, 'tool_result');
  assert.equal(result.toolEvents.length, 3);
});

test('サーバー側の一時停止（pause_turn）は、応答を足してそのまま続ける', async () => {
  const { api, promise } = turn([
    response('pause_turn', [text('続きます')]),
    response('end_turn', [text('終わりました')]),
  ]);
  const result = await promise;
  assert.equal(api.calls[1].messages.length, 2);
  assert.equal(api.calls[1].messages[1].role, 'assistant');
  assert.equal(result.reply, '終わりました');
});

test('渡された履歴とリクエストを書き換えず、履歴は後ろに足すだけにする', async () => {
  const history = Object.freeze([
    Object.freeze({ role: 'user', content: '前の質問' }),
    Object.freeze({ role: 'assistant', content: Object.freeze([thinking('sig-0'), text('前の答え')]) }),
  ]);
  const { api, promise } = turn([
    response('tool_use', [toolUse('toolu_1', 'meal_cost', { days_low: 8, days_high: 8 })]),
    response('end_turn', [text('答え')]),
  ], { history });
  const result = await promise;
  assert.equal(result.history.length, 6);
  assert.equal(result.history[0], history[0]);
  assert.equal(result.history[1], history[1]);
  assert.deepEqual(api.calls[1].messages.slice(0, 3), api.calls[0].messages);
  assert.deepEqual(Object.keys(request), ['model', 'max_tokens', 'system', 'tools']);
});

test('トークンの使用量を、往復ぶん合計する', async () => {
  const { promise } = turn([
    response('tool_use', [toolUse('toolu_1', 'meal_cost', { days_low: 8, days_high: 8 })], {
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
    }),
    response('end_turn', [text('答え')], { usage: { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 105 } }),
  ]);
  const result = await promise;
  assert.deepEqual(result.usage, { input_tokens: 250, output_tokens: 50, cache_read_input_tokens: 110, cache_creation_input_tokens: 7 });
});

test('代わりのモデルが返答したときと、思考ブロックが落とされたときは知らせる', async () => {
  const { promise } = turn([response('end_turn', [text('答え')], {
    model: 'claude-opus-5',
    usage: { ...usage, iterations: [{ type: 'message' }, { type: 'fallback_message' }] },
    input_transformations: [
      { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
      { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'model_binding_mismatch' },
    ],
  })]);
  const result = await promise;
  assert.ok(result.notices.some((notice) => notice.kind === 'fallback' && notice.text.includes('claude-opus-5')));
  assert.equal(result.notices.filter((notice) => notice.kind === 'history_mismatch').length, 1);
});

test('API の呼び出しが失敗したら、例外をそのまま上へ渡す', async () => {
  const failure = new Error('接続できない');
  await assert.rejects(
    runTurn({ createMessage: async () => { throw failure; }, request, history: [], userText: 'こんにちは', executeTool }),
    (error) => error === failure,
  );
});
