import {
  generateText,
  isStepCount,
  jsonSchema,
  Output,
  tool,
  type JSONSchema7,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { attachMoney, type ToolEvent } from "./money/attach";
import { todayInJapan } from "./money/dates";
import { monthSplitError } from "./money/month-split";
import {
  checkReply,
  fitLength,
  fixGapDirection,
  maskProblems,
  maskUnverified,
  softenClaims,
  softenTitle,
} from "./money/guard";
import {
  MAX_WARNINGS,
  calculationSchema,
  type Calculation,
  type MoneyWarning,
} from "./money/schema";
import { TOOLS, executeTool } from "./money/tools";
import { buildSystem } from "./prompt";
import {
  TEXT_LIMITS,
  modelReplySchema,
  type ChatRequest,
  type Message,
  type Proposal,
} from "./workspace";

const MAX_STEPS = 5;
const MAX_OUTPUT_TOKENS_PER_STEP = 6000;
// Vercel の 60 秒より先に自分で打ち切り、計算が済んでいれば表だけでも返す。
export const CHAT_SERVER_BUDGET_MS = 52_000;
// これを過ぎたら道具を呼ばせず、文章を書き終える時間を残す。
const TOOL_CUTOFF_MS = 30_000;

const CALCULATION_CRASHED =
  "計算の途中で想定外のエラーが起きました。この道具は、いま使えません。";
const PROSE_FAILED =
  "計算は終わりましたが、説明の文章を最後まで作れませんでした。計算結果の表だけを先に出します。もう一度送ると、説明を付けられます。";

export interface ChatResult {
  reply: string;
  cards: Proposal[];
  warnings: MoneyWarning[];
  meta: {
    steps: number;
    ms: number;
    tools: string[];
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      cacheReadTokens: number | undefined;
      cacheWriteTokens: number | undefined;
    };
    fallback: boolean;
  };
}

// 画面へ返す形。ステップ数やトークン数（meta）は画面に要らないので返さない。
// 呼んだ道具の名前だけは、「この返答で呼んだ計算」として返す。
export const MAX_RESPONSE_TOOLS = 40;

export function toResponse(result: ChatResult): {
  reply: string;
  cards: Proposal[];
  warnings: MoneyWarning[];
  tools: string[];
} {
  return {
    reply: result.reply,
    cards: result.cards,
    warnings: result.warnings,
    tools: result.meta.tools.slice(0, MAX_RESPONSE_TOOLS),
  };
}

// 計算の前に、会話の中で前に呼んだ計算と合わせて見ないと分からない誤りを差し戻す（#66）。
type Precheck = (name: string, input: unknown) => string | null;

function runRecorded(
  name: string,
  input: unknown,
  record: (event: ToolEvent) => void,
  precheck: Precheck,
): unknown {
  const rejected = precheck(name, input);
  if (rejected) {
    record({ name, input, ok: false, error: rejected });
    throw new Error(rejected);
  }
  let result: ReturnType<typeof executeTool>;
  try {
    result = executeTool(name, input);
  } catch {
    // 想定外の不具合の中身は、モデルにも画面にも出さない。
    record({ name, input, ok: false, crashed: true });
    throw new Error(CALCULATION_CRASHED);
  }
  if (!result.ok) {
    // 受け付けなかった理由はモデルへ返す。読んで呼び方を直せるように。
    record({ name, input, ok: false, error: result.error });
    throw new Error(result.error);
  }
  record({ name, input, ok: true, output: result.output });
  return result.output;
}

function aiTools(record: (event: ToolEvent) => void, precheck: Precheck): ToolSet {
  return Object.fromEntries(
    TOOLS.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(
          structuredClone(definition.input_schema) as JSONSchema7,
        ),
        strict: true,
        execute: async (input: unknown) =>
          runRecorded(definition.name, input, record, precheck),
      }),
    ]),
  );
}

