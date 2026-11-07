"use client";

import { useEffect } from "react";

// # だけを変えるリンク（会話の画面の「見通し」、年表の「設定」など）は、ブラウザがそのまま履歴を足す。
// その履歴には Next.js の印が無く、別のページから「戻る」で帰ると、URL だけ変わって画面が前のページのまま残る。
// # が変わるたびに Next.js の履歴の印を付け直し、「戻る」「進む」でも正しいページを出す（#52、ADR 0015）。
export function HistorySync() {
  useEffect(() => {
    const mark = () => {
      if (!window.history.state?.__NA)
        window.history.replaceState(window.history.state, "", window.location.href);
    };
    window.addEventListener("hashchange", mark);
    return () => window.removeEventListener("hashchange", mark);
  }, []);
  return null;
}
