import type { ReactElement } from "react";
import type { Tone } from "../sound";

// ばあで布のうしろから出てくるもの。この配列を差し替えると、中身が変わる（#52）。
// 絵はこのリポジトリで新しく描いた、特定の作品に似せない簡単な顔。鳴き声は本物の録音ではなく、短い音の組み合わせ。
export interface PeekFriend {
  id: string;
  // 読み上げの名前（画面には出さない）
  name: string;
  Picture: () => ReactElement;
  voice: readonly Tone[];
}

function Eyes({ y = 96, gap = 34, color = "var(--play-ink)" }: { y?: number; gap?: number; color?: string }) {
  return (
    <>
      <ellipse cx={100 - gap} cy={y} rx="9" ry="11" fill={color} />
      <ellipse cx={100 + gap} cy={y} rx="9" ry="11" fill={color} />
      <circle cx={100 - gap + 3} cy={y - 4} r="3" fill="#fff" />
      <circle cx={100 + gap + 3} cy={y - 4} r="3" fill="#fff" />
    </>
  );
}

function Cheeks({ y = 122 }: { y?: number }) {
  return (
    <>
      <ellipse cx="52" cy={y} rx="13" ry="8" fill="var(--play-blush)" opacity="0.8" />
      <ellipse cx="148" cy={y} rx="13" ry="8" fill="var(--play-blush)" opacity="0.8" />
    </>
  );
}

function Cat() {
  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <path d="M38 78 46 18l42 34z" fill="#e3a24a" />
      <path d="M162 78 154 18l-42 34z" fill="#e3a24a" />
      <path d="M50 66 54 36l20 18z" fill="var(--play-blush)" />
      <path d="M150 66 146 36l-20 18z" fill="var(--play-blush)" />
      <ellipse cx="100" cy="112" rx="78" ry="70" fill="#f0b45c" />
      <Eyes />
      <Cheeks />
      <path d="M93 116h14l-7 8z" fill="#c76b4a" />
      <path d="M100 124c-4 8-12 10-18 6M100 124c4 8 12 10 18 6" fill="none" stroke="var(--play-ink)" strokeWidth="4" strokeLinecap="round" />
      <path d="M24 112l30 4M24 130l30-4M176 112l-30 4M176 130l-30-4" stroke="var(--play-ink)" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

function Dog() {
  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <ellipse cx="100" cy="110" rx="74" ry="70" fill="#d9a46c" />
      <ellipse cx="32" cy="98" rx="22" ry="46" fill="#9a6a3e" transform="rotate(14 32 98)" />
      <ellipse cx="168" cy="98" rx="22" ry="46" fill="#9a6a3e" transform="rotate(-14 168 98)" />
      <ellipse cx="100" cy="136" rx="40" ry="30" fill="#f3dcc0" />
      <Eyes y={94} gap={30} />
      <ellipse cx="100" cy="120" rx="14" ry="10" fill="var(--play-ink)" />
      <path d="M100 130v10M100 140c-6 6-14 6-18 0M100 140c6 6 14 6 18 0" fill="none" stroke="var(--play-ink)" strokeWidth="4" strokeLinecap="round" />
      <path d="M94 146q6 14 12 0z" fill="#e9776b" />
    </svg>
  );
}

function Bear() {
  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <circle cx="44" cy="52" r="26" fill="#8a5a3b" />
      <circle cx="156" cy="52" r="26" fill="#8a5a3b" />
      <circle cx="44" cy="52" r="13" fill="#c99470" />
      <circle cx="156" cy="52" r="13" fill="#c99470" />
      <ellipse cx="100" cy="110" rx="76" ry="72" fill="#a26d47" />
      <ellipse cx="100" cy="134" rx="36" ry="28" fill="#e2c09d" />
      <Eyes y={98} gap={32} />
      <ellipse cx="100" cy="124" rx="12" ry="9" fill="var(--play-ink)" />
      <path d="M100 133v8M100 141c-5 5-12 5-15 0M100 141c5 5 12 5 15 0" fill="none" stroke="var(--play-ink)" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function Rabbit() {
  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <ellipse cx="70" cy="40" rx="18" ry="44" fill="#f4f1ea" stroke="#d9d3c6" strokeWidth="3" />
      <ellipse cx="130" cy="40" rx="18" ry="44" fill="#f4f1ea" stroke="#d9d3c6" strokeWidth="3" />
      <ellipse cx="70" cy="44" rx="8" ry="30" fill="var(--play-blush)" />
      <ellipse cx="130" cy="44" rx="8" ry="30" fill="var(--play-blush)" />
      <ellipse cx="100" cy="122" rx="72" ry="62" fill="#f4f1ea" stroke="#d9d3c6" strokeWidth="3" />
      <Eyes y={112} gap={30} />
      <Cheeks y={134} />
      <path d="M94 130h12l-6 7z" fill="#e9776b" />
      <path d="M100 137c-4 7-10 8-15 4M100 137c4 7 10 8 15 4" fill="none" stroke="var(--play-ink)" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function Chick() {
  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <path d="M92 38c0-14 10-20 18-18-8 4-6 12 0 16" fill="#f2c84b" />
      <circle cx="100" cy="112" r="76" fill="#f7d65c" />
      <ellipse cx="34" cy="128" rx="20" ry="30" fill="#efc443" transform="rotate(20 34 128)" />
      <ellipse cx="166" cy="128" rx="20" ry="30" fill="#efc443" transform="rotate(-20 166 128)" />
      <Eyes y={100} gap={28} />
      <Cheeks y={124} />
      <path d="M84 116h32l-16 18z" fill="#ef8a3c" />
    </svg>
  );
}

export const FRIENDS: readonly PeekFriend[] = [
  {
    id: "cat",
    name: "ねこ",
    Picture: Cat,
    voice: [{ freq: 784, to: 587, at: 0.25, dur: 0.5, wave: "triangle", gain: 0.16 }],
  },
  {
    id: "dog",
    name: "いぬ",
    Picture: Dog,
    voice: [
      { freq: 440, to: 392, at: 0.25, dur: 0.16, wave: "triangle", gain: 0.2 },
      { freq: 440, to: 392, at: 0.45, dur: 0.16, wave: "triangle", gain: 0.2 },
    ],
  },
  {
    id: "bear",
    name: "くま",
    Picture: Bear,
    voice: [
      { freq: 261.63, at: 0.25, dur: 0.35, gain: 0.22 },
      { freq: 293.66, at: 0.5, dur: 0.45, gain: 0.22 },
    ],
  },
  {
    id: "rabbit",
    name: "うさぎ",
    Picture: Rabbit,
    voice: [
      { freq: 659.25, at: 0.25, dur: 0.12, gain: 0.16 },
      { freq: 783.99, at: 0.37, dur: 0.12, gain: 0.16 },
      { freq: 880, at: 0.49, dur: 0.18, gain: 0.16 },
    ],
  },
  {
    id: "chick",
    name: "ひよこ",
    Picture: Chick,
    voice: [
      { freq: 1046.5, to: 1318.5, at: 0.25, dur: 0.12, gain: 0.12 },
      { freq: 1046.5, to: 1318.5, at: 0.42, dur: 0.12, gain: 0.12 },
    ],
  },
];
