"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { HousePicture } from "./pictures";

// 押し続けて戻るまでの時間。子どもの偶然の一押しでは戻らず、大人が待てる長さにする（#52、ADR 0015）。
export const HOLD_MS = 1500;

// 隅の家の絵。押し続けると輪が満ちていき、満ちたら戻る。途中で離すと最初から。
// 2 本以上の指が同時に触れたとき（手のひらなど）も数え直す。
export function HomeButton({ to, label }: { to: string; label: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);
  const pointers = useRef(new Set<number>());

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setProgress(0);
  }, []);

  const start = useCallback(() => {
    if (frame.current !== null) return;
    const begin = performance.now();
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - begin) / HOLD_MS);
      setProgress(ratio);
      if (ratio >= 1) {
        frame.current = null;
        router.push(to);
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [router, to]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const release = (id: number) => {
    pointers.current.delete(id);
    stop();
  };

  return (
    <button
      type="button"
      className="play-home"
      aria-label={label}
      onPointerDown={(e) => {
        // 遊びの場所に「触れた」と伝えない（家の下に形や音を出さない）。
        e.stopPropagation();
        pointers.current.add(e.pointerId);
        if (pointers.current.size > 1) stop();
        else start();
      }}
      onPointerUp={(e) => release(e.pointerId)}
      onPointerCancel={(e) => release(e.pointerId)}
      onLostPointerCapture={(e) => release(e.pointerId)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") stop();
      }}
      onBlur={stop}
      onClick={(e) => e.preventDefault()}
    >
      <svg className="play-ring" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="play-ring-track" cx="50" cy="50" r="45" />
        <circle
          className="play-ring-fill"
          cx="50"
          cy="50"
          r="45"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={1 - progress}
          opacity={progress > 0 ? 1 : 0}
        />
      </svg>
      <span className="play-home-house">
        <HousePicture />
      </span>
    </button>
  );
}
