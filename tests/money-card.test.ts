import test from "node:test";
import assert from "node:assert/strict";
import { exampleWorkspace } from "../lib/example";
import { calcDate } from "../lib/money/business-days";
import { citedFacts, moneySources, showDate, yen, yenRange } from "../lib/money/format";
import { checkReply } from "../lib/money/guard";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import { mealCost } from "../lib/money/meals";
import { calculationSchema, type Calculation } from "../lib/money/schema";
import { executeTool } from "../lib/money/tools";
import {
  STORAGE_KEY,
  UNREADABLE_STORAGE_KEY,
  emptyWorkspace,
  exportMemo,
  kinds,
  mergeCards,
  parseStoredWorkspace,
  readStoredWorkspace,
  replySchema,
  requestSchema,
  toRequest,
  workspaceSchema,
  type Card,
} from "../lib/workspace";

function moneyCard(): Card {
  const card = exampleWorkspace().cards.find((item) => item.kind === "money");
  assert.ok(card);
  return card;
}

function outputOf<N extends Calculation["name"]>(card: Card, name: N) {
  const found = card.money?.calculations.find((item) => item.name === name);
  assert.ok(found);
  return found as Extract<Calculation, { name: N }>;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test("カードの種類に「お金の見通し」がある", () => {
  assert.equal(kinds.money.label, "お金の見通し");
});

test("道具の結果は、スキーマを通しても 1 項目も欠けない", () => {
  const calls: [string, unknown][] = [
    [
      "kougaku_gendo",
      {
        treatment_month: "2026-11",
        income_category: "不明",
        amount_basis: "total",
        amount_low: 800_000,
        amount_high: 1_000_000,
        copay_percent: 30,
      },
    ],
    ["meal_cost", { days_low: 8, days_high: 15 }],
    [
      "calc_date",
      {
        start_date: "2026-12-28",
        steps: [
          { label: "診断書を頼む", unit: "business_day", count: 3 },
          { label: "届く", unit: "week", count: 1 },
        ],
        until_date: "2027-01-20",
      },
    ],
    [
      "simulate_cashflow",
      {
        start_date: "2026-11-06",
        cash_on_hand: 100_000,
        scenarios: [
          {
            name: "基本",
            events: [
              {
                date: "2026-11-30",
                label: "入院費",
                direction: "out",
                amount_low: 90_940,
                amount_high: 92_940,
                certainty: "estimate",
              },
              {
                date: "2026-12-20",
                label: "給付金",
                direction: "in",
                amount_low: 0,
                amount_high: 100_000,
                certainty: "assumption",
              },
            ],
          },
          {
            name: "長引く",
            events: [
              {
                date: "2026-12-07",
                label: "入院費",
                direction: "out",
                amount_low: 120_000,
                amount_high: 120_000,
                certainty: "assumption",
              },
            ],
          },
        ],
      },
    ],
  ];
  for (const [name, input] of calls) {
    const result = executeTool(name, input);
    assert.equal(result.ok, true, name);
    const output = (result as { output: unknown }).output;
    assert.deepEqual(
      calculationSchema.parse({ name, input, output }).output,
      output,
      name,
    );
  }
});

test("体験例の表の数字は、計算関数の結果そのもの", () => {
  const card = moneyCard();
  const kougaku = kougakuGendo({
    treatment_month: "2026-11",
    income_category: "ウ",
    amount_basis: "copay",
    amount_low: 240_000,
    amount_high: 300_000,
    copay_percent: 30,
  });
  assert.deepEqual(outputOf(card, "kougaku_gendo").output, kougaku);
  assert.equal(kougaku.cases[0].low.pay_with_cap, 90_940);
  assert.equal(kougaku.cases[0].high.pay_with_cap, 92_940);
  const stay = calcDate({
    start_date: "2026-11-16",
    steps: [],
    until_date: "2026-11-30",
  });
  assert.equal(stay.until?.days_inclusive, 15);
  assert.deepEqual(outputOf(card, "calc_date").output, stay);
  const meals = mealCost({ days_low: 15, days_high: 15 });
  assert.equal(meals.low.cost_max, 24_750);
  assert.deepEqual(outputOf(card, "meal_cost").output, meals);
  const { input, output } = outputOf(card, "simulate_cashflow");
  assert.deepEqual(output, simulateCashflow(input as never));
  const [withCap, withoutCap] = output.scenarios;
  assert.equal(withCap.low_case.need, 115_690);
  assert.equal(withCap.high_case.need, 117_690);
  assert.equal(withoutCap.low_case.need, 264_750);
  assert.equal(withoutCap.high_case.need, 324_750);
});

test("体験例の文章の金額と日付は、計算結果と発言に見当たる", () => {
  const workspace = workspaceSchema.parse(exampleWorkspace());
  const card = moneyCard();
  assert.ok(card.body.includes(yenRange(115_690, 117_690)));
  assert.ok(card.body.includes(showDate("2026-11-30")));
  const prose = [
    ...workspace.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text),
    ...workspace.cards.flatMap((item) => [
      item.title,
      item.body,
      item.nextStep,
      item.uncertainty,
    ]),
  ].join("\n");
  assert.deepEqual(
    checkReply({
      reply: prose,
      toolEvents: card.money?.calculations ?? [],
      userTexts: workspace.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      today: "2026-11-06",
    }),
    [],
  );
});

