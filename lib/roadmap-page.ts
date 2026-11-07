import { readFileSync } from "node:fs";
import { join } from "node:path";

// 札幌の子育て年表を、さきよみの /roadmap としてページで配信するための部品（#52、ADR 0015）。
// 正本は docs/prototypes/sapporo-roadmap.html（単独でも開け、テストもこの HTML を読む）。
// ここでは HTML を 3 つに分けるだけで、中身は書き換えない: 見た目（<style>）、画面の HTML（<body> の中）、動き（2 つの <script>）。
// iframe は使わない（next.config.ts の X-Frame-Options: DENY はそのまま）。
export const ROADMAP_HTML_PATH = join(
  process.cwd(),
  "docs",
  "prototypes",
  "sapporo-roadmap.html",
);

export interface RoadmapParts {
  css: string;
  // 年表の画面。埋め込みデータ（<script id="data" type="application/json">）を含む。
  markup: string;
  // 日付の計算（<script id="model">）と、画面を動かす startRoadmap の定義。
  code: string;
}

function between(html: string, start: string, end: string, from = 0): string {
  const a = html.indexOf(start, from);
  if (a < 0) throw new Error(`年表の HTML に ${start} が無い`);
  const b = html.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`年表の HTML に ${start} の終わりが無い`);
  return html.slice(a + start.length, b);
}

export function splitRoadmapHtml(html: string): RoadmapParts {
  const css = between(html, "<style>", "</style>");
  const bodyStart = html.indexOf("<body>");
  const modelStart = html.indexOf('<script id="model">');
  if (bodyStart < 0 || modelStart < bodyStart)
    throw new Error("年表の HTML の <body> と <script id=\"model\"> の並びが違う");
  const markup = html.slice(bodyStart + "<body>".length, modelStart).trim();
  const model = between(html, '<script id="model">', "</script>");
  const app = between(html, "<script>", "</script>", modelStart);
  if (!/function startRoadmap\(\)/.test(app))
    throw new Error("年表の HTML に startRoadmap が無い");
  return { css, markup, code: `${model}\n${app}` };
}

// 読む場所は決め打ちにする（引数で場所を変えられると、ビルドがプロジェクト全体をサーバーの成果物に含めてしまう）。
export function readRoadmapParts(): RoadmapParts {
  return splitRoadmapHtml(
    readFileSync(join(process.cwd(), "docs", "prototypes", "sapporo-roadmap.html"), "utf8"),
  );
}
