import { z } from "zod";
import { todayInJapan } from "./money/dates";
import { citationsToText, moneyToText } from "./money/format";
import { fixGapDirection, maskProblems } from "./money/guard";
import {
  MAX_WARNINGS,
  moneyRequestSchema,
  moneySchema,
  warningSchema,
} from "./money/schema";

export const kinds = {
  daily: { label: "暮らしの引き継ぎ", mark: "01" },
  contact: { label: "確かめる・頼む", mark: "02" },
  memory: { label: "残しておく言葉", mark: "03" },
  money: { label: "お金の見通し", mark: "04" },
} as const;

// サーバーは 52 秒で打ち切って返す（lib/chat.ts）。応答が届くぶんの余裕を見て、画面はそのあとで諦める。
export const CHAT_CLIENT_TIMEOUT_MS = 58_000;

const id = z.string().min(1).max(80);
export const messageSchema = z.object({
  id,
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(4000),
  warnings: z.array(warningSchema).max(MAX_WARNINGS).optional(),
  // この返答で呼んだ計算の名前（画面の「この返答で呼んだ計算」）。前の保存データには無い。
  tools: z.array(z.string()).max(40).optional(),
  // この返答で作ったり直したりしたカードの id。返答の下の「見る」リンクに使う。前の保存データには無い。
  cardIds: z.array(id).max(5).optional(),
});
// 返答とカードの欄の字数の上限。サーバーの後処理（伏字・案内の置き換え）のあとも、この中に収める。
export const TEXT_LIMITS = {
  reply: 1800,
  title: 80,
  body: 2000,
  nextStep: 200,
  uncertainty: 400,
} as const;
export const proposalSchema = z.object({
  id,
  kind: z.enum(["daily", "contact", "memory", "money"]),
  title: z.string().min(1).max(TEXT_LIMITS.title),
  body: z.string().min(1).max(TEXT_LIMITS.body),
  nextStep: z.string().min(1).max(TEXT_LIMITS.nextStep),
  uncertainty: z.string().max(TEXT_LIMITS.uncertainty),
  evidence: z
    .array(z.object({ messageId: id, quote: z.string().min(1).max(2000) }))
    .min(1)
    .max(4),
  money: moneySchema.optional(),
});
export const cardSchema = proposalSchema.extend({
  edited: z.boolean(),
  done: z.boolean(),
  included: z.boolean(),
});
// Claude に出してもらう形。表の項目を持たせない（表はサーバーが道具の結果から作る）。
export const modelReplySchema = z.object({
  reply: z.string().min(1).max(TEXT_LIMITS.reply),
  cards: z.array(proposalSchema.omit({ money: true })).max(4),
});
// 合成カードを足すことがあるので、モデルの上限より 1 枚多く受ける。
export const replySchema = z.object({
  reply: z.string().min(1).max(TEXT_LIMITS.reply),
  cards: z.array(proposalSchema).max(5),
  warnings: z.array(warningSchema).max(MAX_WARNINGS).optional(),
  tools: z.array(z.string()).max(40).optional(),
});
export const workspaceSchema = z.object({
  version: z.literal(2),
  mode: z.enum(["live", "example"]),
  messages: z.array(messageSchema).max(40),
  cards: z.array(cardSchema).max(24),
});
// 計算の結果は送らない。入力だけ受け取り、サーバーで計算し直す（改ざんされた数字を信じないため）。
const requestCardSchema = cardSchema
  .omit({ money: true })
  .extend({ money: moneyRequestSchema.optional() });
export const requestSchema = z
  .object({
    messages: workspaceSchema.shape.messages,
    cards: z.array(requestCardSchema).max(24),
  })
  .refine(
    (v) => v.messages.length > 0 && v.messages.at(-1)?.role === "user",
    "最後の発言が必要です",
  )
  .refine(
    (v) => v.messages.reduce((n, m) => n + m.text.length, 0) <= 32000,
    "会話が長くなりました",
  )
  .refine(
    (v) => new Set(v.messages.map((m) => m.id)).size === v.messages.length,
    "発言IDが重複しています",
  )
  .refine(
    (v) => new Set(v.cards.map((c) => c.id)).size === v.cards.length,
    "メモIDが重複しています",
  );

