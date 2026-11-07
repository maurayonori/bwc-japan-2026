"use client";

import Link from "next/link";
import { HomeButton } from "./home-button";
import { BaaPicture, BubblePicture, PonPicture } from "./pictures";
import { useSound } from "./sound";

const GAMES = [
  { href: "/play/pon", label: "ぽん", Picture: PonPicture, note: 523.25 },
  { href: "/play/baa", label: "ばあ", Picture: BaaPicture, note: 659.25 },
  { href: "/play/shabon", label: "しゃぼん玉", Picture: BubblePicture, note: 783.99 },
] as const;

// 選ぶ画面。大きな絵が 3 つあり、絵に触ると始まる。
export function PlayChooser() {
  const play = useSound();
  return (
    <main className="play-chooser" aria-label="あそびを選ぶ">
      <HomeButton to="/#talk" label="長押しで、さきよみの会話に戻る" />
      <nav className="play-choices" aria-label="あそび">
        {GAMES.map(({ href, label, Picture, note }) => (
          <Link
            key={href}
            href={href}
            className="play-choice"
            aria-label={label}
            onPointerDown={() => play([{ freq: note, dur: 0.3, gain: 0.18 }])}
          >
            <Picture />
          </Link>
        ))}
      </nav>
    </main>
  );
}
