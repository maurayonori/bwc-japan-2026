import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve("scripts/check-public.mjs");
const hook = resolve(".claude/hooks/pre-push-check.sh");

// 本物の鍵の形はソースに書かず、実行時に連結する
const fakeAnthropic = "sk" + "-ant-" + "a".repeat(30);
const fakeGithub = "ghp" + "_" + "b".repeat(36);
const fakeKeyHeader = "-----BEGIN RSA PRIVATE" + " KEY-----";

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "check-public-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write(dir, { "README.md": "ok\n" });
  git("add", "README.md");
  git("commit", "-qm", "base");
  write(dir, files);
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function write(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
}
function run(dir: string, ...extra: string[]) {
  const r = spawnSync("node", [script, `--root=${dir}`, "--base=main", ...extra], {
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("問題のないファイルは通る", () => {
  const r = repo({ "docs/a.md": "普通の文書\nANTHROPIC_API_KEY=\n", ".env.example": "ANTHROPIC_API_KEY=\n" });
  try {
    assert.equal(run(r.dir).code, 0);
  } finally { r.done(); }
});

test("鍵の形を行番号つきで検出し、値は出力しない", () => {
  const r = repo({
    "docs/a.md": `1行目\n${fakeAnthropic}\n${fakeGithub}\n${fakeKeyHeader}\n`,
    "x.env.txt": "OTHER_API_KEY=abcdef123456\n",
  });
  try {
    const { code, out } = run(r.dir);
    assert.equal(code, 1);
    assert.match(out, /docs\/a\.md:2 .*anthropic-key/);
    assert.match(out, /docs\/a\.md:3 .*github-token/);
    assert.match(out, /docs\/a\.md:4 .*private-key/);
    assert.match(out, /x\.env\.txt:1 .*secret-assignment/);
    assert.ok(!out.includes(fakeAnthropic) && !out.includes("abcdef123456"));
  } finally { r.done(); }
});

test(".env と .vercel と settings.local.json と .env.example の値を検出する", () => {
  const r = repo({
    ".env": "A=1\n",
    ".env.local": "A=1\n",
    ".vercel/project.json": "{}\n",
    ".claude/settings.local.json": "{}\n",
    ".env.example": "ANTHROPIC_API_KEY=somevalue\n",
  });
  try {
    // 利用者のグローバル除外設定に左右されないよう強制的に追跡させる
    r.git("add", "-f", ".env", ".env.local", ".vercel/project.json", ".claude/settings.local.json");
    const { code, out } = run(r.dir);
    assert.equal(code, 1);
    for (const p of [".env ", ".env.local", ".vercel/project.json", ".claude/settings.local.json", ".env.example:1"])
      assert.ok(out.includes(p), p);
  } finally { r.done(); }
});

test("1MB を超えるファイルを検出する", () => {
  const r = repo({ "big.txt": "a".repeat(1024 * 1024 + 1) });
  try {
    assert.match(run(r.dir).out, /big\.txt .*large-file/);
  } finally { r.done(); }
});

test("後のコミットで消した秘密もコミットの差分から検出する", () => {
  const r = repo({});
  try {
    r.git("checkout", "-q", "-b", "feature");
    write(r.dir, { "n.md": `${fakeAnthropic}\n` });
    r.git("add", "n.md");
    r.git("commit", "-qm", "add");
    r.git("rm", "-q", "n.md");
    r.git("commit", "-qm", "rm");
    const { code, out } = run(r.dir);
    assert.equal(code, 1);
    assert.match(out, /n\.md:1 .*anthropic-key.*コミット/);
  } finally { r.done(); }
});

test("許可リストと行内マーカーで誤検出を除ける", () => {
  const r = repo({
    "docs/a.md": `${fakeAnthropic}\n`,
    "docs/b.md": `${fakeGithub} check-public:allow\n`,
    "allow.json": JSON.stringify([{ path: "docs/a.md", rule: "anthropic-key", line: 1 }]),
  });
  try {
    assert.equal(run(r.dir, `--allow=${join(r.dir, "allow.json")}`).code, 0);
  } finally { r.done(); }
});

test("コードの process.env 代入は誤検出しない", () => {
  const r = repo({ "a.ts": "process.env.ANTHROPIC_API_KEY = originalKey;\n" });
  try {
    assert.equal(run(r.dir).code, 0);
  } finally { r.done(); }
});

function runHook(dir: string, command: string) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: dir });
  const r = spawnSync("bash", [hook], {
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: resolve(".") },
  });
  return { code: r.status, err: r.stderr };
}

test("フックは検査が落ちたとき git push だけを exit 2 で止める", () => {
  const r = repo({ "docs/a.md": `${fakeAnthropic}\n` });
  try {
    for (const c of ["git push", "git push -u origin main", "git -C x push", "cd a && git push origin HEAD"]) {
      const h = runHook(r.dir, c);
      assert.equal(h.code, 2, c);
      assert.match(h.err, /docs\/a\.md:1/);
      assert.ok(!h.err.includes(fakeAnthropic));
    }
    for (const c of ["git status", "git commit -m 'git push'", "echo git pushed", "git log --oneline", "ls"])
      assert.equal(runHook(r.dir, c).code, 0, c);
  } finally { r.done(); }
});

test("フックは検査が通れば git push も通す", () => {
  const r = repo({ "docs/a.md": "問題なし\n" });
  try {
    assert.equal(runHook(r.dir, "git push origin main").code, 0);
  } finally { r.done(); }
});
