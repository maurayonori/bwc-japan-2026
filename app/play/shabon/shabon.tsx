"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HomeButton } from "../home-button";
import { useReducedMotion } from "../play-surface";
import { NOTES, useSound } from "../sound";

// しゃぼん玉: ゆっくり浮かぶ玉に触れると、割れて音が鳴る。割れなかった玉は上へ抜けて、また下から来る。
// 数えない、急がせない、終わらない。動きを減らす設定のときは、玉はその場に浮かんだまま動かない。
const COLORS = ["var(--play-sky)", "var(--play-plum)", "var(--play-green)", "var(--play-sun)", "var(--play-coral)"] as const;
const COUNT = 6;
// 触れる的は 96px 以上。
const MIN_SIZE = 112;
const MAX_SIZE = 168;

interface Bubble {
  id: number;
  // 横の位置（画面の幅に対する割合）
  x: number;
  // 動かないときの縦の位置（画面の高さに対する割合）
  y: number;
  size: number;
  // 下から上まで浮かぶ秒数
  rise: number;
  // 始まりを早める秒数（最初は画面のあちこちにいるように）
  ahead: number;
  sway: number;
  color: string;
}

interface Pop {
  id: number;
  x: number;
  y: number;
  size: number;
  color: string;
}

function makeBubble(id: number, spread: boolean): Bubble {
  const size = MIN_SIZE + Math.random() * (MAX_SIZE - MIN_SIZE);
  const rise = 14 + Math.random() * 8;
  return {
    id,
    x: 0.08 + Math.random() * 0.84,
    y: 0.18 + Math.random() * 0.68,
    size,
    rise,
    ahead: spread ? Math.random() * rise * 0.85 : 0,
    sway: 3 + Math.random() * 3,
    color: COLORS[id % COLORS.length],
  };
}

export function Shabon() {
  const play = useSound();
  const still = useReducedMotion();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [pops, setPops] = useState<Pop[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<number>());

  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  };

  // 玉は画面に出てから作る（乱数をサーバーの描画と食い違わせない）。
  useEffect(() => {
    setBubbles(Array.from({ length: COUNT }, () => makeBubble(nextId.current++, true)));
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  function replace(id: number, delay: number) {
    setBubbles((prev) => prev.filter((b) => b.id !== id));
    later(() => setBubbles((prev) => [...prev, makeBubble(nextId.current++, false)]), delay);
  }

  function burst(bubble: Bubble, el: HTMLElement) {
    const box = el.getBoundingClientRect();
    const pop: Pop = {
      id: bubble.id,
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      size: box.width,
      color: bubble.color,
    };
    setPops((prev) => [...prev.slice(-11), pop]);
    later(() => setPops((prev) => prev.filter((p) => p.id !== pop.id)), 700);
    replace(bubble.id, 900);
    // 大きい玉ほど低い音
    const ratio = (bubble.size - MIN_SIZE) / (MAX_SIZE - MIN_SIZE);
    const freq = NOTES[Math.round((1 - ratio) * 5) + 3];
    play([
      { freq: freq * 2, to: freq, dur: 0.12, gain: 0.14, wave: "triangle" },
      { freq, at: 0.05, dur: 0.4, gain: 0.2 },
    ]);
  }

  return (
    <main className="play-field play-shabon" aria-label="しゃぼん玉">
      {bubbles.map((b) => (
        <button
          key={b.id}
          type="button"
          className={still ? "play-bubble still" : "play-bubble"}
          aria-label="しゃぼん玉。触ると割れる"
          style={
            {
              left: `${b.x * 100}%`,
              top: still ? `${b.y * 100}%` : undefined,
              width: b.size,
              height: b.size,
              color: b.color,
              "--rise": `${b.rise}s`,
              "--ahead": `-${b.ahead}s`,
              "--sway": `${b.sway}s`,
            } as CSSProperties
          }
          onPointerDown={(e) => burst(b, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              burst(b, e.currentTarget);
            }
          }}
          onClick={(e) => e.preventDefault()}
          onAnimationEnd={(e) => {
            // 上へ抜けた玉は、少しして下からまた来る。
            if (e.animationName === "play-rise") replace(b.id, 400);
          }}
        >
          <span className="play-bubble-body" />
        </button>
      ))}
      {pops.map((p) => (
        <span
          key={p.id}
          className="play-pop"
          aria-hidden="true"
          style={{ left: p.x, top: p.y, width: p.size, height: p.size, color: p.color }}
        >
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="play-drop" style={{ "--turn": `${i * 45}deg` } as CSSProperties} />
          ))}
        </span>
      ))}
      <HomeButton to="/play" label="長押しで、あそびを選ぶ画面に戻る" />
    </main>
  );
}
