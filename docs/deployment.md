# さきよみの公開版

- 利用 URL: https://sakiyomi-bwc2026.vercel.app
- 判断の記録: [ADR 0010](adr/0010-host-on-vercel-with-authentication.md)（配置）、[ADR 0012](adr/0012-open-production-with-usage-limits.md)（公開と利用上限）

## 開く

本番の固定 URL はログインなしで開ける。個別デプロイの URL とプレビューは Vercel ログインで保護している。

架空の体験例は回数の制限なく試せる。Claude との会話には上限があり、接続元（回線）ごとに 1 日 20 回、全体で 1 日 150 回、IP ごとに 1 時間 20 回まで。

会話は送信時に Vercel の関数を経由して Anthropic へ送る。アプリは会話本文をサーバーに保存しない。保存を選んだデータは開いたブラウザにだけ残り、端末間の同期はない。

## 環境変数

| 名前                       | 種類   | 用途                                  |
| -------------------------- | ------ | ------------------------------------- |
| `ANTHROPIC_API_KEY`        | Secret | Claude API                            |
| `ANTHROPIC_MODEL`          | Config | `claude-sonnet-5-5`                   |
| `APP_ORIGIN`               | Config | `https://sakiyomi-bwc2026.vercel.app` |
| `LIMIT_PER_CLIENT_PER_DAY` | Config | 接続元（回線）ごとの 1 日の回数。省略すると 20  |
| `LIMIT_GLOBAL_PER_DAY`     | Config | 全体の 1 日の回数。省略すると 150     |

Production と Preview に設定する。ローカルで使っている `ANTHROPIC_API_KEY_FILE` は Vercel に設定しない。キーは引数、Git、ログ、クライアントコードへ含めず、CLI では標準入力で渡す。登録後はデプロイし直す。

## 更新する

この作業ディレクトリは `.vercel/project.json` で専用プロジェクトにリンク済み（Git 管理外）。

```sh
npm test
npm run typecheck
npm run build
npx vercel@65.12.0 deploy --prod --scope <作者のチーム>
```

`.vercelignore` は秘密ファイル・資料・テストをアップロード対象から外す。配置後、ビルド完了に加え、画面の表示と `/api/chat` の実応答を確かめる。

## アクセスの保護

- Vercel Firewall のルール `api-chat-rate-limit` で、`/api/chat` への POST を IP ごとに 1 時間 20 回に制限している
- 接続元ごと・全体の回数は `lib/limits.ts` がメモリの中で数える。厳密な上限ではない（ADR 0012）
- 認証は無い。上限を外したまま公開しない
- API の残高はアプリからは見えない。提出前と審査の前に Anthropic のコンソールで確かめる
