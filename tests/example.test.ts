// 架空の体験例（支払日に間に合う準備のストーリー、#55）と、支払日に要るお金の欄、文書の数字の照合。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EXAMPLE_ANSWER,
  EXAMPLE_FIRST,
  EXAMPLE_SITUATION,
  EXAMPLE_TODAY,
  answerExample,
  exampleAfterCalculations,
  exampleAnswered,
  exampleAnsweredWorkspace,
  exampleBeforeCalculations,
  exampleNumbers,
  exampleWorkspace,
} from "../lib/example";
import { calcDate } from "../lib/money/business-days";
import { FACTS } from "../lib/money/facts";
import { CERTAINTY_TEXT, yen } from "../lib/money/format";
import { KOUGAKU_UNDER_70 } from "../lib/money/rules";
import { checkReply } from "../lib/money/guard";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import { mealCost } from "../lib/money/meals";
import type { Calculation } from "../lib/money/schema";
import { PAYDAY_FACTS, paydayDifference, paydayOf, questionCard, resultLinks } from "../lib/views";
import { validateEvidence, workspaceSchema, type Card } from "../lib/workspace";
import {
  KYOKAI_FY2025,
  REFUND_TIMING_SOURCE,
  SCALE_CASES,
  STORY_CHECKED_ON,
  SURVEYS,
  aboutManText,
  casesText,
  okuText,
  refundPerCaseText,
} from "../lib/story";
import { rangeExampleWorkspace } from "./fixtures/range-example";

const moneyOf = (cards: readonly Card[]): Card => {
  const card = cards.findLast((item) => item.kind === "money");
  assert.ok(card);
  return card;
};

test("架空の例の数字は、制度表と計算関数から出る（区分ウ・総額 80 万円・15 日・手元 20 万円）", () => {
  const kougaku = kougakuGendo({
    treatment_month: "2026-12",
    income_category: "ウ",
    amount_basis: "total",
    amount_low: 800_000,
    amount_high: 800_000,
    copay_percent: 30,
  });
  const [item] = kougaku.cases;
  // 85,800 円＋（800,000 − 286,000）× 1%
  assert.equal(item.low.cap, 90_940);
  assert.equal(item.low.copay_without_cap, 240_000);
  assert.equal(item.low.refund_later, 149_060);
  const stay = calcDate({
    start_date: "2026-12-14",
    steps: [],
    until_date: "2026-12-28",
  });
  assert.equal(stay.until?.days_inclusive, 15);
  assert.equal(mealCost({ days_low: 15, days_high: 15 }).low.cost_max, 24_750);

  const n = exampleNumbers();
  assert.deepEqual(n, {
    cash: 200_000,
    total: 800_000,
    cap: 90_940,
    payWithCap: 90_940,
    copayWithoutCap: 240_000,
    refundLater: 149_060,
    meals: 24_750,
    mealDays: 15,
    needWithCap: 115_690,
    needWithoutCap: 264_750,
    remainWithCap: 84_310,
    shortWithoutCap: 64_750,
    difference: 149_060,
    widthBefore: 149_060,
    widthIfResolved: 0,
    widthAfter: 0,
    needAfter: 115_690,
    remainAfter: 84_310,
  });
  // 体験例のカードの計算は、入力を同じ関数に通し直した結果と同じ
  for (const calculation of [
    ...exampleBeforeCalculations(),
    ...exampleAfterCalculations(),
  ])
    if (calculation.name === "simulate_cashflow")
      assert.deepEqual(
        calculation.output,
        simulateCashflow(calculation.input as never),
      );
});

test("病院に聞く前の「まず確かめる 1 つ」は、窓口で上限を使えるか（筋書き）で、確かめると幅が 0 になる", () => {
  const card = moneyOf(exampleWorkspace().cards);
  const cashflow = card.money?.calculations.findLast(
    (item) => item.name === "simulate_cashflow",
  );
  assert.ok(cashflow?.name === "simulate_cashflow");
  const confirm = cashflow.output.what_to_confirm;
  assert.ok(confirm);
  assert.equal(confirm.factors.length, 1);
  assert.equal(confirm.factors[0].kind, "scenario");
  assert.equal(confirm.factors[0].shrink, 149_060);
  assert.equal(confirm.shortfall_low, 0);
  assert.equal(confirm.shortfall_high, 64_750);
  assert.equal(questionCard(exampleWorkspace().messages, exampleWorkspace().cards)?.id, "hospital-desk");
});

