# 0014. 入力欄の横のマイクは、ブラウザ内蔵の音声認識（Web Speech API）にする

- 状態: 採用
- 日付: 2026-11-07
- 関連: #45、#43（#44 で入力欄の下に `.composer-tools` を用意した）、[ADR 0012](0012-open-production-with-usage-limits.md)、[現在の仕様](../family-preparation.md)

## 背景

一文は「話すだけで」だが、#43 で会話だけにした最初の画面でも、入口は文字を打つ入力欄だけだった。作者は「話すだけで」を本当にしたいと言い、主に PC での音声入力を求めた。スマートフォンは、入力欄を押すと出る OS のキーボードに音声入力があるので、それで足りるという判断だった。

公開の試用版は、ログインなしで他人が使う（ADR 0012）。本番コードの凍結は 11/8 12:00 JST で、サーバーの処理やキーを増やす時間は無い。

## 決めたこと

1. **ブラウザ内蔵の音声認識を使う。** `window.SpeechRecognition` か `window.webkitSpeechRecognition` を使い、`lang` は `ja-JP`、`continuous` と `interimResults` は true にする。API ルート、環境変数、キー、新しい依存は足さない。外部の文字起こし API と Whisper は使わない。
2. **ボタンは、PC の対応するブラウザだけに出す。** `SpeechRecognition` があり、`matchMedia('(pointer: fine)')` が真のとき。判定はマウントのあとの `useEffect` で行い、サーバーの描画と食い違わないようにする。スマートフォンでは出さず、OS のキーボードの音声入力に任せる。ページから OS の音声入力を起動することはできないので、そのための仕組みは作らない。
3. **確定した文字だけを、入力欄の今の内容の末尾に足す。** 打ってある文字と、利用者が直した文字は書き換えない。前の文が句読点や空白で終わっていなければ、半角の空白を 1 つはさむ。句読点は足さない。入力欄の上限（4,000 文字）を越える分は、足す側だけを切る。話している途中の文字は入力欄に入れず、入力欄のそばに薄く出す。
4. **自動で送信しない。** 送信は本人が「ここから整理する」を押したとき。押すと録音、もう一度押すか Esc で止める（`stop`。それまでの分は確定させる）。認識が途中で終わったら（`onend`）待機に戻し、自動で再開しない。送信を始めたときと、会話の画面を離れたときは `abort` で結果を捨て、あとから届いた文字が次の下書きに混ざらないようにする。
5. **エラーは日本語で伝え、文字でも入力できることを添える。** `not-allowed` と `service-not-allowed`、`no-speech`、`audio-capture`、`network` に文を用意し、ほかは共通の文にする。こちらから止めたとき（`aborted`）は何も出さない。エラーでアプリを止めない。
6. **音声の送り先を、送る前に伝える。** マイクを初めて押したときは、一言（音声はブラウザの音声認識サービスへ送られる、Chrome では Google、実名や病名は話さず架空の内容で試す）を出し、録音は次に押したときから始める。一言を出したことはページを開いている間だけ覚え、保存しない。「保存とプライバシー」にも同じことを書く。
7. **このサイト自身にだけマイクを許す。** `next.config.ts` の `Permissions-Policy` は `microphone=()`（すべて禁止）だったので、`microphone=(self)` にした。カメラと位置は禁止のまま（2026-11-07 追記: かがみのため、[ADR 0017](0017-kagami-recording-on-this-device-only.md) でカメラもこのサイト自身にだけ許し、`camera=(self), microphone=(self), geolocation=()` にした。マイクはかがみの録画の音声にも使う）。`X-Frame-Options: DENY` も変えないので、他のサイトの枠の中では使えない。CSP は置いておらず、`vercel.json` にもヘッダは無い。
8. **判定と文字の扱いは `lib/voice.ts` に、部品は `app/voice-button.tsx` に置く。** TypeScript の DOM の型に `SpeechRecognition` が無いので、使う分だけを `lib/voice.ts` で定義する（`any` は使わない）。

## 確かめた事実

`developer.mozilla.org` はこの作業の環境から取得できなかったので、MDN のページの原稿（GitHub の `mdn/content` と `mdn/browser-compat-data` の main）を読んで確かめた。