// 前のターンの計算を入力からやり直す。送られてきた結果の数字は信じない。
function recalculate(cards: ChatRequest["cards"]): {
  events: ToolEvent[];
  byCard: Map<string, Calculation[]>;
  stale: Set<string>;
} {
  const events: ToolEvent[] = [];
  const byCard = new Map<string, Calculation[]>();
  const stale = new Set<string>();
  for (const card of cards) {
    const calculations: Calculation[] = [];
    // 前の条件での計算の見通しは、表には残すが、今の額の照合の根拠にはしない（#77）。
    const staleCard = card.money?.stale_cashflow === true;
    if (staleCard) stale.add(card.id);
    for (const { name, input } of card.money?.calculations ?? []) {
      try {
        const result = executeTool(name, input);
        if (!result.ok) continue;
        if (!(staleCard && name === "simulate_cashflow"))
          events.push({ name, input, ok: true, output: result.output });
        calculations.push(
          calculationSchema.parse({ name, input, output: result.output }),
        );
      } catch {
        // 保存された入力が、いまの計算で扱えないときは、その計算だけ諦める。
      }
    }
    if (calculations.length > 0) byCard.set(card.id, calculations);
  }
  return { events, byCard, stale };
}

function proseOf(reply: string, cards: readonly Proposal[]): string {
  return [
    reply,
    ...cards.flatMap((card) => [
      card.title,
      card.body,
      card.nextStep,
      card.uncertainty,
    ]),
  ].join("\n");
}

const toPromptMessage = ({ id, role, text }: Message) => ({ id, role, text });

type CheckArgs = Omit<Parameters<typeof checkReply>[0], "reply">;

// 給付の断定や代行の完了を言う文を、固定の案内に置き換える（#59 の指摘 7、#61 の指摘 5・6）。
// 見出しも含めて、生成した欄をすべて見る。残しておく言葉は本人の原文なので触らない。
function softenCard(card: Proposal, userTexts: readonly string[]): Proposal {
  if (card.kind === "memory") return card;
  const options = { voice: "card" as const, userTexts };
  return {
    ...card,
    title: softenTitle(card.title, options),
    body: softenClaims(card.body, options).text,
    nextStep: softenClaims(card.nextStep, options).text,
    uncertainty: softenClaims(card.uncertainty, options).text,
  };
}

// 照らせない金額や日付を含むカードは採用しない（#59 の指摘 1）。採用しなければ、前の版が画面に残る。
// お金のカードの表はプログラムの計算なので残し、照らせない部分だけを伏せる（#61 の指摘 7）。
function keepVerified(
  cards: readonly Proposal[],
  args: CheckArgs,
): { cards: Proposal[]; warnings: MoneyWarning[] } {
  const warnings: MoneyWarning[] = [];
  const kept = cards.flatMap((card): Proposal[] => {
    if (checkReply({ ...args, reply: proseOf("", [card]) }).length === 0)
      return [card];
    if (card.kind === "money") {
      const mask = (text: string) => maskProblems({ ...args, text }).text;
      return [
        {
          ...card,
          title: mask(card.title),
          body: mask(card.body),
          nextStep: mask(card.nextStep),
          uncertainty: mask(card.uncertainty),
        },
      ];
    }
    const title = card.title.slice(0, 80);
    warnings.push({
      kind: "card",
      shown: title,
      message: `「${title}」のメモは、計算結果や話した内容と照らせない金額か日付があったので、出しませんでした（前の版があれば、そのまま残しています）。もう一度送ると、作り直せます。`,
    });
    return [];
  });
  return { cards: kept, warnings };
}

// 後処理で字数が増えても、画面の形の上限に収める（#61 の指摘 3）。残しておく言葉は原文なので切らない。
function fitCard(card: Proposal): Proposal {
  if (card.kind === "memory") return card;
  return {
    ...card,
    title: fitLength(card.title, TEXT_LIMITS.title),
    body: fitLength(card.body, TEXT_LIMITS.body),
    nextStep: fitLength(card.nextStep, TEXT_LIMITS.nextStep),
    uncertainty: fitLength(card.uncertainty, TEXT_LIMITS.uncertainty),
  };
}

