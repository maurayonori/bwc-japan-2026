import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat, toResponse } from "../lib/chat";
import { checkReply, fitLength, maskUnverified } from "../lib/money/guard";
import { simulateCashflow, type LedgerEvent } from "../lib/money/ledger";
import { executeTool } from "../lib/money/tools";
import { exampleMoneyTurns } from "../lib/example";
import { buildSystem } from "../lib/prompt";
import {
  MEMORY_NEXT_STEP,
  exportMemo,
  mergeCards,
  parseStoredWorkspace,
  replySchema,
  requestSchema,
  type Card,
  type ChatRequest,
  type Proposal,
} from "../lib/workspace";

// PR #61 の外部レビュー（Codex・Cursor）と、統括セッションの実 API の確かめで見つかった誤り。
// 指摘ごとに、再現をそのままテストにする。数字と会話はすべて架空。

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const MEAL = { days_low: 15, days_high: 15 }; // 24,750 円
const QUOTE = "来月2週間入院する。";
const INPUT: ChatRequest = {
  messages: [{ id: "u1", role: "user", text: `${QUOTE}いくら手元に要るか知りたい。` }],
  cards: [],
};
const today = "2026-11-07";
const flags = { edited: false, done: false, included: false };

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

function okEvent(name: string, input: unknown) {
  const result = executeTool(name, input);
  assert.equal(result.ok, true, name);
  return { input, output: (result as { output: unknown }).output };
}
const pay = (amount: number, label = "入院費"): LedgerEvent => ({
  date: "2026-12-28",
  label,
  direction: "out",
  amount_low: amount,
  amount_high: amount,
  certainty: "confirmed",
});
const cashflowOf = (...amounts: number[]) =>
  okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: null,
    scenarios: [{ name: "試算", events: amounts.map((amount, index) => pay(amount, `支払い${index + 1}`)) }],
  });
const meal = okEvent("meal_cost", MEAL);
const check = (reply: string, toolEvents: unknown[], userTexts: string[] = []) =>
  checkReply({
    reply,
    toolEvents: toolEvents as Parameters<typeof checkReply>[0]["toolEvents"],
    userTexts,
    today,
  });

// ---- 1: 円を省いた額 ----

test("指摘1: 「12万」「15万」「28万ほど」のように円を省いた額も照らし、伏せる", () => {
  assert.equal(check("窓口の支払いは12万です。", [meal]).length, 1);
  assert.equal(check("窓口では 15万、上限なしなら 28万ほどです。", [meal]).length, 2);
  const masked = maskUnverified({ reply: "窓口では 15万、上限なしなら 28万ほどです。", toolEvents: [meal], userTexts: [], today });
  assert.doesNotMatch(masked.text, /15万|28万/);
});

test("指摘1: 円を省いた照らせない額を持つカードは、持ち出しに入らない", async () => {
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep("食事代を計算しました。", [
        proposal({ id: "c1", kind: "contact", title: "病院の会計に、このまま聞く", body: "窓口の支払いは12万で足りますか。" }),
      ]),
    ),
    input: INPUT,
  });
  const text = exportMemo(mergeCards([], result.cards).map((card) => ({ ...card, included: true })));
  assert.doesNotMatch(text, /12万/);
});

// ---- 2: 照合が済んだ過去の値 ----

test("指摘2: 前の返答で照らした額は、計算を置き換えたあとの返答でも伏せない", async () => {
  const month = { start_date: today, cash_on_hand: null, scenarios: [{ name: "月またぎ", events: [pay(127_240)] }] };
  const card = { ...proposal({ id: "m1", kind: "money" }), ...flags, money: { calculations: [{ name: "simulate_cashflow", input: month }] } };
  const messages = [
    INPUT.messages[0],
    { id: "a1", role: "assistant" as const, text: "手元に要る額は 115,690 円です。" },
    { id: "u2", role: "user" as const, text: "1月4日まで延びたら？" },
    { id: "a2", role: "assistant" as const, text: "月をまたぐので、127,240 円になります。" },
    { id: "u3", role: "user" as const, text: "前と比べてどう？" },
  ];
  const result = await runChat({
    model: mock(replyStep("前は115,690円でしたが、今は127,240円です。")),
    input: requestSchema.parse({ messages, cards: [card] }),
  });
  assert.match(result.reply, /前は115,690円でしたが/);
  assert.deepEqual(result.warnings, []);
  // 前の返答に無ければ、これまでどおり伏せる。
  const unknown = await runChat({
    model: mock(replyStep("前は115,691円でしたが、今は127,240円です。")),
    input: requestSchema.parse({ messages, cards: [card] }),
  });
  assert.doesNotMatch(unknown.reply, /115,691/);
});

