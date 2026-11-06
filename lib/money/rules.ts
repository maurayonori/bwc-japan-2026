import { deepFreeze } from "./validate";

// 制度の値。すべて出典の URL と確認日を持つ。
// 値を足す・変えるときは、出典を開いて確かめてから書く。記憶や推測で書かない。

// 高額療養費の自己負担限度額（70 歳未満）。令和 8 年 8 月〜令和 9 年 7 月の診療分。
// 式は「base ＋（総医療費 − threshold）× 1%」。threshold が null の区分は定額。
// 総医療費が threshold に満たないときは、加算を 0 にする（施行令 第 42 条の括弧書き）。
export const KOUGAKU_UNDER_70 = deepFreeze({
  from_month: '2026-08',
  to_month: '2027-07',
  rate_percent: 1,
  categories: [
    { key: 'ア', condition: '標準報酬月額 83 万円以上', base: 270_300, threshold: 901_000 },
    { key: 'イ', condition: '標準報酬月額 53 万〜79 万円', base: 179_100, threshold: 597_000 },
    { key: 'ウ', condition: '標準報酬月額 28 万〜50 万円', base: 85_800, threshold: 286_000 },
    { key: 'エ', condition: '標準報酬月額 26 万円以下', base: 61_500, threshold: null },
    { key: 'オ', condition: '被保険者が住民税の非課税者で、区分ア・イに当たらない', base: 36_900, threshold: null },
  ],
  sources: [
    {
      name: '全国健康保険協会（高額療養費の自己負担限度額の表）',
      url: 'https://www.kyoukaikenpo.or.jp/benefit/high_cost_medical_expenses/002/index.html',
      checked_on: '2026-11-06',
    },
    {
      name: '健康保険法施行令 第 42 条（額と、1 円未満の端数の扱い）',
      url: 'https://laws.e-gov.go.jp/law/215IO0000000243',
      checked_on: '2026-11-06',
    },
  ],
});

// 入院中の食事代（食事療養標準負担額）。一般の区分。
export const MEAL_COPAY = deepFreeze({
  from_date: '2026-06-01',
  yen_per_meal: 550,
  meals_per_day_max: 3,
  sources: [
    {
      name: '全国健康保険協会（入院時食事療養費）',
      url: 'https://www.kyoukaikenpo.or.jp/benefit/mynumber_insurance_card/002/index.html',
      checked_on: '2026-11-06',
    },
  ],
});

// 国民の祝日と休日。内閣府の公表のとおり。
const HOLIDAY_LIST: [string, string][] = [
  ['2026-01-01', '元日'],
  ['2026-01-12', '成人の日'],
  ['2026-02-11', '建国記念の日'],
  ['2026-02-23', '天皇誕生日'],
  ['2026-03-20', '春分の日'],
  ['2026-04-29', '昭和の日'],
  ['2026-05-03', '憲法記念日'],
  ['2026-05-04', 'みどりの日'],
  ['2026-05-05', 'こどもの日'],
  ['2026-05-06', '休日'],
  ['2026-07-20', '海の日'],
  ['2026-08-11', '山の日'],
  ['2026-09-21', '敬老の日'],
  ['2026-09-22', '休日'],
  ['2026-09-23', '秋分の日'],
  ['2026-10-12', 'スポーツの日'],
  ['2026-11-03', '文化の日'],
  ['2026-11-23', '勤労感謝の日'],
  ['2027-01-01', '元日'],
  ['2027-01-11', '成人の日'],
  ['2027-02-11', '建国記念の日'],
  ['2027-02-23', '天皇誕生日'],
  ['2027-03-21', '春分の日'],
  ['2027-03-22', '休日'],
  ['2027-04-29', '昭和の日'],
  ['2027-05-03', '憲法記念日'],
  ['2027-05-04', 'みどりの日'],
  ['2027-05-05', 'こどもの日'],
  ['2027-07-19', '海の日'],
  ['2027-08-11', '山の日'],
  ['2027-09-20', '敬老の日'],
  ['2027-09-23', '秋分の日'],
  ['2027-10-11', 'スポーツの日'],
  ['2027-11-03', '文化の日'],
  ['2027-11-23', '勤労感謝の日'],
];

// 営業日の数え方。土日・祝日・12/31〜1/3 を除く（銀行の休日と同じ）。
// 病院・保険会社・保険者の休業日は、これと違うことがある。
export const BUSINESS_DAYS = deepFreeze({
  coverage_from: '2026-01-01',
  coverage_to: '2027-12-31',
  holidays: Object.fromEntries(HOLIDAY_LIST),
  year_end_closure: [
    { month: 12, day: 31 },
    { month: 1, day: 1 },
    { month: 1, day: 2 },
    { month: 1, day: 3 },
  ],
  sources: [
    {
      name: '内閣府「国民の祝日について」',
      url: 'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html',
      checked_on: '2026-11-06',
    },
    {
      name: '銀行法施行令 第 5 条（銀行の休日）',
      url: 'https://laws.e-gov.go.jp/law/357CO0000000040',
      checked_on: '2026-11-06',
    },
  ],
});
