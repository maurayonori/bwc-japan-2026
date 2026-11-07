// #85: 見通しを 1 回だけ呼んだ回でも、検査が前の回の見通しを本線に選び、正しい幅を伏せていた（#83 の後退）。
// 本線は、今回の回に見通しがあれば今回の見通しから選び、今回に無いときだけ前の回までさかのぼる。数字と会話はすべて架空。
import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat } from "../lib/chat";
import { exampleMoneyTurns } from "../lib/example";
import { checkReply, fixGapDirection, maskUnverified } from "../lib/money/guard";
import { mainCashflowIndex } from "../lib/money/main-cashflow";
import { executeTool } from "../lib/money/tools";
import { exportMemo, requestSchema, type Card } from "../lib/workspace";

const TODAY = "2026-11-30";
const SAID_1 =
  "12月14日に入院して、28日に退院する予定です。病院の見積もりだと、医療費は総額で80万円くらい。協会けんぽで、給料は月35万円くらいです。すぐ使えるお金は20万円。";
const SAID_2 =
  "病院の窓口で、退院のときの支払いは15万円から20万円くらいと言われました。家族の交通費は1万円から2万円くらいです。";
// 今回の見通し: 病院の見積もり 150,000〜200,000 円と、交通費 10,000〜20,000 円（内訳の計算は呼ばない）。
const THIS_TURN = {
  start_date: TODAY,
  cash_on_hand: 200_000,
  scenarios: [
    {
      name: "病院の見積もり",
      events: [
        { date: "2026-12-28", label: "退院のときの支払い", direction: "out", amount_low: 150_000, amount_high: 200_000, certainty: "estimate" },
        { date: "2026-12-28", label: "家族の交通費", direction: "out", amount_low: 10_000, amount_high: 20_000, certainty: "assumption" },
      ],
    },
  ],
};
const REPLY = "要る額は160,000円〜220,000円です。";

function thisTurnEvent() {
  const result = executeTool("simulate_cashflow", THIS_TURN);
  assert.equal(result.ok, true);
  return { input: THIS_TURN, output: (result as { output: unknown }).output };
}

test("#85: 今回の見通しを 1 回だけ呼んだ回は、今回の見通しを本線にし、正しい幅を伏せない", () => {
  const { first } = exampleMoneyTurns();
  const toolEvents = [...first.calculations, thisTurnEvent()];
  const from = first.calculations.length;
  assert.equal(mainCashflowIndex(toolEvents, from), from);
  const args = { toolEvents, userTexts: [SAID_1, SAID_2], today: TODAY, currentFrom: from };
  assert.deepEqual(checkReply({ ...args, reply: REPLY }), []);
  assert.equal(maskUnverified({ ...args, reply: REPLY }).masked, 0);
  // 今回に見通しが無いときは、前の回の見通しまでさかのぼる（#83 の前と同じ）。
  assert.equal(mainCashflowIndex(first.calculations, first.calculations.length), first.calculations.findIndex((item) => item.name === "simulate_cashflow"));
});

test("#85: 会話の中でも、今回の見通しで照らし、前の回の幅を「前は…でした」と書いた文も伏せない", async () => {
  const { first } = exampleMoneyTurns();
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 50, text: 50, reasoning: 0 },
  };
  const reply = `前は115,690円から264,750円でした。${REPLY}`;
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "simulate_cashflow", input: JSON.stringify(THIS_TURN) }],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text" as const, text: JSON.stringify({ reply, cards: [] }) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
  const card = {
    id: "m1",
    kind: "money",
    title: "支払日までに、手元に要る額",
    body: "表を読む。",
    nextStep: "読み返す。",
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: SAID_1 }],
    edited: false,
    done: false,
    included: false,
    money: { calculations: first.calculations.map(({ name, input }) => ({ name, input })) },
  };
  const result = await runChat({
    model,
    input: requestSchema.parse({
      messages: [
        { id: "u1", role: "user", text: SAID_1 },
        { id: "a1", role: "assistant", text: "手元に要る額は 115,690 円か 264,750 円です。" },
        { id: "u2", role: "user", text: SAID_2 },
      ],
      cards: [card],
    }),
  });
  assert.equal(result.reply, reply);
  assert.deepEqual(result.warnings, []);
});

test("#85: 足りない額の向きも、本線の見通しで照らす（試し呼びが最後でも、最後の見通しを見ない）", () => {
  const { first } = exampleMoneyTurns();
  // 体験例の発言 1 と同じ回のあとに、筋書き「x」・1 円の試し呼び（#82）が来た。
  const trialInput = {
    start_date: TODAY,
    cash_on_hand: 200_000,
    scenarios: [{ name: "x", events: [{ date: "2026-12-28", label: "x", direction: "out", amount_low: 1, amount_high: 1, certainty: "assumption" }] }],
  };
  const trial = executeTool("simulate_cashflow", trialInput);
  assert.equal(trial.ok, true);
  const toolEvents = [...first.calculations, { input: trialInput, output: (trial as { output: unknown }).output }];
  // 本線（いったん 3 割を払う場合 264,750 円）では 64,750 円足りない。「足ります」は向きが逆。
  const fixed = fixGapDirection("いったん3割を払う場合は 64,750 円足ります。", toolEvents, 0);
  assert.equal(fixed.replaced, 1);
  assert.match(fixed.text, /64,750 円足りない/);
});

test("#85: 持ち出しでも、本線の見通しはそのカード自身の計算から選ぶ（別のカードの見通しで伏せない）", () => {
  const { first } = exampleMoneyTurns();
  const money = (id: string, calculations: unknown[], body: string, included: boolean): Card => ({
    id,
    kind: "money",
    title: "支払日までに、手元に要る額",
    body,
    nextStep: "読み返す。",
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: SAID_1 }],
    edited: false,
    done: false,
    included,
    money: { calculations: calculations as never },
  });
  const earlier = money("m1", first.calculations, "表を読む。", false);
  const now = money("m2", [{ name: "simulate_cashflow", ...thisTurnEvent() }], REPLY, true);
  const messages = [
    { id: "u1", role: "user" as const, text: SAID_1 },
    { id: "u2", role: "user" as const, text: SAID_2 },
  ];
  for (const cards of [[earlier, now], [now, earlier]]) {
    const text = exportMemo(cards, messages);
    assert.match(text, /要る額は160,000円〜220,000円です。/);
    assert.doesNotMatch(text, /照合できない/);
  }
});
