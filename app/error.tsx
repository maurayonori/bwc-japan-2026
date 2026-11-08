"use client";

// 描画の例外で、Next.js の英語の既定画面を出さない（最終点検の指摘）。
// 会話とメモは、保存を選んでいなければこのタブのメモリにあるので、再読み込みを先にすすめない。
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="fallback-page">
      <h1>画面を表示できませんでした</h1>
      <p className="muted">
        もう一度表示を試してください。直らないときは、はじめの画面に戻るか、架空の体験例を開いてください。
      </p>
      <button className="primary" type="button" onClick={reset}>
        もう一度表示する
      </button>
    </main>
  );
}
