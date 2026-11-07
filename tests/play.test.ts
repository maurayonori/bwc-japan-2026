import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { FRIENDS } from "../app/play/baa/animals";
import { Baa } from "../app/play/baa/baa";
import { PlayChooser } from "../app/play/chooser";
import { PlaySurface } from "../app/play/play-surface";
import { Pon } from "../app/play/pon/pon";
import { Shabon } from "../app/play/shabon/shabon";
import { HOLD_MS } from "../app/play/home-button";
import { NOTES, noteAt } from "../app/play/sound";

const PLAY = join(process.cwd(), "app", "play");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const sources = files(PLAY).map((path) => ({
  path: relative(process.cwd(), path),
  text: readFileSync(path, "utf8"),
}));
// コメントを除いたコード
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("あそぶは、3 つのあそびと選ぶ画面だけ", () => {
  const pages = sources.filter((s) => s.path.endsWith("page.tsx")).map((s) => s.path).sort();
  assert.deepEqual(pages, [
    "app/play/baa/page.tsx",
    "app/play/page.tsx",
    "app/play/pon/page.tsx",
    "app/play/shabon/page.tsx",
  ]);
});

test("保存・外への通信・外へのリンク・マイク・カメラ・外部の素材を使わない", () => {
  const banned: [string, RegExp][] = [
    ["保存", /localStorage|sessionStorage|indexedDB|document\.cookie|caches\./],
    ["通信", /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/],
    ["外へのリンク・素材", /https?:\/\/|<img|<iframe|<audio|<video|url\(/],
    ["マイク・カメラ", /getUserMedia|mediaDevices/],
    ["Claude API", /\/api\/|anthropic/i],
    ["メニュー", /SiteHeader/],
  ];
  for (const { path, text } of sources)
    for (const [rule, re] of banned) assert.ok(!re.test(code(text)), `${path}: ${rule}`);
});

test("絵文字を使わない。絵はインライン SVG と CSS", () => {
  const emoji = /\p{Extended_Pictographic}/u;
  for (const { path, text } of sources) assert.ok(!emoji.test(code(text)), path);
});

test("得点・時間制限・失敗の言葉や仕組みを持たない", () => {
  for (const { path, text } of sources)
    assert.ok(!/score|timer.*limit|timeLimit|gameOver|失敗|得点|制限時間/i.test(code(text)), path);
});

// 描いた HTML から、タグと属性を除いて残る文字（画面に見える文字）を取り出す。
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (m) => (m === "&nbsp;" ? " " : "x"))
    .trim();
}

const fakeRouter = {
  push() {},
  replace() {},
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
};

function renderPlay(component: ComponentType) {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: fakeRouter as never },
      createElement(PlaySurface, null, createElement(component)),
    ),
  );
}

test("画面に見える文字は 0。名前は aria-label にだけ置く", () => {
  for (const [name, component] of [
    ["選ぶ画面", PlayChooser],
    ["ぽん", Pon],
    ["ばあ", Baa],
    ["しゃぼん玉", Shabon],
  ] as const) {
    const html = renderPlay(component);
    assert.ok(html.length > 200, name);
    assert.equal(visibleText(html), "", name);
    // ツールチップとして見えてしまう title 属性・SVG の <title>・画像の代わりの文字を使わない
    assert.ok(!/\stitle=|<title>|<img|alt=/.test(html), name);
    assert.match(html, /aria-label="/, name);
  }
  // 確かめ方そのものが文字を見落とさないこと
  assert.equal(visibleText("<p aria-label=\"x\">ぽん</p>"), "ぽん");
  assert.equal(visibleText("<span>&nbsp;</span>"), "");
});

test("家の絵は約 1.5 秒押し続けると戻る", () => {
  assert.equal(HOLD_MS, 1500);
  const home = sources.find((s) => s.path === "app/play/home-button.tsx")?.text ?? "";
  // 2 本以上の指（手のひら）では数え直す。家の外に触れている指も数える（画面全体で数える、#64）
  assert.match(home, /pointers\.current\.size > 1 \|\| elsewhere\) stop\(\)/);
  assert.match(home, /document\.addEventListener\("pointerdown", down, true\)/);
  // 外で離しても離したことが届くよう、押したときに捕まえる（#64）
  assert.match(home, /setPointerCapture\(e\.pointerId\)/);
});

test("ばあの中身は配列で差し替えられる", () => {
  assert.ok(FRIENDS.length >= 3);
  assert.equal(new Set(FRIENDS.map((f) => f.id)).size, FRIENDS.length);
  for (const friend of FRIENDS) {
    assert.ok(friend.name);
    assert.equal(typeof friend.Picture, "function");
    assert.ok(friend.voice.length > 0);
    for (const tone of friend.voice) assert.ok(tone.freq > 100 && tone.freq < 2000);
  }
  const baa = sources.find((s) => s.path === "app/play/baa/baa.tsx")?.text ?? "";
  assert.match(baa, /export function Baa\(\{ friends = FRIENDS \}/);
});

test("音は低めのペンタトニックから選ぶ。位置から高さを決める", () => {
  assert.equal(noteAt(0), NOTES[0]);
  assert.equal(noteAt(0.999), NOTES.at(-1));
  assert.equal(noteAt(-1), NOTES[0]);
  assert.equal(noteAt(2), NOTES.at(-1));
  for (const n of NOTES) assert.ok(n >= 200 && n <= 1000);
});

test("触れる的は 96px 以上。触れ方と拡大を止める", () => {
  const css = sources.find((s) => s.path === "app/play/play.css")?.text ?? "";
  assert.match(css, /\.play-root \.play-home \{[^}]*width: 96px;[^}]*height: 96px;/);
  assert.match(css, /\.play-choice \{[^}]*min-width: 96px;[^}]*min-height: 96px;/);
  assert.match(css, /\.play-root \{[^}]*touch-action: none;[^}]*user-select: none;[^}]*-webkit-touch-callout: none;/);
  const shabon = sources.find((s) => s.path === "app/play/shabon/shabon.tsx")?.text ?? "";
  assert.ok(Number(/const MIN_SIZE = (\d+)/.exec(shabon)?.[1]) >= 96);
  const layout = sources.find((s) => s.path === "app/play/layout.tsx")?.text ?? "";
  assert.match(layout, /userScalable: false/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
