// プログラムの計算結果（道具の出力）を、表にして見せる。
// ここに出る金額と日付は、すべてサーバーの計算結果。Claude が書いた数字は入らない。

import {
  card,
  el,
  foldout,
  list,
  showDate,
  signedYen,
  sourceLine,
  table,
  yen,
  yenRange,
} from "./dom.js";

const READING_GUIDE = [
  "「少なめの場合」は、支払いを少なめ・入金を多めに置いたとき。「多めの場合」は、支払いを多め・入金を少なめに置いたとき。",
  "幅は、置いた仮定の下限と上限です。確率ではありません。",
  "「手元に要る額」は、その日までの支払いをまかなうために、起点の日に手元に要る額です。あとから入るお金では、先に来る支払いは埋まりません。",
  "確かめていない入金は、手元のお金として数えない場合も並べています。",
  "同じ日の入金と支払いは、支払いを先に置いています。",
];

const CERTAINTY_TEXT = {
  confirmed: "確かめた額",
  estimate: "見積もり",
  assumption: "仮定",
};
const DIRECTION_TEXT = { out: "払う", in: "入る" };
const UNIT_TEXT = {
  day: "日",
  week: "週間",
  business_day: "営業日",
  month: "か月",
};
const COPAY_TEXT = { 30: "3 割", 20: "2 割" };
const WEEKEND_REASONS = ["土曜日", "日曜日"];
const MAX_SKIPPED_SHOWN = 6;
const CARD_FAILED = "この計算結果は、画面に表示できませんでした。";

// ---- 高額療養費 ----

function formulaText(formula) {
  return formula.threshold === null
    ? `上限は定額: ${yen(formula.base)}`
    : `上限の式: ${yen(formula.base)} ＋（医療費の総額 − ${yen(formula.threshold)}）× ${formula.rate_percent}%`;
}

function kougakuSingle(item) {
  const same = JSON.stringify(item.low) === JSON.stringify(item.high);
  const columns = same ? [item.low] : [item.low, item.high];
  const rows = [
    ["医療費の総額（10 割）", "total_medical_cost"],
    ["上限が無いときの窓口負担", "copay_without_cap"],
    ["1 か月の上限額", "cap"],
    ["窓口で払う額（上限が適用されるとき）", "pay_with_cap"],
    ["いったん全額を払ったとき、あとで戻る額", "refund_later"],
  ].map(([label, key]) => [
    label,
    ...columns.map((column) => yen(column[key])),
  ]);
  return [
    el("p", {
      class: "card-lead",
      text: `区分${item.category}（${item.condition}）`,
    }),
    table(
      same ? ["", "金額"] : ["", "見積もりが少なめのとき", "多めのとき"],
      rows,
    ),
    el("p", { class: "muted", text: formulaText(item.formula) }),
    ...(columns.some((column) => !column.cap_reduces_payment)
      ? [
          el("p", {
            class: "muted",
            text: "窓口負担が上限額より小さいときは、上限による軽減はなく、そのままの額を払います。",
          }),
        ]
      : []),
  ];
}

function kougakuAll(output) {
  const [first] = output.cases;
  const range = output.range_if_category_unknown;
  const rows = output.cases.map((item) => [
    `区分${item.category}`,
    item.condition,
    yenRange(item.low.cap, item.high.cap),
    yenRange(item.low.pay_with_cap, item.high.pay_with_cap),
  ]);
  const copay = yenRange(
    first.low.copay_without_cap,
    first.high.copay_without_cap,
  );
  return [
    el("p", {
      class: "card-lead",
      text: `所得の区分が分からないので、5 つの区分を並べています。上限が無いときの窓口負担は ${copay}。`,
    }),
    table(
      [
        "区分",
        "条件",
        "1 か月の上限額",
        "窓口で払う額（上限が適用されるとき）",
      ],
      rows,
    ),
    ...(range
      ? [
          el("p", {
            text: `区分が分かるまでの幅: ${yenRange(range.pay_with_cap_low, range.pay_with_cap_high)}`,
          }),
        ]
      : []),
  ];
}

function kougakuCard(output) {
  const [year, month] = output.treatment_month.split("-").map(Number);
  const copay = COPAY_TEXT[output.copay_percent] ?? `${output.copay_percent}%`;
  return card(
    "高額療養費の上限",
    `${year} 年 ${month} 月の診療分・窓口負担 ${copay}・保険診療分だけ`,
    [
      ...(output.cases.length === 1
        ? kougakuSingle(output.cases[0])
        : kougakuAll(output)),
      foldout("前提と、含まれない費用", [
        list(output.assumptions),
        el("p", { class: "fold-label", text: "この額に含まれない費用" }),
        list(output.not_included),
      ]),
      sourceLine(output.sources),
    ],
  );
}

// ---- 食事代 ----

function mealCard(output) {
  const cases =
    output.low.days === output.high.days
      ? [output.low]
      : [output.low, output.high];
  return card("入院中の食事代", "1 日 3 食で数えた、多めの見積もり", [
    list(
      cases.map(
        (item) =>
          `${item.days} 日間: ${yen(output.yen_per_meal)} × ${item.meals_max} 食 ＝ ${yen(item.cost_max)}`,
      ),
    ),
    foldout("前提", [list(output.notes)]),
    sourceLine(output.sources),
  ]);
}

// ---- 日付 ----

function stepText(step) {
  if (step.count === 0) {
    return step.unit === "business_day" ? "当日（休みなら次の営業日）" : "当日";
  }
  const unit = UNIT_TEXT[step.unit] ?? step.unit;
  return `${Math.abs(step.count)} ${unit}${step.count > 0 ? "後" : "前"}`;
}

