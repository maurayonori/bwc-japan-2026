import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PlaySurface } from "./play-surface";
import "./play.css";

// あそぶ（#52、ADR 0015）。1〜2 歳の子が触って遊ぶ。字が読めない前提で、画面に文字を出さない。
// この範囲ではメニューを出さない。戻るのは隅の家の絵の長押しだけ。
export const metadata: Metadata = {
  title: "あそぶ — さきよみ",
  description: "触ると形や音が返ってくる、小さな子のためのあそび。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function PlayLayout({ children }: { children: ReactNode }) {
  return <PlaySurface>{children}</PlaySurface>;
}
