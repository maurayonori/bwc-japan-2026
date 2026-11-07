import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteHeader } from "../app/site-header";
import { exampleWorkspace } from "../lib/example";
import {
  forgetKeptWorkspace,
  keepWorkspace,
  keptCounts,
  keptWorkspace,
} from "../lib/kept-workspace";
import { externalHref, menuItems, type MenuKey } from "../lib/menu";
import { emptyWorkspace } from "../lib/workspace";

const PERSONA = "http://127.0.0.1:4317/";
const ENV = "NEXT_PUBLIC_PERSONA_URL";

function render(current: MenuKey, persona?: string, counts?: { outlook: number; hand: number }) {
  const before = process.env[ENV];
  const kagamiBefore = process.env.NEXT_PUBLIC_KAGAMI_URL;
  if (persona === undefined) delete process.env[ENV];
  else process.env[ENV] = persona;
  // 前に使っていた NEXT_PUBLIC_KAGAMI_URL は、設定されていても読まない
  process.env.NEXT_PUBLIC_KAGAMI_URL = "https://kagami.example.com/";
  try {
    return renderToStaticMarkup(createElement(SiteHeader, { current, counts }));
  } finally {
    if (before === undefined) delete process.env[ENV];
    else process.env[ENV] = before;
    if (kagamiBefore === undefined) delete process.env.NEXT_PUBLIC_KAGAMI_URL;
    else process.env.NEXT_PUBLIC_KAGAMI_URL = kagamiBefore;
  }
}

const links = (html: string) =>
  [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    attrs: m[1],
    href: /href="([^"]*)"/.exec(m[1])?.[1],
    text: m[2].replace(/<[^>]+>/g, ""),
  }));

test("メニューの行き先は 話す・見通し・渡すもの・年表・あそぶ・かがみ。ペルソナは URL があるときだけ最後に", () => {
  assert.deepEqual(
    menuItems().map((item) => [item.key, item.label, item.href, item.external ?? false]),
    [
      ["talk", "話す", "/#talk", false],
      ["outlook", "見通し", "/#outlook", false],
      ["hand", "渡すもの", "/#hand", false],
      ["roadmap", "年表", "/roadmap", false],
      ["play", "あそぶ", "/play", false],
      ["kagami", "かがみ", "/kagami", false],
    ],
  );
  const withPersona = menuItems({ persona: PERSONA });
  assert.equal(withPersona.length, 7);
  assert.deepEqual(withPersona.at(-1), {
    key: "persona",
    label: "ペルソナ",
    href: PERSONA,
    group: "tools",
    external: true,
  });
});

test("外部リンクの URL は http と https だけを通す。空や読めない値では出さない", () => {
  assert.equal(externalHref(PERSONA), PERSONA);
  assert.equal(externalHref(" https://persona.example.com/ "), "https://persona.example.com/");
  for (const bad of [undefined, "", "  ", "javascript:alert(1)", "ftp://example.com/", "127.0.0.1:4317", "data:text/html,x"])
    assert.equal(externalHref(bad), null, String(bad));
  assert.equal(menuItems({ persona: "javascript:alert(1)" }).length, 6);
});

test("かがみはアプリの中のページ。NEXT_PUBLIC_KAGAMI_URL は読まない。ペルソナは URL があるときだけ外部リンク", () => {
  const without = render("talk");
  const kagami = links(without).find((link) => link.text === "かがみ");
  assert.ok(kagami);
  assert.equal(kagami.href, "/kagami");
  assert.ok(!kagami.attrs.includes("target="));
  assert.ok(!without.includes("kagami.example.com"));
  assert.ok(!without.includes("ペルソナ"));
  assert.ok(!without.includes('target="_blank"'));
  const withUrl = render("talk", PERSONA);
  const outside = links(withUrl).filter((link) => link.attrs.includes('target="_blank"'));
  assert.deepEqual(
    outside.map((link) => [link.text.replace(/↗|（別のタブで開く）/g, ""), link.href]),
    [["ペルソナ", PERSONA]],
  );
  assert.match(outside[0].attrs, /rel="noopener noreferrer"/);
  // 公開の配置のように値が空なら出さない
  assert.ok(!render("talk", "").includes("ペルソナ"));
  // かがみのページでは、かがみに印を付ける
  const here = links(render("kagami")).find((link) => link.href === "/kagami");
  assert.match(here?.attrs ?? "", /aria-current="page"/);
});

