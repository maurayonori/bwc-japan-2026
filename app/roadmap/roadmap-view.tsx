"use client";

import { useLayoutEffect, useRef } from "react";
import type { RoadmapParts } from "@/lib/roadmap-page";

declare global {
  interface Window {
    SAKIYOMI_ROADMAP?: boolean;
    startRoadmap?: () => () => void;
  }
}

// 年表の HTML をこのページの中に置き、ページに入るたびに動かし、離れるときに止める（#52、ADR 0015）。
// iframe は使わない。年表の中身と動きは docs/prototypes/sapporo-roadmap.html のまま。
export function RoadmapView({ css, markup, code }: RoadmapParts) {
  const root = useRef<HTMLElement>(null);
  // 離れるときは、DOM を外す前に止める（年表の hashchange と popstate の受け取りを外す）。
  useLayoutEffect(() => {
    const box = root.current;
    if (!box) return;
    // 入るたびに元の形から始める（開発時の二度目の実行でも、区の選択肢などが重ならない）。
    box.innerHTML = markup;
    window.SAKIYOMI_ROADMAP = true;
    const script = document.createElement("script");
    script.textContent = code;
    document.body.appendChild(script);
    script.remove();
    const stop = window.startRoadmap?.();
    return () => stop?.();
  }, [markup, code]);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <main
        className="roadmap-main"
        ref={root}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    </>
  );
}
