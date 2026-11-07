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
// かがみの URL は検査用の架空の値（example.com はドキュメント用に予約された名前）
const KAGAMI = "https://kagami.example.com/";

type Links = { persona?: string; kagami?: string };
const ENV = { persona: "NEXT_PUBLIC_PERSONA_URL", kagami: "NEXT_PUBLIC_KAGAMI_URL" } as const;

function render(current: MenuKey, urls: Links = {}, counts?: { outlook: number; hand: number }) {
  const before = { persona: process.env[ENV.persona], kagami: process.env[ENV.kagami] };
  for (const key of ["persona", "kagami"] as const) {
    if (urls[key] === undefined) delete process.env[ENV[key]];
    else process.env[ENV[key]] = urls[key];
  }
  try {
    return renderToStaticMarkup(createElement(SiteHeader, { current, counts }));
  } finally {
    for (const key of ["persona", "kagami"] as const) {
      if (before[key] === undefined) delete process.env[ENV[key]];
      else process.env[ENV[key]] = before[key];
    }
  }
}

const links = (html: string) =>
  [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    attrs: m[1],
    href: /href="([^"]*)"/.exec(m[1])?.[1],
    text: m[2].replace(/<[^>]+>/g, ""),
  }));

test("メニューの行き先は 話す・見通し・渡すもの・年表・あそぶ。ペルソナとかがみは URL があるときだけ、この順で", () => {
  assert.deepEqual(
    menuItems().map((item) => [item.key, item.label, item.href]),
    [
      ["talk", "話す", "/#talk"],
      ["outlook", "見通し", "/#outlook"],
      ["hand", "渡すもの", "/#hand"],
      ["roadmap", "年表", "/roadmap"],
      ["play", "あそぶ", "/play"],
    ],
  );
  const both = menuItems({ kagami: KAGAMI, persona: PERSONA });
  assert.equal(both.length, 7);
  assert.deepEqual(both.slice(-2), [
    { key: "persona", label: "ペルソナ", href: PERSONA, group: "tools", external: true },
    { key: "kagami", label: "かがみ", href: KAGAMI, group: "tools", external: true },
  ]);
  assert.deepEqual(menuItems({ persona: PERSONA }).map((item) => item.key).slice(-1), ["persona"]);
  assert.deepEqual(menuItems({ kagami: KAGAMI }).map((item) => item.key).slice(-2), ["play", "kagami"]);
});

test("外部リンクの URL は http と https だけを通す。空や読めない値では出さない", () => {
  assert.equal(externalHref(PERSONA), PERSONA);
  assert.equal(externalHref(" https://kagami.example.com/ "), KAGAMI);
  for (const bad of [undefined, "", "  ", "javascript:alert(1)", "ftp://example.com/", "127.0.0.1:4317", "data:text/html,x"])
    assert.equal(externalHref(bad), null, String(bad));
  assert.equal(menuItems({ persona: "javascript:alert(1)", kagami: "javascript:alert(1)" }).length, 5);
});

test("NEXT_PUBLIC_PERSONA_URL と NEXT_PUBLIC_KAGAMI_URL があればメニューに出て、無ければ出ない", () => {
  const without = render("talk");
  for (const word of ["ペルソナ", "かがみ", "4317", "kagami"]) assert.ok(!without.includes(word), word);
  const withUrls = render("talk", { persona: PERSONA, kagami: KAGAMI });
  const outside = links(withUrls).filter((link) => link.attrs.includes('target="_blank"'));
  assert.deepEqual(
    outside.map((link) => [link.text.replace(/↗|（別のタブで開く）/g, ""), link.href]),
    [
      ["ペルソナ", PERSONA],
      ["かがみ", KAGAMI],
    ],
  );
  for (const link of outside) assert.match(link.attrs, /rel="noopener noreferrer"/);
  // 片方だけ
  assert.ok(render("talk", { kagami: KAGAMI }).includes("かがみ"));
  assert.ok(!render("talk", { kagami: KAGAMI }).includes("ペルソナ"));
  // 公開の配置のように値が空なら出さない
  const empty = render("talk", { persona: "", kagami: "" });
  assert.ok(!empty.includes("ペルソナ") && !empty.includes("かがみ"));
});

test("どのページでもメニューは 1 つ。同じ行き先へのリンクを二重に置かない", () => {
  for (const current of ["talk", "outlook", "hand", "roadmap", "play"] as const) {
    const html = render(current, { persona: PERSONA, kagami: KAGAMI }, { outlook: 1, hand: 4 });
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

test("会話の画面の中は # だけで移り、ほかのページからは /#outlook で戻る", () => {
  const home = links(render("outlook", {}, { outlook: 1, hand: 4 }));
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
