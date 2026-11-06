import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODEL, buildRequest, createClient, createSender, describeError, loadEnv, readConfig,
} from '../src/claude.mjs';

const apiError = (status) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'detail' } }, 'detail', new Headers());

// SDK のクライアントの代役。どちらの入口が、どんな引数で呼ばれたかを残す。
function fakeClient({ beta = [], plain = [] } = {}) {
  const calls = [];
  const next = (queue, kind) => async (params) => {
    calls.push({ kind, params });
    const item = queue.shift();
    if (item instanceof Error) throw item;
    return item ?? { stop_reason: 'end_turn', content: [], usage: {} };
  };
  return {
    calls,
    beta: { messages: { create: next([...beta], 'beta') } },
    messages: { create: next([...plain], 'plain') },
  };
}

test('モデルは、専用の指定 → リポジトリ共通の指定 → 既定の順に決まる', () => {
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  assert.equal(readConfig({}).model, 'claude-opus-5-5');
  assert.equal(readConfig({ ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5');
  assert.equal(readConfig({ ANTHROPIC_MODEL: 'claude-sonnet-5-5', HOSPITAL_CHAT_MODEL: 'claude-opus-5-5' }).model, 'claude-opus-5-5');
  assert.equal(readConfig({ ANTHROPIC_MODEL: '  ' }).model, 'claude-opus-5-5');
});

test('effort は明示する。既定は medium で、知らない値は既定に戻す', () => {
  assert.equal(readConfig({}).effort, 'medium');
  assert.equal(readConfig({ HOSPITAL_CHAT_EFFORT: 'low' }).effort, 'low');
  assert.equal(readConfig({ HOSPITAL_CHAT_EFFORT: 'turbo' }).effort, 'medium');
});

test('ベータの機能（フォールバックなど）は既定で入り、off で外せる', () => {
  assert.equal(readConfig({}).betaFeatures, true);
  assert.equal(readConfig({ HOSPITAL_CHAT_BETA: 'off' }).betaFeatures, false);
});

test('リクエストの土台は、Opus 5.5 / Sonnet 5.5 で通る形にする', () => {
  const system = Object.freeze([{ type: 'text', text: 's' }]);
  const tools = Object.freeze([{ name: 't' }]);
  const request = buildRequest({ model: 'claude-opus-5-5', effort: 'medium', system, tools });
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.max_tokens, 16000);
  assert.deepEqual(request.output_config, { effort: 'medium' });
  assert.deepEqual(request.cache_control, { type: 'ephemeral' });
  assert.equal(request.system, system);
  assert.equal(request.tools, tools);
  // 思考の無効化・予算、強制の tool_choice、サンプリングの指定は 400 になるので入れない。
  for (const key of ['thinking', 'tool_choice', 'temperature', 'top_p', 'top_k']) assert.equal(key in request, false, key);
  assert.throws(() => { request.model = 'x'; }, TypeError);
});

test('ベータの機能が有効なら、beta の入口にフォールバックと思考ブロックの扱いを付けて送る', async () => {
  const client = fakeClient();
  const sender = createSender({ client, betaFeatures: true });
  await sender.send({ model: 'claude-opus-5-5', max_tokens: 16000, messages: [] });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].kind, 'beta');
  const { params } = client.calls[0];
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01']);
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(sender.degraded(), false);
});

test('ベータの機能を外したら、通常の入口に余分な指定なしで送る', async () => {
  const client = fakeClient();
  const sender = createSender({ client, betaFeatures: false });
  await sender.send({ model: 'claude-opus-5-5', max_tokens: 16000, messages: [] });
  assert.equal(client.calls[0].kind, 'plain');
  for (const key of ['betas', 'fallbacks', 'thinking']) assert.equal(key in client.calls[0].params, false, key);
});

