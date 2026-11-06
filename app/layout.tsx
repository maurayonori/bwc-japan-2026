import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "さきよみ — 家族のために、今できることから",
  description:
    "気がかりを話すところから、暮らしの引き継ぎ、確認する質問文、残しておく言葉を一つずつ。",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
