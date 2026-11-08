import { z } from "zod";

// 道具の結果の形。カードに付けて画面・保存・持ち出しに使うので、読むときに形を確かめる。
// 値の正しさは計算関数が責任を持つ。ここで見るのは、壊れた保存データで画面が落ちないことだけ。

const sourceSchema = z.object({
  name: z.string(),
  url: z.string(),
  checked_on: z.string(),
});

const kougakuAmountsSchema = z.object({
  total_medical_cost: z.number(),
  copay_without_cap: z.number(),
  cap: z.number(),
  pay_with_cap: z.number(),
  refund_later: z.number(),
  cap_reduces_payment: z.boolean(),
});

export const kougakuOutputSchema = z.object({
  treatment_month: z.string(),
  table_period: z.object({ from_month: z.string(), to_month: z.string() }),
  copay_percent: z.number(),
  cases: z.array(
    z.object({
      category: z.string(),
      condition: z.string(),
      formula: z.object({
        base: z.number(),
        threshold: z.number().nullable(),
        rate_percent: z.number(),
      }),
      low: kougakuAmountsSchema,
      high: kougakuAmountsSchema,
    }),
  ),
  range_if_category_unknown: z
    .object({ pay_with_cap_low: z.number(), pay_with_cap_high: z.number() })
    .nullable(),
  assumptions: z.array(z.string()),
  not_included: z.array(z.string()),
  sources: z.array(sourceSchema),
});

const mealEstimateSchema = z.object({
  days: z.number(),
  meals_max: z.number(),
  cost_max: z.number(),
});

export const mealOutputSchema = z.object({
  yen_per_meal: z.number(),
  meals_per_day_max: z.number(),
  low: mealEstimateSchema,
  high: mealEstimateSchema,
  notes: z.array(z.string()),
  sources: z.array(sourceSchema),
});

export const calcDateOutputSchema = z.object({
  start: z.object({ date: z.string(), weekday: z.string() }),
  steps: z.array(
    z.object({
      label: z.string(),
      unit: z.string(),
      count: z.number(),
      date: z.string(),
      weekday: z.string(),
      skipped_non_business_days: z.array(
        z.object({ date: z.string(), reason: z.string() }),
      ),
    }),
  ),
  until: z
    .object({
      date: z.string(),
      weekday: z.string(),
      days_after_start: z.number(),
      days_inclusive: z.number().nullable(),
    })
    .nullable(),
  business_day_rule: z.string().nullable(),
  sources: z.array(sourceSchema),
});

const ledgerRowSchema = z.object({
  date: z.string(),
  weekday: z.string(),
  label: z.string(),
  direction: z.string(),
  amount: z.number(),
  certainty: z.string(),
  cumulative_net: z.number(),
  balance: z.number().nullable(),
});

const ledgerPathSchema = z.object({
  need: z.number(),
  need_date: z.string().nullable(),
  shortfall: z.number().nullable(),
  first_shortfall_date: z.string().nullable(),
  end_balance: z.number().nullable(),
  rows: z.array(ledgerRowSchema),
});

// 「まず確かめる 1 つ」の順位。値は lib/money/confirm.ts が入力の幅だけから計算する。
export const whatToConfirmSchema = z.object({
  need_low: z.number(),
  need_high: z.number(),
  width: z.number(),
  shortfall_low: z.number().nullable(),
  shortfall_high: z.number().nullable(),
  combinations: z.number(),
  omitted_factors: z.number(),
  factors: z.array(
    z.object({
      kind: z.enum(["scenario", "amount", "income"]),
      name: z.string(),
      label: z.string().nullable(),
      branches: z.array(
        z.object({
          name: z.string(),
          need_low: z.number(),
          need_high: z.number(),
        }),
      ),
      width_if_resolved: z.number(),
      shrink: z.number(),
    }),
  ),
  reading_guide: z.array(z.string()),
});

export const cashflowOutputSchema = z.object({
  start_date: z.string(),
  cash_on_hand: z.number().nullable(),
  scenarios: z.array(
    z.object({
      name: z.string(),
      low_case: ledgerPathSchema,
      high_case: ledgerPathSchema,
      high_case_without_unconfirmed_income: ledgerPathSchema,
      totals: z.object({
        out_low: z.number(),
        out_high: z.number(),
        in_low: z.number(),
        in_high: z.number(),
        unconfirmed_in_high: z.number(),
      }),
    }),
  ),
  comparison_with_first: z.array(
    z.object({
      name: z.string(),
      need_low_difference: z.number(),
      need_high_difference: z.number(),
    }),
  ),
  reading_guide: z.array(z.string()),
  // 順位を足す前に保存したデータにも無いので、無くても読む。
  what_to_confirm: whatToConfirmSchema.optional(),
});

export const TOOL_NAMES = [
  "kougaku_gendo",
  "meal_cost",
  "calc_date",
  "simulate_cashflow",
] as const;

const toolInputSchema = z.record(z.string(), z.unknown());

// 1 枚のカードに付ける計算の上限。多すぎるとカードが読めず、保存も重くなる。
// 月をまたぐ入院で隣の区分も並べると、内訳だけで 6 件になる（11/8 の実 API の評価）。日付・食事代・見通しを足しても収まる数。
export const MAX_CALCULATIONS = 12;

export const calculationSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("kougaku_gendo"),
    input: toolInputSchema,
    output: kougakuOutputSchema,
  }),
  z.object({
    name: z.literal("meal_cost"),
    input: toolInputSchema,
    output: mealOutputSchema,
  }),
  z.object({
    name: z.literal("calc_date"),
    input: toolInputSchema,
    output: calcDateOutputSchema,
  }),
  z.object({
    name: z.literal("simulate_cashflow"),
    input: toolInputSchema,
    output: cashflowOutputSchema,
  }),
]);

export const moneySchema = z.object({
  calculations: z.array(calculationSchema).min(1).max(MAX_CALCULATIONS),
  // 内訳を計算し直したあとに見通しを計算し直せなかったとき、残っている見通しは前の条件での計算（#77）。
  // 見通しの計算し直しが成功した回でだけ外れる（それまでは回をまたいで引き継ぐ）。
  stale_cashflow: z.literal(true).optional(),
});

// サーバーへ送るときは入力だけにする。結果はサーバーが計算し直せるので、送らない。
export const moneyRequestSchema = z.object({
  calculations: z
    .array(z.object({ name: z.enum(TOOL_NAMES), input: toolInputSchema }))
    .max(MAX_CALCULATIONS),
  // 前の回の印。サーバーが引き継ぎ、照合の根拠から古い見通しを外すために送る（#77）。
  stale_cashflow: z.literal(true).optional(),
});

export const MAX_WARNINGS = 20;

export const warningSchema = z.object({
  kind: z.enum(["amount", "date", "card", "calc"]),
  shown: z.string().max(2000),
  message: z.string().max(2400),
});

export type KougakuOutput = z.infer<typeof kougakuOutputSchema>;
export type MealOutput = z.infer<typeof mealOutputSchema>;
export type CalcDateOutput = z.infer<typeof calcDateOutputSchema>;
export type CashflowOutput = z.infer<typeof cashflowOutputSchema>;
export type WhatToConfirm = z.infer<typeof whatToConfirmSchema>;
export type ToolName = (typeof TOOL_NAMES)[number];
export type Calculation = z.infer<typeof calculationSchema>;
export type Money = z.infer<typeof moneySchema>;
export type MoneyWarning = z.infer<typeof warningSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type CalculationRef = z.infer<
  typeof moneyRequestSchema
>["calculations"][number];
