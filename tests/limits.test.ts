import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  clientKeyFrom,
  createDailyLimiter,
  jstDayNumber,
  limitConfigFromEnv,
  limitMessage,
} from "../lib/limits";

const NOON_JST = Date.UTC(2026, 10, 8, 3, 0, 0);
const config = { perClientPerDay: 2, globalPerDay: 3, maxClients: 2 };

test("端末ごとの上限を超えると断り、数えない", () => {
  const limiter = createDailyLimiter(config);
  assert.deepEqual(limiter.take("a", NOON_JST), {
    ok: true,
    clientRemaining: 1,
    globalRemaining: 2,
  });
  assert.equal(limiter.take("a", NOON_JST).ok, true);
  assert.deepEqual(limiter.take("a", NOON_JST), {
    ok: false,
    reason: "client",
  });
  // 断った分は全体の回数に入らないので、別の端末は使える。
  assert.equal(limiter.take("b", NOON_JST).ok, true);
});

test("全体の上限に達すると、まだ使っていない端末も断る", () => {
  const limiter = createDailyLimiter({ ...config, maxClients: 10 });
  limiter.take("a", NOON_JST);
  limiter.take("a", NOON_JST);
  limiter.take("b", NOON_JST);
  assert.deepEqual(limiter.take("c", NOON_JST), {
    ok: false,
    reason: "global",
  });
});

test("追跡する端末の数を超えて増やさない。すでに数えている端末は使える", () => {
  const limiter = createDailyLimiter({ ...config, globalPerDay: 100 });
  limiter.take("a", NOON_JST);
  limiter.take("b", NOON_JST);
  assert.deepEqual(limiter.take("c", NOON_JST), {
    ok: false,
    reason: "capacity",
  });
  assert.equal(limiter.take("a", NOON_JST).ok, true);
});

test("日本時間の 0 時で数え直す", () => {
  const limiter = createDailyLimiter({ ...config, perClientPerDay: 1 });
  const beforeMidnight = Date.UTC(2026, 10, 8, 14, 59, 59);
  const afterMidnight = Date.UTC(2026, 10, 8, 15, 0, 0);
  assert.equal(limiter.take("a", beforeMidnight).ok, true);
  assert.equal(limiter.take("a", beforeMidnight).ok, false);
  assert.equal(limiter.take("a", afterMidnight).ok, true);
  assert.equal(jstDayNumber(afterMidnight) - jstDayNumber(beforeMidnight), 1);
});

test("環境変数で上限を変えられ、不正な値は既定に戻す", () => {
  assert.equal(
    limitConfigFromEnv({ LIMIT_PER_CLIENT_PER_DAY: "5" }).perClientPerDay,
    5,
  );
  for (const value of ["0", "-1", "abc", "1.5", ""]) {
    assert.equal(
      limitConfigFromEnv({ LIMIT_GLOBAL_PER_DAY: value }).globalPerDay,
      150,
    );
  }
});

test("接続元をそのまま鍵にせず、偽装しやすい先頭の値に頼らない", () => {
  const key = clientKeyFrom(
    new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }),
  );
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key.includes("203.0.113.9"), false);
  // 先頭を変えても同じ端末として数える。
  assert.equal(
    clientKeyFrom(new Headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" })),
    key,
  );
  // Vercel が設定する接続元を優先する。
  assert.equal(
    clientKeyFrom(new Headers({ "x-vercel-forwarded-for": "203.0.113.9" })),
    key,
  );
  assert.notEqual(clientKeyFrom(new Headers()), key);
});

test("IPv6 は /64 を 1 つの接続元として数える", () => {
  const key = (address: string) =>
    clientKeyFrom(new Headers({ "x-vercel-forwarded-for": address }));
  const same = key("2001:db8:1:2::1");
  // 同じ /64 の中で下位を変えても、書き方を変えても、同じ接続元。
  assert.equal(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), same);
  assert.equal(key("2001:0DB8:0001:0002:0:0:0:9"), same);
  // /64 が違えば別の接続元。
  assert.notEqual(key("2001:db8:1:3::1"), same);
  // IPv4 は、そのままの形でも IPv6 に写した形でも 1 つのアドレスとして数える。
  assert.equal(key("::ffff:203.0.113.9"), key("203.0.113.9"));
  assert.notEqual(key("::ffff:203.0.113.9"), key("::ffff:203.0.113.10"));
});

test("上限の案内は、入力が残ることと体験例を試せることを伝える", () => {
  for (const reason of ["client", "global", "capacity"] as const) {
    assert.match(limitMessage(reason), /入力とメモは残っています/);
    assert.match(limitMessage(reason), /架空の体験例/);
  }
});
