import { KOUGAKU_UNDER_70 } from './rules.mjs';
import { InputError, divideRoundHalfUp, requireOneOf, requireYenRange } from './validate.mjs';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const UNKNOWN_CATEGORY = '不明';
const CATEGORY_KEYS = KOUGAKU_UNDER_70.categories.map((category) => category.key);

const ASSUMPTIONS = [
  '70 歳未満の人の、1 か月（1 日〜末日）・1 つの医療機関・入院の保険診療分。',
  '全国健康保険協会（協会けんぽ）の表による。国民健康保険やほかの健康保険組合は、区分の決まり方や上乗せの給付が違うことがある。',
  '過去 12 か月に 3 回以上の支給がある場合の引き下げ（多数回該当）、世帯での合算、年間の上限は入れていない。',
  '月をまたぐ入院は、月ごとに分けて計算される。この結果は 1 か月ぶん。',
  '窓口負担の額は概算。実際の請求額とは、端数などで少し違うことがある。',
];

const NOT_INCLUDED = [
  '入院中の食事代（1 食ごとの定額。高額療養費の対象外）',
  '差額ベッド代、病衣・テレビなどのレンタル、診断書などの文書料（保険の対象外）',
];

function requireMonth(month) {
  if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
    throw new InputError('診療月は、YYYY-MM の形で指定してください。');
  }
  if (month < KOUGAKU_UNDER_70.from_month || month > KOUGAKU_UNDER_70.to_month) {
    throw new InputError(
      `この試作が持っている表は、${KOUGAKU_UNDER_70.from_month} 〜 ${KOUGAKU_UNDER_70.to_month} の診療分だけです。その月は計算できません。`,
    );
  }
}

// 総医療費（10 割）を、分数 numerator / denominator で持つ。
// 3 割負担の概算から逆算すると割り切れないことがあるので、丸めるのは最後にする。
function totalAsFraction(amount, basis, copayPercent) {
  return basis === 'total'
    ? { numerator: amount, denominator: 1 }
    : { numerator: amount * 100, denominator: copayPercent };
}

function calculate(category, amount, basis, copayPercent) {
  const { numerator, denominator } = totalAsFraction(amount, basis, copayPercent);
  const overThreshold = category.threshold === null
    ? 0
    : Math.max(0, numerator - category.threshold * denominator);
  const cap = category.base
    + divideRoundHalfUp(overThreshold * KOUGAKU_UNDER_70.rate_percent, 100 * denominator);
  const copayWithoutCap = divideRoundHalfUp(numerator * copayPercent, 100 * denominator);
  const payWithCap = Math.min(copayWithoutCap, cap);
  return {
    total_medical_cost: divideRoundHalfUp(numerator, denominator),
    copay_without_cap: copayWithoutCap,
    cap,
    pay_with_cap: payWithCap,
    refund_later: copayWithoutCap - payWithCap,
    cap_reduces_payment: copayWithoutCap > cap,
  };
}

// 高額療養費の自己負担限度額と、窓口で払う額を計算する。
// 窓口で上限が適用される場合（pay_with_cap）と、適用されずにいったん払う場合（copay_without_cap）を並べる。
export function kougakuGendo(input) {
  requireMonth(input.treatment_month);
  requireOneOf(input.income_category, [...CATEGORY_KEYS, UNKNOWN_CATEGORY], '所得区分');
  requireOneOf(input.amount_basis, ['total', 'copay'], '金額の種類');
  requireOneOf(input.copay_percent, [30, 20], '窓口負担の割合');
  requireYenRange(input.amount_low, input.amount_high, '金額');

  const categories = input.income_category === UNKNOWN_CATEGORY
    ? KOUGAKU_UNDER_70.categories
    : KOUGAKU_UNDER_70.categories.filter((category) => category.key === input.income_category);

  const cases = categories.map((category) => ({
    category: category.key,
    condition: category.condition,
    // 上限の式。threshold が null の区分は、base の定額。
    formula: { base: category.base, threshold: category.threshold, rate_percent: KOUGAKU_UNDER_70.rate_percent },
    low: calculate(category, input.amount_low, input.amount_basis, input.copay_percent),
    high: calculate(category, input.amount_high, input.amount_basis, input.copay_percent),
  }));

  return {
    treatment_month: input.treatment_month,
    table_period: { from_month: KOUGAKU_UNDER_70.from_month, to_month: KOUGAKU_UNDER_70.to_month },
    copay_percent: input.copay_percent,
    cases,
    range_if_category_unknown: input.income_category === UNKNOWN_CATEGORY
      ? {
        pay_with_cap_low: Math.min(...cases.map((item) => item.low.pay_with_cap)),
        pay_with_cap_high: Math.max(...cases.map((item) => item.high.pay_with_cap)),
      }
      : null,
    assumptions: ASSUMPTIONS,
    not_included: NOT_INCLUDED,
    sources: KOUGAKU_UNDER_70.sources,
  };
}