test("体験例の根拠の引用は、発言と完全に一致する", () => {
  const workspace = exampleWorkspace();
  const card = moneyCard();
  for (const evidence of card.evidence) {
    const source = workspace.messages.find(
      (message) => message.id === evidence.messageId,
    );
    assert.equal(source?.role, "user");
    assert.ok(source?.text.includes(evidence.quote));
  }
});

test("編集・完了・選択済みのお金のカードは、表も文章も上書きしない", () => {
  const original = moneyCard();
  for (const flag of ["edited", "done", "included"] as const) {
    const card = { ...original, [flag]: true };
    const [merged] = mergeCards(
      [card],
      [
        {
          ...original,
          body: "上書き",
          money: {
            calculations: [outputOf(original, "meal_cost")],
          },
        },
      ],
    );
    assert.equal(merged.body, original.body);
    assert.deepEqual(merged.money, original.money);
  }
});

test("money の項目が無い提案で直しても、前の表は残る", () => {
  const original = moneyCard();
  const { money: _money, ...withoutMoney } = original;
  const [merged] = mergeCards([original], [{ ...withoutMoney, body: "直した" }]);
  assert.equal(merged.body, "直した");
  assert.deepEqual(merged.money, original.money);
});

test("持ち出しには表の内容・未確認事項・出典が入り、会話の全文は入らない", () => {
  const workspace = exampleWorkspace();
  const card = { ...moneyCard(), included: true };
  const text = exportMemo([card]);
  assert.match(text, /【お金の見通し】/);
  for (const expected of [
    yen(115_690),
    yen(117_690),
    yen(264_750),
    yen(324_750),
    yen(24_750),
    "入院中の食事代",
    "差額ベッド代",
    "まだ確かめていないこと",
    "出典と確認日",
    "https://",
    "確認 2026-",
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.doesNotMatch(text, /example-|標準報酬月額は34万円/);
  for (const message of workspace.messages)
    assert.equal(text.includes(message.text), false, message.id);
});

test("選ばなければ、お金のカードは持ち出さない", () => {
  const { cards } = exampleWorkspace();
  cards[0].included = true;
  assert.doesNotMatch(exportMemo(cards), /お金の見通し|円/);
});

test("表の無いメモでも、本文の出典番号は持ち出し先でたどれる", () => {
  const card = {
    ...exampleWorkspace().cards[1],
    included: true,
    body: "窓口で聞く内容です。[F02]",
  };
  const text = exportMemo([card]);
  assert.match(text, /出典と確認日/);
  assert.match(text, /F02/);
});

test("文章の出典番号から事実を引く。無い番号は出さない", () => {
  assert.deepEqual(
    citedFacts("上限 [F02] と [F03、F07] と [F99]").map((fact) => fact.id),
    ["F02", "F03", "F07"],
  );
});

test("出典は同じ URL を 1 回だけ並べ、確認日を持つ", () => {
  const card = moneyCard();
  const sources = moneySources(card.money!, card.body);
  assert.ok(sources.length >= 2);
  assert.equal(new Set(sources.map((source) => source.url)).size, sources.length);
  for (const source of sources) assert.match(source.checked_on, /^2026-/);
});

test("送るのは計算の入力だけで、結果と注意は送らない", () => {
  const { messages, cards } = exampleWorkspace();
  const request = toRequest(
    [
      {
        ...messages[0],
        warnings: [{ kind: "amount", shown: "1 円", message: "注意" }],
      },
    ],
    cards,
  );
  const body = JSON.stringify(request);
  assert.doesNotMatch(body, /"output"|"warnings"|pay_with_cap/);
  assert.equal(requestSchema.safeParse(request).success, true);
  const parsed = requestSchema.parse(request);
  assert.equal(parsed.cards[3].money?.calculations.length, 4);
});

test("結果の数字を送られても、受け取らずに捨てる", () => {
  const { messages, cards } = exampleWorkspace();
  const parsed = requestSchema.parse({ messages: messages.slice(0, 4), cards });
  assert.equal(JSON.stringify(parsed).includes('"output"'), false);
});

test("返答の形は、表と注意を付けたまま画面で読める", () => {
  const parsed = replySchema.parse({
    reply: "例",
    cards: [moneyCard()],
    warnings: [{ kind: "date", shown: "12/1", message: "注意" }],
  });
  assert.equal(parsed.cards[0].money?.calculations.length, 4);
});

test("version 1 の保存データを、そのまま読む", () => {
  const { cards, messages } = exampleWorkspace();
  const v1 = {
    version: 1,
    mode: "live",
    messages: messages.slice(0, 3),
    cards: cards.filter((card) => card.kind !== "money"),
  };
  const parsed = parseStoredWorkspace(JSON.stringify(v1));
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.messages, v1.messages);
  assert.deepEqual(parsed.cards, v1.cards);
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(v1) });
  const read = readStoredWorkspace(storage);
  assert.equal(read.unreadable, false);
  assert.equal(read.workspace?.cards.length, v1.cards.length);
});

