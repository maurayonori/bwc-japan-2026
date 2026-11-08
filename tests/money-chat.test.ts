import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { MAX_RESPONSE_TOOLS, runChat, toResponse } from "../lib/chat";
import { legacyCashflowInput } from "./helpers/legacy-cashflow";
import { attachMoney, SYNTHETIC_BODY } from "../lib/money/attach";
import {
  calculationSchema,
  type Calculation,
  type CashflowOutput,
} from "../lib/money/schema";
import { executeTool } from "../lib/money/tools";
import {
  mergeCards,
  replySchema,
  requestSchema,
  type Card,
  type ChatRequest,
} from "../lib/workspace";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const KOUGAKU = {
  treatment_month: "2026-11",
  income_category: "ウ",
  amount_basis: "copay",
  amount_low: 240_000,
  amount_high: 300_000,
  copay_percent: 30,
};
const MEAL = { days_low: 15, days_high: 15 };
const CASHFLOW = {
  start_date: "2026-11-06",
  cash_on_hand: null,
  scenarios: [
    {
      name: "基本",
      events: [
        {
          date: "2026-11-30",
          label: "入院費",
          direction: "out",
          amount_low: 90_940,
          amount_high: 92_940,
          certainty: "estimate",
        },
      ],
    },
  ],
};
const QUOTE = "来月2週間入院する。";
const USER_TEXT = `${QUOTE}協会けんぽ。いくら手元に要るか分からない。`;
const INPUT: ChatRequest = {
  messages: [{ id: "u1", role: "user", text: USER_TEXT }],
  cards: [],
};

type ToolCall = { name: string; input: unknown };

