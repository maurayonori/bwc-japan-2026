import { softenClaims } from "./guard";
import { executeTool } from "./tools";

// 道具の入力のうち、モデルが書いた自由文（筋書きの name、入出金と段取りの label）を、計算の前に検査する（#76）。
// 名前は計算表・持ち出しの文章・カードの計算にそのまま写るので、本文と同じ検査（給付の断定・代行の完了・医療の指示）に
// 当たる名前は、中立の名前（「筋書き 1」「項目 2」）に置き換える。当たらない名前（「窓口で上限が使える」など）は変えない。
const NEUTRAL_PREFIX: Record<string, string> = {
  name: "筋書き",
  label: "項目",
};

function claims(text: string): boolean {
  return softenClaims(text, { voice: "reply" }).replaced > 0;
}

function neutralized(value: unknown, key: string, index: number): unknown {
  if (typeof value === "string")
    return key in NEUTRAL_PREFIX && claims(value)
      ? `${NEUTRAL_PREFIX[key]} ${index + 1}`
      : value;
  if (Array.isArray(value)) {
    const items = value.map((item, at) => neutralized(item, key, at));
    return items.every((item, at) => item === value[at]) ? value : items;
  }
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).map(
    ([childKey, child]) =>
      [childKey, neutralized(child, childKey, index)] as const,
  );
  return entries.every(
    ([childKey, child]) =>
      child === (value as Record<string, unknown>)[childKey],
  )
    ? value
    : Object.fromEntries(entries);
}

// 置き換えが無ければ、渡された入力をそのまま返す（保存した入力と同じものとして扱えるように）。
export function neutralizeToolInput(input: unknown): unknown {
  return neutralized(input, "", 0);
}

interface SavedCalculation {
  name: string;
  input: unknown;
  output: unknown;
}

// 保存された計算（旧版で保存したカード）も、読み込むときと持ち出すときに同じ検査を通す（#76）。
// 入力の名前を置き換えたら、結果の名前もそろうように計算し直す。計算し直せなければ、結果の名前だけを置き換える。
export function neutralizeCalculation<C extends SavedCalculation>(calculation: C): C {
  const input = neutralizeToolInput(calculation.input);
  let output = neutralizeToolInput(calculation.output);
  if (input !== calculation.input) {
    try {
      const result = executeTool(calculation.name, input);
      if (result.ok) output = result.output;
    } catch {
      // 計算そのものが失敗しても、結果の名前の置き換えは残す。
    }
  }
  return input === calculation.input && output === calculation.output
    ? calculation
    : { ...calculation, input, output };
}

export function neutralizeMoney<M extends { calculations: readonly SavedCalculation[] }>(money: M): M {
  const calculations = money.calculations.map(neutralizeCalculation);
  return calculations.every((item, index) => item === money.calculations[index])
    ? money
    : { ...money, calculations };
}
