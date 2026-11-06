import { addDays, addMonths, daysBetween, weekdayOf } from "./dates";
import { BUSINESS_DAYS } from "./rules";
import type { CalcDateOutput } from "./schema";
import {
  InputError,
  requireDate,
  requireInteger,
  requireList,
  requireObject,
  requireOneOf,
  requireText,
} from "./validate";

const UNITS = ["day", "week", "business_day", "month"] as const;
const MAX_STEPS = 12;
const MAX_COUNT = 1000;
const MAX_LABEL_LENGTH = 60;
const BUSINESS_DAY_RULE =
  "営業日は、土日・祝日・12/31〜1/3 を除いて数えた（銀行の休日と同じ）。病院・保険会社・保険者の休業日は、これと違うことがある。";

export interface DateStep {
  label: string;
  unit: string;
  count: number;
}

export interface CalcDateInput {
  start_date: string;
  steps: DateStep[];
  until_date: string | null;
}

interface SkippedDay {
  date: string;
  reason: string;
}

function requireCovered(date: string): void {
  if (date < BUSINESS_DAYS.coverage_from || date > BUSINESS_DAYS.coverage_to) {
    throw new InputError(
      `営業日の計算は、${BUSINESS_DAYS.coverage_from} 〜 ${BUSINESS_DAYS.coverage_to} だけに対応しています。`,
    );
  }
}

// 営業日でない理由を返す。営業日なら null。
function nonBusinessReason(date: string): string | null {
  requireCovered(date);
  const holiday = BUSINESS_DAYS.holidays[date];
  if (holiday) return `祝日（${holiday}）`;
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (
    BUSINESS_DAYS.year_end_closure.some(
      (closed) => closed.month === month && closed.day === day,
    )
  ) {
    return "年末年始（12/31〜1/3）";
  }
  const weekday = weekdayOf(date);
  if (weekday === "土" || weekday === "日") return `${weekday}曜日`;
  return null;
}

// 翌日から数えて count 営業日目と、そのあいだに飛ばした休みを返す。
// count が 0 のときは、その日が営業日ならその日、休みなら次の営業日。
function walkBusinessDays(
  date: string,
  count: number,
): { date: string; skipped: SkippedDay[] } {
  const skipped: SkippedDay[] = [];
  let current = date;
  let remaining = count;
  if (count === 0) {
    for (
      let reason = nonBusinessReason(current);
      reason;
      reason = nonBusinessReason(current)
    ) {
      skipped.push({ date: current, reason });
      current = addDays(current, 1);
    }
    return { date: current, skipped };
  }
  while (remaining > 0) {
    current = addDays(current, 1);
    const reason = nonBusinessReason(current);
    if (reason) skipped.push({ date: current, reason });
    else remaining -= 1;
  }
  return { date: current, skipped };
}

export function isBusinessDay(date: string): boolean {
  return nonBusinessReason(date) === null;
}

export function nthBusinessDayAfter(date: string, count: number): string {
  return walkBusinessDays(date, count).date;
}

function applyStep(
  date: string,
  step: DateStep,
): { date: string; skipped: SkippedDay[] } {
  requireObject(step, "段取り");
  requireText(step.label, "段取りの名前", MAX_LABEL_LENGTH);
  requireOneOf(step.unit, UNITS, "段取りの単位");
  requireInteger(
    step.count,
    "段取りの数",
    step.unit === "business_day" ? 0 : -MAX_COUNT,
    MAX_COUNT,
  );

  if (step.unit === "business_day") return walkBusinessDays(date, step.count);
  if (step.unit === "month")
    return { date: addMonths(date, step.count), skipped: [] };
  return {
    date: addDays(date, step.unit === "week" ? step.count * 7 : step.count),
    skipped: [],
  };
}

// 始まりの日から、段取りを順につないで日付を出す。各段取りは、前の段取りの日付から数える。
// until_date を渡すと、始まりの日からその日までの日数も返す。
export function calcDate(input: CalcDateInput): CalcDateOutput {
  requireDate(input.start_date, "始まりの日");
  requireList(input.steps, "段取り", 0, MAX_STEPS);
  if (input.until_date !== null) requireDate(input.until_date, "比べる日");

  const steps: CalcDateOutput["steps"] = [];
  let current = input.start_date;
  for (const step of input.steps) {
    const { date, skipped } = applyStep(current, step);
    steps.push({
      label: step.label,
      unit: step.unit,
      count: step.count,
      date,
      weekday: weekdayOf(date),
      skipped_non_business_days: skipped,
    });
    current = date;
  }

  const usesBusinessDays = input.steps.some(
    (step) => step.unit === "business_day",
  );
  const daysAfterStart =
    input.until_date === null
      ? null
      : daysBetween(input.start_date, input.until_date);

  return {
    start: { date: input.start_date, weekday: weekdayOf(input.start_date) },
    steps,
    until:
      input.until_date === null || daysAfterStart === null
        ? null
        : {
            date: input.until_date,
            weekday: weekdayOf(input.until_date),
            days_after_start: daysAfterStart,
            days_inclusive: daysAfterStart >= 0 ? daysAfterStart + 1 : null,
          },
    business_day_rule: usesBusinessDays ? BUSINESS_DAY_RULE : null,
    sources: usesBusinessDays ? BUSINESS_DAYS.sources : [],
  };
}