test("体験例の文章の金額と日付は、その返答の計算結果と発言に見当たる（2 つの返答とも）", () => {
  const before = workspaceSchema.parse(exampleWorkspace());
  const after = workspaceSchema.parse(exampleAnsweredWorkspace());
  const userTexts = after.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text);
  const proseOf = (texts: string[], cards: readonly Card[]) =>
    [
      ...texts,
      ...cards.flatMap((card) => [
        card.title,
        card.body,
        card.nextStep,
        card.uncertainty,
      ]),
    ].join("\n");
  const firstReply = before.messages.find((m) => m.id === "example-reply");
  const secondReply = after.messages.find((m) => m.id === "example-reply-2");
  assert.ok(firstReply && secondReply);
  assert.deepEqual(
    checkReply({
      reply: proseOf([firstReply.text], before.cards),
      toolEvents: exampleBeforeCalculations(),
      userTexts: userTexts.slice(0, 1),
      today: EXAMPLE_TODAY,
    }),
    [],
  );
  assert.deepEqual(
    checkReply({
      reply: proseOf([secondReply.text], [moneyOf(after.cards)]),
      toolEvents: exampleAfterCalculations(),
      userTexts,
      today: EXAMPLE_TODAY,
    }),
    [],
  );
  for (const text of ["115,690 円", "264,750 円", "84,310 円", "64,750 円", "149,060 円", "12/28（月）"])
    assert.ok(firstReply.text.includes(text), text);
  for (const text of ["115,690 円", "84,310 円", "149,060 円から 0 円に縮みました", "12/14（月）"])
    assert.ok(secondReply.text.includes(text), text);
});

test("体験例の根拠の引用は、発言と完全一致する。発言はデモの台本と同じ", () => {
  const after = exampleAnsweredWorkspace();
  assert.doesNotThrow(() =>
    validateEvidence({ reply: "検査", cards: after.cards }, after.messages),
  );
  assert.equal(after.messages[0].text, EXAMPLE_FIRST);
  assert.equal(after.messages[2].text, EXAMPLE_ANSWER);
  const script = readFileSync("docs/submission/demo-script.md", "utf8");
  assert.ok(script.includes(EXAMPLE_SITUATION), "台本の 1 つ目の発言");
  assert.ok(script.includes(EXAMPLE_ANSWER), "台本の 2 つ目の発言");
  assert.ok(script.includes("入院が1週間延びて、退院は1月4日になりました。"), "台本の 3 つ目の発言");
});

test("支払日に要るお金: 病院に聞く前は、上限を使う場合と使わない場合を並べ、差と手元との差を計算の出力から出す", () => {
  const payday = paydayOf(moneyOf(exampleWorkspace().cards).money);
  assert.ok(payday?.cap && payday.nocap);
  assert.deepEqual(payday.cap.need, { low: 115_690, high: 115_690 });
  assert.deepEqual(payday.nocap.need, { low: 264_750, high: 264_750 });
  assert.equal(payday.cap.needDate, "2026-12-28");
  assert.deepEqual(payday.cap.cash?.low, { kind: "remain", amount: 84_310 });
  assert.deepEqual(payday.nocap.cash?.high, { kind: "short", amount: 64_750 });
  assert.deepEqual(payday.capSaves, { low: 149_060, high: 149_060 });
  assert.equal(payday.sameOtherRows, true);
  assert.deepEqual(payday.kougaku.refundLater, { low: 149_060, high: 149_060 });
  assert.deepEqual(paydayDifference(payday), { kind: "avoidable", amount: { low: 149_060, high: 149_060 } });
  // 確かめた額・見積もり・仮定の区別を残す
  assert.deepEqual(
    payday.cap.rows.map((row) => [row.label, row.amount.low, row.certainty]),
    [
      ["入院費（保険診療分）", 90_940, "estimate"],
      ["入院中の食事代", 24_750, "assumption"],
    ],
  );
});

