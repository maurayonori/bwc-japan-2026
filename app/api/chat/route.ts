import { createAnthropic } from "@ai-sdk/anthropic";
import { runChat } from "@/lib/chat";
import { requestSchema } from "@/lib/workspace";
import { isAllowedRequest, readBoundedJson } from "@/lib/request";
import { readApiKey } from "@/lib/credentials";
import {
  clientKeyFrom,
  createDailyLimiter,
  limitConfigFromEnv,
  limitMessage,
} from "@/lib/limits";

export const runtime = "nodejs";
// Vercel の上限。runChat はこの手前（52 秒）で打ち切る。画面は 58 秒で諦める。
export const maxDuration = 60;

// 公開版の費用を上限内に収める。送信元と入力の検査を通ったものだけを数える（ADR 0012）。
const limiter = createDailyLimiter(limitConfigFromEnv(process.env));

const MAX_CARDS = 24;
const TOO_MANY_CARDS = `メモが${MAX_CARDS}件を超えます。必要なメモを持ち出し、不要なメモを消してから、もう一度試してください。入力は残っています。`;

function fail(error: string, status: number) {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const allowedOrigins = [
    process.env.APP_ORIGIN,
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
    process.env.VERCEL_PROJECT_PRODUCTION_URL &&
      `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ].filter((origin): origin is string => Boolean(origin));
  if (!isAllowedRequest(request, allowedOrigins))
    return fail("アプリを開いたページから送信してください。", 403);
  let input;
  try {
    input = requestSchema.parse(await readBoundedJson(request));
  } catch {
    return fail(
      "会話が長すぎるか、読み取れない内容がありました。メモを持ち出してから、新しい会話を始めてください。",
      400,
    );
  }
  // すでに上限なら、費用と回数を使う前に断る。
  if (input.cards.length >= MAX_CARDS) return fail(TOO_MANY_CARDS, 400);
  const limit = limiter.take(clientKeyFrom(request.headers));
  if (!limit.ok) return fail(limitMessage(limit.reason), 429);
  const apiKey = readApiKey();
  if (!apiKey)
    return fail(
      "Claudeへの接続がまだ設定されていません。入力は画面に残しています。接続を設定するか、架空の体験例を開けます。",
      503,
    );
  try {
    const anthropic = createAnthropic({ apiKey });
    const result = await runChat({
      model: anthropic(process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"),
      input,
      signal: request.signal,
    });
    const ids = new Set(
      [...input.cards, ...result.cards].map((card) => card.id),
    );
    if (ids.size > MAX_CARDS) return fail(TOO_MANY_CARDS, 400);
    // ステップ数やトークン数（result.meta）は画面に要らないので返さない。
    const { reply, cards, warnings } = result;
    return Response.json(
      { reply, cards, warnings },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // 本文・個人情報・プロバイダーのエラー全文はログにも応答にも出さない。
    return fail(
      "今回の整理を完了できませんでした。入力とこれまでのメモは残っています。少し待って、もう一度試してください。",
      502,
    );
  }
}
