import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exampleMoneyTurns, exampleWorkspace } from "../lib/example";
import { yen } from "../lib/money/format";
import { limitConfigFromEnv } from "../lib/limits";

// 提出フォームの下書き（docs/submission/form.md）が、実際の設問 11 問に合っていることを確かめる（#92）。
// 写す範囲は、各設問の見出しのあとの最初の ```text の枠の中。

const ROOT = join(__dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const FORM = read("docs/submission/form.md");
const MAX_OVERVIEW = 500;

// 「## n. 」の見出しのあとの最初の text の枠の中を返す。
function answerOf(form: string, number: number): string {
  const start = form.indexOf(`\n## ${number}. `);
  assert.ok(start >= 0, `設問 ${number} の見出しが無い`);
  const open = form.indexOf("```text\n", start);
  const close = form.indexOf("\n```", open + 1);
  const next = form.indexOf("\n## ", start + 1);
  assert.ok(open >= 0 && close > open, `設問 ${number} の枠が無い`);
  assert.ok(
    next < 0 || open < next,
    `設問 ${number} の枠が次の見出しより後にある`,
  );
  return form.slice(open + "```text\n".length, close);
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

test("設問 3 の概要は指定の 1 文で始まり、500 字以内で、書いてある字数と一致する", () => {
  const overview = answerOf(FORM, 3);
  const [first] = overview.split("\n");
  assert.match(first, /^このプロジェクトは、.+の.+を.+です。$/);
  const all = countOf(overview);
  const withoutBreaks = countOf(overview.replace(/\n/g, ""));
  const withoutSpaces = countOf(overview.replace(/\s/g, ""));
  assert.ok(all <= MAX_OVERVIEW, `${all} 字`);
  assert.ok(
    FORM.includes(
      `字数: 空白と改行を含めて ${all} 字（改行を除くと ${withoutBreaks} 字、空白も除くと ${withoutSpaces} 字）。`,
    ),
    `書いてある字数が実際（${all}・${withoutBreaks}・${withoutSpaces}）と違う`,
  );
});

test("設問 3 の概要の金額は、体験例の計算関数の結果と一致する", () => {
  const overview = answerOf(FORM, 3);
  const { first, second } = exampleMoneyTurns();
  const [withCap, withoutCap] = first.cashflow.scenarios;
  const [confirmed] = second.cashflow.scenarios;
  const cash = first.cashflow.cash_on_hand;
  assert.ok(cash !== null);
  const expected = [
    `上限が使えれば ${yen(withCap.low_case.need)}`,
    `使えなければ ${yen(withoutCap.low_case.need)}`,
    `差は ${yen(first.cashflow.comparison_with_first[0].need_low_difference)}`,
    `手元が ${yen(withoutCap.low_case.need - cash)}足りません`,
    `答えを話すと ${yen(confirmed.low_case.need)}に絞られます`,
  ];
  for (const text of expected) assert.ok(overview.includes(text), text);
});

test("作者の体験に触れる一文は、提出フォームの下書きの中で 1 回だけ出る", () => {
  const sentence =
    "作者自身が入院の準備で、いくら要るのか、誰に何を頼むのかを整理しようとしたことが出発点です。";
  assert.equal(FORM.split(sentence).length - 1, 1);
  assert.equal(FORM.split("作者自身").length - 1, 1);
});

test("設問 11 の回数の上限は、既定の上限と同じ", () => {
  const access = answerOf(FORM, 11);
  const limits = limitConfigFromEnv({});
  assert.ok(access.includes(`端末ごとに 1 日 ${limits.perClientPerDay} 回`));
  assert.ok(access.includes(`全体で 1 日 ${limits.globalPerDay} 回`));
  assert.ok(access.includes("https://sakiyomi-bwc2026.vercel.app"));
});

test("設問 11 の試す発言は、README のデモの 3 発言と同じ", () => {
  const access = answerOf(FORM, 11);
  const readme = read("README.md");
  const [opening, , , answer] = exampleWorkspace().messages;
  const utterances = [
    opening.text,
    answer.text.split("。")[0] + "。",
    "退院は1月4日になりました。",
  ];
  utterances.forEach((text, index) => {
    assert.ok(access.includes(`${index + 1}. ${text}`), text);
    assert.ok(readme.includes(text), `README: ${text}`);
  });
});

test("規模の目安の額は、体験例の差を 100 件にした計算と一致する", () => {
  const { first } = exampleMoneyTurns();
  const difference =
    first.cashflow.comparison_with_first[0].need_low_difference;
  const scale = `${yen(difference)}が 100 件なら ${yen(difference * 100)}`;
  for (const path of [
    "README.md",
    "docs/submission/form.md",
    "docs/family-preparation.md",
  ]) {
    assert.ok(read(path).includes(scale), `${path}: ${scale}`);
  }
});