test("支払日に要るお金: 病院の答えのあとは上限を使う場合だけになり、立て替えずに済む額は高額療養費の計算から出す", () => {
  const after = exampleAnsweredWorkspace();
  assert.ok(exampleAnswered(after));
  const payday = paydayOf(moneyOf(after.cards).money);
  assert.ok(payday?.cap);
  assert.equal(payday.nocap, null);
  assert.equal(payday.capSaves, null);
  assert.deepEqual(paydayDifference(payday), { kind: "refund", amount: { low: 149_060, high: 149_060 } });
  assert.deepEqual(payday.cap.need, { low: 115_690, high: 115_690 });
  assert.deepEqual(payday.cap.cash?.high, { kind: "remain", amount: 84_310 });
  assert.deepEqual(payday.kougaku?.copayWithoutCap, { low: 240_000, high: 240_000 });
  assert.deepEqual(payday.kougaku?.refundLater, { low: 149_060, high: 149_060 });
  // 確かめることが残っていないので、返答の下のリンクに「まず確かめる 1 つ」と書かない
  const reply = after.messages.at(-1);
  assert.ok(reply);
  assert.deepEqual(resultLinks(reply, after.cards, true), [
    { view: "outlook", label: "要る額 115,690 円の見通しを見る" },
  ]);
});

test("支払日に要るお金: 幅のある見積もりでも、行の額が少なめと多めの両方で一致する筋書きだけを見分ける", () => {
  const card = moneyOf(rangeExampleWorkspace().cards);
  const payday = paydayOf(card.money);
  assert.ok(payday?.cap && payday.nocap);
  assert.equal(payday.cap.scenario, "窓口で上限が適用される場合");
  assert.equal(payday.nocap.scenario, "いったん 3 割を払う場合");
  assert.deepEqual(payday.cap.need, { low: 115_690, high: 117_690 });
  assert.deepEqual(payday.nocap.need, { low: 264_750, high: 324_750 });
  assert.deepEqual(payday.capSaves, { low: 149_060, high: 207_060 });
  assert.equal(paydayDifference(payday)?.kind, "avoidable");
  assert.deepEqual(payday.kougaku?.refundLater, { low: 149_060, high: 207_060 });
  // 手元のお金を聞いていないときは、足りる・足りないを出さない
  assert.equal(payday.cashOnHand, null);
  assert.equal(payday.cap.cash, null);
});

test("支払日に要るお金: 見分けられないときは出さない（区分が不明・同じ側の筋書きが 2 本・高額療養費の計算が無い）", () => {
  const cashflow = (scenarios: { name: string; amount: number }[]) => {
    const input = {
      start_date: "2026-11-24",
      cash_on_hand: 200_000,
      scenarios: scenarios.map(({ name, amount }) => ({
        name,
        events: [
          {
            date: "2026-12-28",
            label: "入院費",
            direction: "out",
            amount_low: amount,
            amount_high: amount,
            certainty: "estimate",
          },
        ],
      })),
    };
    return { name: "simulate_cashflow", input, output: simulateCashflow(input) } as Calculation;
  };
  const kougaku = (category: string, total: number): Calculation => {
    const input = {
      treatment_month: "2026-12",
      income_category: category,
      amount_basis: "total",
      amount_low: total,
      amount_high: total,
      copay_percent: 30,
    };
    return { name: "kougaku_gendo", input, output: kougakuGendo(input) } as Calculation;
  };
  const both = cashflow([
    { name: "使う", amount: 90_940 },
    { name: "使わない", amount: 240_000 },
  ]);
  assert.ok(paydayOf({ calculations: [kougaku("ウ", 800_000), both] }));
  assert.equal(paydayOf({ calculations: [both] }), null);
  assert.equal(paydayOf({ calculations: [kougaku("不明", 800_000), both] }), null);
  // 月をまたぐときの内訳の違いなど、上限を使う筋書きが 2 本あるときは、どちらを出すか決めない
  const twoCaps = cashflow([
    { name: "12 月に寄る", amount: 90_940 },
    { name: "半々", amount: 90_940 },
  ]);
  assert.equal(paydayOf({ calculations: [kougaku("ウ", 800_000), twoCaps] }), null);
  // 上限で窓口負担が減らない額（総額 20 万円の 3 割は 60,000 円）は、比べるものが無いので出さない
  const small = cashflow([{ name: "試算", amount: 60_000 }]);
  assert.equal(paydayOf({ calculations: [kougaku("ウ", 200_000), small] }), null);
  assert.equal(paydayOf(undefined), null);
});

