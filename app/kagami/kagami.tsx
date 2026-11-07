"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  MAX_RECORDING_MS,
  addClip,
  clipFileName,
  formatElapsed,
  formatSize,
  getClips,
  pickRecordingType,
  removeClip,
  subscribeClips,
  type Clip,
} from "@/lib/kagami";

// かがみ（#54、ADR 0016）: 撮っている映像を見ながら録画し、止めたらすぐ見返す。端末に保存できる。
// 映像はこの端末の外に出さない（送らない、解析しない、合成しない）。撮ったものはこのタブのメモリにだけ置く。

type Facing = "user" | "environment";
type Camera = "off" | "starting" | "live" | "unavailable";

const NO_CLIPS: readonly Clip[] = [];

function reasonOf(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "カメラの使用が許可されませんでした。";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "カメラが見つかりませんでした。";
  if (name === "NotReadableError") return "カメラをほかのアプリが使っているため、開けませんでした。";
  return "カメラを開けませんでした。";
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
  const [facing, setFacing] = useState<Facing>("user");
  const [audio, setAudio] = useState(true);
  const [canSwitch, setCanSwitch] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [latest, setLatest] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const live = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
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
      if (timer.current !== null) window.clearInterval(timer.current);
      // 録っている途中で離れたら、そこまでを残す（止めた分はメモリに入る）。
      if (recorder.current?.state === "recording") recorder.current.stop();
      stopStream(stream.current);
      stream.current = null;
    };
  }, []);

  // 映像の要素は表示を切り替えると作り直されるので、そのたびにカメラをつなぎ直す。
  useEffect(() => {
    if (camera === "live" && live.current && live.current.srcObject !== stream.current)
      live.current.srcObject = stream.current;
  });

  async function open(next: Facing) {
    stopStream(stream.current);
    stream.current = null;
    setCamera("starting");
    setNote("");
    const video = { facingMode: next };
    let media: MediaStream;
    let withAudio = true;
    try {
      media = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch {
      // マイクが拒否されたら、映像だけで撮る。
      try {
        media = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        withAudio = false;
      } catch (error) {
        if (!mounted.current) return;
        setCamera("unavailable");
        setReason(reasonOf(error));
        return;
      }
    }
    if (!mounted.current) {
      stopStream(media);
      return;
    }
    stream.current = media;
    setFacing(next);
    setAudio(withAudio);
    setCamera("live");
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (mounted.current)
        setCanSwitch(devices.filter((d) => d.kind === "videoinput").length > 1);
    } catch {
      setCanSwitch(false);
    }
  }

  function close() {
    if (recording) return;
    stopStream(stream.current);
    stream.current = null;
    setCamera("off");
  }

  function start() {
    const media = stream.current;
    if (!media || recording) return;
    const type = pickRecordingType((t) => MediaRecorder.isTypeSupported(t), audio);
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
    rec.onstop = () => {
      const blobType = rec.mimeType || type || "video/webm";
      const durationMs = Math.min(MAX_RECORDING_MS, performance.now() - began);
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
      recorder.current = null;
      if (chunks.length === 0) {
        if (mounted.current) {
          setRecording(false);
          setNote("録画が空でした。もう一度撮ってください。");
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
      }
    };
    recorder.current = rec;
    rec.start(1000);
    setRecording(true);
    setElapsed(0);
    setLatest(null);
    setNote("");
    timer.current = window.setInterval(() => {
      const ms = performance.now() - began;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS && rec.state === "recording") {
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
    for (const file of Array.from(files ?? [])) {
      if (!file.type.startsWith("video/") && file.type !== "") continue;
      addClip(file, { name: file.name, at: Date.now(), durationMs: null, source: "file" });
    }
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
                playsInline
                aria-label="いま撮った映像"
              />
            ) : camera === "live" || camera === "starting" ? (
              <video
                ref={live}
                className={facing === "user" ? "kagami-video mirror" : "kagami-video"}
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
                {canSwitch && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void open(facing === "user" ? "environment" : "user")}
                    disabled={recording}
                  >
                    {facing === "user" ? "うしろのカメラにする" : "前のカメラにする"}
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
                onClick={() => void open(facing)}
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
