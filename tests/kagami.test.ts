import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import config from "../next.config";
import {
  MAX_RECORDING_MS,
  addClip,
  clearClips,
  clipFileName,
  extensionOf,
  formatElapsed,
  formatSize,
  getClips,
  pickRecordingType,
  removeClip,
  subscribeClips,
} from "../lib/kagami";

test("1 本の上限は 2 分", () => {
  assert.equal(MAX_RECORDING_MS, 120_000);
});

test("録画の形式は、このブラウザで録れるものを上から選ぶ。音声が無いときは映像だけの形式", () => {
  // Chrome のように MP4 を録れるなら MP4（音声つき）
  const chrome = (t: string) => /^video\/(mp4|webm)/.test(t);
  assert.equal(pickRecordingType(chrome, true), "video/mp4;codecs=avc1.42E01E,mp4a.40.2");
  assert.equal(pickRecordingType(chrome, false), "video/mp4;codecs=avc1.42E01E");
  // H.264 を録れない Chromium は WebM
  const chromium = (t: string) => t.startsWith("video/webm");
  assert.equal(pickRecordingType(chromium, true), "video/webm;codecs=vp9,opus");
  assert.equal(pickRecordingType(chromium, false), "video/webm;codecs=vp9");
  // 形式の細かい指定を受け付けないときは、大まかな指定
  assert.equal(pickRecordingType((t) => t === "video/mp4", true), "video/mp4");
  assert.equal(pickRecordingType((t) => t === "video/webm", false), "video/webm");
  // 何も録れなければ MediaRecorder に任せる
  assert.equal(pickRecordingType(() => false, true), null);
  // 判定で例外が出ても止まらない
  assert.equal(
    pickRecordingType((t) => {
      if (t.startsWith("video/mp4")) throw new Error("x");
      return t === "video/webm";
    }, true),
    "video/webm",
  );
});

test("保存するときの名前と拡張子", () => {
  assert.equal(extensionOf("video/mp4;codecs=avc1.42E01E,mp4a.40.2"), "mp4");
  assert.equal(extensionOf("video/webm;codecs=vp9,opus"), "webm");
  assert.equal(extensionOf("video/quicktime"), "mov");
  assert.equal(extensionOf(""), "webm");
  assert.equal(clipFileName(new Date(2026, 10, 7, 8, 5, 9), "video/webm"), "kagami-20261107-080509.webm");
  assert.equal(clipFileName(new Date(2026, 0, 31, 23, 59, 0), "video/mp4"), "kagami-20260131-235900.mp4");
});

test("経過時間と大きさの書き方", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(999), "0:00");
  assert.equal(formatElapsed(65_000), "1:05");
  assert.equal(formatElapsed(MAX_RECORDING_MS), "2:00");
  assert.equal(formatElapsed(-5), "0:00");
  assert.equal(formatSize(10), "1 KB");
  assert.equal(formatSize(300 * 1024), "300 KB");
  assert.equal(formatSize(1.25 * 1024 * 1024), "1.3 MB");
});

test("撮ったものはこのタブのメモリにだけ置き、消すと URL も解放する", () => {
  const made: string[] = [];
  const revoked: string[] = [];
  const urls = {
    createObjectURL: () => {
      const url = `blob:test/${made.length + 1}`;
      made.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  };
  clearClips(urls);
  let changes = 0;
  const off = subscribeClips(() => changes++);
  const a = addClip(new Blob(["aa"], { type: "video/webm" }), { name: "a.webm", at: 1, durationMs: 1000, source: "camera" }, urls);
  const b = addClip(new Blob(["bbb"], { type: "video/mp4" }), { name: "b.mp4", at: 2, durationMs: null, source: "file" }, urls);
  // 新しいものを上に
  assert.deepEqual(getClips().map((c) => c.id), [b.id, a.id]);
  assert.equal(a.size, 2);
  assert.equal(b.type, "video/mp4");
  assert.equal(b.durationMs, null);
  assert.equal(changes, 2);
  removeClip(a.id, urls);
  assert.deepEqual(getClips().map((c) => c.id), [b.id]);
  assert.deepEqual(revoked, [a.url]);
  removeClip("無いもの", urls);
  assert.equal(changes, 3);
  off();
  clearClips(urls);
  assert.deepEqual(revoked, [a.url, b.url]);
  assert.equal(getClips().length, 0);
});

test("かがみはサーバーにもブラウザの保存領域にも書かない。合成・解析・AI の呼び出しをしない", () => {
  const files = [join(process.cwd(), "lib", "kagami.ts")];
  const dir = join(process.cwd(), "app", "kagami");
  for (const name of readdirSync(dir)) if (statSync(join(dir, name)).isFile()) files.push(join(dir, name));
  for (const file of files) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(code), `${file}: 保存`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|RTCPeerConnection/.test(code), `${file}: 通信`);
    assert.ok(!/\/api\/|anthropic|getContext\(|OffscreenCanvas|ImageCapture|<canvas/i.test(code), `${file}: 合成・解析`);
  }
});

test("本番の応答のヘッダーで、カメラとマイクはこのサイト自身にだけ許し、位置は禁じる。枠の中では使わせない", async () => {
  assert.ok(config.headers);
  const rules = await config.headers();
  const all = rules.find((rule) => rule.source === "/:path*");
  assert.ok(all);
  const header = (key: string) => all.headers.find((h) => h.key === key)?.value;
  assert.equal(header("Permissions-Policy"), "camera=(self), microphone=(self), geolocation=()");
  assert.equal(header("X-Frame-Options"), "DENY");
});
