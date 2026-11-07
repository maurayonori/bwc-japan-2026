import { FACTS } from "./facts";
import type {
  CalcDateOutput,
  CashflowOutput,
  KougakuOutput,
  MealOutput,
  Money,
  Source,
} from "./schema";

// 画面と持ち出しで同じ書き方にするための、表示の部品。ここで新しい数字は作らない。

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const NO_VALUE = "—";

export const CERTAINTY_TEXT: Record<string, string> = {
  confirmed: "確かめた額",
  estimate: "見積もり",
  assumption: "仮定",
};
export const DIRECTION_TEXT: Record<string, string> = {
  out: "払う",
  in: "入る",
};
const UNIT_TEXT: Record<string, string> = {
  day: "日",
  week: "週間",
  business_day: "営業日",
  month: "か月",
};
const RANGE_GUIDE = [
  "「少なめの場合」は、支払いを少なめ・入金を多めに置いたとき。「多めの場合」は、支払いを多め・入金を少なめに置いたとき。",
  "幅は、置いた仮定の下限と上限です。確率ではありません。",
  "確かめていない入金は、手元のお金として数えない場合も並べています。",
];
const NEED_GUIDE = [
  "「手元に要る額」は、その日までの支払いをまかなうために、起点の日に手元に要る額です。あとから入るお金では、先に来る支払いは埋まりません。",
  "同じ日の入金と支払いは、支払いを先に置いています。",
];
export const KOUGAKU_ROWS = [
  ["医療費の総額（10 割）", "total_medical_cost"],
  ["上限が無いときの窓口負担", "copay_without_cap"],
  ["1 か月の上限額", "cap"],
  ["窓口で払う額（上限が適用されるとき）", "pay_with_cap"],
  ["いったん全額を払ったとき、あとで戻る額", "refund_later"],
] as const;

// 返答の下に出す「この返答で呼んだ計算」の名前。
export const TOOL_LABELS: Record<string, string> = {
  kougaku_gendo: "高額療養費の上限",
  meal_cost: "入院中の食事代",
  calc_date: "日付の計算",
  simulate_cashflow: "お金の出入りの見通し",
};

// 呼んだ順に、同じ計算は回数にまとめる（例: 高額療養費の上限 ×2、お金の出入りの見通し ×1）。
export function toolTraceText(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => `${TOOL_LABELS[name] ?? name} ×${count}`)
    .join("、");
}

const numberFormat = new Intl.NumberFormat("ja-JP");

export function yen(value: number | null | undefined): string {
  if (typeof value !== "number") return NO_VALUE;
  return `${value < 0 ? "−" : ""}${numberFormat.format(Math.abs(value))} 円`;
}

export function yenRange(low: number, high: number): string {
  return low === high
    ? yen(low)
    : `${numberFormat.format(low)}〜${numberFormat.format(high)} 円`;
}

export function signedYen(value: number): string {
  return `${value > 0 ? "+" : ""}${yen(value)}`;
}

// 手元のお金と、要る額の幅を比べた差。残るか、足りないか（#55）。
export function cashGapText(
  cash: number,
  needLow: number,
  needHigh: number,
): string {
  const gapLow = cash - needHigh;
  const gapHigh = cash - needLow;
  if (gapLow >= 0) return `${yenRange(gapLow, gapHigh)}残る`;
  if (gapHigh <= 0) return `${yenRange(-gapHigh, -gapLow)}足りない`;
  return `${yen(-gapLow)}まで足りないことがある`;
}

