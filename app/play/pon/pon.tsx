"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { HomeButton } from "../home-button";
import { noteAt, useSound } from "../sound";

// ぽん: 画面のどこに触れても、そこに形が広がり、やさしい音が鳴る。
// 指を何本置いても、手のひらで触れても、それぞれの場所で動く。失敗も得点も時間制限も無い。
const COLORS = [
  "var(--play-sun)",
  "var(--play-coral)",
  "var(--play-sky)",
  "var(--play-green)",
  "var(--play-plum)",
  "var(--play-leaf)",
] as const;
const SHAPES = ["circle", "flower", "star"] as const;
type Shape = (typeof SHAPES)[number];

interface Burst {
  id: number;
  x: number;
  y: number;
  size: number;
  color: string;
  shape: Shape;
}

// 同時に出しておく形の上限（手のひらで触れ続けても重くならないように）。
const MAX_BURSTS = 48;
const LIFE_MS = 1100;
// 指を動かしたとき、この距離ごとに小さな形を足す。
const TRAIL_PX = 64;

function ShapePicture({ shape }: { shape: Shape }) {
  if (shape === "circle")
    return (
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle cx="50" cy="50" r="46" fill="currentColor" />
        <circle cx="50" cy="50" r="24" fill="var(--play-paper)" opacity="0.35" />
      </svg>
    );
  if (shape === "flower")
    return (
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        {[0, 60, 120, 180, 240, 300].map((deg) => (
          <ellipse
            key={deg}
            cx="50"
            cy="24"
            rx="16"
            ry="22"
            fill="currentColor"
            transform={`rotate(${deg} 50 50)`}
          />
        ))}
        <circle cx="50" cy="50" r="15" fill="var(--play-paper)" opacity="0.6" />
      </svg>
    );
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path
        d="M50 6l12 30 32 2-25 20 9 32-28-18-28 18 9-32L6 38l32-2z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Pon() {
  const play = useSound();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [touched, setTouched] = useState(false);
  const nextId = useRef(0);
  const trails = useRef(new Map<number, { x: number; y: number }>());
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  function spawn(x: number, y: number, small: boolean) {
    const id = nextId.current++;
    const burst: Burst = {
      id,
      x,
      y,
      size: small ? 64 + Math.random() * 40 : 120 + Math.random() * 90,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
    };
    setBursts((prev) => [...prev.slice(-(MAX_BURSTS - 1)), burst]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setBursts((prev) => prev.filter((b) => b.id !== id));
    }, LIFE_MS);
    timers.current.add(timer);
  }

  function place(e: PointerEvent<HTMLElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - box.left,
      y: e.clientY - box.top,
      rx: (e.clientX - box.left) / Math.max(1, box.width),
      ry: (e.clientY - box.top) / Math.max(1, box.height),
    };
  }

  return (
    <main
      className="play-field play-pon"
      aria-label="ぽん。どこに触れても、形が広がって音が鳴る"
      onPointerDown={(e) => {
        const p = place(e);
        setTouched(true);
        spawn(p.x, p.y, false);
        trails.current.set(e.pointerId, { x: p.x, y: p.y });
        // 左ほど低く、右ほど高い。上のほうは少し明るい音色にする。
        const freq = noteAt(p.rx);
        play([
          { freq, dur: 0.55, gain: 0.24 },
          { freq: freq * 2, at: 0.02, dur: 0.35, gain: p.ry < 0.5 ? 0.08 : 0.04, wave: "triangle" },
        ]);
      }}
      onPointerMove={(e) => {
        const last = trails.current.get(e.pointerId);
        if (!last) return;
        const p = place(e);
        if (Math.hypot(p.x - last.x, p.y - last.y) < TRAIL_PX) return;
        trails.current.set(e.pointerId, { x: p.x, y: p.y });
        spawn(p.x, p.y, true);
        play([{ freq: noteAt(p.rx), dur: 0.25, gain: 0.08 }]);
      }}
      onPointerUp={(e) => trails.current.delete(e.pointerId)}
      onPointerCancel={(e) => trails.current.delete(e.pointerId)}
    >
      {!touched && <span className="play-invite" aria-hidden="true" />}
      {bursts.map((b) => (
        <span
          key={b.id}
          className="play-burst"
          aria-hidden="true"
          style={{
            left: b.x,
            top: b.y,
            width: b.size,
            height: b.size,
            color: b.color,
          }}
        >
          <ShapePicture shape={b.shape} />
        </span>
      ))}
      <HomeButton to="/play" label="長押しで、あそびを選ぶ画面に戻る" />
    </main>
  );
}
