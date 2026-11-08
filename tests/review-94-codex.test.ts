// PR #94 の Codex のレビュー（c465e5a）の再現。数字と会話はすべて架空。
// ① 手元のお金・総医療費・日付を足した試し呼びが本線になる。② 別のカードの内訳が混ざると、画面と検査で本線が分かれる。
// ③ 同じ額の別々の追加費用の片方が消える。④ 旧形式が本線のとき、画面が別の見通しの順位を出す。
import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat } from "../lib/chat";
import { attachMoney, type ToolEvent } from "../lib/money/attach";
import { checkReply, saidAmounts } from "../lib/money/guard";
import { mainCashflowIndex, shownCashflow } from "../lib/money/main-cashflow";
import type { Calculation } from "../lib/money/schema";
import { executeTool } from "../lib/money/tools";
import { needRangeOf } from "../lib/views";
import { requestSchema, type Message } from "../lib/workspace";

const TODAY = "2026-11-08";
const SAID =
  "二千二十六年の12月14日に入院して、28日に退院する予定です。医療費は総額で80万円くらい。協会けんぽで、給料は月35万円くらいです。すぐ使えるお金は20万円。";
const KOUGAKU = {
  treatment_month: "2026-12",
  income_category: "ウ",
  amount_basis: "total",
  amount_low: 800_000,
  amount_high: 800_000,
  copay_percent: 30,
};
const MEAL = { days_low: 15, days_high: 15 };

function event(name: string, input: unknown): ToolEvent {
  const result = executeTool(name, input);
  assert.equal(result.ok, true, name);
  return {
    name,
    input,
    ok: true,
    output: (result as { output: unknown }).output,
  };
}

type Out = [label: string, low: number, high: number];
// 2 つの筋書き（上限が使える／使えない）。それぞれの入出金の額を並べる。
const cashflow = (
  cap: Out[],
  noCap: Out[],
  name = "窓口で上限が適用される場合",
) => ({
  start_date: TODAY,
  cash_on_hand: 200_000,
  scenarios: [
    {
      name,
      events: cap.map(([label, low, high]) => ({
        date: "2026-12-28",
        label,
        direction: "out",
        amount_low: low,
        amount_high: high,
        certainty: "estimate",
      })),
    },
    {
      name: "上限が適用されず、いったん3割を払う場合",
      events: noCap.map(([label, low, high]) => ({
        date: "2026-12-28",
        label,
        direction: "out",
        amount_low: low,
        amount_high: high,
        certainty: "estimate",
      })),
    },
  ],
});
const REAL = cashflow(
  [["入院費", 115_690, 115_690]],
  [["入院費", 264_750, 264_750]],
);
const trial = (amount: number) => ({
  start_date: TODAY,
  cash_on_hand: 200_000,
  scenarios: [
    {
      name: "x",
      events: [
        {
          date: "2026-12-28",
          label: "x",
          direction: "out",
          amount_low: amount,
          amount_high: amount,
          certainty: "assumption",
        },
      ],
    },
  ],
});

test("PR #94 の Codex①: 手元のお金・総医療費・年を内訳の額に足した試し呼びは、本線にならない", () => {
  assert.deepEqual(saidAmounts([SAID]), []);
  // 315,690 = 115,690 + 手元 200,000、915,690 = + 総医療費 800,000、117,716 = + 二千二十六（年）
  for (const amount of [315_690, 915_690, 117_716]) {
    const events = [
      event("kougaku_gendo", KOUGAKU),
      event("meal_cost", MEAL),
      event("simulate_cashflow", REAL),
      event("simulate_cashflow", trial(amount)),
    ];
    assert.equal(
      mainCashflowIndex(events, 0, saidAmounts([SAID])),
      2,
      String(amount),
    );
    const { cards } = attachMoney({
      proposals: [],
      events,
      existing: [],
      prior: new Map<string, Calculation[]>(),
      messages: [{ id: "u1", role: "user", text: SAID }],
    });
    assert.deepEqual(
      needRangeOf(cards[0] as never),
      { low: 115_690, high: 264_750 },
      String(amount),
    );
    const reply = "手元に要る額は、仮の見積もりで 115,690 円〜264,750 円です。";
    assert.deepEqual(
      checkReply({
        reply,
        toolEvents: events,
        userTexts: [SAID],
        today: TODAY,
        currentFrom: 0,
      }),
      [],
      String(amount),
    );
  }
});

test("PR #94 の Codex①: 足すのは費用の語に結びついた額だけ。日割りの額・収入・手元は足さず、判別できない額も足さない", () => {
  assert.deepEqual(
    saidAmounts([
      "個室を希望していて、差額ベッド代は全部で2万円と言われました。",
    ]),
    [20_000],
  );
  assert.deepEqual(saidAmounts(["差額ベッド代は1日5,000円で4日です。"]), []);
  assert.deepEqual(
    saidAmounts(["差額ベッド代は2万円で、手元は20万円です。"]),
    [20_000],
  );
  assert.deepEqual(
    saidAmounts(["交通費のことは分かりませんが、給料は35万円です。"]),
    [],
  );
  assert.deepEqual(
    saidAmounts(["差額ベッド代は2万円で、ほかに35万円あります。"]),
    [20_000],
  );
  // 会話の発言と、それを引いたカードの根拠は、同じ発言として 1 回だけ数える。
  assert.deepEqual(
    saidAmounts([
      "差額ベッド代は全部で2万円と言われました。",
      "差額ベッド代は全部で2万円",
    ]),
    [20_000],
  );
});

