// URL の打ち間違いなどで、Next.js の英語の既定画面を出さない（最終点検の指摘）。
export default function NotFound() {
  return (
    <main className="fallback-page">
      <h1>このページは見つかりません</h1>
      <p className="muted">URL を確かめるか、はじめの画面に戻ってください。</p>
      <a className="primary" href="/">
        はじめの画面へ
      </a>
    </main>
  );
}