// ---- 3: 後処理のあとの長さ ----

test("指摘3: 伏字と注記で字数が増えても、返答の形の上限を超えず、表を失わない", async () => {
  const reply = "あ".repeat(1788) + "123456円です。";
  assert.equal(reply.length, 1798);
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep(reply, [proposal({ id: "m1", kind: "money", body: "食事代は 24,750 円です。" })]),
    ),
    input: INPUT,
  });
  const response = toResponse(result);
  assert.equal(replySchema.safeParse(response).success, true);
  assert.ok(response.reply.length <= 1800);
  assert.doesNotMatch(response.reply, /123456/);
  assert.ok(response.cards[0].money);
});

test("指摘3: 198 字の次の行動を固定の案内に置き換えても、200 字を超えない", async () => {
  const nextStep = "給付は必ず受けられます。" + "あ".repeat(198 - 12);
  assert.equal(nextStep.length, 198);
  const result = await runChat({
    model: mock(replyStep("例", [proposal({ nextStep })])),
    input: INPUT,
  });
  const response = toResponse(result);
  assert.equal(replySchema.safeParse(response).success, true);
  assert.equal(response.cards.length, 1);
  assert.ok(response.cards[0].nextStep.length <= 200);
  assert.doesNotMatch(response.cards[0].nextStep, /必ず受けられます/);
});

// ---- 4: 書き方の揺れ ----

test("指摘4: 空白や単位のまざった書き方でも、額の全体で照らす", () => {
  assert.deepEqual(check("要る額は11万 5,690円です。", [cashflowOf(115_690)]), []);
  assert.deepEqual(check("食事代は2万 4,750円です。", [meal]), []);
  assert.deepEqual(check("支払いは￥12万3千です。", [cashflowOf(123_000)]), []);
  const masked = maskUnverified({ reply: "要る額は11万 5,690円です。", toolEvents: [cashflowOf(115_690)] as never, userTexts: [], today });
  assert.equal(masked.masked, 0);
  // 違う額なら、額の全体を 1 つとして伏せる。
  const wrong = maskUnverified({ reply: "要る額は11万 5,691円です。", toolEvents: [cashflowOf(115_690)] as never, userTexts: [], today });
  assert.match(wrong.text, /要る額は（照合できない金額）です/);
});

// ---- 5: 本人が済ませた報告 ----

test("指摘5: 本人が済ませたと話した報告は、代行の断定として置き換えない", async () => {
  const said = "私はすでに保険会社に申請しました。";
  const result = await runChat({
    model: mock(
      replyStep("申請は済ませました。", [
        proposal({
          id: "c1",
          kind: "contact",
          title: "保険会社に、このまま聞く",
          body: `${said}給付の対象になるか教えてください。`,
          evidence: [{ messageId: "u1", quote: said }],
        }),
      ]),
    ),
    input: { messages: [{ id: "u1", role: "user", text: said }], cards: [] },
  });
  assert.match(result.cards[0].body, /私はすでに保険会社に申請しました。/);
  // アプリが済ませたと読める返答は、これまでどおり置き換える。
  assert.doesNotMatch(result.reply, /済ませました/);
});

// ---- 6: 見出しと、強調の語の無い断定 ----

test("指摘6: 見出しの断定と、強調の語の無い給付の断定も置き換える", async () => {
  const result = await runChat({
    model: mock(replyStep("例", [proposal({ title: "給付は必ず受けられます。", body: "給付金は支給されます。朝は7時に起きる。" })])),
    input: INPUT,
  });
  const [card] = result.cards;
  assert.doesNotMatch(card.title, /必ず受けられます/);
  assert.ok(card.title.length <= 80);
  assert.doesNotMatch(card.body, /支給されます/);
  assert.match(card.body, /朝は7時に起きる。/);
});