export async function runChat({
  model,
  input,
  signal,
  budgetMs = CHAT_SERVER_BUDGET_MS,
  toolCutoffMs = TOOL_CUTOFF_MS,
}: {
  model: LanguageModel;
  input: ChatRequest;
  signal?: AbortSignal;
  budgetMs?: number;
  toolCutoffMs?: number;
}): Promise<ChatResult> {
  const started = Date.now();
  const today = todayInJapan();
  const events: ToolEvent[] = [];
  const prior = recalculate(input.cards);
  const context = {
    existing: input.cards,
    prior: prior.byCard,
    priorStale: prior.stale,
    messages: input.messages,
    events,
  };
  const elapsed = () => Date.now() - started;

  const finish = (
    reply: string,
    cards: Proposal[],
    warnings: MoneyWarning[],
    extra: Pick<ChatResult["meta"], "steps" | "usage" | "fallback">,
  ): ChatResult => ({
    reply,
    cards,
    warnings: warnings.slice(0, MAX_WARNINGS),
    meta: { ...extra, ms: elapsed(), tools: events.map((event) => event.name) },
  });

  try {
    const result = await generateText({
      model,
      instructions: [...buildSystem(today)],
      prompt: JSON.stringify({
        messages: input.messages.map(toPromptMessage),
        cards: input.cards,
      }),
      tools: aiTools(
        (event) => events.push(event),
        (name, toolInput) =>
          name === "simulate_cashflow"
            ? monthSplitError(
                toolInput,
                [...prior.events, ...events].filter(
                  (event) => event.ok && event.name === "kougaku_gendo",
                ),
              )
            : null,
      ),
      output: Output.object({ schema: modelReplySchema }),
      // 構造化出力を書くステップも 1 回に数える。
      stopWhen: isStepCount(MAX_STEPS),
      prepareStep: ({ stepNumber }) =>
        stepNumber >= MAX_STEPS - 1 || elapsed() > toolCutoffMs
          ? { toolChoice: "none" as const }
          : undefined,
      maxOutputTokens: MAX_OUTPUT_TOKENS_PER_STEP,
      maxRetries: 1,
      timeout: { totalMs: budgetMs },
      abortSignal: signal,
      providerOptions: {
        anthropic: {
          // low: 60 秒の中で道具の往復と文章の生成を終えるため。金額と日付はプログラムが計算するので、速さを取る。
          effort: "low",
          // 安全上の理由で断られたとき、API が代わりのモデルでやり直す。
          fallbacks: "default",
        },
      },
    });
    const { reply: rawReply, cards: proposals } = result.output;
    const attached = attachMoney({
      ...context,
      proposals,
    });
    const textsOf = (role: Message["role"]) =>
      input.messages
        .filter((message) => message.role === role)
        .map((message) => message.text);
    const checkArgs: CheckArgs = {
      toolEvents: [...prior.events, ...events],
      userTexts: textsOf("user"),
      earlierReplies: textsOf("assistant"),
      today,
      // 本線の見通しは今回の回から選ぶ（#85）。前の回の計算も照らす根拠として残す。
      currentFrom: prior.events.length,
    };
    // 足りない額と残る額の向きを逆に書いた文は、計算から作った文に置き換え、注意で伝える（#66 の A-3）。
    const gapWarnings: MoneyWarning[] = [];
    const fixGap = (text: string) => {
      const fixed = fixGapDirection(text, checkArgs.toolEvents, checkArgs.currentFrom, checkArgs.userTexts);
      for (const sentence of fixed.sentences) {
        const shown = sentence.slice(0, 120);
        gapWarnings.push({
          kind: "amount",
          shown,
          message: `「${shown}」は、足りない額と残る額の向きが計算と逆だったので、計算から作った文に置き換えました。`,
        });
      }
      return fixed.text;
    };
    const reply = fixGap(
      softenClaims(rawReply, {
        voice: "reply",
        userTexts: checkArgs.userTexts,
      }).text,
    );
    const softened = attached.cards.map((card) => {
      const soft = softenCard(card, checkArgs.userTexts);
      if (soft.kind === "memory") return soft;
      return {
        ...soft,
        title: fixGap(soft.title),
        body: fixGap(soft.body),
        nextStep: fixGap(soft.nextStep),
        uncertainty: fixGap(soft.uncertainty),
      };
    });
    const guardWarnings = checkReply({
      ...checkArgs,
      reply: proseOf(reply, softened),
    });
    const verified = keepVerified(softened, checkArgs);
    return finish(
      // 返答の本文の照らせない金額と日付は伏せ、短い注記を足す。
      fitLength(maskUnverified({ ...checkArgs, reply }).text, TEXT_LIMITS.reply),
      verified.cards.map(fitCard),
      [...gapWarnings, ...guardWarnings, ...attached.warnings, ...verified.warnings],
      {
        steps: result.steps.length,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens,
        },
        fallback: false,
      },
    );
  } catch (error) {
    // 利用者が中止したとき、計算が 1 つも済んでいないときは、失敗として返す。
    if (signal?.aborted || !events.some((event) => event.ok)) throw error;
    const { cards, warnings } = attachMoney({
      ...context,
      proposals: [],
      forceTable: true,
    });
    return finish(PROSE_FAILED, cards, warnings, {
      steps: 0,
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      fallback: true,
    });
  }
}