| 事実                                                                                                                                                 | 出典                                                                                                                                                                                                                                             | 確認日     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Chrome などでは、ページの音声認識はサーバーの認識エンジンを使い、音声は認識のために Web サービスへ送られる。そのためオフラインでは動かない           | [MDN: SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)（原稿: https://github.com/mdn/content/blob/main/files/en-us/web/api/speechrecognition/index.md）                                                    | 2026-11-07 |
| 既定ではサーバーの認識エンジンを使う。`processLocally` を true にすると端末の中で認識するが、言語の追加の取り込みが要る                              | [MDN: Using the Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)（原稿: https://github.com/mdn/content/blob/main/files/en-us/web/api/web_speech_api/using_the_web_speech_api/index.md） | 2026-11-07 |
| エラーの種類（`not-allowed`、`service-not-allowed`、`no-speech`、`audio-capture`、`network`、`aborted`、`language-not-supported` など）とその意味    | [MDN: SpeechRecognitionErrorEvent.error](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error)（原稿: https://github.com/mdn/content/blob/main/files/en-us/web/api/speechrecognitionerrorevent/error/index.md）    | 2026-11-07 |
| 対応: Chrome は 33 から `webkit` 接頭辞つき、139 から接頭辞なし。Edge は Chrome と同じ。Safari は 14.1 から `webkit` 接頭辞つき。Firefox は 160 から | MDN の対応表のデータ（https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json）                                                                                                                                          | 2026-11-07 |
| Firefox 160 は確認日の時点で beta（公開予定 2026-11-10）。いまの安定版は 159                                                                         | MDN の対応表のデータ（https://github.com/mdn/browser-compat-data/blob/main/browsers/firefox.json）                                                                                                                                               | 2026-11-07 |

**確かめていないこと。** Chrome の音声の送り先が Google のサーバーであることは、作者の指示で画面に書いたが、MDN には運営者の名が無い。Chrome のプライバシーに関する告知と Chromium のソースは、この作業の環境から取得できなかった。提出の前に、Chrome のプライバシーに関する告知で確かめる。

## 検討したほかの案

| 案                                           | 採らなかった理由                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 外部の文字起こし API の Avalon               | 規約が社内業務の利用に限られ、第三者への提供を禁じていて、他人が使う公開アプリに合わない恐れがある。作者の別のリポジトリにあるコードは、大会のルールで持ち込めない |
| Whisper                                      | 作者が精度の点で外した                                                                                                                                             |
| スマートフォンにもマイクのボタンを出す       | 作者の判断で、OS のキーボードの音声入力に任せる。ページから OS の音声入力を起動することはできない                                                                  |
| 初めて押したときから録音し、一言を同時に出す | 一言を読む前に、音声がブラウザの提供元へ送られる。押す回数は初めの 1 回だけ増えるが、送り先を先に伝える方を選んだ                                                  |
| 話している途中の文字も入力欄に入れる         | 途中の文字は認識が進むと書き換わるので、入力欄の中身を書き換えることになる。利用者が同時に直した文字とぶつかる                                                     |
| 自動で送信する、読み上げる、常に聞き続ける   | 送信は本人が押す（Issue の決まり）。常に聞き続けると、話すつもりの無い音声まで送られる                                                                             |

## 結果

- **良くなること。** PC の対応するブラウザでは、文字を打たずに話し始められる。サーバーの処理、キー、依存は増えない。音声はアプリのサーバーを通らない。
- **引き受けること。** 精度はブラウザに依存する。音声はブラウザの提供元の音声認識サービスへ送られる。対応するかどうかもブラウザ次第で、Firefox は 159 ではボタンが出ないが、160 以降は出る見込みで、その動きは確かめていない。Safari（macOS）では `webkit` 接頭辞つきで出るはずだが、確かめていない。実際の声での確認は、マイクのある手元の環境で行う。
- **見直す条件。** 日本語の認識が実用にならないと分かったとき。端末の中で認識する `processLocally` が広く使えるようになり、音声を外へ出さずに済むようになったとき。Firefox 160 以降で、一言の送り先の書き方が合わなくなったとき。
