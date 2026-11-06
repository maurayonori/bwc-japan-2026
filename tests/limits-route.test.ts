import { strict as assert } from "node:assert";
import { test } from "node:test";

const request = (body: unknown, forwardedFor: string) =>
  new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "x-vercel-forwarded-for": forwardedFor,
    },
    body: JSON.stringify(body),
  });

const valid = {
  messages: [{ id: "m1", role: "user", text: "架空の相談です" }],
  cards: [],
};

test("上限を超えた送信は Claude を呼ばずに 429 を返し、壊れた入力は数えない", async () => {
  process.env.LIMIT_PER_CLIENT_PER_DAY = "2";
  process.env.LIMIT_GLOBAL_PER_DAY = "100";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY_FILE;
  const { POST } = await import("../app/api/chat/route");

  // 壊れた入力は 400 で、回数に入らない。
  for (let i = 0; i < 3; i++) {
    const broken = await POST(request({ messages: [] }, "203.0.113.1"));
    assert.equal(broken.status, 400);
  }
  // 鍵が無いので 503 になるが、上限の検査は通っている。
  assert.equal((await POST(request(valid, "203.0.113.1"))).status, 503);
  assert.equal((await POST(request(valid, "203.0.113.1"))).status, 503);

  const limited = await POST(request(valid, "203.0.113.1"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Cache-Control"), "no-store");
  const { error } = (await limited.json()) as { error: string };
  assert.match(error, /入力とメモは残っています/);

  // 別の端末は影響を受けない。
  assert.equal((await POST(request(valid, "203.0.113.2"))).status, 503);

  // メモが上限いっぱいなら、呼び出す前に断り、回数も減らさない。
  const fullCards = Array.from({ length: 24 }, (_, index) => ({
    id: `c${index}`,
    kind: "daily",
    title: "架空のメモ",
    body: "架空の本文",
    nextStep: "架空の次の一歩",
    uncertainty: "",
    evidence: [{ messageId: "m1", quote: "架空の相談です" }],
    edited: false,
    done: false,
    included: false,
  }));
  for (let i = 0; i < 3; i++) {
    const full = await POST(
      request({ ...valid, cards: fullCards }, "203.0.113.3"),
    );
    assert.equal(full.status, 400);
    const body = (await full.json()) as { error: string };
    assert.match(body.error, /24件/);
  }
  assert.equal((await POST(request(valid, "203.0.113.3"))).status, 503);
});
