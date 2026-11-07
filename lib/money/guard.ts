import { isDateString, weekdayOf } from "./dates";
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
// 「¥123,456」「￥12万」。全角の ￥ は normalize で ¥ にそろえる。
const YEN_SIGN_PATTERN = new RegExp(String.raw`¥\s*(${NUMBER})\s*(万)?`, "g");
// 「十二万三千四百五十六円」「2万3100円」のように、漢数字や万を挟んだ書き方。
const NUMERAL_CHARS = "\\d,〇一二三四五六七八九十百千万億";
const MIXED_YEN_PATTERN = new RegExp(
  `([\\d〇一二三四五六七八九十百千万億][${NUMERAL_CHARS}]*)\\s*円`,
  "g",
);
const MIXED_NUMERAL = /[〇一二三四五六七八九十百千億]|万\d/;
// 利用者の発言では、円が付かなくても「34万」「8万5千」は額として受け取る。年齢や日数は受け取らない。
const LOOSE_NUMERAL_PATTERN = new RegExp(`[${NUMERAL_CHARS}]+`, "g");
const KANJI_DIGITS = "〇一二三四五六七八九";
const SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
const LARGE_UNITS: Record<string, number> = { 万: 10_000, 億: 100_000_000 };

const YEAR_DATE_PATTERNS = [
  /(\d{4})-(\d{2})-(\d{2})/g,
  /(?<!\d)(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
];
const MONTH_DAY_PATTERNS = [
  /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
];
// 日付のすぐあとの「（月）」「(月曜)」「（月曜日）」。
const WEEKDAY_AFTER = /^\s*[（(]\s*([日月火水木金土])(?:曜日?)?\s*[）)]/;
// 「縮みません」「縮まない」「縮むとは限らない」など、縮まないことを言う書き方。
const NO_SHRINK_PATTERN =
  /縮(?:みません|まない|まず|まなかっ|まりません|まらない|まらず|まらなかっ|むとは限[らり]|まるとは限[らり])/g;
const SENTENCE_END = /[。！？!?\n]/;

// 道具の入力と結果のうち、金額ではない数（日数・食数・回数・割合・組み合わせの数など）の項目。
// これらの数を「◯円」の根拠にしない。
const NON_YEN_KEYS = new Set([
  "days",
  "days_low",
  "days_high",
  "meals_max",
  "meals_per_day_max",
  "count",
  "days_after_start",
  "days_inclusive",
  "copay_percent",
  "rate_percent",
  "combinations",
  "omitted_factors",
]);

export interface GuardToolEvent {
  input: unknown;
  output?: unknown;
}

// 全角の数字・区切り・円記号を半角にそろえる。1 文字を 1 文字に置き換えるので、位置は変わらない。
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/，/g, ",")
    .replace(/．/g, ".")
    .replace(/／/g, "/")
    .replace(/￥/g, "¥");
}

const toYen = (number: string, hasMan: boolean): number =>
  Math.round(Number(number.replace(/,/g, "")) * (hasMan ? 10_000 : 1));

// 算用数字・漢数字・十百千・万億のまざった数を読む。読めなければ null。
function parseNumeral(run: string): number | null {
  let total = 0;
  let section = 0;
  let current: number | null = null;
  for (const char of run.replace(/,/g, "")) {
    if (/\d/.test(char)) current = (current ?? 0) * 10 + Number(char);
    else if (KANJI_DIGITS.includes(char))
      current = (current ?? 0) * 10 + KANJI_DIGITS.indexOf(char);
    else if (char in SMALL_UNITS) {
      section += (current ?? 1) * SMALL_UNITS[char];
      current = null;
    } else if (char in LARGE_UNITS) {
      total += (section + (current ?? 0) || 1) * LARGE_UNITS[char];
      section = 0;
      current = null;
    } else return null;
  }
  return total + section + (current ?? 0);
}

interface Found {
  value: number;
  shown: string;
  start: number;
  end: number;
}

const overlaps = (spans: readonly [number, number][], start: number, end: number) =>
  spans.some(([from, to]) => start < to && from < end);

