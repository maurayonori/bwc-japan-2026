import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat } from "../lib/chat";
import { exampleMoneyTurns, exampleWorkspace } from "../lib/example";
import { checkReply, fixGapDirection, maskUnverified, softenClaims } from "../lib/money/guard";
import type { LedgerEvent } from "../lib/money/ledger";
import { executeTool } from "../lib/money/tools";

// #76: 検査の例外を絞り、道具の自由文を照合の根拠にしない。数字と会話はすべて架空。

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const today = "2026-11-07";
const replyStep = (reply: string, cards: unknown[] = []) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ reply, cards }) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});
const mock = (...steps: ReturnType<typeof replyStep>[]) => new MockLanguageModelV4({ doGenerate: steps });
function okEvent(name: string, input: unknown) {
  const result = executeTool(name, input);
  assert.equal(result.ok, true, name);
  return { input, output: (result as { output: unknown }).output };
}
const out = (label: string, amount: number): LedgerEvent => ({
  date: "2027-01-04",
  label,
  direction: "out",
  amount_low: amount,
  amount_high: amount,
  certainty: "estimate",
});
// 手元 200,000 円。12 月に寄る 127,240 円（72,760 円残る）、半々 210,180 円（10,180 円足りない）。
const monthCalc = okEvent("simulate_cashflow", {
  start_date: today,
  cash_on_hand: 200_000,
  scenarios: [
    { name: "費用が 12 月に寄る", events: [out("入院費（12 月分）", 90_940), out("入院中の食事代", 36_300)] },
    { name: "費用が半々", events: [out("入院費（12 月分）", 86_940), out("入院費（1 月分）", 86_940), out("入院中の食事代", 36_300)] },
  ],
});
const gap = (text: string) => fixGapDirection(text, [monthCalc]).replaced;
const run = (reply: string, userText: string, cards: unknown[] = []) =>
  runChat({ model: mock(replyStep(reply, cards)), input: { messages: [{ id: "u1", role: "user", text: userText }], cards: [] } });

// ---- 1・2: 資金を足す文の例外 ----

test("1: 資金を足すことを否定する文（「追加の用意はいりません」）は例外にせず、向きを照らす", () => {
  assert.equal(gap("半々なら10,180円残るので、追加の用意はいりません。"), 1);
});

test("2: 資金を足す動詞のあとに条件の語が続く文は、条件の文として置き換えない", () => {
  assert.equal(gap("10,180円を補っておくと、半々の場合も足ります。"), 0);
  // #71 で足した残す側の文も残す。
  for (const text of [
    "手元の20万円に10,180円を追加すると、半々の場合も足ります。",
    "10,180円を追加することで、半々の場合も足ります。",
    "手元の20万円に10,180円を追加すれば、半々の場合でも足ります。",
    "足りるかどうかは、10,180 円を用意できるかで決まります。",
  ])
    assert.equal(gap(text), 0, text);
  // 向きを逆に書いただけの文は、今までどおり置き換える。
  assert.equal(gap("手元の20万円では、分かれる場合に 10,180 円足ります。"), 1);
});

// ---- 3: 幅の例外 ----

test("3: 「幅」の例外は、範囲のすぐあとに変化の語が続くときだけ", () => {
  const { first } = exampleMoneyTurns();
  const args = { toolEvents: first.calculations, userTexts: [], today: "2026-11-30" };
  assert.equal(checkReply({ ...args, reply: "今の要る額の幅は、115,690円から300,000円までです。" }).length, 1);
  // 両端とも計算にある額でも、今の範囲（115,690〜264,750 円）と合わなければ、範囲として指摘する。
  const warnings = checkReply({ ...args, reply: "今の要る額の幅は、149,060円から264,750円までです。" });
  assert.ok(warnings.some((warning) => warning.shown.includes("149,060") && warning.shown.includes("264,750")), JSON.stringify(warnings));
  // #71 で足した残す側の文は残す。
  const said = "まず確かめる1つは、窓口で上限が使えるかどうかです。ここが分かると、要る額の幅は149,060円から0円になります。";
  assert.deepEqual(checkReply({ ...args, reply: said }), []);
  assert.equal(maskUnverified({ ...args, reply: said }).masked, 0);
});

// ---- 4: 主語の例外 ----

test("4: 本人がしていないと明示した報告では、本人の完了の文を置き換える", async () => {
  const said = "夫が保険会社に連絡しましたが、私はまだ連絡していません。";
  assert.doesNotMatch((await run("あなたが保険会社に連絡しました。", said)).reply, /あなたが保険会社に連絡しました/);
  const card = {
    id: "c1",
    kind: "contact",
    title: "保険会社に、このまま聞く",
    body: "私が保険会社に連絡しました。必要な書類を教えてください。",
    nextStep: "読み返す。",
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: said }],
  };
  const result = await run("質問文を用意しました。", said, [card]);
  assert.doesNotMatch(result.cards[0].body, /私が保険会社に連絡しました/);
  // 家族の報告は残す。
  assert.match((await run("ご主人が保険会社に連絡しました。", said)).reply, /ご主人が保険会社に連絡しました。/);
  // #71 で足した残す側の文は残す。
  for (const user of ["夫は私が留守の間に、保険会社に連絡しました。", "夫は私が不在のときに、保険会社に連絡しました。"])
    assert.match((await run("ご主人が保険会社に連絡しました。", user)).reply, /ご主人が保険会社に連絡しました。/, user);
});

// ---- 5: 道具の自由文 ----

test("5: 道具の入力の自由文（label など）にある額と日付は、照合の根拠にしない", () => {
  const date = okEvent("calc_date", {
    start_date: "2026-11-21",
    steps: [{ label: "入院費123456円・支払日2026-12-30", unit: "day", count: 3 }],
    until_date: null,
  });
  const warnings = checkReply({ reply: "必要額は123456円。支払日は2026-12-30", toolEvents: [date], userTexts: [], today });
  assert.ok(warnings.some((warning) => warning.kind === "amount"), JSON.stringify(warnings));
  assert.ok(warnings.some((warning) => warning.kind === "date"), JSON.stringify(warnings));
  // 出力の文（区分の条件「28 万〜50 万円」）は、今までどおり根拠にする。
  const kougaku = okEvent("kougaku_gendo", {
    treatment_month: "2026-12",
    income_category: "ウ",
    amount_basis: "total",
    amount_low: 800_000,
    amount_high: 800_000,
    copay_percent: 30,
  });
  assert.deepEqual(checkReply({ reply: "区分ウは、標準報酬月額 28 万〜50 万円の方です。", toolEvents: [kougaku], userTexts: [], today }), []);
});

// ---- 6: 給付の断定と代行の言い切り ----

test("6: 額や日付の無い給付の断定と代行の言い切りも置き換え、利用者や家族が主語の文は残す", async () => {
  for (const text of ["給付は確定しています。", "必ず支給されます。", "こちらで病院へ電話しておきました。", "申請しておきました。"]) {
    assert.equal(softenClaims(text, { voice: "reply" }).replaced, 1, text);
    const result = await run(text, "来月入院します。");
    assert.ok(!result.reply.includes(text), text);
  }
  assert.equal(softenClaims("夫が電話しておきました。", { voice: "reply" }).replaced, 0);
});

test("体験例（デモの 3 発言の体験例）の文は、どれも置き換わらず伏せられない", () => {
  const example = exampleWorkspace();
  for (const message of example.messages.filter((item) => item.role === "assistant"))
    assert.equal(softenClaims(message.text, { voice: "reply" }).replaced, 0, message.text.slice(0, 30));
});