const toolStep = (...calls: ToolCall[]) => ({
  content: calls.map((call, index) => ({
    type: "tool-call" as const,
    toolCallId: `call-${call.name}-${index}`,
    toolName: call.name,
    input: JSON.stringify(call.input),
  })),
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
const replyStep = (reply: string, cards: unknown[] = []) =>
  textStep(JSON.stringify({ reply, cards }));

const proposal = (patch: object = {}) => ({
  id: "m1",
  kind: "money",
  title: "手元に要る額",
  body: "説明です。",
  nextStep: "病院に聞く。",
  uncertainty: "",
  evidence: [{ messageId: "u1", quote: QUOTE }],
  ...patch,
});

function mock(...steps: ReturnType<typeof textStep | typeof toolStep>[]) {
  return new MockLanguageModelV4({ doGenerate: steps });
}

function resultOf(name: string, input: unknown): unknown {
  const result = executeTool(name, input);
  assert.equal(result.ok, true, name);
  return (result as { output: unknown }).output;
}

function moneyRef(name: string, input: unknown) {
  return { name, input } as NonNullable<
    ChatRequest["cards"][number]["money"]
  >["calculations"][number];
}

const flags = { edited: false, done: false, included: false };

test("道具の往復のあと、表はサーバーの計算結果だけで作る", async () => {
  const model = mock(
    toolStep(
      { name: "kougaku_gendo", input: KOUGAKU },
      { name: "meal_cost", input: MEAL },
    ),
    toolStep({ name: "simulate_cashflow", input: CASHFLOW }),
    replyStep("手元に要る額を出しました。", [proposal()]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.equal(model.doGenerateCalls.length, 3);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.cards.length, 1);
  const calculations = result.cards[0].money?.calculations ?? [];
  assert.deepEqual(
    calculations.map((item) => item.name),
    ["kougaku_gendo", "meal_cost", "simulate_cashflow"],
  );
  assert.deepEqual(calculations[0].output, resultOf("kougaku_gendo", KOUGAKU));
  assert.deepEqual(calculations[2].output, resultOf("simulate_cashflow", CASHFLOW));
  assert.equal(result.meta.steps, 3);
  assert.deepEqual(result.meta.tools, [
    "kougaku_gendo",
    "meal_cost",
    "simulate_cashflow",
  ]);
  assert.equal(result.meta.usage.inputTokens, 300);
  assert.equal(result.meta.fallback, false);
});

test("Claude が表の数字を書いても、カードに入らない", async () => {
  const fake = {
    calculations: [
      {
        name: "meal_cost",
        input: MEAL,
        output: resultOf("meal_cost", { days_low: 1, days_high: 1 }),
      },
    ],
  };
  const model = mock(
    toolStep({ name: "meal_cost", input: MEAL }),
    replyStep("例", [proposal({ money: fake })]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.deepEqual(
    result.cards[0].money?.calculations[0].output,
    resultOf("meal_cost", MEAL),
  );
});

test("Claude に渡すスキーマに、表の項目が無い", async () => {
  const model = mock(replyStep("例"));
  await runChat({ model, input: INPUT });
  const format = model.doGenerateCalls[0].responseFormat;
  assert.equal(format?.type, "json");
  assert.equal(JSON.stringify(format).includes('"money":{'), false);
  assert.equal(JSON.stringify(format).includes("pay_with_cap"), false);
});

test("呼び出しの設定: 指示のキャッシュ・今日の日付・道具・effort", async () => {
  const model = mock(replyStep("例"));
  await runChat({ model, input: INPUT });
  const call = model.doGenerateCalls[0];
  const [stable, dated] = call.prompt;
  assert.equal(stable.role, "system");
  assert.deepEqual(stable.providerOptions?.anthropic?.cacheControl, {
    type: "ephemeral",
  });
  assert.equal(dated.role, "system");
  assert.equal(dated.providerOptions, undefined);
  assert.match(String(dated.content), /^今日は \d{4}-\d{2}-\d{2}（.曜日）です/);
  assert.equal(call.tools?.length, 4);
  assert.equal(call.maxOutputTokens, 6000);
  assert.equal(call.providerOptions?.anthropic?.effort, "low");
  for (const definition of call.tools ?? []) {
    assert.equal(definition.type, "function");
    if (definition.type === "function") assert.equal(definition.strict, true);
  }
});

test("最後のステップは道具を切る。道具の定義は送り続ける", async () => {
  const call = { name: "meal_cost", input: MEAL };
  const model = mock(
    toolStep(call),
    toolStep(call),
    toolStep(call),
    toolStep(call),
    replyStep("例", [proposal()]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.equal(model.doGenerateCalls.length, 5);
  assert.notEqual(model.doGenerateCalls[3].toolChoice?.type, "none");
  assert.equal(model.doGenerateCalls[4].toolChoice?.type, "none");
  assert.equal(model.doGenerateCalls[4].tools?.length, 4);
  assert.equal(result.cards[0].money?.calculations.length, 1);
});

test("文章を作れなくても、計算が済んでいれば表だけを返す", async () => {
  const model = mock(
    toolStep({ name: "kougaku_gendo", input: KOUGAKU }),
    textStep("JSON ではない文章"),
  );
  const result = await runChat({ model, input: INPUT });
  assert.match(result.reply, /説明の文章を最後まで作れませんでした/);
  assert.equal(result.meta.fallback, true);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].kind, "money");
  assert.equal(result.cards[0].body, SYNTHETIC_BODY);
  assert.deepEqual(
    result.cards[0].money?.calculations[0].output,
    resultOf("kougaku_gendo", KOUGAKU),
  );
  assert.equal(result.cards[0].evidence[0].messageId, "u1");
});

test("日付の計算だけが済んだ場合でも、失敗時は表を出す", async () => {
  const input = {
    start_date: "2026-11-16",
    steps: [],
    until_date: "2026-11-30",
  };
  const model = mock(toolStep({ name: "calc_date", input }), textStep("x"));
  const result = await runChat({ model, input: INPUT });
  assert.equal(result.cards[0].money?.calculations[0].name, "calc_date");
});

test("計算が 1 つも無いまま失敗したら、失敗として返す", async () => {
  await assert.rejects(runChat({ model: mock(textStep("x")), input: INPUT }));
});

test("受け付けられなかった計算だけでは、表を作らず失敗として返す", async () => {
  const model = mock(
    toolStep({ name: "meal_cost", input: { days_low: 0, days_high: 0 } }),
    textStep("x"),
  );
  await assert.rejects(runChat({ model, input: INPUT }));
});

test("利用者が中止したら、計算が済んでいても表を返さない", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) return toolStep({ name: "meal_cost", input: MEAL });
      controller.abort();
      throw new DOMException("中止", "AbortError");
    },
  });
  await assert.rejects(
    runChat({ model, input: INPUT, signal: controller.signal }),
  );
});

