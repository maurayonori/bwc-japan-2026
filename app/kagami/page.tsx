import type { Metadata } from "next";
import { SiteHeader } from "../site-header";
import { Kagami } from "./kagami";
import "./kagami.css";

// かがみ（#54、ADR 0017）。撮っている映像を見ながら録画し、すぐに見返す。映像はこの端末の外に出さない。
export const metadata: Metadata = {
  title: "かがみ — さきよみ",
  description: "撮っている映像を見ながら録画し、すぐに見返して、端末に保存できます。映像はこの端末の外に出ません。",
};

export default function KagamiPage() {
  return (
    <div className="app-shell is-page">
      <SiteHeader current="kagami" />
      <Kagami />
    </div>
  );
}
