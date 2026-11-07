"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CHAT_CLIENT_TIMEOUT_MS,
  emptyWorkspace,
  exportMemo,
  kinds,
  mergeCards,
  readStoredWorkspace,
  replySchema,
  STORAGE_KEY,
  toRequest,
  UNREADABLE_STORAGE_KEY,
  type Card,
  type Workspace,
} from "@/lib/workspace";
import { exampleWorkspace } from "@/lib/example";
import {
  VIEW_HASH,
  isHandCard,
  latestMoneyMessageId,
  questionCard,
  resultLinks,
  viewFromHash,
  type View,
} from "@/lib/views";
import { appendTranscript } from "@/lib/voice";
import { keepWorkspace, keptWorkspace } from "@/lib/kept-workspace";
import { citedText } from "@/lib/money/format";
import {
  FactSources,
  FactText,
  MoneyDetails,
  ToolTrace,
  WaitingNote,
  WarningList,
  type AskQuestion,
} from "./money-card";
import { VoiceButton } from "./voice-button";
import { SiteHeader } from "./site-header";

function Modal({
  title,
  children,
  close,
  className = "",
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // ダイアログの名前は、内側の見出しから取る（#64）。
  const headingId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog className={className} ref={ref} onCancel={close} aria-labelledby={headingId}>
      <div className="dialog-heading">
        <h2 id={headingId}>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="閉じる">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

function MemoCard({
  card,
  update,
  remove,
  disabled,
  question,
  onAsk,
}: {
  card: Card;
  update: (patch: Partial<Card>) => void;
  remove: () => void;
  disabled: boolean;
  question?: AskQuestion | null;
  onAsk?: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(card.body);
  const [title, setTitle] = useState(card.title);
  const [step, setStep] = useState(card.nextStep);
  const [uncertainty, setUncertainty] = useState(card.uncertainty);
  function edit() {
    setTitle(card.title);
    setBody(card.body);
    setStep(card.nextStep);
    setUncertainty(card.uncertainty);
    setEditing(true);
  }
  return (
    <article className={`memo-card ${card.kind} ${card.done ? "done" : ""}`}>
      <div className="card-meta">
        <span>
          {kinds[card.kind].mark} / {kinds[card.kind].label}
        </span>
        <span className="tag">
          {card.edited
            ? "自分で編集"
            : card.kind === "memory"
              ? "話した言葉のまま"
              : card.kind === "money"
                ? "表はプログラムの計算"
                : "下書き"}
        </span>
      </div>
      <h3>{card.kind === "memory" ? card.title : <FactText text={card.title} sources={false} />}</h3>
      <p className="card-body">
        {card.kind === "memory" ? card.body : <FactText text={card.body} sources={false} />}
      </p>
      {card.kind === "money" && card.money && (
        <MoneyDetails
          money={card.money}
          text={citedText(card)}
          question={question}
          onAsk={onAsk}
          disabled={disabled}
        />
      )}
      {card.uncertainty && (
        <div className="uncertainty">
          <span>まだ確かめていないこと</span>
          <p>
            <FactText text={card.uncertainty} sources={false} />
          </p>
        </div>
      )}
      <div className="next-step">
        <span className="step-arrow" aria-hidden="true">
          ↳
        </span>
        <div>
          <span>次の一歩</span>
          <p>
            <FactText text={card.nextStep} sources={false} />
          </p>
        </div>
      </div>
      {card.kind !== "memory" && !(card.kind === "money" && card.money) && (
        <FactSources text={citedText(card)} />
      )}
      <div className="card-actions">
        <button className="text-button" onClick={edit} disabled={disabled}>
          内容を直す
        </button>
        <button
          className="text-button"
          onClick={() => update({ done: !card.done })}
          disabled={disabled}
        >
          {card.done ? "✓ 済み・戻す" : "準備できた"}
        </button>
      </div>
      <div className="card-bottom">
        <label>
          <input
            type="checkbox"
            checked={card.included}
            onChange={(e) => update({ included: e.target.checked })}
            disabled={disabled}
          />
          渡すものに含める
        </label>
        <details>
          <summary>元の言葉</summary>
          {card.evidence.map((e, i) => (
            <blockquote key={i}>{e.quote}</blockquote>
          ))}
          <p>編集後の文章は、元の言葉と異なる場合があります。</p>
        </details>
      </div>
      {editing && (
        <Modal title="文章を直す" close={() => setEditing(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!body.trim() || !title.trim() || !step.trim()) return;
              update({
                body: body.trim(),
                title: title.trim(),
                nextStep: step.trim(),
                uncertainty: uncertainty.trim(),
                edited: true,
              });
              setEditing(false);
            }}
          >
            <label className="field">
              見出し
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                required
              />
            </label>
            <label className="field">
              残す文章
              <textarea
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={2000}
                required
              />
            </label>
            <label className="field">
              まだ確かめていないこと
              <textarea
                rows={2}
                value={uncertainty}
                onChange={(e) => setUncertainty(e.target.value)}
                maxLength={400}
              />
            </label>
            <label className="field">
              次の一歩
              <input
                value={step}
                onChange={(e) => setStep(e.target.value)}
                maxLength={200}
                required
              />
            </label>
            <p className="muted">
              編集した文章は、会話を続けても自動で上書きされません。
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="text-button danger"
                onClick={() => {
                  remove();
                  setEditing(false);
                }}
              >
                このメモを削除
              </button>
              <button type="submit" className="primary">
                変更を残す
              </button>
            </div>
          </form>
        </Modal>
      )}
    </article>
  );
}

// 「渡すもの」に並べる種類。お金の見通しは「見通し」に出す。
const HANDOVER_KINDS = ["daily", "contact", "memory"] as const;

// 話し始めの手がかりは、会話の最初の 1 文と入力欄の例だけにする（固定の質問票にしない）。
const FIRST_LINE =
  "入院の予定と、分かっている金額や手元のお金を、そのまま話してください。支払日に要るお金を、窓口で上限が使える場合と使えない場合で並べ、まず確かめる 1 つを出します。家族に頼みたいことも、思いついた順で。";
const PLACEHOLDER =
  "例: 12 月に 2 週間入院します。見積もりは 80 万円。手元にいくら要るか知りたい。";
// 入力欄に入る文字数の上限。マイクで足す文字も、この中に収める。
const DRAFT_LIMIT = 4000;

function errorMessageOf(data: unknown, status: number): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  )
    return data.error;
  return status === 429
    ? "短い時間に送信が続いたため、いまは受け付けられません。入力とメモは残っています。少し時間をおいて試してください。"
    : "接続できませんでした。入力とメモは残っています。少し待って、もう一度試してください。";
}

