import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat } from "../lib/chat";
import { exampleMoneyTurns, exampleWorkspace } from "../lib/example";
import { attachMoney, SYNTHETIC_BODY } from "../lib/money/attach";
import { checkReply, softenClaims } from "../lib/money/guard";
import { simulateCashflow, type LedgerEvent } from "../lib/money/ledger";
import { calculationSchema, type Calculation } from "../lib/money/schema";
import { executeTool } from "../lib/money/tools";
import { buildSystem } from "../lib/prompt";
import {
  exportMemo,
  mergeCards,
  type Card,
  type ChatRequest,
  type Proposal,
} from "../lib/workspace";

// #59: 外部レビューで見つかった、検査をすり抜ける経路と確認の順位の誤り。
// 指摘ごとに、再現をそのままテストにする。数字と会話はすべて架空。

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const MEAL = { days_low: 15, days_high: 15 }; // 24,750 円
const QUOTE = "来月2週間入院する。";
const USER_TEXT = `${QUOTE}協会けんぽ。いくら手元に要るか分からない。`;
const INPUT: ChatRequest = {
  messages: [{ id: "u1", role: "user", text: USER_TEXT }],
  cards: [],
};
const today = "2026-11-07";

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
const replyStep = (reply: string, cards: unknown[] = []) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ reply, cards }) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});
const mock = (...steps: ReturnType<typeof replyStep | typeof toolStep>[]) =>
  new MockLanguageModelV4({ doGenerate: steps });
const flags = { edited: false, done: false, included: false };

const proposal = (patch: Partial<Proposal> = {}): Proposal => ({
  id: "d1",
  kind: "daily",
  title: "朝の支度",
  body: "朝は7時に起きる。",
  nextStep: "読み返す。",
  uncertainty: "",
  evidence: [{ messageId: "u1", quote: QUOTE }],
  ...patch,
});

function outputOf(name: string, input: unknown): unknown {
  const result = executeTool(name, input);
  assert.equal(result.ok, true, name);
  return (result as { output: unknown }).output;
}
const okEvent = (name: string, input: unknown) => ({
  input,
  output: outputOf(name, input),
});

// ---- 指摘 1: 照合できない金額・日付を含むカードを採用しない ----

test("指摘1: 照合できない金額を本文に持つカードは採用せず、前の版を残す", async () => {
  const before: Card = { ...proposal({ body: "前の版の文章" }), ...flags };
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep("食事代を計算しました。", [
        proposal({ body: "支払いは123,456円です。" }),
        proposal({ id: "d2", title: "夜の支度", body: "12/25 に払います。" }),
      ]),
    ),
    input: { ...INPUT, cards: [before] },
  });
  assert.equal(
    result.cards.some((card) => card.id === "d1" || card.id === "d2"),
    false,
  );
  const merged = mergeCards([before], result.cards);
  assert.equal(merged.find((card) => card.id === "d1")?.body, "前の版の文章");
  assert.equal(merged.some((card) => card.id === "d2"), false);
  assert.ok(result.warnings.some((warning) => warning.kind === "card"));
});

test("指摘1: 見出し・次の行動・まだ確かめていないことに照合できない数字があっても採用しない", async () => {
  for (const patch of [
    { title: "123,456 円を用意する" },
    { nextStep: "12/25 までに 123,456 円を用意する。" },
    { uncertainty: "給付は 99,999 円の見込み。" },
  ]) {
    const result = await runChat({
      model: mock(replyStep("例", [proposal(patch)])),
      input: INPUT,
    });
    assert.deepEqual(result.cards, [], JSON.stringify(patch));
  }
});

test("指摘1: お金のカードは表を残し、照合できない文だけを差し替える", async () => {
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep("食事代を計算しました。", [
        proposal({ id: "m1", kind: "money", body: "支払いは123,456円です。" }),
      ]),
    ),
    input: INPUT,
  });
  assert.equal(result.cards.length, 1);
  assert.ok(result.cards[0].money);
  assert.equal(result.cards[0].body, SYNTHETIC_BODY);
  assert.doesNotMatch(JSON.stringify(result.cards[0]), /123,456|123456/);
});

