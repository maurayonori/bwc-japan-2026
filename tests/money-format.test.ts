import { test } from "node:test";
import assert from "node:assert/strict";
import { calcDate } from "../lib/money/business-days";
import {
  cashflowPaths,
  cashflowRows,
  inDisplayOrder,
  moneyToText,
  needDifferenceText,
  readingGuide,
} from "../lib/money/format";
import { simulateCashflow } from "../lib/money/ledger";
import type { Calculation, Money } from "../lib/money/schema";

function cashflow(
  scenarios: {
    name: string;
    low: number;
    high: number;
    income?: "assumption" | null;
  }[],
) {
  return simulateCashflow({
    start_date: "2026-11-06",
    cash_on_hand: 200_000,
    scenarios: scenarios.map(({ name, low, high, income }) => ({
      name,
      events: [
        {
          date: "2026-12-28",
          label: "入院費",
          direction: "out" as const,
          amount_low: low,
          amount_high: high,
          certainty: "estimate" as const,
        },
        ...(income
          ? [
              {
                date: "2027-02-01",
                label: "給付金",
                direction: "in" as const,
                amount_low: 50_000,
                amount_high: 50_000,
                certainty: income,
              },
            ]
          : []),
      ],
    })),
  });
}

const asMoney = (calculations: Calculation[]): Money =>
  ({ calculations }) as unknown as Money;

test("額に幅が無いと、少なめと多めを並べず 1 列にする", () => {
  const output = cashflow([{ name: "試算", low: 115_690, high: 115_690 }]);
  const [scenario] = output.scenarios;
  assert.equal(cashflowPaths(scenario).length, 1);
  const { headers, rows } = cashflowRows(scenario, true, 2026);
  assert.deepEqual(headers, ["", "見通し"]);
  assert.deepEqual(rows[0], ["手元に要る額", "115,690 円"]);
});

test("額に幅があれば、少なめと多めを並べる", () => {
  const output = cashflow([{ name: "試算", low: 100_000, high: 150_000 }]);
  const { headers, rows } = cashflowRows(output.scenarios[0], true, 2026);
  assert.deepEqual(headers, ["", "少なめの場合", "多めの場合"]);
  assert.deepEqual(rows[0], ["手元に要る額", "100,000 円", "150,000 円"]);
});

test("確かめていない入金があれば、額に幅が無くても数えない場合を並べる", () => {
  const output = cashflow([
    { name: "試算", low: 300_000, high: 300_000, income: "assumption" },
  ]);
  const paths = cashflowPaths(output.scenarios[0]);
  assert.equal(paths.length, 3);
  assert.equal(paths[2].label, "多めの場合で、確かめていない入金を数えない");
});

test("比べた差は、少なめと多めが同じなら 1 つだけ書く", () => {
  const same = cashflow([
    { name: "元の予定", low: 100_000, high: 100_000 },
    { name: "延びた場合", low: 110_000, high: 110_000 },
  ]);
  assert.equal(needDifferenceText(same.comparison_with_first[0]), "+10,000 円");

  const differs = cashflow([
    { name: "元の予定", low: 100_000, high: 100_000 },
    { name: "延びた場合", low: 110_000, high: 130_000 },
  ]);
  assert.equal(
    needDifferenceText(differs.comparison_with_first[0]),
    "少なめの場合 +10,000 円、多めの場合 +30,000 円",
  );
});

test("幅が 1 つも無ければ、読み方に幅の説明を出さない", () => {
  const flat = cashflow([{ name: "試算", low: 100_000, high: 100_000 }]);
  assert.ok(readingGuide(flat).every((line) => !line.includes("少なめ")));

  const ranged = cashflow([{ name: "試算", low: 100_000, high: 150_000 }]);
  assert.ok(readingGuide(ranged).some((line) => line.includes("少なめ")));
});

test("持ち出しの文章にも、同じ額を 2 つ書かない", () => {
  const input = {
    start_date: "2026-11-06",
    cash_on_hand: 200_000,
    scenarios: [
      {
        name: "試算",
        events: [
          {
            date: "2026-12-28",
            label: "入院費",
            direction: "out" as const,
            amount_low: 115_690,
            amount_high: 115_690,
            certainty: "estimate" as const,
          },
        ],
      },
    ],
  };
  const text = moneyToText(
    asMoney([
      {
        name: "simulate_cashflow",
        input,
        output: simulateCashflow(input),
      } as Calculation,
    ]),
    "",
  );
  assert.ok(text.includes("- 手元に要る額: 115,690 円"));
  assert.ok(!text.includes("少なめの場合"));
});

test("起点と同じ日までを数えただけの日付計算は、表に出さない", () => {
  const dateCalculation = (until: string): Calculation => {
    const input = { start_date: "2026-12-14", steps: [], until_date: until };
    return {
      name: "calc_date",
      input,
      output: calcDate(input),
    } as Calculation;
  };
  const trivial = dateCalculation("2026-12-14");
  const useful = dateCalculation("2026-12-28");
  assert.deepEqual(inDisplayOrder([trivial, useful]), [useful]);
  assert.ok(!moneyToText(asMoney([trivial]), "").includes("日付の計算"));
  assert.ok(moneyToText(asMoney([useful]), "").includes("日付の計算"));
});