// 土日は日数だけ、祝日と年末年始は日付と理由を出す。
function skippedText(skipped) {
  const weekends = skipped.filter((day) =>
    WEEKEND_REASONS.includes(day.reason),
  );
  const others = skipped.filter((day) => !WEEKEND_REASONS.includes(day.reason));
  const shown = others
    .slice(0, MAX_SKIPPED_SHOWN)
    .map((day) => `${showDate(day.date)} ${day.reason}`);
  const parts = [
    ...(weekends.length > 0 ? [`土日 ${weekends.length} 日`] : []),
    ...shown,
    ...(others.length > shown.length
      ? [`ほか ${others.length - shown.length} 日`]
      : []),
  ];
  return `数えなかった日: ${parts.join("、")}`;
}

function dateCard(output) {
  const steps = output.steps.map((step) =>
    el("li", {}, [
      el("span", { class: "step-label", text: step.label }),
      `: ${stepText(step)} → `,
      el("strong", { text: showDate(step.date) }),
      ...(step.skipped_non_business_days.length > 0
        ? [
            el("span", {
              class: "muted block",
              text: skippedText(step.skipped_non_business_days),
            }),
          ]
        : []),
    ]),
  );
  const chained =
    steps.length > 1 ? "。上から順に、前の行の日付から数えています。" : "";
  const until = output.until;
  return card("日付の計算", `起点: ${showDate(output.start.date)}${chained}`, [
    ...(steps.length > 0 ? [el("ol", { class: "steps" }, steps)] : []),
    ...(until
      ? [
          el("p", {
            text: `起点から ${showDate(until.date)} まで: ${until.days_after_start} 日${until.days_inclusive === null ? "" : `（起点の日を入れると ${until.days_inclusive} 日間）`}`,
          }),
        ]
      : []),
    ...(output.business_day_rule
      ? [el("p", { class: "muted", text: output.business_day_rule })]
      : []),
    sourceLine(output.sources),
  ]);
}

// ---- お金の出入り ----

function pathTable(path, hasCash) {
  const headers = [
    "日付",
    "内容",
    "出入り",
    "金額",
    "確かさ",
    "出入りの累計",
    ...(hasCash ? ["手元の残り"] : []),
  ];
  const rows = path.rows.map((row) => [
    showDate(row.date),
    row.label,
    DIRECTION_TEXT[row.direction] ?? row.direction,
    yen(row.amount),
    CERTAINTY_TEXT[row.certainty] ?? row.certainty,
    yen(row.cumulative_net),
    ...(hasCash ? [yen(row.balance)] : []),
  ]);
  return table(headers, rows);
}

function scenarioBlock(scenario, hasCash) {
  const paths = [
    ["少なめの場合", scenario.low_case],
    ["多めの場合", scenario.high_case],
    ...(scenario.totals.unconfirmed_in_high > 0
      ? [
          [
            "多めの場合で、確かめていない入金を数えない",
            scenario.high_case_without_unconfirmed_income,
          ],
        ]
      : []),
  ];
  const rows = [
    ["手元に要る額", (path) => yen(path.need)],
    ["一番きつくなる日", (path) => showDate(path.need_date)],
    ...(hasCash
      ? [
          ["足りない額", (path) => yen(path.shortfall)],
          [
            "最初に足りなくなる日",
            (path) =>
              path.first_shortfall_date
                ? showDate(path.first_shortfall_date)
                : "なし",
          ],
          ["期間の終わりの手元", (path) => yen(path.end_balance)],
        ]
      : []),
  ].map(([label, read]) => [label, ...paths.map(([, path]) => read(path))]);
  return el("section", { class: "scenario" }, [
    el("h4", { text: scenario.name }),
    table(["", ...paths.map(([label]) => label)], rows),
    foldout(
      "日ごとの出入りを見る",
      paths
        .slice(0, 2)
        .flatMap(([label, path]) => [
          el("p", { class: "fold-label", text: label }),
          pathTable(path, hasCash),
        ]),
    ),
  ]);
}

function comparisonBlock(output) {
  if (output.comparison_with_first.length === 0) return [];
  return [
    el("p", {
      class: "fold-label",
      text: `「${output.scenarios[0].name}」と比べた、手元に要る額の差`,
    }),
    list(
      output.comparison_with_first.map(
        (item) =>
          `${item.name}: 少なめの場合 ${signedYen(item.need_low_difference)}、多めの場合 ${signedYen(item.need_high_difference)}`,
      ),
    ),
  ];
}

function cashflowCard(output) {
  const hasCash = output.cash_on_hand !== null;
  const cash = hasCash
    ? yen(output.cash_on_hand)
    : "聞いていないので、要る額までを出しています";
  return card(
    "お金の出入りの見通し",
    `起点: ${showDate(output.start_date)}。手元のお金: ${cash}`,
    [
      ...output.scenarios.map((scenario) => scenarioBlock(scenario, hasCash)),
      ...comparisonBlock(output),
      foldout("この表の読み方", [list(READING_GUIDE)]),
    ],
  );
}

const CARD_BUILDERS = {
  kougaku_gendo: kougakuCard,
  meal_cost: mealCard,
  calc_date: dateCard,
  simulate_cashflow: cashflowCard,
};

// 道具の実行 1 回ぶんを、カードにする。知らない道具は出さない。
export function toolCard(event) {
  if (!event.ok) {
    return el("p", {
      class: "muted",
      text: `道具が受け付けなかった呼び出しがありました（理由: ${event.error}）`,
    });
  }
  if (!Object.hasOwn(CARD_BUILDERS, event.name)) return null;
  try {
    return CARD_BUILDERS[event.name](event.output);
  } catch (error) {
    // 1 枚の表示の失敗で、返答の全体を消さない。
    console.error(error);
    return el("p", { class: "note error", text: CARD_FAILED });
  }
}
