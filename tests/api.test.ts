import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/chat/route";

const request = (data: unknown, origin = "http://127.0.0.1:3000") =>
  new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host: "127.0.0.1:3000",
      origin,
    },
    body: JSON.stringify(data),
  });

test("APIは他サイト・壊れた入力をClaudeを呼ばずに拒否する", async () => {
  assert.equal(
    (await POST(request({}, "https://outside.example"))).status,
    403,
  );
  const response = await POST(request({ messages: [], cards: [] }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("未接続を見本のAI回答で隠さず、入力を保持できる503を返す", async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFile = process.env.ANTHROPIC_API_KEY_FILE;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY_FILE;
  try {
    const response = await POST(
      request({
        messages: [
          { id: "test", role: "user", text: "引き継ぎの準備をしたい。" },
        ],
        cards: [],
      }),
    );
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.match(data.error, /接続がまだ設定されていません/);
    assert.equal("cards" in data, false);
  } finally {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalFile === undefined) delete process.env.ANTHROPIC_API_KEY_FILE;
    else process.env.ANTHROPIC_API_KEY_FILE = originalFile;
  }
});
