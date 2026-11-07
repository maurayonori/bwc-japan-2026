import test from "node:test";
import assert from "node:assert/strict";
import { FACTS } from "../lib/money/facts";
import { KOUGAKU_ROWS, REFUND_NOTE, moneySources } from "../lib/money/format";
import { simulateCashflow } from "../lib/money/ledger";
import { buildSystem } from "../lib/prompt";
import { exportMemo, type Card } from "../lib/workspace";

// #70: 日付だけの答え、見出しと次の一歩の出典、払い戻しの注記。数字と会話はすべて架空。

test("1: 日付だけの答えでは date だけを直し、額とその確かさはそのままにする指示がある", () => {
  const text = buildSystem("2026-11-07")[0].content;
  assert.ok(text.includes("答えが日付だけ"));
  assert.ok(text.includes("date だけを直し、額とその certainty はそのままにする"));
  // 額そのものを確かめたときだけ confirmed にする（「振込は 12/20」だけで confirmed にしない）。
  assert.ok(text.includes("答えが額そのもの"));
  assert.doesNotMatch(text, /額や日付そのもの/);
});

test("1: 確かめていない入金を confirmed にするだけで、入らない場合の不足が消える（日付だけで confirmed にしない理由）", () => {
  const run = (certainty: "assumption" | "confirmed") =>
    simulateCashflow({
      start_date: "2026-11-07",
      cash_on_hand: 100_000,
      scenarios: [
        {
          name: "給付が 12/20 に入る",
          events: [
            { date: "2026-12-20", label: "給付金", direction: "in", amount_low: 50_000, amount_high: 50_000, certainty },
            { date: "2026-12-28", label: "入院費", direction: "out", amount_low: 150_000, amount_high: 150_000, certainty: "estimate" },
          ],
        },
      ],
    }).scenarios[0].high_case_without_unconfirmed_income.shortfall;
  assert.equal(run("assumption"), 50_000);
  assert.equal(run("confirmed"), 0);
});

test("2: 持ち出しでは、見出しと次の一歩の [Fxx] の出典と確認日も書く", () => {
  const [inTitle, inNext] = FACTS.filter((fact) => fact.sources.length > 0).slice(0, 2);
  const card: Card = {
    id: "c1",
    kind: "contact",
    title: `保険会社に、このまま聞く [${inTitle.id}]`,
    body: "入院の予定を伝える。",
    nextStep: `契約の書類を探す。[${inNext.id}]`,
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: "来月入院します。" }],
    edited: false,
    done: false,
    included: true,
  };
  const text = exportMemo([card], [{ id: "u1", role: "user", text: "来月入院します。" }]);
  for (const fact of [inTitle, inNext]) {
    assert.ok(text.includes(`確認 ${fact.checked_on}`), fact.id);
    for (const source of fact.sources) assert.ok(text.includes(source.url), `${fact.id}: ${source.url}`);
  }
});

test("3: 支払日のカードの払い戻しの注記は、見込みとして書き、受けられるか・いつかは加入先に確かめると書く", () => {
  assert.doesNotMatch(REFUND_NOTE, /払い戻しを受けます/);
  assert.match(REFUND_NOTE, /見込み/);
  assert.match(REFUND_NOTE, /受けられるか、いつになるかは加入している健康保険に確かめて/);
  assert.match(REFUND_NOTE, /\[F05\]/);
});

test("4: 計算表の行名も、あとで戻る額を見込みとして書く", () => {
  const labels = KOUGAKU_ROWS.map(([label]) => label);
  assert.ok(labels.includes("いったん全額を払ったとき、あとで戻る見込みの額"));
  assert.ok(!labels.some((label) => label.endsWith("あとで戻る額")));
});

test("5: お金のカードの出典の一覧は、見出しと次の一歩の [Fxx] も含めて 1 か所にまとめる", () => {
  const [inTitle] = FACTS.filter((fact) => fact.sources.length > 0);
  const sources = moneySources({ calculations: [] }, `見出し [${inTitle.id}]\n本文\n次の一歩\n`);
  for (const source of inTitle.sources) assert.ok(sources.some((item) => item.url === source.url));
});

// ===== 実 API のデモの発言 1 で、正しい文を伏せた 2 件（#71 で直す） =====

test("6: 「要る額の幅は X 円から Y 円になります」は幅を言う文として、要る額の範囲と照らさない", async () => {
  const { exampleMoneyTurns } = await import("../lib/example");
  const { checkReply, maskUnverified } = await import("../lib/money/guard");
  const { first } = exampleMoneyTurns();
  const args = { toolEvents: first.calculations, userTexts: [], today: "2026-11-30" };
  const said =
    "まず確かめる1つは、窓口で上限が使えるかどうかです。ここが分かると、要る額の幅は149,060円から0円になります。";
  assert.deepEqual(checkReply({ ...args, reply: said }), []);
  assert.equal(maskUnverified({ ...args, reply: said }).masked, 0);
  // 幅と言わずに「要る額は X 円から Y 円」と書いた範囲は、今までどおり照らす。
  assert.equal(checkReply({ ...args, reply: "要る額は149,060円から0円です。" }).length, 1);
});

test("7: プロンプトは、標準報酬月額の等級の額を書かず、給料の額と仮定した区分の名前だけを書かせる", () => {
  const text = buildSystem("2026-11-07")[0].content;
  assert.ok(text.includes("標準報酬月額の等級の額（例: 36 万円）は書かない"));
  assert.ok(text.includes("給料の額（利用者の言葉）と、仮定した区分の名前だけを書く"));
});
