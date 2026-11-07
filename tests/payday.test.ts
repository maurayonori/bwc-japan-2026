// 支払日に要るお金の欄（lib/views.ts の paydayOf と paydayDifference）。#55 のレビュー（Codex・Cursor）の例を再現する。
// 人物と金額はすべて架空。
import test from "node:test";
import assert from "node:assert/strict";
import { answerExample, exampleWorkspace } from "../lib/example";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import type { Calculation, Money } from "../lib/money/schema";
import { paydayDifference, paydayOf } from "../lib/views";

interface Row {
  label: string;
  amount: number | [number, number];
  direction?: string;
  certainty?: string;
  date?: string;
}

function kougaku(category: string, total: number, month = "2026-12"): Calculation {
  const input = {
    treatment_month: month,
    income_category: category,
    amount_basis: "total",
    amount_low: total,
    amount_high: total,
    copay_percent: 30,
  };
  return { name: "kougaku_gendo", input, output: kougakuGendo(input) } as Calculation;
}

function cashflow(
  scenarios: { name: string; rows: Row[] }[],
  cash: number | null = 200_000,
): Calculation {
  const input = {
    start_date: "2026-11-24",
    cash_on_hand: cash,
    scenarios: scenarios.map(({ name, rows }) => ({
      name,
      events: rows.map((row) => {
        const [low, high] = Array.isArray(row.amount) ? row.amount : [row.amount, row.amount];
        return {
          date: row.date ?? "2026-12-28",
          label: row.label,
          direction: row.direction ?? "out",
          amount_low: low,
          amount_high: high,
          certainty: row.certainty ?? "estimate",
        };
      }),
    })),
  };
  return { name: "simulate_cashflow", input, output: simulateCashflow(input) } as Calculation;
}

const money = (...calculations: Calculation[]): Money => ({ calculations });
const HOSPITAL = "入院費（保険診療分）";
const MEAL = { label: "入院中の食事代", amount: 24_750, certainty: "assumption" };
const capRow = { label: HOSPITAL, amount: 90_940 };
const nocapRow = { label: HOSPITAL, amount: 240_000 };

test("基本: 上限側と還付側を見分け、差が還付の額と同じなら「避けられる一時立替」", () => {
  const payday = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使う", rows: [capRow, MEAL] },
        { name: "使わない", rows: [nocapRow, MEAL] },
      ]),
    ),
  );
  assert.ok(payday?.cap && payday.nocap);
  assert.deepEqual(payday.capSaves, { low: 149_060, high: 149_060 });
  assert.equal(payday.sameOtherRows, true);
  assert.deepEqual(paydayDifference(payday), {
    kind: "avoidable",
    amount: { low: 149_060, high: 149_060 },
  });
});

test("Codex 1: 区分の違う 2 つの計算（イ・ア）があるときは、結び付けが一意でないので出さない", () => {
  // 区分イ・総額 80 万円の上限適用は 181,130 円。区分アは上限 270,300 円なので、窓口負担 240,000 円のまま。
  const yi = kougaku("イ", 800_000);
  assert.ok(yi.name === "kougaku_gendo");
  assert.equal(yi.output.cases[0].low.pay_with_cap, 181_130);
  const result = paydayOf(
    money(
      yi,
      kougaku("ア", 800_000),
      cashflow([
        { name: "区分イ・上限適用", rows: [{ label: HOSPITAL, amount: 181_130 }] },
        { name: "区分ア・上限適用", rows: [{ label: HOSPITAL, amount: 240_000 }] },
      ]),
    ),
  );
  assert.equal(result, null);
});

test("Codex 1: 医療費でない行が偶然同じ額（家賃・カード）でも、上限側と見なさない", () => {
  const twoMatches = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        {
          name: "試算",
          rows: [
            { label: "上限なしの入院費と食事代", amount: 264_750 },
            { label: "家賃", amount: 90_940 },
            { label: "カードの引き落とし", amount: 90_940 },
          ],
        },
      ]),
    ),
  );
  assert.equal(twoMatches, null);
  // 一致が 1 行でも、医療費の支払いの名前でなければ結び付けない
  const rent = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        {
          name: "試算",
          rows: [
            { label: "上限なしの入院費と食事代", amount: 264_750 },
            { label: "家賃", amount: 90_940 },
          ],
        },
      ]),
    ),
  );
  assert.equal(rent, null);
});

test("Cursor B1: 1 つの筋書きに上限の額と一致する行が 2 つ以上あれば、見分けられない", () => {
  const result = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使う", rows: [capRow, { label: "入院費（追加分）", amount: 90_940 }] },
        { name: "使わない", rows: [nocapRow] },
      ]),
    ),
  );
  assert.equal(result, null);
});

test("Codex 2: 上限側に医療費以外の支出が多いときは、差の向きを保ち「避けられる一時立替」と言わない", () => {
  const payday = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使う", rows: [capRow, { label: "追加の支出", amount: 298_120 }] },
        { name: "使わない", rows: [nocapRow] },
      ]),
    ),
  );
  assert.ok(payday?.cap && payday.nocap);
  assert.deepEqual(payday.cap.need, { low: 389_060, high: 389_060 });
  assert.deepEqual(payday.nocap.need, { low: 240_000, high: 240_000 });
  assert.deepEqual(payday.capSaves, { low: -149_060, high: -149_060 });
  assert.equal(payday.sameOtherRows, false);
  assert.deepEqual(paydayDifference(payday), {
    kind: "difference",
    direction: "cap-more",
    amount: { low: 149_060, high: 149_060 },
  });
});

