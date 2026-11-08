import test from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { runChat } from "../lib/chat";
import { exampleMoneyTurns, exampleWorkspace } from "../lib/example";
import { neutralizeToolInput } from "../lib/money/free-text";
import { moneyToText } from "../lib/money/format";
import {
  checkReply,
  maskUnverified,
  softenClaims,
  softenTitle,
  SOFTENED_MEDICAL,
  SOFTENED_MEDICAL_TITLE,
} from "../lib/money/guard";
import { executeTool } from "../lib/money/tools";
import { exportMemo, parseStoredWorkspace, type ChatRequest } from "../lib/workspace";

// #76 の残り: モデルが書く自由文（道具の入力の名前）と、断定・医療の指示・日付の書き方の取りこぼし。数字と会話はすべて架空。

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const toolStep = (name: string, input: unknown) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `call-${name}`,
      toolName: name,
      input: JSON.stringify(input),
    },
  ],
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
const QUOTE = "来月2週間入院する。";
const INPUT: ChatRequest = {
  messages: [{ id: "u1", role: "user", text: `${QUOTE}協会けんぽ。` }],
  cards: [],
};
const card = {
  id: "m1",
  kind: "money",
  title: "手元に要る額",
  body: "説明です。",
  nextStep: "病院に聞く。",
  uncertainty: "",
  evidence: [{ messageId: "u1", quote: QUOTE }],
};
const CLAIM_NAME = "給付は必ず受けられます。病院に連絡しました。";
const event = (label: string) => ({
  date: "2026-11-30",
  label,
  direction: "out",
  amount_low: 90_940,
  amount_high: 92_940,
  certainty: "estimate",
});
const cashflow = (name: string, label = "入院費") => ({
  start_date: "2026-11-06",
  cash_on_hand: null,
  scenarios: [
    { name, events: [event(label)] },
    { name: "上限が使えない", events: [event("入院費（上限なし）")] },
  ],
});

// ---- 1: 計算表の名前 ----

test("1: 筋書きの名前に給付の断定と代行の完了があれば、計算表と持ち出しの文章に出す前に中立の名前にする", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolStep("simulate_cashflow", cashflow(CLAIM_NAME, "病院に連絡しました")),
      replyStep("見通しを出しました。", [card]),
    ],
  });
  const result = await runChat({ model, input: INPUT });
  const money = result.cards[0].money;
  assert.ok(money);
  const text = moneyToText(money, "");
  for (const shown of [JSON.stringify(money.calculations), text]) {
    assert.ok(!shown.includes("必ず受けられます"), shown.slice(0, 200));
    assert.ok(!shown.includes("連絡しました"), shown.slice(0, 200));
  }
  assert.ok(text.includes("筋書き 1"), text);
  // 正常な名前は変えない。入出金の label は持ち出しの文章に出ないので、計算の記録で確かめる。
  assert.ok(text.includes("上限が使えない"), text);
  const saved = JSON.stringify(money.calculations);
  assert.ok(saved.includes("入院費（上限なし）"), saved);
  assert.ok(saved.includes("項目 1"), saved);
});

test("1: 段取り（calc_date）の label の断定も中立の名前にする", async () => {
  const input = {
    start_date: "2026-11-16",
    steps: [
      { label: "診断書の完成", unit: "day", count: 7 },
      { label: "申請は完了済みです", unit: "business_day", count: 3 },
    ],
    until_date: null,
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolStep("calc_date", input),
      replyStep("日付を出しました。", [card]),
    ],
  });
  const result = await runChat({ model, input: INPUT });
  const text = moneyToText(result.cards[0].money!, "");
  assert.ok(!text.includes("完了済み"), text);
  assert.ok(text.includes("項目 2"), text);
  assert.ok(text.includes("診断書の完成"), text);
});

test("1: 前の回のカードに保存された入力の名前も、計算し直すときに中立の名前にする", async () => {
  // 前の回の計算は、今回の計算があるときに同じカードへまとめて付く。
  const dateInput = { start_date: "2026-11-16", steps: [], until_date: "2026-11-30" };
  const model = new MockLanguageModelV4({ doGenerate: [toolStep("calc_date", dateInput), replyStep("続きです。", [card])] });
  const result = await runChat({
    model,
    input: {
      ...INPUT,
      cards: [
        {
          ...card,
          flags: { edited: false, done: false, included: false },
          money: { calculations: [{ name: "simulate_cashflow", input: cashflow(CLAIM_NAME) }] },
        } as unknown as ChatRequest["cards"][number],
      ],
    },
  });
  const money = result.cards.find((item) => item.id === "m1")?.money;
  assert.ok(money, JSON.stringify(result.cards));
  const saved = JSON.stringify(money.calculations);
  assert.ok(!saved.includes("必ず受けられます"), saved.slice(0, 300));
  assert.ok(saved.includes("筋書き 1"), saved.slice(0, 300));
  // 置き換えの無い入力は、同じものをそのまま返す。
  const plain = cashflow("窓口で上限が使える");
  assert.equal(neutralizeToolInput(plain), plain);
});

