// 本番はログインなしで公開する（ADR 0012）。ここでは別サイトからの送信を拒否する。
export function isAllowedRequest(
  request: Request,
  allowedOrigins: string[] = [],
): boolean {
  try {
    const url = new URL(request.url);
    // Next.js内部のURLはlocalhostに正規化されるため、ブラウザが指定したHostと照合する。
    const host = request.headers.get("host") || url.host;
    const origin = new URL(request.headers.get("origin") || "");
    const local =
      !process.env.VERCEL &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) &&
      origin.protocol === url.protocol;
    const deployed =
      origin.protocol === "https:" && allowedOrigins.includes(origin.origin);
    return origin.host === host && (local || deployed);
  } catch {
    return false;
  }
}

// プロンプトに入る量の上限でもある。道具の往復ごとに送り直すので、公開版の費用に直接効く。
export const MAX_REQUEST_BYTES = 60_000;

export async function readBoundedJson(
  request: Request,
  limit = MAX_REQUEST_BYTES,
): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("content-type");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty-body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("body-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