// ---- 7: お金のカードは違反した部分だけ ----

test("指摘7: お金のカードは、照らせない数字の部分だけを伏せ、見出しと正しい文は残す", async () => {
  const result = await runChat({
    model: mock(
      toolStep({ name: "meal_cost", input: MEAL }),
      replyStep("例", [
        proposal({ id: "m1", kind: "money", title: "支払日までに、手元に要る額", body: "食事代は 24,750 円です。支払いは123,456円です。" }),
      ]),
    ),
    input: INPUT,
  });
  const [card] = result.cards;
  assert.ok(card.money);
  assert.equal(card.title, "支払日までに、手元に要る額");
  assert.match(card.body, /食事代は 24,750 円です。/);
  assert.doesNotMatch(card.body, /123,456/);
});

// ---- 8: 仮の問いで、返答の範囲とプログラムの範囲が食い違う ----

// 統括セッションの実 API の手順（12/14 入院・総額 80 万円・協会けんぽ・月 35 万円 → 窓口で上限が使える → 1/4 まで延びたら？）の 3 回目。
// Claude が元の筋書き（115,690 円）を見通しに入れたので、プログラムの範囲は 115,690〜210,180 円（幅 94,490 円）になったのに、
// 返答は延びた場合の範囲だけを「127,240 円から 210,180 円」と書いた。
const THIRD_REPLY =
  "退院が1月4日になると、手元に要る額は 127,240 円から 210,180 円です。まず確かめる 1 つは、12 月と 1 月の費用の内訳です。病院の会計に聞くと、要る額の幅は 94,490 円から 0 円に縮みます。";
const scenario = (name: string, amount: number) => ({ name, events: [pay(amount)] });

test("指摘8: 返答の要る額の範囲が、最新の計算の範囲と合わなければ指摘する", () => {
  const withOld = okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: 200_000,
    scenarios: [scenario("窓口で上限が使える（1 回目の条件）", 115_690), scenario("費用が 12 月に寄る", 127_240), scenario("費用が半々", 210_180)],
  });
  const asked = ["入院が1週間延びて、退院が1月4日になったら？"];
  const warnings = check(THIRD_REPLY, [withOld], asked);
  assert.ok(warnings.some((warning) => warning.shown.includes("127,240") && warning.shown.includes("210,180")), JSON.stringify(warnings));
  // 新しい条件の筋書きだけなら、同じ範囲の文は通る。
  const onlyNew = okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: 200_000,
    scenarios: [scenario("費用が 12 月に寄る", 127_240), scenario("費用が半々", 210_180)],
  });
  assert.deepEqual(check(THIRD_REPLY.replace("94,490", "82,940"), [onlyNew], asked), []);
});

test("指摘8: プロンプトは、仮の問いでも新しい条件の筋書きだけを置き、前の額は前の値として書かせる", () => {
  const text = buildSystem(today)[0].content;
  for (const phrase of ["新しい条件の筋書きだけを置く", "前は ◯ 円でした", "comparison_with_first は、同じ条件の中で比べる"])
    assert.ok(text.includes(phrase), phrase);
});

// ---- 9: 途中まで重ねて取り出す ----

test("指摘9: 発言の額は途中まで重ねて取り出さず、歩・歳などが続く数字は額にしない", () => {
  assert.equal(check("12万円です。", [], ["12万3千円かかると言われた。"]).length, 1);
  assert.deepEqual(check("123,000 円です。", [], ["12万3千円かかると言われた。"]), []);
  assert.equal(check("3,000円です。", [], ["私は三千歩歩く。"]).length, 1);
  assert.equal(check("40,000円です。", [], ["4万人が使う。"]).length, 1);
  // 単位は数字のすぐあとのものだけを見る。空白のあとの語で額を外さない。
  assert.equal(check("支払いは12万 月末までに。", []).length, 1);
});

// ---- 10: 和暦と、括弧の無い曜日 ----