test("道具が断った理由はモデルに返り、呼び方を直せる", async () => {
  const model = mock(
    toolStep({ name: "meal_cost", input: { days_low: 0, days_high: 0 } }),
    toolStep({ name: "meal_cost", input: MEAL }),
    replyStep("例", [proposal()]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.match(JSON.stringify(model.doGenerateCalls[1].prompt), /入院日数/);
  assert.equal(result.cards[0].money?.calculations.length, 1);
  assert.deepEqual(result.meta.tools, ["meal_cost", "meal_cost"]);
});

test("同じ入力の計算は、表に 1 回だけ出す", async () => {
  const model = mock(
    toolStep(
      { name: "meal_cost", input: MEAL },
      { name: "meal_cost", input: MEAL },
    ),
    replyStep("例", [proposal()]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.equal(result.cards[0].money?.calculations.length, 1);
});

test("編集・完了・選択済みのカードを直そうとしたら、新しい id で出し、元は残す", async () => {
  for (const flag of ["edited", "done", "included"] as const) {
    const existing: Card = {
      ...(proposal({ body: "本人が確かめた文章" }) as Card),
      ...flags,
      [flag]: true,
    };
    const model = mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep("例", [proposal({ body: "新しい説明" })]),
    );
    const result = await runChat({
      model,
      input: { ...INPUT, cards: [existing] },
    });
    assert.notEqual(result.cards[0].id, "m1");
    const merged = mergeCards([existing], result.cards);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].body, "本人が確かめた文章");
    assert.equal(merged[0].money, undefined);
    assert.equal(merged[1].body, "新しい説明");
    assert.ok(merged[1].money);
  }
});

test("計算も既存カードも無いお金のカードは出さず、注意を出す", async () => {
  const model = mock(replyStep("例", [proposal({ body: "計算していない説明" })]));
  const result = await runChat({ model, input: INPUT });
  assert.deepEqual(result.cards, []);
  assert.equal(result.warnings[0].kind, "card");
});

test("計算が無い返答で既存のお金のカードを直すときは、前の表を消さない", async () => {
  const existing: Card = {
    ...(proposal() as Card),
    ...flags,
    money: {
      calculations: [
        calculationSchema.parse({
          name: "meal_cost",
          input: MEAL,
          output: resultOf("meal_cost", MEAL),
        }),
      ],
    },
  };
  const model = mock(replyStep("例", [proposal({ body: "直した説明" })]));
  const request = requestSchema.parse({ ...INPUT, cards: [existing] });
  const result = await runChat({ model, input: request });
  assert.equal("money" in result.cards[0], false);
  const [merged] = mergeCards([existing], result.cards);
  assert.equal(merged.body, "直した説明");
  assert.deepEqual(merged.money, existing.money);
});

test("お金のカードが 2 枚あれば、計算は最初の 1 枚に付ける", async () => {
  const existing: Card = { ...(proposal({ id: "m2" }) as Card), ...flags };
  const model = mock(
    toolStep({ name: "meal_cost", input: MEAL }),
    replyStep("例", [proposal(), proposal({ id: "m2", body: "直した" })]),
  );
  const result = await runChat({
    model,
    input: { ...INPUT, cards: [existing] },
  });
  assert.ok(result.cards[0].money);
  assert.equal("money" in result.cards[1], false);
});

test("お金のカードの引用が合わなくても、表は捨てず、最後の発言を根拠にする", async () => {
  const model = mock(
    toolStep({ name: "meal_cost", input: MEAL }),
    replyStep("例", [
      proposal({ evidence: [{ messageId: "u1", quote: "話していない" }] }),
    ]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.deepEqual(result.cards[0].evidence, [
    { messageId: "u1", quote: USER_TEXT },
  ]);
  assert.ok(result.cards[0].money);
});

test("ほかのカードの引用が合わなければ、そのカードだけ落として注意を出す", async () => {
  const model = mock(
    toolStep({ name: "meal_cost", input: MEAL }),
    replyStep("例", [
      proposal(),
      proposal({
        id: "d1",
        kind: "daily",
        title: "朝のこと",
        evidence: [{ messageId: "u1", quote: "話していない" }],
      }),
      proposal({
        id: "mem",
        kind: "memory",
        title: "言葉",
        body: "作られた思い出",
      }),
      proposal({ id: "d2", kind: "daily", title: "夜のこと" }),
    ]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.deepEqual(
    result.cards.map((card) => card.id),
    ["m1", "d2"],
  );
  assert.deepEqual(
    result.warnings.map((warning) => warning.kind),
    ["card", "card"],
  );
});

test("お金のカードが無くても、計算があれば表のカードを足す", async () => {
  const model = mock(
    toolStep({ name: "meal_cost", input: MEAL }),
    replyStep("例", [proposal({ id: "d1", kind: "daily" })]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[1].kind, "money");
  assert.equal(result.cards[1].id, "money-1");
});

test("日付の計算だけで、お金のカードを勝手に増やさない", async () => {
  const model = mock(
    toolStep({
      name: "calc_date",
      input: { start_date: "2026-11-16", steps: [], until_date: "2026-11-30" },
    }),
    replyStep("15 日間です。"),
  );
  const result = await runChat({ model, input: INPUT });
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.warnings, []);
});

test("お金のカードを作らなくても、既存のカードの表を計算し直して更新する", async () => {
  const existing: Card = {
    ...(proposal({ body: "前の 1 か月ぶんの説明" }) as Card),
    ...flags,
  };
  const model = mock(toolStep({ name: "meal_cost", input: MEAL }), replyStep("例"));
  const result = await runChat({ model, input: { ...INPUT, cards: [existing] } });
  assert.equal(result.cards[0].id, "m1");
  assert.equal(result.cards[0].body, SYNTHETIC_BODY);
  assert.ok(result.cards[0].money);
});

test("前のターンの計算は入力からやり直し、その数字を文章で使っても注意を出さない", async () => {
  const card = {
    ...proposal(),
    ...flags,
    money: { calculations: [moneyRef("kougaku_gendo", KOUGAKU)] },
  };
  const request = requestSchema.parse({ ...INPUT, cards: [card] });
  const allowed = await runChat({
    model: mock(replyStep("前の計算では 92,940 円でした。")),
    input: request,
  });
  assert.deepEqual(allowed.warnings, []);
  const unknown = await runChat({
    model: mock(replyStep("前の計算では 92,941 円でした。")),
    input: request,
  });
  assert.equal(unknown.warnings.length, 1);
  assert.equal(unknown.warnings[0].kind, "amount");
});

test("カードの本文の金額と日付も照らす", async () => {
  const model = mock(
    toolStep({ name: "meal_cost", input: MEAL }),
    replyStep("例", [
      proposal({
        body: "食事代は 24,750 円です。入院費は 77,777 円です。12/25 に払います。",
      }),
    ]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.deepEqual(
    result.warnings.map((warning) => [warning.kind, warning.shown]),
    [
      ["amount", "77,777 円"],
      ["date", "12/25"],
    ],
  );
  assert.ok(result.cards[0].money, "注意を出しても、止めない");
});

test("条件を変えて一部の道具だけ呼び直したら、残りの表は前の結果を残す", async () => {
  const card = {
    ...proposal(),
    ...flags,
    money: {
      calculations: [
        moneyRef("kougaku_gendo", KOUGAKU),
        moneyRef("meal_cost", MEAL),
      ],
    },
  };
  const longer = { days_low: 22, days_high: 22 };
  const model = mock(
    toolStep({ name: "meal_cost", input: longer }),
    replyStep("例", [proposal()]),
  );
  const result = await runChat({
    model,
    input: requestSchema.parse({ ...INPUT, cards: [card] }),
  });
  const calculations = result.cards[0].money?.calculations ?? [];
  assert.deepEqual(
    calculations.map((item) => item.name),
    ["kougaku_gendo", "meal_cost"],
  );
  assert.deepEqual(calculations[1].input, longer);
  assert.deepEqual(calculations[1].output, resultOf("meal_cost", longer));
});

test("送られた計算の入力が今は扱えなければ、その計算だけ諦める", async () => {
  const card = {
    ...proposal(),
    ...flags,
    money: {
      calculations: [
        moneyRef("meal_cost", { days_low: -1, days_high: 0 }),
        moneyRef("kougaku_gendo", KOUGAKU),
      ],
    },
  };
  const result = await runChat({
    model: mock(replyStep("前の計算では 92,940 円でした。")),
    input: requestSchema.parse({ ...INPUT, cards: [card] }),
  });
  assert.deepEqual(result.warnings, []);
});

test("Claude に渡す JSON には、発言の本文と計算の入力だけを入れる", async () => {
  const card = {
    ...proposal(),
    ...flags,
    money: {
      calculations: [
        {
          name: "meal_cost",
          input: MEAL,
          output: resultOf("meal_cost", MEAL),
        },
      ],
    },
  };
  const model = mock(replyStep("例"));
  await runChat({
    model,
    input: requestSchema.parse({
      messages: [
        {
          ...INPUT.messages[0],
          warnings: [{ kind: "amount", shown: "1 円", message: "前の注意" }],
        },
      ],
      cards: [card],
    }),
  });
  const prompt = JSON.stringify(model.doGenerateCalls[0].prompt.slice(2));
  assert.match(prompt, /days_low/);
  assert.doesNotMatch(prompt, /cost_max|前の注意/);
});

test("時間切れでも、計算が済んでいれば表を返す", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      calls += 1;
      if (calls === 1) return toolStep({ name: "meal_cost", input: MEAL });
      await new Promise((_, reject) => {
        abortSignal?.addEventListener("abort", () =>
          reject(abortSignal.reason),
        );
      });
      throw new Error("ここには来ない");
    },
  });
  const started = Date.now();
  const result = await runChat({ model, input: INPUT, budgetMs: 150 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.meta.fallback, true);
  assert.deepEqual(
    result.cards[0].money?.calculations[0].output,
    resultOf("meal_cost", MEAL),
  );
});

test("時間が経っていたら、次のステップから道具を切る", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return toolStep({ name: "meal_cost", input: MEAL });
      }
      return replyStep("例", [proposal()]);
    },
  });
  await runChat({ model, input: INPUT, toolCutoffMs: 10 });
  assert.notEqual(model.doGenerateCalls[0].toolChoice?.type, "none");
  assert.equal(model.doGenerateCalls[1].toolChoice?.type, "none");
  assert.equal(model.doGenerateCalls[1].tools?.length, 4);
});

