import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { FACTS } from '../src/facts.mjs';
import { createServer } from '../src/server.mjs';
import { TOOLS } from '../src/tools.mjs';

const config = Object.freeze({ model: 'claude-opus-5-5', effort: 'medium', betaFeatures: true });
const usage = { input_tokens: 10, output_tokens: 5 };
const text = (value) => ({ type: 'text', text: value });
const answer = (value) => ({ stop_reason: 'end_turn', content: [text(value)], usage, model: config.model });
const servers = [];

after(() => Promise.all(servers.map((server) => new Promise((resolve) => { server.close(resolve); }))));

// 用意した応答を順に返す、Claude API の代役。関数を入れると、その場で呼んで結果を返す。
function scripted(responses) {
  const calls = [];
  const queue = [...responses];
  const send = async (params) => {
    calls.push(structuredClone(params));
    const item = queue.shift();
    if (item instanceof Error) throw item;
    if (typeof item === 'function') return item();
    return item ?? answer('（用意した応答が尽きた）');
  };
  return { send, calls };
}

async function start(options = {}) {
  const api = scripted(options.responses ?? []);
  const server = createServer({
    send: options.connected === false ? null : api.send,
    connected: options.connected !== false,
    config,
    today: () => '2026-11-06',
    degraded: () => false,
    ...options.overrides,
  });
  servers.push(server);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const post = (pathname, body, headers = {}) => fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const chat = async (message, sessionId = null) => {
    const response = await post('/api/chat', { session_id: sessionId, message });
    return { status: response.status, body: await response.json() };
  };
  return { api, origin, port, post, chat };
}

// Host ヘッダーを変えて送るための、素の HTTP リクエスト。
function rawGet(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

test('画面のファイルを、安全のためのヘッダーを付けて返す', async () => {
  const { origin } = await start();
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /<html lang="ja">/);

  for (const pathname of ['/app.js', '/cards.js', '/dom.js']) {
    const script = await fetch(`${origin}${pathname}`);
    assert.equal(script.status, 200, pathname);
    assert.match(script.headers.get('content-type'), /^text\/javascript/, pathname);
  }
  const style = await fetch(`${origin}/app.css`);
  assert.match(style.headers.get('content-type'), /^text\/css/);
});

