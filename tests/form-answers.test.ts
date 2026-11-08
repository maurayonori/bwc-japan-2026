import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 提出フォームの下書き（docs/submission/form.md）が、告知された 11 問の形に合っていることを確かめる（#92）。
// 送信後は直せないので、字数・冒頭の形・動画の URL の食い違いを送る前に落とす。
// 11/8 17:36 に開いた提出ページに合わせ、チーム名を足し、8 は写さない印を付け、11 は 150 字に収めた（#7）。

const ROOT = join(__dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const FORM = read("docs/submission/form.md");
const README = read("README.md");
// フォームの上限は 500 字。改行を 2 字と数えるフォームでも収まるようにする。
const MAX_OVERVIEW = 500;
const AUTHOR_SENTENCE = "作者自身が入院の準備で";

// 「## n. 」の見出しから次の「## 」までを返す。
function sectionOf(form: string, number: number): string {
  const start = form.indexOf(`\n## ${number}. `);
  assert.ok(start >= 0, `設問 ${number} の見出しが無い`);
  const next = form.indexOf("\n## ", start + 1);
  return form.slice(start, next < 0 ? undefined : next);
}

// 設問の中の最初の ```text の枠の中を返す。写すのはこの中だけ。
function answerOf(form: string, number: number): string {
  const section = sectionOf(form, number);
  const open = section.indexOf("```text\n");
  const close = section.indexOf("\n```", open + 1);
  assert.ok(open >= 0 && close > open, `設問 ${number} の枠が無い`);
  return section.slice(open + "```text\n".length, close);
}

const countOf = (text: string): number => [...text].length;

test("設問の見出しは 1 から 11 まで、この順に並ぶ", () => {
  const numbers = [...FORM.matchAll(/^## (\d+)\. /gm)].map((match) =>
    Number(match[1]),
  );
  assert.deepEqual(
    numbers,
    Array.from({ length: 11 }, (_, index) => index + 1),
  );
});

test("設問 3 の概要は指定の 1 文で始まり、改行を 2 字と数えても 500 字以内で、書いてある字数と一致する", () => {
  const overview = answerOf(FORM, 3);
  const [first] = overview.split("\n");
  // 「このプロジェクトは、〔誰〕の〔課題〕を〔どう変える〕〔形〕です。」
  assert.match(
    first,
    /^このプロジェクトは、[^。]+の[^。]+を、[^。]+変える[^。]+です。$/,
  );
  const breaks = overview.split("\n").length - 1;
  assert.ok(
    countOf(overview) + breaks <= MAX_OVERVIEW,
    `${countOf(overview)} 字・改行 ${breaks} つ`,
  );
  assert.ok(
    sectionOf(FORM, 3).includes(
      `${countOf(overview)} 字（改行 ${breaks} つを含む`,
    ),
    `書いてある字数が実際の ${countOf(overview)} 字・改行 ${breaks} つと違う`,
  );
});

test("設問 3 の円の額は、計算関数と照らしている README の額だけ", () => {
  const amounts = [
    ...answerOf(FORM, 3).matchAll(/(\d{1,3}(?:,\d{3})+)円/g),
  ].map((match) => match[1]);
  assert.ok(amounts.length > 0);
  for (const amount of amounts)
    assert.ok(README.includes(`${amount} 円`), `${amount} 円が README に無い`);
});

test("作者の体験の一文は設問 3 にだけ置き、README には置かない", () => {
  assert.ok(answerOf(FORM, 3).includes(AUTHOR_SENTENCE));
  assert.ok(!README.includes(AUTHOR_SENTENCE));
});

test("設問 5 は URL の行が 1 つで、README のデモ動画のリンクと同じ", () => {
  const urls = sectionOf(FORM, 5)
    .split("\n")
    .filter((line) => /^https:\/\/\S+$/.test(line));
  assert.equal(urls.length, 1, urls.join(", "));
  const readmeLine = README.split("\n").find((line) =>
    line.startsWith("デモ動画: "),
  );
  assert.ok(readmeLine, "README にデモ動画の行が無い");
  assert.ok(readmeLine.includes(urls[0]), readmeLine);
});

// 写すためのページ（public/submission-form.html）の初期値が form.md と同じであることを確かめる（#4、#7）。
// ページから写した答えが form.md と違うまま送られるのを防ぐ。
const PAGE = read("public/submission-form.html");

// DEFAULTS の「key: "値"」を返す。
function pageDefault(key: string): string {
  const match = PAGE.match(new RegExp(`\\n\\s+${key}: "([^"\\n]*)",`));
  assert.ok(match, `ページの初期値に ${key} が無い`);
  return match[1];
}

// チーム名は屋号なので、値をリポジトリに置かない。作者が提出ページで入れる（告知の 11 問には無く、番号を付けない）。
test("チーム名は form.md で 1 より前に節があり、ページの初期値は空", () => {
  const start = FORM.indexOf("\n## チーム名（必須）\n");
  assert.ok(start >= 0, "チーム名の見出しが無い");
  assert.ok(start < FORM.indexOf("\n## 1. "), "チーム名は 1 より前に置く");
  assert.equal(pageDefault("team_name"), "");
});

test("設問 3・7・10・11 の写す本文が、ページにそのまま入っている", () => {
  for (const number of [3, 7, 10, 11]) {
    const answer = answerOf(FORM, number);
    assert.ok(
      !/`|\$\{/.test(answer),
      `設問 ${number} にバッククォートか \${ がある`,
    );
    assert.ok(
      PAGE.includes(`\`${answer}\``),
      `設問 ${number} の本文がページと違う`,
    );
  }
});

test("ページの概要は、冒頭と続きを改行 1 つでつないで設問 3 と同じになる", () => {
  assert.ok(PAGE.includes(`const OVERVIEW = \`${answerOf(FORM, 3)}\`;`));
  assert.ok(PAGE.includes('return lead + "\\n" + body;'));
});

test("ページの buildStuckMeta が初期値から組み立てる本文は、form.md の 8 の枠と同じ", () => {
  const source = PAGE.match(/function buildStuckMeta\(\) \{[\s\S]*?\n    \}/);
  assert.ok(source, "ページに buildStuckMeta が無い");
  const fields: Record<string, { value: string }> = {
    "#stuck_product": { value: pageDefault("stuck_product") },
    "#stuck_env": { value: pageDefault("stuck_env") },
    "#stuck_cause": { value: pageDefault("stuck_cause") },
  };
  const build = new Function("$", `${source[0]}\nreturn buildStuckMeta();`);
  assert.equal(
    build((selector: string) => fields[selector]),
    answerOf(FORM, 8),
  );
});

// <select> の素の selected（スクリプトが動く前の値）を返す。無ければ最初の選択肢。
function selectedOf(id: string): string {
  const select = PAGE.match(
    new RegExp(`<select[^>]* id="${id}">([\\s\\S]*?)</select>`),
  );
  assert.ok(select, `ページに ${id} の選択欄が無い`);
  const options = [
    ...select[1].matchAll(/<option value="([^"]*)"( selected)?>/g),
  ];
  const selected = options.filter((option) => option[2]);
  assert.ok(selected.length <= 1, `${id} の selected が 2 つ以上ある`);
  return (selected[0] ?? options[0])[1];
}

test("ページの選択欄の素の selected は、初期値と同じ", () => {
  for (const id of ["theme", "stuck_product", "stuck_cause", "docs_found"])
    assert.equal(selectedOf(id), pageDefault(id), id);
});

test("設問 7 と 8 の下に置く写す枠は 1 つだけで、選ばなかった候補は 11 と送信前の確認より後ろの付録にある", () => {
  for (const number of [7, 8])
    assert.equal(
      sectionOf(FORM, number).split("```text\n").length - 1,
      1,
      `設問 ${number}`,
    );
  const appendix = FORM.indexOf(
    "\n## 付録: 7 に選ばなかった候補（写さない）\n",
  );
  assert.ok(appendix > FORM.indexOf("\n## 送信前の確認\n"));
  assert.ok(FORM.indexOf("\n## 送信前の確認\n") > FORM.indexOf("\n## 11. "));
});

test("ページの設問 6・9・5 の初期値は form.md と同じ", () => {
  const listed = [
    ...sectionOf(FORM, 6).matchAll(/^- \[x\] ([^（\n]+)（/gm),
  ].map((match) => match[1]);
  assert.equal(listed.length, 4, listed.join(", "));
  const products = PAGE.match(/claude_products: (\[[^\]\n]*\]),/);
  assert.ok(products, "ページの初期値に claude_products が無い");
  assert.deepEqual(JSON.parse(products[1]), listed);
  for (const name of listed)
    assert.ok(PAGE.includes(`value="${name}"`), `${name} の選択肢が無い`);
  assert.equal(pageDefault("claude_other"), answerOf(FORM, 6));

  assert.equal(answerOf(FORM, 9), "はい");
  assert.equal(pageDefault("docs_found"), "はい");
  assert.equal(pageDefault("docs_comment"), "");

  const url = sectionOf(FORM, 5)
    .split("\n")
    .find((line) => /^https:\/\/\S+$/.test(line));
  assert.equal(pageDefault("demo_video"), url);
});

