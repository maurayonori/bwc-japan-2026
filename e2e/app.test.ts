// ブラウザでの通しの検査（#52）。先に next build を済ませておく（npm run test:e2e がビルドしてから走らせる）。
// Claude には送らない。/api/chat への送信は、架空の体験例の返答で差し替える。
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, devices, type Browser, type Page } from "playwright";
import { exampleWorkspace } from "../lib/example";
import { pathToFileURL } from "node:url";
import { externalHref } from "../lib/menu";

let server: ChildProcess;
let browser: Browser;
let base = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("port"))));
    });
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const next = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  // 実 API に届かないよう、鍵を外して起動する
  const env = { ...process.env, ANTHROPIC_API_KEY: "" };
  server = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], {
    env,
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/roadmap`)).ok) break;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

// 架空の体験例の最初の返答。お金のカード 1 枚と、渡すもの 2 枚（病院の会計への質問文、朝の支度）。
function mockReply() {
  const example = exampleWorkspace();
  const reply = example.messages.find((m) => m.role === "assistant");
  assert.ok(reply);
  return {
    reply: reply.text,
    cards: example.cards.map(({ edited: _e, done: _d, included: _i, ...card }) => card),
    tools: reply.tools,
    warnings: reply.warnings,
  };
}

async function menu(page: Page, label: string) {
  await page.locator('nav[aria-label="メニュー"]').getByRole("link", { name: label, exact: false }).first().click();
}

// 押し続けて戻る（家の絵の真ん中を、マウスで HOLD_MS より長く押す）
async function holdHome(page: Page, ms = 1900) {
  const box = await page.locator(".play-home").boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test("会話の途中で年表やあそぶへ移って戻っても、会話・計算結果・直した文章・下書きが消えない", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let calls = 0;
  await page.route("**/api/chat", async (route) => {
    calls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockReply()) });
  });

  await page.goto(`${base}/`);
  await page.waitForSelector("#thoughts:not([disabled])");
  const said = "架空の例: 来月から 2 週間入院します。手元にいくら要るか知りたい。";
  await page.fill("#thoughts", said);
  await page.getByRole("button", { name: /ここから整理する/ }).click();
  await page.waitForSelector(".message.user");
  const firstLine = mockReply().reply.split("\n")[0];
  await page.getByText(firstLine.slice(0, 20), { exact: false }).first().waitFor();
  await page.fill("#thoughts", "送る前の下書き");

  await menu(page, "見通し");
  await page.waitForSelector("#outlook-title");
  const money = await page.locator(".memo-card.money").innerText();
  assert.match(money, /円/);

  await menu(page, "渡すもの");
  await page.waitForSelector("#hand-title");
  await page.locator(".memo-card").first().getByRole("button", { name: "内容を直す" }).click();
  await page.locator("dialog textarea").first().fill("自分で直した文章（架空）");
  await page.getByRole("button", { name: "変更を残す" }).click();
  await page.getByText("自分で直した文章（架空）").waitFor();

  // 年表へ（メニュー）
  await menu(page, "年表");
  await page.waitForURL(`${base}/roadmap`);
  await page.waitForSelector("#cond:not(:empty)");
  assert.equal(await page.locator('nav[aria-label="メニュー"]').count(), 1);
  // 年表の中の設定へ移り、メニューの「あそぶ」へ
  await page.click("#nav-link");
  await page.waitForSelector("#settings-view:not([hidden])");
  await menu(page, "あそぶ");
  await page.waitForURL(`${base}/play`);
  assert.equal(await page.locator('nav[aria-label="メニュー"]').count(), 0);
  await page.getByRole("link", { name: "ぽん" }).click();
  await page.waitForURL(`${base}/play/pon`);
  await page.mouse.click(600, 500);
  await holdHome(page);
  await page.waitForURL(`${base}/play`);
  await holdHome(page);
  await page.waitForURL(`${base}/#talk`);

  // 会話と下書きが残っている
  await page.waitForSelector("main.talk");
  await page.getByText(said).waitFor();
  await page.getByText(firstLine.slice(0, 20), { exact: false }).first().waitFor();
  assert.equal(await page.inputValue("#thoughts"), "送る前の下書き");
  // メニューの件数も残っている
  assert.match(await page.locator('nav[aria-label="メニュー"]').innerText(), /見通し\s*1[\s\S]*渡すもの\s*2/);

  // 計算の結果が同じ
  await menu(page, "見通し");
  await page.waitForSelector("#outlook-title");
  assert.equal(await page.locator(".memo-card.money").innerText(), money);

  // 直した文章が残り、上書きされていない
  await menu(page, "渡すもの");
  await page.waitForSelector("#hand-title");
  await page.getByText("自分で直した文章（架空）").waitFor();
  assert.ok((await page.locator(".memo-card .tag", { hasText: "自分で編集" }).count()) >= 1);

  // ブラウザの「戻る」でも、元のページと表示に戻る
  await menu(page, "年表");
  await page.waitForURL(`${base}/roadmap`);
  await page.goBack();
  await page.waitForURL(`${base}/#hand`);
  await page.waitForSelector("#hand-title");
  await page.getByText("自分で直した文章（架空）").waitFor();
  await page.goBack();
  await page.waitForURL(`${base}/#outlook`);
  await page.waitForSelector("#outlook-title");
  await page.goForward();
  await page.waitForURL(`${base}/#hand`);
  await page.goForward();
  await page.waitForURL(`${base}/roadmap`);
  await page.waitForSelector("#cond:not(:empty)");

  // サーバーにもブラウザにも保存していない（送ったのは「ここから整理する」の 1 回だけ）
  assert.equal(calls, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem("sakiyomi-family-v1")), null);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("架空の体験例: 支払日に要るお金を 2 つ並べ、病院の答えの続きで更新する。直した文章は上書きしない", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let calls = 0;
  await page.route("**/api/chat", async (route) => {
    calls++;
    await route.abort();
  });
  await page.goto(`${base}/`);
  await page.getByText("入院の予定や医療費の見込みを、そのまま話してください。").waitFor();
  assert.equal(await page.locator(".brand small").innerText(), "使える制度を、支払日に間に合う準備へ");
  await page.getByRole("button", { name: "まず、架空の体験例を見る" }).click();

  // 返答の下に、2 つの支払日の額と差（避けられる一時立替）
  const summary = page.locator(".message.assistant .payday.compact");
  await summary.waitFor();
  const said = await summary.innerText();
  for (const text of ["窓口で上限を使う", "115,690 円", "使わずに、あとで還付", "264,750 円", "避けられる一時立替", "149,060 円", "84,310 円残る", "64,750 円足りない"])
    assert.ok(said.includes(text), text);

  // 見通し: カードの先頭に同じ 2 つ。確かさの区別と、還付の時期の出典と確認日
  await menu(page, "見通し");
  await page.waitForSelector("#outlook-title");
  assert.match(await page.locator("#outlook-title").innerText(), /^支払日に要るお金と、まず確かめる 1\s?つ$/);
  const block = page.locator(".memo-card.money .payday").first();
  const outlook = await block.innerText();
  for (const text of ["支払日に要るお金", "2026 年 12 月の診療分", "200,000 円", "見積もり", "仮定", "診療月から 3 か月以上", "確認 2026-"])
    assert.ok(outlook.includes(text), text);
  assert.equal(
    await block.locator('a.fact-cite[href="https://www.kyoukaikenpo.or.jp/faq/benefit/004/index.html"]').count(),
    1,
  );
  // カードの中で、支払日の額が本文より先に来る
  const order = await page.locator(".memo-card.money").evaluate((card) => {
    const payday = card.querySelector(".payday");
    const body = card.querySelector(".card-body");
    return Boolean(payday && body && payday.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(order, true);
  assert.match(await page.locator(".money-confirm").innerText(), /病院の会計/);

  // 渡すもの: 病院の会計への質問文を自分で直す
  await menu(page, "渡すもの");
  await page.waitForSelector("#hand-title");
  const desk = page.locator(".memo-card", { hasText: "病院の会計に、このまま聞く" });
  await desk.getByRole("button", { name: "内容を直す" }).click();
  await page.locator("dialog textarea").first().fill("自分で直した質問文（架空）");
  await page.getByRole("button", { name: "変更を残す" }).click();
  await page.getByText("自分で直した質問文（架空）").waitFor();

  // 続き: 病院の答えを話す
  await page.getByRole("button", { name: "続き: 病院の答えを話す →" }).click();
  await page.waitForURL(`${base}/#talk`);
  await page.getByText("病院に聞いたら、マイナ保険証で窓口の上限は効くと言われました。").waitFor();
  const updated = await page.locator(".message.assistant .payday.compact").innerText();
  for (const text of ["115,690 円", "84,310 円残る", "この見通しには入れていません", "149,060 円"])
    assert.ok(updated.includes(text), text);
  assert.equal(await page.locator(".message.assistant .payday.compact").count(), 1, "最新の返答の下だけ");
  assert.equal(await page.getByRole("button", { name: "続き: 病院の答えを話す →" }).count(), 0);
  await page.getByText("要る額の幅は 149,060 円から 0 円に縮みました。").waitFor();

  await menu(page, "見通し");
  await page.waitForSelector("#outlook-title");
  assert.match(await page.locator(".money-confirm").innerText(), /幅はありません/);
  await menu(page, "渡すもの");
  await page.waitForSelector("#hand-title");
  await page.getByText("自分で直した質問文（架空）").waitFor();

  // 体験例は Claude に送らない
  assert.equal(calls, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("メニューはどのページでも 1 つ。あそぶでは出さない。ペルソナとかがみは設定があるときだけ", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  // ビルドのときの値で決まる。npm run test:e2e は未設定、npm run test:e2e:links は両方を設定して確かめる
  const persona = externalHref(process.env.NEXT_PUBLIC_PERSONA_URL);
  const kagami = externalHref(process.env.NEXT_PUBLIC_KAGAMI_URL);
  const expected = [
    "話す",
    "見通し",
    "渡すもの",
    "年表",
    "あそぶ",
    ...(persona ? ["ペルソナ"] : []),
    ...(kagami ? ["かがみ"] : []),
  ];
  for (const path of ["/", "/#outlook", "/#hand", "/roadmap"]) {
    await page.goto(`${base}${path}`);
    await page.waitForLoadState("networkidle");
    const nav = page.locator('nav[aria-label="メニュー"]');
    assert.equal(await nav.count(), 1, path);
    const labels = (await nav.locator("a").allInnerTexts()).map((t) => t.replace(/[\d↗\s]|（別のタブで開く）/g, ""));
    assert.deepEqual(labels, expected, path);
    // 見通し・渡すものへのリンクは、メニューの中に 1 つずつ
    assert.equal(await nav.locator('a[href$="#outlook"]').count(), 1, path);
    assert.equal(await nav.locator('a[href$="#hand"]').count(), 1, path);
    assert.equal(await page.locator('header a[href$="#outlook"], header a[href$="#hand"]').count(), 2, path);
    for (const href of [persona, kagami].filter(Boolean))
      assert.equal(await nav.locator(`a[href="${href}"][target="_blank"][rel="noopener noreferrer"]`).count(), 1, path);
    assert.equal(await nav.locator('a[target="_blank"]').count(), [persona, kagami].filter(Boolean).length, path);
  }
  for (const path of ["/play", "/play/pon", "/play/baa", "/play/shabon"]) {
    await page.goto(`${base}${path}`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator('nav[aria-label="メニュー"]').count(), 0, path);
    assert.equal(await page.locator("header").count(), 0, path);
  }
  // 320px の幅でもページは横にはみ出さない。収まらないメニューは、メニューの中で横に送って最後まで届く
  const phone = await browser.newContext({ ...devices["iPhone SE"] });
  const small = await phone.newPage();
  for (const path of ["/", "/roadmap"]) {
    await small.goto(`${base}${path}`);
    await small.waitForLoadState("networkidle");
    assert.equal(await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, path);
    const nav = small.locator('nav[aria-label="メニュー"]');
    const box = await nav.boundingBox();
    assert.ok(box && box.width <= 320, path);
    assert.equal(await nav.evaluate((n) => getComputedStyle(n).overflowX), "auto", path);
    const last = await nav.evaluate((n) => {
      n.scrollLeft = n.scrollWidth;
      const a = [...n.querySelectorAll("a")].at(-1)!.getBoundingClientRect();
      return { left: a.left, right: a.right, width: window.innerWidth };
    });
    assert.ok(last.left >= 0 && last.right <= last.width, `${path} ${JSON.stringify(last)}`);
  }
  await phone.close();
  await context.close();
});

// ヘッダーの中で、2 行以上に折れている文字（途中で折り返した語）
async function wrappedHeaderText(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector("header.site-header");
    if (!header) return ["ヘッダーが無い"];
    const out: string[] = [];
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement;
      if (!node.textContent?.trim() || !el || el.closest(".sr-only") || getComputedStyle(el).display === "none") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      if (lines.size > 1) out.push(node.textContent.trim());
    }
    return out;
  });
}

test("ヘッダーの文字を、どの幅でも途中で折り返さない。1280px の見た目は変えない", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const widths = [320, 375, 414, 600, 740, 741, 771, 800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1280, 1440];
  for (const path of ["/", "/roadmap"]) {
    await page.goto(`${base}${path}`);
    await page.waitForLoadState("networkidle");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      assert.deepEqual(await wrappedHeaderText(page), [], `${path} ${width}px`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${path} ${width}px`);
    }
  }
  // 1280px: 副題と「公開の試用版」を出し、製品名・メニュー・右の道具を 1 行に並べる（動画と同じ）
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/`);
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator(".brand small").isVisible(), true);
  assert.equal(await page.locator(".header-actions .connection").isVisible(), true);
  const rows = await page.evaluate(() =>
    [".brand", "nav.view-nav", ".header-actions"].map((s) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    }),
  );
  assert.ok(Math.max(...rows) - Math.min(...rows) <= 2, JSON.stringify(rows));
  await context.close();
});

