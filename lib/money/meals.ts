import { MEAL_COPAY } from "./rules";
import type { MealOutput } from "./schema";
import { InputError, requireInteger } from "./validate";

const MAX_DAYS = 366;

const NOTES = [
  "1 日 3 食で数えた、多めの見積もり。入院する日と退院する日は 3 食にならないことが多い。",
  `一般の区分の額（${MEAL_COPAY.from_date} 以降）。住民税非課税の世帯や、難病・小児慢性特定疾病の患者は、これより低い。`,
  "食事代は高額療養費の対象外で、上限の計算には入らない。",
];

export interface MealInput {
  days_low: number;
  days_high: number;
}

function estimate(days: number) {
  const mealsMax = days * MEAL_COPAY.meals_per_day_max;
  return {
    days,
    meals_max: mealsMax,
    cost_max: mealsMax * MEAL_COPAY.yen_per_meal,
  };
}

// 入院中の食事代を、入院日数（入院する日と退院する日を含む）から多めに見積もる。
export function mealCost(input: MealInput): MealOutput {
  requireInteger(input.days_low, "入院日数の下限", 1, MAX_DAYS);
  requireInteger(input.days_high, "入院日数の上限", 1, MAX_DAYS);
  if (input.days_low > input.days_high)
    throw new InputError("入院日数は、下限を上限以下にしてください。");

  return {
    yen_per_meal: MEAL_COPAY.yen_per_meal,
    meals_per_day_max: MEAL_COPAY.meals_per_day_max,
    low: estimate(input.days_low),
    high: estimate(input.days_high),
    notes: NOTES,
    sources: MEAL_COPAY.sources,
  };
}
