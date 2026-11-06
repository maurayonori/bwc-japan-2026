// 画面の動き。この端末の中のサーバーとだけ通信する。
// Claude の返答も計算結果も、文字として入れる（HTML として解釈させない）。

import { toolCard } from "./cards.js";
import {
  count,
  el,
  externalLink,
  list,
  setTodayYear,
  sourceLine,
} from "./dom.js";

const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("message");
const sendButton = document.getElementById("send");
const resetButton = document.getElementById("reset");
const exampleButton = document.getElementById("example");
const statusPill = document.getElementById("status");
const factsList = document.getElementById("facts-list");
const factsCount = document.getElementById("facts-count");

// 架空の例。実在の人物・出来事ではない。
const EXAMPLE_TEXT =
  "来月の中ごろに、手術で入院することになりました。入院は 10 日間から 2 週間くらいと言われています。病院の人には、3 割負担でだいたい 30 万円くらいと言われました。高額療養費という制度があるのは聞いたことがありますが、自分が使えるのか、結局いくら用意しておけばいいのかが分かりません。月末には家賃 8 万円の引き落としもあります。民間の医療保険にも入っていますが、いつ・いくら出るのかは確かめていません。";

const TEXT = {
  pending: "考えています。計算の道具を呼ぶので、30 秒ほどかかることがあります…",
  unreachable:
    "サーバーに届きませんでした。サーバーが動いているかを確かめて、もう一度送ってください。",
  unexpected: "想定外のエラーが起きました。サーバーのログを見てください。",
  sessionLost:
    "サーバーが起動し直されたか、会話が古くなったため、この画面の会話は引き継げません。もう一度送ると、新しい会話として始まります。",
  notSent: "（送れませんでした）",
  notConnected:
    "Claude への接続が設定されていません。リポジトリ直下の .env.local に ANTHROPIC_API_KEY か ANTHROPIC_API_KEY_FILE を書いて、サーバーを起動し直してください。画面は見られますが、会話はできません。",
  statusUnknown: "サーバーの状態を読めませんでした",
  confirmReset: "画面の会話を消して、新しく始めます。よろしいですか？",
  checkNumbers: "返答の数字を、計算結果と照らしてください",
  cardsTitle: "プログラムの計算結果",
};

const VERIFIED_TEXT = {
  primary: "出典の本文と突き合わせ済み",
  transcribed: "出典からの書き起こし。本文との突き合わせはまだ",
};

let sessionId = null;
let busy = false;
let facts = new Map();

// ---- Claude の返答（段落、「- 」と「1. 」の箇条書き、**太字**、[F03] の出典番号だけを読む） ----

function citationNodes(ids) {
  return ids.flatMap((id, index) => {
    const fact = facts.get(id);
    const source = fact?.sources[0];
    const link = fact
      ? externalLink(
          source?.url,
          id,
          `${fact.topic}（${source?.name ?? "出典"}）`,
        )
      : el("span", { text: id, title: "この番号の事実は、持っていません" });
    link.classList.add("cite");
    return index > 0 ? [" ", link] : [link];
  });
}

function withCitations(text) {
  return text
    .split(/(\[F\d{2}(?:\s*[,、]\s*F\d{2})*\])/)
    .filter(Boolean)
    .flatMap((part) =>
      /^\[F\d{2}/.test(part) ? citationNodes(part.match(/F\d{2}/g)) : [part],
    );
}

function inline(text) {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .flatMap((part) => {
      const bold = /^\*\*([^*]+)\*\*$/.exec(part);
      return bold
        ? [el("strong", {}, withCitations(bold[1]))]
        : withCitations(part);
    });
}

// 続いている箇条書きの行、続いている文の行を、それぞれ 1 つにまとめる。
function groupLines(lines) {
  return lines.reduce((groups, line) => {
    const bullet = /^[-・]\s+(.*)$/.exec(line);
    const numbered = /^\d{1,2}[.．)）]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const kind = bullet
      ? "list"
      : numbered
        ? "numbered"
        : heading
          ? "heading"
          : "text";
    const content = bullet?.[1] ?? numbered?.[1] ?? heading?.[1] ?? line;
    const last = groups.at(-1);
    if (last && last.kind === kind && kind !== "heading") {
      return [
        ...groups.slice(0, -1),
        { kind, lines: [...last.lines, content] },
      ];
    }
    return [...groups, { kind, lines: [content] }];
  }, []);
}

function renderGroup(group) {
  if (group.kind === "list" || group.kind === "numbered") {
    return el(
      group.kind === "list" ? "ul" : "ol",
      {},
      group.lines.map((line) => el("li", {}, inline(line))),
    );
  }
  if (group.kind === "heading") {
    return el("p", {}, el("strong", {}, inline(group.lines[0])));
  }
  return el(
    "p",
    {},
    group.lines.flatMap((line, index) =>
      index > 0 ? [el("br"), ...inline(line)] : inline(line),
    ),
  );
}

function renderReply(text) {
  return text.split(/\n{2,}/).flatMap((block) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return groupLines(lines).map(renderGroup);
  });
}

// ---- 会話 ----

function appendToLog(node) {
  log.append(node);
  node.scrollIntoView({ block: "nearest" });
  return node;
}

const appendNote = (text, kind) =>
  appendToLog(
    el("p", {
      class: `note ${kind}`,
      text,
      ...(kind === "error" ? { role: "alert" } : {}),
    }),
  );

