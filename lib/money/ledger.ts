import { rankUncertainties, type NeedRangeOf } from "./confirm";
import { weekdayOf } from "./dates";
import type { CashflowOutput } from "./schema";
import {
  InputError,
  requireDate,
  requireList,
  requireObject,
  requireOneOf,
  requireText,
  requireYen,
  requireYenRange,
} from "./validate";

const DIRECTIONS = ["out", "in"];
const CERTAINTIES = ["confirmed", "estimate", "assumption"];
const MAX_SCENARIOS = 4;
const MAX_EVENTS = 30;
const MAX_NAME_LENGTH = 60;

const READING_GUIDE = [
  "low_case は、支払いを少なめ・入金を多めに置いた場合。high_case は、支払いを多め・入金を少なめに置いた場合。",
  "high_case_without_unconfirmed_income は、high_case から「確認済み」でない入金を除いた場合。確認できていない入金を、手元のお金として数えないための欄。",
  "need は、その日までの支払いをまかなうために、始まりの日の時点で手元に要る額。入金より先に来る支払いは、あとの入金では埋まらない。",
  "幅は、置いた仮定の下限と上限。確率や信頼区間ではない。",
  "同じ日の入金と支払いは、支払いを先に置いた。",
];

export interface LedgerEvent {
  date: string;
  label: string;
  direction: string;
  amount_low: number;
  amount_high: number;
  certainty: string;
}

export interface LedgerScenario {
  name: string;
  events: LedgerEvent[];
}

export interface CashflowInput {
  start_date: string;
  cash_on_hand: number | null;
  scenarios: LedgerScenario[];
}

type LedgerPath = CashflowOutput["scenarios"][number]["low_case"];
type LedgerRow = LedgerPath["rows"][number];

function requireEvent(event: LedgerEvent, startDate: string): void {
  requireObject(event, "入出金");
  requireDate(event.date, "入出金の日付");
  if (event.date < startDate)
    throw new InputError("見通しを始める日より前の入出金は置けません。");
  requireText(event.label, "入出金の名前", MAX_NAME_LENGTH);
  requireOneOf(event.direction, DIRECTIONS, "入出金の向き");
  requireOneOf(event.certainty, CERTAINTIES, "確かさ");
  requireYenRange(
    event.amount_low,
    event.amount_high,
    `「${event.label}」の金額`,
  );
}

function requireScenarios(
  scenarios: LedgerScenario[],
  startDate: string,
): void {
  requireList(scenarios, "筋書き", 1, MAX_SCENARIOS);
  for (const scenario of scenarios) {
    requireObject(scenario, "筋書き");
    requireText(scenario.name, "筋書きの名前", MAX_NAME_LENGTH);
    requireList(scenario.events, `「${scenario.name}」の入出金`, 1, MAX_EVENTS);
    for (const event of scenario.events) requireEvent(event, startDate);
  }
  const names = scenarios.map((scenario) => scenario.name);
  if (new Set(names).size !== names.length)
    throw new InputError("筋書きの名前は、重ならないようにしてください。");
}

// 日付順。同じ日は支払いを先にする。それ以外は渡された順を保つ。
function inOrder(events: LedgerEvent[]): LedgerEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.date.localeCompare(b.event.date) ||
        DIRECTIONS.indexOf(a.event.direction) -
          DIRECTIONS.indexOf(b.event.direction) ||
        a.index - b.index,
    )
    .map(({ event }) => event);
}

