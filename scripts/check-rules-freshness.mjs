#!/usr/bin/env node
// 制度表 (lib/money/rules.ts) の値を変えたのに、出典の確認日 (checked_on) を今日にしていない編集を止める。依存なし。
// 使い方: node scripts/check-rules-freshness.mjs [--root=DIR] [--base=REF] [--today=YYYY-MM-DD]
//
// - `git diff <base>`（既定は HEAD。未コミットの変更すべて）で rules.ts の変わった箇所を取り出す
// - 変わった箇所を、その箇所を含む sources か、直後に続く sources（＝その値の出典）ごとにまとめる
// - まとめた中で、消えた行と増えた行の「行ごとの数字の並び」を比べる。同じなら（書式・並べ替え・文言だけ）通す
// - 数字が変わった出典は、checked_on のどれかが今日（JST）でなければ止める。出典が続かない値も止める
// - コメント行と checked_on の行そのものは比べない
//
// exit 0: 問題なし / exit 2: 確認日が古い（フックはこれで止める） / exit 1: git が使えないなどの失敗
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RULES_PATH = "lib/money/rules.ts";

const CHECKED_ON_RE = /\bchecked_on\s*:\s*['"](\d{4}-\d{2}-\d{2})['"]/;
const SOURCES_RE = /^\s*sources\s*:/;
const COMMENT_RE = /^\s*(?:\/\/|\/\*|\*)/;
const NUMBER_RE = /\d+(?:[_.,]\d+)*/g;

export function todayInJapan(now = new Date()) {
  // en-CA は YYYY-MM-DD で出る
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--(root|base|today)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// 比べる対象。数字を含む行ごとに、数字を出てくる順に並べたもの（270_300 と 270300 は同じ）。
// 行単位なので、行の並べ替えは通し、区分どうしで金額を入れ替えた変更は止める。コメント行と checked_on の行は除く
function numbersOf(lines) {
  return lines
    .filter((l) => !COMMENT_RE.test(l) && !CHECKED_ON_RE.test(l))
    .map((l) => (l.match(NUMBER_RE) ?? []).map((n) => n.replaceAll("_", "")).join(" "))
    .filter((s) => s !== "")
    .sort();
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// git diff -U0 の出力を、変わった箇所（hunk）ごとに分ける
export function parseHunks(diff) {
  const hunks = [];
  let cur = null;
  for (const l of diff.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      // 削除だけの箇所は、新しいファイルで「削除された位置の直後の行」を位置とする
      cur = { line: count === 0 ? start + 1 : start, removed: [], added: [] };
      hunks.push(cur);
    } else if (cur && l.startsWith("-") && !l.startsWith("---")) {
      cur.removed.push(l.slice(1));
    } else if (cur && l.startsWith("+") && !l.startsWith("+++")) {
      cur.added.push(l.slice(1));
    }
  }
  return hunks;
}

// 新しい rules.ts の sources ブロックを探す。sources: の行から、行頭に戻る行（宣言の終わり）の手前まで
export function sourceBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!SOURCES_RE.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^\S/.test(lines[end])) end++;
    const checked = [];
    const names = [];
    for (let j = i; j < end; j++) {
      const c = CHECKED_ON_RE.exec(lines[j]);
      if (c) checked.push(c[1]);
      const n = /\bname\s*:\s*['"](.+?)['"]/.exec(lines[j]);
      if (n) names.push(n[1]);
    }
    blocks.push({ start: i + 1, end, checked, names });
    i = end - 1;
  }
  return blocks;
}

// 変わった位置を含む sources、なければ直後に続く sources
function governingBlock(blocks, line) {
  return (
    blocks.find((b) => b.start <= line && line <= b.end) ??
    blocks.find((b) => b.start >= line) ??
    null
  );
}

export function check({ root, base = "HEAD", today = todayInJapan() }) {
  const abs = join(root, RULES_PATH);
  if (!existsSync(abs)) return { problems: [], changed: 0, today };
  const diff = execFileSync(
    "git",
    ["-C", root, "diff", "-U0", "--no-color", "--no-ext-diff", base, "--", RULES_PATH],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const blocks = sourceBlocks(readFileSync(abs, "utf8"));
  // 同じ出典に属する変更をまとめてから比べる（行の移動は、削除と追加の別々の箇所になるため）
  const groups = new Map();
  for (const h of parseHunks(diff)) {
    const block = governingBlock(blocks, h.line);
    const g = groups.get(block) ?? { block, lines: [], removed: [], added: [] };
    g.lines.push(h.line);
    g.removed.push(...h.removed);
    g.added.push(...h.added);
    groups.set(block, g);
  }
  const changed = [...groups.values()].filter(
    (g) => !sameList(numbersOf(g.removed), numbersOf(g.added)),
  );
  const problems = [];
  for (const g of changed) {
    if (!g.block) problems.push({ lines: g.lines, reason: "no-source" });
    else if (!g.block.checked.includes(today))
      problems.push({ lines: g.lines, reason: "stale", block: g.block });
  }
  return { problems, changed: changed.length, today };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  let result;
  try {
    result = check({ root, base: args.base, today: args.today });
  } catch (e) {
    console.error(`check-rules-freshness: 調べられませんでした（${e.message.split("\n")[0]}）`);
    return 1;
  }
  const { problems, changed, today } = result;
  if (problems.length === 0) {
    console.log(
      changed === 0
        ? `check-rules-freshness: ${RULES_PATH} の値は変わっていません`
        : `check-rules-freshness: 値が変わった ${changed} か所とも、出典の確認日が今日（${today}）です`,
    );
    return 0;
  }
  console.error(
    `${RULES_PATH} の値が変わりましたが、出典の確認日 (checked_on) が今日（${today}、JST）になっていません。`,
  );
  for (const p of problems) {
    const where = `${RULES_PATH}:${p.lines.join(",")}`;
    if (p.reason === "no-source") {
      console.error(`  ${where}  この値に続く sources（出典の URL と checked_on）がありません`);
    } else {
      const names = p.block.names.join("、") || "名前なし";
      const dates = p.block.checked.join("、") || "なし";
      console.error(
        `  ${where}  続く出典（${names}）の checked_on: ${dates}（${RULES_PATH}:${p.block.start} から）`,
      );
    }
  }
  console.error(
    "出典を開いて値を確かめたなら、確かめた出典の checked_on を今日にしてください。確かめていないなら、値の変更を戻してください。",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-rules-freshness.mjs"))
  process.exit(main());
