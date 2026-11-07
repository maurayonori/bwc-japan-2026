import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat } from "../lib/chat";
import { exampleMoneyTurns } from "../lib/example";
import { checkReply, fixGapDirection, maskUnverified } from "../lib/money/guard";
import { monthSplitError } from "../lib/money/month-split";
import type { LedgerEvent } from "../lib/money/ledger";
import { executeTool } from "../lib/money/tools";
import { exportMemo, type Card, type Proposal } from "../lib/workspace";

// #66: 月をまたぐ入院の月ごとの額、足りない額の向き、検査の伏せすぎ。数字と会話はすべて架空。

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const today = "2026-11-07";
const flags = { edited: false, done: false, included: false };
type ToolCall = { name: string; input: unknown };
const toolStep = (...calls: ToolCall[]) => ({
  content: calls.map((call, index) => ({
    type: "tool-call" as const,
    toolCallId: `call-${call.name}-${index}-${Math.random()}`,
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
const SAID =
  "12月14日に入院して、28日に退院する予定です。病院の見積もりだと、医療費は総額で80万円くらい。協会けんぽで、給料は月35万円くらいです。すぐ使えるお金は20万円。";
const ASKED = "入院が1週間延びて、退院が1月4日になったら？";
const proposal = (patch: Partial<Proposal> = {}): Proposal => ({
  id: "m1",
  kind: "money",
  title: "支払日までに、手元に要る額",
  body: "表を読む。",
  nextStep: "読み返す。",
  uncertainty: "",
  evidence: [{ messageId: "u1", quote: SAID }],
  ...patch,
});
function okEvent(name: string, input: unknown) {
  const result = executeTool(name, input);
  assert.equal(result.ok, true, name);
  return { input, output: (result as { output: unknown }).output };
}

// ---- A-1: 月ごとの医療費を、同じ筋書きの中で独立した幅にしない ----

const kougaku = (month: string, low: number, high: number) => ({
  treatment_month: month,
  income_category: "ウ",
  amount_basis: "total",
  amount_low: low,
  amount_high: high,
  copay_percent: 30,
});
const MEAL_22 = { days_low: 22, days_high: 22 }; // 12/14〜1/4 は 22 日間、36,300 円
const out = (label: string, low: number, high: number, date = "2027-01-04"): LedgerEvent => ({
  date,
  label,
  direction: "out",
  amount_low: low,
  amount_high: high,
  certainty: low === high ? "estimate" : "assumption",
});
// 1 回目の返答の入力の形: 12 月分と 1 月分を、それぞれ 0〜80 万円の独立した幅として置いた。
const FIRST_RUN = {
  start_date: today,
  cash_on_hand: 200_000,
  scenarios: [
    {
      name: "窓口で上限が使える場合",
      events: [
        out("入院費（12 月分の保険診療分）", 0, 90_940),
        out("入院費（1 月分の保険診療分）", 0, 90_940),
        out("入院中の食事代", 36_300, 36_300),
      ],
    },
  ],
};
// 2 回目の返答の入力の形: 筋書きごとに月の額を 1 つに決めた。
const SECOND_RUN = {
  start_date: today,
  cash_on_hand: 200_000,
  scenarios: [
    { name: "費用が 12 月に寄る", events: [out("入院費（12 月分）", 90_940, 90_940), out("入院中の食事代", 36_300, 36_300)] },
    { name: "費用が 1 月に寄る", events: [out("入院費（1 月分）", 90_940, 90_940), out("入院中の食事代", 36_300, 36_300)] },
    {
      name: "費用が半々",
      events: [out("入院費（12 月分）", 86_940, 86_940), out("入院費（1 月分）", 86_940, 86_940), out("入院中の食事代", 36_300, 36_300)],
    },
  ],
};
const rangedKougaku = [
  okEvent("kougaku_gendo", kougaku("2026-12", 0, 800_000)),
  okEvent("kougaku_gendo", kougaku("2027-01", 0, 800_000)),
];

test("A-1: 月ごとの医療費を同じ筋書きの中で別々の幅にした入力は、道具のエラーで差し戻す", () => {
  const error = monthSplitError(FIRST_RUN, rangedKougaku);
  assert.ok(error);
  assert.match(error, /筋書きごとに/);
  // 筋書きごとに月の額を決めた入力は受け付ける。
  assert.equal(monthSplitError(SECOND_RUN, rangedKougaku), null);
  // 1 か月だけの幅（上限が使えるか分からないときなど）は受け付ける。
  assert.equal(
    monthSplitError({ ...FIRST_RUN, scenarios: [{ name: "試算", events: [out("入院費", 90_940, 264_750)] }] }, []),
    null,
  );
});

test("A-1: 1 回目の入力の形は会話の中で差し戻され、2 回目の形でデモの数字（127,240〜210,180 円、10,180 円足りない、幅 82,940 → 0 円）になる", async () => {
  const result = await runChat({
    model: mock(
      toolStep(
        { name: "kougaku_gendo", input: kougaku("2026-12", 0, 800_000) },
        { name: "kougaku_gendo", input: kougaku("2027-01", 0, 800_000) },
        { name: "meal_cost", input: MEAL_22 },
      ),
      toolStep({ name: "simulate_cashflow", input: FIRST_RUN }),
      toolStep(
        { name: "kougaku_gendo", input: kougaku("2026-12", 400_000, 400_000) },
        { name: "kougaku_gendo", input: kougaku("2027-01", 400_000, 400_000) },
      ),
      toolStep({ name: "simulate_cashflow", input: SECOND_RUN }),
      replyStep("退院が1月4日になると、手元に要る額は 127,240 円から 210,180 円です。", [proposal()]),
    ),
    input: {
      messages: [
        { id: "u1", role: "user", text: SAID },
        { id: "a1", role: "assistant", text: "手元に要る額は 115,690 円です。" },
        { id: "u2", role: "user", text: ASKED },
      ],
      cards: [],
    },
  });
  const cashflows = result.cards[0].money?.calculations.filter((item) => item.name === "simulate_cashflow") ?? [];
  assert.equal(cashflows.length, 1);
  const confirm = (cashflows[0].output as { what_to_confirm: { need_low: number; need_high: number; width: number; shortfall_high: number; factors: { width_if_resolved: number }[] } }).what_to_confirm;
  assert.deepEqual([confirm.need_low, confirm.need_high, confirm.width, confirm.shortfall_high], [127_240, 210_180, 82_940, 10_180]);
  assert.equal(confirm.factors[0].width_if_resolved, 0);
  assert.deepEqual(result.warnings, []);
});

// ---- A-3: 足りない額の向き ----

const monthCalc = okEvent("simulate_cashflow", SECOND_RUN);

test("A-3: 足りない額を「足ります」と書いた文は、計算から作った文に置き換える", () => {
  const wrong = "手元の20万円では、分かれる場合に 10,180 円足ります。";
  const fixed = fixGapDirection(wrong, [monthCalc]);
  assert.equal(fixed.replaced, 1);
  assert.doesNotMatch(fixed.text, /足ります/);
  assert.match(fixed.text, /「費用が半々」/);
  assert.match(fixed.text, /10,180 円足りない/);
  for (const right of ["手元の20万円では、分かれる場合に 10,180 円足りません。", "半々なら 10,180 円足りなくなります。", "12 月に寄るなら 72,760 円残ります。"])
    assert.equal(fixGapDirection(right, [monthCalc]).replaced, 0, right);
  // 残る額を「足りない」と書いた文も置き換える。
  assert.equal(fixGapDirection("12 月に寄るなら 72,760 円足りません。", [monthCalc]).replaced, 1);
  // 足りる側と足りない側の言い方がまざって判別できない文は、置き換えない。
  assert.equal(fixGapDirection("半々なら 10,180 円足りませんが、12 月に寄るなら足ります。", [monthCalc]).replaced, 0);
});

test("A-3: 返答・カード・持ち出しの文にも、足りない額の向きの検査をかける", async () => {
  const wrong = "手元の20万円では、分かれる場合に 10,180 円足ります。";
  const result = await runChat({
    model: mock(toolStep({ name: "simulate_cashflow", input: SECOND_RUN }), replyStep(wrong, [proposal({ body: wrong })])),
    input: { messages: [{ id: "u1", role: "user", text: SAID }], cards: [] },
  });
  assert.doesNotMatch(result.reply, /足ります/);
  assert.match(result.reply, /10,180 円足りない/);
  assert.doesNotMatch(result.cards[0].body, /足ります/);
  const saved: Card = { ...result.cards[0], ...flags, included: true, body: wrong };
  assert.doesNotMatch(exportMemo([saved], [{ id: "u1", role: "user", text: SAID }]), /10,180 円足ります/);
});

// ---- A-2: 普通の言い回しの正しい文を伏せない ----

const rangeOf = (name: string, low: number, high: number) => ({
  name,
  events: [{ ...out("入院費", low, high, "2026-12-28") }],
});
const check = (reply: string, toolEvents: unknown[], userTexts: string[] = []) =>
  checkReply({ reply, toolEvents: toolEvents as never, userTexts, today });

test("A-2①: 条件に「前提で」などが入っても、条件の部分が多く一致する筋書きで照らす。絞れなければ照らさない", () => {
  const calc = okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: null,
    scenarios: [rangeOf("窓口で上限が使える・費用が12月に寄る", 127_240, 150_000), rangeOf("窓口で上限が使える・費用が半々", 210_180, 230_000)],
  });
  assert.deepEqual(check("窓口で上限が使える前提で費用が半々の場合、手元に要る額は210,180円から230,000円です。", [calc]), []);
  // どちらの筋書きかを絞れない言い方は、照らさない。
  assert.deepEqual(check("窓口で上限が使える前提で費用が分かれる場合、手元に要る額は210,180円から230,000円です。", [calc]), []);
  // 条件に当たる筋書きと合わない範囲は、これまでどおり指摘する。
  assert.equal(check("窓口で上限が使える前提で費用が半々の場合、手元に要る額は127,240円から230,000円です。", [calc]).length, 1);
});

test("A-2②: 従属節の主語（「私が入院している間に」）を、済ませた人として拾わない", async () => {
  const said = "夫は私が入院している間に、保険会社に連絡しました。";
  const result = await runChat({
    model: mock(replyStep("ご主人が保険会社に連絡しました。")),
    input: { messages: [{ id: "u1", role: "user", text: said }], cards: [] },
  });
  assert.match(result.reply, /ご主人が保険会社に連絡しました。/);
});

test("A-2③: 前の値の文の途中にほかの額があっても、切り替えの語が無ければ前の値として照らさない", () => {
  const { first, second } = exampleMoneyTurns();
  const events = [...first.calculations, ...second.calculations];
  const past = "前の試算では医療費の総額が80万円で要る額は115,690円〜264,750円でした。";
  assert.deepEqual(check(past, events, [SAID]), []);
  assert.equal(maskUnverified({ reply: past, toolEvents: events as never, userTexts: [SAID], today }).masked, 0);
  // 切り替えの語があれば、今の値として照らす。
  assert.equal(check("前の試算では115,690円でしたが、今の要る額は115,690円〜264,750円です。", events, [SAID]).length, 1);
});

// ===== #67 への Codex の確認（中 4 件） =====

test("Codex③: 時を示す語（「退院前に」「仕事の合間に」）だけでは、主節の主語を外さない", async () => {
  for (const said of ["夫が退院前に保険会社に連絡しました。", "夫が仕事の合間に、保険会社に連絡しました。"]) {
    const result = await runChat({
      model: mock(replyStep("ご主人が保険会社に連絡しました。")),
      input: { messages: [{ id: "u1", role: "user", text: said }], cards: [] },
    });
    assert.match(result.reply, /ご主人が保険会社に連絡しました。/, said);
  }
});

test("Codex①: 総額に幅がある月ごとの見積もり（12 月 70〜80 万円・1 月 0〜10 万円）は差し戻さない", () => {
  const sources = [
    okEvent("kougaku_gendo", kougaku("2026-12", 700_000, 800_000)),
    okEvent("kougaku_gendo", kougaku("2027-01", 0, 100_000)),
  ];
  const input = {
    start_date: today,
    cash_on_hand: 200_000,
    scenarios: [
      {
        name: "病院の見積もり",
        events: [out("入院費（12 月分）", 89_940, 90_940), out("入院費（1 月分）", 0, 30_000), out("入院中の食事代", 36_300, 36_300)],
      },
    ],
  };
  assert.equal(monthSplitError(input, sources), null);
  // 決まった総額を、月ごとに 0 円からの同じ幅へ広げた入力は、これまでどおり差し戻す。
  assert.ok(monthSplitError(FIRST_RUN, rangedKougaku));
});

test("Codex②: 準備の方法を言う条件の文や、問いの形の文は、足りない額の向きを判別できないとして置き換えない", () => {
  for (const text of [
    "手元の20万円に10,180円を追加すれば、半々の場合でも足ります。",
    "足りるかどうかは、10,180 円を用意できるかで決まります。",
  ])
    assert.equal(fixGapDirection(text, [monthCalc]).replaced, 0, text);
  // 向きを逆に書いただけの文は、これまでどおり置き換える。
  assert.equal(fixGapDirection("手元の20万円では、分かれる場合に 10,180 円足ります。", [monthCalc]).replaced, 1);
});

test("Codex④: 筋書きを見分ける部分が短くても（「半々」）、一致の条件に入れる。絞れなければ照らさない", () => {
  const calc = okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: null,
    scenarios: [rangeOf("窓口で上限が使える（12月寄り）", 127_240, 150_000), rangeOf("窓口で上限が使える（半々）", 210_180, 230_000)],
  });
  assert.deepEqual(check("窓口で上限が使える前提の場合、手元に要る額は127,240円から230,000円です。", [calc]), []);
  // 短い部分まで条件に入っていれば、その筋書きと照らす。
  assert.deepEqual(check("窓口で上限が使える前提で半々の場合、手元に要る額は210,180円から230,000円です。", [calc]), []);
  assert.equal(check("窓口で上限が使える前提で半々の場合、手元に要る額は127,240円から230,000円です。", [calc]).length, 1);
});