test("自分で直したカードは、見本の続きでも上書きしない。守られたお金のカードは別の番号で足す", () => {
  const edited = exampleWorkspace();
  edited.cards = edited.cards.map((card) =>
    card.id === "hospital-desk"
      ? { ...card, body: "自分で直した質問文（架空）", edited: true }
      : card.kind === "money"
        ? { ...card, included: true }
        : card,
  );
  const after = answerExample(edited);
  assert.equal(after.cards.find((card) => card.id === "hospital-desk")?.body, "自分で直した質問文（架空）");
  const old = after.cards.find((card) => card.id === "hospital-money");
  assert.ok(paydayOf(old?.money)?.nocap, "前の見通しは残る");
  const fresh = after.cards.find((card) => card.id === "hospital-money-2");
  assert.ok(fresh && paydayOf(fresh.money)?.nocap === null);
  assert.deepEqual(after.messages.at(-1)?.cardIds, ["hospital-money-2"]);
  // 2 回押しても重ねない
  assert.equal(answerExample(after), after);
});

test("支払日の欄に添える事実の文は、持っている事実（出典つき）の本文に沿う", () => {
  for (const { id, text } of PAYDAY_FACTS) {
    const fact = FACTS.find((item) => item.id === id);
    assert.ok(fact, id);
    assert.ok(fact.sources[0].url.startsWith("https://www.kyoukaikenpo.or.jp/") || fact.sources[0].url.startsWith("https://"), id);
    assert.match(fact.checked_on, /^2026-/);
    assert.ok(text.length > 0);
  }
  const f05 = FACTS.find((item) => item.id === "F05");
  assert.ok(f05?.text.includes("診療月から 3 か月以上"));
  assert.equal(f05?.sources[0].url, "https://www.kyoukaikenpo.or.jp/faq/benefit/004/index.html");
  const f02 = FACTS.find((item) => item.id === "F02");
  for (const word of ["マイナ保険証", "限度額適用認定証", "差額ベッド代", "食事代"])
    assert.ok(f02?.text.includes(word), word);
});

// ---- 文書の数字を、計算の出力と照合する ----

// デモの 3 つ目の発言（入院が 1 週間延び、退院が 1/4 になった）。病院の答えのあとなので、窓口で上限を使う。
// 月ごとの費用の内訳は分からないので、費用が 12 月に寄る場合と、半々に分かれる場合を並べる（lib/prompt.ts の指示）。
function extendedNumbers() {
  const capOf = (month: string, total: number) =>
    kougakuGendo({
      treatment_month: month,
      income_category: "ウ",
      amount_basis: "total",
      amount_low: total,
      amount_high: total,
      copay_percent: 30,
    }).cases[0].low.pay_with_cap;
  const discharge = "2027-01-04";
  const stay = calcDate({ start_date: "2026-12-14", steps: [], until_date: discharge });
  const days = stay.until?.days_inclusive ?? 0;
  const meals = mealCost({ days_low: days, days_high: days }).low.cost_max;
  const event = (label: string, amount: number) => ({
    date: discharge,
    label,
    direction: "out",
    amount_low: amount,
    amount_high: amount,
    certainty: "assumption",
  });
  const leanCap = capOf("2026-12", 800_000);
  const halfCap = capOf("2026-12", 400_000);
  assert.equal(capOf("2027-01", 400_000), halfCap);
  const output = simulateCashflow({
    start_date: EXAMPLE_TODAY,
    cash_on_hand: 200_000,
    scenarios: [
      { name: "費用が 12 月に寄る場合", events: [event("入院費（12 月分）", leanCap), event("入院中の食事代", meals)] },
      {
        name: "費用が半々に分かれる場合",
        events: [event("入院費（12 月分）", halfCap), event("入院費（1 月分）", halfCap), event("入院中の食事代", meals)],
      },
    ],
  });
  const [lean, half] = output.scenarios;
  return {
    discharge,
    days,
    meals,
    leanCap,
    halfCap,
    leanNeed: lean.low_case.need,
    leanRemain: lean.low_case.end_balance ?? -1,
    halfNeed: half.low_case.need,
    halfShort: half.low_case.shortfall ?? -1,
    width: output.what_to_confirm?.width ?? -1,
  };
}