test("指摘10: 和暦の年と、括弧の無い曜日も照らす", () => {
  const date = okEvent("calc_date", { start_date: "2026-11-21", steps: [], until_date: null });
  assert.equal(check("令和10年11月21日に入院します。", [date]).length, 1);
  assert.deepEqual(check("令和8年11月21日に入院します。", [date]), []);
  assert.equal(check("11月21日 日曜日に入院します。", [date]).length, 1);
  assert.deepEqual(check("11月21日 土曜日に入院します。", [date]), []);
});

// ---- 11: 保存済みの残しておく言葉 ----

test("指摘11: 保存済みの残しておく言葉は、読み込むときに原文の見出しと決まった次の行動にする", () => {
  const body = "毎朝、白い棚から着替えを取ります。";
  const memory = (patch: Partial<Card>): Card => ({
    ...proposal({ id: "mem", kind: "memory", title: "娘とハワイへ行った思い出", body, nextStep: "ハワイの写真を探す。", uncertainty: "旅行の日付は未確認。" }),
    ...flags,
    ...patch,
  });
  const stored = { version: 2, mode: "live", messages: [{ id: "u1", role: "user", text: body }], cards: [memory({}), memory({ id: "mem2", edited: true })] };
  const [plain, edited] = parseStoredWorkspace(JSON.stringify(stored)).cards;
  assert.equal(plain.title, body);
  assert.equal(plain.nextStep, MEMORY_NEXT_STEP);
  assert.equal(plain.uncertainty, "");
  assert.equal(edited.title, "娘とハワイへ行った思い出");
});

// ---- 12: 同点の順位 ----

test("指摘12: 候補を 6 件に絞るときも、同点は縮む額 → 種類 → 入力順で決める（ADR 0013）", () => {
  const confirm = simulateCashflow({
    start_date: today,
    cash_on_hand: null,
    scenarios: [
      {
        name: "試算",
        events: [
          pay(100_000, "入院費"),
          // 支払いのあとの入金は要る額に効かない（縮む額はどれも 0）。入力の早いものほど幅が小さい。
          ...Array.from({ length: 7 }, (_, index): LedgerEvent => ({
            date: "2027-01-20",
            label: `給付${index + 1}`,
            direction: "in",
            amount_low: 0,
            amount_high: (index + 1) * 10_000,
            certainty: "assumption",
          })),
        ],
      },
    ],
  }).what_to_confirm;
  assert.ok(confirm);
  assert.equal(confirm.omitted_factors, 1);
  assert.deepEqual(
    confirm.factors.map((factor) => factor.label),
    ["給付1", "給付2", "給付3", "給付4", "給付5", "給付6"],
  );
});

// ===== 3 回目: 2 回目への外部レビュー（Codex・Cursor）で見つかった誤り =====

// 月またぎで、窓口の上限が使える 2 本と、使えない 1 本の筋書き。
const monthWithCap = (names: [string, string, string]) =>
  okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: 200_000,
    scenarios: [scenario(names[0], 127_240), scenario(names[1], 210_180), scenario(names[2], 276_300)],
  });
const CAP_NAMES: [string, string, string] = [
  "窓口で上限が使える・費用が 12 月に寄る",
  "窓口で上限が使える・費用が半々",
  "窓口で上限が使えない",
];
const CONDITIONAL_REPLY =
  "窓口で上限が使える場合、手元に要る額は127,240円から210,180円です。上限が使えない場合は276,300円です。";

test("3回目 指摘1: 条件をつけた正しい範囲は、その条件の筋書きの範囲と照らして通す", () => {
  const calc = monthWithCap(CAP_NAMES);
  assert.deepEqual(check(CONDITIONAL_REPLY, [calc]), []);
  assert.equal(maskUnverified({ reply: CONDITIONAL_REPLY, toolEvents: [calc] as never, userTexts: [], today }).masked, 0);
  // 条件の筋書きと合わない範囲は、これまでどおり指摘する。
  const wrong = CONDITIONAL_REPLY.replace("210,180円です", "276,300円です");
  assert.ok(check(wrong, [calc]).some((warning) => warning.shown.includes("127,240") && warning.shown.includes("276,300")));
  // 条件を筋書きに結び付けられないときは、正しい返答を伏せないほうを取り、指摘しない。
  const unnamed = monthWithCap(["費用が 12 月に寄る", "費用が半々", "上限なし"]);
  assert.deepEqual(check(CONDITIONAL_REPLY, [unnamed]), []);
});

