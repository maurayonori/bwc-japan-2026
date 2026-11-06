import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';

// Claude API を呼ぶところ。公式の SDK（@anthropic-ai/sdk）だけを使う。

export const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'medium';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

// ベータの機能。どちらも、無くても会話は動く。
// - フォールバック: 安全上の理由でモデルが返答を断ったとき、API が代わりのモデルで同じリクエストをやり直す。
// - 思考ブロックの扱い: 履歴が変わったと判定されたとき、400 にせず、そのブロックを落として続ける。
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const BETA_PARAMS = Object.freeze({
  betas: Object.freeze([FALLBACK_BETA, THINKING_BINDING_BETA]),
  fallbacks: 'default',
  thinking: Object.freeze({ type: 'adaptive', block_binding: Object.freeze({ prefix_mismatch_behavior: 'drop_block' }) }),
});

function readEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

// リポジトリ直下の .env と .env.local を読む。優先は、実際の環境変数 → .env.local → .env。
// process.env は書き換えない（鍵をシェルや子プロセスへ広げないため）。
export function loadEnv(repoRoot, processEnv) {
  return {
    ...readEnvFile(path.join(repoRoot, '.env')),
    ...readEnvFile(path.join(repoRoot, '.env.local')),
    ...processEnv,
  };
}

const filled = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

export function readConfig(env) {
  return {
    model: filled(env.HOSPITAL_CHAT_MODEL) ?? filled(env.ANTHROPIC_MODEL) ?? DEFAULT_MODEL,
    effort: EFFORTS.includes(env.HOSPITAL_CHAT_EFFORT) ? env.HOSPITAL_CHAT_EFFORT : DEFAULT_EFFORT,
    betaFeatures: env.HOSPITAL_CHAT_BETA !== 'off',
  };
}

function readKeyFile(file) {
  try {
    return filled(readFileSync(file, 'utf8'));
  } catch {
    // 読めない鍵ファイルは「未設定」として扱う。起動時の表示で、未接続だと分かる。
    return null;
  }
}

// 鍵は ANTHROPIC_API_KEY、無ければ ANTHROPIC_API_KEY_FILE が指すファイルから読む。
// どちらも無ければ null を返す（呼び出し側が「未接続」として案内する）。鍵は表示もログもしない。
export function createClient(env) {
  const options = { timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES };
  const apiKey = filled(env.ANTHROPIC_API_KEY)
    ?? (filled(env.ANTHROPIC_API_KEY_FILE) ? readKeyFile(filled(env.ANTHROPIC_API_KEY_FILE)) : null);
  if (apiKey) return new Anthropic({ ...options, apiKey });
  const authToken = filled(env.ANTHROPIC_AUTH_TOKEN);
  if (authToken) return new Anthropic({ ...options, apiKey: null, authToken });
  return null;
}

// セッションのあいだ変えない、リクエストの土台。
// 思考は常に有効なモデルなので thinking は書かず、深さは effort で決める。
// 上の cache_control は、伸びていく会話の末尾を自動でキャッシュする指定。
export function buildRequest({ model, effort, system, tools }) {
  return Object.freeze({
    model,
    max_tokens: MAX_TOKENS,
    output_config: Object.freeze({ effort }),
    cache_control: Object.freeze({ type: 'ephemeral' }),
    system,
    tools,
  });
}

// メッセージを送る関数を作る。
// ベータ付きのリクエストが 400 で拒まれたときは、ベータの指定を外して 1 回だけ送り直す。
// それで通ったら、以後は外したまま送る（degraded() が true になる）。
export function createSender({ client, betaFeatures }) {
  let useBeta = betaFeatures;
  let degraded = false;

  async function send(params) {
    if (!useBeta) return client.messages.create(params);
    try {
      return await client.beta.messages.create({ ...params, ...BETA_PARAMS });
    } catch (error) {
      if (!(error instanceof Anthropic.BadRequestError)) throw error;
      const response = await client.messages.create(params);
      useBeta = false;
      degraded = true;
      return response;
    }
  }

  return { send, degraded: () => degraded };
}

// 失敗を、型で見分けて、画面に出す日本語と HTTP の状態にする。
// API が返した詳しい文面は、画面にもサーバーのログにも出さない。
export function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return { code: 'auth', status: 502, message: 'API キーが正しくないか、無効になっています。.env.local の設定を確かめてください。' };
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { code: 'permission', status: 502, message: 'この API キーでは、指定したモデルや機能を使えません。' };
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { code: 'not_found', status: 502, message: '指定したモデルが見つかりません。ANTHROPIC_MODEL の値を確かめてください。' };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { code: 'rate_limit', status: 429, message: '利用の上限に達しました。少し待ってから、もう一度送ってください。' };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { code: 'connection', status: 503, message: 'Claude に接続できませんでした。ネットワークを確かめて、もう一度送ってください。' };
  }
  if (error instanceof Anthropic.APIError && error.status >= 500) {
    return { code: 'server', status: 503, message: 'Claude の側が混み合っているか、不調です。少し待ってから、もう一度送ってください。' };
  }
  if (error instanceof Anthropic.APIError) {
    return { code: 'bad_request', status: 502, message: 'リクエストが受け付けられませんでした。この試作の不具合の可能性があります。サーバーのログを見てください。' };
  }
  return { code: 'unknown', status: 500, message: '想定外のエラーが起きました。サーバーのログを見てください。' };
}
