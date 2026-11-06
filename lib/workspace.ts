import { z } from "zod";

export const kinds = {
  daily: { label: "暮らしの引き継ぎ", mark: "01" },
  contact: { label: "確かめる・頼む", mark: "02" },
  memory: { label: "残しておく言葉", mark: "03" },
} as const;

const id = z.string().min(1).max(80);
export const messageSchema = z.object({
  id,
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(4000),
});
export const proposalSchema = z.object({
  id,
  kind: z.enum(["daily", "contact", "memory"]),
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(2000),
  nextStep: z.string().min(1).max(200),
  uncertainty: z.string().max(400),
  evidence: z
    .array(z.object({ messageId: id, quote: z.string().min(1).max(2000) }))
    .min(1)
    .max(4),
});
export const cardSchema = proposalSchema.extend({
  edited: z.boolean(),
  done: z.boolean(),
  included: z.boolean(),
});
export const replySchema = z.object({
  reply: z.string().min(1).max(1800),
  cards: z.array(proposalSchema).max(4),
});
export const workspaceSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["live", "example"]),
  messages: z.array(messageSchema).max(40),
  cards: z.array(cardSchema).max(24),
});
export const requestSchema = workspaceSchema
  .pick({ messages: true, cards: true })
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

export function emptyWorkspace(): Workspace {
  return { version: 1, mode: "live", messages: [], cards: [] };
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

export function exportMemo(cards: Card[]): string {
  const selected = cards.filter((card) => card.included);
  if (selected.length === 0) return "";
  return [
    "家族のしおり",
    "渡す前の確認用メモです。未確認の内容は各項目に記載しています。",
    ...selected.map((card) =>
      [
        `【${kinds[card.kind].label}】${card.title}`,
        card.body,
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