export type Message = z.infer<typeof messageSchema>;
export type Card = z.infer<typeof cardSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Reply = z.infer<typeof replySchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type ChatRequest = z.infer<typeof requestSchema>;

export function emptyWorkspace(): Workspace {
  return { version: 2, mode: "live", messages: [], cards: [] };
}

// 送るのは発言の本文と、計算の入力まで。表の結果と注意は、この端末にだけ置く。
export function toRequest(
  messages: readonly Message[],
  cards: readonly Card[],
): ChatRequest {
  return {
    messages: messages.map(({ id, role, text }) => ({ id, role, text })),
    cards: cards.map((card) => ({
      ...card,
      money: card.money && {
        calculations: card.money.calculations.map(({ name, input }) => ({
          name,
          input,
        })),
      },
    })),
  };
}

const storedWorkspaceSchema = workspaceSchema.extend({
  version: z.union([z.literal(1), z.literal(2)]),
});

// #59 より前の版で保存した「残しておく言葉」は、Claude が作った見出しと次の行動を持っている。
// 次の行動が決まった文でないもの（前の版の形）は、本人が直したもの以外、読み込むときに原文の見出しと決まった文にそろえる（#61 の指摘 11）。
// 体験例の見出し（作者が書いた架空の文）は、今の形で保存されているので、そのまま読む。
function normalizeStoredMemory(card: Card): Card {
  if (card.kind !== "memory" || card.edited) return card;
  if (card.nextStep === MEMORY_NEXT_STEP && card.uncertainty === "") return card;
  return memoryForExport(card);
}

// version 1（お金のカードが無かった頃）の保存データも、そのまま読む。読めないときは投げる。
export function parseStoredWorkspace(raw: string): Workspace {
  const stored = storedWorkspaceSchema.parse(JSON.parse(raw));
  return { ...stored, version: 2, cards: stored.cards.map(normalizeStoredMemory) };
}

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem">;

// 読めない保存データを消さない。保存し直しても上書きされないよう、別のキーへ写しておく。
export function readStoredWorkspace(storage: WorkspaceStorage): {
  workspace: Workspace | null;
  unreadable: boolean;
} {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return { workspace: null, unreadable: false };
  try {
    return { workspace: parseStoredWorkspace(raw), unreadable: false };
  } catch {
    try {
      storage.setItem(UNREADABLE_STORAGE_KEY, raw);
    } catch {
      // 写せなくても、元のキーには残っている。
    }
    return { workspace: null, unreadable: true };
  }
}

// 発言にない引用や、AIが書いた言葉を「本人の言葉」として残さない。
export function validateEvidence(reply: Reply, messages: Message[]): Reply {
  if (new Set(reply.cards.map((c) => c.id)).size !== reply.cards.length)
    throw new Error("duplicate-card");
  for (const card of reply.cards) {
    for (const evidence of card.evidence) {
      const source = messages.find(
        (m) => m.id === evidence.messageId && m.role === "user",
      );
      if (!source?.text.includes(evidence.quote))
        throw new Error("invalid-evidence");
    }
    if (
      card.kind === "memory" &&
      card.body !== card.evidence.map((e) => e.quote).join("\n\n")
    ) {
      throw new Error("invented-memory");
    }
  }
  return reply;
}

export function mergeCards(current: Card[], proposals: Proposal[]): Card[] {
  const cards = [...current];
  for (const proposal of proposals) {
    const index = cards.findIndex((c) => c.id === proposal.id);
    if (index >= 0) {
      const previous = cards[index];
      // 編集済み・完了済み・持ち出すと選んだ文章は、会話で勝手に書き換えない。
      if (!previous.edited && !previous.done && !previous.included)
        cards[index] = { ...previous, ...proposal };
    } else if (cards.length < 24) {
      cards.push({ ...proposal, edited: false, done: false, included: false });
    }
  }
  return cards;
}