test("デモの 3 つ目の発言の数字（入院が 1 週間延びた）も、計算関数から出る", () => {
  const { discharge: _discharge, ...numbers } = extendedNumbers();
  assert.deepEqual(numbers, {
    days: 22,
    meals: 36_300,
    leanCap: 90_940,
    halfCap: 86_940,
    leanNeed: 127_240,
    leanRemain: 72_760,
    halfNeed: 210_180,
    halfShort: 10_180,
    width: 82_940,
  });
});

const read = (file: string) => readFileSync(file, "utf8");
// 「12/28」の形（年と曜日を付けない）。
const monthDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

// 文書の表の行（区切りの行は除く）。
function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("|") && !/^\|[\s|:-]+\|$/.test(line.trim()))
    .map(cells);
}

function assertRows(file: string, text: string, expected: string[][]) {
  const rows = tableRows(text);
  for (const row of expected) {
    const found = rows.find((candidate) => candidate[0] === row[0] && candidate.length === row.length);
    assert.ok(found, `${file}: 「${row[0]}」の行が無い`);
    assert.deepEqual(found, row, `${file}: 「${row[0]}」の行`);
  }
}

// 基本の例の表（README と仕様）。行の名前・額・確かさ・支払日は、支払日の欄（paydayOf）の出力から作る。
function basicTable(): string[][] {
  const payday = paydayOf(moneyOf(exampleWorkspace().cards).money);
  assert.ok(payday?.cap && payday.nocap);
  const { cap, nocap, cashOnHand } = payday;
  const needDate = cap.needDate;
  assert.ok(needDate);
  assert.ok(cashOnHand !== null && cap.cash && nocap.cash);
  const cell = (row: (typeof cap.rows)[number]) =>
    `${yen(row.amount.low)}（${CERTAINTY_TEXT[row.certainty]}）`;
  const cash = (result: NonNullable<typeof cap.cash>["low"]) =>
    `${yen(result.amount)}${result.kind === "short" ? "足りない" : "残る"}`;
  return [
    ["", "窓口で上限を使う", "使わずに、あとで還付を受ける"],
    ...cap.rows.map((row, index) => [row.label, cell(row), cell(nocap.rows[index])]),
    [`**支払日（${monthDay(needDate)}）に要るお金**`, `**${yen(cap.need.low)}**`, `**${yen(nocap.need.low)}**`],
    [`手元の ${yen(cashOnHand)}と比べて`, cash(cap.cash.low), cash(nocap.cash.low)],
  ];
}

