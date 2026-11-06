import test from "node:test";
import assert from "node:assert/strict";
import {
  exportMemo,
  mergeCards,
  requestSchema,
  validateEvidence,
  workspaceSchema,
  type Reply,
} from "../lib/workspace";
import { exampleWorkspace } from "../lib/example";
import { isAllowedRequest, readBoundedJson } from "../lib/request";

test("架空の体験例にも、本人の発言を根拠にする検査を適用する", () => {
  const workspace = workspaceSchema.parse(exampleWorkspace());
  assert.doesNotThrow(() =>
    validateEvidence(
      { reply: "例", cards: workspace.cards },
      workspace.messages,
    ),
  );
});

test("AIが作った発言・存在しない引用・書き換えた思い出を本人の言葉にしない", () => {
  const workspace = exampleWorkspace();
  const card = workspace.cards[2];
  const check = (patch: object) =>
    validateEvidence(
      { reply: "例", cards: [{ ...card, ...patch }] } as Reply,
      workspace.messages,
    );
  assert.throws(
    () => check({ body: "いつまでも愛しているよ。" }),
    /invented-memory/,
  );
  assert.throws(
    () =>
      check({
        evidence: [{ messageId: "example-3", quote: "話していない出来事" }],
      }),
    /invalid-evidence/,
  );
  assert.throws(
    () =>
      check({
        evidence: [{ messageId: "example-reply", quote: "朝の引き継ぎメモ" }],
      }),
    /invalid-evidence/,
  );
});

test("編集・完了・持ち出し選択したメモは上書きしない。未確認のメモのみ会話で更新する", () => {
  const original = exampleWorkspace().cards[0];
  for (const flag of ["edited", "done", "included"] as const) {
    const card = { ...original, [flag]: true };
    assert.equal(
      mergeCards([card], [{ ...original, body: "上書き" }])[0].body,
      original.body,
    );
  }
  const next = mergeCards(
    [original],
    [{ ...original, body: "会話で追加された情報" }],
  );
  assert.equal(next[0].body, "会話で追加された情報");
  assert.equal(original.body, exampleWorkspace().cards[0].body);
});

test("持ち出すのは選んだメモだけ。引用・会話・未選択の思い出を漏らさない", () => {
  const { cards } = exampleWorkspace();
  assert.equal(exportMemo(cards), "");
  cards[0].included = true;
  const text = exportMemo(cards);
  assert.match(text, /朝の支度/);
  assert.match(text, /まだ確かめていないこと/);
  assert.doesNotMatch(text, /ホットケーキ|保険会社|example-|再来週/);
});

test("履歴の上限と重複IDをAPI境界で拒否する", () => {
  const workspace = exampleWorkspace();
  const input = {
    messages: workspace.messages.slice(0, 3),
    cards: workspace.cards,
  };
  assert.equal(requestSchema.safeParse(input).success, true);
  assert.equal(
    requestSchema.safeParse({
      ...input,
      messages: [...input.messages, input.messages[0]],
    }).success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({
      ...input,
      messages: [{ id: "x", role: "user", text: "x".repeat(4001) }],
    }).success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({ ...input, messages: workspace.messages }).success,
    false,
  );
});

test("他サイトからの送信・公開ホストからのAPI実行を拒否する", () => {
  const req = (url: string, origin?: string) =>
    new Request(url, { headers: origin ? { origin } : {} });
  assert.equal(
    isAllowedRequest(
      req("http://127.0.0.1:3000/api/chat", "http://127.0.0.1:3000"),
    ),
    true,
  );
  assert.equal(
    isAllowedRequest(
      req("http://127.0.0.1:3000/api/chat", "https://other.example"),
    ),
    false,
  );
  assert.equal(
    isAllowedRequest(
      req("https://public.example/api/chat", "https://public.example"),
    ),
    false,
  );
  assert.equal(isAllowedRequest(req("http://localhost:3000/api/chat")), false);
  assert.equal(
    isAllowedRequest(
      new Request("http://localhost:3000/api/chat", {
        headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      }),
    ),
    true,
  );
  assert.equal(
    isAllowedRequest(
      new Request("http://localhost:3000/api/chat", {
        headers: { host: "external.example", origin: "http://127.0.0.1:3000" },
      }),
    ),
    false,
  );
});

test("配置先として登録したHTTPSオリジンだけを許可し、偽装したHostや別サイトは拒否する", () => {
  const origin = "https://sakiyomi.example";
  const origins = [origin];
  const req = (host: string, from: string) =>
    new Request("http://localhost/api/chat", {
      headers: { host, origin: from },
    });
  assert.equal(
    isAllowedRequest(req("sakiyomi.example", origin), origins),
    true,
  );
  assert.equal(
    isAllowedRequest(req("sakiyomi.example", "https://evil.example"), origins),
    false,
  );
  assert.equal(isAllowedRequest(req("evil.example", origin), origins), false);
  assert.equal(
    isAllowedRequest(req("sakiyomi.example", "http://sakiyomi.example"), [
      "http://sakiyomi.example",
    ]),
    false,
  );
  assert.equal(
    isAllowedRequest(
      req("unknown.vercel.app", "https://unknown.vercel.app"),
      origins,
    ),
    false,
  );
});

test("Content-Lengthに頼らず実際の本文サイズ・JSON形式を検査する", async () => {
  const req = (body: string) =>
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  assert.deepEqual(await readBoundedJson(req('{"ok":true}')), { ok: true });
  await assert.rejects(
    readBoundedJson(req('"' + "a".repeat(40) + '"'), 20),
    /body-too-large/,
  );
  await assert.rejects(readBoundedJson(req("not JSON")));
});