test("別の見通しに含まれる筋書きだけの計算は、表に重ねない", async () => {
  const second = {
    name: "長引く場合",
    events: CASHFLOW.scenarios[0].events,
  };
  const both = { ...CASHFLOW, scenarios: [...CASHFLOW.scenarios, second] };
  const model = mock(
    toolStep({ name: "simulate_cashflow", input: both }),
    toolStep({ name: "simulate_cashflow", input: CASHFLOW }),
    replyStep("例", [proposal()]),
  );
  const result = await runChat({ model, input: INPUT });
  const calculations = result.cards[0].money?.calculations ?? [];
  assert.equal(calculations.length, 1);
  assert.deepEqual(calculations[0].input, both);
});

test("筋書きが違う見通しは、両方とも表に出す", async () => {
  const other = {
    ...CASHFLOW,
    scenarios: [{ ...CASHFLOW.scenarios[0], name: "別の筋書き" }],
  };
  const model = mock(
    toolStep({ name: "simulate_cashflow", input: CASHFLOW }),
    toolStep({ name: "simulate_cashflow", input: other }),
    replyStep("例", [proposal()]),
  );
  const result = await runChat({ model, input: INPUT });
  assert.equal(result.cards[0].money?.calculations.length, 2);
});

test("想定外のエラーの計算は表に入れず、注意を出す（理由の本文は出さない）", () => {
  const { cards, warnings } = attachMoney({
    proposals: [],
    events: [
      {
        name: "meal_cost",
        input: MEAL,
        ok: false,
        crashed: true,
      },
    ],
    existing: [],
    prior: new Map<string, Calculation[]>(),
    messages: INPUT.messages,
  });
  assert.deepEqual(cards, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "calc");
});

