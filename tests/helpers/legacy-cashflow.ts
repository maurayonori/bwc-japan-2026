import { kougakuGendo } from "../../lib/money/kougaku";
import type { CashflowInput } from "../../lib/money/ledger";
import { mealCost } from "../../lib/money/meals";

// テストの固定の入力。2026-11-07 まで架空の体験例だったもの（11 月の 15 日間、区分ウ、窓口負担 24 万〜30 万円、手元のお金は不明）。
// 筋書きの不明点（上限が使えるか）と入院費の額の幅の 2 つがあり、先頭を確かめても幅が 2,000 円残るので、順位づけの検査に使う。
// 数字は手で書かず、本番と同じ計算関数で作る。
export function legacyCashflowInput(): CashflowInput {
  const kougaku = kougakuGendo({
    treatment_month: "2026-11",
    income_category: "ウ",
    amount_basis: "copay",
    amount_low: 240_000,
    amount_high: 300_000,
    copay_percent: 30,
  });
  const meals = mealCost({ days_low: 15, days_high: 15 });
  const { low, high } = kougaku.cases[0];
  const mealEvent = {
    date: "2026-11-30",
    label: "入院中の食事代",
    direction: "out" as const,
    amount_low: meals.low.cost_max,
    amount_high: meals.high.cost_max,
    certainty: "estimate" as const,
  };
  const hospital = (amountLow: number, amountHigh: number) => ({
    date: "2026-11-30",
    label: "入院費（保険診療分）",
    direction: "out" as const,
    amount_low: amountLow,
    amount_high: amountHigh,
    certainty: "estimate" as const,
  });
  return {
    start_date: "2026-11-06",
    cash_on_hand: null,
    scenarios: [
      {
        name: "窓口で上限が適用される場合",
        events: [hospital(low.pay_with_cap, high.pay_with_cap), mealEvent],
      },
      {
        name: "いったん 3 割を払う場合",
        events: [
          hospital(low.copay_without_cap, high.copay_without_cap),
          mealEvent,
        ],
      },
    ],
  };
}
