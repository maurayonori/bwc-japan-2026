// かがみのブラウザでの検査（#54、ADR 0017）。Chromium の偽のカメラとマイクで撮る。先に next build を済ませておく。
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

// 保存の呼び出しそのものを記録する（localStorage・sessionStorage の setItem、indexedDB.open、caches.open）。
const COUNT_WRITES = `
  (() => {
    window.__writes = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      window.__writes.push((this === window.localStorage ? "localStorage" : "sessionStorage") + ".setItem " + key);
      return setItem.call(this, key, value);
    };
    if (window.indexedDB) {
      const open = window.indexedDB.open.bind(window.indexedDB);
      window.indexedDB.open = function (name, version) {
        window.__writes.push("indexedDB.open " + name);
        return open(name, version);
      };
    }
    if (window.caches) {
      const openCache = window.caches.open.bind(window.caches);
      window.caches.open = function (name) {
        window.__writes.push("caches.open " + name);
        return openCache(name);
      };
    }
  })();
`;
const writes = (page: Page) => page.evaluate(`window.__writes`) as Promise<string[]>;

// blob: と data: 以外の通信を数える（映像がこの端末の外に出ないこと）。
function watchRequests(page: Page) {
  const list: string[] = [];
  const on = (request: Request) => {
    if (!/^(blob|data):/.test(request.url())) list.push(request.url());
  };
  page.on("request", on);
  return { list, off: () => page.off("request", on) };
}

