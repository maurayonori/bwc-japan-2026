// 支払日の表に確かめていない入金を数えない場合が並ぶこと、見通しを計算し直せなかったときに古い額へ印が付くこと（#77、ADR 0019）。
// Claude には送らない。/api/chat への送信は、計算関数で作ったカードの返答で差し替える。
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { STALE_CASHFLOW_WARNING } from "../lib/money/attach";
import { STALE_CASHFLOW_NOTE, WITHOUT_UNCONFIRMED_INCOME } from "../lib/money/format";
import { kougakuGendo } from "../lib/money/kougaku";
import { simulateCashflow } from "../lib/money/ledger";
import { mealCost } from "../lib/money/meals";
import { calculationSchema } from "../lib/money/schema";
import { startServer } from "./server";

let browser: Browser;
let base = "";
let stop = () => {};

before(async () => {
  // 送信を押せるよう、接続ありの画面で起動する（#64）。鍵は偽物で、送信はブラウザの中で差し替える。
  ({ base, stop } = await startServer({ connected: true }));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  stop();
});

const card = (money: unknown) => ({
  id: "money-1",
  kind: "money",
  title: "お金の見通し",
  body: "計算の結果を表にしました。説明は会話の返答を見てください。",
  nextStep: "表の前提を読み、違うところを会話で伝える。",
  uncertainty: "表の額には、見積もりや仮に置いた値が入っています。",
  evidence: [{ messageId: "m1", quote: "架空の例" }],
  money,
});

async function send(page: Page, body: unknown) {
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
  await page.goto(`${base}/`);
  await page.waitForSelector("#thoughts:not([disabled])");
  await page.fill("#thoughts", "架空の例: 総額は160万円でした。");
  await page.getByRole("button", { name: /ここから整理する/ }).click();
  await page.locator(".message.assistant").last().waitFor();
}

test("見通しを計算し直せなかったときは、古い要る額を今の額として出さず、計算し直すよう頼む", async () => {
  const kougakuInput = (total: number) => ({
    treatment_month: "2026-12",
    income_category: "ウ",
    amount_basis: "total",
    amount_low: total,
    amount_high: total,
    copay_percent: 30,
  });
  const mealInput = { days_low: 15, days_high: 15 };
  const oldKougaku = kougakuGendo(kougakuInput(800_000));
  const meals = mealCost(mealInput);
  const event = (label: string, amount: number) => ({
    date: "2026-12-28",
    label,
    direction: "out",
    amount_low: amount,
    amount_high: amount,
    certainty: "estimate",
  });
  const cashflowInput = {
    start_date: "2026-11-30",
    cash_on_hand: 200_000,
    scenarios: [
      {
        name: "窓口で上限が使える場合",
        events: [
          event("入院費（保険診療分）", oldKougaku.cases[0].low.pay_with_cap),
          event("入院中の食事代", meals.low.cost_max),
        ],
      },
    ],
  };
  const money = {
    calculations: [
      calculationSchema.parse({ name: "meal_cost", input: mealInput, output: meals }),
      calculationSchema.parse({ name: "simulate_cashflow", input: cashflowInput, output: simulateCashflow(cashflowInput) }),
      calculationSchema.parse({ name: "kougaku_gendo", input: kougakuInput(1_600_000), output: kougakuGendo(kougakuInput(1_600_000)) }),
    ],
    stale_cashflow: true,
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await send(page, {
    reply: "総額を 160 万円にして、内訳を計算し直しました。",
    cards: [card(money)],
    warnings: [{ kind: "calc", shown: "前の条件での計算", message: STALE_CASHFLOW_WARNING }],
    tools: ["kougaku_gendo"],
  });
  const message = page.locator(".message.assistant").last();
  // 返答の下のリンクに、前の条件での要る額を書かない。
  const link = message.getByText(/まず確かめる 1 つを見る/);
  await link.waitFor();
  assert.equal((await link.innerText()).includes("円"), false);
  // 計算し直すよう頼む一文が、会話の中で見える。
  assert.ok((await page.locator("body").innerText()).includes(STALE_CASHFLOW_WARNING));
  await link.click();
  const note = page.locator(".money-stale");
  await note.waitFor();
  assert.equal((await note.innerText()).trim(), STALE_CASHFLOW_NOTE);
  assert.ok((await page.locator(".money-payday h4").innerText()).includes("（前の条件での計算）"));
  assert.ok((await page.locator(".money-confirm h4").innerText()).includes("（前の条件での計算）"));
  // （中 4）印があるあいだは、古い順位から質問文を作らず、計算し直すように頼む。
  const confirm = page.locator(".money-confirm");
  assert.equal(await confirm.getByRole("button", { name: "質問文を作ってもらう" }).count(), 0);
  assert.equal(await confirm.getByRole("button", { name: "質問文をコピー" }).count(), 0);
  await confirm.getByRole("button", { name: "計算し直すように頼む" }).click();
  await page.waitForFunction(() => (document.querySelector("#thoughts") as HTMLTextAreaElement | null)?.value.includes("計算し直して"));
  assert.deepEqual(errors, []);
  await context.close();
});

test("確かめていない入金がある見通しは、支払日の表に、その入金を数えない場合の行が並ぶ", async () => {
  const input = {
    start_date: "2026-11-07",
    cash_on_hand: 0,
    scenarios: [
      {
        name: "見通し",
        events: [
          { date: "2026-11-08", label: "給付金", direction: "in", amount_low: 100_000, amount_high: 100_000, certainty: "assumption" },
          { date: "2026-11-10", label: "入院費", direction: "out", amount_low: 100_000, amount_high: 100_000, certainty: "confirmed" },
        ],
      },
    ],
  };
  const money = {
    calculations: [calculationSchema.parse({ name: "simulate_cashflow", input, output: simulateCashflow(input) })],
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await send(page, { reply: "給付金が入る場合と入らない場合を並べました。", cards: [card(money)], tools: ["simulate_cashflow"] });
  await page.locator(".message.assistant").last().getByText(/まず確かめる 1 つを見る/).click();
  const table = page.locator(".money-payday");
  await table.waitFor();
  const rows = await table.locator("tbody tr").allInnerTexts();
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("確かめた額・仮定"), rows[0]);
  assert.ok(rows[1].includes(`見通し・${WITHOUT_UNCONFIRMED_INCOME}`), rows[1]);
  assert.ok(rows[1].includes("100,000 円"), rows[1]);
  assert.ok(rows[1].includes("足りない"), rows[1]);
  assert.equal(await page.locator(".money-stale").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