// 支払いと入金のどちらの端を使うかを決めて、1 本の見通しを作る。
function trace(
  events: LedgerEvent[],
  cash: number | null,
  amountOf: (event: LedgerEvent) => number,
): LedgerPath {
  const { rows, minimum, minimumDate } = inOrder(events).reduce(
    (state, event) => {
      const amount = amountOf(event);
      const cumulative =
        state.cumulative + (event.direction === "out" ? -amount : amount);
      const isNewMinimum = cumulative < state.minimum;
      return {
        cumulative,
        minimum: isNewMinimum ? cumulative : state.minimum,
        minimumDate: isNewMinimum ? event.date : state.minimumDate,
        rows: [
          ...state.rows,
          {
            date: event.date,
            weekday: weekdayOf(event.date),
            label: event.label,
            direction: event.direction,
            amount,
            certainty: event.certainty,
            cumulative_net: cumulative,
            balance: cash === null ? null : cash + cumulative,
          },
        ],
      };
    },
    {
      cumulative: 0,
      minimum: 0,
      minimumDate: null as string | null,
      rows: [] as LedgerRow[],
    },
  );

  const need = Math.max(0, -minimum);
  const firstShortfall = rows.find(
    (row) => row.balance !== null && row.balance < 0,
  );
  return {
    need,
    need_date: minimumDate,
    shortfall: cash === null ? null : Math.max(0, need - cash),
    first_shortfall_date: firstShortfall ? firstShortfall.date : null,
    end_balance:
      cash === null
        ? null
        : cash + (rows.length > 0 ? rows[rows.length - 1].cumulative_net : 0),
    rows,
  };
}

const lowAmount = (event: LedgerEvent): number =>
  event.direction === "out" ? event.amount_low : event.amount_high;
const highAmount = (event: LedgerEvent): number =>
  event.direction === "out" ? event.amount_high : event.amount_low;
const isUnconfirmedIncome = (event: LedgerEvent): boolean =>
  event.direction === "in" && event.certainty !== "confirmed";

function sum(
  events: LedgerEvent[],
  direction: string,
  key: "amount_low" | "amount_high",
): number {
  return events
    .filter((event) => event.direction === direction)
    .reduce((total, event) => total + event[key], 0);
}

// 「まず確かめる 1 つ」の順位づけに渡す、要る額の下限と上限。見通しと同じ trace で計算する。
const needRange: NeedRangeOf = (events) => ({
  need_low: trace(events, null, lowAmount).need,
  need_high: trace(events, null, highAmount).need,
});

function simulateScenario(scenario: LedgerScenario, cash: number | null) {
  const { events } = scenario;
  return {
    name: scenario.name,
    low_case: trace(events, cash, lowAmount),
    high_case: trace(events, cash, highAmount),
    high_case_without_unconfirmed_income: trace(
      events.filter((event) => !isUnconfirmedIncome(event)),
      cash,
      highAmount,
    ),
    totals: {
      out_low: sum(events, "out", "amount_low"),
      out_high: sum(events, "out", "amount_high"),
      in_low: sum(events, "in", "amount_low"),
      in_high: sum(events, "in", "amount_high"),
      unconfirmed_in_high: sum(
        events.filter(isUnconfirmedIncome),
        "in",
        "amount_high",
      ),
    },
  };
}

// 入出金を日付順に並べ、手元に要る額・不足する額・不足が始まる日を、筋書きごとに出す。
// 家計簿ではない。渡された入出金だけを比べる。
export function simulateCashflow(input: CashflowInput): CashflowOutput {
  requireDate(input.start_date, "見通しを始める日");
  if (input.cash_on_hand !== null) requireYen(input.cash_on_hand, "手元のお金");
  requireScenarios(input.scenarios, input.start_date);

  const scenarios = input.scenarios.map((scenario) =>
    simulateScenario(scenario, input.cash_on_hand),
  );
  const [first, ...others] = scenarios;

  return {
    start_date: input.start_date,
    cash_on_hand: input.cash_on_hand,
    scenarios,
    comparison_with_first: others.map((scenario) => ({
      name: scenario.name,
      need_low_difference: scenario.low_case.need - first.low_case.need,
      need_high_difference: scenario.high_case.need - first.high_case.need,
    })),
    reading_guide: READING_GUIDE,
    what_to_confirm: rankUncertainties(input, needRange),
  };
}