test("新しい形の保存データも読み直せる", () => {
  const workspace = { ...exampleWorkspace(), mode: "live" as const };
  const parsed = parseStoredWorkspace(JSON.stringify(workspace));
  assert.deepEqual(parsed, workspace);
  assert.equal(emptyWorkspace().version, 2);
});

test("読めない保存データは消さず、別のキーにも写す", () => {
  for (const raw of [
    "{壊れた",
    JSON.stringify({ version: 3, mode: "live", messages: [], cards: [] }),
    JSON.stringify({ version: 1, mode: "live", messages: "x", cards: [] }),
  ]) {
    const storage = memoryStorage({ [STORAGE_KEY]: raw });
    const read = readStoredWorkspace(storage);
    assert.equal(read.workspace, null);
    assert.equal(read.unreadable, true);
    assert.equal(storage.data.get(STORAGE_KEY), raw);
    assert.equal(storage.data.get(UNREADABLE_STORAGE_KEY), raw);
  }
});

test("保存データが無いときは、読めないと言わない", () => {
  assert.deepEqual(readStoredWorkspace(memoryStorage()), {
    workspace: null,
    unreadable: false,
  });
});

test("別のキーへ写せなくても、読めないことは伝わる", () => {
  const read = readStoredWorkspace({
    getItem: () => "{壊れた",
    setItem: () => {
      throw new Error("quota");
    },
  });
  assert.equal(read.unreadable, true);
});

test("壊れた表のカードは、保存データとして読まない（画面を落とさない）", () => {
  const card = moneyCard();
  const broken = {
    ...exampleWorkspace(),
    mode: "live",
    cards: [
      {
        ...card,
        money: {
          calculations: [
            { name: "meal_cost", input: {}, output: { low: "たくさん" } },
          ],
        },
      },
    ],
  };
  assert.throws(() => parseStoredWorkspace(JSON.stringify(broken)));
});