test("PR #94 の Codex③: 同じ額の別々の追加費用（差額ベッド代 2 万円と交通費 2 万円）は、別々に数える", () => {
  const said = "差額ベッド代は全部で2万円、交通費も全部で2万円かかります。";
  assert.deepEqual(saidAmounts([said]), [20_000, 20_000]);
  const both = cashflow(
    [["入院費（差額ベッド代と交通費込み）", 155_690, 155_690]],
    [["入院費（差額ベッド代と交通費込み）", 304_750, 304_750]],
  );
  const events = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    event("simulate_cashflow", REAL),
    event("simulate_cashflow", both),
  ];
  const userTexts = [SAID, said];
  assert.equal(mainCashflowIndex(events, 0, saidAmounts(userTexts)), 3);
  const reply = "手元に要る額は155,690円〜304,750円です。";
  assert.deepEqual(
    checkReply({
      reply,
      toolEvents: events,
      userTexts,
      today: TODAY,
      currentFrom: 0,
    }),
    [],
  );
});

test("PR #94 の Codex②: 別のカードに古い内訳が残っていても、検査は画面と同じ見通しを本線にし、正しい範囲を伏せない", async () => {
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 50, text: 50, reasoning: 0 },
  };
  const said = "個室を希望していて、差額ベッド代は全部で2万円と言われました。";
  const oldKougaku = {
    ...KOUGAKU,
    amount_low: 1_000_000,
    amount_high: 1_000_000,
  };
  const old = (
    executeTool("kougaku_gendo", oldKougaku) as {
      output: {
        cases: { low: { pay_with_cap: number; copay_without_cap: number } }[];
      };
    }
  ).output.cases[0].low;
  // A: 保険診療・食事・ベッド代を別々の入出金にした見通し（135,690〜284,750 円）。
  const a = cashflow(
    [
      ["入院費（保険診療分）", 90_940, 90_940],
      ["食事代", 24_750, 24_750],
      ["差額ベッド代", 20_000, 20_000],
    ],
    [
      ["入院費（3割）", 240_000, 240_000],
      ["食事代", 24_750, 24_750],
      ["差額ベッド代", 20_000, 20_000],
    ],
  );
  // B: 別のカードの古い内訳（総医療費 100 万円）と食事代・ベッド代を合算した見通し。
  const b = cashflow(
    [["入院費", old.pay_with_cap + 44_750, old.pay_with_cap + 44_750]],
    [
      [
        "入院費",
        old.copay_without_cap + 44_750,
        old.copay_without_cap + 44_750,
      ],
    ],
  );
  const reply = "手元に要る額は135,690円〜284,750円です。";
  const call = (id: string, input: unknown) => ({
    type: "tool-call" as const,
    toolCallId: id,
    toolName: "simulate_cashflow",
    input: JSON.stringify(input),
  });
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [call("c1", a), call("c2", b)],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [
          { type: "text" as const, text: JSON.stringify({ reply, cards: [] }) },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
  const card = (id: string, kougaku: unknown) => ({
    id,
    kind: "money",
    title: "支払日までに、手元に要る額",
    body: "表を読む。",
    nextStep: "読み返す。",
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: SAID }],
    edited: false,
    done: false,
    included: false,
    money: {
      calculations: [
        { name: "kougaku_gendo", input: kougaku },
        { name: "meal_cost", input: MEAL },
      ],
    },
  });
  const messages: Message[] = [
    { id: "u1", role: "user", text: SAID },
    { id: "u2", role: "user", text: said },
  ];
  const result = await runChat({
    model,
    // 更新の対象は最後のお金のカード（80 万円の内訳）。前のカードに 100 万円の古い内訳が残っている。
    input: requestSchema.parse({
      messages,
      cards: [card("old", oldKougaku), card("now", KOUGAKU)],
    }),
  });
  const updated = result.cards.find((item) => item.id === "now");
  assert.deepEqual(needRangeOf(updated as never), {
    low: 135_690,
    high: 284_750,
  });
  assert.equal(result.reply, reply);
  assert.deepEqual(result.warnings, []);
});

test("PR #94 の Codex④: 旧形式の見通しが本線なら、画面は別の見通しの順位を出さない", () => {
  const b = {
    start_date: TODAY,
    cash_on_hand: 200_000,
    scenarios: [
      {
        name: "病院の見積もり",
        events: [
          {
            date: "2026-12-28",
            label: "退院のときの支払い",
            direction: "out",
            amount_low: 160_000,
            amount_high: 220_000,
            certainty: "estimate",
          },
        ],
      },
    ],
  };
  const current = event("simulate_cashflow", REAL);
  const { what_to_confirm: _omit, ...legacy } = current.output as Record<
    string,
    unknown
  >;
  const calculations = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    current,
    event("simulate_cashflow", b),
    { ...current, output: legacy },
  ].map(({ name, input, output }) => ({
    name,
    input,
    output,
  })) as Calculation[];
  // 画面（money-card.tsx の MoneyDetails）は shownCashflow の見通しで支払日の表と順位を出す。
  // 見通し B が最後なら B の順位が出る。旧形式 C が最後（本線）なら C を使い、B の順位へ移らない（C には順位が無い）。
  assert.equal(shownCashflow(calculations.slice(0, 4)), calculations[3]);
  const shown = shownCashflow(calculations);
  assert.equal(shown, calculations[4]);
  assert.equal((shown?.output as { what_to_confirm?: unknown }).what_to_confirm, undefined);
});