// 台本の「画面に出る金額」の表。
function scriptTable(): string[][] {
  const n = exampleNumbers();
  const e = extendedNumbers();
  const stay = calcDate({ start_date: "2026-12-14", steps: [], until_date: "2026-12-28" });
  const short = `${monthDay("2026-12-14")}〜${monthDay("2026-12-28")}、${stay.until?.days_inclusive} 日`;
  const long = `${monthDay("2026-12-14")}〜${monthDay(e.discharge)}、${e.days} 日`;
  return [
    ["場面", "筋書き", "入院費（保険診療分）", "食事代", "支払日に要るお金", "手元との差"],
    [`発言 1（${short}）`, "窓口で上限を使う", yen(n.payWithCap), yen(n.meals), yen(n.needWithCap), `${yen(n.remainWithCap)}残る`],
    ["発言 1", "使わずに、あとで還付", yen(n.copayWithoutCap), yen(n.meals), yen(n.needWithoutCap), `${yen(n.shortWithoutCap)}足りない`],
    ["発言 2（病院の答え）", "窓口で上限を使う、だけ残る", yen(n.payWithCap), yen(n.meals), yen(n.needAfter), `${yen(n.remainAfter)}残る`],
    [`発言 3（${long}）`, "上限を使う、費用が 12 月に寄る", yen(e.leanCap), yen(e.meals), yen(e.leanNeed), `${yen(e.leanRemain)}残る`],
    ["発言 3", "上限を使う、費用が半々", `${yen(e.halfCap)} × 2 か月`, yen(e.meals), yen(e.halfNeed), `${yen(e.halfShort)}足りない`],
  ];
}

// 文書の本筋の節で使ってよい金額・件数・割合・日付。計算の出力、話した値、制度表、出典つきの定数（lib/story.ts）から作る。
function allowedTokens() {
  const n = exampleNumbers();
  const e = extendedNumbers();
  const ward = KOUGAKU_UNDER_70.categories.find((category) => category.key === "ウ");
  assert.ok(ward?.threshold);
  const scale = SCALE_CASES * n.difference;
  const { jili2025, tokyo2014 } = SURVEYS;
  const plain = (text: string) => text.replace(/\s+/g, "").replace(/^約/, "");
  const amounts = [
    ...Object.values(n),
    ...Object.values(e).filter((value): value is number => typeof value === "number"),
    n.widthAfter,
    ward.base,
    ward.threshold,
    scale,
    94_490, // 台本: 「〜なったら？」と聞いたときに並ぶ幅の説明（PdM の実 API の確認）
  ];
  return {
    tokens: new Set([
      ...amounts.map((value) => plain(yen(value))),
      // 話した値（80 万円・20 万円・35 万円）
      "80万円",
      "20万円",
      "35万円",
      plain(casesText(KYOKAI_FY2025.refund.cases)),
      plain(casesText(KYOKAI_FY2025.inKind.cases)),
      plain(okuText(KYOKAI_FY2025.refund.yen)),
      plain(okuText(KYOKAI_FY2025.inKind.yen)),
      plain(refundPerCaseText()),
      plain(aboutManText(scale)),
      `${SCALE_CASES}件`,
      "1件", // 「1 件あたり」
      "0件", // 「測っていない（0 件）」
      `${KOUGAKU_UNDER_70.rate_percent}%`,
      `${jili2025.hospitalized}人`,
      `${jili2025.capAtDeskPercent}%`,
      `${jili2025.refundLaterPercent}%`,
      `${jili2025.averageCostMan}万円`,
      `${tokyo2014.respondents}人`,
      `${tokyo2014.topDifficultyPercent}%`,
    ]),
    dates: new Set(["12/14", "12/28", "1/4", "11/7"]),
    isoDates: new Set([STORY_CHECKED_ON, FACTS.find((fact) => fact.id === "F05")?.checked_on]),
  };
}

// 文書の文から、金額・件数・人数・割合と、日付を取り出す（URL は除く）。
function tokensIn(text: string) {
  // リンクの行き先を先に消し、そのあとで地の文の URL を消す（URL は空白・かっこ・読点の手前まで）。
  const body = text
    .replace(/\]\([^)\n]*\)/g, "]")
    .replace(/https?:\/\/[^\s)（）「」、。]+/g, "");
  const amounts = [
    ...body.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(万|億)?\s*(?:(\d+)\s*千)?\s*(円|件|人|%)/g),
  ].map(([, number, unit, thousand, kind]) => `${number}${unit ?? ""}${thousand ? `${thousand}千` : ""}${kind}`);
  const isoDates = [...body.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(([date]) => date);
  const dates = [...body.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "").matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g)].map(
    ([, month, day]) => `${Number(month)}/${Number(day)}`,
  );
  return { amounts, dates, isoDates };
}