test("端末が暗い表示でも、年表はさきよみの明るいトークンのまま", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const page = await context.newPage();
  const look = () =>
    page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        body: getComputedStyle(document.body).backgroundColor,
        bg: root.getPropertyValue("--bg").trim(),
        ink: root.getPropertyValue("--ink").trim(),
        scheme: root.colorScheme,
        theme: document.documentElement.getAttribute("data-theme"),
      };
    });
  await page.goto(`${base}/`);
  await page.waitForLoadState("networkidle");
  const home = await look();
  assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), true);
  assert.deepEqual(home, { body: "rgb(246, 246, 238)", bg: "#f6f6ee", ink: "#293c36", scheme: "normal", theme: null });
  await page.goto(`${base}/roadmap`);
  await page.waitForSelector("#cond:not(:empty)");
  assert.deepEqual(await look(), home);
  // 設定画面に明るさの切り替えを置かない
  await page.click("#nav-link");
  await page.waitForSelector("#settings-view:not([hidden])");
  assert.equal(await page.locator("[data-theme-set]").count(), 0);
  assert.deepEqual(await look(), home);
  // 単独で開いた HTML も同じ
  await page.goto(`${pathToFileURL(join(process.cwd(), "docs", "prototypes", "sapporo-roadmap.html")).href}?today=2026-11-07`);
  await page.waitForSelector("#cond:not(:empty)");
  assert.deepEqual(await look(), home);
  await context.close();
});

