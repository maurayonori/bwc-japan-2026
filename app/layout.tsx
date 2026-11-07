import type { Metadata } from "next";
import "./globals.css";
import { HistorySync } from "./history-sync";

export const metadata: Metadata = {
  title: "さきよみ — 使える制度を、支払日に間に合う準備へ",
  description:
    "入院の予定や医療費の見込みを話すと、支払日に要るお金をプログラムが計算し、使える制度の確認と準備につなぎます。",
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