test("計算が多すぎるときは最後の 12 件だけにして、注意を出す", () => {
  const events = Array.from({ length: 14 }, (_, index) => {
    const input = { days_low: index + 1, days_high: index + 1 };
    return {
      name: "meal_cost",
      input,
      ok: true,
      output: resultOf("meal_cost", input),
    };
  });
  const { cards, warnings } = attachMoney({
    proposals: [],
    events,
    existing: [],
    prior: new Map<string, Calculation[]>(),
    messages: INPUT.messages,
  });
  assert.equal(cards[0].money?.calculations.length, 12);
  assert.deepEqual(cards[0].money?.calculations[11].input, {
    days_low: 14,
    days_high: 14,
  });
  assert.equal(warnings[0].kind, "calc");
});

// 体験例の見通しの入力（窓口で上限が適用される場合と、いったん 3 割を払う場合）。
// 2026-11-07 までの体験例の入力（筋書きと額の 2 つの不明点があり、答えのあとも幅が 2,000 円残る）。
function exampleCashflowInput() {
  return structuredClone(legacyCashflowInput()) as unknown as {
    start_date: string;
    cash_on_hand: number | null;
    scenarios: { name: string; events: unknown[] }[];
  };
}

function cashflowOf(card: { money?: { calculations: Calculation[] } }) {
  const found = card.money?.calculations.find(
    (item) => item.name === "simulate_cashflow",
  );
  assert.ok(found?.name === "simulate_cashflow");
  return found;
}

