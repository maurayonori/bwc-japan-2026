// 架空の体験例（支払日に間に合う準備のストーリー、#55）と、支払日に要るお金の欄、文書の数字の照合。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EXAMPLE_ANSWER,
  EXAMPLE_FIRST,
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
import { yen } from "../lib/money/format";
import { checkReply } from "../lib/money/guard";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import { mealCost } from "../lib/money/meals";
import type { Calculation } from "../lib/money/schema";
import { PAYDAY_FACTS, paydayOf, questionCard, resultLinks } from "../lib/views";
import { validateEvidence, workspaceSchema, type Card } from "../lib/workspace";
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
  assert.ok(script.includes(EXAMPLE_ANSWER), "台本の 2 つ目の発言");
});

test("支払日に要るお金: 病院に聞く前は、上限を使う場合と使わない場合を並べ、差と手元との差を計算の出力から出す", () => {
  const payday = paydayOf(moneyOf(exampleWorkspace().cards).money);
  assert.ok(payday?.cap && payday.nocap);
  assert.deepEqual(payday.cap.need, { low: 115_690, high: 115_690 });
  assert.deepEqual(payday.nocap.need, { low: 264_750, high: 264_750 });
  assert.equal(payday.cap.needDate, "2026-12-28");
  assert.deepEqual(payday.cap.cash?.low, { kind: "remain", amount: 84_310 });
  assert.deepEqual(payday.nocap.cash?.high, { kind: "short", amount: 64_750 });
  assert.deepEqual(payday.needDifference, { low: 149_060, high: 149_060 });
  assert.deepEqual(payday.kougaku?.refundLater, { low: 149_060, high: 149_060 });
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
  assert.equal(payday.needDifference, null);
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
  assert.deepEqual(payday.needDifference, { low: 149_060, high: 207_060 });
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

// デモの 3 つ目の発言（入院が 1 週間延び、退院が 1/4 になる）。病院の答えのあとなので、窓口で上限を使う。
// 月ごとの費用の内訳は分からないので、費用が 12 月に寄る場合と、半々に分かれる場合を並べる（lib/prompt.ts の指示）。
function extendedNumbers() {
  const capOf = (month: string, total: number) => {
    if (total === 0) return 0;
    const out = kougakuGendo({
      treatment_month: month,
      income_category: "ウ",
      amount_basis: "total",
      amount_low: total,
      amount_high: total,
      copay_percent: 30,
    });
    return out.cases[0].low.pay_with_cap;
  };
  const stay = calcDate({ start_date: "2026-12-14", steps: [], until_date: "2027-01-04" });
  const days = stay.until?.days_inclusive ?? 0;
  const meals = mealCost({ days_low: days, days_high: days }).low.cost_max;
  const event = (date: string, label: string, amount: number, certainty: string) => ({
    date,
    label,
    direction: "out",
    amount_low: amount,
    amount_high: amount,
    certainty,
  });
  const scenario = (name: string, dec: number, jan: number) => ({
    name,
    events: [
      event("2027-01-04", "入院費（12 月分）", capOf("2026-12", dec), "assumption"),
      ...(jan > 0 ? [event("2027-01-04", "入院費（1 月分）", capOf("2027-01", jan), "assumption")] : []),
      event("2027-01-04", "入院中の食事代", meals, "assumption"),
    ],
  });
  const output = simulateCashflow({
    start_date: EXAMPLE_TODAY,
    cash_on_hand: 200_000,
    scenarios: [scenario("費用が 12 月に寄る場合", 800_000, 0), scenario("費用が半々に分かれる場合", 400_000, 400_000)],
  });
  const [lean, half] = output.scenarios;
  return {
    days,
    meals,
    leanNeed: lean.low_case.need,
    leanRemain: lean.low_case.end_balance,
    halfNeed: half.low_case.need,
    halfShort: half.low_case.shortfall,
    width: output.what_to_confirm?.width,
  };
}

test("デモの 3 つ目の発言の数字（入院が 1 週間延びる）も、計算関数から出る", () => {
  assert.deepEqual(extendedNumbers(), {
    days: 22,
    meals: 36_300,
    leanNeed: 127_240,
    leanRemain: 72_760,
    halfNeed: 210_180,
    halfShort: 10_180,
    width: 82_940,
  });
});

test("README・仕様・提出文・台本の架空の例の金額は、アプリの計算の出力と一致する", () => {
  const n = exampleNumbers();
  const scale = 100 * n.difference; // 社会の規模の試算（100 件）。規模感で、達成予測ではない
  assert.equal(scale, 14_906_000);
  const amounts = [
    n.needWithCap,
    n.needWithoutCap,
    n.difference,
    n.remainWithCap,
    n.shortWithoutCap,
  ].map(yen);
  const files = {
    "README.md": [...amounts, yen(n.cash), yen(scale)],
    "docs/family-preparation.md": amounts,
    "docs/submission/form.md": [...amounts, yen(scale)],
    "docs/submission/demo-script.md": [
      ...amounts,
      yen(n.meals),
      yen(n.copayWithoutCap),
      yen(n.payWithCap),
      ...(() => {
        const e = extendedNumbers();
        return [e.leanNeed, e.halfNeed, e.leanRemain, e.halfShort, e.width ?? -1].map(yen);
      })(),
    ],
  };
  for (const [file, expected] of Object.entries(files)) {
    const text = readFileSync(file, "utf8");
    for (const amount of expected) assert.ok(text.includes(amount), `${file}: ${amount}`);
    // 規模の試算を書くなら、達成予測ではないと書く
    if (text.includes(yen(scale)))
      assert.match(text, /達成予測ではない|達成予測ではありません/, file);
  }
});
