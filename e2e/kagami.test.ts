// かがみのブラウザでの検査（#54、ADR 0016）。Chromium の偽のカメラとマイクで撮る。先に next build を済ませておく。
// ブラウザで動かすスクリプトは文字列で渡す（TypeScript の変換の補助 __name がブラウザに無いため）。
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from "playwright";
import { startServer } from "./server";

let browser: Browser;
let base = "";
let stop = () => {};

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

// カメラから得たストリームを window.__streams に控える（止めたかどうかを確かめるため）。
const KEEP_STREAMS = `
  (() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    const original = media.getUserMedia.bind(media);
    window.__streams = [];
    media.getUserMedia = function (constraints) {
      return original(constraints).then(function (stream) {
        window.__streams.push(stream);
        return stream;
      });
    };
  })();
`;

// blob: と data: 以外の通信を数える（映像がこの端末の外に出ないこと）。
function watchRequests(page: Page) {
  const list: string[] = [];
  const on = (request: Request) => {
    if (!/^(blob|data):/.test(request.url())) list.push(request.url());
  };
  page.on("request", on);
  return { list, off: () => page.off("request", on) };
}

// ブラウザの保存領域がすべて空か（localStorage・sessionStorage・IndexedDB・Cache Storage）。
async function storage(page: Page) {
  return page.evaluate(`(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }))()`);
}
const EMPTY = { local: 0, session: 0, indexedDB: 0, caches: 0 };

async function newPage(context: BrowserContext) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors };
}

async function cameraOn(page: Page) {
  await page.getByRole("button", { name: "カメラをつける" }).click();
  await page.waitForFunction(`(() => {
    const video = document.querySelector("video.kagami-video");
    return Boolean(video && video.videoWidth > 0);
  })()`);
}

async function record(page: Page, ms: number) {
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(ms);
  await page.getByRole("button", { name: "録画を止める" }).click();
  await page.locator('video[aria-label="いま撮った映像"]').waitFor();
}

// 動画を音を消して再生し、進んだ秒数を返す。
async function playFor(video: Locator, ms = 800) {
  return video.evaluate(async (v: HTMLVideoElement, wait: number) => {
    v.muted = true;
    await v.play();
    await new Promise((r) => setTimeout(r, wait));
    v.pause();
    return { time: v.currentTime, src: v.src };
  }, ms);
}

