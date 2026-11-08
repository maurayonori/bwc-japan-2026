// #85 の残り: 本線の見通しの選び方。数字と会話はすべて架空。
// 1. 利用者が言った追加費用（差額ベッド代など）を足した最新の見通しより、古い試算が本線に選ばれていた。
// 2. 本線に選んだ旧形式の見通し（what_to_confirm が無い）を飛ばして、別の見通しの範囲で正しい額を伏せていた。
// 3. 計算のラベルに書いた金額と日付は、照合の根拠にしない（#78 の再現テストの追加）。
import test from "node:test";
import assert from "node:assert/strict";
import { attachMoney, type ToolEvent } from "../lib/money/attach";
import {
  saidAmounts,
  checkReply,
  fixGapDirection,
  maskUnverified,
} from "../lib/money/guard";
import {
  mainCashflowIndex,
  withMainCashflowLast,
} from "../lib/money/main-cashflow";
import type { Calculation } from "../lib/money/schema";
import { executeTool } from "../lib/money/tools";
import { needRangeOf } from "../lib/views";
import type { Message } from "../lib/workspace";

const TODAY = "2026-11-08";
const SAID_1 =
  "12月14日に入院して、28日に退院する予定です。病院の見積もりだと、医療費は総額で80万円くらい。協会けんぽで、給料は月35万円くらいです。すぐ使えるお金は20万円。";
const SAID_2 = "個室を希望していて、差額ベッド代は全部で2万円と言われました。";
const USER_TEXTS = [SAID_1, SAID_2];
const MESSAGES: Message[] = [
  { id: "u1", role: "user", text: SAID_1 },
  { id: "u2", role: "user", text: SAID_2 },
];

const KOUGAKU = {
  treatment_month: "2026-12",
  income_category: "ウ",
  amount_basis: "total",
  amount_low: 800_000,
  amount_high: 800_000,
  copay_percent: 30,
};
const MEAL = { days_low: 15, days_high: 15 };

// どの筋書きも、合計 1 件の支払いにした見通し。
const oneEach = (cap: number, noCap: number, label: string) => ({
  start_date: TODAY,
  cash_on_hand: 200_000,
  scenarios: [
    {
      name: "窓口で上限が適用される場合",
      events: [
        {
          date: "2026-12-28",
          label,
          direction: "out",
          amount_low: cap,
          amount_high: cap,
          certainty: "estimate",
        },
      ],
    },
    {
      name: "上限が適用されず、いったん3割を払う場合",
      events: [
        {
          date: "2026-12-28",
          label,
          direction: "out",
          amount_low: noCap,
          amount_high: noCap,
          certainty: "estimate",
        },
      ],
    },
  ],
});
// 保険診療 90,940 円＋食事 24,750 円＝115,690 円（上限なしは 240,000＋24,750＝264,750 円）。
const BEFORE = oneEach(115_690, 264_750, "入院費");
// 差額ベッド代 20,000 円込み。
const WITH_ROOM = oneEach(135_690, 284_750, "入院費（差額ベッド代込み）");
const DUMMY = {
  start_date: TODAY,
  cash_on_hand: 200_000,
  scenarios: [
    {
      name: "x",
      events: [
        {
          date: "2026-12-28",
          label: "x",
          direction: "out",
          amount_low: 1,
          amount_high: 1,
          certainty: "assumption",
        },
      ],
    },
  ],
};

function event(name: string, input: unknown): ToolEvent {
  const result = executeTool(name, input);
  assert.equal(result.ok, true, name);
  return {
    name,
    input,
    ok: true,
    output: (result as { output: unknown }).output,
  };
}

// 追加の支出として言った額だけ（差額ベッド代 2 万円）。手元・総額・給料は足さない（PR #94 の Codex①）。
const said = saidAmounts(USER_TEXTS);

test("#85 の残り 1: 利用者が言った差額ベッド代を足した最新の見通しを本線にする", () => {
  const events = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    event("simulate_cashflow", BEFORE),
    event("simulate_cashflow", WITH_ROOM),
  ];
  assert.equal(mainCashflowIndex(events, 0, said), 3);
  // 発言の額が渡されないときは、今までどおり内訳の額だけで照らす。
  assert.equal(mainCashflowIndex(events), 2);

  // カード: 支払日の表は差額ベッド代込みの見通しで出る。
  const { cards } = attachMoney({
    proposals: [],
    events,
    existing: [],
    prior: new Map<string, Calculation[]>(),
    messages: MESSAGES,
  });
  const calculations = cards[0]?.money?.calculations ?? [];
  assert.deepEqual(
    calculations.findLast((item) => item.name === "simulate_cashflow")?.input,
    WITH_ROOM,
  );
  assert.deepEqual(needRangeOf(cards[0] as never), {
    low: 135_690,
    high: 284_750,
  });

  // 検査: 差額ベッド代込みの範囲を伏せない。古い範囲は「いまの計算の範囲と合わない」と伝える。
  const args = {
    toolEvents: events,
    userTexts: USER_TEXTS,
    today: TODAY,
    currentFrom: 0,
  };
  const reply = "手元に要る額は135,690円〜284,750円です。";
  assert.deepEqual(checkReply({ ...args, reply }), []);
  assert.equal(maskUnverified({ ...args, reply }).masked, 0);
  assert.equal(
    checkReply({ ...args, reply: "手元に要る額は115,690円〜264,750円です。" })
      .length,
    1,
  );

  // 足りない額の向きも、差額ベッド代込みの見通しで照らす（284,750 − 200,000 = 84,750 円足りない）。
  const fixed = fixGapDirection(
    "いったん3割を払う場合は 84,750 円足ります。",
    events,
    0,
    USER_TEXTS,
  );
  assert.equal(fixed.replaced, 1);
  assert.match(fixed.text, /84,750 円足りない/);
});

