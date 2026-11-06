// 日付は 'YYYY-MM-DD' の文字列で持ち、計算は UTC の通し日で行う。端末のタイムゾーンに左右されない。

const DAY_MS = 86_400_000;
const JAPAN_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function parts(date: string): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new TypeError("日付の形が正しくありません。");
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function toDayNumber(date: string): number {
  const { year, month, day } = parts(date);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function fromDayNumber(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  return fromDayNumber(toDayNumber(value)) === value;
}

export function addDays(date: string, count: number): string {
  return fromDayNumber(toDayNumber(date) + count);
}

export function daysBetween(from: string, to: string): number {
  return toDayNumber(to) - toDayNumber(from);
}

export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(toDayNumber(date) * DAY_MS).getUTCDay()];
}

// 行き先の月に同じ日が無いとき（31 日 → 2 月など）は、その月の末日にする。
export function addMonths(date: string, count: number): string {
  const { year, month, day } = parts(date);
  const lastDay = new Date(
    Date.UTC(year, month - 1 + count + 1, 0),
  ).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + count, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

export function todayInJapan(now: Date = new Date()): string {
  return new Date(now.getTime() + JAPAN_OFFSET_MS).toISOString().slice(0, 10);
}
