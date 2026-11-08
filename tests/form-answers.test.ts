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
// フォームの上限は 500 字。改行を 2 字と数えるフォームでも収まるよう、下書きは 480 字・改行 2 つまでにする。
const MAX_OVERVIEW = 480;
const MAX_OVERVIEW_BREAKS = 2;

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

test("設問 3 の概要は指定の 1 文で始まり、480 字以内・改行 2 つまでで、書いてある字数と一致する", () => {
  const overview = answerOf(FORM, 3);
  const [first] = overview.split("\n");
  // 「このプロジェクトは、〔誰〕の〔課題〕を〔どう変える〕〔形〕です。」の 1 文。〔課題〕は名詞句で閉じてから「を」に入る。
  const template = first.match(
    /^このプロジェクトは、(.+?)(?:の|が抱える)(「[^」]+」課題)を、([^。]+?変える) ([^。]+)です。$/,
  );
  assert.ok(template, first);
  const [, who, , , form] = template;
  assert.ok(who.includes("本人と家族"), who);
  assert.equal(form, "Web アプリ");
  const all = countOf(overview);
  const withoutBreaks = countOf(overview.replace(/\n/g, ""));
  const withoutSpaces = countOf(overview.replace(/\s/g, ""));
  const breaks = all - withoutBreaks;
  assert.ok(all <= MAX_OVERVIEW, `${all} 字`);
  assert.ok(breaks <= MAX_OVERVIEW_BREAKS, `改行 ${breaks} つ`);
  // 改行を 2 字と数えても、フォームの 500 字に収まる。
  assert.ok(all + breaks <= 500, `改行を 2 字と数えると ${all + breaks} 字`);
  assert.ok(
    FORM.includes(
      `字数: 空白と改行を含めて ${all} 字（改行を除くと ${withoutBreaks} 字、空白も除くと ${withoutSpaces} 字）。改行は ${breaks} つ。`,
    ),
    `書いてある字数が実際（${all}・${withoutBreaks}・${withoutSpaces}・改行 ${breaks}）と違う`,
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
    `後者は ${yen(withoutCap.low_case.need - cash)}足りません`,
    `話すと ${yen(confirmed.low_case.need)}に絞られます`,
  ];
  for (const text of expected) assert.ok(overview.includes(text), text);
  // 枠の中の円の額は、体験例の計算から出る額だけにする。手で書いた額を混ぜない。
  const computed = new Set(
    [
      withCap.low_case.need,
      withoutCap.low_case.need,
      first.cashflow.comparison_with_first[0].need_low_difference,
      cash - withCap.low_case.need,
      withoutCap.low_case.need - cash,
      confirmed.low_case.need,
    ].map(yen),
  );
  const amounts = [...overview.matchAll(/[\d,]+ 円/g)].map((match) => match[0]);
  assert.ok(amounts.length > 0);
  for (const amount of amounts) assert.ok(computed.has(amount), amount);
});

test("設問 3 の概要は、製品の骨格を入力欄 1 つ → 見通し → 渡すもの の順に書く", () => {
  const overview = answerOf(FORM, 3);
  const steps = [
    "入力欄 1 つ",
    "「見通し」",
    "上限が窓口で使える場合と使えない場合",
    "まず確かめる 1 つ",
    "「渡すもの」",
    "選んで渡せます",
  ];
  const positions = steps.map((step) => overview.indexOf(step));
  positions.forEach((position, index) =>
    assert.ok(position >= 0, steps[index]),
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
});

test("作者の体験に触れる一文は、提出フォームの下書きの中で 1 回だけ出て、README には無い", () => {
  const sentence =
    "作者自身が入院の準備で、いくら要るのか、誰に何を頼むのかを整理しようとしたことが出発点です。";
  assert.equal(FORM.split(sentence).length - 1, 1);
  assert.equal(FORM.split("作者自身").length - 1, 1);
  assert.ok(answerOf(FORM, 3).includes(sentence));
  // 提出文書で作者の体験に触れるのは一文だけ（CLAUDE.md）。README の経緯の「作者自身が『この形では使わない』」は開発の判断で、体験ではない。
  const readme = read("README.md");
  assert.ok(!readme.includes("作者自身が入院"));
  assert.ok(!readme.includes("入院の準備で"));
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
