"use client";

import { useCallback, useEffect, useRef } from "react";

// あそぶの音は、すべてその場で Web Audio で作る（#52、ADR 0015）。音の素材ファイルも外への通信も使わない。
// 小さな子の耳に強すぎないよう、正弦波と三角波だけにし、全体を低い音量と柔らかいフィルターに通す。
// 手のひらで一度にたくさん触れても割れないよう、同時に鳴らす数に上限を置く。

// ペンタトニック（ド・レ・ミ・ソ・ラ）。どの順で鳴っても濁らない。
export const NOTES = [
  261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0,
] as const;

const MAX_VOICES = 8;
const MASTER_GAIN = 0.5;

type Wave = "sine" | "triangle";

export interface Tone {
  freq: number;
  // 鳴り始めまでの秒数
  at?: number;
  dur?: number;
  wave?: Wave;
  gain?: number;
  // 終わりの高さ（音を少し上げ下げする）
  to?: number;
}

type AudioContextClass = typeof AudioContext;

export function useSound() {
  const ctxRef = useRef<{ ctx: AudioContext; out: AudioNode } | null>(null);
  const voices = useRef(0);

  useEffect(
    () => () => {
      void ctxRef.current?.ctx.close();
      ctxRef.current = null;
    },
    [],
  );

  // 音の準備は、子どもが最初に触れたとき（ブラウザが音を許すとき）に行う。
  const audio = useCallback(() => {
    if (!ctxRef.current) {
      const Ctor: AudioContextClass | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextClass })
          .webkitAudioContext;
      if (!Ctor) return null;
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      const soft = ctx.createBiquadFilter();
      soft.type = "lowpass";
      soft.frequency.value = 2400;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -18;
      limiter.ratio.value = 8;
      master.connect(soft).connect(limiter).connect(ctx.destination);
      ctxRef.current = { ctx, out: master };
    }
    const current = ctxRef.current;
    if (current.ctx.state === "suspended") void current.ctx.resume();
    return current;
  }, []);

  const play = useCallback(
    (tones: readonly Tone[]) => {
      const a = audio();
      if (!a || voices.current >= MAX_VOICES) return;
      const now = a.ctx.currentTime;
      let end = 0;
      for (const t of tones) {
        const start = now + (t.at ?? 0);
        const dur = t.dur ?? 0.35;
        const osc = a.ctx.createOscillator();
        osc.type = t.wave ?? "sine";
        osc.frequency.setValueAtTime(t.freq, start);
        if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + dur);
        const env = a.ctx.createGain();
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(t.gain ?? 0.22, start + 0.015);
        env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(env).connect(a.out);
        osc.start(start);
        osc.stop(start + dur + 0.05);
        end = Math.max(end, (t.at ?? 0) + dur);
      }
      voices.current++;
      window.setTimeout(() => {
        voices.current = Math.max(0, voices.current - 1);
      }, end * 1000 + 60);
    },
    [audio],
  );

  return play;
}

// 0〜1 の位置を音の高さにする（左ほど低く、右ほど高い）。
export function noteAt(ratio: number): number {
  const i = Math.min(NOTES.length - 1, Math.max(0, Math.floor(ratio * NOTES.length)));
  return NOTES[i];
}
