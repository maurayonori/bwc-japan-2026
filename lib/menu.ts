import { VIEW_HASH } from "./views";

// アプリ全体の 1 つのメニュー（#52、ADR 0015）。行き先はここにだけ書き、どのページも同じものを出す。
// 「話す」「見通し」「渡すもの」はさきよみの会話の画面（/ の # で切り替える）。年表とあそぶは別のページ。
// ペルソナ（手元で動かす Persona Studio）とかがみは外部リンクで、それぞれ NEXT_PUBLIC_PERSONA_URL・NEXT_PUBLIC_KAGAMI_URL があるときだけ出す。
// どちらのコードもこのリポジトリには入れない。公開の配置では設定しないので出ない。
export type MenuKey =
  | "talk"
  | "outlook"
  | "hand"
  | "roadmap"
  | "play"
  | "persona"
  | "kagami";

export interface MenuItem {
  key: MenuKey;
  label: string;
  href: string;
  // さきよみの会話の画面か、別の道具か。メニューでは間に区切りを置く。
  group: "sakiyomi" | "tools";
  external?: boolean;
}

export const HOME_KEYS = ["talk", "outlook", "hand"] as const;
export type HomeKey = (typeof HOME_KEYS)[number];
export const isHomeKey = (key: MenuKey): key is HomeKey =>
  (HOME_KEYS as readonly string[]).includes(key);

const BASE_ITEMS: readonly MenuItem[] = [
  { key: "talk", label: "話す", href: `/${VIEW_HASH.talk}`, group: "sakiyomi" },
  {
    key: "outlook",
    label: "見通し",
    href: `/${VIEW_HASH.outlook}`,
    group: "sakiyomi",
  },
  { key: "hand", label: "渡すもの", href: `/${VIEW_HASH.hand}`, group: "sakiyomi" },
  { key: "roadmap", label: "年表", href: "/roadmap", group: "tools" },
  { key: "play", label: "あそぶ", href: "/play", group: "tools" },
];

// 外部リンクにしてよい URL だけを通す。http と https 以外（javascript: など）や読めない値は出さない。
export function externalHref(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// 外部リンクの行き先。出す順もこの並び（ペルソナのあとにかがみ）。
const EXTERNAL_ITEMS = [
  { key: "persona", label: "ペルソナ" },
  { key: "kagami", label: "かがみ" },
] as const;

export type ExternalKey = (typeof EXTERNAL_ITEMS)[number]["key"];

export function menuItems(
  urls: Partial<Record<ExternalKey, string | undefined>> = {},
): MenuItem[] {
  const external = EXTERNAL_ITEMS.flatMap(({ key, label }) => {
    const href = externalHref(urls[key]);
    return href
      ? [{ key, label, href, group: "tools" as const, external: true }]
      : [];
  });
  return [...BASE_ITEMS, ...external];
}