// 文章から「◯円」「◯万円」「A〜B 円」「¥◯」「漢数字の◯円」の金額を、位置つきで取り出す。円の付かない数字は金額として扱わない。
function amountsAt(text: string): Found[] {
  const normalized = normalize(text);
  const found: Found[] = [];
  const covered: [number, number][] = [];
  for (const match of normalized.matchAll(MIXED_YEN_PATTERN)) {
    const run = match[1].replace(/^,+/, "");
    if (!MIXED_NUMERAL.test(run)) continue;
    const value = parseNumeral(run);
    if (value === null) continue;
    const start = match.index + match[0].indexOf(run);
    const end = match.index + match[0].length;
    found.push({ value, shown: `${run}円`, start, end });
    covered.push([start, end]);
  }
  for (const match of normalized.matchAll(YEN_SIGN_PATTERN)) {
    const [, number, man] = match;
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(covered, start, end)) continue;
    found.push({
      value: toYen(number, Boolean(man)),
      shown: `¥${number}${man ? "万" : ""}`,
      start,
      end,
    });
    covered.push([start, end]);
  }
  const matches = [...normalized.matchAll(AMOUNT_PATTERN)].filter(
    (match) => !overlaps(covered, match.index, match.index + match[0].length),
  );
  matches.forEach((match, index) => {
    const [whole, number, man, yen, rangeMark] = match;
    const start = match.index;
    const end = start + whole.length - (rangeMark?.length ?? 0);
    if (yen) {
      found.push({
        value: toYen(number, Boolean(man)),
        shown: `${number}${man ? " 万" : " "}円`,
        start,
        end,
      });
      return;
    }
    // 「A〜B 円」の A。単位（万）が A に無ければ、B の単位を借りる。
    const next = matches[index + 1];
    if (
      rangeMark &&
      next &&
      next[3] &&
      next.index === match.index + whole.length
    ) {
      const hasMan = Boolean(man || next[2]);
      found.push({
        value: toYen(number, hasMan),
        shown: `${number}${hasMan ? " 万" : " "}円`,
        start,
        end,
      });
    }
  });
  return found.sort((a, b) => a.start - b.start);
}

function amountsIn(text: string): { value: number; shown: string }[] {
  return amountsAt(text).map(({ value, shown }) => ({ value, shown }));
}

// 利用者の発言から、利用者が言った額を取り出す。円の付いた額と、「34万」「8万5千」のように万・千の付いた額。
function userAmountsIn(text: string): number[] {
  const normalized = normalize(text);
  const loose = [...normalized.matchAll(AMOUNT_PATTERN)].flatMap(
    ([, number, man]) => (man ? [toYen(number, true)] : []),
  );
  const mixed = [...normalized.matchAll(LOOSE_NUMERAL_PATTERN)].flatMap(
    ([run]) => {
      // 数字を含み、万・千・億の付いた塊だけ（「万」だけの塊や「千葉」の「千」は額にしない）。
      if (!/[万千億]/.test(run) || !/[\d〇一二三四五六七八九]/.test(run)) return [];
      const value = parseNumeral(run.replace(/^,+/, ""));
      return value === null ? [] : [value];
    },
  );
  return [...amountsIn(text).map((amount) => amount.value), ...loose, ...mixed];
}

const pad = (value: number) => String(value).padStart(2, "0");

interface DateFound {
  monthDay: string;
  date: string | null;
  weekday: string | null;
  shown: string;
  start: number;
  end: number;
}

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

// 文章から日付を、位置つきで取り出す。年のある日付は年月日も持つ。すぐあとの曜日も読む。
function datesAt(text: string): DateFound[] {
  const normalized = normalize(text);
  const found: DateFound[] = [];
  const covered: [number, number][] = [];
  const withWeekday = (start: number, end: number) => {
    const after = WEEKDAY_AFTER.exec(normalized.slice(end));
    return {
      weekday: after ? after[1] : null,
      end: after ? end + after[0].length : end,
    };
  };
  for (const pattern of YEAR_DATE_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const [whole, year, month, day] = match;
      if (!validMonthDay(Number(month), Number(day))) continue;
      const start = match.index;
      const date = `${year}-${pad(Number(month))}-${pad(Number(day))}`;
      const { weekday, end } = withWeekday(start, start + whole.length);
      found.push({
        monthDay: `${Number(month)}/${Number(day)}`,
        date,
        weekday,
        shown: date,
        start,
        end,
      });
      covered.push([start, start + whole.length]);
    }
  }
  for (const pattern of MONTH_DAY_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const [whole, month, day] = match;
      const start = match.index;
      if (overlaps(covered, start, start + whole.length)) continue;
      if (!validMonthDay(Number(month), Number(day))) continue;
      const monthDay = `${Number(month)}/${Number(day)}`;
      const { weekday, end } = withWeekday(start, start + whole.length);
      found.push({ monthDay, date: null, weekday, shown: monthDay, start, end });
    }
  }
  // 書き方ごと（年のある日付 → 月/日 → 月日）に並べる。注意の並びをこれまでと同じにするため。
  return found;
}