// 検査に使う短い動画を、このテストの中で作る（ほかの検査の結果に頼らない）。キャンバスを MediaRecorder で録る。
async function makeVideo(): Promise<Buffer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/roadmap`);
  const encoded = (await page.evaluate(`(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(200);
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = i % 2 ? "#2c5c4d" : "#f2b84b";
      ctx.fillRect(0, 0, 160, 120);
      await new Promise((r) => setTimeout(r, 60));
    }
    rec.stop();
    await done;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text);
  })()`)) as string;
  await context.close();
  return Buffer.from(encoded, "base64");
}

test("撮る・止める・消音のプレビュー・再生・端末に保存・撮り直す。操作のあいだ通信 0、保存領域は空。メニューで移っても残る", async () => {
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

  // ここから、かがみの操作の終わりまで、通信を 1 つの見張りで数える
  const network = watchRequests(page);
  await cameraOn(page);
  assert.equal(await page.getByText("マイクを使えないので").count(), 0);
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(2200);
  assert.match(await page.locator(".kagami-rec").innerText(), /録画中 0:0[2-3] \/ 2:00/);
  await page.getByRole("button", { name: "録画を止める" }).click();
  const preview = page.locator('video[aria-label="いま撮った映像"]');
  await preview.waitFor();
  // 撮った直後のプレビューは消音で始め、操作の部品を出す
  assert.deepEqual(
    await preview.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, controls: v.controls })),
    { muted: true, controls: true },
  );
  const played = await playFor(preview);
  assert.ok(played.src.startsWith("blob:"), played.src);
  assert.ok(played.time > 0.2, String(played.time));

  // 端末に保存する
  const download = page.waitForEvent("download");
  await page.locator(".kagami-controls").getByRole("link", { name: "端末に保存する" }).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^kagami-\d{8}-\d{6}\.(webm|mp4)$/);
  const saved = join(mkdtempSync(join(tmpdir(), "kagami-")), file.suggestedFilename());
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
  // 並べたものを再生する
  const again = await playFor(page.locator(".kagami-item video").first());
  assert.ok(again.time > 0.2, String(again.time));
  await page.getByRole("button", { name: "カメラを止める" }).click();
  network.off();
  assert.deepEqual(network.list, [], "かがみの操作のあいだに通信した");
  assert.deepEqual(await storage(page), EMPTY);

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

  // 消す
  await page.locator(".kagami-item").getByRole("button", { name: "消す" }).click();
  assert.equal(await page.locator(".kagami-item").count(), 0);
  assert.deepEqual(await storage(page), EMPTY);
  assert.deepEqual(errors, []);
  await context.close();
});

test("タブが隠れたら、録画を止めてそこまでを残し、カメラのトラックも止める。戻ったら「カメラをつける」から", async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["camera", "microphone"],
  });
  await context.addInitScript(KEEP_STREAMS);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.waitForLoadState("networkidle");
  const network = watchRequests(page);
  await cameraOn(page);
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(1500);
  // タブが隠れたことにする
  await page.evaluate(`(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
  await page.getByText("タブを離れたので、録画とカメラを止めました。撮ったところまでは残っています。").waitFor();
  await page.locator(".kagami-item").first().waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 1);
  assert.equal(await page.locator(".kagami-rec").count(), 0);
  // カメラとマイクのトラックがすべて止まっている
  const tracks = (await page.evaluate(`window.__streams.flatMap((s) => s.getTracks().map((t) => t.readyState))`)) as string[];
  assert.ok(tracks.length >= 2, JSON.stringify(tracks));
  assert.ok(tracks.every((state) => state === "ended"), JSON.stringify(tracks));
  // 残ったものは再生できる
  const played = await playFor(page.locator(".kagami-item video").first());
  assert.ok(played.time > 0.2, String(played.time));
  // 戻ったら、もう一度押してつける
  await page.evaluate(`(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
  await page.getByRole("button", { name: "残して、続けて撮る" }).click();
  await cameraOn(page);
  await page.getByRole("button", { name: "録画を始める" }).waitFor();
  network.off();
  assert.deepEqual(network.list, []);
  assert.deepEqual(await storage(page), EMPTY);
  assert.deepEqual(errors, []);
  await context.close();
});

test("2 分に達したら、自動で録画を止めて残す", async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["camera", "microphone"],
  });
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.waitForLoadState("networkidle");
  // 時計を差し替えて、2 分を待たずに進める
  await page.clock.install();
  await cameraOn(page);
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.clock.runFor(119_000);
  assert.match(await page.locator(".kagami-rec").innerText(), /録画中 1:5[89] \/ 2:00/);
  assert.equal(await page.locator(".kagami-item").count(), 0);
  await page.clock.runFor(1_500);
  await page.getByText("1 本は 2:00 までなので、止めました。").waitFor();
  await page.locator(".kagami-item").first().waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 1);
  assert.equal(await page.locator(".kagami-rec").count(), 0);
  assert.match(await page.locator(".kagami-meta").first().innerText(), /2:00/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラが拒否されたら、動画を選ぶ形に切り替わる。選んだ動画を見られ、MIME が空でも拡張子で受け、動画でないものは断る", async () => {
  const video = await makeVideo();
  const dir = mkdtempSync(join(tmpdir(), "kagami-pick-"));
  const path = join(dir, "pick.webm");
  writeFileSync(path, video);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.addInitScript(`
    navigator.mediaDevices.getUserMedia = function () {
      return Promise.reject(new DOMException("拒否", "NotAllowedError"));
    };
  `);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.waitForLoadState("networkidle");
  const network = watchRequests(page);
  await page.getByRole("button", { name: "カメラをつける" }).click();
  await page.getByText("カメラの使用が許可されませんでした。").waitFor();
  const input = page.locator('input[type="file"][accept="video/*"][capture="environment"]');
  assert.equal(await input.count(), 1);
  assert.equal(await page.getByRole("button", { name: "録画を始める" }).count(), 0);
  await input.setInputFiles(path);
  const item = page.locator(".kagami-item");
  await item.waitFor();
  assert.match(await item.innerText(), /端末から選んだ動画/);
  const played = await playFor(item.locator("video"));
  assert.ok(played.time > 0.2, String(played.time));
  // MIME が空でも、拡張子が動画なら受ける。動画でないものは断る
  await input.setInputFiles([
    { name: "IMG_0001.MOV", mimeType: "", buffer: video },
    { name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
  ]);
  await page.getByText("memo.txt は動画として開けませんでした。mp4・m4v・mov・webm の動画を選んでください。").waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 2);
  assert.equal(await page.locator(".kagami-item a[download='IMG_0001.MOV']").count(), 1);
  network.off();
  assert.deepEqual(network.list, []);
  assert.deepEqual(await storage(page), EMPTY);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラが使用中なら、動画を選ぶ形にせず「カメラをつける」に戻して、閉じてから押すよう伝える", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(`
    navigator.mediaDevices.getUserMedia = function () {
      return Promise.reject(new DOMException("使用中", "NotReadableError"));
    };
  `);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.getByRole("button", { name: "カメラをつける" }).click();
  await page.getByText("ほかのアプリがカメラを使っているかもしれません。閉じてから、もう一度押してください。").waitFor();
  await page.getByRole("button", { name: "カメラをつける" }).waitFor();
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラの API が無いブラウザでは、開いたときから動画を選ぶ形にする", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(`Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });`);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.getByText("このブラウザでは、ここからカメラを使えません。").waitFor();
  assert.equal(await page.locator('input[type="file"][accept="video/*"][capture="environment"]').count(), 1);
  assert.equal(await page.getByRole("button", { name: "カメラをつける" }).count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("マイクが拒否されたら映像だけで撮る。カメラが 2 つあれば前とうしろを切り替える。isTypeSupported が無くても撮れる", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    permissions: ["camera"],
  });
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
      MediaRecorder.isTypeSupported = undefined;
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
  await page.waitForFunction(`(() => {
    const video = document.querySelector("video.kagami-video");
    return Boolean(video && video.videoWidth > 0);
  })()`);
  assert.doesNotMatch((await page.locator("video.kagami-video").getAttribute("class")) ?? "", /mirror/);
  const asked = await page.evaluate(`window.asked`);
  assert.deepEqual(asked, ["user", "user", "environment", "environment"]);
  await record(page, 1200);
  const clip = await page.locator('video[aria-label="いま撮った映像"]').evaluate((v: HTMLVideoElement) => v.src);
  assert.ok(clip.startsWith("blob:"));
  assert.equal(await page.locator(".kagami-item").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});
