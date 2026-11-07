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
import { menuItems, personaHref, type MenuKey } from "../lib/menu";
import { emptyWorkspace } from "../lib/workspace";

const PERSONA = "http://127.0.0.1:4317/";

function render(current: MenuKey, persona?: string, counts?: { outlook: number; hand: number }) {
  const before = process.env.NEXT_PUBLIC_PERSONA_URL;
  if (persona === undefined) delete process.env.NEXT_PUBLIC_PERSONA_URL;
  else process.env.NEXT_PUBLIC_PERSONA_URL = persona;
  try {
    return renderToStaticMarkup(createElement(SiteHeader, { current, counts }));
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_PERSONA_URL;
    else process.env.NEXT_PUBLIC_PERSONA_URL = before;
  }
}

const links = (html: string) =>
  [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    attrs: m[1],
    href: /href="([^"]*)"/.exec(m[1])?.[1],
    text: m[2].replace(/<[^>]+>/g, ""),
  }));

test("メニューの行き先は 話す・見通し・渡すもの・年表・あそぶ。ペルソナは URL があるときだけ", () => {
  assert.deepEqual(
    menuItems(undefined).map((item) => [item.key, item.label, item.href]),
    [
      ["talk", "話す", "/#talk"],
      ["outlook", "見通し", "/#outlook"],
      ["hand", "渡すもの", "/#hand"],
      ["roadmap", "年表", "/roadmap"],
      ["play", "あそぶ", "/play"],
    ],
  );
  const withPersona = menuItems(PERSONA);
  assert.equal(withPersona.length, 6);
  assert.deepEqual(withPersona.at(-1), {
    key: "persona",
    label: "ペルソナ",
    href: PERSONA,
    group: "tools",
    external: true,
  });
});

test("ペルソナの URL は http と https だけを通す。空や読めない値では出さない", () => {
  assert.equal(personaHref(PERSONA), PERSONA);
  assert.equal(personaHref(" https://persona.example/ "), "https://persona.example/");
  for (const bad of [undefined, "", "  ", "javascript:alert(1)", "ftp://example.com/", "127.0.0.1:4317", "data:text/html,x"])
    assert.equal(personaHref(bad), null, String(bad));
  assert.equal(menuItems("javascript:alert(1)").length, 5);
});

test("NEXT_PUBLIC_PERSONA_URL があればメニューにペルソナが出て、無ければ出ない", () => {
  const without = render("talk");
  assert.ok(!without.includes("ペルソナ"));
  assert.ok(!without.includes("4317"));
  const withUrl = render("talk", PERSONA);
  const persona = links(withUrl).find((link) => link.text.startsWith("ペルソナ"));
  assert.ok(persona);
  assert.equal(persona.href, PERSONA);
  assert.match(persona.attrs, /target="_blank"/);
  assert.match(persona.attrs, /rel="noopener noreferrer"/);
  // 公開の配置のように値が空なら出さない
  assert.ok(!render("talk", "").includes("ペルソナ"));
});

test("どのページでもメニューは 1 つ。同じ行き先へのリンクを二重に置かない", () => {
  for (const current of ["talk", "outlook", "hand", "roadmap", "play"] as const) {
    const html = render(current, PERSONA, { outlook: 1, hand: 4 });
    assert.equal(html.match(/<nav /g)?.length, 1, current);
    assert.equal(html.match(/aria-label="メニュー"/g)?.length, 1, current);
    const nav = html.slice(html.indexOf("<nav "), html.indexOf("</nav>"));
    const hrefs = links(nav).map((link) => link.href);
    assert.equal(new Set(hrefs).size, hrefs.length, current);
    assert.equal(hrefs.length, 6, current);
    // 今いるところに印を付ける
    const marked = links(nav).filter((link) => link.attrs.includes('aria-current="page"'));
    assert.equal(marked.length, 1, current);
  }
});

test("会話の画面の中は # だけで移り、ほかのページからは /#outlook で戻る", () => {
  const home = links(render("outlook", undefined, { outlook: 1, hand: 4 }));
  assert.deepEqual(
    home.map((link) => link.href),
    ["#talk", "#talk", "#outlook", "#hand", "/roadmap", "/play"],
  );
  assert.equal(home.find((link) => link.href === "#outlook")?.text, "見通し1");
  assert.equal(home.find((link) => link.href === "#hand")?.text, "渡すもの4");
  const roadmap = links(render("roadmap"));
  assert.deepEqual(
    roadmap.map((link) => link.href),
    ["/#talk", "/#talk", "/#outlook", "/#hand", "/roadmap", "/play"],
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
