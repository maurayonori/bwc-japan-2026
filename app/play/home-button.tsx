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
  // 画面のどこかに触れている指（家の指も含む）。家以外の場所にも指が触れていれば、長押しを数え直す（#64、ADR 0015）。
  const touching = useRef(new Set<number>());

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

  // 画面全体の指を数える。捕まえる前の段階で受けるので、遊びの場所が知らせを止めても数えられる。
  useEffect(() => {
    const down = (e: PointerEvent) => {
      touching.current.add(e.pointerId);
      // 家を押しているあいだに、ほかの指が触れたら取り消す（家の上でも、遊びの場所でも）
      if (frame.current !== null && !pointers.current.has(e.pointerId)) stop();
    };
    const up = (e: PointerEvent) => {
      touching.current.delete(e.pointerId);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, [stop]);

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
        // 押したまま家の外へ動かして離しても、離したこと（pointerup）が家に届くよう捕まえる（#64）。
        // 届かないと長押しが続き、外で離したのに戻ってしまう。
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 捕まえられないときも、離した・取り消した・捕まえ損ねたの知らせで取り消す
        }
        pointers.current.add(e.pointerId);
        // 家に 2 本以上、または家の外にも指が触れていれば始めない（手のひらなど）
        const elsewhere = [...touching.current].some((id) => !pointers.current.has(id));
        if (pointers.current.size > 1 || elsewhere) stop();
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