// 画面に見える文字（文字のノード、::before と ::after の content、ツールチップ、画像の代わりの文字）
async function visibleText(page: Page) {
  return page.evaluate(() => {
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.textContent?.trim() && !node.parentElement?.closest("script, style, template"))
        texts.push(node.textContent.trim());
    }
    for (const el of document.body.querySelectorAll("*"))
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && !["none", "normal", '""'].includes(content)) texts.push(`${pseudo} ${content}`);
      }
    const tips = document.querySelectorAll("[title], svg title, img, [alt]").length;
    return { inner: document.body.innerText.trim(), texts, tips };
  });
}

test("/play の画面に見える文字は 0。触れる的は 96px 以上。外へ通信せず、保存しない", async () => {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(base)) errors.push(`外への通信 ${r.url()}`);
  });
  const none = { inner: "", texts: [], tips: 0 };
  const big = async (selector: string) => {
    for (const box of await page.locator(selector).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON())))
      assert.ok(box.width >= 96 && box.height >= 96, `${selector} ${box.width}x${box.height}`);
  };

  await page.goto(`${base}/play`);
  await page.waitForSelector(".play-choice");
  assert.deepEqual(await visibleText(page), none, "/play");
  await big(".play-home");
  await big(".play-choice");
  assert.equal(await page.locator(".play-choice").count(), 3);
  assert.equal(await page.locator(".play-root").evaluate((e) => getComputedStyle(e).touchAction), "none");
  assert.equal(await page.locator(".play-root").evaluate((e) => getComputedStyle(e).userSelect), "none");
  // 偶然の一押しでは戻らない
  const home = await page.locator(".play-home").boundingBox();
  assert.ok(home);
  await page.touchscreen.tap(home.x + 48, home.y + 48);
  await page.waitForTimeout(400);
  assert.equal(new URL(page.url()).pathname, "/play");

  await page.goto(`${base}/play/pon`);
  await page.waitForSelector(".play-pon");
  for (const [x, y] of [[100, 300], [250, 500], [320, 200]]) await page.touchscreen.tap(x, y);
  assert.ok((await page.locator(".play-burst").count()) >= 1);
  assert.deepEqual(await visibleText(page), none, "/play/pon");

  await page.goto(`${base}/play/baa`);
  await page.waitForSelector(".play-peek");
  await big(".play-peek");
  assert.deepEqual(await visibleText(page), none, "/play/baa（布）");
  await page.locator(".play-peek").tap();
  await page.waitForSelector(".play-peek.open");
  assert.deepEqual(await visibleText(page), none, "/play/baa（めくった）");

  await page.goto(`${base}/play/shabon`);
  await page.waitForSelector(".play-bubble");
  await big(".play-bubble");
  const bubbles = await page.locator(".play-bubble").count();
  await page.locator(".play-bubble").first().dispatchEvent("pointerdown");
  await page.waitForSelector(".play-pop");
  assert.ok((await page.locator(".play-bubble").count()) < bubbles);
  assert.deepEqual(await visibleText(page), none, "/play/shabon");

  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(await page.evaluate(() => document.cookie), "");
  assert.deepEqual(errors, []);
  await context.close();
});

