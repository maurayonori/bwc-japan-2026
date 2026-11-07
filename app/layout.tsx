import type { Metadata } from "next";
import "./globals.css";
import { HistorySync } from "./history-sync";

export const metadata: Metadata = {
  title: "さきよみ — 入院のお金、支払日に間に合う準備",
  description:
    "入院が決まった人が普通の言葉で話すと、支払日に要るお金を窓口で上限が使える場合と使えない場合で並べ、まず確かめる 1 つを出す。家族や窓口に渡す文章も。",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        {children}
        <HistorySync />
      </body>
    </html>
  );
}