test("指摘1: 返答の本文の照合できない金額と日付は伏せ、短い注記を付ける", async () => {
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep(
        "食事代は 24,750 円です。支払いは123,456円です。12/25 に払います。",
      ),
    ),
    input: INPUT,
  });
  assert.doesNotMatch(result.reply, /123,456|12\/25/);
  assert.match(result.reply, /24,750 円/);
  assert.match(result.reply, /伏せました/);
  assert.deepEqual(
    result.warnings.map((warning) => warning.kind).sort(),
    ["amount", "date"],
  );
});

test("指摘1: 持ち出しの文に、照合できない金額・日付が入らない", async () => {
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep("例", [
        proposal({ body: "支払いは123,456円です。" }),
        proposal({ id: "m1", kind: "money", body: "12/25 に 77,777 円を払います。" }),
        proposal({ id: "c1", kind: "contact", title: "病院の会計に、このまま聞く", body: "￥88,888 で足りますか。" }),
      ]),
    ),
    input: INPUT,
  });
  const cards = mergeCards([], result.cards).map((card) => ({
    ...card,
    included: true,
  }));
  const text = exportMemo(cards);
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /123,456|77,777|88,888|12\/25/);
});

// ---- 指摘 2: 「残しておく言葉」は見出しと次の行動も作らせない ----

test("指摘2: 残しておく言葉の見出しと次の行動は、原文と固定の文にする", async () => {
  const quote = "毎朝、白い棚から着替えを取ります";
  const result = await runChat({
    model: mock(
      replyStep("言葉を残しました。", [
        proposal({
          id: "mem",
          kind: "memory",
          title: "娘とハワイへ行った思い出",
          body: quote,
          nextStep: "ハワイの写真を探す。",
          uncertainty: "旅行の日付は未確認。",
          evidence: [{ messageId: "u1", quote }],
        }),
      ]),
    ),
    input: { messages: [{ id: "u1", role: "user", text: quote }], cards: [] },
  });
  assert.equal(result.cards.length, 1);
  const [card] = result.cards;
  assert.equal(card.title, quote);
  assert.equal(card.nextStep, "この言葉を残しておくか、自分で選ぶ。");
  assert.equal(card.uncertainty, "");
  const text = exportMemo([{ ...card, ...flags, included: true }]);
  assert.doesNotMatch(text, /ハワイ|旅行|写真/);
});

test("指摘2: 保存済みの残しておく言葉も、持ち出しでは原文にない見出しと次の行動を書かない。本人が直した見出しは残す", () => {
  const stored: Card = {
    ...proposal({
      id: "mem",
      kind: "memory",
      title: "娘とハワイへ行った思い出",
      body: "毎朝、白い棚から着替えを取ります。",
      nextStep: "ハワイの写真を探す。",
      uncertainty: "旅行の日付は未確認。",
    }),
    ...flags,
    included: true,
  };
  const text = exportMemo([stored]);
  assert.doesNotMatch(text, /ハワイ|旅行|写真/);
  assert.match(text, /毎朝、白い棚から着替えを取ります/);
  const edited = exportMemo([{ ...stored, edited: true, title: "本人が付けた見出し", nextStep: "本人が書いた次の一歩" }]);
  assert.match(edited, /本人が付けた見出し/);
  assert.match(edited, /本人が書いた次の一歩/);
});

// ---- 指摘 3: 照合の穴 ----

const meal14 = okEvent("meal_cost", { days_low: 14, days_high: 14 }); // 23,100 円
const date1121 = okEvent("calc_date", {
  start_date: "2026-11-21",
  steps: [],
  until_date: null,
});
const check = (reply: string, toolEvents: unknown[], userTexts: string[] = []) =>
  checkReply({
    reply,
    toolEvents: toolEvents as Parameters<typeof checkReply>[0]["toolEvents"],
    userTexts,
    today,
  });

test("指摘3: 失敗した計算の入力は根拠にしない", () => {
  const failed = { input: { amount_low: 777_777, amount_high: 777_777 } };
  assert.equal(check("777,777 円です。", [failed]).length, 1);
  // 成功した計算に渡した値は、これまでどおり書いてよい。
  assert.deepEqual(check("23,100 円です。", [meal14]), []);
});