// 月日だけの日付を、今年と来年の年月日に広げる。
function withYears(monthDay: string, today: string): string[] {
  const [month, day] = monthDay.split("/").map(Number);
  const year = Number(today.slice(0, 4));
  return [year, year + 1]
    .map((value) => `${value}-${pad(month)}-${pad(day)}`)
    .filter(isDateString);
}

// 道具の入力と結果を端までたどり、数（金額の項目だけ）と文字列を集める。
function leavesOf(
  value: unknown,
  key = "",
): { numbers: number[]; strings: string[] } {
  if (typeof value === "number")
    return { numbers: NON_YEN_KEYS.has(key) ? [] : [value], strings: [] };
  if (typeof value === "string") return { numbers: [], strings: [value] };
  if (value === null || typeof value !== "object")
    return { numbers: [], strings: [] };
  const entries = Array.isArray(value)
    ? value.map((item) => [key, item] as const)
    : Object.entries(value);
  return entries.reduce(
    (all, [childKey, child]) => {
      const leaves = leavesOf(child, childKey);
      return {
        numbers: [...all.numbers, ...leaves.numbers],
        strings: [...all.strings, ...leaves.strings],
      };
    },
    { numbers: [] as number[], strings: [] as string[] },
  );
}

const FACT_TEXTS = FACTS.map((fact) => fact.text);

interface Allowed {
  amounts: Set<number>;
  monthDays: Set<string>;
  dates: Set<string>;
}

function allowedValues({
  toolEvents,
  userTexts,
  today,
}: {
  toolEvents: readonly GuardToolEvent[];
  userTexts: readonly string[];
  today: string;
}): Allowed {
  // 失敗した計算（結果の無いもの）の入力は、根拠にしない。
  const leaves = toolEvents
    .filter((event) => event.output !== undefined)
    .map((event) => {
      const input = leavesOf(event.input);
      const output = leavesOf(event.output);
      return {
        numbers: [...input.numbers, ...output.numbers],
        strings: [...input.strings, ...output.strings],
      };
    });
  const numbers = leaves.flatMap((leaf) => leaf.numbers);
  const toolStrings = leaves.flatMap((leaf) => leaf.strings);
  const strings = [...toolStrings, ...userTexts, ...FACT_TEXTS, today];
  const mentions = strings.flatMap(datesAt);
  return {
    amounts: new Set([
      // 累計や差額は、結果では負の値。返答では「◯円少ない」のように符号なしで書くので、大きさで照らす。
      ...numbers.map(Math.abs),
      // 道具の結果の説明文（区分の条件「28 万〜50 万円」など）と、持っている事実の文にある金額。
      ...[...toolStrings, ...FACT_TEXTS].flatMap((text) =>
        amountsIn(text).map((amount) => amount.value),
      ),
      ...userTexts.flatMap(userAmountsIn),
    ]),
    monthDays: new Set(mentions.map((mention) => mention.monthDay)),
    // 年のある日付はそのまま。年の無い日付（発言の「11/9」など）は、今年と来年のどちらとも読む。
    dates: new Set(
      mentions.flatMap((mention) =>
        mention.date ? [mention.date] : withYears(mention.monthDay, today),
      ),
    ),
  };
}

interface Unverified {
  warning: MoneyWarning;
  start: number;
  end: number;
}

