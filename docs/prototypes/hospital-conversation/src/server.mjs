import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequest, createClient, createSender, describeError, loadEnv, readConfig } from './claude.mjs';
import { runTurn } from './conversation.mjs';
import { todayInJapan } from './dates.mjs';
import { FACTS } from './facts.mjs';
import { checkReply } from './guard.mjs';
import { buildSystem } from './prompt.mjs';
import { TOOLS, executeTool } from './tools.mjs';

// この端末の中だけで動く、検証用のサーバー。
// - 127.0.0.1 で待ち受け、この画面からのリクエストだけを受ける
// - 会話はメモリの中にだけ置く。ファイルに書かない。本文をログに出さない
// - 利用者の文章は、返答を作るために Anthropic の API へ送られる（画面に明記している）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DEFAULT_PORT = 8791;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_SESSIONS = 20;

// 返すファイルは、ここに書いたものだけ。パスからファイル名を組み立てない。
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/cards.js': { file: 'cards.js', type: 'text/javascript; charset=utf-8' },
  '/dom.js': { file: 'dom.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const MESSAGES = {
  forbidden: 'この試作は、この端末で開いた画面からだけ使えます。',
  notFound: '見つかりません。',
  method: 'この操作はできません。',
  contentType: 'JSON で送ってください。',
  tooLarge: '入力が長すぎます。短くして、もう一度送ってください。',
  unreadable: '入力を読み取れませんでした。',
  emptyMessage: `メッセージは、1 文字以上 ${MAX_MESSAGE_LENGTH} 文字以下で送ってください。`,
  notConnected: 'Claude への接続が設定されていません。リポジトリ直下の .env.local（または .env）に ANTHROPIC_API_KEY か ANTHROPIC_API_KEY_FILE を書いて、このサーバーを起動し直してください。',
  noSession: '会話が見つかりません。新しい会話を始めてください。',
  busy: '前の返答を作っている途中です。返答が出てから、もう一度送ってください。',
  full: 'いまは返答待ちの会話が上限に達しています。返答が出てから、新しい会話を始めてください。',
  tooLong: '会話が長くなりました。新しい会話を始めてください。',
  unexpected: '想定外のエラーが起きました。サーバーのログを見てください。',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respondJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// 上限までを読む。超えたら中身は捨てて、最後に断る（途中で切ると、相手に理由が届かないことがある）。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) reject(new HttpError(413, MESSAGES.tooLarge));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJsonObject(req) {
  const body = await readBody(req);
  try {
    const value = JSON.parse(body);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, MESSAGES.unreadable);
  }
}

