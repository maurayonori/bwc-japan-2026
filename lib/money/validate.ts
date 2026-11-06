import { isDateString } from "./dates";

// 道具（tool）の入力が受け付けられないときに投げる。
// message は日本語で書く。そのままモデルへ返り、モデルが呼び方を直す手がかりになる。
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export const MAX_YEN = 1_000_000_000;

export function requireYen(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_YEN
  ) {
    throw new InputError(
      `${name}は、0 以上 10 億以下の整数（円）で指定してください。`,
    );
  }
  return value;
}

export function requireYenRange(
  low: unknown,
  high: unknown,
  name: string,
): void {
  const lowYen = requireYen(low, `${name}の下限`);
  const highYen = requireYen(high, `${name}の上限`);
  if (lowYen > highYen)
    throw new InputError(`${name}は、下限を上限以下にしてください。`);
}

export function requireInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new InputError(
      `${name}は、${min} 以上 ${max} 以下の整数で指定してください。`,
    );
  }
  return value;
}

export function requireDate(value: unknown, name: string): string {
  if (!isDateString(value)) {
    throw new InputError(
      `${name}は、実在する日付を YYYY-MM-DD の形で指定してください。`,
    );
  }
  return value;
}

export function requireOneOf<T>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new InputError(
      `${name}は、${allowed.join("・")} のどれかで指定してください。`,
    );
  }
  return value as T;
}

export function requireText(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maxLength
  ) {
    throw new InputError(
      `${name}は、1 文字以上 ${maxLength} 文字以下で指定してください。`,
    );
  }
  return value;
}

export function requireList(
  value: unknown,
  name: string,
  minLength: number,
  maxLength: number,
): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minLength ||
    value.length > maxLength
  ) {
    throw new InputError(
      `${name}は、${minLength} 個以上 ${maxLength} 個以下で指定してください。`,
    );
  }
  return value;
}

export function requireObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(`${name}の形が正しくありません。`);
  }
  return value as Record<string, unknown>;
}

// 0 以上の整数どうしの割り算。ちょうど半分（50 銭）は切り上げる。
export function divideRoundHalfUp(
  numerator: number,
  denominator: number,
): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