// 照らせなかった金額と日付（曜日の食い違いも）を、位置つきで集める。
function unverifiedIn(text: string, allowed: Allowed, today: string): Unverified[] {
  const amounts = amountsAt(text)
    .filter((amount) => !allowed.amounts.has(amount.value))
    .map(
      (amount): Unverified => ({
        start: amount.start,
        end: amount.end,
        warning: {
          kind: "amount",
          shown: amount.shown,
          message: `「${amount.shown}」は、計算結果・あなたの発言・出典のどれにも見当たらない金額です。計算し直すように頼んでください。`,
        },
      }),
    );
  const dates = datesAt(text).flatMap((mention): Unverified[] => {
    const knownMonthDay = allowed.monthDays.has(mention.monthDay);
    const known = mention.date
      ? allowed.dates.has(mention.date)
      : knownMonthDay;
    if (!known) {
      // 月日がどこにも無ければ、これまでどおり「月/日」で示す。月日は合っていて年だけ違うときは、年月日で示す。
      const shown = knownMonthDay ? mention.shown : mention.monthDay;
      return [
        {
          start: mention.start,
          end: mention.end,
          warning: {
            kind: "date",
            shown,
            message: `「${shown}」は、計算結果にも、あなたの発言にも見当たらない日付です。計算し直すように頼んでください。`,
          },
        },
      ];
    }
    if (!mention.weekday) return [];
    // 曜日は、プログラムが計算した曜日と照らす。年の無い日付は、照らせた年のどれかと合えばよい。
    const candidates = mention.date
      ? [mention.date]
      : [...allowed.dates].filter((date) =>
          date.endsWith(`-${pad(Number(mention.monthDay.split("/")[0]))}-${pad(Number(mention.monthDay.split("/")[1]))}`),
        );
    const years = candidates.length > 0 ? candidates : withYears(mention.monthDay, today);
    if (years.some((date) => weekdayOf(date) === mention.weekday)) return [];
    const shown = `${mention.shown}（${mention.weekday}）`;
    return [
      {
        start: mention.start,
        end: mention.end,
        warning: {
          kind: "date",
          shown,
          message: `「${shown}」の曜日は、計算した曜日（${years.map(weekdayOf).join("・")}）と合いません。計算し直すように頼んでください。`,
        },
      },
    ];
  });
  // 注意は、これまでどおり金額を先、日付をあとに並べる。
  return [...amounts, ...dates];
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

interface CheckArgs {
  toolEvents: readonly GuardToolEvent[];
  userTexts: readonly string[];
  today: string;
}

export function checkReply({
  reply,
  toolEvents,
  userTexts,
  today,
}: CheckArgs & { reply: string | null }): MoneyWarning[] {
  if (!reply) return [];
  const allowed = allowedValues({ toolEvents, userTexts, today });
  const seen = new Set<string>();
  return [
    ...unverifiedIn(reply, allowed, today).map((item) => item.warning),
    ...misleadingShrink(reply, toolEvents),
  ].filter((warning) => {
    const key = `${warning.kind}:${warning.shown}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const MASKED_AMOUNT = "（照合できない金額）";
export const MASKED_DATE = "（照合できない日付）";
export const MASK_NOTE =
  "（計算結果・あなたの発言・出典のどれとも照らせなかった金額や日付を伏せました。）";

// 返答の本文から、照らせなかった金額と日付を伏せる（#59 の指摘 1）。伏せたら短い注記を足す。
export function maskUnverified({
  reply,
  toolEvents,
  userTexts,
  today,
}: CheckArgs & { reply: string }): { text: string; masked: number } {
  const allowed = allowedValues({ toolEvents, userTexts, today });
  const items = unverifiedIn(reply, allowed, today);
  if (items.length === 0) return { text: reply, masked: 0 };
  let text = reply;
  let lastStart = Infinity;
  for (const item of [...items].sort((a, b) => b.start - a.start)) {
    // 重なった範囲（「12/25（日）」の日付と曜日など）は、外側を 1 回だけ伏せる。
    if (item.end > lastStart) continue;
    const mask = item.warning.kind === "amount" ? MASKED_AMOUNT : MASKED_DATE;
    text = text.slice(0, item.start) + mask + text.slice(item.end);
    lastStart = item.start;
  }
  return { text: `${text}\n${MASK_NOTE}`, masked: items.length };
}

// 給付が受けられると言い切る文と、連絡や申請を済ませたと言う文（#59 の指摘 7）。
// このアプリは給付を判断せず、連絡も申請もしないので、出たら固定の案内に置き換える。
// 「申請しましたか」のような問いかけや、「必ず確かめてください」のような勧めは置き換えない。
const OVERCLAIM_PATTERNS = [
  /(?:必ず|確実に|間違いなく|絶対に?)[^。！？\n]{0,24}?(?:受けられ|受け取れ|もらえ|支給され|支払われ|振り込まれ|戻ってき|戻ります|下ります|下りる|出ます|入ります)/,
  /(?:申請|連絡|予約|請求|送信|送付|手続き|問い合わせ)(?:は|も|を)?(?:済ませました|済ませておきました|済みです|完了しました|しておきました|しました|行いました)(?!か)/,
  /代わりに[^。！？\n]{0,12}(?:申請|連絡|予約|請求|送信|送付|手続き)(?:しました|しておきます|します|を済ませ)/,
];
export const SOFTENED_CLAIM =
  "（給付が受けられるか、手続きが済んだかは、ここでは確かめられません。加入先や窓口に確かめてください。このアプリは、連絡や申請を代わりに行いません。）";

export function softenClaims(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const sentences = text.match(/[^。！？\n]+[。！？]?|\n/g) ?? [];
  const softened = sentences.map((sentence) => {
    if (!OVERCLAIM_PATTERNS.some((pattern) => pattern.test(sentence)))
      return sentence;
    replaced += 1;
    // 続けて置き換えるときは、案内を 1 回だけにする。
    return replaced === 1 ? SOFTENED_CLAIM : "";
  });
  return replaced === 0 ? { text, replaced } : { text: softened.join(""), replaced };
}