test('ベータ付きのリクエストが 400 で拒まれたら、外して 1 回だけ送り直し、以後は外したままにする', async () => {
  const ok = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} };
  const client = fakeClient({ beta: [apiError(400)], plain: [ok] });
  const sender = createSender({ client, betaFeatures: true });
  const response = await sender.send({ model: 'm', messages: [] });
  assert.equal(response, ok);
  assert.deepEqual(client.calls.map((call) => call.kind), ['beta', 'plain']);
  assert.equal(sender.degraded(), true);
  await sender.send({ model: 'm', messages: [] });
  assert.deepEqual(client.calls.map((call) => call.kind), ['beta', 'plain', 'plain']);
});

test('外して送り直しても 400 なら、その失敗を返し、設定は変えない', async () => {
  const second = apiError(400);
  const client = fakeClient({ beta: [apiError(400)], plain: [second] });
  const sender = createSender({ client, betaFeatures: true });
  await assert.rejects(sender.send({ model: 'm', messages: [] }), (error) => error === second);
  assert.equal(sender.degraded(), false);
});

test('400 以外の失敗（混雑・認証など）では、送り直さない', async () => {
  for (const status of [401, 429, 500, 529]) {
    const failure = apiError(status);
    const client = fakeClient({ beta: [failure] });
    const sender = createSender({ client, betaFeatures: true });
    await assert.rejects(sender.send({ model: 'm', messages: [] }), (error) => error === failure);
    assert.equal(client.calls.length, 1, String(status));
  }
});

test('失敗は、型で見分けて日本語の説明にする', () => {
  const cases = [
    [apiError(401), 'auth', 502],
    [apiError(403), 'permission', 502],
    [apiError(404), 'not_found', 502],
    [apiError(429), 'rate_limit', 429],
    [apiError(400), 'bad_request', 502],
    [apiError(500), 'server', 503],
    [apiError(529), 'server', 503],
    [new Anthropic.APIConnectionError({ message: 'x' }), 'connection', 503],
    [new Anthropic.APIConnectionTimeoutError(), 'connection', 503],
    [new Error('unknown'), 'unknown', 500],
  ];
  for (const [error, code, status] of cases) {
    const described = describeError(error);
    assert.equal(described.code, code, error.constructor.name);
    assert.equal(described.status, status, error.constructor.name);
    assert.match(described.message, /[ぁ-ん]/);
    assert.doesNotMatch(described.message, /detail/);
  }
});

test('.env.local と .env を読み、実際の環境変数を優先する', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hospital-env-'));
  try {
    writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_MODEL=from-env\nONLY_ENV=1\n');
    writeFileSync(path.join(dir, '.env.local'), 'ANTHROPIC_MODEL=from-local\nONLY_LOCAL=1\n');
    const env = loadEnv(dir, { ONLY_LOCAL: 'from-process' });
    assert.equal(env.ANTHROPIC_MODEL, 'from-local');
    assert.equal(env.ONLY_ENV, '1');
    assert.equal(env.ONLY_LOCAL, 'from-process');
    assert.deepEqual(loadEnv(path.join(dir, 'missing'), { A: '1' }), { A: '1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('鍵は、環境変数か、鍵ファイルのパスから読む。無ければクライアントを作らない', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hospital-key-'));
  try {
    const keyFile = path.join(dir, 'key');
    writeFileSync(keyFile, 'dummy-key-from-file\n');
    assert.equal(createClient({}), null);
    assert.equal(createClient({ ANTHROPIC_API_KEY: '   ' }), null);
    assert.equal(createClient({ ANTHROPIC_API_KEY_FILE: path.join(dir, 'missing') }), null);
    assert.equal(createClient({ ANTHROPIC_API_KEY: 'dummy-key' }).apiKey, 'dummy-key');
    assert.equal(createClient({ ANTHROPIC_API_KEY_FILE: keyFile }).apiKey, 'dummy-key-from-file');
    assert.equal(createClient({ ANTHROPIC_API_KEY: 'dummy-key', ANTHROPIC_API_KEY_FILE: keyFile }).apiKey, 'dummy-key');
    assert.equal(createClient({ ANTHROPIC_AUTH_TOKEN: 'dummy-token' }).authToken, 'dummy-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