test("ページのプロジェクト名は form.md の 1 と同じ", () => {
  const name = sectionOf(FORM, 1)
    .split("\n")
    .slice(2)
    .find((line) => line.trim() !== "");
  assert.equal(pageDefault("project_name"), name);
});

test("ページは前の版の下書きのキーを消さずに読み、新しい版のキーに保存する", () => {
  assert.ok(
    PAGE.includes('const STORAGE_KEY = "sakiyomi-bwc2026-submission-form-v3";'),
  );
  assert.ok(!/(?:removeItem|setItem)\((?!STORAGE_KEY\b)/.test(PAGE));
  // 前の版の v2 と無印が両方残っていれば、両方を新しい順に読み、どちらも見せる（壊れた値は飛ばす）。
  const keys = PAGE.match(/const OLD_STORAGE_KEYS = \[[\s\S]*?\n    \];/);
  assert.ok(keys, "ページに OLD_STORAGE_KEYS が無い");
  const stored: Record<string, string> = {
    "sakiyomi-bwc2026-submission-form-v2": JSON.stringify({ reviewer: "v2 の文" }),
    "sakiyomi-bwc2026-submission-form": JSON.stringify({ reviewer: "無印の文" }),
  };
  const localStorage = { getItem: (key: string) => stored[key] ?? null };
  const load = new Function("localStorage", `${keys[0]}\n${pageFunction("loadOldDrafts")}\nreturn loadOldDrafts();`);
  assert.deepEqual(
    load(localStorage).map((draft: { data: { reviewer: string } }) => draft.data.reviewer),
    ["v2 の文", "無印の文"],
  );
  stored["sakiyomi-bwc2026-submission-form-v2"] = "{壊れた値";
  assert.deepEqual(
    load(localStorage).map((draft: { data: { reviewer: string } }) => draft.data.reviewer),
    ["無印の文"],
  );
  assert.ok(PAGE.includes("for (const old of loadOldDrafts()) renderOldDraft(old.data, old.name);"));
  // 前の下書きで「その他」の文だけ直した場合も見えるようにする。
  assert.ok(PAGE.includes('["claude_other", '));
});

test("設問 8 の環境と設問 10 の止まった時刻（11/7 と 11/8 の区間）は同じ", () => {
  const span = (text: string, day: string): string => {
    const match = text.match(new RegExp(`${day} (\\d{1,2}:\\d{2}〜\\d{1,2}:\\d{2})`));
    assert.ok(match, `${day} の区間が無い`);
    return match[1];
  };
  for (const day of ["11/7", "11/8"])
    assert.equal(span(answerOf(FORM, 8), day), span(answerOf(FORM, 10), day), day);
});

test("設問 2 の表示文と設問 4 の URL は、form.md とページの初期値で同じ", () => {
  const firstLine = (number: number): string | undefined =>
    sectionOf(FORM, number)
      .split("\n")
      .slice(2)
      .find((line) => line.trim() !== "");
  const theme = PAGE.match(
    new RegExp(`<option value="${pageDefault("theme")}"(?: selected)?>([^<]*)</option>`),
  );
  assert.ok(theme, "ページの初期値のテーマの選択肢が無い");
  assert.equal(theme[1], firstLine(2));
  assert.equal(pageDefault("github"), firstLine(4));
});

test("設問 11 の回数の上限は、docs/deployment.md の接続元ごとの 1 日の回数と同じ", () => {
  const deployment = read("docs/deployment.md").match(
    /接続元（回線）ごとに 1 日 (\d+) 回、全体で 1 日 (\d+) 回、IP ごとに 1 時間 (\d+) 回/,
  );
  assert.ok(deployment, "docs/deployment.md に回数の上限の文が無い");
  // 11 は 150 字に収めるため、接続元ごとの 1 日の回数だけを書く（作者が 11/8 17:42 に決めた）。
  const answer = answerOf(FORM, 11).match(/接続元（回線）ごとに 1 日 (\d+) 回/);
  assert.ok(answer, "設問 11 に回数の上限の文が無い");
  assert.equal(answer[1], deployment[1]);
});

test("設問 11 は提出ページの上限の 150 字以内で、1 行にする", () => {
  const answer = answerOf(FORM, 11);
  assert.ok(countOf(answer) <= 150, `${countOf(answer)} 字`);
  assert.ok(!answer.includes("\n"));
});

test("設問 8 は提出ページに欄が無いので、見出しとページの欄に写さない印があり、全文コピーに入れない", () => {
  assert.ok(sectionOf(FORM, 8).split("\n")[1].includes("写さない"));
  assert.ok(
    PAGE.includes(
      "<legend>その問題が起きた製品・環境・原因（提出ページに欄が無いので写さない）</legend>",
    ),
  );
  assert.ok(!pageFunction("buildAllText").includes("stuck_meta"));
});

// ページのソースから、名前の付いた関数（4 字下げの閉じ括弧まで）を取り出す。
function pageFunction(name: string): string {
  const source = PAGE.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`));
  assert.ok(source, `ページに ${name} が無い`);
  return source[0];
}

test("ページの init は、今の版の保存か初期値だけを欄に入れ、前の下書きは読むだけの形でしか出さない", () => {
  const init = pageFunction("init");
  assert.equal((init.match(/localStorage\.getItem\(/g) ?? []).length, 1);
  assert.ok(init.includes("localStorage.getItem(STORAGE_KEY)"));
  assert.ok(init.includes("applyState(saved || DEFAULTS);"));
  assert.ok(init.includes("for (const old of loadOldDrafts()) renderOldDraft(old.data, old.name);"));
  const render = pageFunction("renderOldDraft");
  assert.ok(!render.includes("applyState"));
  assert.ok(render.includes("body.readOnly = true;"));
});

test("保存の無いときの全文コピーは、【…】ごとに form.md の写す枠（6 と 9 は初期値）と同じ", () => {
  const overview = PAGE.match(/const OVERVIEW = `[\s\S]*?`;/);
  const defaults = PAGE.match(/const DEFAULTS = \{[\s\S]*?\n    \};/);
  assert.ok(overview && defaults, "ページに OVERVIEW か DEFAULTS が無い");
  const DEFAULTS = new Function(`${overview[0]}\n${defaults[0]}\nreturn DEFAULTS;`)();
  const fields: Record<string, { value: string }> = {
    "#stuck_product": { value: DEFAULTS.stuck_product },
    "#stuck_env": { value: DEFAULTS.stuck_env },
    "#stuck_cause": { value: DEFAULTS.stuck_cause },
  };
  const joinOverview = new Function(`${pageFunction("joinOverview")}\nreturn joinOverview;`)();
  const buildStuckMeta = new Function("$", `${pageFunction("buildStuckMeta")}\nreturn buildStuckMeta;`)(
    (selector: string) => fields[selector],
  );
  const buildAllText = new Function(`${pageFunction("buildAllText")}\nreturn buildAllText;`)();
  // applyState(DEFAULTS) と同じ: 概要全文は冒頭と続きをつなぎ、8 の本文は buildStuckMeta で組む。
  const state = {
    ...DEFAULTS,
    overview_full: joinOverview(DEFAULTS.overview_lead, DEFAULTS.overview_body),
    stuck_meta: buildStuckMeta(),
  };
  const theme = PAGE.match(new RegExp(`<option value="${DEFAULTS.theme}"(?: selected)?>([^<]*)</option>`));
  assert.ok(theme);
  const text: string = buildAllText(state, theme[1]);

  const firstLine = (number: number): string | undefined =>
    sectionOf(FORM, number)
      .split("\n")
      .slice(2)
      .find((line) => line.trim() !== "");
  const expected: [string, string | undefined][] = [
    ["チーム名", ""],
    ["プロジェクト名", firstLine(1)],
    ["テーマ", firstLine(2)],
    ["概要", answerOf(FORM, 3)],
    ["GitHub", firstLine(4)],
    ["デモ動画", sectionOf(FORM, 5).split("\n").find((line) => /^https:\/\/\S+$/.test(line))],
    ["使用した Claude", DEFAULTS.claude_products.join(", ")],
    ["その他に書く文", answerOf(FORM, 6)],
    ["詰まった場面", answerOf(FORM, 7)],
    ["公式情報", DEFAULTS.docs_found],
    ["感想", answerOf(FORM, 10)],
    ["審査員用", answerOf(FORM, 11)],
  ];
  const parts = text.split(/\n\n(?=【[^】\n]+】\n)/).map((part) => {
    const match = part.match(/^【([^】\n]+)】\n([\s\S]*)$/);
    assert.ok(match, part.slice(0, 40));
    return [match[1], match[2]];
  });
  assert.deepEqual(parts, expected);
  assert.equal(DEFAULTS.docs_found, answerOf(FORM, 9));
});
