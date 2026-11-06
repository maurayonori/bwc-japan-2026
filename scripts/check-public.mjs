#!/usr/bin/env node
// 公開リポジトリへ push する前の機械検査。依存なし。
// 使い方: node scripts/check-public.mjs [--root=DIR] [--base=REF] [--allow=FILE]
// 検出したらファイルと行番号とルール名だけを出し、値は出さない。exit 1。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const MAX_BYTES = 1024 * 1024;
const SKIP_FILES = new Set(["package-lock.json"]);

// 本物の鍵の形を、このファイル自体が検出されないよう連結で組み立てる
const KEY_PATTERNS = [
  { rule: "anthropic-key", re: new RegExp("sk" + "-ant-[A-Za-z0-9_-]{16,}") },
  { rule: "github-token", re: new RegExp("\\bgh[pousr]" + "_[A-Za-z0-9]{30,}") },
  { rule: "github-token", re: new RegExp("github" + "_pat_[A-Za-z0-9_]{20,}") },
  { rule: "vercel-token", re: new RegExp("\\bvc[pairk]" + "_[A-Za-z0-9]{20,}") },
  {
    rule: "private-key",
    re: new RegExp("-----BEGIN (?:[A-Z]+ )*PRIVATE" + " KEY-----"),
  },
  { rule: "aws-key", re: new RegExp("\\bAKIA" + "[0-9A-Z]{16}\\b") },
];
const ASSIGN_RE =
  /\b([A-Z][A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET|PASSWORD))\s*=\s*(["']?)([^\s"'#]*)/;
const PLACEHOLDER_RE =
  /^(?:|\$\{?[A-Z_]+\}?|<[^>]*>|\.{3}|x{3,}|your[-_].*|changeme|example.*|dummy.*|test.*|process\.env.*)$/i;

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--(root|base|allow)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function loadAllow(root, file) {
  const path = file ?? join(root, "scripts", "check-public.allow.json");
  if (!existsSync(path)) return [];
  const list = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(list)) throw new Error("許可リストは配列にしてください");
  return list; // { path?, rule?, line? }
}

const allowed = (allow, f) =>
  allow.some(
    (a) =>
      (a.path === undefined || a.path === f.path) &&
      (a.rule === undefined || a.rule === f.rule) &&
      (a.line === undefined || a.line === f.line),
  );

function pathFindings(path) {
  const found = [];
  const name = basename(path);
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example")
    found.push("env-file");
  if (path.split("/").includes(".vercel")) found.push("vercel-dir");
  if (path === ".claude/settings.local.json") found.push("claude-local-settings");
  return found;
}

function lineFindings(path, text) {
  const isExample = basename(path) === ".env.example";
  const rules = new Set();
  if (text.includes("check-public:allow")) return rules;
  for (const { rule, re } of KEY_PATTERNS) if (re.test(text)) rules.add(rule);
  const m = ASSIGN_RE.exec(text);
  const isCode = /\.(?:[cm]?[jt]sx?)$/.test(path);
  const prop = m && m.index > 0 && text[m.index - 1] === "."; // process.env.X = 変数
  if (m && !((prop || isCode) && m[2] === "")) {
    const value = m[3];
    // .env.example は値が空でなければならない。他は明らかな見本値を除く
    if (isExample ? value !== "" : !PLACEHOLDER_RE.test(value))
      rules.add("secret-assignment");
  }
  return rules;
}

function scanWorktree(root) {
  const findings = [];
  const files = git(root, ["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  for (const path of files) {
    if (path.split("/").includes("node_modules")) continue;
    if (SKIP_FILES.has(basename(path))) continue;
    for (const rule of pathFindings(path)) findings.push({ path, line: 0, rule });
    const abs = join(root, path);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) findings.push({ path, line: 0, rule: "large-file" });
    if (st.size > MAX_BYTES * 8) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue;
    buf
      .toString("utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const rule of lineFindings(path, text))
          findings.push({ path, line: i + 1, rule });
      });
  }
  return findings;
}

function resolveBase(root, base) {
  for (const ref of base ? [base] : ["origin/main", "main"]) {
    try {
      git(root, ["rev-parse", "--verify", "-q", ref]);
      return ref;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

// base..HEAD の各コミットで追加された行と、追加されたパスを調べる
// （後で消した秘密も履歴には残るため、差分の合計ではなくコミットごとに見る）
function scanCommits(root, base) {
  const findings = [];
  const ref = resolveBase(root, base);
  if (!ref) return { findings, ref: null };
  const log = git(root, [
    "log",
    `${ref}..HEAD`,
    "-p",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--format=%x01%h",
  ]);
  for (const block of log.split("\x01").slice(1)) {
    const [hash, ...lines] = block.split("\n");
    let path = null;
    let n = 0;
    let skip = false;
    for (const l of lines) {
      if (l.startsWith("+++ ")) {
        path = l === "+++ /dev/null" ? null : l.slice(6);
        skip = path === null || path.split("/").includes("node_modules") ||
          SKIP_FILES.has(basename(path));
        if (path && !skip)
          for (const rule of pathFindings(path))
            findings.push({ path, line: 0, rule, commit: hash });
      } else if (l.startsWith("@@")) {
        const m = /\+(\d+)/.exec(l);
        n = m ? Number(m[1]) : 0;
      } else if (l.startsWith("+") && !skip && path) {
        for (const rule of lineFindings(path, l.slice(1)))
          findings.push({ path, line: n, rule, commit: hash });
        n++;
      }
    }
  }
  return { findings, ref };
}

export function check({ root, base, allowFile }) {
  const allow = loadAllow(root, allowFile);
  const tree = scanWorktree(root);
  const { findings: commits, ref } = scanCommits(root, base);
  const seen = new Set();
  const all = [...tree, ...commits].filter((f) => {
    if (allowed(allow, f)) return false;
    const key = `${f.commit ?? "tree"}|${f.path}|${f.line}|${f.rule}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { findings: all, base: ref };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  const { findings, base } = check({ root, base: args.base, allowFile: args.allow });
  if (findings.length === 0) {
    console.log(`check-public: 問題なし（比較元: ${base ?? "なし"}）`);
    return 0;
  }
  console.error(`check-public: ${findings.length} 件を検出（値は表示しません）`);
  for (const f of findings) {
    const where = f.line ? `${f.path}:${f.line}` : f.path;
    console.error(`  ${where}  [${f.rule}]${f.commit ? `  (コミット ${f.commit})` : ""}`);
  }
  console.error("誤検出は scripts/check-public.allow.json か行内の check-public:allow で許可できます。");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-public.mjs"))
  process.exit(main());
