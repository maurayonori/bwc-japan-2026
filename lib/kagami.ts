// かがみ（#54、ADR 0016）: 撮っている映像を見ながら録画し、その場で見返す。合成・映像の解析・AI の呼び出しはしない。
// 撮ったものはこのタブのメモリにだけ置く。サーバーにもブラウザの保存領域にも書かない。タブを閉じると消える。

// 1 本の上限。これを過ぎたら自動で止める。
export const MAX_RECORDING_MS = 2 * 60 * 1000;

// 録画の形式の候補。上から順に、このブラウザで録れるものを使う。
// MP4（H.264・AAC）はスマホの写真アプリなどでも開きやすいので先に試し、録れなければ WebM にする。
const WITH_AUDIO = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;
const VIDEO_ONLY = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

// 録れる形式が 1 つも無ければ null（MediaRecorder に任せる）。
export function pickRecordingType(
  isTypeSupported: (type: string) => boolean,
  withAudio: boolean,
): string | null {
  for (const type of withAudio ? WITH_AUDIO : VIDEO_ONLY) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // 判定できない形式は飛ばす
    }
  }
  return null;
}

// 保存するときの拡張子。
export function extensionOf(type: string): string {
  const base = type.split(";")[0].trim().toLowerCase();
  if (base === "video/mp4") return "mp4";
  if (base === "video/quicktime") return "mov";
  if (base === "video/x-matroska") return "mkv";
  return "webm";
}

const two = (n: number) => String(n).padStart(2, "0");

// 端末に保存するときの名前。端末の時刻で付ける（例: kagami-20261107-183012.webm）。
export function clipFileName(at: Date, type: string): string {
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `kagami-${stamp}.${extensionOf(type)}`;
}

// 経過時間を「1:05」の形にする。
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${two(total % 60)}`;
}

export interface Clip {
  id: string;
  // このタブの中だけで使える blob: の URL。消すときに解放する。
  url: string;
  name: string;
  type: string;
  size: number;
  // 撮った（選んだ）時刻
  at: number;
  // 録った長さ。端末から選んだ動画は分からないので null。
  durationMs: number | null;
  source: "camera" | "file";
}

type UrlApi = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

// このタブのメモリ。メニューで移ってもページを読み込み直さないので残り、タブを閉じると消える。
let clips: readonly Clip[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function emit() {
  for (const listener of listeners) listener();
}

export function getClips(): readonly Clip[] {
  return clips;
}

export function subscribeClips(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addClip(
  blob: Blob,
  info: { name: string; at: number; durationMs: number | null; source: Clip["source"] },
  urls: UrlApi = URL,
): Clip {
  const clip: Clip = {
    id: `clip-${++nextId}`,
    url: urls.createObjectURL(blob),
    name: info.name,
    type: blob.type,
    size: blob.size,
    at: info.at,
    durationMs: info.durationMs,
    source: info.source,
  };
  clips = [clip, ...clips];
  emit();
  return clip;
}

export function removeClip(id: string, urls: UrlApi = URL): void {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  urls.revokeObjectURL(clip.url);
  clips = clips.filter((c) => c.id !== id);
  emit();
}

// テストのため。画面からは呼ばない。
export function clearClips(urls: UrlApi = URL): void {
  for (const clip of clips) urls.revokeObjectURL(clip.url);
  clips = [];
  emit();
}

// 大きさを「1.2 MB」の形にする。
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
