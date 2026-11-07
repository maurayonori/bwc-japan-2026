import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bashProblem,
  guard,
  readProblem,
  sourceHosts,
} from "../.claude/hooks/rules-auditor-guard.mjs";

// .claude/settings.json の PreToolUse から呼ばれる入口
const hook = resolve(".claude/hooks/rules-auditor-guard.sh");
const root = resolve(".");
const AUDITOR = { agent_id: "a0000", agent_type: "rules-auditor" };

function runGuard(input: unknown, projectDir = root) {
  const r = spawnSync("bash", [hook], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { code: r.status, err: r.stderr };
}

test("Bash: gh issue create は、本文に表や記号があっても単一引用符の中なら通す", () => {
  for (const cmd of [
    "gh issue create --title '制度表の鮮度点検: 食事代が出典と違う（2026-11-07）' --body '| 項目 | 結果 |\n| --- | --- |\n| `550` 円 | 不一致 |' --label task",
    'gh issue create --title "点検" --body "差分なし"',
    "gh issue create -t 点検 -b 本文",
  ])
    assert.equal(bashProblem(cmd), null, cmd);
});

test("Bash: gh issue create 以外と、別のコマンドにつなぐ書き方を止める", () => {
  for (const cmd of [
    "gh issue list",
    "gh issue edit 1 --body x",
    "git push",
    "echo gh issue create",
    "FOO=1 gh issue create --title t",
    "gh issue create --title t; rm -rf lib",
    "gh issue create --title t && git push",
    "gh issue create --title t | sh",
    "gh issue create --title t > out.txt",
    "gh issue create --title t\ncat .env",
    "gh issue create --title $(cat .env)",
    'gh issue create --title "$(cat .env)"',
    'gh issue create --title "$ANTHROPIC_API_KEY"',
    "gh issue create --title `cat .env`",
    "gh issue create --title 'unterminated",
  ])
    assert.notEqual(bashProblem(cmd), null, cmd);
});

test("Bash: 手元のファイルを Issue に載せるオプションを止める", () => {
  for (const cmd of [
    "gh issue create --title t --body-file .env",
    "gh issue create --title t --body-file=.env",
    "gh issue create --title t -F .env",
    "gh issue create --title t -wF .env",
    "gh issue create --recover .env",
  ])
    assert.notEqual(bashProblem(cmd), null, cmd);
  // 引用符の中の文字列はオプションとして数えない
  assert.equal(bashProblem("gh issue create --title t --body '--body-file は使わない -F'"), null);
});

test("Read / Grep: rules.ts と手順書だけを読める", () => {
  assert.equal(readProblem(root, root, "lib/money/rules.ts"), null);
  assert.equal(readProblem(root, root, resolve("lib/money/rules.ts")), null);
  assert.equal(readProblem(root, root, ".claude/skills/rules-freshness/SKILL.md"), null);
  for (const p of [".env", ".env.example", "lib/money/../../.env", "lib/money", "", undefined])
    assert.notEqual(readProblem(root, root, p as string), null, String(p));
});

test("WebFetch: 取得できるホストは rules.ts の出典から決まる", () => {
  const hosts = sourceHosts(readFileSync(resolve("lib/money/rules.ts"), "utf8"));
  for (const h of ["www.kyoukaikenpo.or.jp", "www8.cao.go.jp", "laws.e-gov.go.jp"])
    assert.ok(hosts.has(h), h);
});

test("フック: 許すときは exit 0、止めるときは exit 2 で理由を stderr に出す", () => {
  const ok = [
    { tool_name: "Read", tool_input: { file_path: resolve("lib/money/rules.ts") } },
    { tool_name: "Grep", tool_input: { pattern: "checked_on", path: "lib/money/rules.ts" } },
    { tool_name: "WebFetch", tool_input: { url: "https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html", prompt: "祝日" } },
    { tool_name: "Bash", tool_input: { command: "gh issue create --title t --body 'b'" } },
    // 呼び出し元への報告を止めると、点検の結果が届かない
    { tool_name: "SubagentHandback", tool_input: { message: "結果" } },
    { tool_name: "Skill", tool_input: { skill: "rules-freshness" } },
  ];
  for (const input of ok) {
    const r = runGuard({ ...AUDITOR, ...input, cwd: root });
    assert.equal(r.code, 0, `${input.tool_name}: ${r.err}`);
  }
  const ng = [
    { tool_name: "Read", tool_input: { file_path: resolve(".env") } },
    { tool_name: "Grep", tool_input: { pattern: "KEY" } },
    { tool_name: "WebFetch", tool_input: { url: "https://example.com/?q=1", prompt: "x" } },
    { tool_name: "Bash", tool_input: { command: "cat .env" } },
    { tool_name: "Edit", tool_input: { file_path: resolve("lib/money/rules.ts") } },
    { tool_name: "Write", tool_input: { file_path: resolve("lib/money/rules.ts") } },
    { tool_name: "Skill", tool_input: { skill: "update-config" } },
    { tool_name: "Glob", tool_input: { pattern: "**/.env*" } },
    { tool_name: "mcp__github__issue_write", tool_input: { method: "create", title: "t" } },
  ];
  for (const input of ng) {
    const r = runGuard({ ...AUDITOR, ...input, cwd: root });
    assert.equal(r.code, 2, input.tool_name);
    assert.match(r.err, /rules-auditor の道具の制限で止めました/);
  }
});

test("フック: 本体の会話と、ほかのサブエージェントの呼び出しは素通しにする", () => {
  const inputs = [
    { tool_name: "Read", tool_input: { file_path: resolve(".env") } },
    { tool_name: "Bash", tool_input: { command: "git status" } },
    { tool_name: "Edit", tool_input: { file_path: resolve("lib/money/rules.ts") } },
  ];
  for (const input of inputs) {
    assert.equal(runGuard({ ...input, cwd: root }).code, 0, `本体: ${input.tool_name}`);
    const other = { ...input, agent_id: "a1111", agent_type: "Explore", cwd: root };
    assert.equal(runGuard(other).code, 0, `Explore: ${input.tool_name}`);
  }
  // 道具の入力の中に同じ文字列があっても、点検役の呼び出しとは見なさない
  const written = {
    tool_name: "Write",
    tool_input: { file_path: resolve("x.json"), content: '{"agent_type":"rules-auditor"}' },
    cwd: root,
  };
  assert.equal(runGuard(written).code, 0);
});

test("フック: 検査できないとき（検査の本体が見つからないなど）も、点検役の呼び出しは止める", () => {
  const empty = mkdtempSync(join(tmpdir(), "auditor-guard-"));
  try {
    const r = runGuard(
      { ...AUDITOR, tool_name: "Read", tool_input: { file_path: resolve("lib/money/rules.ts") }, cwd: empty },
      empty,
    );
    assert.equal(r.code, 2);
    assert.match(r.err, /検査できなかったので止めました/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("検査の本体も agent_type を確かめる（絞り込みをすり抜けた入力を通す）", () => {
  const read = { tool_name: "Read", tool_input: { file_path: resolve(".env") }, cwd: root };
  assert.equal(guard(read, root), null);
  assert.notEqual(guard({ ...AUDITOR, ...read }, root), null);
});
