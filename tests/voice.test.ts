import test from "node:test";
import assert from "node:assert/strict";
import config from "../next.config";
import {
  VOICE_LANG,
  VOICE_NOTICE,
  appendTranscript,
  readResults,
  recognitionOf,
  startVoice,
  voiceErrorMessage,
  type Recognition,
  type RecognitionErrorEvent,
  type RecognitionResult,
  type RecognitionResultEvent,
} from "../lib/voice";

// 偽の SpeechRecognition。作られたものを並べ、テストから結果・エラー・終了を起こす。
class FakeRecognition implements Recognition {
  static made: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: RecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  calls: string[] = [];
  constructor() {
    FakeRecognition.made.push(this);
  }
  start() {
    this.calls.push("start");
  }
  stop() {
    this.calls.push("stop");
  }
  abort() {
    this.calls.push("abort");
  }
}

class BrokenRecognition extends FakeRecognition {
  start(): void {
    throw new Error("InvalidStateError");
  }
}

function result(transcript: string, isFinal: boolean): RecognitionResult {
  return Object.assign([{ transcript }], { isFinal });
}

function resultEvent(
  resultIndex: number,
  ...results: RecognitionResult[]
): RecognitionResultEvent {
  return { resultIndex, results };
}

function record() {
  const log = {
    finals: [] as string[],
    interims: [] as string[],
    errors: [] as string[],
    ends: 0,
  };
  return {
    log,
    handlers: {
      final: (text: string) => log.finals.push(text),
      interim: (text: string) => log.interims.push(text),
      error: (message: string) => log.errors.push(message),
      end: () => {
        log.ends += 1;
      },
    },
  };
}

function lastMade(): FakeRecognition {
  const made = FakeRecognition.made.at(-1);
  assert.ok(made);
  return made;
}

const pointer = (fine: boolean) => (query: string) => ({
  matches: query === "(pointer: fine)" && fine,
});

test("マイクは SpeechRecognition があり、主な入力が細かい指し方（PC）のときだけ出す", () => {
  assert.equal(
    recognitionOf({
      SpeechRecognition: FakeRecognition,
      matchMedia: pointer(true),
    }),
    FakeRecognition,
  );
  // 接頭辞つき（Chrome・Safari）でも使う
  assert.equal(
    recognitionOf({
      webkitSpeechRecognition: FakeRecognition,
      matchMedia: pointer(true),
    }),
    FakeRecognition,
  );
  // スマートフォン（指で触る）では出さない。OS のキーボードの音声入力に任せる
  assert.equal(
    recognitionOf({
      SpeechRecognition: FakeRecognition,
      webkitSpeechRecognition: FakeRecognition,
      matchMedia: pointer(false),
    }),
    null,
  );
  // SpeechRecognition が無いブラウザでは出さない
  assert.equal(recognitionOf({ matchMedia: pointer(true) }), null);
  // matchMedia が無いときも出さない
  assert.equal(recognitionOf({ SpeechRecognition: FakeRecognition }), null);
});

test("確定した文字は、入力欄の今の内容の末尾に足す。空のときはそのまま入る", () => {
  assert.equal(
    appendTranscript("", "来月から 2 週間入院します", 4000),
    "来月から 2 週間入院します",
  );
  assert.equal(
    appendTranscript("", "  前後の空白は除く  ", 4000),
    "前後の空白は除く",
  );
  // 足す文字が無ければ、今の内容をそのまま返す
  assert.equal(appendTranscript("打った文字", "   ", 4000), "打った文字");
});

test("打ってある文字と直した文字は書き換えない。区切りの空白だけをはさむ", () => {
  assert.equal(
    appendTranscript("来月入院します", "手元にいくら要るか知りたい", 4000),
    "来月入院します 手元にいくら要るか知りたい",
  );
  // 句読点や空白・改行で終わっていれば、はさまない。句読点を足すこともしない
  assert.equal(
    appendTranscript("来月入院します。", "手元にいくら要るか", 4000),
    "来月入院します。手元にいくら要るか",
  );
  assert.equal(
    appendTranscript("食事代は？\n", "1 食いくらですか", 4000),
    "食事代は？\n1 食いくらですか",
  );
  // 前の内容の空白や改行も、そのまま残す
  const typed = "  利用者が直した文\n\n";
  assert.ok(appendTranscript(typed, "続き", 4000).startsWith(typed));
});

