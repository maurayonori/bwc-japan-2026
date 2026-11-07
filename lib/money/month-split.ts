import { kougakuOutputSchema } from "./schema";

// 月をまたぐ入院で、月ごとの窓口負担を、同じ筋書きの中で別々の幅（0 円から）として置いた入力を見つける（#66）。
// 2 か月の医療費の合計は総額で決まっているので、別々の幅にすると「両方の月が多め」の組み合わせまで数え、
// 要る額の幅が広がりすぎる（実 API の 1 回目: 36,300〜218,180 円）。プログラムで差し戻し、筋書きごとに月の額を決めさせる。

interface KougakuEvent {
  input: unknown;
  output?: unknown;
}

interface MonthRange {
  month: string;
  low: number;
  high: number;
}

// 高額療養費の計算の結果から、診療月ごとの窓口負担の幅（上限が使える場合・使えない場合）を集める。
function monthRanges(kougaku: readonly KougakuEvent[]): MonthRange[] {
  return kougaku.flatMap((event) => {
    const parsed = kougakuOutputSchema.safeParse(event.output);
    if (!parsed.success) return [];
    const { treatment_month: month, cases } = parsed.data;
    return cases.flatMap((item) => [
      { month, low: item.low.pay_with_cap, high: item.high.pay_with_cap },
      { month, low: item.low.copay_without_cap, high: item.high.copay_without_cap },
    ]);
  });
}

// 入出金の名前に書かれた月（「入院費（12 月分）」の 12）。
const LABEL_MONTH = /(\d{1,2})\s*月/;
const MEDICAL_LABEL = /入院費|医療費|保険診療|窓口負担|高額療養費/;

interface CashflowEvent {
  label?: unknown;
  direction?: unknown;
  amount_low?: unknown;
  amount_high?: unknown;
}

function monthsOf(event: CashflowEvent, ranges: readonly MonthRange[]): Set<string> {
  const months = new Set(
    ranges
      .filter((range) => range.low === event.amount_low && range.high === event.amount_high)
      .map((range) => range.month.slice(5).replace(/^0/, "")),
  );
  const label = typeof event.label === "string" ? event.label : "";
  const named = LABEL_MONTH.exec(label);
  if (named && MEDICAL_LABEL.test(label)) months.add(String(Number(named[1])));
  return months;
}

export const MONTH_SPLIT_ERROR =
  "月をまたぐ入院の月ごとの窓口負担を、同じ筋書きの中で別々の幅（0 円から）として置いています。2 か月の医療費の合計は総額で決まっているので、別々の幅にすると、両方の月が多めになる組み合わせまで数えてしまいます。月ごとの医療費は、筋書きごとに 1 つの額に決めてください（例: 12 月に寄る＝12 月に総額・1 月は 0 円、1 月に寄る、半々＝総額の半分ずつ）。その額で kougaku_gendo を月ごとに呼び、筋書きを分けて simulate_cashflow を呼び直してください。";

export function monthSplitError(
  input: unknown,
  kougaku: readonly KougakuEvent[],
): string | null {
  const scenarios = (input as { scenarios?: unknown })?.scenarios;
  if (!Array.isArray(scenarios)) return null;
  const ranges = monthRanges(kougaku);
  for (const scenario of scenarios) {
    const events: CashflowEvent[] = Array.isArray(scenario?.events) ? scenario.events : [];
    // 幅のある支払いのうち、診療月が分かるもの。
    const ranged = events
      .filter(
        (event) =>
          event.direction === "out" &&
          typeof event.amount_low === "number" &&
          typeof event.amount_high === "number" &&
          event.amount_low < event.amount_high,
      )
      .map((event) => ({ event, months: monthsOf(event, ranges) }))
      .filter((item) => item.months.size > 0);
    if (ranged.length < 2) continue;
    const months = new Set(ranged.flatMap((item) => [...item.months]));
    // 0 円から始まる幅（その月に費用が無いかもしれない、という置き方）があるときだけ差し戻す。
    // 総額の幅を月ごとに分けた幅（例: 35〜45 万円ずつ）は、両端が総額の両端と合うので受け付ける。
    const fromZero = ranged.some((item) => item.event.amount_low === 0);
    if (months.size >= 2 && fromZero) return MONTH_SPLIT_ERROR;
  }
  return null;
}
