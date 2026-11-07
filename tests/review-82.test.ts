// #82: 同じ返答で見通しの道具が 2 回呼ばれ、2 回目が試し呼び（筋書き「x」・1 円）だったとき、
// 「最後の見通し」を本線にすると、正しい額が伏せられ、表の先頭が「x 1 円」になる。
// 内訳の計算（kougaku_gendo・meal_cost）の額を入出金に含む見通しを本線にする。
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachMoney, type ToolEvent } from "../lib/money/attach";
import { checkReply } from "../lib/money/guard";
import {
  breakdownAmounts,
  mainCashflowIndex,
  withMainCashflowLast,
} from "../lib/money/main-cashflow";
import type { Calculation } from "../lib/money/schema";
import { executeTool } from "../lib/money/tools";
import { needRangeOf } from "../lib/views";
import type { Message } from "../lib/workspace";

const TODAY = "2026-11-07";
const USER_TEXT =
  "12月14日に入院して、28日に退院する予定です。病院の見積もりだと、医療費は総額で80万円くらい。協会けんぽで、給料は月35万円くらいです。すぐ使えるお金は20万円。";
const MESSAGES: Message[] = [{ id: "u1", role: "user", text: USER_TEXT }];

const KOUGAKU = {
  treatment_month: "2026-12",
  income_category: "ウ",
  amount_basis: "total",
  amount_low: 800_000,
  amount_high: 800_000,
  copay_percent: 30,
};
const MEAL = { days_low: 15, days_high: 15 };
// 体験例と同じ見通し（窓口で上限が適用される場合 115,690 円、いったん 3 割を払う場合 264,750 円）。
const REAL = {
  start_date: TODAY,
  cash_on_hand: 200_000,
  scenarios: [
    {
      name: "窓口で上限が適用される場合",
      events: [
        {
          date: "2026-12-28",
          label: "入院費（保険診療分）",
          direction: "out",
          amount_low: 90_940,
          amount_high: 90_940,
          certainty: "estimate",
        },
        {
          date: "2026-12-28",
          label: "食事代",
          direction: "out",
          amount_low: 24_750,
          amount_high: 24_750,
          certainty: "assumption",
        },
      ],
    },
    {
      name: "上限が適用されず、いったん3割を払う場合",
      events: [
        {
          date: "2026-12-28",
          label: "入院費（3割）",
          direction: "out",
          amount_low: 240_000,
          amount_high: 240_000,
          certainty: "estimate",
        },
        {
          date: "2026-12-28",
          label: "食事代",
          direction: "out",
          amount_low: 24_750,
          amount_high: 24_750,
          certainty: "assumption",
        },
      ],
    },
  ],
};
// 本番で実際に起きた試し呼び（11/8 00:10 JST）。
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

function attach(events: ToolEvent[]) {
  const { cards } = attachMoney({
    proposals: [],
    events,
    existing: [],
    prior: new Map<string, Calculation[]>(),
    messages: MESSAGES,
  });
  const card = cards[0];
  assert.ok(card?.money, "お金のカードが作られる");
  return card;
}

const lastCashflow = (calculations: readonly Calculation[]) =>
  calculations.findLast(
    (calculation) => calculation.name === "simulate_cashflow",
  );

const REPLY =
  "手元に要る額は、仮の見積もりで 115,690 円〜264,750 円です。一番きつい日は退院日の 12/28（月）です。";

test("内訳の計算の額（窓口で払う額・上限の無いときの負担・食事代・その和）が、本線を選ぶ基準になる", () => {
  const reference = breakdownAmounts([
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
  ]);
  for (const amount of [90_940, 240_000, 24_750, 115_690, 264_750])
    assert.ok(reference.has(amount), String(amount));
  assert.equal(reference.has(1), false);
});

test("試し呼び（x・1 円）が最後でも、内訳と合う見通しが本線になり、カードでは最後に置かれる", () => {
  const events = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    event("simulate_cashflow", REAL),
    event("simulate_cashflow", DUMMY),
  ];
  assert.equal(mainCashflowIndex(events), 2);
  const card = attach(events);
  const calculations = card.money?.calculations ?? [];
  // 試し呼びの記録は消さない
  assert.equal(
    calculations.filter((item) => item.name === "simulate_cashflow").length,
    2,
  );
  assert.deepEqual(lastCashflow(calculations)?.input, REAL);
  assert.deepEqual(needRangeOf({ ...card, evidence: card.evidence } as never), {
    low: 115_690,
    high: 264_750,
  });
});

test("試し呼びが先で正しい見通しが後なら、並びは変わらない", () => {
  const events = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    event("simulate_cashflow", DUMMY),
    event("simulate_cashflow", REAL),
  ];
  const ordered = withMainCashflowLast(events);
  assert.deepEqual(
    ordered.map((item) => item.input),
    events.map((item) => item.input),
  );
  assert.deepEqual(
    lastCashflow(attach(events).money?.calculations ?? [])?.input,
    REAL,
  );
});

test("内訳の計算が無い回は、今までどおり最後の見通しが本線", () => {
  const events = [
    event("simulate_cashflow", REAL),
    event("simulate_cashflow", DUMMY),
  ];
  assert.equal(mainCashflowIndex(events), 1);
  assert.deepEqual(
    lastCashflow(attach(events).money?.calculations ?? [])?.input,
    DUMMY,
  );
});

test("検査も本線の見通しと照らすので、試し呼びが最後でも正しい範囲は伏せられない", () => {
  const toolEvents = [
    event("kougaku_gendo", KOUGAKU),
    event("meal_cost", MEAL),
    event("simulate_cashflow", REAL),
    event("simulate_cashflow", DUMMY),
  ];
  const args = {
    toolEvents,
    userTexts: [USER_TEXT],
    earlierReplies: [] as string[],
    today: TODAY,
  };
  assert.deepEqual(checkReply({ ...args, reply: REPLY }), []);
  // 試し呼びの範囲（1 円）を書いた返答は、本線と合わないので指摘される
  const wrong = checkReply({
    ...args,
    reply: "手元に要る額は 1 円〜1 円です。",
  });
  assert.ok(wrong.length > 0);
  // 直す前の動き（内訳の計算が無く、最後の見通しが試し呼びのとき）: 正しい範囲が「合わない」と出る。
  // これが本番で起きた症状。内訳の計算があれば、上のとおり本線で照らすので出ない。
  const before = checkReply({ ...args, toolEvents: [toolEvents[2], toolEvents[3]], reply: REPLY });
  assert.ok(before.some((item) => item.message.includes("要る額の範囲")), "試し呼びが本線なら正しい範囲は合わない");
});