test("どのページでもメニューは 1 つ。同じ行き先へのリンクを二重に置かない", () => {
  for (const current of ["talk", "outlook", "hand", "roadmap", "play", "kagami"] as const) {
    const html = render(current, PERSONA, { outlook: 1, hand: 4 });
    assert.equal(html.match(/<nav /g)?.length, 1, current);
    assert.equal(html.match(/aria-label="メニュー"/g)?.length, 1, current);
    const nav = html.slice(html.indexOf("<nav "), html.indexOf("</nav>"));
    const hrefs = links(nav).map((link) => link.href);
    assert.equal(new Set(hrefs).size, hrefs.length, current);
    assert.equal(hrefs.length, 7, current);
    // 今いるところに印を付ける
    const marked = links(nav).filter((link) => link.attrs.includes('aria-current="page"'));
    assert.equal(marked.length, 1, current);
  }
});

test("主は 話す・見通し・渡すもの。年表・あそぶ・かがみ（とペルソナ）は区切りのあとの「家族の道具」にまとめる", () => {
  for (const persona of [undefined, PERSONA]) {
    const html = render("talk", persona);
    const nav = html.slice(html.indexOf("<nav "), html.indexOf("</nav>"));
    const at = nav.indexOf('<ul class="menu-tools" aria-label="家族の道具">');
    assert.ok(at > 0, "家族の道具のまとまりが無い");
    const main = links(nav.slice(0, at)).map((link) => link.href);
    const tools = links(nav.slice(at)).map((link) => link.href);
    assert.deepEqual(main, ["#talk", "#outlook", "#hand"]);
    assert.deepEqual(tools, ["/roadmap", "/play", "/kagami", ...(persona ? [PERSONA] : [])]);
    // 区切りは家族の道具の前に 1 つ
    assert.equal(nav.match(/class="tools-start"/g)?.length, 1);
  }
});

test("会話の画面の中は # だけで移り、ほかのページからは /#outlook で戻る", () => {
  const home = links(render("outlook", undefined, { outlook: 1, hand: 4 }));
  assert.deepEqual(
    home.map((link) => link.href),
    ["#talk", "#talk", "#outlook", "#hand", "/roadmap", "/play", "/kagami"],
  );
  assert.equal(home.find((link) => link.href === "#outlook")?.text, "見通し1");
  assert.equal(home.find((link) => link.href === "#hand")?.text, "渡すもの4");
  const roadmap = links(render("roadmap"));
  assert.deepEqual(
    roadmap.map((link) => link.href),
    ["/#talk", "/#talk", "/#outlook", "/#hand", "/roadmap", "/play", "/kagami"],
  );
  assert.match(roadmap.find((link) => link.href === "/roadmap")?.attrs ?? "", /aria-current="page"/);
});

test("会話の状態はメモリにだけ置く。ほかのページのメニューの件数もそこから出す", () => {
  forgetKeptWorkspace();
  assert.equal(keptWorkspace(), null);
  assert.equal(keptCounts(), null);
  const workspace = exampleWorkspace();
  keepWorkspace({ workspace: { ...workspace, mode: "live" }, draft: "下書き", remember: false, live: null });
  assert.equal(keptWorkspace()?.draft, "下書き");
  assert.deepEqual(keptCounts(), { outlook: 1, hand: 4 });
  // 移ってきたページのメニューに件数が出る
  const html = render("roadmap");
  assert.ok(html.includes("見通し<span class=\"count\">1</span>"));
  assert.ok(html.includes("渡すもの<span class=\"count\">4</span>"));
  keepWorkspace({ workspace: emptyWorkspace(), draft: "", remember: false, live: null });
  assert.deepEqual(keptCounts(), { outlook: 0, hand: 0 });
  forgetKeptWorkspace();
});
