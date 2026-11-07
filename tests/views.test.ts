import test from "node:test";
import assert from "node:assert/strict";
import { exampleWorkspace } from "../lib/example";
import { yenRange } from "../lib/money/format";
import {
  VIEW_HASH,
  latestMoneyMessageId,
  needRangeOf,
  resultLinks,
  viewFromHash,
} from "../lib/views";
import {
  parseStoredWorkspace,
  requestSchema,
  toRequest,
  type Card,
  type Message,
} from "../lib/workspace";

function exampleReply(): Message {
  const reply = exampleWorkspace().messages.find(
    (message) => message.role === "assistant",
  );
  assert.ok(reply);
  return reply;
}

function moneyCard(cards: readonly Card[]): Card {
  const card = cards.find((item) => item.kind === "money");
  assert.ok(card);
  return card;
}

test("URL の # から表示を決める。知らない # や # 無しは「話す」", () => {
  assert.equal(viewFromHash("#talk"), "talk");
  assert.equal(viewFromHash("#outlook"), "outlook");
  assert.equal(viewFromHash("#hand"), "hand");
  assert.equal(viewFromHash(""), "talk");
  assert.equal(viewFromHash("#conversation"), "talk");
  assert.equal(viewFromHash("#OUTLOOK"), "talk");
  for (const [view, hash] of Object.entries(VIEW_HASH))
    assert.equal(viewFromHash(hash), view);
});

test("体験例の返答の下に、見通しと渡すものへのリンクを出す。金額は道具の出力から組み立てる", () => {
  const { cards } = exampleWorkspace();
  const range = needRangeOf(moneyCard(cards));
  assert.deepEqual(range, { low: 115_690, high: 324_750 });
  const calculation = moneyCard(cards).money?.calculations.find(
    (item) => item.name === "simulate_cashflow",
  );
  assert.ok(calculation?.name === "simulate_cashflow");
  assert.equal(range?.low, calculation.output.what_to_confirm?.need_low);
  assert.equal(range?.high, calculation.output.what_to_confirm?.need_high);
  assert.deepEqual(resultLinks(exampleReply(), cards, true), [
    {
      view: "outlook",
      label: `要る額 ${yenRange(115_690, 324_750)}と、まず確かめる 1 つを見る`,
    },
    { view: "hand", label: "渡すものを見る（4 件）" },
  ]);
  assert.equal(
    resultLinks(exampleReply(), cards, true)[0].label,
    "要る額 115,690〜324,750 円と、まず確かめる 1 つを見る",
  );
});

test("あとの返答でお金のカードが直されうるので、最後に扱った返答でなければ金額を書かない", () => {
  const { cards } = exampleWorkspace();
  assert.equal(
    resultLinks(exampleReply(), cards, false)[0].label,
    "要る額の幅と、まず確かめる 1 つを見る",
  );
  // 順位の無い前の保存データでも、金額を作らずにリンクだけ出す。
  const old = cards.map((card) =>
    card.kind === "money" && card.money
      ? {
          ...card,
          money: {
            calculations: card.money.calculations.map((item) =>
              item.name === "simulate_cashflow"
                ? {
                    ...item,
                    output: { ...item.output, what_to_confirm: undefined },
                  }
                : item,
            ),
          },
        }
      : card,
  );
  assert.equal(needRangeOf(moneyCard(old)), null);
  assert.equal(
    resultLinks(exampleReply(), old, true)[0].label,
    "要る額の幅と、まず確かめる 1 つを見る",
  );
});

test("結果が無い返答・利用者の発言・消したカードには、リンクを出さない", () => {
  const { cards, messages } = exampleWorkspace();
  const reply = exampleReply();
  assert.deepEqual(resultLinks({ ...reply, cardIds: undefined }, cards, true), []);
  assert.deepEqual(resultLinks({ ...reply, cardIds: [] }, cards, true), []);
  assert.deepEqual(
    resultLinks({ ...messages[0], cardIds: ["morning"] }, cards, true),
    [],
  );
  const remaining = cards.filter(
    (card) => card.kind !== "money" && card.id !== "pancake",
  );
  assert.deepEqual(resultLinks(reply, remaining, true), [
    { view: "hand", label: "渡すものを見る（3 件）" },
  ]);
});

test("金額を書く返答は、お金のカードを扱った返答のうち一番あとのもの", () => {
  const { cards, messages } = exampleWorkspace();
  assert.equal(latestMoneyMessageId(messages, cards), "example-reply");
  const handOnly: Message = {
    id: "later-hand",
    role: "assistant",
    text: "朝のメモを直しました。",
    cardIds: ["morning"],
  };
  assert.equal(
    latestMoneyMessageId([...messages, handOnly], cards),
    "example-reply",
  );
  const moneyAgain: Message = {
    id: "later-money",
    role: "assistant",
    text: "見通しを直しました。",
    cardIds: ["hospital-money"],
  };
  assert.equal(
    latestMoneyMessageId([...messages, handOnly, moneyAgain], cards),
    "later-money",
  );
  assert.equal(latestMoneyMessageId(messages, []), null);
});

test("返答で扱ったカードの id は保存して読み直せ、前の保存データにも無くてよい。サーバーへは送らない", () => {
  const workspace = { ...exampleWorkspace(), mode: "live" as const };
  const stored = parseStoredWorkspace(JSON.stringify(workspace));
  assert.deepEqual(
    stored.messages.at(-1)?.cardIds,
    workspace.messages.at(-1)?.cardIds,
  );
  const old = JSON.parse(JSON.stringify(workspace));
  for (const message of old.messages) delete message.cardIds;
  assert.equal(
    parseStoredWorkspace(JSON.stringify(old)).messages.at(-1)?.cardIds,
    undefined,
  );
  const request = toRequest(workspace.messages, workspace.cards);
  assert.doesNotMatch(JSON.stringify(request.messages), /cardIds/);
  assert.equal(requestSchema.safeParse(request).success, false); // 最後が利用者の発言ではないので断る
  const asked = toRequest(
    [...workspace.messages, { id: "u5", role: "user", text: "続き" }],
    workspace.cards,
  );
  assert.equal(requestSchema.safeParse(asked).success, true);
});
