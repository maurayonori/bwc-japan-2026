import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bashProblem,
  readProblem,
  sourceHosts,
} from "../.claude/hooks/rules-auditor-guard.mjs";

const guard = resolve(".claude/hooks/rules-auditor-guard.mjs");
const root = resolve(".");

function runGuard(input: unknown) {
  const r = spawnSync("node", [guard], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
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
  ];
  for (const input of ok) {
    const r = runGuard({ ...input, cwd: root });
    assert.equal(r.code, 0, `${input.tool_name}: ${r.err}`);
  }
  const ng = [
    { tool_name: "Read", tool_input: { file_path: resolve(".env") } },
    { tool_name: "Grep", tool_input: { pattern: "KEY" } },
    { tool_name: "WebFetch", tool_input: { url: "https://example.com/?q=1", prompt: "x" } },
    { tool_name: "Bash", tool_input: { command: "cat .env" } },
    { tool_name: "Edit", tool_input: { file_path: resolve("lib/money/rules.ts") } },
    { tool_name: "Write", tool_input: { file_path: resolve("lib/money/rules.ts") } },
  ];
  for (const input of ng) {
    const r = runGuard({ ...input, cwd: root });
    assert.equal(r.code, 2, input.tool_name);
    assert.match(r.err, /rules-auditor の道具の制限で止めました/);
  }
});
