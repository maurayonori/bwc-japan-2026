"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
  FactText,
  MoneyDetails,
  WaitingNote,
  WarningList,
} from "./money-card";

function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? "mark small" : "mark"}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M11 29V12c7-1 10 2 10 7v13M29 10c-7 0-10 4-10 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="28" cy="10" r="4" fill="currentColor" />
      <path
        d="M11 29c6-2 13-2 19 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

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
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog className={className} ref={ref} onCancel={close} aria-label={title}>
      <div className="dialog-heading">
        <h2>{title}</h2>
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
}: {
  card: Card;
  update: (patch: Partial<Card>) => void;
  remove: () => void;
  disabled: boolean;
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
      <h3>{card.title}</h3>
      <p className="card-body">
        {card.kind === "memory" ? card.body : <FactText text={card.body} />}
      </p>
      {card.kind === "money" && card.money && (
        <MoneyDetails money={card.money} text={card.body} />
      )}
      {card.uncertainty && (
        <div className="uncertainty">
          <span>まだ確かめていないこと</span>
          <p>
            <FactText text={card.uncertainty} />
          </p>
        </div>
      )}
      <div className="next-step">
        <span className="step-arrow" aria-hidden="true">
          ↳
        </span>
        <div>
          <span>次の一歩</span>
          <p>{card.nextStep}</p>
        </div>
      </div>
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
          渡すメモに含める
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
        <Modal title="メモを直す" close={() => setEditing(false)}>
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

const starters = [
  {
    label: "入院のお金の見通し",
    text: "来月入院することになりました。いくら手元に用意しておけばいいのか分かりません。",
  },
  {
    label: "暮らしの引き継ぎ",
    text: "しばらく家を空けるので、普段自分がしていることを家族に渡しておきたい。",
  },
  {
    label: "保険や手続きの確認",
    text: "保険の書類はあるけれど、何を確認しておけばよいか分からない。",
  },
  {
    label: "日々の言葉を残す",
    text: "家族との今日の出来事を、忘れないように残しておきたい。",
  },
];

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
  const [remember, setRemember] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [filter, setFilter] = useState<"all" | Card["kind"]>("all");
  const [modal, setModal] = useState<"privacy" | "export" | "reset" | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const live = useRef<{ workspace: Workspace; draft: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const example = workspace.mode === "example";
  const selected = workspace.cards.filter((c) => c.included).length;
  const memo = exportMemo(workspace.cards);

  useEffect(() => {
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
    if (!text || busy || example) return;
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
          },
        ],
        cards: mergeCards(prev.cards, reply.cards),
      }));
      setDraft("");
      setFilter("all");
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
  }
  function updateCard(id: string, patch: Partial<Card>) {
    setWorkspace((prev) => ({
      ...prev,
      cards: prev.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  }
  function download() {
    const blob = new Blob(["\uFEFF" + memo], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = example ? "家族のしおり-架空の体験例.txt" : "家族のしおり.txt";
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

  return (
    <>
      <a className="skip-link" href="#conversation">
        会話に移動
      </a>
      <header className="site-header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          aria-label="さきよみ"
        >
          <Mark />
          <span>
            さきよみ<small>家族のための準備室</small>
          </span>
        </a>
        <div className="header-actions">
          <span className={`connection ${connected ? "ready" : ""}`}>
            {connected ? "公開の試用版" : "会話は準備中"}
          </span>
          <button className="text-button" onClick={() => setModal("privacy")}>
            保存とプライバシー
          </button>
        </div>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">ひとつずつ、かたちに。</p>
            <h1>
              家族のために。
              <br className="mobile-break" />
              今できることから。
            </h1>
            <p>入院や長い不在の前に。話すだけで、いつ・いくら要るかの見通しと、家族に渡すメモができます。</p>
          </div>
          <button
            className="example-button"
            onClick={toggleExample}
            disabled={busy || !hydrated}
          >
            {example ? "自分の準備に戻る" : "まず、架空の体験例を見る"}
            <span aria-hidden="true">↗</span>
          </button>
        </section>
        {example && (
          <div className="example-banner">
            <span>架空の体験例</span>
            会話とメモは見本です。編集・完了・持ち出しを試せます。
            <button onClick={toggleExample}>自分の準備を始める →</button>
          </div>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <div className="workspace-grid">
          <section
            className="conversation panel"
            id="conversation"
            aria-labelledby="conversation-title"
          >
            <div className="section-heading">
              <div>
                <span className="section-number">TALK</span>
                <h2 id="conversation-title">いま、気になっていること</h2>
              </div>
              <span className="quiet-dot" aria-hidden="true" />
            </div>
            <div
              className="transcript"
              ref={transcript}
              role="log"
              aria-label="会話"
              aria-live="polite"
            >
              {workspace.messages.length === 0 ? (
                <div className="welcome">
                  <div className="welcome-mark">
                    <Mark />
                  </div>
                  <h3>
                    まとまっていなくても、
                    <br />
                    そのままで大丈夫です。
                  </h3>
                  <p>
                    暮らしのこと、お金のこと、伝えたいこと。
                    <br />
                    いま話せることから始められます。
                  </p>
                  <div className="starters">
                    <span>たとえば、こんなところから</span>
                    {starters.map((s) => (
                      <button
                        key={s.label}
                        disabled={busy}
                        onClick={() => {
                          setDraft(s.text);
                          input.current?.focus();
                        }}
                      >
                        <span>{s.label}</span>
                        <span aria-hidden="true">＋</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                workspace.messages.map((m) => (
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
                    <WarningList warnings={m.warnings} />
                  </div>
                ))
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
                  rows={3}
                  maxLength={4000}
                  disabled={busy || example}
                  placeholder={
                    example
                      ? "「自分の準備に戻る」から、自由に話せます。"
                      : "気になっていることを、そのまま。\n「何から手をつければいいか分からない」からでも。"
                  }
                />
                <div className="composer-bottom">
                  <span>
                    {busy ? "入力は消えません" : "うまく書こうとしなくて大丈夫"}
                  </span>
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
                      disabled={!draft.trim() || example || !hydrated}
                    >
                      ここから整理する <span aria-hidden="true">↑</span>
                    </button>
                  )}
                </div>
              </form>
              <p className="privacy-hint">
                公開の試用版です。実名や病名は書かず、架空の内容で試してください。送信すると、会話とメモをClaudeに渡して整理します。
                <button onClick={() => setModal("privacy")}>詳しく</button>
              </p>
            </div>
          </section>
          <section className="preparation" aria-labelledby="memo-title">
            <div className="section-heading memo-heading">
              <div>
                <span className="section-number">PREPARE</span>
                <h2 id="memo-title">
                  家族のしおり
                  <span className="count">{workspace.cards.length}</span>
                </h2>
              </div>
              <span className="draft-label">少しずつ育てるメモ</span>
            </div>
            {workspace.cards.length === 0 ? (
              <div className="empty-board">
                <div className="paper-art" aria-hidden="true">
                  <div className="paper back" />
                  <div className="paper front">
                    <Mark small />
                    <i />
                    <i />
                    <i />
                    <b>一枚から、はじめよう。</b>
                  </div>
                </div>
                <h3>
                  話したことが、
                  <br />
                  家族の役に立つかたちに。
                </h3>
                <p>
                  退院の日に要るお金。朝の支度の引き継ぎ。窓口への質問文。
                  <br />
                  大切にしておきたい、今日のひと言。
                  <br />
                  会話から、ここにメモができていきます。
                </p>
                <ol className="steps">
                  <li>
                    <span>1</span>気がかりを話す
                  </li>
                  <li>
                    <span>2</span>できた文章を確かめる
                  </li>
                  <li>
                    <span>3</span>渡すものを選ぶ
                  </li>
                </ol>
              </div>
            ) : (
              <>
                <div className="board-summary">
                  <span>
                    <strong>
                      {workspace.cards.filter((c) => c.done).length}
                    </strong>{" "}
                    / {workspace.cards.length} 件の準備ができました
                  </span>
                  <p>全部を一度に進めなくても。ひとつ選ぶところから。</p>
                </div>
                <div className="filters" aria-label="メモの絞り込み">
                  <button
                    aria-pressed={filter === "all"}
                    onClick={() => setFilter("all")}
                  >
                    すべて
                  </button>
                  {Object.entries(kinds).map(([k, v]) => (
                    <button
                      key={k}
                      aria-pressed={filter === k}
                      onClick={() => setFilter(k as Card["kind"])}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <div className="cards">
                  {workspace.cards
                    .filter((c) => filter === "all" || c.kind === filter)
                    .map((card) => (
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
                      />
                    ))}
                  {!workspace.cards.some(
                    (c) => filter === "all" || c.kind === filter,
                  ) && (
                    <p className="filter-empty">
                      この種類のメモは、まだありません。
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
                    選んだ{selected}件を確認 <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
        <footer className="workspace-footer">
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
            会話とメモを消去
          </button>
          <p>
            さきよみは、家族の準備を進めるための試作です。診療や保障の判断は行いません。
          </p>
        </footer>
      </main>
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
            <h3>公開の試用版です</h3>
            <p>
              ログインなしで試せるように公開しています。Claudeとの会話は、1台あたり1日20回までなどの上限があります。架空の体験例は回数の制限なく試せます。実名、病名、連絡先は書かないでください。
            </p>
            <h3>保存する場所を自分で選べます</h3>
            <p>
              初期状態では、この画面を閉じると会話とメモは消えます。「このブラウザに保存」を選ぶと、この端末のブラウザに残ります。共有端末では保存を選ばないでください。アプリのサーバーは会話を保存しません。
            </p>
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
        <Modal title="会話とメモを消去しますか" close={() => setModal(null)}>
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
                setNotice("会話とメモを消去しました。");
                setModal(null);
              }}
            >
              消去して新しく始める
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
