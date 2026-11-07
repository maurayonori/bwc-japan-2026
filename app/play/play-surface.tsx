"use client";

import { useEffect, useState, type ReactNode } from "react";

// あそぶの画面全体（#52、ADR 0015）。拡大・選択・長押しのメニューを止め、画面を動かさない。
// 保存、外への通信、マイク、カメラは使わない。
export function PlaySurface({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("play-mode");
    const stop = (event: Event) => event.preventDefault();
    // iPhone の Safari は viewport の拡大禁止を無視するので、ピンチの合図そのものを止める。
    const pinch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    document.addEventListener("gesturestart", stop);
    document.addEventListener("touchmove", pinch, { passive: false });
    document.addEventListener("dblclick", stop);
    return () => {
      root.classList.remove("play-mode");
      document.removeEventListener("gesturestart", stop);
      document.removeEventListener("touchmove", pinch);
      document.removeEventListener("dblclick", stop);
    };
  }, []);
  return (
    <div className="play-root" onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  );
}

// 動きを減らす設定。最初の描画では分からないので、画面に出てから読む。
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setReduced(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return reduced;
}