// 通信をすべて記録する（方式・行き先・本文の有無）。メニューで移るときのページの読み込みと見分けるため。
function watchAll(page: Page) {
  const list: { method: string; url: string; body: boolean }[] = [];
  const on = (request: Request) => {
    if (/^(blob|data):/.test(request.url())) return;
    list.push({ method: request.method(), url: request.url(), body: request.postDataBuffer() !== null });
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

// 並べたものの 1 本目の大きさ（バイト）。blob: を読むだけで、外へは出ない。
async function firstClipSize(page: Page): Promise<number> {
  return (await page.evaluate(`(async () => {
    const video = document.querySelector(".kagami-item video");
    return (await (await fetch(video.src)).blob()).size;
  })()`)) as number;
}

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
  await context.addInitScript(COUNT_WRITES);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.waitForLoadState("networkidle");
  await page.getByText(PRIVACY).waitFor();
  // 開いただけではカメラをつけない
  assert.equal(await page.locator("video.kagami-video").count(), 0);

  // ここから「消す」まで、通信を 1 つの見張りで記録する
  const network = watchAll(page);
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
  // 写しで比べる（元の配列を空の型に絞り込ませない）
  assert.deepEqual([...network.list], [], "かがみの操作のあいだに通信した");
  assert.deepEqual(await storage(page), EMPTY);
  assert.deepEqual(await writes(page), [], "保存の呼び出しがあった");

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
  await page.waitForLoadState("networkidle");
  // 移るあいだの通信は、このサイトの年表とかがみのページと、その部品（/_next/static/）の読み込み（本文の無い GET）だけ
  const moving = network.list.length;
  for (const request of network.list) {
    const url = new URL(request.url);
    assert.equal(url.origin, base, request.url);
    assert.equal(request.method, "GET", request.url);
    assert.equal(request.body, false, request.url);
    assert.ok(["/roadmap", "/kagami"].includes(url.pathname) || url.pathname.startsWith("/_next/static/"), request.url);
  }

  // 並べたものを再生して、消す
  const back = await playFor(page.locator(".kagami-item video").first());
  assert.ok(back.time > 0.2, String(back.time));
  await page.locator(".kagami-item").getByRole("button", { name: "消す" }).click();
  assert.equal(await page.locator(".kagami-item").count(), 0);
  network.off();
  assert.equal(network.list.length, moving, `戻ってから消すまでに通信した: ${JSON.stringify(network.list.slice(moving))}`);
  assert.deepEqual(await storage(page), EMPTY);
  assert.deepEqual(await writes(page), [], "保存の呼び出しがあった");
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
  await page.waitForTimeout(1600);
  // タブが隠れたことにする
  await page.evaluate(`(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
  await page.getByText("タブを離れたので、録画とカメラを止めました。撮ったところまでは残っています。").waitFor();
  await page.locator(".kagami-item").first().waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 1);
  // 最後のかたまりまで残っている（カメラを先に止めると、1 秒ごとのかたまりの分しか残らない）
  // 約 1.6 秒で、偽のカメラでは約 110KB になる。ほぼ空にならないことを確かめる
  const hiddenSize = await firstClipSize(page);
  assert.ok(hiddenSize > 60_000, String(hiddenSize));
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
  // 裏で遅れたときのように、上限を十分に越えるところまで一気に進める（確かめる処理は 1 回だけ走る）
  await page.clock.fastForward(6_000);
  await page.getByText("1 本は 2:00 までなので、止めました。").waitFor();
  await page.locator(".kagami-item").first().waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 1);
  assert.equal(await page.locator(".kagami-rec").count(), 0);
  // 長さは 2:00 に丸めず、実際に録った長さ（2 分 5 秒）を出す
  assert.match(await page.locator(".kagami-meta").first().innerText(), /・2:05・/);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラが拒否されたら、動画を選ぶ形に切り替わる。選んだ動画を見られ、MIME が空でも拡張子で受け、動画でないものは断る", async () => {
  const video = await makeVideo();
  const dir = mkdtempSync(join(tmpdir(), "kagami-pick-"));
  const path = join(dir, "pick.webm");
  writeFileSync(path, video);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.addInitScript(COUNT_WRITES);
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
  assert.deepEqual(await writes(page), []);
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

test("マイクが拒否されたら映像だけで撮る。isTypeSupported が無くても撮れる", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    permissions: ["camera"],
  });
  await context.addInitScript(`
    (() => {
      const media = navigator.mediaDevices;
      const original = media.getUserMedia.bind(media);
      media.getUserMedia = function (constraints) {
        if (constraints && constraints.audio) return Promise.reject(new DOMException("拒否", "NotAllowedError"));
        return original(constraints);
      };
      MediaRecorder.isTypeSupported = undefined;
    })();
  `);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await cameraOn(page);
  await page.getByText("マイクを使えないので、映像だけを録ります。").waitFor();
  // 前のカメラを頼んで開き、向きが分からないときは前のカメラとして鏡のように見せる
  assert.match((await page.locator("video.kagami-video").getAttribute("class")) ?? "", /mirror/);
  // カメラが 1 つなら切り替えのボタンは出さない
  assert.equal(await page.getByRole("button", { name: /カメラにする$/ }).count(), 0);
  await record(page, 1200);
  const clip = await page.locator('video[aria-label="いま撮った映像"]').evaluate((v: HTMLVideoElement) => v.src);
  assert.ok(clip.startsWith("blob:"));
  assert.equal(await page.locator(".kagami-item").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラが 2 つあれば deviceId で切り替える。取得元が変わり、前のトラックは止まる", async () => {
  // 偽のカメラを 2 つにしたブラウザで確かめる
  const two = await chromium.launch({
    args: ["--use-fake-device-for-media-stream=device-count=2", "--use-fake-ui-for-media-stream"],
  });
  try {
    const context = await two.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"] });
    await context.addInitScript(KEEP_STREAMS);
    // カメラの一覧の取得を 1.5 秒遅らせる（切り替え先が決まるまでのあいだを作る）
    await context.addInitScript(`
      (() => {
        const media = navigator.mediaDevices;
        const list = media.enumerateDevices.bind(media);
        media.enumerateDevices = function () {
          return new Promise(function (resolve, reject) {
            setTimeout(function () { list().then(resolve, reject); }, 1500);
          });
        };
      })();
    `);
    const { page, errors } = await newPage(context);
    await page.goto(`${base}/kagami`);
    await cameraOn(page);
    const first = (await page.evaluate(`window.__streams[0].getVideoTracks()[0].getSettings().deviceId`)) as string;
    assert.match((await page.locator("video.kagami-video").getAttribute("class")) ?? "", /mirror/);
    // 偽のカメラは向きを持たないので「ほかのカメラ」
    await page.getByRole("button", { name: "ほかのカメラにする" }).click();
    await page.waitForFunction(`window.__streams.length === 2 && window.__streams[1].getVideoTracks()[0].readyState === "live"`);
    // 新しいカメラに対する切り替え先が決まるまで（一覧の取得を待つあいだ）は、ボタンを出さない
    await page.waitForFunction(`(() => {
      const video = document.querySelector("video.kagami-video");
      return Boolean(video && video.srcObject === window.__streams[1]);
    })()`);
    assert.equal(await page.getByRole("button", { name: /カメラにする$/ }).count(), 0, "切り替え先が決まる前にボタンが出た");
    await page.getByRole("button", { name: "ほかのカメラにする" }).waitFor();
    await page.waitForFunction(`(() => {
      const video = document.querySelector("video.kagami-video");
      return Boolean(video && video.videoWidth > 0 && video.srcObject === window.__streams[1]);
    })()`);
    const after = (await page.evaluate(`({
      id: window.__streams[1].getVideoTracks()[0].getSettings().deviceId,
      old: window.__streams[0].getTracks().map((t) => t.readyState),
    })`)) as { id: string; old: string[] };
    assert.notEqual(after.id, first, "取得元が変わっていない");
    assert.ok(after.old.length > 0 && after.old.every((state) => state === "ended"), JSON.stringify(after.old));
    // 向きが分からないカメラは鏡写しにしない
    assert.doesNotMatch((await page.locator("video.kagami-video").getAttribute("class")) ?? "", /mirror/);
    // もう一度押すと最初のカメラに戻る
    await page.getByRole("button", { name: "ほかのカメラにする" }).click();
    await page.waitForFunction(`window.__streams.length === 3 && window.__streams[2].getVideoTracks()[0].readyState === "live"`);
    // 取得元は A → B → A の順で、同じカメラを続けて開き直さない
    const ids = (await page.evaluate(`window.__streams.map((s) => s.getVideoTracks()[0].getSettings().deviceId)`)) as string[];
    assert.deepEqual(ids, [first, after.id, first]);
    await page.getByRole("button", { name: "ほかのカメラにする" }).waitFor();
    await record(page, 1000);
    assert.equal(await page.locator(".kagami-item").count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await two.close();
  }
});

test("カメラを取る途中で画面を離れたら取り直さず、タブが隠れたあとに返ってきたカメラはすぐ止める", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
  // getUserMedia を 0.8 秒遅らせる。最初の方式では、音声つきの要求を遅れて断る
  await context.addInitScript(`
    (() => {
      const media = navigator.mediaDevices;
      const original = media.getUserMedia.bind(media);
      window.__calls = [];
      window.__streams = [];
      window.__mode = "deny-audio-late";
      media.getUserMedia = function (constraints) {
        const audio = Boolean(constraints && constraints.audio);
        window.__calls.push(audio);
        const mode = window.__mode;
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            if (mode === "deny-audio-late" && audio) {
              reject(new DOMException("拒否", "NotAllowedError"));
              return;
            }
            original(constraints).then(function (stream) {
              window.__streams.push(stream);
              resolve(stream);
            }, reject);
          }, 800);
        });
      };
    })();
  `);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await page.waitForLoadState("networkidle");
  // 1. 取る途中で画面を離れたら、映像だけで取り直さない
  await page.getByRole("button", { name: "カメラをつける" }).click();
  await page.locator('nav[aria-label="メニュー"]').getByRole("link", { name: "年表" }).click();
  await page.waitForURL(`${base}/roadmap`);
  await page.waitForTimeout(1500);
  assert.deepEqual(await page.evaluate(`window.__calls`), [true], "画面を離れたあとに取り直した");
  // 2. 取る途中でタブが隠れたら、あとから返ってきたカメラはすぐ止める
  await page.locator('nav[aria-label="メニュー"]').getByRole("link", { name: "かがみ" }).click();
  await page.waitForURL(`${base}/kagami`);
  await page.evaluate(`window.__mode = "late"`);
  await page.getByRole("button", { name: "カメラをつける" }).click();
  await page.evaluate(`(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
  await page.waitForFunction(`window.__streams.length === 1`);
  await page.waitForTimeout(300);
  const states = (await page.evaluate(`window.__streams[0].getTracks().map((t) => t.readyState)`)) as string[];
  assert.ok(states.length > 0 && states.every((s) => s === "ended"), JSON.stringify(states));
  await page.getByRole("button", { name: "カメラをつける" }).waitFor();
  assert.equal(await page.locator("video.kagami-video").count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test("カメラが途中で切れたら、録っていたところまでを残して「カメラをつける」に戻り、つけ直せる", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
  await context.addInitScript(KEEP_STREAMS);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await cameraOn(page);
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(1600);
  // カメラが外れたことにする
  await page.evaluate(`window.__streams[0].getVideoTracks()[0].dispatchEvent(new Event("ended"))`);
  await page.getByText("カメラが切れました。もう一度「カメラをつける」を押してください。").waitFor();
  await page.locator(".kagami-item").first().waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 1);
  const lostSize = await firstClipSize(page);
  assert.ok(lostSize > 60_000, String(lostSize));
  const states = (await page.evaluate(`window.__streams[0].getTracks().map((t) => t.readyState)`)) as string[];
  assert.ok(states.every((s) => s === "ended"), JSON.stringify(states));
  // 取り直せる
  await page.getByRole("button", { name: "残して、続けて撮る" }).click();
  await cameraOn(page);
  await page.getByRole("button", { name: "録画を始める" }).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test("録画がエラーで止まったら、録画中の表示とタイマーを片付け、撮ったところまでを 1 本だけ残す", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
  // 作られた MediaRecorder を控える（エラーを起こすため）
  await context.addInitScript(`
    (() => {
      const Original = window.MediaRecorder;
      window.__recorders = [];
      function Recorder(stream, options) {
        const recorder = options ? new Original(stream, options) : new Original(stream);
        window.__recorders.push(recorder);
        return recorder;
      }
      Recorder.prototype = Original.prototype;
      Recorder.isTypeSupported = Original.isTypeSupported.bind(Original);
      window.MediaRecorder = Recorder;
    })();
  `);
  const { page, errors } = await newPage(context);
  await page.goto(`${base}/kagami`);
  await cameraOn(page);
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(1600);
  await page.evaluate(`window.__recorders[0].dispatchEvent(new Event("error"))`);
  await page.getByText("録画が途中で止まりました。撮ったところまでは残っています。").waitFor();
  // 録画中の表示が消え、タイマーも止まる（経過時間の表示が無い）
  assert.equal(await page.locator(".kagami-rec").count(), 0);
  await page.waitForFunction(`window.__recorders[0].state === "inactive"`);
  await page.waitForTimeout(600);
  // 止めたときの知らせが遅れて来ても、2 本にならない
  assert.equal(await page.locator(".kagami-item").count(), 1);
  await page.locator('video[aria-label="いま撮った映像"]').waitFor();
  // 止めて残りを受け取ってから残すので、ほぼ空にならない（約 1.6 秒で約 110KB）
  const errorSize = await firstClipSize(page);
  assert.ok(errorSize > 60_000, String(errorSize));
  // 次の録画を始められる
  await page.getByRole("button", { name: "残して、続けて撮る" }).click();
  await page.getByRole("button", { name: "録画を始める" }).waitFor();

  // 止まった知らせが来ない環境でも、1.5 秒で「録画中」を片付ける
  await page.getByRole("button", { name: "録画を始める" }).click();
  await page.locator(".kagami-rec").waitFor();
  await page.waitForTimeout(1300);
  await page.evaluate(`(() => {
    const recorder = window.__recorders[1];
    recorder.stop = function () {};
    recorder.dispatchEvent(new Event("error"));
  })()`);
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".kagami-rec").count(), 1, "知らせを待つあいだに片付けた");
  await page.locator(".kagami-rec").waitFor({ state: "detached", timeout: 3000 });
  await page.getByText("録画が途中で止まりました。").waitFor();
  assert.equal(await page.locator(".kagami-item").count(), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

