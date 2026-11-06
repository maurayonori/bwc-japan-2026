import { generateText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { requestSchema, replySchema, validateEvidence } from "@/lib/workspace";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { isAllowedRequest, readBoundedJson } from "@/lib/request";
import { readApiKey } from "@/lib/credentials";

export const runtime = "nodejs";
export const maxDuration = 60;

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
  const apiKey = readApiKey();
  if (!apiKey)
    return fail(
      "Claudeへの接続がまだ設定されていません。入力は画面に残しています。接続を設定するか、架空の体験例を開けます。",
      503,
    );
  try {
    const anthropic = createAnthropic({ apiKey });
    const { output } = await generateText({
      model: anthropic(process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"),
      system: SYSTEM_PROMPT,
      prompt: JSON.stringify(input),
      output: Output.object({ schema: replySchema }),
      maxOutputTokens: 5000,
      maxRetries: 1,
      providerOptions: { anthropic: { effort: "low" } },
      timeout: 50_000,
      abortSignal: request.signal,
    });
    const validated = validateEvidence(output, input.messages);
    const ids = new Set(
      [...input.cards, ...validated.cards].map((card) => card.id),
    );
    if (ids.size > 24)
      return fail(
        "メモが24件を超えます。必要なメモを持ち出し、不要なメモを消してから、もう一度試してください。入力は残っています。",
        400,
      );
    return Response.json(validated, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // 本文・個人情報・プロバイダーのエラー全文はログにも応答にも出さない。
    return fail(
      "今回の整理を完了できませんでした。入力とこれまでのメモは残っています。少し待って、もう一度試してください。",
      502,
    );
  }
}
