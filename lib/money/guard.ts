import { FACTS } from "./facts";
import { yen } from "./format";
import {
  whatToConfirmSchema,
  type MoneyWarning,
  type WhatToConfirm,
} from "./schema";

// 返答に書かれた金額と日付が、プログラムの計算結果・利用者の発言・持っている事実のどれかにあるかを照らす。
// 「金額と日付は、プログラムが計算したものだけを見せる」という約束を、目で確かめられるようにするため。
// 見つからないものは、返答を止めずに、注意として画面に出す。

const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const AMOUNT_PATTERN = new RegExp(
  String.raw`(${NUMBER})\s*(万)?\s*(円)?(\s*[〜～~]\s*)?`,
  "g",
);
const ISO_DATE_PATTERN = /(\d{4})-(\d{2})-(\d{2})/g;
const SLASH_DATE_PATTERN = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g;
const KANJI_DATE_PATTERN = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
// 「縮みません」「縮まない」「縮むとは限らない」など、縮まないことを言う書き方。
const NO_SHRINK_PATTERN =
  /縮(?:みません|まない|まず|まなかっ|まりません|まらない|まらず|まらなかっ|むとは限[らり]|まるとは限[らり])/g;
const SENTENCE_END = /[。！？!?\n]/;

export interface GuardToolEvent {
  input: unknown;
  output?: unknown;
}

// 全角の数字・区切りを半角にそろえる。
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/，/g, ",")
    .replace(/．/g, ".")
    .replace(/／/g, "/");
}

const toYen = (number: string, hasMan: boolean): number =>
  Math.round(Number(number.replace(/,/g, "")) * (hasMan ? 10_000 : 1));

// 文章から「◯円」「◯万円」「A〜B 円」の金額を取り出す。円の付かない数字は金額として扱わない。
function amountsIn(text: string): { value: number; shown: string }[] {
  const matches = [...normalize(text).matchAll(AMOUNT_PATTERN)];
  return matches.flatMap((match, index) => {
    const [, number, man, yen, rangeMark] = match;
    if (yen)
      return [
        {
          value: toYen(number, Boolean(man)),
          shown: `${number}${man ? " 万" : " "}円`,
        },
      ];
    // 「A〜B 円」の A。単位（万）が A に無ければ、B の単位を借りる。
    const next = matches[index + 1];
    if (
      rangeMark &&
      next &&
      next[3] &&
      next.index === match.index + match[0].length
    ) {
      const hasMan = Boolean(man || next[2]);
      return [
        {
          value: toYen(number, hasMan),
          shown: `${number}${hasMan ? " 万" : " "}円`,
        },
      ];
    }
    return [];
  });
}

// 利用者の発言では、円が付いていない数字も、利用者が言った額として受け取る。
function looseAmountsIn(text: string): number[] {
  return [...normalize(text).matchAll(AMOUNT_PATTERN)].flatMap(
    ([, number, man]) => [
      toYen(number, false),
      ...(man ? [toYen(number, true)] : []),
    ],
  );
}

function validMonthDay(month: number, day: number): string[] {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
    ? [`${month}/${day}`]
    : [];
}

// 文章から日付を取り出し、「月/日」の形にそろえる。
function datesIn(text: string): string[] {
  const normalized = normalize(text);
  return [
    ...[...normalized.matchAll(ISO_DATE_PATTERN)].flatMap((match) =>
      validMonthDay(Number(match[2]), Number(match[3])),
    ),
    ...[...normalized.matchAll(SLASH_DATE_PATTERN)].flatMap((match) =>
      validMonthDay(Number(match[1]), Number(match[2])),
    ),
    ...[...normalized.matchAll(KANJI_DATE_PATTERN)].flatMap((match) =>
      validMonthDay(Number(match[1]), Number(match[2])),
    ),
  ];
}

// 道具の入力と結果を端までたどり、数と文字列を集める。
function leavesOf(value: unknown): (number | string)[] {
  if (typeof value === "number" || typeof value === "string") return [value];
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(leavesOf);
  return [];
}

const FACT_TEXTS = FACTS.map((fact) => fact.text);

