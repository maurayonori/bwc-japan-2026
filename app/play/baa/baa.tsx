"use client";

import { useEffect, useRef, useState } from "react";
import { HomeButton } from "../home-button";
import { useSound, type Tone } from "../sound";
import { FRIENDS, type PeekFriend } from "./animals";

// ばあ: 布に触れるとめくれて、うしろからだれかが出てきて、音が鳴る。もう一度触れると布が戻り、次のだれかに替わる。
const REVEAL: readonly Tone[] = [
  { freq: 523.25, dur: 0.14, gain: 0.16 },
  { freq: 659.25, at: 0.07, dur: 0.14, gain: 0.16 },
  { freq: 783.99, at: 0.14, dur: 0.22, gain: 0.16 },
];
const COVER: readonly Tone[] = [
  { freq: 523.25, dur: 0.16, gain: 0.12 },
  { freq: 392.0, at: 0.1, dur: 0.24, gain: 0.12 },
];
// 布が下りきってから、うしろのだれかを替える。
const SWAP_MS = 500;

function Cloth() {
  return (
    <svg viewBox="0 0 300 260" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path
        d="M8 26C40 6 70 34 100 16s62 18 94 0 62 16 98 6v228c-34 10-64-12-98 0s-62-12-94 2-66-10-92 0z"
        fill="var(--play-sky)"
      />
      <path d="M50 40v200M110 34v206M170 40v200M230 34v206" stroke="var(--play-paper)" strokeWidth="8" strokeLinecap="round" opacity="0.25" />
      <circle cx="80" cy="120" r="12" fill="var(--play-paper)" opacity="0.5" />
      <circle cx="150" cy="170" r="12" fill="var(--play-paper)" opacity="0.5" />
      <circle cx="220" cy="110" r="12" fill="var(--play-paper)" opacity="0.5" />
    </svg>
  );
}

export function Baa({ friends = FRIENDS }: { friends?: readonly PeekFriend[] }) {
  const play = useSound();
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const swap = useRef<number | null>(null);
  const friend = friends[index % friends.length];

  useEffect(() => () => {
    if (swap.current !== null) window.clearTimeout(swap.current);
  }, []);

  function toggle() {
    if (swap.current !== null) {
      window.clearTimeout(swap.current);
      swap.current = null;
    }
    if (open) {
      setOpen(false);
      play(COVER);
      swap.current = window.setTimeout(() => {
        swap.current = null;
        setIndex((i) => (i + 1) % friends.length);
      }, SWAP_MS);
    } else {
      setOpen(true);
      play([...REVEAL, ...friend.voice]);
    }
  }

  return (
    <main className="play-field play-baa" aria-label="ばあ">
      <button
        type="button"
        className={open ? "play-peek open" : "play-peek"}
        aria-label={open ? `${friend.name}。もう一度触ると布が戻る` : "布に触ると、だれかが出てくる"}
        onPointerDown={toggle}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            toggle();
          }
        }}
        onClick={(e) => e.preventDefault()}
      >
        <span className="play-friend" key={friend.id}>
          <friend.Picture />
        </span>
        <span className="play-cloth">
          <Cloth />
        </span>
      </button>
      <HomeButton to="/play" label="長押しで、あそびを選ぶ画面に戻る" />
    </main>
  );
}