// ---- 2: 給付の断定・代行の完了・医療の指示の言い換え ----

const SOFTEN: [text: string, replaced: 0 | 1][] = [
  ["給付金を受け取れます。", 1],
  ["給付金は受給できます。", 1],
  ["申請は完了済みです。", 1],
  ["連絡が済んでいます。", 1],
  ["治療を中止してください。", 1],
  ["薬をやめましょう。", 1],
  ["手術を延期したほうがいいです。", 1],
  // 確認を勧める文と問いは残す（ADR 0018: 判別できないときは置き換えない）。
  ["受け取れるかは窓口で確かめましょう。", 0],
  ["給付金を受け取れますか。", 0],
  ["給付金を受け取れるかは、加入先に確かめてください。", 0],
  ["申請が済んだら教えてください。", 0],
  ["申請が完了しているか、窓口で確かめましょう。", 0],
  ["治療を中止するかは主治医と相談してください。", 0],
  ["薬をやめてよいかは主治医に確かめてください。", 0],
  ["主治医に「治療を中止してください」と言われたら、窓口にも伝えましょう。", 0],
];

test("2: 給付の断定・代行の完了・医療の指示の言い換えを置き換え、確認を勧める文は残す", () => {
  for (const [text, replaced] of SOFTEN)
    assert.equal(
      Math.min(
        softenClaims(text, { voice: "reply", userTexts: ["来月入院します。"] })
          .replaced,
        1,
      ),
      replaced,
      text,
    );
});

test("2: 医療の指示は医療の案内に置き換え、見出しも医療の短い文にする", () => {
  assert.equal(
    softenClaims("治療を中止してください。", { voice: "reply" }).text,
    SOFTENED_MEDICAL,
  );
  assert.equal(softenTitle("治療を中止してください"), SOFTENED_MEDICAL_TITLE);
  // 本人がした報告は、カードでは今までどおり残す。
  assert.equal(
    softenClaims("申請は完了済みです。", {
      voice: "card",
      userTexts: ["申請は完了済みです。"],
    }).replaced,
    0,
  );
});

// ---- 3: 日付の書き方 ----

const args = {
  toolEvents: [],
  userTexts: ["来月入院します。"],
  today: "2026-11-08",
};
const DATES: [text: string, flagged: 0 | 1][] = [
  ["支払日は21日です。", 1],
  ["支払期限は2026.12.20です。", 1],
  ["給付予定日は二〇二六年十二月二十日です。", 1],
  ["給付予定日は令和八年十二月二十日です。", 1],
  ["支払日は十二月二十日です。", 1],
  // 期間と、区別できない日だけの表記は照らさない。
  ["15日間入院します。", 0],
  ["21日まで入院します。", 0],
  ["入院日数は21日です。", 0],
  ["その日は1日中休みです。", 0],
  ["小数の 2026.125 は日付にしない。", 0],
  // 照らせる日付（今日）は通す。
  ["今日は8日です。", 0],
  ["今日は二〇二六年十一月八日です。", 0],
  ["今日は2026.11.8です。", 0],
];

test("3: ドット区切り・漢数字・日だけの日付も照らし、期間は照らさない", () => {
  for (const [text, flagged] of DATES)
    assert.equal(
      Math.min(checkReply({ ...args, reply: text }).length, 1),
      flagged,
      text,
    );
  assert.equal(
    maskUnverified({ ...args, reply: "支払日は21日です。" }).text.split(
      "\n",
    )[0],
    "支払日は（照合できない日付）です。",
  );
  // 利用者が言った日は照らせる。
  assert.equal(
    checkReply({
      ...args,
      userTexts: ["支払日は21日です。"],
      reply: "支払日は21日です。",
    }).length,
    0,
  );
  assert.equal(
    checkReply({
      ...args,
      userTexts: ["12月21日に払います。"],
      reply: "支払日は21日です。",
    }).length,
    0,
  );
});

test("3: デモの 3 発言の通常の返答（12 月 14 日・28 日・1 月 4 日など）では注意も置き換えも出ない", () => {
  const { first, second } = exampleMoneyTurns();
  const example = exampleWorkspace();
  const userTexts = example.messages.filter((item) => item.role === "user").map((item) => item.text);
  const prose = [
    ...example.messages.filter((item) => item.role === "assistant").map((item) => item.text),
    ...example.cards.flatMap((item) => [item.title, item.body, item.nextStep, item.uncertainty]),
  ];
  const toolEvents = [...first.calculations, ...second.calculations];
  for (const text of prose) {
    assert.deepEqual(checkReply({ toolEvents, userTexts, today: "2026-11-30", reply: text }), [], text.slice(0, 40));
    assert.equal(softenClaims(text, { voice: "reply", userTexts }).replaced, 0, text.slice(0, 40));
  }
});