test("上限を越える分は、足す側だけを切る。今の内容は削らない", () => {
  assert.equal(appendTranscript("あいう", "えおかきく", 6), "あいう えお");
  assert.equal(appendTranscript("あいうえお", "かき", 5), "あいうえお");
  const full = "あ".repeat(10);
  assert.equal(appendTranscript(full, "い", 8), full);
});

test("認識の結果から、確定した文字と話している途中の文字を分ける", () => {
  assert.deepEqual(readResults(resultEvent(0, result("来月から", false))), {
    final: "",
    interim: "来月から",
  });
  assert.deepEqual(
    readResults(
      resultEvent(
        0,
        result("来月から入院します", true),
        result("手元に", false),
      ),
    ),
    { final: "来月から入院します", interim: "手元に" },
  );
  // resultIndex より前の確定は、前の通知で渡し済みなので繰り返さない
  assert.deepEqual(
    readResults(
      resultEvent(
        1,
        result("来月から入院します", true),
        result(" 手元にいくら要るか", true),
      ),
    ),
    { final: "手元にいくら要るか", interim: "" },
  );
});

test("エラーは日本語で伝え、文字でも入力できることを添える。こちらから止めたときは出さない", () => {
  for (const code of [
    "not-allowed",
    "service-not-allowed",
    "no-speech",
    "audio-capture",
    "network",
    "language-not-supported",
    "知らない値",
  ]) {
    const message = voiceErrorMessage(code);
    assert.ok(message, code);
    assert.match(message, /文字でも入力できます。$/, code);
    assert.doesNotMatch(
      message,
      /[A-Za-z]{4,}/,
      `${code} の文に英語の語を残さない`,
    );
  }
  assert.match(voiceErrorMessage("not-allowed") ?? "", /マイク/);
  assert.equal(
    voiceErrorMessage("not-allowed"),
    voiceErrorMessage("service-not-allowed"),
  );
  assert.match(voiceErrorMessage("no-speech") ?? "", /聞き取れません/);
  assert.match(voiceErrorMessage("audio-capture") ?? "", /マイク/);
  assert.match(voiceErrorMessage("network") ?? "", /接続できません/);
  assert.equal(voiceErrorMessage("aborted"), null);
});

test("初めて押したときの一言は、音声の送り先と、架空の内容で試すことを伝える", () => {
  assert.match(VOICE_NOTICE, /ブラウザの音声認識サービス/);
  assert.match(VOICE_NOTICE, /Google/);
  assert.match(VOICE_NOTICE, /実名や病名は話さず、架空の内容で試して/);
});

test("開始すると ja-JP・continuous・interimResults で録音を始め、確定した文字だけを渡す", () => {
  const { log, handlers } = record();
  startVoice(FakeRecognition, handlers);
  const recognition = lastMade();
  assert.equal(recognition.lang, VOICE_LANG);
  assert.equal(recognition.lang, "ja-JP");
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  assert.deepEqual(recognition.calls, ["start"]);

  // 話している途中の文字は、確定として渡さない
  recognition.onresult?.(resultEvent(0, result("来月から", false)));
  assert.deepEqual(log.finals, []);
  assert.deepEqual(log.interims, ["来月から"]);

  // 確定したら渡し、途中の文字を消す
  recognition.onresult?.(resultEvent(0, result("来月から入院します", true)));
  assert.deepEqual(log.finals, ["来月から入院します"]);
  assert.equal(log.interims.at(-1), "");

  // 確定の後ろに途中の文字が続くとき、途中の文字は確定に混ぜない
  recognition.onresult?.(
    resultEvent(1, result("来月から入院します", true), result("手元に", false)),
  );
  assert.deepEqual(log.finals, ["来月から入院します"]);
  assert.equal(log.interims.at(-1), "手元に");
  assert.equal(log.ends, 0);
});

