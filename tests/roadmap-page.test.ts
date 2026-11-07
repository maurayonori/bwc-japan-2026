import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROADMAP_HTML_PATH, readRoadmapParts, splitRoadmapHtml } from "../lib/roadmap-page";

const html = readFileSync(ROADMAP_HTML_PATH, "utf8");

// CSS の規則の選択子を、@media の中も含めて取り出す（@keyframes の中は除く）。
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let depth = 0;
  let inKeyframes = -1;
  let buf = "";
  for (const ch of text) {
    if (ch === "{") {
      const head = buf.trim();
      if (head.startsWith("@keyframes")) inKeyframes = depth;
      else if (!head.startsWith("@") && inKeyframes < 0)
        out.push(...head.split(",").map((s) => s.trim()));
      depth++;
      buf = "";
    } else if (ch === "}") {
      depth--;
      if (depth === inKeyframes) inKeyframes = -1;
      buf = "";
    } else if (ch === ";" ) {
      buf = "";
    } else buf += ch;
  }
  return out;
}

test("年表の HTML を見た目・画面・動きの 3 つに分ける。中身は HTML のまま", () => {
  const parts = readRoadmapParts();
  assert.ok(parts.css.includes(".rmp"));
  assert.ok(parts.markup.startsWith('<div class="wrap rmp">'));
  assert.ok(parts.markup.includes('<script id="data" type="application/json">'));
  assert.ok(parts.markup.includes('<div id="main-view">'));
  assert.ok(parts.markup.includes('<section id="settings-view" hidden'));
  assert.ok(!parts.markup.includes('<script id="model">'));
  assert.ok(parts.code.includes("function startRoadmap()"));
  assert.ok(parts.code.includes("function planFamily("));
  // さきよみの中では自分で始めるので、単独のときだけすぐに始める
  assert.match(parts.code, /if \(!window\.SAKIYOMI_ROADMAP\) startRoadmap\(\);\s*$/);
  // 埋め込みデータは HTML と同じもの
  const data = (s: string) =>
    /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(s)?.[1];
  assert.equal(data(parts.markup), data(html));
  assert.throws(() => splitRoadmapHtml("<html><body></body></html>"));
});

test("メイン画面（年表と詳細）に入力欄を出さない。入力欄は設定画面だけ", () => {
  const { markup } = readRoadmapParts();
  const main = markup.slice(0, markup.indexOf('<section id="settings-view"'));
  assert.ok(!/<input|<select|<textarea/.test(main));
});

test("年表の CSS は .rmp の中に閉じ、ヘッダーとメニューに漏れない", () => {
  const { css } = readRoadmapParts();
  const all = selectors(css);
  assert.ok(all.length > 100);
  const allowed = [
    /^\.rmp(?=[\s.#:[]|$)/,
    /^:root\[data-theme="dark"\](?: \.rmp\b.*)?$/,
    /^:root:not\(\[data-theme="light"\]\)(?: \.rmp\b.*)?$/,
    /^html$/,
    /^body$/,
  ];
  // 暗い表示のときだけ、ヘッダーのメニューの白い地を暗くする
  const header = [
    ':root[data-theme="dark"] .view-nav a[aria-current="page"]',
    ':root[data-theme="dark"] .view-nav .count',
    ':root:not([data-theme="light"]) .view-nav a[aria-current="page"]',
    ':root:not([data-theme="light"]) .view-nav .count',
  ];
  const leaks = all.filter(
    (s) => !header.includes(s) && !allowed.some((re) => re.test(s)),
  );
  assert.deepEqual(leaks, []);
  // 明るい表示の :root を書き換えない（さきよみのトークンは globals.css だけが決める）
  assert.ok(!all.includes(":root"));
  // body に書くのは横のはみ出しを止めることだけ
  assert.match(css, /\nbody \{ overflow-x: hidden; \}\n/);
});

test("年表の色と文字は、さきよみのトークンから作る", () => {
  const { css } = readRoadmapParts();
  const globals = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  for (const token of ["--ink", "--muted", "--green", "--line", "--paper", "--bg", "--sage", "--amber", "--font"])
    assert.ok(globals.includes(`${token}:`), token);
  assert.match(css, /\.rmp \{[^}]*--text: var\(--ink\);[^}]*--accent: var\(--green\);[^}]*font-family: var\(--font\);/);
  // 年表だけの文字の指定（system-ui など）を残さない
  assert.ok(!/system-ui|Hiragino Sans"/.test(css));
  // 単独で開いたときも globals.css を読む
  const link = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1];
  assert.equal(link, "../../app/globals.css");
  assert.ok(existsSync(join(dirname(ROADMAP_HTML_PATH), link)));
});

test("年表は iframe を使わずページで出す。X-Frame-Options: DENY は残す", () => {
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  assert.match(config, /key: "X-Frame-Options", value: "DENY"/);
  for (const file of ["app/roadmap/page.tsx", "app/roadmap/roadmap-view.tsx"]) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    assert.ok(!/<iframe/i.test(source), file);
  }
  assert.ok(!/<iframe/i.test(html));
});