test("#85 の残り 1: 発言の額を足しても、試し呼びは本線にならない（#82）", () => {
  const events = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    event("simulate_cashflow", WITH_ROOM),
    event("simulate_cashflow", DUMMY),
  ];
  assert.equal(mainCashflowIndex(events, 0, said), 2);
  assert.deepEqual(
    withMainCashflowLast(events, said).findLast(
      (item) => item.name === "simulate_cashflow",
    )?.input,
    WITH_ROOM,
  );
});

test("#85 の残り 1: 発言の額を 2 つ足した見通しも本線にする（差額ベッド代 2 万円と家族の交通費 1 万円）", () => {
  const both = oneEach(145_690, 294_750, "入院費（差額ベッド代と交通費込み）");
  const events = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    event("simulate_cashflow", BEFORE),
    event("simulate_cashflow", both),
  ];
  assert.equal(mainCashflowIndex(events, 0, [...said, 10_000]), 3);
  // 誰も言っていない額（30,000 円の差）では推さない。
  assert.equal(mainCashflowIndex(events, 0, said), 2);
});

// 3 つの見通し: 現行 A（内訳あり）、現行 B（160,000〜220,000 円）、旧形式 C（A から what_to_confirm だけを除いたもの）。
function legacyAfterOthers() {
  const b = {
    start_date: TODAY,
    cash_on_hand: 200_000,
    scenarios: [
      {
        name: "病院の見積もり",
        events: [
          {
            date: "2026-12-28",
            label: "退院のときの支払い",
            direction: "out",
            amount_low: 160_000,
            amount_high: 220_000,
            certainty: "estimate",
          },
        ],
      },
    ],
  };
  const a = event("simulate_cashflow", BEFORE);
  const { what_to_confirm: _omit, ...legacy } = a.output as Record<
    string,
    unknown
  >;
  return [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    a,
    event("simulate_cashflow", b),
    { ...a, output: legacy },
  ];
}

test("#90 の残り 2: 旧形式の見通しが本線なら、別の見通しの範囲に移らず、正しい範囲を伏せない", () => {
  const toolEvents = legacyAfterOthers();
  assert.equal(mainCashflowIndex(toolEvents, 0), 4);
  const args = {
    toolEvents,
    userTexts: [SAID_1],
    today: TODAY,
    currentFrom: 0,
  };
  const reply = "手元に要る額は115,690円〜264,750円です。";
  assert.deepEqual(checkReply({ ...args, reply }), []);
  const masked = maskUnverified({ ...args, reply });
  assert.equal(masked.masked, 0);
  assert.doesNotMatch(masked.text, /照合できない/);
  // 足りない額の向きも、本線（旧形式 C）で照らす。264,750 − 200,000 = 64,750 円足りない。
  const fixed = fixGapDirection(
    "いったん3割を払う場合は 64,750 円足ります。",
    toolEvents,
    0,
  );
  assert.equal(fixed.replaced, 1);
  assert.match(fixed.text, /64,750 円足りない/);
});

test("#78 の再現: calc_date のラベルに書いた金額と日付は、照合の根拠にしない", () => {
  const input = {
    start_date: TODAY,
    steps: [
      { label: "費用777,777円、給付日2026-12-20", unit: "day", count: 0 },
    ],
    until_date: null,
  };
  const toolEvents = [event("calc_date", input)];
  const warnings = checkReply({
    reply: "給付予定額は777,777円、給付予定日は2026-12-20です。",
    toolEvents,
    userTexts: [SAID_1],
    today: TODAY,
  });
  assert.ok(
    warnings.some(
      (warning) => warning.kind === "amount" && /777,777/.test(warning.shown),
    ),
    JSON.stringify(warnings),
  );
  assert.ok(
    warnings.some(
      (warning) => warning.kind === "date" && /12\/20/.test(warning.shown),
    ),
    JSON.stringify(warnings),
  );
});