export function createServer({
  send, connected, config, today = todayInJapan, degraded = () => false,
  maxTurns = DEFAULT_MAX_TURNS, maxSessions = DEFAULT_MAX_SESSIONS,
}) {
  const staticFiles = Object.fromEntries(Object.entries(STATIC_FILES).map(([route, { file, type }]) => [
    route, { type, body: readFileSync(path.join(PUBLIC_DIR, file)) },
  ]));
  const sessions = new Map();

  function newSession() {
    // 上限を超えるぶんは、返答待ちでないものを、最後に使った時刻が古い順に消す。
    const idle = [...sessions.values()].filter((session) => !session.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const session of idle.slice(0, Math.max(0, sessions.size - maxSessions + 1))) sessions.delete(session.id);
    if (sessions.size >= maxSessions) throw new HttpError(503, MESSAGES.full);

    const day = today();
    // system と tools は、セッションの最初に決めて変えない（思考ブロックとキャッシュのため）。
    return {
      id: randomUUID(),
      today: day,
      request: buildRequest({ model: config.model, effort: config.effort, system: buildSystem(day), tools: TOOLS }),
      history: [],
      toolEvents: [],
      userTexts: [],
      turns: 0,
      busy: false,
      lastUsedAt: Date.now(),
    };
  }

  async function chat(req, res) {
    const body = await readJsonObject(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message === '' || message.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, MESSAGES.emptyMessage);
    if (!connected) throw new HttpError(503, MESSAGES.notConnected);

    const known = body.session_id === null || body.session_id === undefined ? null : sessions.get(body.session_id);
    if (known === undefined) throw new HttpError(404, MESSAGES.noSession);
    const session = known ?? newSession();
    if (session.busy) throw new HttpError(409, MESSAGES.busy);
    if (session.turns >= maxTurns) throw new HttpError(409, MESSAGES.tooLong);

    sessions.set(session.id, { ...session, busy: true });
    // 返答を待っているあいだに消された会話は、書き戻さない（消したものを復活させない）。
    const save = (next) => {
      if (sessions.has(session.id)) sessions.set(session.id, next);
    };
    try {
      const result = await runTurn({
        createMessage: send, request: session.request, history: session.history, userText: message, executeTool,
      });
      // 道具の中の想定外の失敗は、握りつぶさずにログへ出す（本文は出さない）。
      for (const error of result.errors) console.error('[tool error]', describeError(error).code);

      const kept = result.history !== session.history;
      const toolEvents = kept ? [...session.toolEvents, ...result.toolEvents] : session.toolEvents;
      const userTexts = [...session.userTexts, message];
      const warnings = checkReply({ reply: result.reply, toolEvents, userTexts, today: session.today });

      save({
        ...session,
        history: result.history,
        toolEvents,
        userTexts: kept ? userTexts : session.userTexts,
        turns: session.turns + 1,
        busy: false,
        lastUsedAt: Date.now(),
      });
      respondJson(res, 200, {
        session_id: session.id,
        outcome: result.outcome,
        reply: result.reply,
        tool_events: kept ? result.toolEvents : [],
        notices: result.notices.map((notice) => notice.text),
        warnings: warnings.map((warning) => warning.message),
        usage: result.usage,
        model: config.model,
        degraded: degraded(),
      });
    } catch (error) {
      save({ ...session, busy: false, lastUsedAt: Date.now() });
      const described = describeError(error);
      // API のエラー本文には、送った文章や認証情報が含まれる可能性がある。
      console.error('[chat error]', described.code, described.status);
      respondJson(res, described.status, { error: described.message, code: described.code, session_id: session.id });
    }
  }

  async function reset(req, res) {
    const body = await readJsonObject(req);
    if (typeof body.session_id !== 'string') throw new HttpError(400, MESSAGES.unreadable);
    sessions.delete(body.session_id);
    respondJson(res, 200, { ok: true });
  }

  const postRoutes = { '/api/chat': chat, '/api/reset': reset };

  const getRoutes = {
    '/api/status': (req, res) => respondJson(res, 200, {
      connected, model: config.model, effort: config.effort, beta_features: config.betaFeatures, degraded: degraded(), today: today(),
    }),
    '/api/facts': (req, res) => respondJson(res, 200, { facts: FACTS }),
  };

  // ほかのサイトや、名前を付け替えたアドレス（DNS リバインディング）からのリクエストを通さない。
  function requireLocal(req, port) {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) throw new HttpError(403, MESSAGES.forbidden);
    if (req.method === 'GET') return;
    if (!hosts.map((host) => `http://${host}`).includes(req.headers.origin)) throw new HttpError(403, MESSAGES.forbidden);
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    requireLocal(req, req.socket.localPort);

    if (req.method === 'GET') {
      if (Object.hasOwn(getRoutes, pathname)) return getRoutes[pathname](req, res);
      if (Object.hasOwn(staticFiles, pathname)) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': staticFiles[pathname].type });
        return res.end(staticFiles[pathname].body);
      }
      throw new HttpError(404, MESSAGES.notFound);
    }
    if (!Object.hasOwn(postRoutes, pathname)) throw new HttpError(404, MESSAGES.notFound);
    if (req.method !== 'POST') throw new HttpError(405, MESSAGES.method);
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, MESSAGES.contentType);
    return postRoutes[pathname](req, res);
  }

  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      if (error instanceof HttpError) {
        respondJson(res, error.status, { error: error.message });
        return;
      }
      console.error('[server error]', describeError(error).code);
      respondJson(res, 500, { error: MESSAGES.unexpected });
    });
  });
}

function main() {
  const env = loadEnv(REPO_ROOT, process.env);
  const config = readConfig(env);
  const client = createClient(env);
  const sender = client ? createSender({ client, betaFeatures: config.betaFeatures }) : null;
  const server = createServer({
    send: sender ? sender.send : null,
    connected: sender !== null,
    config,
    degraded: sender ? sender.degraded : () => false,
  });
  const port = Number(env.HOSPITAL_CHAT_PORT) || DEFAULT_PORT;

  server.on('error', (error) => {
    const reason = error.code === 'EADDRINUSE'
      ? `ポート ${port} は、ほかで使われています。HOSPITAL_CHAT_PORT で別の番号を指定してください。`
      : `サーバーを起動できませんでした（${error.code ?? error.message}）。`;
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  });
  // 鍵そのものは出さない。設定があるかどうかだけを出す。
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write([
      `入院前のお金の見通し（検証用の試作）: http://127.0.0.1:${port}`,
      `  モデル: ${config.model} ／ effort: ${config.effort} ／ ベータの機能: ${config.betaFeatures ? '有効' : '無効'}`,
      `  Claude への接続: ${sender ? '設定あり' : '未設定（画面は開けますが、会話はできません）'}`,
      '  止めるときは Ctrl+C',
      '',
    ].join('\n'));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