test("3回目 指摘2: 家族の完了報告は、本人が同じことを話していれば残し、アプリが行ったと読める文は置き換える", async () => {
  const wife = "妻がすでに保険会社に連絡しました。";
  const said = "私はすでに保険会社に申請しました。";
  const run = (reply: string, userText: string, cards: Proposal[] = []) =>
    runChat({
      model: mock(replyStep(reply, cards)),
      input: { messages: [{ id: "u1", role: "user", text: userText }], cards: [] },
    });
  const family = await run(`${wife}次は病院の会計です。`, wife, [
    proposal({ id: "c1", kind: "contact", title: "保険会社に、このまま聞く", body: `${wife}必要な書類を教えてください。`, evidence: [{ messageId: "u1", quote: wife }] }),
  ]);
  assert.match(family.reply, /妻がすでに保険会社に連絡しました。/);
  assert.match(family.cards[0].body, /妻がすでに保険会社に連絡しました。/);
  // 本人の発言を返答で繰り返しても、置き換えない（Cursor の指摘）。
  assert.match((await run(said, said)).reply, /私はすでに保険会社に申請しました。/);
  // 「あなたが」があっても、アプリが代わりに行ったと読める文は置き換える。
  assert.doesNotMatch((await run("あなたが安心できるよう、代わりに保険会社に申請しました。", said)).reply, /申請しました/);
  assert.doesNotMatch((await run("こちらで申請しておきました。", said)).reply, /しておきました/);
  // 本人が話していない家族の完了報告は、置き換える。
  assert.doesNotMatch((await run("妻が保険会社に連絡しました。", "来月入院します。")).reply, /連絡しました/);
});

test("3回目 指摘3: 「幅」「前は」が文にあっても、要る額の範囲そのものは照らす", () => {
  const withOld = okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: 200_000,
    scenarios: [scenario("窓口で上限が使える（1 回目の条件）", 115_690), scenario("費用が 12 月に寄る", 127_240), scenario("費用が半々", 210_180)],
  });
  assert.equal(check("手元に要る額の幅は127,240円〜210,180円です。", [withOld]).length, 1);
  assert.equal(check("前は115,690円でしたが、今の要る額は127,240円〜210,180円です。", [withOld]).length, 1);
  // 幅の縮みを言う部分と、前の値を言う部分は照らさない。
  assert.deepEqual(check("要る額の幅は 94,490 円から 0 円に縮みます。", [withOld]), []);
  assert.deepEqual(check("前の要る額は 127,240 円から 210,180 円でした。", [withOld]), []);
});

test("3回目 指摘4: 「1〜2千円」の左端は、右端の千を借りて 1,000 円と読む", () => {
  assert.deepEqual(check("文書料は1〜2千円です。", [cashflowOf(1_000, 2_000)]), []);
  assert.equal(maskUnverified({ reply: "文書料は1〜2千円です。", toolEvents: [cashflowOf(1_000, 2_000)] as never, userTexts: [], today }).masked, 0);
});

test("3回目 指摘5: 字数の調整で、全角の金額を途中で切らない", () => {
  const text = "あ".repeat(1795) + "１１５，６９０円です。";
  const fitted = fitLength(text, 1800);
  assert.ok(fitted.length <= 1800);
  assert.doesNotMatch(fitted, /[０-９]/);
  const half = fitLength("あ".repeat(1790) + "要る額は 11万 5,690 円です。", 1800);
  assert.doesNotMatch(half, /11万|5,6/);
});