// 年は書かない。年をまたぐ見通しでも読み違えないよう、起点と違う年だけ年を足せるようにする。
export function showDate(date: string | null, baseYear?: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!match) return NO_VALUE;
  const [year, month, day] = match.slice(1).map(Number);
  const weekday =
    WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${baseYear === undefined || year === baseYear ? "" : `${year}/`}${month}/${day}（${weekday}）`;
}

export function monthText(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return `${year} 年 ${value} 月`;
}

export function copayText(percent: number): string {
  return percent === 30 ? "3 割" : percent === 20 ? "2 割" : `${percent}%`;
}

export function formulaText(
  formula: KougakuOutput["cases"][number]["formula"],
): string {
  return formula.threshold === null
    ? `上限は定額: ${yen(formula.base)}`
    : `上限の式: ${yen(formula.base)} ＋（医療費の総額 − ${yen(formula.threshold)}）× ${formula.rate_percent}%`;
}

export function stepText(step: CalcDateOutput["steps"][number]): string {
  if (step.count === 0) {
    return step.unit === "business_day" ? "当日（休みなら次の営業日）" : "当日";
  }
  const unit = UNIT_TEXT[step.unit] ?? step.unit;
  return `${Math.abs(step.count)} ${unit}${step.count > 0 ? "後" : "前"}`;
}

const yearOf = (date: string): number => Number(date.slice(0, 4));

export type CashflowScenario = CashflowOutput["scenarios"][number];

export function cashflowPaths(scenario: CashflowScenario) {
  // 支払いにも入金にも幅が無いと、少なめと多めは同じ結果になる。同じ額を 2 列に並べない。
  if (
    scenario.totals.unconfirmed_in_high === 0 &&
    JSON.stringify(scenario.low_case) === JSON.stringify(scenario.high_case)
  )
    return [{ label: "見通し", path: scenario.low_case }];
  return [
    { label: "少なめの場合", path: scenario.low_case },
    { label: "多めの場合", path: scenario.high_case },
    ...(scenario.totals.unconfirmed_in_high > 0
      ? [
          {
            label: "多めの場合で、確かめていない入金を数えない",
            path: scenario.high_case_without_unconfirmed_income,
          },
        ]
      : []),
  ];
}

// 表の行。1 列目が項目名、以降が場合ごとの値。画面と持ち出しの両方が使う。
export function cashflowRows(
  scenario: CashflowScenario,
  hasCash: boolean,
  baseYear: number,
): { headers: string[]; rows: string[][] } {
  const paths = cashflowPaths(scenario);
  const read = (
    label: string,
    value: (path: CashflowScenario["low_case"]) => string,
  ) => [label, ...paths.map(({ path }) => value(path))];
  return {
    headers: ["", ...paths.map(({ label }) => label)],
    rows: [
      read("手元に要る額", (path) => yen(path.need)),
      read("一番きつくなる日", (path) =>
        path.need_date ? showDate(path.need_date, baseYear) : "なし",
      ),
      ...(hasCash
        ? [
            read("足りない額", (path) => yen(path.shortfall)),
            read("最初に足りなくなる日", (path) =>
              path.first_shortfall_date
                ? showDate(path.first_shortfall_date, baseYear)
                : "なし",
            ),
            read("期間の終わりの手元", (path) => yen(path.end_balance)),
          ]
        : []),
    ],
  };
}

// 幅のある場合が 1 つも無ければ、幅についての読み方は要らない。
export function readingGuide(output: CashflowOutput): string[] {
  return output.scenarios.some((scenario) => cashflowPaths(scenario).length > 1)
    ? [...RANGE_GUIDE, ...NEED_GUIDE]
    : NEED_GUIDE;
}

// 最初の場合と比べた、手元に要る額の差。少なめと多めが同じなら 1 つだけ書く。
export function needDifferenceText(
  item: CashflowOutput["comparison_with_first"][number],
): string {
  return item.need_low_difference === item.need_high_difference
    ? signedYen(item.need_low_difference)
    : `少なめの場合 ${signedYen(item.need_low_difference)}、多めの場合 ${signedYen(item.need_high_difference)}`;
}

const uniqueSources = (sources: readonly Source[]): Source[] => [
  ...new Map(sources.map((source) => [source.url, source])).values(),
];

const CITATION_ID = /F\d{2}/g;

export interface CitedFact {
  id: string;
  topic: string;
  sources: readonly { name: string; url: string }[];
  checked_on: string;
}

// 文章に書かれた [F03] の番号から、持っている事実を引く。無い番号は出さない。
export function citedFacts(text: string): CitedFact[] {
  const citations = text.match(/\[F\d{2}(?:\s*[,、]\s*F\d{2})*\]/g) ?? [];
  const ids = new Set(
    citations.flatMap((part) => part.match(CITATION_ID) ?? []),
  );
  return FACTS.filter((fact) => ids.has(fact.id));
}

// 計算の結果と、文章で引いた事実の出典を 1 つにまとめる（同じ URL は 1 回だけ）。
// simulate_cashflow は、渡した入出金を日付順に並べるだけで制度の表を使わないので、出典を持たない（結果に sources が無い）。
export function moneySources(money: Money, text: string): Source[] {
  const fromTools = money.calculations.flatMap((calculation) =>
    calculation.name === "simulate_cashflow" ? [] : calculation.output.sources,
  );
  const fromFacts = citedFacts(text).flatMap((fact) =>
    fact.sources.map((source) => ({
      name: `${source.name}（${fact.id}: ${fact.topic}）`,
      url: source.url,
      checked_on: fact.checked_on,
    })),
  );
  return uniqueSources([...fromTools, ...fromFacts]);
}

// ---- 持ち出しのテキスト ----

function sourceLines(sources: readonly Source[]): string[] {
  return sources.length > 0
    ? [
        "出典と確認日",
        ...sources.map(
          (source) =>
            `- ${source.name} ${source.url}（確認 ${source.checked_on}）`,
        ),
      ]
    : [];
}

// 表の無いメモの本文に [F03] があるとき、持ち出した先でも出典をたどれるようにする。
export function citationsToText(text: string): string {
  return sourceLines(
    uniqueSources(
      citedFacts(text).flatMap((fact) =>
        fact.sources.map((source) => ({
          name: `${source.name}（${fact.id}: ${fact.topic}）`,
          url: source.url,
          checked_on: fact.checked_on,
        })),
      ),
    ),
  ).join("\n");
}

function kougakuText(output: KougakuOutput): string[] {
  const single = output.cases.length === 1;
  return [
    `■ 高額療養費の上限（${monthText(output.treatment_month)}の診療分・窓口負担 ${copayText(output.copay_percent)}・保険診療分だけ）`,
    ...output.cases.flatMap((item) => [
      `区分${item.category}（${item.condition}）`,
      ...(single
        ? KOUGAKU_ROWS.map(
            ([label, key]) =>
              `- ${label}: ${yenRange(item.low[key], item.high[key])}`,
          )
        : [
            `- 1 か月の上限額: ${yenRange(item.low.cap, item.high.cap)}`,
            `- 窓口で払う額（上限が適用されるとき）: ${yenRange(item.low.pay_with_cap, item.high.pay_with_cap)}`,
          ]),
    ]),
  ];
}

function mealText(output: MealOutput): string[] {
  const cases =
    output.low.days === output.high.days
      ? [output.low]
      : [output.low, output.high];
  return [
    "■ 入院中の食事代（1 日 3 食で数えた、多めの見積もり）",
    ...cases.map(
      (item) =>
        `- ${item.days} 日間: ${yen(output.yen_per_meal)} × ${item.meals_max} 食 ＝ ${yen(item.cost_max)}`,
    ),
  ];
}

function dateText(output: CalcDateOutput): string[] {
  const baseYear = yearOf(output.start.date);
  return [
    `■ 日付の計算（起点 ${showDate(output.start.date)}）`,
    ...output.steps.map(
      (step) =>
        `- ${step.label}: ${stepText(step)} → ${showDate(step.date, baseYear)}`,
    ),
    ...(output.until
      ? [
          `- ${showDate(output.until.date, baseYear)} まで: ${output.until.days_after_start} 日${output.until.days_inclusive === null ? "" : `（起点の日を入れると ${output.until.days_inclusive} 日間）`}`,
        ]
      : []),
  ];
}

// 持ち出し用の「まず確かめる 1 つ」。不明点が無ければ見出しも出さない。
export function confirmText(output: CashflowOutput): string[] {
  const confirm = output.what_to_confirm;
  const top = confirm?.factors[0];
  if (!confirm || !top) return [];
  return [
    "■ まず確かめる 1 つ",
    top.name,
    `- 手元に要る額の幅: ${yenRange(confirm.need_low, confirm.need_high)}（幅 ${yen(confirm.width)}）`,
    ...(confirm.shortfall_low !== null && confirm.shortfall_high !== null
      ? [
          `- 手元のお金と比べて足りない額: ${yenRange(confirm.shortfall_low, confirm.shortfall_high)}`,
        ]
      : []),
    `- 確かめると残る幅: ${yen(top.width_if_resolved)}（答えによって残る幅のうち、大きいほう）`,
    ...top.branches.map(
      (branch) =>
        `- 答えが「${branch.name}」なら: ${yenRange(branch.need_low, branch.need_high)}`,
    ),
  ];
}

function cashflowText(output: CashflowOutput): string[] {
  const hasCash = output.cash_on_hand !== null;
  const baseYear = yearOf(output.start_date);
  return [
    ...confirmText(output),
    `■ お金の出入りの見通し（起点 ${showDate(output.start_date)}。手元のお金: ${hasCash ? yen(output.cash_on_hand) : "聞いていないので、要る額までを出しています"}）`,
    ...output.scenarios.flatMap((scenario) => {
      const { headers, rows } = cashflowRows(scenario, hasCash, baseYear);
      return [
        `「${scenario.name}」`,
        ...rows.map(([label, ...values]) =>
          values.length === 1
            ? `- ${label}: ${values[0]}`
            : `- ${label}: ${values.map((value, index) => `${headers[index + 1]} ${value}`).join(" ／ ")}`,
        ),
      ];
    }),
    ...output.comparison_with_first.map(
      (item) =>
        `「${output.scenarios[0].name}」と比べた差 「${item.name}」: ${needDifferenceText(item)}`,
    ),
  ];
}

const DISPLAY_ORDER = [
  "simulate_cashflow",
  "kougaku_gendo",
  "meal_cost",
  "calc_date",
];

// 起点と同じ日までを数えただけの日付計算は、読む人に何も伝えないので表に出さない。
function isTrivialDate(calculation: Money["calculations"][number]): boolean {
  return (
    calculation.name === "calc_date" &&
    calculation.output.steps.length === 0 &&
    calculation.output.until?.days_after_start === 0
  );
}

// 先に答え（手元に要る額）、次に内訳の順に並べる。
export function inDisplayOrder(
  calculations: Money["calculations"],
): Money["calculations"] {
  return calculations
    .filter((calculation) => !isTrivialDate(calculation))
    .sort(
      (a, b) => DISPLAY_ORDER.indexOf(a.name) - DISPLAY_ORDER.indexOf(b.name),
    );
}

export function moneyToText(money: Money, text: string): string {
  const calculations = inDisplayOrder(money.calculations);
  const tables = calculations.flatMap((calculation) => {
    switch (calculation.name) {
      case "kougaku_gendo":
        return kougakuText(calculation.output);
      case "meal_cost":
        return mealText(calculation.output);
      case "calc_date":
        return dateText(calculation.output);
      case "simulate_cashflow":
        return cashflowText(calculation.output);
    }
  });
  const notIncluded = [
    ...new Set(
      calculations.flatMap((calculation) =>
        calculation.name === "kougaku_gendo"
          ? calculation.output.not_included
          : [],
      ),
    ),
  ];
  const assumptions = [
    ...new Set(
      calculations.flatMap((calculation) => {
        if (calculation.name === "kougaku_gendo")
          return calculation.output.assumptions;
        if (calculation.name === "meal_cost") return calculation.output.notes;
        return [];
      }),
    ),
  ];
  const sources = moneySources(money, text);
  return [
    "表の金額と日付は、プログラムが計算したものです。",
    ...tables,
    ...(notIncluded.length > 0
      ? ["この額に含まれない費用", ...notIncluded.map((line) => `- ${line}`)]
      : []),
    ...(assumptions.length > 0
      ? ["前提", ...assumptions.map((line) => `- ${line}`)]
      : []),
    ...sourceLines(sources),
  ].join("\n");
}
