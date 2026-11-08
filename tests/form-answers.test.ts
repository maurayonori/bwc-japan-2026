import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 提出フォームの下書き（docs/submission/form.md）が、告知された 11 問の形に合っていることを確かめる（#92）。
// 送信後は直せないので、字数・冒頭の形・動画の URL の食い違いを送る前に落とす。

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