function appendUser(text) {
  return appendToLog(
    el("article", { class: "message user" }, [
      el("p", { class: "who", text: "あなた" }),
      el("p", { class: "said", text }),
    ]),
  );
}

function usageText(body) {
  const usage = body.usage;
  const inputTokens =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens;
  return [
    body.model,
    `入力 ${count(inputTokens)} トークン（うちキャッシュから ${count(usage.cache_read_input_tokens)}）`,
    `出力 ${count(usage.output_tokens)} トークン`,
    ...(body.degraded ? ["ベータの機能なしで動作"] : []),
  ].join("・");
}

function appendAssistant(body) {
  const cards = body.tool_events.map(toolCard).filter(Boolean);
  const node = el("article", { class: "message assistant" }, [
    el("p", { class: "who", text: "Claude の返答" }),
    ...(body.reply
      ? [el("div", { class: "reply" }, renderReply(body.reply))]
      : []),
    ...body.notices.map((text) => el("p", { class: "note notice", text })),
    ...(body.warnings.length > 0
      ? [
          el("div", { class: "note warning" }, [
            el("p", { class: "fold-label", text: TEXT.checkNumbers }),
            list(body.warnings),
          ]),
        ]
      : []),
    ...(cards.length > 0
      ? [
          el("div", { class: "cards" }, [
            el("h2", { class: "cards-title", text: TEXT.cardsTitle }),
            ...cards,
          ]),
        ]
      : []),
    el("p", { class: "usage", text: usageText(body) }),
  ]);
  log.append(node);
  node.scrollIntoView({ block: "start" });
}

// 失敗も、画面に出せる形（error の文）にして返す。
async function requestJson(pathname, payload) {
  try {
    const response = await fetch(
      pathname,
      payload === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
    );
    const body = await response.json();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    console.error(error);
    return { ok: false, status: 0, body: { error: TEXT.unreachable } };
  }
}

function setBusy(value) {
  busy = value;
  for (const button of [sendButton, resetButton, exampleButton]) {
    button.disabled = value;
  }
  log.setAttribute("aria-busy", String(value));
}

// 送れなかった文は、入力欄に戻す（書き直さなくて済むように）。
function showFailure(userNode, text, message) {
  userNode.classList.add("failed");
  userNode.append(el("p", { class: "who", text: TEXT.notSent }));
  if (input.value.trim() === "") input.value = text;
  appendNote(message, "error");
}

async function send(text) {
  setBusy(true);
  input.value = "";
  const userNode = appendUser(text);
  const pending = appendNote(TEXT.pending, "pending");
  const { ok, status, body } = await requestJson("/api/chat", {
    session_id: sessionId,
    message: text,
  });
  pending.remove();

  if (typeof body.session_id === "string") sessionId = body.session_id;
  if (ok) {
    appendAssistant(body);
  } else if (status === 404) {
    sessionId = null;
    showFailure(userNode, text, TEXT.sessionLost);
  } else {
    showFailure(userNode, text, body.error ?? TEXT.unexpected);
  }
  setBusy(false);
  input.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (busy || text === "") return;
  send(text).catch((error) => {
    console.error(error);
    appendNote(TEXT.unexpected, "error");
    setBusy(false);
  });
});

// 日本語の変換を確定する Enter では送らない。送るのは、ボタンか ⌘ / Ctrl + Enter。
input.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.isComposing
  ) {
    event.preventDefault();
    form.requestSubmit();
  }
});

exampleButton.addEventListener("click", () => {
  input.value = EXAMPLE_TEXT;
  input.focus();
});

resetButton.addEventListener("click", async () => {
  if (busy) return;
  if (log.childElementCount > 0 && !window.confirm(TEXT.confirmReset)) return;
  const previous = sessionId;
  sessionId = null;
  log.replaceChildren();
  input.focus();
  if (previous) await requestJson("/api/reset", { session_id: previous });
});

// ---- 起動 ----

function showStatus(status) {
  if (!status) {
    statusPill.textContent = TEXT.statusUnknown;
    statusPill.classList.add("warn");
    return;
  }
  setTodayYear(Number(status.today.slice(0, 4)));
  statusPill.textContent = status.connected
    ? `Claude に接続（${status.model}）`
    : "未接続（鍵の設定が要ります）";
  statusPill.classList.add(status.connected ? "ok" : "warn");
  if (!status.connected) appendNote(TEXT.notConnected, "error");
}

function showFacts(items) {
  facts = new Map(items.map((fact) => [fact.id, fact]));
  factsCount.textContent = `（${items.length} 件）`;
  factsList.replaceChildren(
    ...items.map((fact) =>
      el("li", {}, [
        el("p", {}, el("strong", { text: `${fact.id} ${fact.topic}` })),
        el("p", { text: fact.text }),
        sourceLine(
          fact.sources,
          `（${fact.checked_on} に確認。${VERIFIED_TEXT[fact.verified] ?? fact.verified}）`,
        ),
      ]),
    ),
  );
}

async function init() {
  const [status, factsResult] = await Promise.all([
    requestJson("/api/status"),
    requestJson("/api/facts"),
  ]);
  showStatus(status.ok ? status.body : null);
  showFacts(factsResult.ok ? factsResult.body.facts : []);
}

init().catch((error) => {
  console.error(error);
  statusPill.textContent = TEXT.statusUnknown;
  statusPill.classList.add("warn");
});
