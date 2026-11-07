"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { keptCounts } from "@/lib/kept-workspace";
import { isHomeKey, menuItems, type MenuItem, type MenuKey } from "@/lib/menu";
import { VIEW_HASH } from "@/lib/views";

function Mark() {
  return (
    <svg className="mark small" viewBox="0 0 40 40" fill="none" aria-hidden="true">
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

type Counts = { outlook: number; hand: number };

function MenuLink({
  item,
  current,
  count,
}: {
  item: MenuItem;
  current: MenuKey;
  count?: number;
}) {
  const label = (
    <>
      {item.label}
      {count !== undefined && <span className="count">{count}</span>}
    </>
  );
  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer">
        {item.label}
        <span aria-hidden="true">↗</span>
        <span className="sr-only">（別のタブで開く）</span>
      </a>
    );
  }
  const ariaCurrent = item.key === current ? ("page" as const) : undefined;
  // 会話の画面の中の移動は、今までどおり # だけを変える（hashchange で表示を切り替える）。
  if (isHomeKey(current) && isHomeKey(item.key)) {
    return (
      <a href={VIEW_HASH[item.key]} aria-current={ariaCurrent}>
        {label}
      </a>
    );
  }
  // ページをまたぐ移動は読み込み直さない。会話の画面の状態をメモリに残すため（ADR 0015）。
  return (
    <Link href={item.href} aria-current={ariaCurrent} prefetch={false}>
      {label}
    </Link>
  );
}

// 全ページで同じ 1 つのメニュー（#52、ADR 0015）。会話の画面では件数を、ほかのページではメモリに残っている件数を出す。
// ペルソナは、ビルドのときに URL があるときだけ出す外部リンク。
// children はヘッダーの右に置くもの（会話の画面の「保存とプライバシー」など）。
export function SiteHeader({
  current,
  counts,
  children,
}: {
  current: MenuKey;
  counts?: Counts;
  children?: ReactNode;
}) {
  // ほかのページでは、会話の画面から移ってきたときだけ件数がある。最初の描画で一度だけ読む。
  const [shown] = useState<Counts | null>(() => counts ?? keptCounts());
  const shownCounts = counts ?? shown;
  // NEXT_PUBLIC_ の値はビルドのときに埋め込まれる。名前をそのまま書く（まとめて読むと埋め込まれない）。
  const items = menuItems({ persona: process.env.NEXT_PUBLIC_PERSONA_URL });
  const home = isHomeKey(current);
  // 外部リンクの数。中くらいの幅でヘッダーをどこまで詰めるかを、CSS がこれで決める。
  const links = items.filter((item) => item.external).length;
  const primary = items.filter((item) => item.group === "sakiyomi");
  const tools = items.filter((item) => item.group === "tools");
  return (
    <header className="site-header" data-links={links}>
      {home ? (
        <a className="brand" href={VIEW_HASH.talk} aria-label="さきよみ（話す）">
          <Mark />
          <span>
            さきよみ<small>入院のお金、支払日に間に合う準備</small>
          </span>
        </a>
      ) : (
        <Link className="brand" href={`/${VIEW_HASH.talk}`} aria-label="さきよみ（話す）">
          <Mark />
          <span>
            さきよみ<small>入院のお金、支払日に間に合う準備</small>
          </span>
        </Link>
      )}
      <nav className="view-nav" aria-label="メニュー">
        <ul>
          {primary.map((item) => (
            <li key={item.key}>
              <MenuLink
                item={item}
                current={current}
                count={
                  item.key === "outlook" || item.key === "hand"
                    ? shownCounts?.[item.key]
                    : undefined
                }
              />
            </li>
          ))}
          {/* 区切りのあとに、家族の道具（年表・あそぶ・かがみ）を小さく控えめに並べる。主は会話の画面の 3 つ。 */}
          {tools.length > 0 && (
            <li className="tools-start">
              <ul className="menu-tools" aria-label="家族の道具">
                {tools.map((item) => (
                  <li key={item.key}>
                    <MenuLink item={item} current={current} />
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      </nav>
      {children}
    </header>
  );
}