export function FamilyWorkspace({ connected }: { connected: boolean }) {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 返答が届いたことを読み上げで短く知らせる（#64）。本文は会話の記録が読み上げるので、ここには入れない。
  const [arrived, setArrived] = useState("");
  const [remember, setRemember] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<View>("talk");
  const [filter, setFilter] = useState<
    "all" | (typeof HANDOVER_KINDS)[number]
  >("all");
  const [modal, setModal] = useState<"privacy" | "export" | "reset" | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const live = useRef<{ workspace: Workspace; draft: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  // 「話す」に移ったあとで入力欄にフォーカスするか。
  const focusOnTalk = useRef(false);
  const example = workspace.mode === "example";
  const selected = workspace.cards.filter((c) => c.included).length;
  const memo = exportMemo(workspace.cards, workspace.messages);
  const moneyCards = workspace.cards.filter((c) => !isHandCard(c));
  const handCards = workspace.cards.filter(isHandCard);
  const shownCards = handCards.filter(
    (c) => filter === "all" || c.kind === filter,
  );
  const moneyMessageId = latestMoneyMessageId(
    workspace.messages,
    workspace.cards,
  );
  // 「まず確かめる 1 つ」で見せる質問文。今の見通しを作った返答で、いっしょに作ったり直したりした文章だけを使う（#48）。
  const questionSource = questionCard(workspace.messages, workspace.cards);
  const question = questionSource
    ? { title: questionSource.title, body: questionSource.body }
    : null;

  // 会話の入力欄へ移る。ほかの表示にいるときは、「話す」に移ってからフォーカスする。
  function focusComposer() {
    if (view === "talk") {
      input.current?.focus();
      return;
    }
    focusOnTalk.current = true;
    window.location.hash = VIEW_HASH.talk;
  }
  // 質問文が無いときは、作ってもらう下書きを会話の入力欄に入れる。送信はしない。
  const askForQuestion = example
    ? undefined
    : (text: string) => {
        setDraft(text);
        focusComposer();
      };

  useEffect(() => {
    // 年表やあそぶから戻ったときは、このタブのメモリに置いた状態から続ける（#52、ADR 0015）。
    const kept = keptWorkspace();
    if (kept) {
      setWorkspace(kept.workspace);
      setDraft(kept.draft);
      setRemember(kept.remember);
      live.current = kept.live;
      setHydrated(true);
      return;
    }
    try {
      const stored = readStoredWorkspace(localStorage);
      if (stored.workspace?.mode === "live") {
        setWorkspace(stored.workspace);
        setRemember(true);
      }
      if (stored.unreadable) {
        setNotice(
          "保存したデータを読み込めませんでした。元のデータは消していません。",
        );
      }
    } catch {
      setNotice(
        "保存したデータを読み込めませんでした。元のデータは消していません。",
      );
    }
    setHydrated(true);
  }, []);
  // # の変化（リンク、ブラウザの戻る・進む）で表示を切り替える。会話と下書きとカードは、この画面の状態に残る。
  useEffect(() => {
    const read = () => setView(viewFromHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  // 会話に戻ったら会話の末尾を見せる。ほかの表示は先頭から読む。
  useEffect(() => {
    if (view !== "talk") {
      window.scrollTo(0, 0);
      return;
    }
    const box = transcript.current;
    if (box) box.scrollTop = box.scrollHeight;
    if (focusOnTalk.current) {
      focusOnTalk.current = false;
      input.current?.focus();
    }
  }, [view]);
  // ほかのページへ移るときに状態が消えないよう、変わるたびにメモリへ写す。サーバーにもブラウザにも保存しない。
  useEffect(() => {
    if (hydrated) keepWorkspace({ workspace, draft, remember, live: live.current });
  }, [hydrated, workspace, draft, remember]);
  useEffect(() => {
    if (!hydrated || example) return;
    if (remember) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      } catch {
        setNotice(
          "このブラウザに保存できません。必要なメモをダウンロードしてください。",
        );
      }
    }
  }, [workspace, remember, hydrated, example]);
  useEffect(() => {
    const active = example ? live.current : { workspace, draft };
    if (
      !active ||
      (!active.draft && (remember || active.workspace.messages.length === 0))
    )
      return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, remember, workspace.messages.length, example]);
  useEffect(() => {
    transcript.current?.scrollTo({
      top: transcript.current.scrollHeight,
      behavior: "smooth",
    });
  }, [workspace.messages, busy]);
  useEffect(() => () => abort.current?.abort(), []);

  async function send() {
    const text = draft.trim();
    if (!text || busy || example || !connected) return;
    if (workspace.messages.length >= 39) {
      setError(
        "この会話は長くなりました。メモを持ち出してから、新しく始めてください。",
      );
      return;
    }
    const messages = [
      ...workspace.messages,
      { id: crypto.randomUUID(), role: "user" as const, text },
    ];
    setBusy(true);
    setError("");
    setNotice("");
    setArrived("");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toRequest(messages, workspace.cards)),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(CHAT_CLIENT_TIMEOUT_MS),
        ]),
      });
      // 上限やゲートウェイの応答は JSON とは限らない。読めなくても入力は残す。
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessageOf(data, res.status));
      const reply = replySchema.parse(data);
      setWorkspace((prev) => ({
        ...prev,
        messages: [
          ...messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: reply.reply,
            warnings: reply.warnings,
            tools: reply.tools,
            cardIds: reply.cards.map((card) => card.id),
          },
        ],
        cards: mergeCards(prev.cards, reply.cards),
      }));
      setDraft("");
      setFilter("all");
      setArrived("返答が届きました");
    } catch (e) {
      setError(
        controller.signal.aborted
          ? "整理を中止しました。入力とメモは残っています。"
          : e instanceof Error && e.name !== "TimeoutError"
            ? e.message
            : "時間がかかっているため中断しました。入力は残っています。もう一度試してください。",
      );
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }
  function toggleExample() {
    if (example) {
      setWorkspace(live.current?.workspace || emptyWorkspace());
      setDraft(live.current?.draft || "");
      live.current = null;
    } else {
      live.current = { workspace, draft };
      setWorkspace(exampleWorkspace());
      setDraft("");
    }
    setError("");
    setFilter("all");
    setNotice("");
    setArrived("");
  }
  function updateCard(id: string, patch: Partial<Card>) {
    setWorkspace((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  }
  function renderCard(card: Card) {
    return (
      <MemoCard
        key={card.id}
        card={card}
        disabled={busy}
        update={(patch) => updateCard(card.id, patch)}
        remove={() =>
          setWorkspace((prev) => ({
            ...prev,
            cards: prev.cards.filter((c) => c.id !== card.id),
          }))
        }
        question={card.kind === "money" ? question : undefined}
        onAsk={card.kind === "money" ? askForQuestion : undefined}
      />
    );
  }
  function download() {
    const blob = new Blob(["﻿" + memo], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = example ? "渡すもの-架空の体験例.txt" : "渡すもの.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function changeRemember(value: boolean) {
    if (!value) {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(UNREADABLE_STORAGE_KEY);
      } catch {
        setNotice(
          "保存データを消せませんでした。ブラウザのサイトデータ設定から消去してください。",
        );
        return;
      }
    }
    setRemember(value);
  }

  const notes = (
    <>
      {example && (
        <div className="example-banner">
          <span>架空の体験例</span>
          <span className="example-note">
            会話と文章は見本です。編集・完了・持ち出しを試せます。
          </span>
          <button onClick={toggleExample}>自分の準備に戻る →</button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
  const saveControls = (
    <>
      <label>
        <input
          type="checkbox"
          checked={remember}
          disabled={example || !hydrated}
          onChange={(e) => changeRemember(e.target.checked)}
        />
        このブラウザに保存して、次回つづける
      </label>
      <button
        className="text-button"
        onClick={() => setModal("reset")}
        disabled={busy || example}
      >
        会話と準備を消去
      </button>
    </>
  );
  const footer = (
    <footer className="workspace-footer">
      {saveControls}
      <p>
        さきよみは、家族の準備を進めるための試作です。診療や保障の判断は行いません。
      </p>
    </footer>
  );
  const backToTalk = (
    <a className="back-link" href={VIEW_HASH.talk}>
      <span aria-hidden="true">←</span> 会話に戻る
    </a>
  );

  return (
    <div className={`app-shell ${view === "talk" ? "is-talk" : "is-page"}`}>
      <h1 className="sr-only">さきよみ 入院のお金、支払日に間に合う準備</h1>
      <a
        className="skip-link"
        href={VIEW_HASH.talk}
        onClick={(e) => {
          e.preventDefault();
          focusComposer();
        }}
      >
        会話の入力欄に移動
      </a>
      <SiteHeader
        current={view}
        counts={{ outlook: moneyCards.length, hand: handCards.length }}
      >
        <div className="header-actions">
          <span className={`connection ${connected ? "ready" : ""}`}>
            {connected ? "公開の試用版" : "会話は準備中"}
          </span>
          <button className="text-button" onClick={() => setModal("privacy")}>
            保存とプライバシー
          </button>
        </div>
      </SiteHeader>
      {view === "talk" && (
        <main className="talk" id="conversation" aria-label="話す">
          {(example || notice) && <div className="talk-notes">{notes}</div>}
          <p className="sr-only" role="status">
            {arrived}
          </p>
          <div
            className="transcript"
            ref={transcript}
            role="log"
            aria-label="会話"
            aria-live="polite"
          >
            {workspace.messages.length === 0 ? (
              <div className="message assistant first-line">
                <span className="speaker">さきよみ</span>
                <p>{FIRST_LINE}</p>
              </div>
            ) : (
              workspace.messages.map((m) => {
                const links = resultLinks(
                  m,
                  workspace.cards,
                  m.id === moneyMessageId,
                );
                return (
                  <div key={m.id} className={`message ${m.role}`}>
                    <span className="speaker">
                      {m.role === "user"
                        ? example
                          ? "架空の利用者"
                          : "あなた"
                        : example
                          ? "整理の見本"
                          : "さきよみ"}
                    </span>
                    <p>
                      {m.role === "assistant" ? (
                        <FactText text={m.text} />
                      ) : (
                        m.text
                      )}
                    </p>
                    {links.length > 0 && (
                      <p className="result-links">
                        {links.map((link) => (
                          <a key={link.view} href={VIEW_HASH[link.view]}>
                            {link.label}
                            <span aria-hidden="true"> →</span>
                          </a>
                        ))}
                      </p>
                    )}
                    {m.role === "assistant" && <ToolTrace tools={m.tools} />}
                    <WarningList warnings={m.warnings} />
                  </div>
                );
              })
            )}
            {busy && (
              <div className="thinking" role="status">
                <span className="pulse" />
                <WaitingNote />
              </div>
            )}
          </div>
          <div className="composer-wrap">
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {/* 接続が無いときは、押す前に送れないと分かるようにする（#64）。本番は接続ありなので出ない。 */}
            {!connected && !example && (
              <p className="offline-note" id="offline-note">
                接続が無いので送れません。架空の体験例で動きを見られます。
                <button
                  type="button"
                  onClick={toggleExample}
                  disabled={busy || !hydrated}
                >
                  架空の体験例を見る
                </button>
              </p>
            )}
            {/* 個人情報を書かない注意は、入力欄の直上に本文と同じ大きさで置く（#64） */}
            <p className="privacy-hint">
              公開の試用版です。実名や病名は書かず、架空の内容で試してください。送信すると、会話とメモをClaudeに渡して整理します。
              <button onClick={() => setModal("privacy")}>詳しく</button>
            </p>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="thoughts">
                気になっていることを自由に書く
              </label>
              <textarea
                id="thoughts"
                ref={input}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                maxLength={DRAFT_LIMIT}
                disabled={busy || example}
                placeholder={
                  example
                    ? "「自分の準備に戻る」から、自由に話せます。"
                    : PLACEHOLDER
                }
              />
              <div className="composer-bottom">
                {/* 入力欄のそばに置く道具。マイクは確定した文字を下書きの末尾に足すだけで、送信はしない（#45）。 */}
                <div className="composer-tools">
                  {!example && (
                    <VoiceButton
                      disabled={busy || !hydrated}
                      append={(text) =>
                        setDraft((prev) =>
                          appendTranscript(prev, text, DRAFT_LIMIT),
                        )
                      }
                    />
                  )}
                  {!example && (
                    <button
                      type="button"
                      className="text-link"
                      onClick={toggleExample}
                      disabled={busy || !hydrated}
                    >
                      {workspace.messages.length === 0
                        ? "まず、架空の体験例を見る"
                        : "架空の体験例を見る"}
                    </button>
                  )}
                </div>
                {busy ? (
                  <button
                    type="button"
                    className="send-button"
                    onClick={() => abort.current?.abort()}
                  >
                    中止
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="send-button"
                    disabled={!draft.trim() || example || !hydrated || !connected}
                    aria-describedby={!connected && !example ? "offline-note" : undefined}
                  >
                    ここから整理する <span aria-hidden="true">↑</span>
                  </button>
                )}
              </div>
            </form>
          </div>
        </main>
      )}
      {view === "outlook" && (
        <main className="page" aria-labelledby="outlook-title">
          {notes}
          {backToTalk}
          <section className="foresight">
            <div className="section-heading memo-heading">
              <div>
                <span className="section-number">見通し</span>
                <h2 id="outlook-title">
                  支払日に要るお金と、まず確かめる 1{" "}つ
                </h2>
              </div>
              <span className="draft-label">話すほど、幅が縮む</span>
            </div>
            {moneyCards.length === 0 ? (
              <p className="foresight-empty">
                入院のことを話すと、ここに支払日に要るお金と、まず確かめる 1
                {" "}つが出ます。
                {/* メニューから先に開いた人が迷わないよう、体験例も開けるようにする（#64）。途中で折れないよう 1 つにまとめる */}
                <span className="empty-actions">
                  <a href={VIEW_HASH.talk}>話す</a>
                  <button
                    type="button"
                    className="text-link"
                    onClick={toggleExample}
                    disabled={busy || !hydrated}
                  >
                    架空の体験例を見る
                  </button>
                </span>
              </p>
            ) : (
              <div className="cards">{moneyCards.map(renderCard)}</div>
            )}
          </section>
          {footer}
        </main>
      )}
      {view === "hand" && (
        <main className="page" aria-labelledby="hand-title">
          {notes}
          {backToTalk}
          <section className="handover">
            <div className="section-heading memo-heading">
              <div>
                <span className="section-number">渡すもの</span>
                <h2 id="hand-title">
                  家族と窓口に渡すもの
                  <span className="count">{handCards.length}</span>
                </h2>
              </div>
            </div>
            {workspace.cards.length === 0 ? (
              <p className="foresight-empty">
                朝の支度の引き継ぎ、窓口への質問文、残しておきたい言葉。会話から、ここに渡す文章ができていきます。
                <span className="empty-actions">
                  <a href={VIEW_HASH.talk}>話す</a>
                  <button
                    type="button"
                    className="text-link"
                    onClick={toggleExample}
                    disabled={busy || !hydrated}
                  >
                    架空の体験例を見る
                  </button>
                </span>
              </p>
            ) : (
              <>
                <div className="board-summary">
                  <span>
                    <strong>{handCards.filter((c) => c.done).length}</strong>{" "}
                    / {handCards.length} 件の準備ができました
                  </span>
                  <p>全部を一度に進めなくても。ひとつ選ぶところから。</p>
                </div>
                <div className="filters" aria-label="渡すものの絞り込み">
                  <button
                    aria-pressed={filter === "all"}
                    onClick={() => setFilter("all")}
                  >
                    すべて
                  </button>
                  {HANDOVER_KINDS.map((kind) => (
                    <button
                      key={kind}
                      aria-pressed={filter === kind}
                      onClick={() => setFilter(kind)}
                    >
                      {kinds[kind].label}
                    </button>
                  ))}
                </div>
                <div className="cards">
                  {shownCards.map(renderCard)}
                  {shownCards.length === 0 && (
                    <p className="filter-empty">
                      {filter === "all"
                        ? "家族や窓口に渡す文章は、まだありません。"
                        : "この種類の文章は、まだありません。"}
                    </p>
                  )}
                </div>
                <div className="export-bar">
                  <div>
                    <strong>渡す内容は、自分で選べます。</strong>
                    <p>会話の全文は入りません。</p>
                  </div>
                  <button
                    className="primary"
                    disabled={selected === 0 || busy}
                    onClick={() => {
                      setCopied(false);
                      setModal("export");
                    }}
                  >
                    選んだ{selected}件を確認{" "}
                    <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </>
            )}
          </section>
          {footer}
        </main>
      )}
      {modal === "privacy" && (
        <Modal title="保存とプライバシー" close={() => setModal(null)}>
          <div className="prose">
            <h3>話した内容を整理するとき</h3>
            <p>
              「ここから整理する」を押すと、この画面の会話とメモをアプリのサーバー経由でAnthropicのClaude
              APIに送ります。サービス側の取り扱いは
              <a
                href="https://www.anthropic.com/legal/privacy"
                target="_blank"
                rel="noreferrer"
              >
                Anthropicのプライバシーポリシー
              </a>
              をご確認ください。
            </p>
            <h3>マイクで話すとき</h3>
            <p>
              パソコンのChromeなどでは、入力欄の下の「話して入力」から話せます。音声は、文字にするためにブラウザの音声認識サービス（ChromeではGoogle）へ送られます。アプリのサーバーは音声を受け取りません。文字は入力欄に入るだけで、送信は「ここから整理する」を押したときです。実名や病名は話さず、架空の内容で試してください。スマートフォンでは、キーボードの音声入力を使えます。
            </p>
            <h3>公開の試用版です</h3>
            <p>
              ログインなしで試せるように公開しています。Claudeとの会話は、1台あたり1日20回までなどの上限があります。架空の体験例は回数の制限なく試せます。実名、病名、連絡先は書かないでください。
            </p>
            <h3>保存する場所を自分で選べます</h3>
            <p>
              初期状態では、この画面を閉じると会話とメモは消えます。「このブラウザに保存」を選ぶと、この端末のブラウザに残ります。共有端末では保存を選ばないでください。アプリのサーバーは会話を保存しません。
            </p>
            <div className="privacy-controls">{saveControls}</div>
            <h3>渡す前に、中身を確かめられます</h3>
            <p>
              選んだメモだけをコピー・ダウンロードできます。家族や窓口へ自動で送ることはありません。持ち出したファイルは、この画面の消去では削除されません。
            </p>
            {!connected && (
              <details>
                <summary>開発用：Claudeへの接続を設定する</summary>
                <p>
                  プロジェクトの .env.local に ANTHROPIC_API_KEY
                  を設定し、サーバーを再起動してください。キーはこの画面に入力しません。モデルは
                  ANTHROPIC_MODEL で指定できます。
                </p>
              </details>
            )}
          </div>
        </Modal>
      )}
      {modal === "export" && (
        <Modal
          title="渡す前に、内容を確かめる"
          close={() => setModal(null)}
          className="export-dialog"
        >
          <p className="muted">
            選んだ{selected}件だけです。会話や、選んでいないメモは含みません。
            {example && "（架空の体験例）"}
          </p>
          <pre className="export-preview">{memo}</pre>
          <div className="dialog-actions">
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(memo);
                  setCopied(true);
                } catch {
                  setNotice(
                    "コピーできませんでした。ダウンロードをご利用ください。",
                  );
                }
              }}
            >
              {copied ? "✓ コピーしました" : "文章をコピー"}
            </button>
            <button className="primary" onClick={download}>
              テキストで保存 ↓
            </button>
          </div>
          <p className="muted" role="status">
            {copied
              ? "渡したい相手へのメッセージなどに貼り付けられます。"
              : "内容を読んでから、渡す相手を自分で選んでください。"}
          </p>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal title="会話と準備を消去しますか" close={() => setModal(null)}>
          <p>
            この画面と、このブラウザに保存した内容を消去します。必要なメモは先に持ち出してください。
          </p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              戻る
            </button>
            <button
              className="primary danger-button"
              onClick={() => {
                try {
                  localStorage.removeItem(STORAGE_KEY);
                  localStorage.removeItem(UNREADABLE_STORAGE_KEY);
                } catch {
                  setNotice("ブラウザの保存データを消せませんでした。");
                  setModal(null);
                  return;
                }
                setWorkspace(emptyWorkspace());
                setDraft("");
                setRemember(false);
                setError("");
                setNotice("会話と準備を消去しました。");
                setModal(null);
              }}
            >
              消去して新しく始める
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