function allowedValues({
  toolEvents,
  userTexts,
  today,
}: {
  toolEvents: readonly GuardToolEvent[];
  userTexts: readonly string[];
  today: string;
}): { amounts: Set<number>; dates: Set<string> } {
  const leaves = toolEvents.flatMap((event) => [
    ...leavesOf(event.input),
    ...leavesOf(event.output ?? null),
  ]);
  const toolStrings = leaves.filter(
    (leaf): leaf is string => typeof leaf === "string",
  );
  const strings = [...toolStrings, ...userTexts, ...FACT_TEXTS, today];
  return {
    amounts: new Set([
      // 累計や差額は、結果では負の値。返答では「◯円少ない」のように符号なしで書くので、大きさで照らす。
      ...leaves
        .filter((leaf): leaf is number => typeof leaf === "number")
        .map(Math.abs),
      // 道具の結果の説明文（区分の条件「28 万〜50 万円」など）と、持っている事実の文にある金額。
      ...[...toolStrings, ...FACT_TEXTS].flatMap((text) =>
        amountsIn(text).map((amount) => amount.value),
      ),
      ...userTexts.flatMap(looseAmountsIn),
    ]),
    dates: new Set(strings.flatMap(datesIn)),
  };
}

// 道具の結果にある「まず確かめる 1 つ」の順位（what_to_confirm）を、出てきた順に集める。最後のものが今の見通し。
function confirmsIn(toolEvents: readonly GuardToolEvent[]): WhatToConfirm[] {
  return toolEvents.flatMap((event) => {
    const output = event.output;
    if (output === null || typeof output !== "object") return [];
    if (!("what_to_confirm" in output)) return [];
    const parsed = whatToConfirmSchema.safeParse(output.what_to_confirm);
    return parsed.success ? [parsed.data] : [];
  });
}

// 「まず確かめる 1 つ」を確かめても幅が縮まない（shrink が 0）のに、「縮む」と書いた文を拾う。
// 数字は計算結果にあっても、意味が逆になるため。前の計算から今の幅まで縮んだ、という報告は正しいので通す。
function misleadingShrink(
  reply: string,
  toolEvents: readonly GuardToolEvent[],
): MoneyWarning[] {
  const confirms = confirmsIn(toolEvents);
  const current = confirms.at(-1);
  const top = current?.factors[0];
  if (!current || !top || top.shrink !== 0) return [];
  const earlierWidths = new Set(
    confirms
      .slice(0, -1)
      .map((confirm) => confirm.width)
      .filter((width) => width > current.width),
  );
  return normalize(reply)
    .split(SENTENCE_END)
    .flatMap((sentence): MoneyWarning[] => {
      if (!sentence.replace(NO_SHRINK_PATTERN, "").includes("縮")) return [];
      if (amountsIn(sentence).some((amount) => earlierWidths.has(amount.value)))
        return [];
      const shown = sentence.trim().slice(0, 120);
      return [
        {
          kind: "amount",
          shown,
          message: `「${shown}」とありますが、計算では「${top.name}」を確かめても、答えによっては要る額の幅が縮みません（いまの幅 ${yen(current.width)}、確かめると残る幅 ${yen(top.width_if_resolved)}）。見通しで答えごとの要る額を確かめるか、書き直すように頼んでください。`,
        },
      ];
    });
}

export function checkReply({
  reply,
  toolEvents,
  userTexts,
  today,
}: {
  reply: string | null;
  toolEvents: readonly GuardToolEvent[];
  userTexts: readonly string[];
  today: string;
}): MoneyWarning[] {
  if (!reply) return [];
  const allowed = allowedValues({ toolEvents, userTexts, today });

  const unknownAmounts = amountsIn(reply)
    .filter((amount) => !allowed.amounts.has(amount.value))
    .map(
      (amount): MoneyWarning => ({
        kind: "amount",
        shown: amount.shown,
        message: `「${amount.shown}」は、計算結果・あなたの発言・出典のどれにも見当たらない金額です。計算し直すように頼んでください。`,
      }),
    );

  const unknownDates = datesIn(reply)
    .filter((date) => !allowed.dates.has(date))
    .map(
      (date): MoneyWarning => ({
        kind: "date",
        shown: date,
        message: `「${date}」は、計算結果にも、あなたの発言にも見当たらない日付です。計算し直すように頼んでください。`,
      }),
    );

  const seen = new Set<string>();
  return [
    ...unknownAmounts,
    ...unknownDates,
    ...misleadingShrink(reply, toolEvents),
  ].filter((warning) => {
    const key = `${warning.kind}:${warning.shown}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
