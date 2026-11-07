import test from "node:test";
import assert from "node:assert/strict";
import { exampleWorkspace } from "../lib/example";
import { yenRange } from "../lib/money/format";
import {
  VIEW_HASH,
  askWhom,
  latestMoneyMessageId,
  needRangeOf,
  questionCard,
  resultLinks,
  viewFromHash,
} from "../lib/views";
import {
  mergeCards,
  parseStoredWorkspace,
  requestSchema,
  toRequest,
  type Card,
  type Message,
  type Proposal,
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
  const { cards, messages } = exampleWorkspace();
  const range = needRangeOf(moneyCard(cards));
  // カードに残るのは 2 回目の計算（確かめた額の筋書き 1 本）
  assert.deepEqual(range, { low: 115_690, high: 115_690 });
  const calculation = moneyCard(cards).money?.calculations.find(
    (item) => item.name === "simulate_cashflow",
  );
  assert.ok(calculation?.name === "simulate_cashflow");
  assert.equal(range?.low, calculation.output.what_to_confirm?.need_low);
  assert.equal(range?.high, calculation.output.what_to_confirm?.need_high);
  // 1 回目の返答は、お金のカードを最後に扱った返答ではないので、金額を書かない
  assert.deepEqual(resultLinks(exampleReply(), cards, false), [
    { view: "outlook", label: "要る額の幅と、まず確かめる 1 つを見る" },
    { view: "hand", label: "渡すものを見る（4 件）" },
  ]);
  const last = messages.at(-1);
  assert.ok(last && last.role === "assistant");
  assert.equal(latestMoneyMessageId(messages, cards), last.id);
  assert.deepEqual(resultLinks(last, cards, true), [
    {
      view: "outlook",
      label: `要る額 ${yenRange(115_690, 115_690)}と、まず確かめる 1 つを見る`,
    },
    { view: "hand", label: "渡すものを見る（1 件）" },
  ]);
  assert.equal(
    resultLinks(last, cards, true)[0].label,
    "要る額 115,690 円と、まず確かめる 1 つを見る",
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
    (card) => card.kind !== "money" && card.id !== "memory",
  );
  assert.deepEqual(resultLinks(reply, remaining, true), [
    { view: "hand", label: "渡すものを見る（3 件）" },
  ]);
});