// 「残しておく言葉」は本人の発言の原文だけにする（#59 の指摘 2）。
// 見出しと次の行動も作らせない。見出しは原文の最初の一文、次の行動は固定の文にする。
export const MEMORY_NEXT_STEP = "この言葉を残しておくか、自分で選ぶ。";
const MAX_MEMORY_TITLE = 40;

export function memoryTitle(body: string): string {
  const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
  const sentence = /^[^。！？]*[。！？]?/.exec(firstLine.trim())?.[0] ?? "";
  return sentence.slice(0, MAX_MEMORY_TITLE) || "残しておく言葉";
}

export function asMemory<
  T extends { title: string; body: string; nextStep: string; uncertainty: string },
>(card: T): T {
  return {
    ...card,
    title: memoryTitle(card.body),
    nextStep: MEMORY_NEXT_STEP,
    uncertainty: "",
  };
}

// 読み込むときと持ち出すときの「残しておく言葉」。本人が直したものはそのまま、それ以外は原文にない見出しと次の行動を書かない。
function memoryForExport(card: Card): Card {
  if (card.kind !== "memory" || card.edited) return card;
  const fixed = asMemory(card);
  return card.body.includes(card.title) ? { ...fixed, title: card.title } : fixed;
}

// 持ち出す直前にも、カードの文の金額と日付を、カードの計算・会話・出典と照らし、照らせない部分を伏せる
// （3 回目の指摘 6）。前の版で保存したカードや、検査より前に作られたカードが、そのまま家族や窓口へ渡らないように。
// 本人が直したカードは本人の文なので触らない。残しておく言葉は原文なので触らない。
function verifiedForExport(
  card: Card,
  cards: readonly Card[],
  messages: readonly Message[],
): Card {
  if (card.edited || card.kind === "memory") return card;
  const args = {
    // 要る額の範囲は「最新の計算」と照らすので、そのカード自身の計算を最後に置く（4 回目の指摘④）。
    // 選んだあとに条件を変えた、別のカードの計算で照らさないため。
    toolEvents: [
      ...cards
        .filter((item) => item.id !== card.id)
        .flatMap((item) => item.money?.calculations ?? []),
      ...(card.money?.calculations ?? []),
    ],
    // 会話が渡されないときも、カードの根拠の引用（本人の発言の原文）は使う。
    userTexts: [
      ...messages.filter((message) => message.role === "user").map((message) => message.text),
      ...cards.flatMap((item) => item.evidence.map((evidence) => evidence.quote)),
    ],
    earlierReplies: messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text),
    today: todayInJapan(),
  };
  // 足りない額と残る額の向きを逆に書いた文は、計算から作った文に置き換えてから伏せる（#66 の A-3）。
  const mask = (text: string) =>
    maskProblems({
      ...args,
      text: fixGapDirection(text, args.toolEvents).text,
    }).text;
  return {
    ...card,
    title: mask(card.title),
    body: mask(card.body),
    nextStep: mask(card.nextStep),
    uncertainty: mask(card.uncertainty),
  };
}

export function exportMemo(
  cards: Card[],
  messages: readonly Message[] = [],
): string {
  const selected = cards
    .filter((card) => card.included)
    .map(memoryForExport)
    .map((card) => verifiedForExport(card, cards, messages));
  if (selected.length === 0) return "";
  return [
    "さきよみ — 渡すもの",
    "渡す前の確認用メモです。未確認の内容は各項目に記載しています。",
    ...selected.map((card) =>
      [
        `【${kinds[card.kind].label}】${card.title}`,
        card.body,
        card.kind === "money" && card.money
          ? moneyToText(card.money, `${card.body}\n${card.uncertainty}`)
          : card.kind === "memory"
            ? ""
            : citationsToText(`${card.body}\n${card.uncertainty}`),
        card.uncertainty ? `まだ確かめていないこと：${card.uncertainty}` : "",
        `次にすること：${card.nextStep}`,
        `準備の状態：${card.done ? "本人が完了を確認" : "これから"}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
  ].join("\n\n──────────\n\n");
}

export const STORAGE_KEY = "sakiyomi-family-v1";
export const UNREADABLE_STORAGE_KEY = "sakiyomi-family-unreadable";
