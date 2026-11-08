import { test } from "node:test";
import assert from "node:assert/strict";
import { FACTS } from "../lib/money/facts";
import { buildSystem, type SystemBlock } from "../lib/prompt";
import { TOOLS } from "../lib/money/tools";

test("システムプロンプトは、変わらない部分と今日の日付の 2 ブロックに分かれる", () => {
  const system = buildSystem("2026-11-06");
  assert.equal(system.length, 2);
  assert.deepEqual(system[0].providerOptions?.anthropic.cacheControl, {
    type: "ephemeral",
  });
  assert.equal("providerOptions" in system[1], false);
  assert.match(system[1].content, /2026-11-06（金曜日）/);
});

test("変わらない部分は、日付が違っても同じ文字列になる（キャッシュと思考ブロックのため）", () => {
  assert.equal(
    buildSystem("2026-11-06")[0].content,
    buildSystem("2027-01-15")[0].content,
  );
  assert.doesNotMatch(buildSystem("2026-11-06")[0].content, /2026-11-06/);
});

test("セッションのあいだ書き換えられない", () => {
  const system = buildSystem("2026-11-06") as SystemBlock[];
  assert.throws(() => {
    system[0].content = "x";
  }, TypeError);
  assert.throws(() => {
    system.push(system[0]);
  }, TypeError);
});

test("ADR 0007 の約束が入っている", () => {
  const text = buildSystem("2026-11-06")[0].content;
  for (const phrase of [
    "項目を埋めてもらう道具ではありません",
    "最初の返答から見通しを出す",
    "1 回の返答で 1 つまで",
    "必ず道具を呼ぶ",
    "確かめていない入金",
    "医学的な見通しや確率を言わない",
    "言い切らない",
    "代わりに行ったとは言わない",
    "画面に無い言葉で呼ばない",
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("「まず確かめる 1 つ」の読み方と、答えを反映する呼び直しが入っている", () => {
  const text = buildSystem("2026-11-06")[0].content;
  for (const phrase of [
    "what_to_confirm.factors",
    "「まず確かめる 1 つ」として 1 行で書く",
    "width_if_resolved",
    "このまま聞く",
    "certainty を confirmed にする",
    "前の width から新しい width",
    "同じ label は 1 つの不明点として数える",
    "いったん 3 割を払う筋書きを並べる",
    "まず確かめる 1 つの前後の幅",
    "先頭の shrink が 0 のときは",
    "答えごとに何が決まるかを書く",
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
});

test("すべての道具の名前と、すべての事実の番号が入っている", () => {
  const text = buildSystem("2026-11-06")[0].content;
  for (const tool of TOOLS) assert.ok(text.includes(tool.name), tool.name);
  for (const fact of FACTS) assert.ok(text.includes(`[${fact.id}]`), fact.id);
});

test("事実は、番号が重ならず、出典の URL と確認日を持つ", () => {
  assert.equal(new Set(FACTS.map((fact) => fact.id)).size, FACTS.length);
  for (const fact of FACTS) {
    assert.match(fact.id, /^F\d{2}$/);
    assert.ok(fact.sources.length >= 1, fact.id);
    for (const item of fact.sources)
      assert.match(item.url, /^https:\/\//, fact.id);
    assert.match(fact.checked_on, /^2026-11-0[56]$/, fact.id);
    assert.ok(["primary", "transcribed"].includes(fact.verified), fact.id);
  }
});

// 11/8 の実 API の評価で、「来月の3日」を Claude が自分で「12/3」に直して書き、照らせない日付として伏せられた回があった。
test("相対の言い方を日付に直すときは calc_date で求める", () => {
  const text = buildSystem("2026-11-08")[0].content;
  assert.ok(text.includes("「来月の3日」「2週間後」のような言い方を日付に直すときは calc_date で求める"));
});

// 11/8 の実 API の評価で、「このアプリは何ができますか？」に、話し方の例として「給料は月30万円」と書き、伏せられた（2 回中 2 回）。
test("使い方の説明や話し方の例に、話されていない金額や日付を書かない", () => {
  const text = buildSystem("2026-11-08")[0].content;
  assert.ok(text.includes("使い方の説明や話し方の例に、利用者が話していない金額や日付を書かない"));
});