test("指摘3: 年齢や日数のような金額でない数字を、金額の根拠にしない", () => {
  assert.equal(check("42 円です。", [], ["私は42歳です。"]).length, 1);
  assert.equal(check("14 円です。", [meal14]).length, 1);
  // 利用者が言った金額（万の付いた額）は、これまでどおり書いてよい。
  assert.deepEqual(
    check("240,000〜300,000 円と聞いています。", [], ["病院からは24万〜30万と聞いた。"]),
    [],
  );
});

test("指摘3: 年のある日付は年月日で照らし、曜日はプログラムが付けたものと照らす", () => {
  for (const ok of ["2026-11-21", "2026年11月21日", "2026/11/21", "11/21（土）", "11月21日(土)"])
    assert.deepEqual(check(`${ok}に入院します。`, [date1121]), [], ok);
  for (const ng of ["2028-11-21", "2028年11月21日", "2028/11/21", "11/21（日）", "2026-11-21（日）"])
    assert.equal(check(`${ng}に入院します。`, [date1121]).length, 1, ng);
});

test("指摘3: ¥・￥の付いた金額と、漢数字の金額も照らす", () => {
  for (const ng of ["¥123,456", "￥123,456", "十二万三千四百五十六円", "12万3千円"])
    assert.equal(check(`支払いは${ng}です。`, [meal14]).length, 1, ng);
  for (const ok of ["¥23,100", "￥23,100", "二万三千百円", "2万3100円"])
    assert.deepEqual(check(`食事代は${ok}です。`, [meal14]), [], ok);
});

// ---- 指摘 4・5: 確認の順位と残る幅 ----

const out = (date: string, label: string, low: number, high: number, certainty = "estimate"): LedgerEvent => ({
  date, label, direction: "out", amount_low: low, amount_high: high, certainty,
});
const income = (date: string, label: string, low: number, high: number, certainty = "assumption"): LedgerEvent => ({
  date, label, direction: "in", amount_low: low, amount_high: high, certainty,
});

test("指摘4: 必要額に効かない入金が多くても、効く支払いを先頭にし、上限で落としたら「一番」と言い切らない", () => {
  const confirm = simulateCashflow({
    start_date: today,
    cash_on_hand: null,
    scenarios: [
      {
        name: "試算",
        events: [
          out("2026-11-16", "入院費", 100_000, 150_000),
          ...Array.from({ length: 6 }, (_, index) =>
            income("2026-12-20", `給付${index + 1}`, 0, 1_000_000),
          ),
        ],
      },
    ],
  }).what_to_confirm;
  assert.ok(confirm);
  assert.equal(confirm.factors[0].label, "入院費");
  assert.equal(confirm.factors[0].shrink, 50_000);
  assert.equal(confirm.omitted_factors, 1);
  assert.ok(confirm.reading_guide.every((line) => !line.includes("一番")));
  assert.match(buildSystem(today)[0].content, /omitted_factors/);
});

test("指摘5: 必要額を決める支払いの時点が切り替わる中間の額も評価する", () => {
  const confirm = simulateCashflow({
    start_date: today,
    cash_on_hand: null,
    scenarios: [
      {
        name: "A",
        events: [
          out("2026-11-20", "確定の支払い", 90_000, 90_000, "confirmed"),
          out("2026-11-20", "通院費", 0, 100_000),
        ],
      },
      {
        name: "B",
        events: [
          income("2026-11-10", "確定の入金", 100_000, 100_000, "confirmed"),
          out("2026-11-20", "通院費", 0, 100_000),
          out("2026-11-21", "通院費", 0, 100_000),
        ],
      },
    ],
  }).what_to_confirm;
  assert.ok(confirm);
  const visits = confirm.factors.find((factor) => factor.label === "通院費");
  assert.equal(visits?.width_if_resolved, 140_000);
  assert.equal(confirm.width, 190_000);
});

