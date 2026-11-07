import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  sourceBlocks,
  todayInJapan,
} from "../scripts/check-rules-freshness.mjs";

const script = resolve("scripts/check-rules-freshness.mjs");
const hook = resolve(".claude/hooks/rules-freshness-check.sh");
const TODAY = "2026-11-07";
const OLD = "2026-11-06";

// 本物の rules.ts と同じ形の小さな表（値は検査のための架空のもの）
const RULES = `import { deepFreeze } from "./validate";

// 高額療養費。令和 8 年 8 月から
export const KOUGAKU_UNDER_70 = deepFreeze({
  from_month: '2026-08',
  categories: [
    { key: 'ア', condition: '標準報酬月額 83 万円以上', base: 270_300, threshold: 901_000 },
    { key: 'エ', condition: '標準報酬月額 26 万円以下', base: 61_500, threshold: null },
  ],
  sources: [
    {
      name: '協会けんぽ（限度額）',
      url: 'https://example.com/high_cost/002/index.html',
      checked_on: '${OLD}',
    },
    {
      name: '施行令 第 42 条',
      url: 'https://example.com/law',
      checked_on: '${OLD}',
    },
  ],
});

export const MEAL_COPAY = deepFreeze({
  yen_per_meal: 550,
  sources: [
    { name: '協会けんぽ（食事）', url: 'https://example.com/meal', checked_on: '${OLD}' },
  ],
});

const HOLIDAY_LIST: [string, string][] = [
  ['2026-01-01', '元日'],
  ['2026-05-06', '休日'],
];

export const BUSINESS_DAYS = deepFreeze({
  holidays: Object.fromEntries(HOLIDAY_LIST),
  sources: [
    { name: '内閣府', url: 'https://example.com/holidays', checked_on: '${OLD}' },
  ],
});
`;

const RULES_PATH = "lib/money/rules.ts";

