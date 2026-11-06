import { createHash, randomBytes } from "node:crypto";

// 公開版で Claude API の費用を上限内に収めるための、1 日あたりの回数制限。
// 状態はサーバーの実行インスタンスのメモリにある。インスタンスが増えると上限はその数だけ緩み、
// 入れ替わると数え直しになる。外部の保存先を増やさない代わりに、厳密な上限にはしない（ADR 0012）。
export type LimitConfig = {
  perClientPerDay: number;
  globalPerDay: number;
  /** 追跡する端末の上限。超えたら新しい端末を断り、メモリを増やし続けない。 */
  maxClients: number;
};

export type LimitResult =
  | { ok: true; clientRemaining: number; globalRemaining: number }
  | { ok: false; reason: "client" | "global" | "capacity" };

export type DailyLimiter = {
  /** 1 回分を数える。上限に達していれば数えずに断る。 */
  take: (clientKey: string, nowMs?: number) => LimitResult;
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 日本時間の 0 時で切り替わる日の番号。 */
export function jstDayNumber(nowMs: number): number {
  return Math.floor((nowMs + JST_OFFSET_MS) / DAY_MS);
}

export function createDailyLimiter(config: LimitConfig): DailyLimiter {
  let day = -1;
  let globalCount = 0;
  let clients = new Map<string, number>();

  return {
    take(clientKey, nowMs = Date.now()) {
      const today = jstDayNumber(nowMs);
      if (today !== day) {
        day = today;
        globalCount = 0;
        clients = new Map();
      }
      const used = clients.get(clientKey) ?? 0;
      if (globalCount >= config.globalPerDay)
        return { ok: false, reason: "global" };
      if (used >= config.perClientPerDay)
        return { ok: false, reason: "client" };
      if (used === 0 && clients.size >= config.maxClients)
        return { ok: false, reason: "capacity" };
      clients.set(clientKey, used + 1);
      globalCount += 1;
      return {
        ok: true,
        clientRemaining: config.perClientPerDay - used - 1,
        globalRemaining: config.globalPerDay - globalCount,
      };
    },
  };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 環境変数で上書きできる既定の上限。不正な値は既定に戻す。 */
export function limitConfigFromEnv(
  env: Record<string, string | undefined>,
): LimitConfig {
  return {
    perClientPerDay: readPositiveInt(env.LIMIT_PER_CLIENT_PER_DAY, 20),
    globalPerDay: readPositiveInt(env.LIMIT_GLOBAL_PER_DAY, 150),
    maxClients: 5000,
  };
}

// 接続元をそのまま持たないよう、起動ごとの乱数を混ぜた要約だけを数える。
const SALT = randomBytes(16);

// IPv6 は 1 つの契約で /64 の中のアドレスを自由に使えるので、/64 を 1 つの接続元として数える。
function networkOf(address: string): string {
  if (!address.includes(":")) return address;
  // ::ffff:203.0.113.9 は IPv4 の接続元。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  const [head, tail = ""] = address.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill(
    "0",
  );
  return [...left, ...zeros, ...right]
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
}

/**
 * 端末を見分ける鍵を作る。Vercel が設定する接続元ヘッダーを優先する。
 * x-forwarded-for は利用者が先頭に任意の値を足せるので、最後の値を使う。
 */
export function clientKeyFrom(headers: Headers): string {
  const forwarded = headers.get("x-vercel-forwarded-for");
  const chain = (forwarded ?? headers.get("x-forwarded-for") ?? "").split(",");
  const address = chain.at(forwarded ? 0 : -1)?.trim() || "unknown";
  return createHash("sha256")
    .update(SALT)
    .update(networkOf(address))
    .digest("hex");
}

export function limitMessage(reason: "client" | "global" | "capacity"): string {
  return reason === "client"
    ? "この端末の今日の試用回数に達しました。入力とメモは残っています。架空の体験例は引き続き試せます。"
    : "今日の公開版の利用上限に達しました。入力とメモは残っています。架空の体験例は引き続き試せます。";
}