test("年表は /roadmap のページとして出る（iframe なし、X-Frame-Options: DENY のまま）", async () => {
  const response = await fetch(`${base}/roadmap`);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(base)) errors.push(`外への通信 ${r.url()}`);
  });
  await page.goto(`${base}/roadmap?today=2026-11-07`);
  await page.waitForSelector("#cond:not(:empty)");
  assert.equal(await page.locator("iframe").count(), 0);
  assert.ok((await page.textContent("#cond"))?.startsWith("上の子 1 歳 0 か月"));
  // メイン画面に入力欄なし（詳細の「済んだ」を除く）
  assert.equal(
    await page.evaluate(
      () =>
        [...document.querySelectorAll("main input, main select, main textarea")].filter(
          (e) => !e.closest("#settings-view") && !((e as HTMLInputElement).type === "checkbox" && e.closest("details.item")),
        ).length,
    ),
    0,
  );
  // 年表の棒を押すと詳細が開く。出典と確認日がある
  const id = "a-sapporo-procedures-shussho-todoke";
  await page.locator(`.el[data-id="${id}"]`).click();
  assert.equal(await page.evaluate((i) => (document.getElementById(`item-${i}`) as HTMLDetailsElement).open, id), true);
  const detail = await page.locator(`#item-${id}`).innerText();
  assert.match(detail, /確認日/);
  assert.ok((await page.locator(`#item-${id} a[href^="https://"]`).count()) >= 1);
  // 年表の色と文字は、さきよみのトークン
  const look = await page.evaluate(() => {
    const rmp = getComputedStyle(document.querySelector(".rmp")!);
    const root = getComputedStyle(document.documentElement);
    return { accent: rmp.getPropertyValue("--accent").trim(), green: root.getPropertyValue("--green").trim(), font: rmp.fontFamily, bodyFont: getComputedStyle(document.body).fontFamily };
  });
  assert.equal(look.accent, look.green);
  assert.equal(look.font, look.bodyFont);
  // 設定画面から戻る
  await page.click("#nav-link");
  await page.waitForSelector("#settings-view:not([hidden])");
  await page.click("#back-main");
  await page.waitForSelector("#main-view:not([hidden])");
  assert.deepEqual(errors, []);
  await context.close();
});