test("金額を書く返答は、お金のカードを扱った返答のうち一番あとのもの", () => {
  const { cards, messages } = exampleWorkspace();
  // 体験例は 2 回目の返答でもお金のカードを扱うので、そちらが一番あと
  assert.equal(latestMoneyMessageId(messages, cards), "example-reply-2");
  assert.equal(latestMoneyMessageId(messages.slice(0, 3), cards), "example-reply");
  const handOnly: Message = {
    id: "later-hand",
    role: "assistant",
    text: "朝のメモを直しました。",
    cardIds: ["morning"],
  };
  assert.equal(
    latestMoneyMessageId([...messages, handOnly], cards),
    "example-reply-2",
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

// #48 の再現（架空）。3 ターンの会話で、カードと返答がどう積み重なるかを、画面と同じ mergeCards で作る。
const TURN_TEXTS = [
  "来月10日から2週間入院します。医療費は80万円くらいと言われました。年収は500万円くらいです。退院の日に手元にいくら要るか知りたい。",
  "病院に聞いたら、マイナ保険証で窓口の上限は効くと言われました。",
  "入院が1週間延びて、退院が1月4日になったら？",
];

function proposalOf(id: string, kind: Proposal["kind"], title: string, messageId: string): Proposal {
  return {
    id,
    kind,
    title,
    body: `${title}の本文`,
    nextStep: "読み返す。",
    uncertainty: "",
    evidence: [{ messageId, quote: TURN_TEXTS[Number(messageId.slice(1)) - 1].slice(0, 10) }],
  };
}

function threeTurns() {
  const turns: { reply: string; proposals: Proposal[] }[] = [
    {
      reply: "まず確かめる 1 つは、窓口で上限が適用されるかです。病院の会計に聞く文を作りました。",
      proposals: [
        proposalOf("money", "money", "退院の日までに、手元に要る額", "u1"),
        proposalOf("hospital-desk", "contact", "病院の会計に、このまま聞く", "u1"),
      ],
    },
    {
      reply: "窓口で上限が効くと分かったので、計算し直しました。まず確かめる 1 つは、所得の区分です。加入している健康保険に聞く文を作りました。",
      proposals: [
        proposalOf("money", "money", "退院の日までに、手元に要る額", "u2"),
        proposalOf("kenpo", "contact", "加入している健康保険に、このまま聞く", "u2"),
      ],
    },
    {
      reply: "まず確かめる1つは、退院日と月ごとの費用の内訳です。病院の会計に聞く文を直しました。",
      proposals: [
        proposalOf("money", "money", "退院の日までに、手元に要る額", "u3"),
        proposalOf("hospital-desk", "contact", "病院の会計に、このまま聞く", "u3"),
      ],
    },
  ];
  const messages: Message[] = [];
  let cards: Card[] = [];
  const states: { messages: Message[]; cards: Card[] }[] = [];
  turns.forEach((turn, index) => {
    messages.push({ id: `u${index + 1}`, role: "user", text: TURN_TEXTS[index] });
    messages.push({
      id: `a${index + 1}`,
      role: "assistant",
      text: turn.reply,
      cardIds: turn.proposals.map((proposal) => proposal.id),
    });
    cards = mergeCards(cards, turn.proposals);
    states.push({ messages: [...messages], cards: [...cards] });
  });
  return states;
}

test("#48: 直した質問文は元の位置に残るので、並びの最後のカードは今の確認の質問文とは限らない", () => {
  const { cards } = threeTurns()[2];
  assert.deepEqual(
    cards.map((card) => card.id),
    ["money", "hospital-desk", "kenpo"],
  );
  // 前の選び方（並びの最後の「確かめる・頼む」）では、2 ターン目の健康保険の質問文を拾っていた。
  assert.equal(
    cards.findLast((card) => card.kind === "contact")?.id,
    "kenpo",
  );
});

test("#48: 「まず確かめる 1 つ」の質問文は、今の見通しを作った返答で作ったり直したりした文章から選ぶ", () => {
  const [first, second, third] = threeTurns();
  assert.equal(questionCard(first.messages, first.cards)?.id, "hospital-desk");
  assert.equal(questionCard(second.messages, second.cards)?.id, "kenpo");
  const chosen = questionCard(third.messages, third.cards);
  assert.equal(chosen?.id, "hospital-desk");
  assert.equal(askWhom(chosen?.title ?? ""), "病院の会計");
});

test("#48: 今の確認に対応する質問文が分からなければ、古い質問文を出さない", () => {
  const { messages, cards } = threeTurns()[2];
  // 見通しだけを直し、質問文に触れなかった返答のあと。
  const moneyOnly: Message[] = [
    ...messages,
    { id: "u4", role: "user", text: "続き" },
    { id: "a4", role: "assistant", text: "計算し直しました。", cardIds: ["money"] },
  ];
  assert.equal(questionCard(moneyOnly, cards), null);
  // 発言に cardIds が無い前の保存データ。
  const old = messages.map(({ cardIds: _ids, ...message }) => message);
  assert.equal(questionCard(old, cards), null);
  // 2 枚の質問文を直し、「まず確かめる」の行からどちらか決まらない返答。
  const both: Message[] = [
    ...messages,
    { id: "u4", role: "user", text: "続き" },
    {
      id: "a4",
      role: "assistant",
      text: "まず確かめる 1 つは、退院日です。\n病院の会計と加入している健康保険に聞く文を直しました。",
      cardIds: ["money", "hospital-desk", "kenpo"],
    },
  ];
  assert.equal(questionCard(both, cards), null);
  const named: Message[] = [
    ...both.slice(0, -1),
    { ...both.at(-1)!, text: "まず確かめる 1 つは、所得の区分です。加入している健康保険に聞くと分かります。" },
  ];
  assert.equal(questionCard(named, cards)?.id, "kenpo");
});

test("体験例では、2 枚の質問文のうち「まず確かめる」の行に出てくる病院の会計の文を選ぶ", () => {
  const { messages, cards } = exampleWorkspace();
  // 1 回目の返答だけなら、2 枚の質問文から「まず確かめる」の行の病院の会計を選ぶ
  const firstTurn = messages.slice(0, 3);
  assert.equal(firstTurn.at(-1)?.id, "example-reply");
  const chosenFirst = questionCard(firstTurn, cards);
  assert.equal(chosenFirst?.id, "hospital-desk");
  // 2 回目の返答（答えを添えて直した質問文だけを扱う）でも、同じ 1 枚
  const chosen = questionCard(messages, cards);
  assert.equal(chosen?.id, "hospital-desk");
  assert.equal(chosen?.title, "病院の会計に、このまま聞く");
});

test("聞く相手は、質問文の見出しから取り出す", () => {
  assert.equal(askWhom("病院の会計に、このまま聞く"), "病院の会計");
  assert.equal(askWhom("加入している健康保険にこのまま聞く"), "加入している健康保険");
  assert.equal(askWhom("保険の確認"), "保険の確認");
});