test('画面のファイル以外は返さない', async () => {
  const { origin } = await start();
  for (const pathname of ['/package.json', '/src/server.mjs', '/../package.json', '/%2e%2e/package.json', '/app.js/../../package.json', '/api/unknown']) {
    const response = await fetch(`${origin}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
});

test('状態と、持っている事実を返す', async () => {
  const { origin } = await start();
  const status = await (await fetch(`${origin}/api/status`)).json();
  assert.deepEqual(status, {
    connected: true, model: 'claude-opus-5-5', effort: 'medium', beta_features: true, degraded: false, today: '2026-11-06',
  });
  const facts = await (await fetch(`${origin}/api/facts`)).json();
  assert.equal(facts.facts.length, FACTS.length);
  assert.match(facts.facts[0].sources[0].url, /^https:/);
});

test('この端末の、この画面からのリクエストだけを受け付ける', async () => {
  const { origin, port, post } = await start();
  const noOrigin = await fetch(`${origin}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await post('/api/chat', { message: 'x' }, { origin: 'https://example.com' })).status, 403);
  assert.equal(await rawGet(port, '/api/status', 'example.com'), 403);
  assert.equal(await rawGet(port, '/api/status', `localhost:${port}`), 200);
  assert.equal((await post('/api/chat', { message: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${origin}/api/chat`, { method: 'PUT', headers: { origin } })).status, 405);
});

test('読めない・空・長すぎる入力は断る', async () => {
  const { post, api } = await start();
  assert.equal((await post('/api/chat', '{"message":')).status, 400);
  assert.equal((await post('/api/chat', { session_id: null, message: '   ' })).status, 400);
  assert.equal((await post('/api/chat', { session_id: null, message: 12 })).status, 400);
  assert.equal((await post('/api/chat', { session_id: null, message: 'あ'.repeat(4001) })).status, 400);
  assert.equal((await post('/api/chat', { session_id: null, message: 'a'.repeat(40_000) })).status, 413);
  assert.equal((await post('/api/chat', [1, 2])).status, 400);
  assert.equal(api.calls.length, 0);
});

test('鍵が設定されていないときは、設定のしかたを案内する', async () => {
  const { chat, origin } = await start({ connected: false });
  const { status, body } = await chat('来月入院します');
  assert.equal(status, 503);
  assert.match(body.error, /\.env\.local/);
  assert.equal((await (await fetch(`${origin}/api/status`)).json()).connected, false);
});

test('会話を進め、道具の計算結果を返し、同じセッションでは履歴を引き継ぐ', async () => {
  const toolCall = {
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'kougaku_gendo', input: {
        treatment_month: '2026-11', income_category: 'ウ', amount_basis: 'copay', amount_low: 300_000, amount_high: 300_000, copay_percent: 30,
      } },
    ],
    usage,
    model: config.model,
  };
  const { chat, api } = await start({ responses: [toolCall, answer('窓口では 92,940 円です。'), answer('はい、月ごとです。')] });

  const first = await chat('来月入院します。概算は 30 万円と言われました。');
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, 'answered');
  assert.equal(first.body.reply, '窓口では 92,940 円です。');
  assert.match(first.body.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(first.body.tool_events.length, 1);
  assert.equal(first.body.tool_events[0].output.cases[0].low.cap, 92_940);
  assert.deepEqual(first.body.warnings, []);
  assert.deepEqual(first.body.usage, { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

  const second = await chat('月ごとに計算するのですか', first.body.session_id);
  assert.equal(second.body.session_id, first.body.session_id);
  assert.equal(second.body.reply, 'はい、月ごとです。');

  // 送ったリクエスト: 土台は毎回同じで、messages は後ろに足すだけ。
  assert.equal(api.calls.length, 3);
  assert.equal(api.calls[0].model, 'claude-opus-5-5');
  assert.deepEqual(api.calls[0].output_config, { effort: 'medium' });
  assert.deepEqual(api.calls[0].tools, structuredClone(TOOLS));
  assert.match(api.calls[0].system[1].text, /2026-11-06/);
  assert.deepEqual(api.calls[2].system, api.calls[0].system);
  assert.deepEqual(api.calls[2].tools, api.calls[0].tools);
  assert.equal(api.calls[2].messages.length, 5);
  assert.deepEqual(api.calls[2].messages.slice(0, 3), api.calls[1].messages);
  assert.equal(api.calls[2].messages[1].content[0].signature, 'sig-1');
});

test('計算結果に無い金額が返答にあったら、注意を付ける', async () => {
  const { chat } = await start({ responses: [answer('たぶん 123,456 円くらいです。')] });
  const { body } = await chat('いくらかかりますか');
  assert.equal(body.warnings.length, 1);
  assert.match(body.warnings[0], /123,456 円/);
});

test('知らないセッションと、消したセッションは見つからないと返す', async () => {
  const { chat, post } = await start({ responses: [answer('はい')] });
  assert.equal((await chat('こんにちは', '00000000-0000-4000-8000-000000000000')).status, 404);
  const { body } = await chat('こんにちは');
  const reset = await post('/api/reset', { session_id: body.session_id });
  assert.equal(reset.status, 200);
  assert.equal((await chat('続きです', body.session_id)).status, 404);
  assert.equal((await post('/api/reset', { session_id: 12 })).status, 400);
});

test('API の失敗は、本文を画面にもログにも出さず、セッションは続けて使える', async (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const limited = Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'secret detail' } }, 'secret detail', new Headers());
  const { chat } = await start({ responses: [answer('はい'), limited, answer('戻りました')] });
  const first = await chat('こんにちは');
  const failed = await chat('もう一度', first.body.session_id);
  assert.equal(failed.status, 429);
  assert.equal(failed.body.code, 'rate_limit');
  assert.doesNotMatch(JSON.stringify(failed.body), /secret detail/);
  assert.equal(logs.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(logs.mock.calls.map((call) => call.arguments)), /secret detail/);
  const retried = await chat('もう一度', first.body.session_id);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.reply, '戻りました');
});

test('断られた往復は履歴に残さず、計算結果も返さない', async () => {
  const refusal = { stop_reason: 'refusal', content: [], usage, model: config.model };
  const { chat, api } = await start({ responses: [refusal, answer('はい')] });
  const first = await chat('最初の発言');
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, 'refused');
  assert.equal(first.body.reply, null);
  assert.ok(first.body.notices.length >= 1);
  await chat('言い直し', first.body.session_id);
  assert.deepEqual(api.calls[1].messages, [{ role: 'user', content: '言い直し' }]);
});

test('同じセッションで返答を待っているあいだは、次の発言を受け付けない', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { chat } = await start({ responses: [answer('はい'), () => waiting.then(() => answer('お待たせしました'))] });
  const first = await chat('こんにちは');
  const slow = chat('時間のかかる質問', first.body.session_id);
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  const blocked = await chat('割り込み', first.body.session_id);
  assert.equal(blocked.status, 409);
  release();
  assert.equal((await slow).body.reply, 'お待たせしました');
});

test('返答を待っているあいだに消した会話は、返答が出たあとも残らない', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { chat, post } = await start({ responses: [answer('はい'), () => waiting.then(() => answer('遅い返答'))] });
  const first = await chat('こんにちは');
  const slow = chat('時間のかかる質問', first.body.session_id);
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal((await post('/api/reset', { session_id: first.body.session_id })).status, 200);
  release();
  await slow;
  assert.equal((await chat('続き', first.body.session_id)).status, 404);
});

test('長くなった会話は、新しく始めるように案内する', async () => {
  const { chat } = await start({ responses: [answer('1'), answer('2')], overrides: { maxTurns: 2 } });
  const first = await chat('1 回目');
  await chat('2 回目', first.body.session_id);
  const third = await chat('3 回目', first.body.session_id);
  assert.equal(third.status, 409);
  assert.match(third.body.error, /新しい会話/);
});

test('セッションが上限を超えたら、いちばん古いものから消す', async () => {
  const { chat } = await start({ responses: [answer('a'), answer('b'), answer('c')], overrides: { maxSessions: 2 } });
  const first = await chat('1 人目');
  await chat('2 人目');
  await chat('3 人目');
  assert.equal((await chat('続き', first.body.session_id)).status, 404);
});

test('全セッションが返答待ちなら、新しい会話を断り API を余分に呼ばない', async () => {
  let release;
  let signalStarted;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const { chat, api } = await start({
    responses: [() => { signalStarted(); return waiting.then(() => answer('完了')); }],
    overrides: { maxSessions: 1 },
  });
  const first = chat('1 人目');
  await started;
  try {
    const second = await chat('2 人目');
    assert.equal(second.status, 503);
    assert.equal(api.calls.length, 1);
  } finally {
    release();
    await first;
  }
  assert.equal((await chat('待った後の新しい会話')).status, 200);
});