test("体験例とストーリーの数字（115,690 円・264,750 円・差 149,060 円）は変わらない", () => {
  // 1 回目の計算: 窓口で上限を使う場合と使わない場合を並べる（#55 のストーリー）。
  const { first, second } = exampleMoneyTurns();
  const [withCap, withoutCap] = first.cashflow.scenarios;
  assert.equal(withCap.low_case.need, 115_690);
  assert.equal(withoutCap.low_case.need, 264_750);
  assert.equal(withoutCap.low_case.need - withCap.low_case.need, 149_060);
  const confirm = first.cashflow.what_to_confirm;
  assert.equal(confirm?.width, 149_060);
  assert.deepEqual(
    confirm?.factors.map((factor) => [factor.kind, factor.width_if_resolved, factor.shrink]),
    [["scenario", 0, 149_060]],
  );
  // 2 回目（確かめた額）は幅が無い。
  assert.equal(second.cashflow.what_to_confirm?.width, 0);
  assert.equal(second.cashflow.scenarios[0].low_case.need, 115_690);
  // 画面に出すお金のカードは 2 回目の計算を持つ。
  const card = exampleWorkspace().cards.find((item) => item.kind === "money");
  const found = card?.money?.calculations.find((item) => item.name === "simulate_cashflow");
  assert.ok(found?.name === "simulate_cashflow");
  assert.deepEqual(found.output, second.cashflow);
});

// ---- 指摘 6: 診療月ごとの計算記録 ----

test("指摘6: 12 月分だけ計算し直しても、11 月分の高額療養費の記録は残す", () => {
  const kougaku = (month: string, amount: number) => {
    const input = {
      treatment_month: month,
      income_category: "ウ",
      amount_basis: "total",
      amount_low: amount,
      amount_high: amount,
      copay_percent: 30,
    };
    return { name: "kougaku_gendo", input, output: outputOf("kougaku_gendo", input) };
  };
  const nov = kougaku("2026-11", 500_000);
  const decOld = kougaku("2026-12", 300_000);
  const decNew = kougaku("2026-12", 400_000);
  const { cards } = attachMoney({
    proposals: [proposal({ id: "m1", kind: "money" })],
    events: [{ ...decNew, ok: true }],
    existing: [{ ...proposal({ id: "m1", kind: "money" }), ...flags }],
    prior: new Map<string, Calculation[]>([
      ["m1", [calculationSchema.parse(nov), calculationSchema.parse(decOld)]],
    ]),
    messages: INPUT.messages,
  });
  const months = (cards[0].money?.calculations ?? []).map(
    (calculation) => [
      (calculation.input as { treatment_month: string }).treatment_month,
      (calculation.input as { amount_low: number }).amount_low,
    ],
  );
  assert.deepEqual(months, [
    ["2026-11", 500_000],
    ["2026-12", 400_000],
  ]);
});

// ---- 指摘 7: 給付の断定と、代行の完了 ----

test("指摘7: 給付の断定と代行の完了は、固定の案内に置き換える", async () => {
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep(
        "食事代は 24,750 円です。給付は必ず受けられます。病院への申請は済ませました。",
      ),
    ),
    input: INPUT,
  });
  assert.match(result.reply, /24,750 円/);
  assert.doesNotMatch(result.reply, /必ず受けられます|済ませました/);
  assert.match(result.reply, /確かめてください/);
});

test("指摘7: 体験例と、ふだんの言い回しは置き換えない", () => {
  const workspace = exampleWorkspace();
  const prose = [
    ...workspace.messages.map((message) => message.text),
    ...workspace.cards.flatMap((card) => [card.title, card.body, card.nextStep, card.uncertainty]),
    "給付金が出るかは、契約先に確かめてください。",
    "申請は、退院してからでも間に合います。",
    "病院の会計で、窓口で上限を適用できるかを聞く。",
    "必ず確かめてから払ってください。",
  ];
  for (const text of prose) assert.equal(softenClaims(text).text, text, text);
});

// 指摘 5 の確かめ: 少なめと多めのあいだを細かく区切り、台帳の計算で総当たりした残る幅と比べる。
// 架空の入力を固定の乱数で作る。境目の間を測りこぼさない（総当たりより小さくならない）ことと、
// 境目でない所を大きく見積もらない（区切りの粗さの分を超えて大きくならない）ことを確かめる。
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  return { int, pick };
}

