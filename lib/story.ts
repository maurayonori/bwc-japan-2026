// 大会のストーリー（ADR 0016）の文書で使う統計と、その出典。画面では使わない。
// README・仕様・提出文・台本に書く件数と額は、ここから作り、tests/example.test.ts が文書と照合する。
// 値を変えるときは、出典を開いて確かめてから書く。記憶や推測で書かない。

export const STORY_CHECKED_ON = "2026-11-07";

// 全国健康保険協会「令和7年度事業報告書（協会けんぽ2025）」p.17（PDF の 22 枚目）「（3）現金給付の動向」。
// 事業期間は 2025 年 4 月 1 日〜2026 年 3 月 31 日。2026-11-07 に PDF を取得して本文を読んだ。
export const KYOKAI_FY2025 = {
  // 高額療養費（償還払い）: 104万2千件、283億円
  refund: { cases: 1_042_000, yen: 28_300_000_000 },
  // 現物給付による高額療養費: 460万5千件、6,628億円
  inKind: { cases: 4_605_000, yen: 662_800_000_000 },
  source: {
    name: "全国健康保険協会 令和7年度事業報告書 p.17",
    url: "https://www.mhlw.go.jp/content/12400000/001748917.pdf#page=22",
    checked_on: STORY_CHECKED_ON,
  },
} as const;

// 規模感の試算の件数。達成予測ではない。
export const SCALE_CASES = 100;

// 協会けんぽ よくある質問（払い戻しまでの期間）。lib/money/facts.ts の F05 と同じページ。
export const REFUND_TIMING_SOURCE = {
  name: "全国健康保険協会 よくある質問",
  url: "https://www.kyoukaikenpo.or.jp/faq/benefit/004/index.html",
  quote: "診療月から3か月以上かかります",
  checked_on: STORY_CHECKED_ON,
} as const;

// 文書で引く調査の数字（docs/research/hospital-money-facts-20261105.md で 2026-11-07 に本文と照合済み）。
export const SURVEYS = {
  jili2025: {
    hospitalized: 675, // 人。過去 5 年に入院した人
    capAtDeskPercent: 49.6,
    refundLaterPercent: 17.9,
    averageCostMan: 18.7, // 万円。自己負担費用の平均
    url: "https://www.jili.or.jp/files/research/chousa/pdf/r7/2025honshi_all-.pdf",
  },
  tokyo2014: {
    respondents: 831, // 人
    topDifficultyPercent: 34.5,
    url: "https://www.gan-portal.metro.tokyo.lg.jp/uploads/01_260527_gaiyou.pdf",
  },
} as const;

// 「104 万 2 千件」のように書く（万未満の千の位まで）。
export function casesText(cases: number): string {
  const man = Math.floor(cases / 10_000);
  const sen = Math.round((cases % 10_000) / 1_000);
  return `${man} 万${sen > 0 ? ` ${sen} 千` : ""}件`;
}

// 「283 億円」「6,628 億円」のように書く。
export function okuText(yen: number): string {
  return `${new Intl.NumberFormat("ja-JP").format(yen / 100_000_000)} 億円`;
}

// 償還払いの 1 件あたりの額を、0.1 万円の単位にならした値（「約 2.7 万円」）。
export function refundPerCaseText(): string {
  const { cases, yen } = KYOKAI_FY2025.refund;
  return `約 ${(Math.round(yen / cases / 1_000) / 10).toFixed(1)} 万円`;
}

// 「約 1,491 万円」のように、万円の単位に丸めて書く。
export function aboutManText(yen: number): string {
  return `約 ${new Intl.NumberFormat("ja-JP").format(Math.round(yen / 10_000))} 万円`;
}