const ANSWER = "病院の会計で、窓口で上限が適用されると聞いた。";
const ASKED =
  "まず確かめる 1 つは、窓口で上限が適用されるかです。病院の会計に聞くと、要る額の幅は 209,060 円から 60,000 円に縮みます。";

test("答えを伝えたターンで幅が縮み、前の幅を書いた返答にも注意が出ない", async () => {
  const before = exampleCashflowInput();
  const capOnly = { ...before, scenarios: [before.scenarios[0]] };
  const messages = [
    INPUT.messages[0],
    { id: "a1", role: "assistant" as const, text: ASKED },
    { id: "u2", role: "user" as const, text: ANSWER },
  ];
  const card = {
    ...proposal(),
    ...flags,
    money: { calculations: [moneyRef("simulate_cashflow", before)] },
  };
  const reply =
    "窓口で上限が適用されると分かったので、要る額の幅は 209,060 円から 2,000 円に縮みました。";
  const answerCard = proposal({ evidence: [{ messageId: "u2", quote: ANSWER }] });
  const result = await runChat({
    model: mock(
      toolStep({ name: "simulate_cashflow", input: capOnly }),
      replyStep(reply, [answerCard]),
    ),
    input: requestSchema.parse({ messages, cards: [card] }),
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.cards[0].id, "m1");
  const after = cashflowOf(result.cards[0]);
  assert.deepEqual(after.input, capOnly);
  const previous = resultOf("simulate_cashflow", before) as CashflowOutput;
  assert.equal(previous.what_to_confirm?.width, 209_060);
  assert.equal(after.output.what_to_confirm?.width, 2_000);

  // 前の計算が無く、前の返答にもその額が無ければ、前の幅は見当たらない金額として注意が出る（検査が効いている）。
  // 前の返答に書いた額は、照らし終えた値として根拠に入る（#61 の指摘 2）ので、対照では前の返答から額を外す。
  const withoutPrior = await runChat({
    model: mock(
      toolStep({ name: "simulate_cashflow", input: capOnly }),
      replyStep(reply, [answerCard]),
    ),
    input: requestSchema.parse({
      messages: messages.map((message) =>
        message.id === "a1"
          ? { ...message, text: "まず確かめる 1 つは、窓口で上限が適用されるかです。" }
          : message,
      ),
      cards: [],
    }),
  });
  assert.deepEqual(
    withoutPrior.warnings.map((warning) => warning.shown),
    ["209,060 円"],
  );
});

test("渡すものに含めたお金のカードは、答えのターンでも上書きせず、新しい id で出す", async () => {
  const before = exampleCashflowInput();
  const capOnly = { ...before, scenarios: [before.scenarios[0]] };
  const existing: Card = {
    ...(proposal({ body: "渡すものに含めた文章" }) as Card),
    ...flags,
    included: true,
    money: {
      calculations: [
        calculationSchema.parse({
          name: "simulate_cashflow",
          input: before,
          output: resultOf("simulate_cashflow", before),
        }),
      ],
    },
  };
  const result = await runChat({
    model: mock(
      toolStep({ name: "simulate_cashflow", input: capOnly }),
      replyStep("幅が縮みました。", [proposal({ body: "新しい説明" })]),
    ),
    input: requestSchema.parse({ ...INPUT, cards: [existing] }),
  });
  assert.notEqual(result.cards[0].id, "m1");
  const merged = mergeCards([existing], result.cards);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].body, "渡すものに含めた文章");
  assert.deepEqual(merged[0].money, existing.money);
  assert.equal(cashflowOf(merged[1]).output.what_to_confirm?.width, 2_000);
});

