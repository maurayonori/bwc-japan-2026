// かがみのブラウザでの検査（#54、ADR 0016）。Chromium の偽のカメラとマイクで撮る。先に next build を済ませておく。
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import { startServer } from "./server";

let browser: Browser;
let base = "";
let stop = () => {};
// 1 つ目の検査で端末に保存した動画。カメラを使えないときの検査で選ぶ。
let saved = "";

before(async () => {
  ({ base, stop } = await startServer());
  browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
});

after(async () => {
  await browser?.close();
  stop();
});

const PRIVACY = "映像はこの端末の外に出ません。タブを閉じると消えます。残すときは保存してください。";

// blob: と data: 以外の通信を数える（映像がこの端末の外に出ないこと）。
function watchRequests(page: Page) {
  const list: string[] = [];
  const on = (request: Request) => {
    if (!/^(blob|data):/.test(request.url())) list.push(request.url());
  };
  page.on("request", on);
  return { list, off: () => page.off("request", on) };
}

async function newPage(context: BrowserContext) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors };
}

async function cameraOn(page: Page) {
  await page.getByRole("button", { name: "カメラをつける" }).click();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>("video.kagami-video");
    return Boolean(video && video.videoWidth > 0);
  });
}

async function record(page: Page, ms: number) {
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(ms);
  await page.getByRole("button", { name: "録画を止める" }).click();
  await page.locator('video[aria-label="いま撮った映像"]').waitFor();
}

// 動画を音を消して再生し、進んだ秒数を返す。
async function playFor(video: ReturnType<Page["locator"]>, ms = 800) {
  return video.evaluate(async (v: HTMLVideoElement, wait: number) => {
    v.muted = true;
    await v.play();
    await new Promise((r) => setTimeout(r, wait));
    v.pause();
    return { time: v.currentTime, src: v.src };
  }, ms);
}

