"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ACCEPTED_EXTENSIONS,
  MAX_RECORDING_MS,
  addClip,
  cameraFailure,
  clipFileName,
  facingOf,
  formatElapsed,
  formatSize,
  getClips,
  mirrored,
  nextCamera,
  pickRecordingType,
  reachedLimit,
  removeClip,
  subscribeClips,
  switchLabel,
  videoTypeOf,
  type Clip,
  type Facing,
} from "@/lib/kagami";

// かがみ（#54、ADR 0017）: 撮っている映像を見ながら録画し、止めたらすぐ見返す。端末に保存できる。
// 映像はこの端末の外に出さない（送らない、解析しない、合成しない）。撮ったものはこのタブのメモリにだけ置く。

type Camera = "off" | "starting" | "live" | "unavailable";
// カメラを開く頼み方。最初は前のカメラを希望し、切り替えは deviceId で別のカメラを指定する。
type Target = { facingMode: Facing } | { deviceId: string };

const NO_CLIPS: readonly Clip[] = [];

function errorName(error: unknown): string {
  return error instanceof DOMException || error instanceof Error ? error.name : "";
}

function timeOf(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function Kagami() {
  const clips = useSyncExternalStore(subscribeClips, getClips, () => NO_CLIPS);
  const [camera, setCamera] = useState<Camera>("off");
  const [reason, setReason] = useState("");
  // 取得したカメラの向き。鏡写しに使う（トラックの設定に無ければ、頼んだ向きから推す）
  const [facing, setFacing] = useState<Facing | null>(null);
  // トラックの設定で確かめられた向き。切り替えのボタンの文言に使う（推した向きで「うしろ」とは書かない）
  const [knownFacing, setKnownFacing] = useState<Facing | null>(null);
  const [audio, setAudio] = useState(true);
  // 切り替えたときに使う、いまと別のカメラの deviceId
  const [otherCamera, setOtherCamera] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [latest, setLatest] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const live = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  // カメラを開く要求の番号。画面を離れた・タブが隠れた・止めた・別の要求に替わったときに進め、古い要求の結果を使わない。
  const request = useRef(0);
  // 開いたことのあるカメラの向き（deviceId ごと、トラックの設定で確かめられたものだけ）。切り替えの文言に使う。
  const facingById = useRef(new Map<string, Facing>());
  // 録画を止めたあとで止めるカメラ。録画の最後のかたまりを受け取ってから止める（先に止めると、残すものが短くなる）。
  const release = useRef<MediaStream | null>(null);

  // 録っていれば止めて、終わってからカメラを止める。録っていなければ、すぐ止める。
  function stopRecordingThenRelease(media: MediaStream | null) {
    if (!media) return;
    const rec = recorder.current;
    if (rec && rec.state === "recording") {
      release.current = media;
      rec.stop();
      // 録画の終わりの知らせが来ない環境でも、カメラを点けたままにしない。
      window.setTimeout(() => {
        if (release.current === media) {
          stopStream(media);
          release.current = null;
        }
      }, 3000);
    } else {
      stopStream(media);
    }
  }
  const cameraNow = useRef<Camera>("off");
  const latestClip = clips.find((clip) => clip.id === latest) ?? null;

  // カメラの API が無いブラウザでは、最初から動画を選ぶ形にする。
  useEffect(() => {
    mounted.current = true;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setCamera("unavailable");
      setReason("このブラウザでは、ここからカメラを使えません。");
    }
    return () => {
      mounted.current = false;
      request.current++;
      if (timer.current !== null) window.clearInterval(timer.current);
      // 録っている途中で離れたら、そこまでを残す（止めた分はメモリに入る）。カメラは録画が終わってから止める。
      stopRecordingThenRelease(stream.current);
      stream.current = null;
    };
  }, []);

  // 映像の要素は表示を切り替えると作り直されるので、そのたびにカメラをつなぎ直す。
  useEffect(() => {
    cameraNow.current = camera;
    if (camera === "live" && live.current && live.current.srcObject !== stream.current)
      live.current.srcObject = stream.current;
  });

  // タブが隠れたら、録っている途中ならそこまでを残して止め、カメラも止める。
  // 戻ったときは「カメラをつける」をもう一度押してもらう（裏のタブで上限の 2 分を過ぎて録り続けることもない）。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      // 開いている途中の要求も無効にする（あとから返ってきたカメラは、すぐ止める）。
      request.current++;
      const wasRecording = recorder.current?.state === "recording";
      const active = stream.current !== null || cameraNow.current === "starting";
      if (!active) return;
      stopRecordingThenRelease(stream.current);
      stream.current = null;
      setCamera((now) => (now === "unavailable" ? now : "off"));
      setNote(
        wasRecording
          ? "タブを離れたので、録画とカメラを止めました。撮ったところまでは残っています。"
          : "タブを離れたので、カメラを止めました。",
      );
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // カメラが途中で切れたとき（外れた、ほかのアプリに取られたなど）。録っていればそこまでを残し、「カメラをつける」に戻す。
  function lost(media: MediaStream) {
    if (stream.current !== media) return;
    stopRecordingThenRelease(media);
    stream.current = null;
    if (!mounted.current) return;
    setCamera("off");
    setNote("カメラが切れました。もう一度「カメラをつける」を押してください。");
  }

  async function open(target: Target) {
    const id = ++request.current;
    // 画面を離れた・タブが隠れた・止めた・別の要求に替わったあとなら、この要求の結果は使わない。
    const stale = () => !mounted.current || request.current !== id;
    stopStream(stream.current);
    stream.current = null;
    // 新しいカメラに対する切り替え先が決まるまで、切り替えのボタンを出さない（同じカメラを開き直さないため）。
    setOtherCamera(null);
    setCamera("starting");
    setNote("");
    const video: MediaTrackConstraints =
      "deviceId" in target ? { deviceId: { exact: target.deviceId } } : { facingMode: target.facingMode };
    let media: MediaStream;
    let withAudio = true;
    try {
      media = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch {
      // 古くなった要求なら、映像だけで取り直さない。
      if (stale()) return;
      // マイクが拒否されたら、映像だけで撮る。
      try {
        media = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        withAudio = false;
      } catch (error) {
        if (stale()) return;
        // 拒否とカメラが無いときだけ、動画を選ぶ形にする。使用中などは、もう一度押してもらう。
        const failure = cameraFailure(errorName(error));
        if (failure.fallback) {
          setCamera("unavailable");
          setReason(failure.message);
        } else {
          setCamera("off");
          setNote(failure.message);
        }
        return;
      }
    }
    // 返ってくる前に画面を離れた・タブが隠れたなら、返ってきたカメラはすぐ止める。
    if (stale()) {
      stopStream(media);
      return;
    }
    stream.current = media;
    const settings = media.getVideoTracks()[0]?.getSettings?.() ?? {};
    // 表示と鏡写しは、取得したトラックの設定から決める（facingMode は希望でしかないため）。
    setFacing(facingOf(settings.facingMode, "facingMode" in target ? target.facingMode : null));
    const known = facingOf(settings.facingMode, null);
    setKnownFacing(known);
    if (known && settings.deviceId) facingById.current.set(settings.deviceId, known);
    setAudio(withAudio);
    setCamera("live");
    for (const track of media.getTracks()) track.addEventListener("ended", () => lost(media));
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (stale() || stream.current !== media) return;
      const ids = devices.filter((d) => d.kind === "videoinput").map((d) => d.deviceId);
      setOtherCamera(nextCamera(ids, settings.deviceId));
    } catch {
      if (!stale()) setOtherCamera(null);
    }
  }

  function close() {
    if (recording) return;
    request.current++;
    stopStream(stream.current);
    stream.current = null;
    setCamera("off");
  }

  function start() {
    const media = stream.current;
    if (!media || recording) return;
    // isTypeSupported が無いブラウザでは、形式を MediaRecorder に任せる。
    const type =
      typeof MediaRecorder.isTypeSupported === "function"
        ? pickRecordingType((t) => MediaRecorder.isTypeSupported(t), audio)
        : null;
    let rec: MediaRecorder;
    try {
      rec = type ? new MediaRecorder(media, { mimeType: type }) : new MediaRecorder(media);
    } catch {
      setNote("このブラウザでは録画を始められませんでした。");
      return;
    }
    const chunks: Blob[] = [];
    const began = performance.now();
    const at = new Date();
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    // 録画の後始末。止めたとき・エラーのとき・どちらが先に来ても 1 回だけ行う。
    let finished = false;
    const finish = (failed: boolean) => {
      if (finished) return;
      finished = true;
      if (rec.state === "recording") {
        try {
          rec.stop();
        } catch {
          // 止められなくても、後始末は続ける
        }
      }
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
      if (recorder.current === rec) recorder.current = null;
      // 録画が終わったので、止めると決めていたカメラを止める。
      if (release.current) {
        stopStream(release.current);
        release.current = null;
      }
      const blobType = rec.mimeType || type || "video/webm";
      // 実際に録った長さを出す（上限で止めたときも 2:00 に丸めない）。
      const durationMs = performance.now() - began;
      if (chunks.length === 0) {
        if (mounted.current) {
          setRecording(false);
          setNote(
            failed
              ? "録画が途中で止まりました。もう一度撮ってください。"
              : "録画が空でした。もう一度撮ってください。",
          );
        }
        return;
      }
      const blob = new Blob(chunks, { type: blobType });
      const clip = addClip(blob, {
        name: clipFileName(at, blobType),
        at: at.getTime(),
        durationMs,
        source: "camera",
      });
      if (mounted.current) {
        setRecording(false);
        setLatest(clip.id);
        if (failed) setNote("録画が途中で止まりました。撮ったところまでは残っています。");
      }
    };
    // エラーのときは止めて、残りのかたまりを受け取ってから後始末する（すぐに後始末すると、残すものがほぼ空になる）。
    // 止まった知らせが来ない環境でも「録画中」のまま止まらないよう、1.5 秒で必ず後始末する。
    let failed = false;
    rec.onstop = () => finish(failed);
    rec.onerror = () => {
      failed = true;
      if (rec.state === "recording") {
        try {
          rec.stop();
        } catch {
          // 止められなければ、下の待ち時間のあとで後始末する
        }
      }
      window.setTimeout(() => finish(true), 1500);
    };
    try {
      rec.start(1000);
    } catch {
      setNote("録画を始められませんでした。カメラをつけ直して、もう一度試してください。");
      return;
    }
    recorder.current = rec;
    setRecording(true);
    setElapsed(0);
    setLatest(null);
    setNote("");
    timer.current = window.setInterval(() => {
      const ms = performance.now() - began;
      setElapsed(ms);
      if (reachedLimit(ms) && rec.state === "recording") {
        rec.stop();
        setNote(`1 本は ${formatElapsed(MAX_RECORDING_MS)} までなので、止めました。`);
      }
    }, 250);
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  // 撮り直す: いま撮ったものを消して、撮る画面に戻る。
  function retake() {
    if (latest) removeClip(latest);
    setLatest(null);
  }

  function choose(files: FileList | null) {
    const refused: string[] = [];
    for (const file of Array.from(files ?? [])) {
      const type = videoTypeOf(file.name, file.type);
      if (!type) {
        refused.push(file.name);
        continue;
      }
      // MIME が空のファイルは、拡張子から決めた形式を付けて置く。
      const blob = file.type === type ? file : new Blob([file], { type });
      addClip(blob, { name: file.name, at: Date.now(), durationMs: null, source: "file" });
    }
    setNote(
      refused.length
        ? `${refused.join("、")} は動画として開けませんでした。${ACCEPTED_EXTENSIONS.join("・")} の動画を選んでください。`
        : "",
    );
  }

  return (
    <main className="page kagami" aria-labelledby="kagami-title">
      <div className="section-heading memo-heading">
        <div>
          <span className="section-number">かがみ</span>
          <h1 id="kagami-title" className="kagami-title">
            撮って、すぐに見返す
          </h1>
        </div>
      </div>
      <p className="kagami-privacy">
        映像はこの端末の外に出ません。タブを閉じると消えます。残すときは保存してください。
      </p>

      {camera !== "unavailable" && (
        <section className="kagami-stage" aria-label="撮る">
          <div className="kagami-screen">
            {latestClip ? (
              <video
                key={latestClip.id}
                className="kagami-video"
                src={latestClip.url}
                controls
                autoPlay
                // 人のいる場所で急に音が出ないよう、消音で始める。音は利用者が出す。
                muted
                playsInline
                aria-label="いま撮った映像"
              />
            ) : camera === "live" || camera === "starting" ? (
              <video
                ref={live}
                className={mirrored(facing) ? "kagami-video mirror" : "kagami-video"}
                autoPlay
                muted
                playsInline
                aria-label="カメラの映像"
              />
            ) : (
              <div className="kagami-off">
                <p>カメラは止まっています。</p>
              </div>
            )}
            {recording && (
              <p className="kagami-rec" role="status">
                <span className="kagami-dot" aria-hidden="true" />
                録画中 {formatElapsed(elapsed)} / {formatElapsed(MAX_RECORDING_MS)}
              </p>
            )}
          </div>

          <div className="kagami-controls">
            {latestClip ? (
              <>
                <button type="button" className="secondary" onClick={retake}>
                  撮り直す
                </button>
                <a className="primary" href={latestClip.url} download={latestClip.name}>
                  端末に保存する
                </a>
                <button type="button" className="text-link" onClick={() => setLatest(null)}>
                  残して、続けて撮る
                </button>
              </>
            ) : camera === "live" ? (
              <>
                {recording ? (
                  <button type="button" className="primary kagami-stop" onClick={stop}>
                    録画を止める
                  </button>
                ) : (
                  <button type="button" className="primary kagami-start" onClick={start}>
                    録画を始める
                  </button>
                )}
                {otherCamera && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void open({ deviceId: otherCamera })}
                    disabled={recording}
                  >
                    {switchLabel(knownFacing, facingById.current.get(otherCamera) ?? null)}
                  </button>
                )}
                <button type="button" className="text-link" onClick={close} disabled={recording}>
                  カメラを止める
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => void open({ facingMode: "user" })}
                disabled={camera === "starting"}
              >
                {camera === "starting" ? "カメラを開いています…" : "カメラをつける"}
              </button>
            )}
          </div>
          {camera === "live" && !audio && (
            <p className="muted">マイクを使えないので、映像だけを録ります。</p>
          )}
          {note && (
            <p className="notice" role="status">
              {note}
            </p>
          )}
          <p className="muted">
            1 本は {formatElapsed(MAX_RECORDING_MS)} まで。録っているあいだも映像が見えます。
          </p>
        </section>
      )}

      {camera === "unavailable" && (
        <section className="kagami-stage" aria-label="動画を選ぶ">
          <p className="notice" role="status">
            {reason}端末で撮った動画を選ぶと、ここで見返せます。
          </p>
          {note && (
            <p className="notice" role="status">
              {note}
            </p>
          )}
          <label className="primary kagami-pick">
            動画を選ぶ
            <input
              className="sr-only"
              type="file"
              accept="video/*"
              capture="environment"
              multiple
              onChange={(e) => {
                choose(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </section>
      )}

      <section className="kagami-list" aria-labelledby="kagami-list-title">
        <h2 id="kagami-list-title">
          このタブで撮ったもの<span className="count">{clips.length}</span>
        </h2>
        {clips.length === 0 ? (
          <p className="foresight-empty">まだありません。撮ると、ここに並びます。</p>
        ) : (
          <ul>
            {clips.map((clip) => (
              <li key={clip.id} className="kagami-item">
                <video
                  className="kagami-thumb"
                  src={clip.url}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={`${timeOf(clip.at)} の映像`}
                />
                <div className="kagami-meta">
                  <span>
                    {clip.source === "camera" ? `${timeOf(clip.at)} に撮影` : "端末から選んだ動画"}
                    {clip.durationMs !== null && `・${formatElapsed(clip.durationMs)}`}
                    {`・${formatSize(clip.size)}`}
                  </span>
                  <span className="kagami-actions">
                    <a href={clip.url} download={clip.name}>
                      端末に保存する
                    </a>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => {
                        if (clip.id === latest) setLatest(null);
                        removeClip(clip.id);
                      }}
                    >
                      消す
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
