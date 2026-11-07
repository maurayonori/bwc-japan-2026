import type { Metadata } from "next";
import { readRoadmapParts } from "@/lib/roadmap-page";
import { SiteHeader } from "../site-header";
import { RoadmapView } from "./roadmap-view";

// 年表の中身は docs/prototypes/sapporo-roadmap.html から、ビルドのときに読む（#52、ADR 0015）。
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "札幌の子育て年表 — さきよみ",
  description:
    "架空の子ども 2 人を例に、誕生から小学校入学までの札幌市の手続き・予防接種・預け先の事前登録を 1 枚の年表にした試作です。",
};

export default function RoadmapPage() {
  const parts = readRoadmapParts();
  return (
    <div className="app-shell is-page">
      <SiteHeader current="roadmap" />
      <RoadmapView {...parts} />
    </div>
  );
}