// 文書の本筋の節（見出し start から見出し end の手前まで）。
function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `節「${start}」〜「${end}」`);
  return text.slice(from, to);
}

const STORY_SECTIONS: Record<string, [string, string][]> = {
  "README.md": [["# さきよみ", "## 測るもの"]],
  "docs/family-preparation.md": [
    ["## 一文", "## 体験"],
    ["## 測るもの", "## これから確かめること"],
  ],
  "docs/submission/form.md": [
    ["### 一文", "### なぜ自分が取り組むのか"],
    ["### 何を作り、何が変わるか", "### ハッカソンのあと、誰が使い続けるか"],
    ["**プロジェクトの概要（短い版", "**Claude の使い方"],
  ],
  "docs/submission/demo-script.md": [["# デモ動画の台本 v2", "## 撮影の前に確かめること"]],
};

test("基本の例の表は、README と仕様で行と列ごとに計算の出力と一致する", () => {
  for (const file of ["README.md", "docs/family-preparation.md"]) assertRows(file, read(file), basicTable());
});

test("台本の「画面に出る金額」の表は、行と列ごとに計算の出力と一致する（日付・日数・内訳を含む）", () => {
  assertRows("docs/submission/demo-script.md", read("docs/submission/demo-script.md"), scriptTable());
});

test("提出文の架空の例と、規模感の試算の文は、計算の出力から作った文と一致する", () => {
  const n = exampleNumbers();
  const form = read("docs/submission/form.md");
  for (const line of [
    `- 窓口で上限を使えば ${yen(n.needWithCap)}で、手元から ${yen(n.remainWithCap)}残ります。`,
    `- 使わずにあとで還付を受けるなら ${yen(n.needWithoutCap)}で、${yen(n.shortWithoutCap)}足りません。`,
    `- 差の ${yen(n.difference)}が、窓口で上限を使えば避けられる一時立替です。`,
  ])
    assert.ok(form.includes(line), line);
  const scale = `架空の例の差 ${yen(n.difference)}が ${SCALE_CASES} 件なら ${yen(SCALE_CASES * n.difference)}（${aboutManText(SCALE_CASES * n.difference)}）`;
  for (const file of ["README.md", "docs/submission/form.md"]) {
    const text = read(file);
    assert.ok(text.includes(scale), `${file}: ${scale}`);
    assert.match(text, /達成予測ではない|達成予測ではありません/, file);
    assert.ok(text.includes(`1 件あたり${refundPerCaseText()}`), `${file}: 1 件あたり`);
  }
  const script = read("docs/submission/demo-script.md");
  assert.ok(script.includes(`架空の例の差 ${yen(n.difference)}が ${SCALE_CASES} 件なら ${yen(SCALE_CASES * n.difference)}`));
  assert.match(script, /達成予測ではない/);
});

