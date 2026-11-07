"use client";

import { useEffect, useRef, useState } from "react";
import {
  VOICE_NOTICE,
  recognitionOf,
  startVoice,
  type RecognitionConstructor,
  type VoiceSession,
} from "@/lib/voice";

function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="7"
        y="2.5"
        width="6"
        height="10"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 初めての一言を出したか。ページを開いている間だけ覚える（体験例や見通しから戻っても、もう一度は求めない）。保存はしない。
let noticeShown = false;

// 入力欄の横のマイク（#45）。PC の対応するブラウザだけに出す。
// 確定した文字は append で入力欄の末尾に足す。送信はしない（送るのは本人がボタンを押したとき）。
export function VoiceButton({
  disabled,
  append,
}: {
  disabled: boolean;
  append: (text: string) => void;
}) {
  const recognition = useRef<RecognitionConstructor | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [message, setMessage] = useState("");
  const [noticed, setNoticed] = useState(noticeShown);

  // 対応の判定はマウントのあとに行う（サーバーの描画と食い違わないように）。
  useEffect(() => {
    recognition.current = recognitionOf(window);
    setSupported(recognition.current !== null);
    return () => session.current?.abort();
  }, []);
  // 送信が始まったら、聞くのをやめる。あとから届いた文字が次の下書きに混ざらないよう、結果は捨てる。
  useEffect(() => {
    if (disabled) session.current?.abort();
  }, [disabled]);
  // 録音中は Esc でも止める。
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") session.current?.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening]);

  if (!supported) return null;

  function toggle() {
    if (listening) {
      session.current?.stop();
      return;
    }
    // 初めて押したときは、音声の送り先を先に伝える。録音は次に押したときから。
    if (!noticed) {
      noticeShown = true;
      setNoticed(true);
      return;
    }
    const Recognition = recognition.current;
    if (!Recognition) return;
    setMessage("");
    setListening(true);
    session.current = startVoice(Recognition, {
      final: append,
      interim: setInterim,
      error: setMessage,
      end: () => setListening(false),
    });
  }

  return (
    <>
      <button
        type="button"
        className="voice-button"
        aria-pressed={listening}
        aria-label="マイクで話して入力"
        onClick={toggle}
        disabled={disabled}
      >
        {listening ? (
          <span className="voice-dot" aria-hidden="true" />
        ) : (
          <MicIcon />
        )}
        話して入力
      </button>
      {(noticed || listening || interim || message) && (
        <div className="voice-status">
          {listening && (
            <p className="voice-listening" role="status">
              聞いています。もう一度押すか Esc で止まります。
            </p>
          )}
          {interim && (
            <p className="voice-interim" aria-hidden="true">
              {interim}
            </p>
          )}
          {message && (
            <p className="voice-error" role="alert">
              {message}
            </p>
          )}
          {noticed && !listening && !message && (
            <p className="voice-notice" role="status">
              {VOICE_NOTICE}
            </p>
          )}
        </div>
      )}
    </>
  );
}