function repo(text = RULES) {
  const dir = mkdtempSync(join(tmpdir(), "rules-freshness-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "lib/money"), { recursive: true });
  writeFileSync(join(dir, RULES_PATH), text);
  git("add", RULES_PATH);
  git("commit", "-qm", "base");
  const file = join(dir, RULES_PATH);
  return {
    dir,
    git,
    file,
    edit: (...pairs: [string, string][]) => {
      let t = readFileSync(file, "utf8");
      for (const [from, to] of pairs) {
        assert.ok(t.includes(from), `置き換える文字列が無い: ${from}`);
        t = t.replace(from, to);
      }
      writeFileSync(file, t);
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(dir: string, today = TODAY) {
  const r = spawnSync("node", [script, `--root=${dir}`, `--today=${today}`], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const mealChecked = [
  `{ name: '協会けんぽ（食事）', url: 'https://example.com/meal', checked_on: '${OLD}' }`,
  `{ name: '協会けんぽ（食事）', url: 'https://example.com/meal', checked_on: '${TODAY}' }`,
] as [string, string];
const kougakuChecked = [
  `url: 'https://example.com/high_cost/002/index.html',\n      checked_on: '${OLD}'`,
  `url: 'https://example.com/high_cost/002/index.html',\n      checked_on: '${TODAY}'`,
] as [string, string];
const holidayChecked = [
  `{ name: '内閣府', url: 'https://example.com/holidays', checked_on: '${OLD}' }`,
  `{ name: '内閣府', url: 'https://example.com/holidays', checked_on: '${TODAY}' }`,
] as [string, string];

test("止めない: 何も変えていない", () => {
  const r = repo();
  try {
    const { code, out } = run(r.dir);
    assert.equal(code, 0);
    assert.match(out, /値は変わっていません/);
  } finally { r.done(); }
});

test("止める: 金額を変えたのに、その表の確認日が古い", () => {
  const r = repo();
  try {
    r.edit(["yen_per_meal: 550", "yen_per_meal: 510"]);
    const { code, out } = run(r.dir);
    assert.equal(code, 2);
    assert.match(out, /lib\/money\/rules\.ts:\d+ .*協会けんぽ（食事）.*checked_on: 2026-11-06/);
    assert.match(out, /今日（2026-11-07、JST）/);
  } finally { r.done(); }
});

test("止めない: 金額を変え、その表の出典の確認日を今日にした", () => {
  const r = repo();
  try {
    r.edit(["yen_per_meal: 550", "yen_per_meal: 510"], mealChecked);
    assert.equal(run(r.dir).code, 0);
  } finally { r.done(); }
});

test("止めない: 出典が 2 つある表は、確かめた 1 つの確認日を今日にすればよい", () => {
  const r = repo();
  try {
    r.edit(["base: 270_300, threshold: 901_000", "base: 290_000, threshold: 950_000"], kougakuChecked);
    assert.equal(run(r.dir).code, 0);
  } finally { r.done(); }
});

test("止める: 高額療養費を変えて、食事代の確認日だけを今日にした（別の表の確認日は数えない）", () => {
  const r = repo();
  try {
    r.edit(["base: 61_500", "base: 62_000"], mealChecked);
    const { code, out } = run(r.dir);
    assert.equal(code, 2);
    assert.match(out, /協会けんぽ（限度額）、施行令 第 42 条/);
  } finally { r.done(); }
});

test("祝日を足すと、続く営業日の表の確認日が要る", () => {
  const r = repo();
  try {
    r.edit(["  ['2026-05-06', '休日'],\n", "  ['2026-05-06', '休日'],\n  ['2026-07-20', '海の日'],\n"]);
    assert.equal(run(r.dir).code, 2);
    r.edit(holidayChecked);
    assert.equal(run(r.dir).code, 0);
  } finally { r.done(); }
});

test("止める: 行を消しても値の変更として扱う", () => {
  const r = repo();
  try {
    r.edit(["  ['2026-01-01', '元日'],\n", ""]);
    assert.equal(run(r.dir).code, 2);
  } finally { r.done(); }
});

test("止める: 出典の URL を変えたのに確認日が古い", () => {
  const r = repo();
  try {
    r.edit(["high_cost/002/index.html", "high_cost/003/index.html"]);
    const { code, out } = run(r.dir);
    assert.equal(code, 2);
    assert.match(out, /協会けんぽ（限度額）/);
  } finally { r.done(); }
});

test("止める: 区分どうしで金額を入れ替えた（数字の集合は同じでも、行の値が変わる）", () => {
  const r = repo();
  try {
    r.edit(["base: 270_300", "base: 61_500"], ["base: 61_500, threshold: null", "base: 270_300, threshold: null"]);
    assert.equal(run(r.dir).code, 2);
  } finally { r.done(); }
});

test("止める: 区分の条件の数字を変えた", () => {
  const r = repo();
  try {
    r.edit(["標準報酬月額 83 万円以上", "標準報酬月額 81 万円以上"]);
    assert.equal(run(r.dir).code, 2);
  } finally { r.done(); }
});

test("止める: 出典の無い値を足した", () => {
  const r = repo();
  try {
    r.edit(["const HOLIDAY_LIST", "export const NEW_RATE = 3;\n\nconst HOLIDAY_LIST"]);
    // 続く BUSINESS_DAYS の出典を数えるので止まる。末尾に足すと出典が無い
    assert.equal(run(r.dir).code, 2);
    const r2 = repo(RULES + "\nexport const TAIL_RATE = 7;\n");
    try {
      r2.edit(["TAIL_RATE = 7", "TAIL_RATE = 8"]);
      const { code, out } = run(r2.dir);
      assert.equal(code, 2);
      assert.match(out, /sources（出典の URL と checked_on）がありません/);
    } finally { r2.done(); }
  } finally { r.done(); }
});

test("止めない: コメント・文言・書式・並べ替えだけの変更（数字の並びが同じ）", () => {
  const r = repo();
  try {
    r.edit(
      ["// 高額療養費。令和 8 年 8 月から", "// 高額療養費。令和 9 年 8 月から（注記を直した）"],
      ["base: 270_300", "base: 270300"],
      ["condition: '標準報酬月額 26 万円以下'", "condition: '標準報酬月額が 26 万円以下'"],
      ["  ['2026-01-01', '元日'],\n  ['2026-05-06', '休日'],", "  ['2026-05-06', '休日'],\n  ['2026-01-01', '元日'],"],
    );
    const { code, out } = run(r.dir);
    assert.equal(code, 0, out);
  } finally { r.done(); }
});

test("止めない: 確認日だけを更新した", () => {
  const r = repo();
  try {
    r.edit(mealChecked);
    assert.equal(run(r.dir).code, 0);
  } finally { r.done(); }
});

test("ステージ済みの変更も HEAD と比べて調べる", () => {
  const r = repo();
  try {
    r.edit(["yen_per_meal: 550", "yen_per_meal: 510"]);
    r.git("add", RULES_PATH);
    assert.equal(run(r.dir).code, 2);
  } finally { r.done(); }
});

test("今日は JST で数える", () => {
  assert.equal(todayInJapan(new Date("2026-11-07T14:59:59Z")), "2026-11-07");
  assert.equal(todayInJapan(new Date("2026-11-07T15:00:00Z")), "2026-11-08");
});

test("本物の rules.ts の 3 つの表から、出典と確認日を読める", () => {
  const blocks = sourceBlocks(readFileSync(resolve(RULES_PATH), "utf8"));
  assert.equal(blocks.length, 3);
  for (const b of blocks) {
    assert.ok(b.checked.length >= 1);
    assert.equal(b.checked.length, b.names.length);
    for (const d of b.checked) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// PostToolUse フック。Claude Code が渡す JSON を標準入力に入れて実行する
function runHook(input: unknown, projectDir = resolve(".")) {
  const r = spawnSync("bash", [hook], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("フック: rules.ts の値を変えて確認日が古いと exit 2 で止め、理由を stderr に出す", () => {
  const r = repo();
  try {
    r.edit(["yen_per_meal: 550", "yen_per_meal: 510"]);
    const h = runHook({ tool_name: "Edit", tool_input: { file_path: r.file }, cwd: r.dir });
    assert.equal(h.code, 2);
    assert.match(h.err, /制度表の確認日の検査/);
    assert.match(h.err, /checked_on/);
  } finally { r.done(); }
});

test("フック: 確認日を今日（JST）にしていれば止めない", () => {
  const r = repo();
  const today = todayInJapan();
  try {
    r.edit(
      ["yen_per_meal: 550", "yen_per_meal: 510"],
      [mealChecked[0], mealChecked[0].replace(OLD, today)],
    );
    const h = runHook({ tool_name: "Write", tool_input: { file_path: r.file }, cwd: r.dir });
    assert.equal(h.code, 0, h.err);
  } finally { r.done(); }
});

test("フック: rules.ts 以外のファイルの編集では何もしない", () => {
  const r = repo();
  try {
    r.edit(["yen_per_meal: 550", "yen_per_meal: 510"]);
    for (const p of [join(r.dir, "lib/money/meals.ts"), join(r.dir, "docs/rules.ts"), ""]) {
      const h = runHook({ tool_name: "Edit", tool_input: { file_path: p }, cwd: r.dir });
      assert.equal(h.code, 0, p);
      assert.equal(h.err, "");
    }
  } finally { r.done(); }
});

test("フック: 相対パスの rules.ts は cwd のリポジトリで調べる", () => {
  const r = repo();
  try {
    r.edit(["yen_per_meal: 550", "yen_per_meal: 510"]);
    const h = runHook({ tool_name: "Edit", tool_input: { file_path: RULES_PATH }, cwd: r.dir });
    assert.equal(h.code, 2);
  } finally { r.done(); }
});

test("フック: git で調べられないときは編集を止めず（exit 1）、知らせるだけにする", () => {
  const dir = mkdtempSync(join(tmpdir(), "rules-freshness-nogit-"));
  try {
    mkdirSync(join(dir, "lib/money"), { recursive: true });
    writeFileSync(join(dir, RULES_PATH), RULES);
    const h = runHook({ tool_name: "Write", tool_input: { file_path: join(dir, RULES_PATH) }, cwd: dir });
    assert.equal(h.code, 1);
    assert.match(h.err, /調べられませんでした/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
