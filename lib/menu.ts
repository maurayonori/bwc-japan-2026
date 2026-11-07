import { VIEW_HASH } from "./views";

// アプリ全体の 1 つのメニュー（#52、ADR 0015）。行き先はここにだけ書き、どのページも同じものを出す。
// 「話す」「見通し」「渡すもの」はさきよみの会話の画面（/ の # で切り替える）。年表とあそぶは別のページ。
// ペルソナは手元で動かす Persona Studio への外部リンクで、NEXT_PUBLIC_PERSONA_URL があるときだけ出す。
export type MenuKey = "talk" | "outlook" | "hand" | "roadmap" | "play" | "persona";

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
export function personaHref(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function menuItems(personaUrl: string | undefined): MenuItem[] {
  const persona = personaHref(personaUrl);
  return [
    ...BASE_ITEMS,
    ...(persona
      ? [
          {
            key: "persona" as const,
            label: "ペルソナ",
            href: persona,
            group: "tools" as const,
            external: true,
          },
        ]
      : []),
  ];
}