test("認識が終わったら待機へ戻す。自動で再開しない", () => {
  const { log, handlers } = record();
  const before = FakeRecognition.made.length;
  startVoice(FakeRecognition, handlers);
  const recognition = lastMade();
  recognition.onresult?.(resultEvent(0, result("話している途中", false)));
  recognition.onend?.();
  assert.equal(log.ends, 1);
  assert.equal(log.interims.at(-1), "", "途中の文字を消す");
  assert.deepEqual(recognition.calls, ["start"], "start を呼び直さない");
  assert.equal(FakeRecognition.made.length, before + 1, "新しく作り直さない");
  // 終わったあとに届いた結果は使わない
  recognition.onresult?.(resultEvent(0, result("遅れて届いた文字", true)));
  assert.deepEqual(log.finals, []);
});

test("もう一度押す・Esc は stop で止め、それまでの分の確定は受け取る", () => {
  const { log, handlers } = record();
  const session = startVoice(FakeRecognition, handlers);
  const recognition = lastMade();
  session.stop();
  assert.deepEqual(recognition.calls, ["start", "stop"]);
  recognition.onresult?.(resultEvent(0, result("止める前に話した文", true)));
  recognition.onend?.();
  assert.deepEqual(log.finals, ["止める前に話した文"]);
  assert.equal(log.ends, 1);
  // 終わったあとの stop は何もしない
  session.stop();
  assert.deepEqual(recognition.calls, ["start", "stop"]);
});

test("送信を始めたときと画面を離れたときは abort で捨て、あとから届いた文字を足さない", () => {
  const { log, handlers } = record();
  const session = startVoice(FakeRecognition, handlers);
  const recognition = lastMade();
  session.abort();
  assert.deepEqual(recognition.calls, ["start", "abort"]);
  assert.equal(log.ends, 1);
  // abort のあとに届くもの（結果、aborted のエラー、終了）は無視する
  recognition.onresult?.(
    resultEvent(0, result("送信のあとに届いた文字", true)),
  );
  recognition.onerror?.({ error: "aborted" });
  recognition.onend?.();
  assert.deepEqual(log.finals, []);
  assert.deepEqual(log.errors, []);
  assert.equal(log.ends, 1, "終了は 1 回だけ");
  session.abort();
  assert.deepEqual(recognition.calls, ["start", "abort"]);
});

test("エラーは日本語の文を渡し、そのあとの終了で待機へ戻る。アプリは止めない", () => {
  const { log, handlers } = record();
  startVoice(FakeRecognition, handlers);
  const recognition = lastMade();
  recognition.onerror?.({ error: "not-allowed" });
  assert.deepEqual(log.errors, [voiceErrorMessage("not-allowed")]);
  recognition.onend?.();
  assert.equal(log.ends, 1);

  const other = record();
  startVoice(FakeRecognition, other.handlers);
  lastMade().onerror?.({ error: "no-speech" });
  lastMade().onend?.();
  assert.deepEqual(other.log.errors, [voiceErrorMessage("no-speech")]);
  assert.equal(other.log.ends, 1);
});

test("録音を始められなかったときも、例外を投げずにエラーを出して待機へ戻る", () => {
  const { log, handlers } = record();
  const session = startVoice(BrokenRecognition, handlers);
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0], /文字でも入力できます。$/);
  assert.equal(log.ends, 1);
  session.stop();
  session.abort();
  assert.equal(log.ends, 1);
});

test("応答のヘッダは、このサイト自身のマイクを止めない（音声入力のため）", async () => {
  assert.ok(config.headers);
  const rules = await config.headers();
  const values = rules.flatMap((rule) => rule.headers);
  const policy = values.find((h) => h.key === "Permissions-Policy");
  assert.ok(policy);
  assert.match(policy.value, /(^|,\s*)microphone=\(self\)/);
  assert.doesNotMatch(policy.value, /microphone=\(\)/);
  // カメラはかがみのため、このサイト自身にだけ許す（#54、ADR 0016）。位置は今までどおり止める
  assert.match(policy.value, /(^|,\s*)camera=\(self\)/);
  assert.match(policy.value, /geolocation=\(\)/);
  // マイクを止めうる CSP は置いていない
  assert.equal(
    values.some((h) => /^content-security-policy$/i.test(h.key)),
    false,
  );
});
