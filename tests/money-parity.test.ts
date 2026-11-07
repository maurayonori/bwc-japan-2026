import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FACTS, factsForPrompt } from "../lib/money/facts";
import { checkReply } from "../lib/money/guard";
import { BUSINESS_DAYS, KOUGAKU_UNDER_70, MEAL_COPAY } from "../lib/money/rules";
import { TOOLS, executeTool } from "../lib/money/tools";

// 移植で計算結果が変わらないことを、試作そのものと突き合わせて確かめる。
// 試作は公開の配置物に入らないので、無いときは飛ばす。静的に import しない（型検査と build に巻き込まない）。
const PROTOTYPE = new URL(
  "../docs/prototypes/hospital-conversation/src/",
  import.meta.url,
);
const skip = !existsSync(fileURLToPath(PROTOTYPE));
const load = (file: string) => import(new URL(file, PROTOTYPE).href);

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low: number, high: number) =>
    low + Math.floor(next() * (high - low + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  return { next, int, pick };
}
type Random = ReturnType<typeof random>;

const pad = (value: number) => String(value).padStart(2, "0");
const randomDate = (r: Random) =>
  `${r.pick([2026, 2026, 2027])}-${pad(r.int(1, 12))}-${pad(r.int(1, 28))}`;
const randomYen = (r: Random) =>
  r.pick([
    0,
    1,
    99,
    1000,
    r.int(0, 300_000),
    r.int(0, 300_000),
    r.int(0, 5_000_000),
    r.int(0, 5_000_000),
    1_000_000_001,
  ]);

function randomKougaku(r: Random) {
  const low = randomYen(r);
  return {
    treatment_month: r.pick([
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-11",
      "2026-11",
      "2027-01",
      "2027-07",
      "2027-07",
      "2027-08",
      "2026-13",
    ]),
    income_category: r.pick(["ア", "イ", "ウ", "エ", "オ", "不明", "ウ", "不明", "カ"]),
    amount_basis: r.pick(["total", "total", "copay", "copay", "other"]),
    amount_low: low,
    amount_high: r.next() < 0.1 ? low - 1 : low + r.int(0, 800_000),
    copay_percent: r.pick([30, 30, 20, 10]),
  };
}

function randomMeal(r: Random) {
  return { days_low: r.int(-1, 40), days_high: r.int(0, 400) };
}

function randomDateInput(r: Random) {
  return {
    start_date: r.next() < 0.05 ? "2026-02-30" : randomDate(r),
    steps: Array.from({ length: r.int(0, 4) }, (_, index) => ({
      label: `段取り${index}`,
      unit: r.pick(["day", "week", "business_day", "month", "year"]),
      count: r.int(-10, 40),
    })),
    until_date: r.next() < 0.5 ? null : randomDate(r),
  };
}

function randomEvent(r: Random, start: string) {
  const low = r.int(0, 400_000);
  return {
    date: r.next() < 0.05 ? "2020-01-01" : `${start.slice(0, 8)}${pad(r.int(1, 28))}`,
    label: `入出金${r.int(1, 5)}`,
    direction: r.pick(["out", "out", "in"]),
    amount_low: low,
    amount_high: low + r.pick([0, 0, r.int(0, 200_000)]),
    certainty: r.pick(["confirmed", "estimate", "assumption"]),
  };
}

function randomCashflow(r: Random) {
  const start = `2026-${pad(r.int(1, 11))}-01`;
  return {
    start_date: start,
    cash_on_hand: r.next() < 0.5 ? null : r.int(0, 800_000),
    scenarios: Array.from({ length: r.int(1, 4) }, (_, index) => ({
      name: `筋書き${index}`,
      events: Array.from({ length: r.int(1, 8) }, () => randomEvent(r, start)),
    })),
  };
}

// 移植は試作に無い順位（what_to_confirm）を足した。試作と比べるのは、それ以外の項目。
function withoutRanking(
  name: string,
  result: ReturnType<typeof executeTool>,
): ReturnType<typeof executeTool> {
  if (name !== "simulate_cashflow" || !result.ok) return result;
  const { what_to_confirm: _ranking, ...output } = result.output as {
    what_to_confirm?: unknown;
  };
  return { ...result, output } as ReturnType<typeof executeTool>;
}

test("限度額の表・食事代・祝日は試作と同じ", { skip }, async () => {
  const rules = await load("rules.mjs");
  assert.deepEqual(KOUGAKU_UNDER_70, rules.KOUGAKU_UNDER_70);
  assert.deepEqual(MEAL_COPAY, rules.MEAL_COPAY);
  assert.deepEqual(BUSINESS_DAYS, rules.BUSINESS_DAYS);
});

test("事実と出典と確認日は試作と同じ", { skip }, async () => {
  const facts = await load("facts.mjs");
  assert.deepEqual(FACTS, facts.FACTS);
  assert.equal(factsForPrompt(), facts.factsForPrompt());
});

test("道具の定義は試作と同じ", { skip }, async () => {
  const tools = await load("tools.mjs");
  assert.deepEqual(TOOLS, tools.TOOLS);
});

test("固定シードの架空入力で、4 つの道具の結果が試作と一致する", { skip }, async () => {
  const tools = await load("tools.mjs");
  const generators = {
    kougaku_gendo: randomKougaku,
    meal_cost: randomMeal,
    calc_date: randomDateInput,
    simulate_cashflow: randomCashflow,
  };
  for (const [name, generate] of Object.entries(generators)) {
    const r = random(20261106);
    let accepted = 0;
    for (let index = 0; index < 1000; index += 1) {
      const input = generate(r);
      const ported = withoutRanking(name, executeTool(name, input));
      assert.deepEqual(ported, tools.executeTool(name, input), name);
      if (ported.ok) accepted += 1;
    }
    // 拒否ばかりだと、計算を比べたことにならない。
    assert.ok(accepted >= 200, `${name} の受付 ${accepted} 件`);
  }
});

test("固定シードの文章で、数字の検査の結果が試作と一致する", { skip }, async () => {
  const guard = await load("guard.mjs");
  const r = random(8);
  const toolEvents = [
    {
      input: randomKougaku(random(1)),
      output: { amount: 92_940, note: "28 万〜50 万円" },
    },
  ];
  for (let index = 0; index < 500; index += 1) {
    const parts = Array.from({ length: r.int(1, 6) }, () =>
      r.pick([
        `${r.int(0, 400_000).toLocaleString("en-US")} 円`,
        `${r.int(1, 90)}万円`,
        `${r.int(1, 30)}〜${r.int(31, 60)}万円`,
        `${r.int(1, 13)}/${r.int(1, 32)}（月）`,
        `${r.int(1, 12)}月${r.int(1, 31)}日`,
        randomDate(r),
        "９２，９４０円",
        "92,940 円",
        "手元に要る額は",
      ]),
    );
    const args = {
      reply: parts.join("、"),
      toolEvents,
      userTexts: ["手元には 30 万円くらい。入院は 11/9 から。"],
      today: "2026-11-06",
    };
    assert.deepEqual(checkReply(args), guard.checkReply(args));
  }
});
