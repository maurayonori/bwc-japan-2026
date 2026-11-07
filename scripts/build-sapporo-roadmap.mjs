#!/usr/bin/env node
// data/items/*.yaml から、札幌の子育て年表（docs/prototypes/sapporo-roadmap.html）の埋め込みデータを作る。依存なし。
// 使い方: node scripts/build-sapporo-roadmap.mjs          HTML の <script id="data"> を書き換える
//         node scripts/build-sapporo-roadmap.mjs --check  書き換えが要るなら exit 1（HTML が YAML と食い違っていないかの確認）
// 読むのは人が確かめた data/items/ だけ。data/candidates/ は読まない。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "docs", "prototypes", "sapporo-roadmap.html");
const ITEM_FILES = ["procedures", "vaccines", "childcare-registration"];
const KINDS = new Set([
  "birth_offset",
  "age_start",
  "annual_period",
  "application_window",
  "after_previous",
  "before_milestone",
]);

// ---- YAML の小さなパーサ ----
// data/items/ で使っている書き方だけを読む: ブロックの対応表と列、フローの {} と []、
// プレーン・単引用符・二重引用符の文字列（複数行の折り返しを含む）、行末のコメント。
// アンカー、タグ、ブロック文字列（| と >）は data/items/ に無いので読まない（あれば例外にする）。
export function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const indentOf = (l) => /^ */.exec(l)[0].length;
  const isBlank = (l) => /^\s*(#.*)?$/.test(l);
  const isSeqLine = (l) => /^\s*-( |$)/.test(l);
  const skipBlank = () => {
    while (i < lines.length && isBlank(lines[i])) i++;
  };
  const fail = (msg) => {
    throw new Error(`YAML ${i + 1} 行目: ${msg}`);
  };

  function parseNode(indent) {
    skipBlank();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < indent) return null;
    return isSeqLine(lines[i]) ? parseSeq(ind) : parseMap(ind);
  }

  function parseSeq(ind) {
    const arr = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const l = lines[i];
      if (indentOf(l) !== ind || !isSeqLine(l)) break;
      const after = l.slice(ind + 1);
      const rest = after.replace(/^ +/, "");
      const contentIndent = ind + 1 + (after.length - rest.length);
      if (rest === "" || rest.startsWith("#")) {
        i++;
        arr.push(parseNode(ind + 1));
      } else if (keyMatch(rest)) {
        lines[i] = " ".repeat(contentIndent) + rest; // 「- key: v」を対応表の 1 行目として読み直す
        arr.push(parseMap(contentIndent));
      } else {
        arr.push(parseValue(rest, ind));
      }
    }
    return arr;
  }

  function keyMatch(s) {
    return /^([^\s:#'"{[][^:]*?):(?: +(.*))?$/.exec(s);
  }

  function parseMap(ind) {
    const obj = {};
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const l = lines[i];
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) fail("字下げが合わない");
      if (isSeqLine(l)) break;
      const m = keyMatch(l.slice(ind));
      if (!m) fail("「キー: 値」の形ではない");
      const key = m[1];
      if (Object.hasOwn(obj, key)) fail(`キー ${key} が重複している`);
      const rest = m[2] ?? "";
      if (rest === "" || rest.startsWith("#")) {
        i++;
        skipBlank();
        if (i < lines.length) {
          const nl = lines[i];
          const ni = indentOf(nl);
          if (ni > ind || (ni === ind && isSeqLine(nl))) {
            obj[key] = parseNode(ni);
            continue;
          }
        }
        obj[key] = null;
      } else {
        obj[key] = parseValue(rest, ind);
      }
    }
    return obj;
  }

  // 値を 1 つ読み、使った行を進める。parentIndent より深い行は折り返しの続きとして扱う
  function parseValue(rest, parentIndent) {
    if (/^[|>]/.test(rest)) fail("ブロック文字列は読まない");
    if (/^[&*!]/.test(rest)) fail("アンカー・タグは読まない");
    if (rest[0] === "'" || rest[0] === '"') return parseQuoted(rest, parentIndent);
    if (rest[0] === "{" || rest[0] === "[") {
      const src = stripComment(rest);
      i++;
      const [v, end] = parseFlow(src, 0);
      if (src.slice(end).trim() !== "") fail("フローの後ろに余計な文字がある");
      return v;
    }
    // プレーン（複数行は空白 1 つで折り返す。空行は改行）
    let s = stripComment(rest).trim();
    const ended = s.length !== rest.trim().length; // 行末コメントがあれば、そこで値は終わる
    i++;
    if (!ended) {
      let blank = 0;
      while (i < lines.length) {
        const l = lines[i];
        if (/^\s*$/.test(l)) {
          blank++;
          i++;
          continue;
        }
        if (indentOf(l) <= parentIndent || /^\s*#/.test(l)) {
          i -= blank; // 空行は次の要素のために戻す
          break;
        }
        const t = stripComment(l).trim();
        s += blank > 0 ? "\n".repeat(blank) + t : " " + t;
        blank = 0;
        i++;
        if (t.length !== l.trim().length) break;
      }
    }
    return resolvePlain(s);
  }

  function parseQuoted(rest, parentIndent) {
    const q = rest[0];
    let out = "";
    let line = rest.slice(1);
    for (;;) {
      let j = 0;
      let closed = false;
      while (j < line.length) {
        const c = line[j];
        if (q === "'" && c === "'") {
          if (line[j + 1] === "'") {
            out += "'";
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        if (q === '"' && c === "\\") {
          const n = line[j + 1];
          const map = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", "0": "\0", r: "\r" };
          if (n === "u") {
            out += String.fromCharCode(parseInt(line.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          if (!(n in map)) fail(`読めないエスケープ \\${n}`);
          out += map[n];
          j += 2;
          continue;
        }
        if (q === '"' && c === '"') {
          closed = true;
          break;
        }
        out += c;
        j++;
      }
      if (closed) {
        const tail = line.slice(j + 1);
        if (stripComment(tail).trim() !== "") fail("引用符の後ろに余計な文字がある");
        i++;
        return out;
      }
      // 次の行へ折り返す
      out = out.replace(/[ \t]+$/, "");
      i++;
      let breaks = 0;
      while (i < lines.length && /^\s*$/.test(lines[i])) {
        breaks++;
        i++;
      }
      if (i >= lines.length) fail("引用符が閉じていない");
      if (indentOf(lines[i]) <= parentIndent) fail("引用符の続きの字下げが浅い");
      out += breaks > 0 ? "\n".repeat(breaks) : " ";
      line = lines[i].replace(/^\s+/, "");
    }
  }

  function stripComment(s) {
    let q = null;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (q) {
        if (c === q) q = null;
        continue;
      }
      if ((c === "'" || c === '"') && (j === 0 || /[\s,[{:]/.test(s[j - 1]))) q = c;
      else if (c === "#" && (j === 0 || /\s/.test(s[j - 1]))) return s.slice(0, j);
    }
    return s;
  }

  function parseFlow(s, p) {
    const ws = () => {
      while (p < s.length && /\s/.test(s[p])) p++;
    };
    ws();
    if (s[p] === "{" || s[p] === "[") {
      const close = s[p] === "{" ? "}" : "]";
      const isMap = s[p] === "{";
      const out = isMap ? {} : [];
      p++;
      ws();
      if (s[p] === close) return [out, p + 1];
      for (;;) {
        if (isMap) {
          const km = /^([^:,{}[\]\s][^:,{}[\]]*?)\s*:\s*/.exec(s.slice(p));
          if (!km) fail("フローの対応表のキーを読めない");
          p += km[0].length;
          const [v, np] = parseFlow(s, p);
          out[km[1]] = v;
          p = np;
        } else {
          const [v, np] = parseFlow(s, p);
          out.push(v);
          p = np;
        }
        ws();
        if (s[p] === ",") {
          p++;
          ws();
          continue;
        }
        if (s[p] === close) return [out, p + 1];
        fail("フローが閉じていない");
      }
    }
    if (s[p] === "'" || s[p] === '"') {
      const q = s[p];
      let out = "";
      p++;
      while (p < s.length) {
        if (s[p] === q) {
          if (q === "'" && s[p + 1] === "'") {
            out += "'";
            p += 2;
            continue;
          }
          return [out, p + 1];
        }
        out += s[p++];
      }
      fail("フローの引用符が閉じていない");
    }
    const m = /^[^,{}[\]]*/.exec(s.slice(p));
    return [resolvePlain(m[0].trim()), p + m[0].length];
  }

  function resolvePlain(s) {
    if (s === "" || s === "~" || /^(null|Null|NULL)$/.test(s)) return null;
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    if (/^[-+]?\d+$/.test(s)) return Number(s);
    if (/^[-+]?(\d+\.\d*|\.\d+)$/.test(s)) return Number(s);
    return s; // 日付（2026-11-04）も文字列のまま持つ
  }

  const doc = parseNode(0);
  skipBlank();
  if (i < lines.length) fail("読み残しがある");
  return doc;
}

// ---- 表示に要る項目だけを抜き出す ----

// 括弧と鉤括弧の外の「。」で文を分ける（括弧の中の。で切らない）
export function sentences(text) {
  if (!text) return [];
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of text) {
    cur += c;
    if ("（「『(".includes(c)) depth++;
    else if ("）」』)".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "。" && depth === 0) {
      out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const httpsUrl = (u, where) => {
  if (typeof u !== "string" || !/^https:\/\/[^\s"'<>]+$/.test(u))
    throw new Error(`${where}: 出典 URL が https で始まっていない`);
  return u;
};

function compactItem(it) {
  const where = it.id;
  if (!it.id || !it.name) throw new Error(`id か name が無い項目がある`);
  if (!KINDS.has(it.schedule?.kind)) throw new Error(`${where}: 期日の決まり方（schedule.kind）が無いか不明`);
  if (!DATE_RE.test(String(it.checked_on))) throw new Error(`${where}: 確認日が無い`);
  if (!it.evidence) throw new Error(`${where}: 根拠の抜粋が無い`);
  const e = it.eligibility ?? {};
  const notes = sentences(it.notes);
  const out = {
    id: it.id,
    domain: it.domain,
    muni: it.municipality,
    name: it.name,
    age: [e.age_months?.from ?? 0, e.age_months?.to ?? null],
    work: e.work_status ?? null,
    nursery: e.nursery ?? null,
    nc: e.needs_check === true,
    schedule: it.schedule,
    prep: it.prep_days ?? null,
    cost: { amount: it.cost?.amount ?? null, subsidy: it.cost?.subsidy ?? null },
    // 出典と同じ URL と null の欄は省く（画面では url が無ければ出典へリンクする）
    contacts: (it.contacts ?? []).map((c) =>
      dropNull({
        ward: c.ward,
        name: c.name,
        url: c.url && c.url !== it.source_url ? httpsUrl(c.url, where) : null,
        phone: c.phone,
      }),
    ),
    src: httpsUrl(it.source_url, where),
    chk: String(it.checked_on),
    ev: it.evidence,
    // notes から「要確認」と「必要なもの」の文だけを原文のまま抜く（言い換えない）
    check: notes.filter((s) => s.includes("要確認")),
    need: notes.filter((s) => /必要書類|必要なもの|持ち物/.test(s)),
    // 出典に「閉庁日なら翌開庁日まで」とある項目だけ、締切を後ろへずらす
    closedRule: /閉庁日の場合、翌開庁日/.test(it.notes ?? "") ? "next" : null,
  };
  if (e.age_limit_note) out.ageNote = e.age_limit_note;
  return out;
}

function compactEvent(ev) {
  const where = ev.id;
  if (!DATE_RE.test(String(ev.checked_on))) throw new Error(`${where}: 確認日が無い`);
  if (!ev.evidence) throw new Error(`${where}: 根拠の抜粋が無い`);
  const a = ev.applies_to ?? {};
  return {
    id: ev.id,
    kind: ev.kind,
    name: ev.name,
    age: a.age_months ? [a.age_months.from ?? 0, a.age_months.to ?? null] : null,
    nursery: a.nursery ?? null,
    months: a.months ?? null,
    value: ev.measure?.value ?? null,
    unit: ev.measure?.unit ?? null,
    stat: ev.measure?.stat ?? null,
    basis: ev.measure?.basis ?? null,
    src: httpsUrl(ev.source_url, where),
    chk: String(ev.checked_on),
    ev: ev.evidence,
  };
}

// 区の source_urls は画面で使わない（窓口ごとの url を出典として出す）
function compactWard(w) {
  if (!DATE_RE.test(String(w.checked_on))) throw new Error(`${w.name}: 確認日が無い`);
  for (const o of w.offices ?? []) if (!o.url) throw new Error(`${w.name} ${o.name}: 出典 URL が無い`);
  return {
    name: w.name,
    chk: String(w.checked_on),
    offices: (w.offices ?? []).map((o) =>
      dropNull({ role: o.role, name: o.name, url: httpsUrl(o.url, w.name), phone: o.phone, address: o.address }),
    ),
  };
}

function dropNull(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}

export function loadYaml(root = ROOT) {
  const read = (f) => parseYaml(readFileSync(join(root, "data", "items", `${f}.yaml`), "utf8"));
  return {
    items: ITEM_FILES.flatMap((f) => read(f).items),
    events: read("events").events,
    wards: read("wards").wards,
  };
}

export function buildData(root = ROOT) {
  const y = loadYaml(root);
  const data = {
    items: y.items.map(compactItem),
    events: y.events.map(compactEvent),
    wards: y.wards.map(compactWard),
  };
  const ids = [...data.items, ...data.events].map((x) => x.id);
  const dup = ids.find((id, k) => ids.indexOf(id) !== k);
  if (dup) throw new Error(`id が重複している: ${dup}`);
  return data;
}

// </script> を閉じないよう < を < にする
export function embed(data) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .split(LS).join("\\u2028")
    .split(PS).join("\\u2029");
}

const DATA_RE = /(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/;

export function render(html, data) {
  if (!DATA_RE.test(html)) throw new Error('HTML に <script id="data" type="application/json"> が無い');
  return html.replace(DATA_RE, (_, a, __, c) => a + embed(data) + c);
}

function main() {
  const check = process.argv.includes("--check");
  const html = readFileSync(HTML, "utf8");
  const data = buildData();
  const next = render(html, data);
  const counts = `手続き・予防接種・預け先 ${data.items.length} 件、起きうること ${data.events.length} 件、区 ${data.wards.length} 区`;
  if (check) {
    if (next !== html) {
      console.error("sapporo-roadmap: 埋め込みデータが YAML と食い違っている。node scripts/build-sapporo-roadmap.mjs で作り直す");
      return 1;
    }
    console.log(`sapporo-roadmap: 埋め込みデータは YAML と一致（${counts}）`);
    return 0;
  }
  writeFileSync(HTML, next);
  console.log(`sapporo-roadmap: ${counts} を埋め込んだ（${Buffer.byteLength(next)} バイト）`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
