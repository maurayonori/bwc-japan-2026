import { isHandCard } from "./views";
import type { Workspace } from "./workspace";

// 会話の画面から年表やあそぶへ移って戻るあいだ、会話・計算の結果・直した文章を、このタブのメモリにだけ置く（#52、ADR 0015）。
// サーバーにもブラウザの保存領域にも書かない。タブを閉じるか再読み込みすると消える（「このブラウザに保存」を選んだときは、今までどおり localStorage から読む）。
// メニューの移動はページを読み込み直さない（Next.js の Link）ので、このモジュールの値は移動のあいだも残る。
export interface KeptWorkspace {
  workspace: Workspace;
  draft: string;
  remember: boolean;
  // 架空の体験例を見ているあいだに預けている、自分の会話と下書き。
  live: { workspace: Workspace; draft: string } | null;
}

let kept: KeptWorkspace | null = null;

export function keepWorkspace(value: KeptWorkspace): void {
  kept = value;
}

export function keptWorkspace(): KeptWorkspace | null {
  return kept;
}

export function forgetKeptWorkspace(): void {
  kept = null;
}

// ほかのページのメニューに出す件数。会話の画面をまだ開いていなければ出さない。
export function keptCounts(): { outlook: number; hand: number } | null {
  if (!kept) return null;
  const hand = kept.workspace.cards.filter(isHandCard).length;
  return { outlook: kept.workspace.cards.length - hand, hand };
}