test("撮る・止める・すぐ再生・端末に保存・撮り直す。録画中と再生中の通信は 0。メニューを移って戻っても残る", async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["camera", "microphone"],
    acceptDownloads: true,
  });
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.waitForLoadState("networkidle");
  await page.getByText(PRIVACY).waitFor();
  // 開いただけではカメラをつけない
  assert.equal(await page.locator("video.kagami-video").count(), 0);
  await cameraOn(page);
  assert.equal(await page.getByText("マイクを使えないので").count(), 0);

  const recording = watchRequests(page);
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(2200);
  assert.match(await page.locator(".kagami-rec").innerText(), /録画中 0:0[2-3] \/ 2:00/);
  await page.getByRole("button", { name: "録画を止める" }).click();
  const preview = page.locator('video[aria-label="いま撮った映像"]');
  await preview.waitFor();
  const played = await playFor(preview);
  assert.ok(played.src.startsWith("blob:"), played.src);
  assert.ok(played.time > 0.2, String(played.time));
  recording.off();
  assert.deepEqual(recording.list, [], "録画中と、止めてすぐの再生で通信した");

  // 端末に保存する
  const download = page.waitForEvent("download");
  await page.locator(".kagami-controls").getByRole("link", { name: "端末に保存する" }).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^kagami-\d{8}-\d{6}\.(webm|mp4)$/);
  saved = join(mkdtempSync(join(tmpdir(), "kagami-")), file.suggestedFilename());
  await file.saveAs(saved);
  assert.ok(statSync(saved).size > 1000);
  assert.equal(await page.locator(".kagami-item").count(), 1);

  // 撮り直す: 2 本目を撮って、撮り直すと消える
  await page.getByRole("button", { name: "残して、続けて撮る" }).click();
  await record(page, 1200);
  assert.equal(await page.locator(".kagami-item").count(), 2);
  await page.getByRole("button", { name: "撮り直す" }).click();
  assert.equal(await page.locator(".kagami-item").count(), 1);
  await page.getByRole("button", { name: "録画を始める" }).waitFor();

  // メニューで年表へ移って戻っても残る
  const menu = page.locator('nav[aria-label="メニュー"]');
  await menu.getByRole("link", { name: "年表" }).click();
  await page.waitForURL(`${base}/roadmap`);
  await page.waitForSelector("#cond:not(:empty)");
  await menu.getByRole("link", { name: "かがみ" }).click();
  await page.waitForURL(`${base}/kagami`);
  await page.locator(".kagami-item").first().waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 1);
  // 戻ったときはカメラをつけ直すまで止まっている
  await page.getByRole("button", { name: "カメラをつける" }).waitFor();

  // 並べたものを再生しても通信しない
  const playback = watchRequests(page);
  const again = await playFor(page.locator(".kagami-item video").first());
  assert.ok(again.time > 0.2, String(again.time));
  playback.off();
  assert.deepEqual(playback.list, [], "再生中に通信した");

  // 消す
  await page.locator(".kagami-item").getByRole("button", { name: "消す" }).click();
  assert.equal(await page.locator(".kagami-item").count(), 0);
  // ブラウザの保存領域に書かない
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラが拒否されたら、動画を選ぶ形に切り替わり、選んだ動画を同じように見られる", async () => {
  assert.ok(saved, "1 つ目の検査で保存した動画が要る");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("拒否", "NotAllowedError"));
  });
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "カメラをつける" }).click();
  await page.getByText("カメラの使用が許可されませんでした。").waitFor();
  const input = page.locator('input[type="file"][accept="video/*"][capture="environment"]');
  assert.equal(await input.count(), 1);
  assert.equal(await page.getByRole("button", { name: "録画を始める" }).count(), 0);
  await input.setInputFiles(saved);
  const item = page.locator(".kagami-item");
  await item.waitFor();
  assert.match(await item.innerText(), /端末から選んだ動画/);
  const watching = watchRequests(page);
  const played = await playFor(item.locator("video"));
  assert.ok(played.time > 0.2, String(played.time));
  watching.off();
  assert.deepEqual(watching.list, []);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラの API が無いブラウザでは、開いたときから動画を選ぶ形にする", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  });
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.getByText("このブラウザでは、ここからカメラを使えません。").waitFor();
  assert.equal(await page.locator('input[type="file"][accept="video/*"][capture="environment"]').count(), 1);
  assert.equal(await page.getByRole("button", { name: "カメラをつける" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("マイクが拒否されたら映像だけで撮る。カメラが 2 つあれば前とうしろを切り替えられる", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    permissions: ["camera"],
  });
  // 変換の補助（__name など）が入らないよう、ブラウザで動かすスクリプトは文字列で渡す。
  await context.addInitScript(`
    (() => {
      const media = navigator.mediaDevices;
      const original = media.getUserMedia.bind(media);
      const asked = [];
      window.asked = asked;
      media.getUserMedia = function (constraints) {
        const video = constraints && constraints.video;
        asked.push(String((video && video.facingMode) || ""));
        if (constraints && constraints.audio) return Promise.reject(new DOMException("拒否", "NotAllowedError"));
        return original(constraints);
      };
      const list = media.enumerateDevices.bind(media);
      media.enumerateDevices = async function () {
        const devices = await list();
        return devices.concat([{ deviceId: "back", groupId: "g", kind: "videoinput", label: "" }]);
      };
    })();
  `);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await cameraOn(page);
  await page.getByText("マイクを使えないので、映像だけを録ります。").waitFor();
  // 前のカメラは鏡のように左右を返して見せる
  assert.match((await page.locator("video.kagami-video").getAttribute("class")) ?? "", /mirror/);
  await page.getByRole("button", { name: "うしろのカメラにする" }).click();
  await page.getByRole("button", { name: "前のカメラにする" }).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>("video.kagami-video");
    return Boolean(video && video.videoWidth > 0);
  });
  assert.doesNotMatch((await page.locator("video.kagami-video").getAttribute("class")) ?? "", /mirror/);
  const asked = await page.evaluate(() => (window as unknown as { asked: string[] }).asked);
  assert.deepEqual(asked, ["user", "user", "environment", "environment"]);
  await record(page, 1200);
  const clip = await page.locator('video[aria-label="いま撮った映像"]').evaluate((v: HTMLVideoElement) => v.src);
  assert.ok(clip.startsWith("blob:"));
  assert.equal(await page.locator(".kagami-item").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});