// ===== PR #96 への Codex のレビュー（中 4 件） =====

test("Codex 1: 主治医への確認を勧める問いの形（〜か、〜かどうか、〜かは）は残す", () => {
  for (const text of [
    "薬をやめてもいいか、主治医に確かめてください。",
    "薬をやめてもいいかどうか、主治医に聞きましょう。",
    "治療を中止すべきかは主治医と相談してください。",
    "薬をやめるべきか、主治医に聞いてください。",
    "手術を延期しても大丈夫か病院に確かめましょう。",
  ])
    assert.equal(softenClaims(text, { voice: "reply" }).replaced, 0, text);
});

test("Codex 2: 「べき」の形の医療の指示も置き換える", () => {
  for (const text of ["治療を中止すべきです。", "薬をやめるべきです。", "通院を控えるべきです。", "薬をやめてもいいです。"])
    assert.equal(softenClaims(text, { voice: "reply" }).text, SOFTENED_MEDICAL, text);
});

test("Codex 3: 日数（15日あります・15日ぶり・15日間）は、日付の根拠にも照らす対象にもしない", () => {
  const base = { toolEvents: [], today: "2026-11-08" };
  // 見逃し: 利用者の言った日数を、支払日の根拠にしない。
  assert.equal(checkReply({ ...base, userTexts: ["今月の休日は15日あります。"], reply: "支払日は15日です。" }).length, 1);
  // 誤検出: 日数は伏せない。
  for (const text of ["その日は15日ぶりに家族と会えます。", "休日は15日あります。", "その日は15日間の入院の初日です。", "今日は8日です。"]) {
    assert.equal(checkReply({ ...base, userTexts: ["来月入院します。"], reply: text }).length, 0, text);
    assert.equal(maskUnverified({ ...base, userTexts: ["来月入院します。"], reply: text }).masked, 0, text);
  }
  // 日付を言う語のすぐあとの日は、今までどおり照らす。
  assert.equal(checkReply({ ...base, userTexts: ["12月15日に払います。"], reply: "支払日は15日です。" }).length, 0);
  assert.equal(checkReply({ ...base, userTexts: [], reply: "入金予定日は21日です。" }).length, 1);
});

// 旧版で保存したカード: 筋書きの名前に断定があり、結果にもその名前が写っている。
function storedWithClaim() {
  const workspace = exampleWorkspace();
  const cards = workspace.cards.map((card) => {
    if (!card.money) return card;
    const calculations = card.money.calculations.map((calculation) => {
      if (calculation.name !== "simulate_cashflow") return calculation;
      const input = structuredClone(calculation.input) as { scenarios: { name: string }[] };
      input.scenarios[0].name = CLAIM_NAME;
      const result = executeTool("simulate_cashflow", input);
      assert.equal(result.ok, true);
      return { ...calculation, input, output: (result as { output: unknown }).output };
    });
    return { ...card, included: true, money: { ...card.money, calculations } };
  });
  return { ...workspace, cards } as typeof workspace;
}

test("Codex 4: 保存済みのカードの名前は、読み込むときと持ち出すときにも中立の名前にする", () => {
  const stored = storedWithClaim();
  assert.ok(JSON.stringify(stored).includes("必ず受けられます"));
  // 持ち出し（読み込み直さずに、そのまま持ち出す）。
  const direct = exportMemo(stored.cards, stored.messages);
  assert.ok(!direct.includes("必ず受けられます"), direct);
  assert.ok(!direct.includes("連絡しました"), direct);
  assert.ok(direct.includes("筋書き 1"), direct);
  // 読み込み。
  const loaded = parseStoredWorkspace(JSON.stringify(stored));
  const saved = JSON.stringify(loaded.cards.map((card) => card.money ?? null));
  assert.ok(!saved.includes("必ず受けられます"), saved.slice(0, 300));
  assert.ok(saved.includes("筋書き 1"));
  // 断定の無い保存データは、読み込んでも変わらない。
  const plain = exampleWorkspace();
  assert.deepEqual(
    parseStoredWorkspace(JSON.stringify(plain)).cards.map((card) => card.money),
    plain.cards.map((card) => card.money),
  );
  assert.equal(exportMemo(plain.cards.map((card) => ({ ...card, included: true })), plain.messages).includes("筋書き 1"), false);
});
