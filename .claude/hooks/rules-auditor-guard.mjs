#!/usr/bin/env node
// rules-auditor サブエージェントの PreToolUse フック。依存なし。
// 点検役は外部のページを読み、公開リポジトリに Issue を書ける。手元の秘密に届かないよう、道具の使い道を絞る。
// - Read / Grep: lib/money/rules.ts と、点検の手順書（SKILL.md）だけ
// - WebFetch: rules.ts の sources[].url に載っているホストだけ
// - Bash: `gh issue create` だけ。つなぎ・リダイレクト・展開・置換と、手元のファイルを読む --body-file / -F / --recover は使えない
// 許すなら exit 0、止めるなら理由を stderr に出して exit 2。
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const READABLE = ["lib/money/rules.ts", ".claude/skills/rules-freshness/SKILL.md"];

// gh issue create 以外のコマンドや、シェルが別のことをする書き方を見つけたら理由を返す
export function bashProblem(command) {
  const cmd = command.trim();
  if (!/^gh\s+issue\s+create(\s|$)/.test(cmd)) return "使えるのは gh issue create だけです";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
      else if (c === "$" || c === "`") return "二重引用符の中で $ や ` は使えません。本文は単一引用符で囲んでください";
    } else if (c === "\\") {
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (";&|<>()`$\n\r".includes(c)) {
      return `引用符の外で ${JSON.stringify(c)} は使えません（つなぎ・リダイレクト・展開の禁止）`;
    }
  }
  if (quote) return "引用符が閉じていません";
  // 手元のファイルを読むオプション。-F は -wF のようにまとめて書けるので、短いオプションの並びも見る
  const flags = unquoted(cmd);
  if (/(^|\s)(--body-file|--recover)(=|\s|$)/.test(flags) || /(^|\s)-[A-Za-z]*F/.test(flags))
    return "--body-file / -F / --recover は使えません。本文は --body で渡してください";
  return null;
}

// 引用符の中を伏せた文字列（オプションの判定用）
function unquoted(cmd) {
  return cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
}

function projectPath(root, cwd, p) {
  return resolve(isAbsolute(p) ? p : join(cwd || root, p));
}

export function readProblem(root, cwd, p) {
  if (!p) return "読む場所を指定してください（lib/money/rules.ts）";
  const target = projectPath(root, cwd, p);
  if (READABLE.some((r) => resolve(root, r) === target)) return null;
  return `読めるのは ${READABLE.join(" と ")} だけです`;
}

export function sourceHosts(rulesText) {
  const hosts = new Set();
  for (const m of rulesText.matchAll(/\burl\s*:\s*['"](https?:\/\/[^'"]+)['"]/g)) {
    try {
      hosts.add(new URL(m[1]).hostname);
    } catch {
      /* URL でなければ数えない */
    }
  }
  return hosts;
}

export function fetchProblem(rulesText, url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "URL の形ではありません";
  }
  const hosts = sourceHosts(rulesText);
  if (hosts.has(host)) return null;
  return `取得できるのは rules.ts の出典のホスト（${[...hosts].join("、")}）だけです`;
}

export function guard(input, root) {
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const cwd = input.cwd;
  switch (tool) {
    case "Bash":
      return bashProblem(String(ti.command ?? ""));
    case "Read":
      return readProblem(root, cwd, ti.file_path);
    case "Grep":
      return readProblem(root, cwd, ti.path);
    case "WebFetch":
      return fetchProblem(readFileSync(join(root, READABLE[0]), "utf8"), String(ti.url ?? ""));
    default:
      return `rules-auditor は ${tool} を使えません`;
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    console.error("rules-auditor-guard: 入力を読めませんでした");
    return 2;
  }
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let problem;
  try {
    problem = guard(input, root);
  } catch (e) {
    problem = `検査できませんでした（${e.message.split("\n")[0]}）`;
  }
  if (!problem) return 0;
  console.error(`rules-auditor の道具の制限で止めました: ${problem}`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("rules-auditor-guard.mjs"))
  process.exit(main());
