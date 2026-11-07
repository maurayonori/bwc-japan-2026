// 同じ回に見通し（simulate_cashflow）が複数あるとき、どれを本線にするかをプログラムで決める（#82）。
// Claude が試しに呼んだ見通し（筋書き「x」・1 円など）が最後に来ると、「最後の見通し」を見る画面と検査が
// 正しい額を伏せてしまう。内訳の計算（kougaku_gendo・meal_cost）の額を入出金に含む見通しのうち最後のものを
// 本線にし、どれも含まなければ今までどおり最後の見通しを本線にする。試し呼びの記録は消さない。
//
// 入力は、カードの計算（Calculation）でも検査に渡す道具の記録（input と output だけ）でも使えるよう、
// 出力の形で道具を見分ける。

interface ToolLike {
  input: unknown;
  output?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const numbersOf = (value: unknown, keys: readonly string[]): number[] =>
  isRecord(value)
    ? keys.flatMap((key) =>
        typeof value[key] === "number" ? [value[key]] : [],
      )
    : [];

// 見通しの結果か（what_to_confirm を持つ）。
export const isCashflowOutput = (output: unknown): boolean =>
  isRecord(output) &&
  "what_to_confirm" in output &&
  Array.isArray(output.scenarios);

// 内訳の計算が出した額。高額療養費は窓口で払う額と上限の無いときの負担、食事代は多めと少なめの合計。
// 保険診療分と食事代を 1 つの入出金にまとめた見通し（例: 入院費 115,690 円）も拾えるよう、その和も入れる。
export function breakdownAmounts(items: readonly ToolLike[]): Set<number> {
  const copays: number[] = [];
  const meals: number[] = [];
  for (const { output } of items) {
    if (!isRecord(output)) continue;
    if (Array.isArray(output.cases)) {
      for (const item of output.cases) {
        if (!isRecord(item)) continue;
        copays.push(
          ...numbersOf(item.low, ["pay_with_cap", "copay_without_cap"]),
          ...numbersOf(item.high, ["pay_with_cap", "copay_without_cap"]),
        );
      }
    }
    if (
      isRecord(output.low) &&
      isRecord(output.high) &&
      "yen_per_meal" in output
    ) {
      meals.push(
        ...numbersOf(output.low, ["cost_max"]),
        ...numbersOf(output.high, ["cost_max"]),
      );
    }
  }
  const amounts = new Set<number>([...copays, ...meals]);
  for (const copay of copays)
    for (const meal of meals) amounts.add(copay + meal);
  amounts.delete(0);
  return amounts;
}

// 見通しの入力にある入出金の額（少なめと多め）。
export function cashflowAmounts(input: unknown): number[] {
  if (!isRecord(input) || !Array.isArray(input.scenarios)) return [];
  return input.scenarios.flatMap((scenario) =>
    isRecord(scenario) && Array.isArray(scenario.events)
      ? scenario.events.flatMap((event) =>
          numbersOf(event, ["amount_low", "amount_high"]),
        )
      : [],
  );
}

// 本線にする見通しの位置。見通しが無ければ -1。
// from は今回の回の記録が始まる位置（#85）。今回の回に見通しがあれば今回の見通しから選び、無いときだけ
// 前の回までさかのぼる。内訳の額（照らす基準）は、前の回の分も含めて全体から集める。
export function mainCashflowIndex(items: readonly ToolLike[], from = 0): number {
  const all = items.flatMap((item, index) =>
    isCashflowOutput(item.output) ? [index] : [],
  );
  const current = all.filter((index) => index >= from);
  const cashflows = current.length > 0 ? current : all;
  if (cashflows.length <= 1) return cashflows[0] ?? -1;
  const reference = breakdownAmounts(items);
  const consistent =
    reference.size === 0
      ? []
      : cashflows.filter((index) =>
          cashflowAmounts(items[index].input).some((amount) => reference.has(amount)),
        );
  const candidates = consistent.length > 0 ? consistent : cashflows;
  return candidates[candidates.length - 1];
}

// 本線の見通しが最後に来るように並べ直す。ほかの順は変えない。
// 画面と持ち出しは「最後の見通し」を見るので、並びを直すだけで全部がそろう。
export function withMainCashflowLast<T extends ToolLike>(
  items: readonly T[],
): T[] {
  const main = mainCashflowIndex(items);
  if (main < 0 || main === items.length - 1) return [...items];
  const lastCashflow = items.reduce(
    (found, item, index) => (isCashflowOutput(item.output) ? index : found),
    -1,
  );
  if (main === lastCashflow) return [...items];
  return [...items.filter((_, index) => index !== main), items[main]];
}
