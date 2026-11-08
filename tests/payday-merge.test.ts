// #74: 月をまたぐ入院で、Claude が額の変わらない筋書きを 2 つに分けると、支払日の表に同じ行が 2 つ並び、
// 表の下の差の文に「0 円」が出る。支払日の表では、要る額・いつ・手元のお金との差・確かさがすべて同じ筋書きを
// 1 行にまとめ、名前を「／」でつなぐ。お金の出入りの表（計算の記録）は筋書きごとに残す。数字はすべて架空。
import { test } from "node:test";
import assert from "node:assert/strict";
import { paydayGapText, paydayTable } from "../lib/money/format";
import { simulateCashflow } from "../lib/money/ledger";

type Certainty = "confirmed" | "estimate" | "assumption";

function scenario(
  name: string,
  amount: number,
  {
    date = "2027-01-04",
    certainty = "estimate" as Certainty,
    income,
  }: {
    date?: string;
    certainty?: Certainty;
    income?: { date: string; amount: number };
  } = {},
) {
  return {
    name,
    events: [
      ...(income
        ? [
            {
              date: income.date,
              label: "傷病手当金",
              direction: "in" as const,
              amount_low: income.amount,
              amount_high: income.amount,
              certainty: "assumption" as const,
            },
          ]
        : []),
      {
        date,
        label: "入院費",
        direction: "out" as const,
        amount_low: amount,
        amount_high: amount,
        certainty,
      },
    ],
  };
}

const cashflow = (scenarios: ReturnType<typeof scenario>[], cash = 200_000) =>
  simulateCashflow({ start_date: "2026-11-08", cash_on_hand: cash, scenarios });

test("要る額・いつ・差・確かさが同じ筋書きは、支払日の表で 1 行にまとめ、名前を「／」でつなぐ", () => {
  // 11/8 04:16 の本番の 3 回目と同じ形（12 月に寄る・1 月に寄るが同じ 127,240 円）。
  const output = cashflow([
    scenario("費用が12月に寄る場合", 127_240),
    scenario("費用が1月に寄る場合", 127_240),
    scenario("費用が12月と1月に半々の場合", 210_180),
  ]);
  const { rows } = paydayTable(output);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], "費用が12月に寄る場合／費用が1月に寄る場合");
  assert.equal(rows[0][1], "127,240 円");
  assert.equal(rows[1][0], "費用が12月と1月に半々の場合");
  // 計算の記録は消さない
  assert.equal(output.scenarios.length, 3);
});

test("差の文は、まとめた筋書きを 1 回だけ書き、先頭と同じ額の筋書きの「0 円」を出さない", () => {
  const output = cashflow([
    scenario("費用が12月に寄る場合", 127_240),
    scenario("費用が1月に寄る場合", 127_240),
    scenario("費用が12月と1月に半々の場合", 210_180),
  ]);
  assert.equal(
    paydayGapText(output),
    "「費用が12月に寄る場合／費用が1月に寄る場合」と比べると、「費用が12月と1月に半々の場合」は +82,940 円。",
  );
});

test("先頭以外で同じ額の筋書き（上限が使えない 2 つ）も、1 行・1 回にまとめる", () => {
  // 11/8 04:06 の本番の形（2×2 の 4 筋書きで、上限が使えない 2 つが 276,300 円）。
  const output = cashflow([
    scenario("12月に寄り、窓口で上限が適用される場合", 127_240),
    scenario("12月に寄り、上限が適用されず3割を払う場合", 276_300),
    scenario("12月と1月に半々で、窓口で上限が適用される場合", 210_180),
    scenario("12月と1月に半々で、上限が適用されず3割を払う場合", 276_300),
  ]);
  const { rows } = paydayTable(output);
  assert.deepEqual(
    rows.map((row) => [row[0], row[1]]),
    [
      ["12月に寄り、窓口で上限が適用される場合", "127,240 円"],
      [
        "12月に寄り、上限が適用されず3割を払う場合／12月と1月に半々で、上限が適用されず3割を払う場合",
        "276,300 円",
      ],
      ["12月と1月に半々で、窓口で上限が適用される場合", "210,180 円"],
    ],
  );
  assert.equal(
    paydayGapText(output),
    "「12月に寄り、窓口で上限が適用される場合」と比べると、「12月に寄り、上限が適用されず3割を払う場合／12月と1月に半々で、上限が適用されず3割を払う場合」は +149,060 円、「12月と1月に半々で、窓口で上限が適用される場合」は +82,940 円。",
  );
});

test("額が同じでも、いつか確かさが違えばまとめない", () => {
  const output = cashflow([
    scenario("退院日に払う場合", 127_240),
    scenario("月末に払う場合", 127_240, { date: "2027-01-29" }),
    scenario("病院に確かめた場合", 127_240, { certainty: "confirmed" }),
  ]);
  assert.equal(paydayTable(output).rows.length, 3);
});

test("確かめていない入金を数えない場合の行が違えば、まとめない", () => {
  // 片方だけ、支払日より前に入る確かめていない入金がある（数えない場合の行が付く）。
  const output = cashflow(
    [
      scenario("給付金が入る場合", 115_690, {
        date: "2026-12-28",
        income: { date: "2026-12-20", amount: 100_000 },
      }),
      scenario("給付金が無い場合", 15_690, { date: "2026-12-28" }),
    ],
    50_000,
  );
  const names = paydayTable(output).rows.map((row) => row[0]);
  assert.deepEqual(names, [
    "給付金が入る場合",
    "給付金が入る場合・確かめていない入金を数えない場合",
    "給付金が無い場合",
  ]);
});

test("同じ額の筋書きが無ければ、表と差の文は今までと同じ（体験例の 1 回目）", () => {
  const output = cashflow([
    scenario("窓口で上限が適用される場合", 115_690, { date: "2026-12-28" }),
    scenario("上限が適用されず、いったん3割を払う場合", 264_750, {
      date: "2026-12-28",
    }),
  ]);
  assert.deepEqual(
    paydayTable(output).rows.map((row) => row[0]),
    ["窓口で上限が適用される場合", "上限が適用されず、いったん3割を払う場合"],
  );
  assert.equal(
    paydayGapText(output),
    "「窓口で上限が適用される場合」と比べると、「上限が適用されず、いったん3割を払う場合」は +149,060 円。",
  );
});

test("すべての筋書きが同じなら、1 行になり、差の文は出さない", () => {
  const output = cashflow([
    scenario("費用が12月に寄る場合", 127_240),
    scenario("費用が1月に寄る場合", 127_240),
  ]);
  assert.equal(paydayTable(output).rows.length, 1);
  assert.equal(paydayGapText(output), "");
});
