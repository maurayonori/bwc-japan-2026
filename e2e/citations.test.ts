// 出典の番号 [Fxx] を引いた返答に、出典すべて（名前と URL）と確認日が、ホバーでなく見える形で出る（#68）。
// Claude には送らない。/api/chat への送信は、架空の体験例の返答で差し替える。
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { exampleWorkspace } from "../lib/example";
import { FACTS } from "../lib/money/facts";
import { citedFacts } from "../lib/money/format";
import { startServer } from "./server";

let browser: Browser;
let base = "";
let stop = () => {};

before(async () => {
  // 送信を押せるよう、接続ありの画面で起動する（接続が無いと送れない、#64）。送信はブラウザの中で差し替える。
  ({ base, stop } = await startServer({ connected: true }));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  stop();
});

test("[Fxx] を引いた返答の下に、その事実の出典すべての名前と URL、確認日が見える", async () => {
  const example = exampleWorkspace();
  const reply = example.messages.find((m) => m.role === "assistant");
  assert.ok(reply);
  const facts = citedFacts(reply.text);
  assert.ok(facts.length > 0, "体験例の返答は [F05] を引いている");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: reply.text,
        cards: example.cards.map(({ edited: _e, done: _d, included: _i, ...card }) => card),
        tools: reply.tools,
      }),
    });
  });
  await page.goto(`${base}/`);
  await page.waitForSelector("#thoughts:not([disabled])");
  await page.fill("#thoughts", "架空の例: 来月から 2 週間入院します。手元にいくら要るか知りたい。");
  await page.getByRole("button", { name: /ここから整理する/ }).click();
  const message = page.locator(".message.assistant").filter({ hasText: reply.text.split("\n")[0].slice(0, 20) }).first();
  await message.waitFor();
  const sources = message.locator(".fact-sources");
  await sources.waitFor();
  assert.equal(await sources.isVisible(), true);
  const shown = await sources.innerText();
  for (const fact of facts) {
    assert.ok(shown.includes(`確認 ${fact.checked_on}`), `${fact.id} の確認日`);
    for (const source of fact.sources) {
      assert.ok(shown.includes(source.name), `${fact.id} の出典の名前: ${source.name}`);
      assert.ok(shown.includes(source.url), `${fact.id} の出典の URL: ${source.url}`);
      assert.equal(await sources.locator(`a[href="${source.url}"]`).first().isVisible(), true);
    }
  }
  // 狭い幅でも、出典の行が横にはみ出さない。
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `横にはみ出した幅: ${overflow}px`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カードの見出しと次の一歩の [Fxx] も、カードの終わりに出典すべての名前と URL、確認日を出す", async () => {
  const example = exampleWorkspace();
  const reply = example.messages.find((m) => m.role === "assistant");
  assert.ok(reply);
  const [inTitle, inNext] = FACTS.filter((fact) => fact.sources.length > 0).slice(0, 2);
  const card = {
    id: "cite-card",
    kind: "contact",
    title: `保険会社に、このまま聞く [${inTitle.id}]`,
    body: "入院の予定を伝え、必要な書類を聞く。",
    nextStep: `契約の書類を探す。[${inNext.id}]`,
    uncertainty: "",
    evidence: [{ messageId: "u1", quote: "架空の例: 来月入院します。" }],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "質問文を用意しました。", cards: [card], tools: [] }),
    });
  });
  await page.goto(`${base}/`);
  await page.waitForSelector("#thoughts:not([disabled])");
  await page.fill("#thoughts", "架空の例: 来月入院します。");
  await page.getByRole("button", { name: /ここから整理する/ }).click();
  await page.locator(".message.assistant").filter({ hasText: "質問文を用意しました" }).first().waitFor();
  await page.evaluate(() => {
    location.hash = "#hand";
  });
  const title = page.locator("h3").filter({ hasText: "保険会社に、このまま聞く" }).first();
  await title.waitFor();
  const sources = title.locator("xpath=ancestor::*[.//span[contains(@class,'fact-sources')]][1]").locator(".fact-sources").first();
  await sources.waitFor();
  assert.equal(await sources.isVisible(), true);
  const shown = await sources.innerText();
  for (const fact of [inTitle, inNext]) {
    assert.ok(shown.includes(`確認 ${fact.checked_on}`), `${fact.id} の確認日`);
    for (const source of fact.sources) {
      assert.ok(shown.includes(source.name), `${fact.id} の出典の名前`);
      assert.ok(shown.includes(source.url), `${fact.id} の出典の URL`);
    }
  }
  // 見出しの [Fxx] も、出典へのリンクになる。
  assert.equal(await page.locator("h3 a.fact-cite").filter({ hasText: inTitle.id }).count() > 0, true);
  assert.deepEqual(errors, []);
  await context.close();
});

test("[F02][F07] と続けて引いた番号は、F02F07 とくっつかず、間が空いて見える", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "給付金は確認できていないので、手元のお金に数えていません。[F02][F07]", cards: [], tools: [] }),
    });
  });
  await page.goto(`${base}/`);
  await page.waitForSelector("#thoughts:not([disabled])");
  await page.fill("#thoughts", "架空の例: 来月入院します。");
  await page.getByRole("button", { name: /ここから整理する/ }).click();
  const message = page.locator(".message.assistant").filter({ hasText: "手元のお金に数えていません" }).first();
  await message.waitFor();
  const text = await message.locator("a.fact-cite").evaluateAll((links) =>
    links.map((link) => link.textContent).join("|"),
  );
  assert.equal(text, "F02|F07");
  const shown = (await message.innerText()).replace(/\s+/g, " ");
  assert.match(shown, /F02 F07/, `番号の間に空白が要る: ${shown.slice(0, 80)}`);
  assert.doesNotMatch(shown, /F02F07/);
  assert.deepEqual(errors, []);
  await context.close();
});