test("協会けんぽの統計は、出典の URL と確認日を添えて、定数と同じ値で書く", () => {
  const refund = `${casesText(KYOKAI_FY2025.refund.cases)}、${okuText(KYOKAI_FY2025.refund.yen)}`;
  const inKind = `${casesText(KYOKAI_FY2025.inKind.cases)}、${okuText(KYOKAI_FY2025.inKind.yen)}`;
  assert.equal(refund, "104 万 2 千件、283 億円");
  assert.equal(inKind, "460 万 5 千件、6,628 億円");
  assert.equal(refundPerCaseText(), "約 2.7 万円");
  for (const file of ["README.md", "docs/submission/form.md"]) {
    const text = read(file);
    assert.ok(text.includes(`（償還払い）は ${refund}`), `${file}: 償還払い`);
    assert.ok(text.includes(`（現物給付）は ${inKind}`), `${file}: 現物給付`);
    assert.ok(text.includes(`${KYOKAI_FY2025.source.url})、${KYOKAI_FY2025.source.checked_on} 確認`), `${file}: 出典と確認日`);
  }
  const spec = read("docs/family-preparation.md");
  assert.ok(spec.includes(`${casesText(KYOKAI_FY2025.refund.cases)}・${okuText(KYOKAI_FY2025.refund.yen)}`));
  assert.ok(spec.includes(`${KYOKAI_FY2025.source.url})、${KYOKAI_FY2025.source.checked_on} 確認`));
  // 台本の規模の場面に、出典の URL と確認日
  const scene = section(read("docs/submission/demo-script.md"), "## 場面 8.", "## 場面 9.");
  assert.ok(scene.includes(`${KYOKAI_FY2025.source.url}（${KYOKAI_FY2025.source.checked_on} 確認）`));
  assert.ok(scene.includes("104万2千件・283億円"));
  // 還付の時期は、出典の文のとおり「払い戻しまで」と起点（診療月）を書く
  for (const file of ["README.md", "docs/submission/form.md", "docs/family-preparation.md"]) {
    const text = read(file);
    assert.ok(text.includes(`「${REFUND_TIMING_SOURCE.quote}」`), `${file}: 還付の時期の引用`);
    assert.ok(text.includes(`${REFUND_TIMING_SOURCE.url})、${REFUND_TIMING_SOURCE.checked_on} 確認`), `${file}: 還付の時期の出典`);
  }
  const all = ["README.md", "docs/submission/form.md", "docs/family-preparation.md", "docs/submission/demo-script.md"].map(read).join("\n");
  assert.doesNotMatch(all, /診療月から 3 か月以上立て替え|戻るのは3か月以上/);
});

test("上限の式の定数は、制度表と同じ値で書く", () => {
  const ward = KOUGAKU_UNDER_70.categories.find((category) => category.key === "ウ");
  assert.ok(ward?.threshold);
  const formula = `${yen(ward.base)}＋（総医療費 − ${yen(ward.threshold)}）× ${KOUGAKU_UNDER_70.rate_percent}%`;
  assert.equal(formula, "85,800 円＋（総医療費 − 286,000 円）× 1%");
  for (const file of ["README.md", "docs/family-preparation.md", "docs/adr/0016-payday-story-cap-at-desk-versus-refund.md"])
    assert.ok(read(file).includes(formula), file);
});

test("文書の本筋の節にある金額・件数・割合・日付は、計算の出力か出典つきの定数にあるものだけ", () => {
  const { tokens, dates, isoDates } = allowedTokens();
  for (const [file, ranges] of Object.entries(STORY_SECTIONS)) {
    const text = read(file);
    for (const [start, end] of ranges) {
      const found = tokensIn(section(text, start, end));
      for (const token of found.amounts) assert.ok(tokens.has(token), `${file}（${start}）: ${token}`);
      for (const date of found.dates) assert.ok(dates.has(date), `${file}（${start}）: ${date}`);
      for (const date of found.isoDates) assert.ok(isoDates.has(date), `${file}（${start}）: ${date}`);
    }
  }
});

test("照合は、表の 1 か所の書き換えや、件数・日付の書き換えを見つける", () => {
  const readme = read("README.md");
  const table = basicTable();
  // 表の 115,690 円だけを変えると、別の段落に正しい額が残っていても落ちる
  const broken = readme.replace("**115,690 円**", "**999,999 円**");
  assert.notEqual(broken, readme);
  assert.throws(() => assertRows("README.md", broken, table));
  const { tokens, dates } = allowedTokens();
  const check = (text: string) => {
    const found = tokensIn(text);
    return found.amounts.every((token) => tokens.has(token)) && found.dates.every((date) => dates.has(date));
  };
  const story = section(readme, "# さきよみ", "## 測るもの");
  assert.equal(check(story), true);
  for (const [from, to] of [
    ["24,750 円（仮定）", "24,751 円（仮定）"],
    ["支払日（12/28）", "支払日（12/29）"],
    ["が 100 件なら", "が 101 件なら"],
    ["104 万 2 千件", "105 万 2 千件"],
  ]) {
    assert.ok(story.includes(from), from);
    assert.equal(check(story.replace(from, to)), false, to);
  }
});