test("Codex 2: 医療費以外の出入りが筋書きで違えば、上限側が少なくても「避けられる一時立替」と言わない", () => {
  const payday = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使う", rows: [capRow, MEAL] },
        { name: "使わない", rows: [nocapRow, { ...MEAL, amount: 36_300 }] },
      ]),
    ),
  );
  assert.ok(payday);
  assert.equal(payday.sameOtherRows, false);
  assert.deepEqual(paydayDifference(payday), {
    kind: "difference",
    direction: "cap-less",
    amount: { low: 160_610, high: 160_610 },
  });
});

test("Codex 3・Cursor B1: 分類できない筋書きが 1 本でもあれば、比較の欄を丸ごと出さない", () => {
  const threeWays = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "上限あり", rows: [capRow] },
        { name: "上限なし・食事込み", rows: [{ label: "入院費と食事代", amount: 264_750 }] },
        { name: "上限なし・食事多め", rows: [{ label: "入院費と食事代", amount: 324_750 }] },
      ]),
    ),
  );
  assert.equal(threeWays, null);
  const oneUnknown = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使う", rows: [capRow] },
        { name: "使わない", rows: [nocapRow] },
        { name: "別の見積もり", rows: [{ label: HOSPITAL, amount: 150_000 }] },
      ]),
    ),
  );
  assert.equal(oneUnknown, null);
});

test("Cursor B2: 還付側が一番上の筋書きでも、差の向きは同じに読む", () => {
  const payday = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使わない", rows: [nocapRow, MEAL] },
        { name: "使う", rows: [capRow, MEAL] },
      ]),
    ),
  );
  assert.ok(payday?.cap && payday.nocap);
  assert.deepEqual(payday.capSaves, { low: 149_060, high: 149_060 });
  assert.equal(paydayDifference(payday)?.kind, "avoidable");
});

test("Cursor B2: 両側があっても差が取れないときは、差の行を出さない（還付の額に戻さない）", () => {
  const payday = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使う", rows: [capRow, MEAL] },
        { name: "使わない", rows: [nocapRow, MEAL] },
      ]),
    ),
  );
  assert.ok(payday);
  assert.equal(paydayDifference({ ...payday, capSaves: null }), null);
  // 少なめと多めで向きが分かれる差も、行を出さない
  assert.equal(paydayDifference({ ...payday, capSaves: { low: -1_000, high: 2_000 } }), null);
});

test("両側の医療費の行は、同じ名前・同じ日付のときだけ結び付ける", () => {
  const result = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        { name: "使う", rows: [capRow] },
        { name: "使わない", rows: [{ ...nocapRow, label: "入院費（窓口で 3 割）" }] },
      ]),
    ),
  );
  assert.equal(result, null);
});

test("片側だけのときは、高額療養費の計算から還付まで立て替える額を出す", () => {
  const payday = paydayOf(
    money(kougaku("ウ", 800_000), cashflow([{ name: "使う", rows: [capRow, MEAL] }])),
  );
  assert.ok(payday?.cap);
  assert.equal(payday.nocap, null);
  assert.deepEqual(paydayDifference(payday), {
    kind: "refund",
    amount: { low: 149_060, high: 149_060 },
  });
});

test("Codex 4: 入金の内訳の幅は、小さい順に並べる", () => {
  const payday = paydayOf(
    money(
      kougaku("ウ", 800_000),
      cashflow([
        {
          name: "使う",
          rows: [
            capRow,
            { label: "給付金", amount: [30_000, 50_000], direction: "in", certainty: "assumption", date: "2027-01-20" },
          ],
        },
        { name: "使わない", rows: [nocapRow, { label: "給付金", amount: [30_000, 50_000], direction: "in", certainty: "assumption", date: "2027-01-20" }] },
      ]),
    ),
  );
  assert.ok(payday?.cap);
  const income = payday.cap.rows.find((row) => row.direction === "in");
  assert.deepEqual(income?.amount, { low: 30_000, high: 50_000 });
});

test("Cursor B5: 体験例の続きで、準備できた（done）だけのお金のカードも上書きせず、別の番号で足す", () => {
  const workspace = exampleWorkspace();
  workspace.cards = workspace.cards.map((card) =>
    card.kind === "money" ? { ...card, done: true } : card,
  );
  const before = workspace.cards.find((card) => card.id === "hospital-money");
  const after = answerExample(workspace);
  const kept = after.cards.find((card) => card.id === "hospital-money");
  assert.deepEqual(kept, before);
  assert.ok(paydayOf(kept?.money)?.nocap, "前の見通しは両側のまま");
  const fresh = after.cards.find((card) => card.id === "hospital-money-2");
  assert.ok(fresh);
  assert.equal(fresh.done, false);
  assert.equal(paydayOf(fresh.money)?.nocap, null);
  assert.deepEqual(after.messages.at(-1)?.cardIds, ["hospital-money-2"]);
});
