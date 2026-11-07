import { yenRange } from "./money/format";
import type { Card, Message } from "./workspace";

// 画面は「話す」「見通し」「渡すもの」の 3 つ。URL の # で切り替えるので、ブラウザの戻るでも戻れる。
export const VIEWS = ["talk", "outlook", "hand"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_HASH: Record<View, string> = {
  talk: "#talk",
  outlook: "#outlook",
  hand: "#hand",
};

// 知らない # や # 無しは、最初の画面（話す）にする。
export function viewFromHash(hash: string): View {
  const name = hash.replace(/^#/, "");
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : "talk";
}

export const isHandCard = (card: Card): boolean => card.kind !== "money";

export interface ResultLink {
  view: View;
  label: string;
}

// お金のカードにある、一番あとに計算した見通しの「要る額の幅」。順位の無い前の保存データでは null。
export function needRangeOf(card: Card): { low: number; high: number } | null {
  const cashflow = card.money?.calculations.findLast(
    (calculation) => calculation.name === "simulate_cashflow",
  );
  if (cashflow?.name !== "simulate_cashflow") return null;
  const range = cashflow.output.what_to_confirm;
  return range ? { low: range.need_low, high: range.need_high } : null;
}

// 返答の下に出す移動のリンク。その返答で作ったり直したりしたカードが、いまも残っているときだけ出す。
// 金額は道具の出力だけから組み立てる。カードはあとの返答で直されることがあるので、
// 金額を入れるのは、そのお金のカードを最後に扱った返答だけにする（withAmount）。
export function resultLinks(
  message: Message,
  cards: readonly Card[],
  withAmount: boolean,
): ResultLink[] {
  if (message.role !== "assistant" || !message.cardIds?.length) return [];
  const ids = new Set(message.cardIds);
  const touched = cards.filter((card) => ids.has(card.id));
  const money = touched.find((card) => !isHandCard(card));
  const hand = touched.filter(isHandCard);
  const range = money && withAmount ? needRangeOf(money) : null;
  return [
    ...(money
      ? [
          {
            view: "outlook" as const,
            label: range
              ? `要る額 ${yenRange(range.low, range.high)}と、まず確かめる 1 つを見る`
              : "要る額の幅と、まず確かめる 1 つを見る",
          },
        ]
      : []),
    ...(hand.length > 0
      ? [{ view: "hand" as const, label: `渡すものを見る（${hand.length} 件）` }]
      : []),
  ];
}

// 金額を入れてよい返答: お金のカードを扱った返答のうち、一番あとのもの。
export function latestMoneyMessageId(
  messages: readonly Message[],
  cards: readonly Card[],
): string | null {
  const moneyIds = new Set(
    cards.filter((card) => !isHandCard(card)).map((card) => card.id),
  );
  return (
    messages.findLast(
      (message) =>
        message.role === "assistant" &&
        (message.cardIds ?? []).some((id) => moneyIds.has(id)),
    )?.id ?? null
  );
}