test("指摘5: 残る幅は、少なめと多めのあいだを総当たりした値と合う（固定の乱数の架空入力 40 件）", () => {
  const r = seeded(59);
  const keyOf = (event: LedgerEvent) => `${event.direction}:${event.label}`;
  const STEPS = 100;
  let checked = 0;
  for (let round = 0; round < 40; round += 1) {
    const scenarios = Array.from({ length: r.int(1, 3) }, (_, index) => ({
      name: `筋書き${index + 1}`,
      events: Array.from({ length: r.int(2, 6) }, (): LedgerEvent => {
        const direction = r.pick(["out", "out", "in"]);
        const low = r.int(0, 20) * 10_000;
        return {
          date: `2026-11-${String(r.int(10, 28)).padStart(2, "0")}`,
          label: `${direction === "out" ? "支払い" : "入金"}${r.int(1, 3)}`,
          direction,
          amount_low: low,
          amount_high: low + r.pick([0, r.int(1, 20) * 10_000]),
          certainty: r.pick(["confirmed", "estimate", "assumption"]),
        };
      }),
    }));
    const confirm = simulateCashflow({ start_date: today, cash_on_hand: null, scenarios }).what_to_confirm;
    assert.ok(confirm);
    if (confirm.omitted_factors > 0) continue;
    const uncertain = (event: LedgerEvent) =>
      event.certainty !== "confirmed" &&
      (event.direction === "in" ? event.amount_high > 0 : event.amount_low !== event.amount_high);
    const factorKeys = new Set(scenarios.flatMap((s) => s.events.filter(uncertain).map(keyOf)));
    for (const factor of confirm.factors) {
      if (factor.kind !== "amount" && factor.kind !== "income") continue;
      const key = `${factor.kind === "income" ? "in" : "out"}:${factor.label}`;
      // ほかの不明点を、要る額が一番大きくなる端・一番小さくなる端に置いた、台帳の要る額。
      const needWith = (events: LedgerEvent[], t: number | "none", mode: "high" | "low") => {
        const pinned = events.map((event) => {
          let amount: number;
          if (event.certainty !== "confirmed" && keyOf(event) === key)
            amount = t === "none" ? 0 : Math.round(event.amount_low + (event.amount_high - event.amount_low) * t);
          else if (event.certainty !== "confirmed" && factorKeys.has(keyOf(event)))
            amount = mode === "high"
              ? (event.direction === "out" ? event.amount_high : 0)
              : (event.direction === "out" ? event.amount_low : event.amount_high);
          else if (mode === "high")
            amount = event.direction === "out" ? event.amount_high : event.certainty !== "confirmed" ? 0 : event.amount_low;
          else amount = event.direction === "out" ? event.amount_low : event.amount_high;
          // 額を決めたので「確かめた額」として渡す（基準の計算で順位づけを動かさない）。
          return { ...event, amount_low: amount, amount_high: amount, certainty: "confirmed" };
        });
        const [scenario] = simulateCashflow({
          start_date: today,
          cash_on_hand: null,
          scenarios: [{ name: "x", events: pinned }],
        }).scenarios;
        return scenario.high_case.need;
      };
      const widthAt = (t: number | "none") =>
        Math.max(...scenarios.map((s) => needWith(s.events, t, "high"))) -
        Math.min(...scenarios.map((s) => needWith(s.events, t, "low")));
      const grid = Array.from({ length: STEPS + 1 }, (_, index) => widthAt(index / STEPS));
      const brute = Math.max(...grid, ...(factor.kind === "income" ? [widthAt("none")] : []));
      // 区切りの粗さで見落とす分の上限: 一番大きい幅（20 万円）× 各筋書きの回数 × 2 ÷ 区切りの数。
      const slack = (200_000 * 6 * 2) / STEPS + 1;
      assert.ok(factor.width_if_resolved >= brute - 1, `${factor.name}: ${factor.width_if_resolved} < ${brute}`);
      assert.ok(factor.width_if_resolved <= brute + slack, `${factor.name}: ${factor.width_if_resolved} > ${brute}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `確かめた不明点 ${checked} 件`);
});