test("3回目 指摘6: 持ち出しの直前にも検査し、照らせない数字は伏せる。編集したカードはそのまま", () => {
  const body = "窓口の支払いは12万で足りますか。";
  const base: Card = {
    ...proposal({ id: "c1", kind: "contact", title: "病院の会計に、このまま聞く", body }),
    ...flags,
    included: true,
  };
  const messages = [{ id: "u1", role: "user" as const, text: INPUT.messages[0].text }];
  const text = exportMemo([base], messages);
  assert.doesNotMatch(text, /12万/);
  assert.match(text, /窓口の支払いは/);
  const edited = exportMemo([{ ...base, edited: true }], messages);
  assert.match(edited, /12万/);
  // 本人が話した額は伏せない。
  const said = exportMemo([{ ...base, body: "窓口の支払いは12万で足りますか。" }], [{ id: "u1", role: "user", text: "窓口で12万と言われた。" }]);
  assert.match(said, /12万/);
});

// ===== 4 回目: 3 回目への外部レビュー（Codex）で見つかった誤り =====

test("4回目 指摘④: 持ち出しの範囲の検査は、そのカード自身の計算で行う（あとの計算のカードがあっても伏せない）", () => {
  const { first, second } = exampleMoneyTurns();
  const body = "手元に要る額は115,690円〜264,750円です。";
  const card = (id: string, calculations: typeof first.calculations, included: boolean): Card => ({
    ...proposal({ id, kind: "money", title: "支払日までに、手元に要る額", body }),
    ...flags,
    included,
    money: { calculations },
  });
  const chosen = card("m1", first.calculations, true);
  const later = card("m2", second.calculations, false);
  for (const cards of [[chosen], [chosen, later], [later, chosen]]) {
    const text = exportMemo(cards, []);
    assert.match(text, /115,690円〜264,750円/, JSON.stringify(cards.map((item) => item.id)));
    assert.doesNotMatch(text, /照合できない/);
  }
  // 自分の計算と合わない範囲は、これまでどおり伏せる。
  const wrong = { ...chosen, body: "手元に要る額は115,690円〜300,000円です。" };
  assert.doesNotMatch(exportMemo([wrong, later], []), /115,690円〜300,000円/);
});

const rangeOf = (name: string, low: number, high: number) => ({
  name,
  events: [{ ...pay(low), amount_high: high, certainty: "assumption" as const }],
});

test("4回目 指摘①: 複合した条件は、条件全体が一致する筋書きを先に使う", () => {
  const calc = okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: null,
    scenarios: [
      rangeOf("窓口で上限が使える・費用が12月に寄る", 127_240, 150_000),
      rangeOf("窓口で上限が使える・費用が半々", 210_180, 230_000),
    ],
  });
  assert.deepEqual(check("窓口で上限が使える・費用が半々の場合、手元に要る額は210,180円から230,000円です。", [calc]), []);
  // 条件の一部（窓口で上限が使える）だけなら、当たる筋書きをすべて合わせた範囲と照らす。
  assert.deepEqual(check("窓口で上限が使える場合、手元に要る額は127,240円から230,000円です。", [calc]), []);
});

test("4回目 指摘②: 完了の報告は、完了した行為のすぐ前の主語と結び付ける", async () => {
  const run = (reply: string, userText: string) =>
    runChat({ model: mock(replyStep(reply)), input: { messages: [{ id: "u1", role: "user", text: userText }], cards: [] } });
  assert.match((await run("ご主人が保険会社に連絡しました。", "私は入院中で、夫が保険会社に連絡しました。")).reply, /ご主人が保険会社に連絡しました。/);
  assert.doesNotMatch((await run("あなたは入院中で、私が保険会社に連絡しました。", "私は保険会社に連絡しました。")).reply, /私が保険会社に連絡しました/);
});

test("4回目 指摘③: 前の値の例外は、読点の位置でなく、前の値と範囲のあいだで決める", () => {
  const withOld = okEvent("simulate_cashflow", {
    start_date: today,
    cash_on_hand: 200_000,
    scenarios: [scenario("窓口で上限が使える（1 回目の条件）", 115_690), scenario("費用が 12 月に寄る", 127_240), scenario("費用が半々", 210_180)],
  });
  const mixed = "前は115690円でしたが今の要る額は127,240円〜210,180円です。";
  assert.equal(check(mixed, [withOld]).length, 1);
  assert.ok(maskUnverified({ reply: mixed, toolEvents: [withOld] as never, userTexts: [], today }).masked > 0);
  assert.deepEqual(check("前の要る額は、127,240円から210,180円でした。", [withOld]), []);
});