test("画面へ返すのは reply・cards・warnings・tools だけ", async () => {
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep("例", [proposal()]),
    ),
    input: INPUT,
  });
  const response = toResponse(result);
  assert.deepEqual(Object.keys(response).sort(), [
    "cards",
    "reply",
    "tools",
    "warnings",
  ]);
  assert.deepEqual(response.tools, ["meal_cost"]);
  assert.doesNotMatch(
    JSON.stringify(response),
    /inputTokens|"usage"|"meta"|"fallback"/,
  );
  assert.equal(replySchema.safeParse(response).success, true);
  const many = toResponse({
    ...result,
    meta: { ...result.meta, tools: Array.from({ length: 50 }, () => "meal_cost") },
  });
  assert.equal(many.tools.length, MAX_RESPONSE_TOOLS);
  assert.equal(replySchema.safeParse(many).success, true);
});

// #46: 先頭の確認で幅が縮まないのに「縮みます」と書いた返答は、数字の不一致と同じく注意として返す。カードは止めない。
const NO_SHRINK = {
  start_date: "2026-11-07",
  cash_on_hand: null,
  scenarios: [
    {
      name: "窓口で上限が適用される場合（区分が不明なので幅）",
      events: [
        { date: "2026-12-23", label: "入院費（保険診療分）", direction: "out", amount_low: 36_900, amount_high: 240_000, certainty: "assumption" },
        { date: "2026-12-23", label: "入院中の食事代", direction: "out", amount_low: 23_100, amount_high: 23_100, certainty: "estimate" },
      ],
    },
    {
      name: "いったん 3 割を払う場合",
      events: [
        { date: "2026-12-23", label: "入院費（保険診療分）", direction: "out", amount_low: 240_000, amount_high: 240_000, certainty: "estimate" },
        { date: "2026-12-23", label: "入院中の食事代", direction: "out", amount_low: 23_100, amount_high: 23_100, certainty: "estimate" },
      ],
    },
  ],
};

test("幅が縮まない確認を「縮みます」と書いた返答には、数字の不一致と同じく注意を出し、カードはそのまま付ける", async () => {
  const wrong = await runChat({
    model: mock(
      toolStep({ name: "simulate_cashflow", input: NO_SHRINK }),
      replyStep("病院の会計に聞くと、要る額の幅は 203,100 円に縮みます。", [proposal()]),
    ),
    input: INPUT,
  });
  assert.deepEqual(
    wrong.warnings.map((warning) => [warning.kind, warning.shown]),
    [["amount", "病院の会計に聞くと、要る額の幅は 203,100 円に縮みます"]],
  );
  assert.equal(
    cashflowOf(wrong.cards[0]).output.what_to_confirm?.factors[0].shrink,
    0,
  );
  assert.deepEqual(toResponse(wrong).warnings, wrong.warnings);

  const right = await runChat({
    model: mock(
      toolStep({ name: "simulate_cashflow", input: NO_SHRINK }),
      replyStep(
        "まず確かめる 1 つは、窓口で上限が適用されるかです。適用されないなら 263,100 円に決まります。適用されるなら、所得の区分によって 60,000〜263,100 円の幅が残ります。",
        [proposal()],
      ),
    ),
    input: INPUT,
  });
  assert.deepEqual(right.warnings, []);
});
