# ADR 0010：Vercelで常時利用できる状態にし、全URLを認証で保護する

- 日付：2026-11-06
- 状態：置き換え（0012。本番 URL は利用上限つきで公開した。Vercel への配置と Secret の扱いは有効）
- 関連：ADR 0008、作者の「Vercelか何かに上げ、常に触れる状態にしてほしい」という依頼

## 判断

作者の既存のVercelチームに専用プロジェクト `sakiyomi-bwc2026` を作る。Next.jsを本番環境へ配置し、固定URLからこのMacの稼働状態に依存せず使えるようにする。

ページとAPIの両方をVercel AuthenticationのAll Deploymentsで保護する。アクセス権のあるVercelアカウントでログインして利用する。認証なしのAPI公開は行わず、新たなアカウント管理・パスワード実装も増やさない。

APIのlocalhost限定を、登録済みHTTPSオリジンとHostの一致を確認する方式へ拡張する。`APP_ORIGIN`、Vercelが設定する本番ドメインとデプロイURLだけを許可する。任意の `*.vercel.app` は許可しない。この照合は認証の代用ではなく、認証はプラットフォームで行う。

既存のハッカソン用APIキーをVercelのSecretへ登録する。ローカルの秘密ファイルや `.env.local` をソースとしてアップロードしない。デプロイするのはアプリの実行・ビルドに必要なファイルだけとし、調査資料、他の試作、個人的な会話の記録は含めない。

会話の保存方式はブラウザ内のままとする。オンライン化は端末間同期を意味しない。Vercelは実行時に会話をAnthropicへ中継するが、アプリは本文をDBやログに保存しない。

## 運用

- 本番URL：https://sakiyomi-bwc2026.vercel.app
- プロジェクト：`sakiyomi-bwc2026`（管理画面は作者のVercelチーム）
- Node.js 24、実行リージョン東京（hnd1）。
- 全デプロイの認証保護を維持する。今後誰でも使える形へ広げる場合は、利用量制限などを先に設計する。
- APIクレジット、APIキーやホスティング契約が有効なことを前提に動く。無期限・無停止を保証するものではない。

## 根拠

[Vercelの公式案内](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan)で、All DeploymentsのVercel Authenticationが全プランで追加料金なしになったことを確認した（2026-11-06確認）。
