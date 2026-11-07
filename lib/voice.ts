// 入力欄の横のマイク（#45、ADR 0014）。ブラウザ内蔵の音声認識（Web Speech API）を使う。
// 対応の判定、認識結果の読み取り、入力欄の末尾に足す処理、エラー文を、画面から切り離した関数にする。
// サーバーには何も送らない。音声を文字にするのはブラウザと、その提供元の音声認識サービス。

export const VOICE_LANG = "ja-JP";

// TypeScript の DOM の型に SpeechRecognition が無いので、使う分だけをここで定義する。
// グローバルの型は書き換えない（ブラウザ側の型が増えたときにぶつからないように）。
export type RecognitionAlternative = { readonly transcript: string };
export type RecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
};
export type RecognitionResultList = {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
};
export type RecognitionResultEvent = {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
};
export type RecognitionErrorEvent = { readonly error: string };

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionConstructor = new () => Recognition;

// 判定に使う window の一部。テストでは偽物を渡す。
export type SpeechScope = {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  matchMedia?: (query: string) => { matches: boolean };
};

// マイクのボタンを出すか。SpeechRecognition があり、主な入力がマウスなどの細かい指し方（PC）のときだけ。
// スマートフォンは OS のキーボードの音声入力に任せる（ページから起動はできない）。
export function recognitionOf(
  scope: SpeechScope,
): RecognitionConstructor | null {
  const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Recognition || typeof scope.matchMedia !== "function") return null;
  return scope.matchMedia("(pointer: fine)").matches ? Recognition : null;
}

// 認識の結果から、今回確定した文字と、話している途中の文字を分けて取り出す。
// 確定した文字は resultIndex から後だけを読む（前のものは前の通知で渡し済み）。
export function readResults(event: RecognitionResultEvent): {
  final: string;
  interim: string;
} {
  let final = "";
  let interim = "";
  for (let i = 0; i < event.results.length; i++) {
    const result = event.results[i];
    const text = result[0]?.transcript ?? "";
    if (!result.isFinal) interim += text;
    else if (i >= event.resultIndex) final += text;
  }
  return { final: final.trim(), interim: interim.trim() };
}

const NO_GAP_AFTER = /[\s。、，．！？!?,.]$/;

// 確定した文字を、入力欄の今の内容の末尾に足す。今の内容は削らず、書き換えない。
// 前の文が句読点や空白で終わっていなければ、半角の空白を 1 つはさむ（句読点は足さない）。
// 上限を越える分は、足す側だけを切る。
export function appendTranscript(
  current: string,
  addition: string,
  limit: number,
): string {
  const text = addition.trim();
  if (!text || current.length >= limit) return current;
  const gap = current === "" || NO_GAP_AFTER.test(current) ? "" : " ";
  return (current + gap + text).slice(0, limit);
}

const KEEP_TYPING = "文字でも入力できます。";
const VOICE_FAILED = `音声入力を続けられませんでした。${KEEP_TYPING}`;

// エラーを日本語で伝える。こちらから止めたとき（aborted）は何も出さない。
export function voiceErrorMessage(code: string): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return `マイクか音声認識の使用が許可されていません。ブラウザのアドレス欄の設定から、このサイトのマイクを許可してください。${KEEP_TYPING}`;
    case "no-speech":
      return `声が聞き取れませんでした。もう一度マイクを押して話してください。${KEEP_TYPING}`;
    case "audio-capture":
      return `マイクから音を取れませんでした。マイクのつなぎ方と、パソコンの設定を確かめてください。${KEEP_TYPING}`;
    case "network":
      return `音声認識のサービスに接続できませんでした。少し待ってもう一度試してください。${KEEP_TYPING}`;
    default:
      return VOICE_FAILED;
  }
}

// マイクを初めて押したときに出す一言。「保存とプライバシー」にも同じことを書く。
export const VOICE_NOTICE =
  "マイクで話した音声は、文字にするためにブラウザの音声認識サービス（ChromeではGoogle）へ送られます。実名や病名は話さず、架空の内容で試してください。もう一度押すと、話し始められます。";

export type VoiceHandlers = {
  // 確定した文字。入力欄の末尾に足す。
  final: (text: string) => void;
  // 話している途中の文字。入力欄には入れず、そばに薄く出す。空文字で消す。
  interim: (text: string) => void;
  error: (message: string) => void;
  // 認識が終わった。待機の状態へ戻す。自動で再開しない。
  end: () => void;
};

export type VoiceSession = {
  // 聞くのをやめ、それまでの分を確定させる（もう一度押す、Esc）。
  stop: () => void;
  // 結果を捨てて終える（送信を始めた、画面を離れた）。
  abort: () => void;
};

// 録音を始める。lang は ja-JP、continuous と interimResults は true。
export function startVoice(
  Recognition: RecognitionConstructor,
  on: VoiceHandlers,
): VoiceSession {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    on.interim("");
    on.end();
  };
  const recognition = new Recognition();
  recognition.lang = VOICE_LANG;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    if (closed) return;
    const { final, interim } = readResults(event);
    if (final) on.final(final);
    on.interim(interim);
  };
  recognition.onerror = (event) => {
    if (closed) return;
    const message = voiceErrorMessage(event.error);
    if (message) on.error(message);
  };
  recognition.onend = close;
  try {
    recognition.start();
  } catch {
    on.error(VOICE_FAILED);
    close();
  }
  return {
    stop: () => {
      if (!closed) recognition.stop();
    },
    abort: () => {
      if (closed) return;
      recognition.abort();
      close();
    },
  };
}
