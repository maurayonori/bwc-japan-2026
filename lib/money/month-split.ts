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
  // その月に渡した額の幅（kougaku_gendo の入力。総医療費か窓口負担か）。
  basis: string;
  givenLow: number;
  givenHigh: number;
}

// 高額療養費の計算の結果から、診療月ごとの窓口負担の幅（上限が使える場合・使えない場合）を、渡した額の幅と一緒に集める。
function monthRanges(kougaku: readonly KougakuEvent[]): MonthRange[] {
  return kougaku.flatMap((event) => {
    const parsed = kougakuOutputSchema.safeParse(event.output);
    if (!parsed.success) return [];
    const input = event.input as { amount_basis?: unknown; amount_low?: unknown; amount_high?: unknown };
    if (typeof input?.amount_low !== "number" || typeof input?.amount_high !== "number")
      return [];
    const given = {
      basis: String(input.amount_basis),
      givenLow: input.amount_low,
      givenHigh: input.amount_high,
    };
    const { treatment_month: month, cases } = parsed.data;
    return cases.flatMap((item) => [
      { month, low: item.low.pay_with_cap, high: item.high.pay_with_cap, ...given },
      { month, low: item.low.copay_without_cap, high: item.high.copay_without_cap, ...given },
    ]);
  });
}

interface CashflowEvent {
  label?: unknown;
  direction?: unknown;
  amount_low?: unknown;
  amount_high?: unknown;
}

export const MONTH_SPLIT_ERROR =
  "月をまたぐ入院の月ごとの窓口負担を、同じ筋書きの中で別々の幅（0 円から）として置いています。2 か月の医療費の合計は総額で決まっているので、別々の幅にすると、両方の月が多めになる組み合わせまで数えてしまいます。月ごとの医療費は、筋書きごとに 1 つの額に決めてください（例: 12 月に寄る＝12 月に総額・1 月は 0 円、1 月に寄る、半々＝総額の半分ずつ）。その額で kougaku_gendo を月ごとに呼び、筋書きを分けて simulate_cashflow を呼び直してください。";

// 差し戻すのは、決まった総額を月ごとの独立した幅に広げたと確かめられる入力だけ（#67 の Codex①）。
// 同じ筋書きの中に、別々の月の窓口負担の幅があり、どちらも「0 円から同じ額まで」を渡した計算の結果と一致するとき
// （総額をその月に全部寄せた場合までを、どの月にも置いている）。病院が月ごとに言った幅（12 月 70〜80 万円、
// 1 月 0〜10 万円）は、月ごとに渡した額が違うので受け付ける。確かめられないものは受け付ける。
export function monthSplitError(
  input: unknown,
  kougaku: readonly KougakuEvent[],
): string | null {
  const scenarios = (input as { scenarios?: unknown })?.scenarios;
  if (!Array.isArray(scenarios)) return null;
  const ranges = monthRanges(kougaku).filter(
    (range) => range.givenLow === 0 && range.givenHigh > 0,
  );
  for (const scenario of scenarios) {
    const events: CashflowEvent[] = Array.isArray(scenario?.events) ? scenario.events : [];
    const spread = events
      .filter(
        (event) =>
          event.direction === "out" &&
          typeof event.amount_low === "number" &&
          typeof event.amount_high === "number" &&
          event.amount_low < event.amount_high,
      )
      .map((event) =>
        ranges.filter(
          (range) => range.low === event.amount_low && range.high === event.amount_high,
        ),
      )
      .filter((matched) => matched.length > 0);
    for (const [index, first] of spread.entries())
      for (const second of spread.slice(index + 1))
        if (
          first.some((a) =>
            second.some(
              (b) =>
                a.month !== b.month &&
                a.basis === b.basis &&
                a.givenHigh === b.givenHigh,
            ),
          )
        )
          return MONTH_SPLIT_ERROR;
  }
  return null;
}
