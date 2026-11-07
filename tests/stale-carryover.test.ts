import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat } from "../lib/chat";
import { exampleMoneyTurns } from "../lib/example";
import { STALE_CASHFLOW_WARNING } from "../lib/money/attach";
import { paydayTable } from "../lib/money/format";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import { calculationSchema } from "../lib/money/schema";
import { needRangeOf } from "../lib/views";
import { exportMemo, type Card, type ChatRequest } from "../lib/workspace";

// #80 への Codex の指摘（高 2・中 2）の再現（#77、ADR 0019）。

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const toolStep = (name: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: `call-${name}`, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
const textStep = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});
const mock = (...steps: ReturnType<typeof textStep | typeof toolStep>[]) =>
  new MockLanguageModelV4({ doGenerate: steps });

const KOUGAKU_160 = {
  treatment_month: "2026-12",
  income_category: "ウ",
  amount_basis: "total",
  amount_low: 1_600_000,
  amount_high: 1_600_000,
  copay_percent: 30,
};
const CALC_DATE = { start_date: "2026-12-14", steps: [], until_date: "2026-12-28" };
const TEXT = "総額は160万円でした。退院は28日の予定です。";

// 1 回目: 体験例の 1 回目の見通しを残したまま、総額 160 万円の内訳だけを計算し直し、見通しを計算し直せなかった（印あり）。
function staleMoneyRequest() {
  const { first } = exampleMoneyTurns();
  const refs = first.calculations
    .filter((calculation) => calculation.name !== "kougaku_gendo")
    .map(({ name, input }) => ({ name, input }));
  return {
    calculations: [...refs, { name: "kougaku_gendo", input: KOUGAKU_160 }],
    stale_cashflow: true as const,
  };
}

function staleRequest(): ChatRequest {
  return {
    messages: [{ id: "u1", role: "user", text: TEXT }],
    cards: [
      {
        id: "money-1",
        kind: "money",
        title: "お金の見通し",
        body: "計算の結果を表にしました。",
        nextStep: "表を読む。",
        uncertainty: "",
        evidence: [{ messageId: "u1", quote: "総額は160万円でした。" }],
        edited: false,
        done: false,
        included: false,
        money: staleMoneyRequest(),
      },
    ] as ChatRequest["cards"],
  };
}

test("（高 1）見通しを計算し直していない次の回で、日付だけ計算して文章の生成に失敗しても、印と警告は消えない", async () => {
  const model = mock(toolStep("calc_date", CALC_DATE), textStep("x"));
  const result = await runChat({ model, input: staleRequest() });
  const card = result.cards.find((item) => item.kind === "money");
  assert.ok(card?.money);
  assert.equal(card.money.stale_cashflow, true);
  assert.ok(result.warnings.some((warning) => warning.message === STALE_CASHFLOW_WARNING));
  assert.equal(needRangeOf({ ...card, edited: false, done: false, included: false }), null);
});

test("（高 1）印は、見通しの計算し直しが成功した回でだけ外れる", async () => {
  const { first } = exampleMoneyTurns();
  const cashflow = first.calculations.find((item) => item.name === "simulate_cashflow");
  assert.ok(cashflow?.name === "simulate_cashflow");
  const input = structuredClone(cashflow.input) as { scenarios: { events: { label: string; amount_low: number; amount_high: number }[] }[] };
  const fresh = kougakuGendo(KOUGAKU_160).cases[0].low;
  for (const [index, scenario] of input.scenarios.entries())
    for (const event of scenario.events)
      if (event.label.startsWith("入院費")) {
        const amount = index === 0 ? fresh.pay_with_cap : fresh.copay_without_cap;
        event.amount_low = amount;
        event.amount_high = amount;
      }
  const reply = JSON.stringify({ reply: "計算し直しました。", cards: [] });
  const model = mock(toolStep("simulate_cashflow", input), textStep(reply));
  const result = await runChat({ model, input: staleRequest() });
  const card = result.cards.find((item) => item.kind === "money");
  assert.ok(card?.money);
  assert.equal(card.money.stale_cashflow, undefined);
  assert.ok(!result.warnings.some((warning) => warning.message === STALE_CASHFLOW_WARNING));
  assert.deepEqual(needRangeOf({ ...card, edited: false, done: false, included: false })?.low, 123_690);
});

test("（高 2）印の付いた見通しは、返答の今の額の照合の根拠にしない", async () => {
  const reply = JSON.stringify({ reply: "今の支払日に要る額は115,690円です。", cards: [] });
  const model = mock(toolStep("calc_date", CALC_DATE), textStep(reply));
  const result = await runChat({ model, input: staleRequest() });
  assert.equal(result.reply.includes("115,690"), false, result.reply);
});

test("（高 2）印の付いた見通しは、持ち出しの今の額の照合の根拠にせず、前の条件の注記を出す", () => {
  const { first } = exampleMoneyTurns();
  const calculations = [
    ...first.calculations.filter((calculation) => calculation.name !== "kougaku_gendo"),
    calculationSchema.parse({ name: "kougaku_gendo", input: KOUGAKU_160, output: kougakuGendo(KOUGAKU_160) }),
  ];
  const money: Card = {
    id: "money-1",
    kind: "money",
    title: "お金の見通し",
    body: "計算の結果を表にしました。",
    nextStep: "表を読む。",
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: "総額は160万円でした。" }],
    edited: false,
    done: false,
    included: false,
    money: { calculations, stale_cashflow: true },
  };
  const contact: Card = {
    id: "hospital-desk",
    kind: "contact",
    title: "病院の会計に聞く",
    body: "今の支払日に要る額は115,690円〜264,750円です。窓口で上限が使えるかを教えてください。",
    nextStep: "病院の会計に聞く。",
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: "総額は160万円でした。" }],
    edited: false,
    done: false,
    included: true,
  };
  const memo = exportMemo([money, contact]);
  assert.equal(memo.includes("115,690"), false, memo);
  assert.equal(memo.includes("264,750"), false, memo);
  assert.ok(memo.includes("前の条件での計算"), memo);
});

test("（中 3）入金に幅があっても、確かさの列に未確認の入金の確かさが入る", () => {
  const output = simulateCashflow({
    start_date: "2026-11-07",
    cash_on_hand: 0,
    scenarios: [
      {
        name: "見通し",
        events: [
          { date: "2026-11-08", label: "給付金", direction: "in", amount_low: 0, amount_high: 100_000, certainty: "assumption" },
          { date: "2026-11-10", label: "入院費", direction: "out", amount_low: 100_000, amount_high: 100_000, certainty: "confirmed" },
        ],
      },
    ],
  });
  const [counted] = paydayTable(output).rows;
  assert.equal(counted[0], "見通し");
  assert.equal(counted[4], "確かめた額・仮定");
});

test("（高 1）カードを付け直さない回でも、印が外れていなければ、計算し直すよう頼み続ける", async () => {
  const reply = JSON.stringify({ reply: "退院は28日の予定ですね。", cards: [] });
  const model = mock(toolStep("calc_date", CALC_DATE), textStep(reply));
  const result = await runChat({ model, input: staleRequest() });
  assert.equal(result.cards.some((item) => item.kind === "money"), false);
  assert.ok(result.warnings.some((warning) => warning.message === STALE_CASHFLOW_WARNING));
});
