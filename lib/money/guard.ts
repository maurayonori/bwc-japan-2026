import { isDateString, weekdayOf } from "./dates";
import { FACTS } from "./facts";
import { cashGapText, yen } from "./format";
import {
  cashflowOutputSchema,
  whatToConfirmSchema,
  type MoneyWarning,
  type WhatToConfirm,
} from "./schema";

// 返答に書かれた金額と日付が、プログラムの計算結果・利用者の発言・持っている事実のどれかにあるかを照らす。
// 「金額と日付は、プログラムが計算したものだけを見せる」という約束を、目で確かめられるようにするため。
// 見つからないものは、返答を止めずに、注意として画面に出す。

// 額の全体を 1 回で取り出す（#61 の指摘 1・4・9）。先頭の ¥、数字・漢数字・万千億のならび、
// 単位のあとの空白（「11万 5,690」）、末尾の円、そのあとの範囲の印（〜）まで。
const AMOUNT_PATTERN =
  /(¥\s*)?((?:\d|[〇一二三四五六七八九十百千])(?:[\d,〇一二三四五六七八九十百千万億]|\.\d|\s+(?=[万億千])|(?<=[万億千])\s+(?=[\d〇一二三四五六七八九]))*)(\s*円)?(\s*[〜～~]\s*)?/g;
// 額のすぐあとにこれが続く数字は、金額ではない（「三千歩」「4万人」「8万点」など）。
// 「12万 月末に」のような額をすり抜けさせないよう、間に空白のあるものと、月・日・本・食のように
// 次の語の頭にもなる 1 文字は数えない。
const NON_YEN_UNIT =
  /^(?:歩|歳|才|日間|週間|か月|ヶ月|ヵ月|カ月|箇月|年間|時間|分間|秒|人|名|回|件|個|枚|冊|台|杯|点|%|％|割|倍|位|km|kg|cm|mm|ページ|字|号|番|階|社|校|軒|戸|世帯|票|株)/;
const KANJI_DIGITS = "〇一二三四五六七八九";
const SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
const LARGE_UNITS: Record<string, number> = { 万: 10_000, 億: 100_000_000 };

const YEAR_DATE_PATTERNS = [
  /(\d{4})-(\d{2})-(\d{2})/g,
  /(?<!\d)(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
  // 和暦（令和）。令和元年は 2019 年（#61 の指摘 10）。
  /令和\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
];
const yearOf = (written: string): string =>
  /^\d{4}$/.test(written)
    ? written
    : String(2018 + (written === "元" ? 1 : Number(written)));
const MONTH_DAY_PATTERNS = [
  /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
];
// 日付のすぐあとの「（月）」「(月曜)」「（月曜日）」と、括弧の無い「月曜日」「月曜」（#61 の指摘 10）。
const WEEKDAY_AFTER =
  /^\s*(?:[（(]\s*([日月火水木金土])(?:曜日?)?\s*[）)]|([日月火水木金土])曜日?)/;
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

// 自由文の項目。道具の入力で Claude が自由に書けるのは、段取り・入出金の label と、筋書きの name だけ
// （出力の rows・scenarios・factors にもそのまま写る）。ほかの文字列の項目（区分の条件、前提、注意など）はプログラムが作る。
const FREE_TEXT_KEYS = new Set(["label", "name"]);

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

interface Candidate {
  body: string;
  compact: string;
  sign: boolean;
  yen: boolean;
  range: boolean;
  start: number;
  end: number;
}

const ARABIC_ONLY = /^\d[\d,]*(?:\.\d+)?$/;
const ARABIC_WITH_LARGE = /^(\d[\d,]*(?:\.\d+)?)([万億])$/;

// 額の全体の値。「18.7万」「12万3千」「十二万三千四百五十六」「2万 4,750」など。読めなければ null。
function valueOf(compact: string, borrowed: string | null): number | null {
  if (ARABIC_ONLY.test(compact))
    return Math.round(
      Number(compact.replace(/,/g, "")) *
        (borrowed ? { ...SMALL_UNITS, ...LARGE_UNITS }[borrowed] : 1),
    );
  const large = ARABIC_WITH_LARGE.exec(compact);
  if (large)
    return Math.round(Number(large[1].replace(/,/g, "")) * LARGE_UNITS[large[2]]);
  return compact.includes(".") ? null : parseNumeral(compact);
}

// 文章から額を、額の全体ごとに位置つきで取り出す。円・¥・万千億のどれかが付いたものだけを額にする。
// 「A〜B 円」の A に単位が無ければ、B の単位を借りる。歩・歳・人などが続く数字は額にしない。
function amountsAt(text: string): Found[] {
  const normalized = normalize(text);
  const candidates: Candidate[] = [...normalized.matchAll(AMOUNT_PATTERN)].map(
    (match) => {
      const [whole, sign, body, yen, range] = match;
      const start = match.index;
      return {
        body: body.trimEnd(),
        compact: body.replace(/\s+/g, ""),
        sign: Boolean(sign),
        yen: Boolean(yen),
        range: Boolean(range),
        start,
        end: start + whole.length - (range?.length ?? 0),
      };
    },
  );
  const accepted = (candidate: Candidate): boolean => {
    if (candidate.yen || candidate.sign) return true;
    if (!/[万億千]/.test(candidate.compact)) return false;
    if (!/[\d〇一二三四五六七八九]/.test(candidate.compact)) return false;
    return !NON_YEN_UNIT.test(normalized.slice(candidate.end));
  };
  const found: Found[] = [];
  candidates.forEach((candidate, index) => {
    let borrowed: string | null = null;
    if (!accepted(candidate)) {
      // 「A〜B 円」の A。B が額で、すぐあとに続くときだけ、B の大きい単位を借りる。
      const next = candidates[index + 1];
      const adjacent =
        candidate.range &&
        next &&
        accepted(next) &&
        next.start ===
          candidate.end + (/^\s*[〜～~]\s*/.exec(normalized.slice(candidate.end))?.[0].length ?? -1);
      if (!adjacent || !ARABIC_ONLY.test(candidate.compact)) return;
      // 「1〜2千円」の千も借りる（3 回目の指摘 4）。「1〜2万5千円」は、先頭の大きい単位（万）を借りる。
      borrowed = /億/.test(next.compact)
        ? "億"
        : /万/.test(next.compact)
          ? "万"
          : /千$/.test(next.compact)
            ? "千"
            : null;
    }
    const value = valueOf(candidate.compact, borrowed);
    if (value === null) return;
    // これまでの書き方（「123,456 円」「31 万円」）は、注意の示し方もこれまでどおりにする。
    const plain = ARABIC_ONLY.test(candidate.compact)
      ? candidate.compact
      : ARABIC_WITH_LARGE.exec(candidate.compact)?.[1];
    const man = borrowed === "万" || candidate.compact.endsWith("万");
    const classic =
      plain !== undefined &&
      !candidate.sign &&
      (candidate.yen || borrowed === "万") &&
      !/億$/.test(candidate.compact);
    found.push({
      value,
      shown: classic
        ? `${plain}${man ? " 万" : " "}円`
        : `${normalized.slice(candidate.start, candidate.end).trim()}${borrowed ?? ""}`,
      start: candidate.start,
      end: candidate.end,
    });
  });
  return found;
}

function amountsIn(text: string): { value: number; shown: string }[] {
  return amountsAt(text).map(({ value, shown }) => ({ value, shown }));
}

// 利用者の発言から、利用者が言った額を取り出す。返答と同じく額の全体ごとに取り出し、途中まで重ねない（#61 の指摘 9）。
function userAmountsIn(text: string): number[] {
  return amountsIn(text).map((amount) => amount.value);
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
      weekday: after ? (after[1] ?? after[2]) : null,
      end: after ? end + after[0].length : end,
    };
  };
  for (const pattern of YEAR_DATE_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const [whole, written, month, day] = match;
      if (!validMonthDay(Number(month), Number(day))) continue;
      const start = match.index;
      const date = `${yearOf(written)}-${pad(Number(month))}-${pad(Number(day))}`;
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
  // 道具に渡した名前や説明（label・name など）は Claude が書いた自由文なので、額と日付の根拠にしない（#76）。
  // 出力にそのまま写された名前（筋書きの名前・行の label）も同じ。区分の条件などの、プログラムが作った文は残す。
  if (typeof value === "string")
    return { numbers: [], strings: FREE_TEXT_KEYS.has(key) ? [] : [value] };
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

interface CheckArgs {
  toolEvents: readonly GuardToolEvent[];
  userTexts: readonly string[];
  // 会話の前の返答（assistant の発言）。
  earlierReplies?: readonly string[];
  today: string;
}

interface Allowed {
  amounts: Set<number>;
  monthDays: Set<string>;
  dates: Set<string>;
}

function allowedValues({
  toolEvents,
  userTexts,
  earlierReplies = [],
  today,
}: CheckArgs): Allowed {
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
  // 前の返答は、そのときに照らし終えた文（照らせない値は伏せてある）。計算を置き換えたあとも、
  // 「前は ◯ 円でした」と書けるように根拠に残す（#61 の指摘 2）。
  const strings = [...toolStrings, ...userTexts, ...earlierReplies, ...FACT_TEXTS, today];
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
      ...earlierReplies.flatMap(userAmountsIn),
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

// 「X 円から Y 円」「X〜Y 円」のつなぎ。
const RANGE_JOINER = /^\s*(?:[〜～~]|から)\s*$/;
// 「幅」を言う範囲のすぐあとに続く、変化の語（#76）。
const WIDTH_CHANGE_AFTER = /^\s*(?:に縮|になり|になる|になっ|に狭|に変わ|に減|まで縮|まで狭|へ)/;
// 幅の縮みを言う部分（「幅は ◯ 円から ◯ 円に縮みます」）。範囲のすぐあとに続く。
const SHRINK_AFTER = /^\s*(?:に|へ|まで)\s*(?:縮|狭)/;
// 前の値を言う語。範囲と同じ節（読点で区切った部分）の、範囲より前にあるときだけ照らさない。
const PAST_MARKER = /前は|前の|以前|これまで|もともと|元の|最初の/;
// 前の値の語と範囲のあいだに、今の値を言い始める語があれば、範囲は今の値（4 回目の指摘③）。
const PRESENT_AFTER_PAST = /でしたが|ですが|けれど|けど|一方|今の|今は|いまの|いまは|現在|新しい/;

// 範囲が前の値を言っているか。文の中で範囲より前に前の値の語があり、そのあいだに今の値を言い始める語
// （「今の」「でしたが」など）が無ければ、前の値とみなして照らさない。読点の位置や、あいだにある別の額
// （「前の試算では総額が80万円で…」）には頼らない（#66 の A-2③）。
function pastRange(before: string): boolean {
  const marker = [...before.matchAll(new RegExp(PAST_MARKER.source, "g"))].at(-1);
  if (!marker) return false;
  return !PRESENT_AFTER_PAST.test(before.slice(marker.index + marker[0].length));
}

// 条件を言う語（「〜場合」「〜なら」「〜とき」）。
const CONDITION_MARKER = /(?:の)?場合|なら(?:ば)?|とき/g;
const CLAUSE_BREAK = /[、,]/;
// 条件と筋書きの名前の言い方をそろえる。
const canon = (text: string) =>
  text
    .replace(/\s+/g, "")
    .replace(/適用されない|適用できない/g, "使えない")
    .replace(/適用される|適用できる/g, "使える")
    .replace(/(?:の)?場合$/, "");
// 一致した語のすぐあとが否定や問いなら、別の条件として結び付けない（「使えるか分からない」「使えない」）。
const NEGATED_AFTER = /^(?:か|ない|なく|ず|ません)/;

function containsAffirmed(haystack: string, needle: string): boolean {
  let from = haystack.indexOf(needle);
  while (from >= 0) {
    if (!NEGATED_AFTER.test(haystack.slice(from + needle.length))) return true;
    from = haystack.indexOf(needle, from + 1);
  }
  return false;
}

function sentenceAround(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !SENTENCE_END.test(text[from - 1])) from -= 1;
  let to = end;
  while (to < text.length && !SENTENCE_END.test(text[to])) to += 1;
  return text.slice(from, to);
}

interface ScenarioRange {
  keys: string[];
  need_low: number;
  need_high: number;
}

// 最新の見通しの、筋書きごとの要る額の範囲と、結び付けに使う名前と入出金の label。
function latestScenarios(toolEvents: readonly GuardToolEvent[]): {
  confirm: WhatToConfirm;
  scenarios: ScenarioRange[];
} | null {
  for (const event of [...toolEvents].reverse()) {
    const output = event.output;
    if (output === null || typeof output !== "object" || !("what_to_confirm" in output))
      continue;
    const parsed = whatToConfirmSchema.safeParse(output.what_to_confirm);
    if (!parsed.success) continue;
    const confirm = parsed.data;
    const branches = confirm.factors.find((factor) => factor.kind === "scenario")?.branches ?? [];
    const input = event.input as { scenarios?: { name?: unknown; events?: { label?: unknown }[] }[] };
    const inputs = Array.isArray(input?.scenarios) ? input.scenarios : [];
    const labelsOf = (index: number) =>
      (inputs[index]?.events ?? [])
        .map((item) => item.label)
        .filter((label): label is string => typeof label === "string");
    // どの筋書きにもある label は、筋書きを区別しないので結び付けに使わない。
    const shared = new Set(
      labelsOf(0).filter((label) => inputs.every((_, index) => labelsOf(index).includes(label))),
    );
    const scenarios = branches.map((branch, index) => ({
      keys: [branch.name, ...labelsOf(index).filter((label) => !shared.has(label))]
        .map(canon)
        .filter((key) => key.length >= 3),
      need_low: branch.need_low,
      need_high: branch.need_high,
    }));
    return { confirm, scenarios };
  }
  return null;
}

// 条件の語の前の部分に当たる筋書きを探す。結び付けられなければ null。
function scenariosFor(condition: string, scenarios: readonly ScenarioRange[]): ScenarioRange[] | null {
  const said = canon(condition);
  if (said.length < 3) return null;
  // 条件全体が名前に入っている筋書きを先に使う（4 回目の指摘①）。複合した条件の一部だけで、
  // 別の筋書きまで混ぜて範囲を広げないため。無ければ、名前の一部（「・」などで区切った部分）で結び付ける。
  const whole = scenarios.filter((scenario) =>
    scenario.keys.some((key) => containsAffirmed(key, said)),
  );
  if (whole.length > 0) return whole;
  // 名前の部分（「・」などで区切った部分）が、すべて条件に入っている筋書きだけを使う（#66 の A-2①）。
  // 「窓口で上限が使える前提で費用が半々」は「窓口で上限が使える・費用が半々」に当たり、共通の部分しか入っていない
  // 「窓口で上限が使える・費用が12月に寄る」は混ぜない。どれも当たらなければ照らさない。
  // 見分ける部分が短くても（「半々」）、一致の条件に入れる（#67 の Codex④）。
  const full = scenarios.filter((scenario) =>
    scenario.keys.some((key) => {
      const parts = key.split(/[・、,／/（）()]/).filter((part) => part.length > 0);
      return (
        parts.some((part) => part.length >= 3) &&
        parts.every((part) => containsAffirmed(said, part))
      );
    }),
  );
  return full.length > 0 ? full : null;
}

// 返答が書いた「要る額」の範囲が、最新の計算の範囲（what_to_confirm の need_low〜need_high）と合うかを照らす（#61 の指摘 8）。
// 数字が 1 つずつ計算にあっても、別の筋書きの額を組み合わせた範囲は、画面の表と食い違うため。
// 条件をつけた範囲（「〜場合」「〜なら」）は、その条件に当たる筋書きの範囲と照らす。結び付けられないときは照らさない
// （取りこぼしを許し、正しい返答を伏せないほうを取る）。幅の縮みを言う部分と、前の値を言う部分は照らさない（3 回目の指摘 1・3）。
function rangeMismatches(
  text: string,
  toolEvents: readonly GuardToolEvent[],
): Unverified[] {
  const latest = latestScenarios(toolEvents);
  if (!latest) return [];
  const { confirm } = latest;
  const normalized = normalize(text);
  const amounts = amountsAt(text);
  return amounts.slice(0, -1).flatMap((low, index): Unverified[] => {
    const high = amounts[index + 1];
    if (!RANGE_JOINER.test(normalized.slice(low.end, high.start))) return [];
    let sentenceStart = low.start;
    while (sentenceStart > 0 && !SENTENCE_END.test(normalized[sentenceStart - 1]))
      sentenceStart -= 1;
    const sentence = sentenceAround(normalized, low.start, high.end);
    if (!sentence.includes("要る額")) return [];
    if (SHRINK_AFTER.test(normalized.slice(high.end))) return [];
    const before = normalized.slice(sentenceStart, low.start);
    if (pastRange(before)) return [];
    // 文の最後の「要る額」から範囲までに「幅」があり、範囲のすぐあとに変化の語が続く文
    // （「要る額の幅は149,060円から0円になります」）は、幅が変わることを言う文なので、要る額の範囲とは照らさない（#71）。
    // 変化の語が無い「今の要る額の幅は、X 円から Y 円までです」は、要る額の範囲として照らす（#76）。一つずつの額の照合は残る。
    const lastNeed = before.lastIndexOf("要る額");
    if (
      lastNeed >= 0 &&
      before.slice(lastNeed).includes("幅") &&
      WIDTH_CHANGE_AFTER.test(normalized.slice(high.end))
    )
      return [];
    const conditions = [...before.matchAll(CONDITION_MARKER)];
    const condition = conditions.at(-1);
    let expected: { need_low: number; need_high: number; name: string | null };
    if (condition) {
      // 条件の語の前の部分（読点や前の条件の語のあとから）を、筋書きに結び付ける。
      const head = before.slice(0, condition.index);
      const from = Math.max(
        ...[...head.matchAll(new RegExp(CLAUSE_BREAK, "g"))].map((match) => match.index + 1),
        ...conditions.slice(0, -1).map((match) => match.index + match[0].length),
        0,
      );
      const said = head.slice(from).replace(/^[はがもで]/, "").trim();
      const matched = scenariosFor(said, latest.scenarios);
      if (!matched) return [];
      expected = {
        need_low: Math.min(...matched.map((scenario) => scenario.need_low)),
        need_high: Math.max(...matched.map((scenario) => scenario.need_high)),
        name: said,
      };
    } else {
      // 範囲のあとにだけ条件の語があれば、どの条件の範囲か分からないので照らさない。
      if (new RegExp(CONDITION_MARKER.source).test(sentence)) return [];
      expected = { need_low: confirm.need_low, need_high: confirm.need_high, name: null };
    }
    const [from, to] = [low.value, high.value].sort((a, b) => a - b);
    if (from === expected.need_low && to === expected.need_high) return [];
    const shown = `${low.shown}〜${high.shown}`;
    const where = expected.name
      ? `「${expected.name}」に当たる筋書きの要る額の範囲`
      : "いまの計算の要る額の範囲";
    return [
      {
        start: low.start,
        end: high.end,
        warning: {
          kind: "amount",
          shown,
          message: `「${shown}」は、${where}（${yen(expected.need_low)}〜${yen(expected.need_high)}）と合いません。表の筋書きと見比べるか、計算し直すように頼んでください。`,
        },
      },
    ];
  });
}

// 照らせない金額・日付と、計算と合わない要る額の範囲を、位置つきで集める。
// 範囲の端が、それだけで照らせない額なら、範囲の注意は重ねない。
function problemsIn(text: string, args: CheckArgs): Unverified[] {
  const unverified = unverifiedIn(text, allowedValues(args), args.today);
  const ranges = rangeMismatches(text, args.toolEvents).filter(
    (range) =>
      !unverified.some((item) => item.start < range.end && range.start < item.end),
  );
  return [...unverified, ...ranges];
}

export function checkReply({
  reply,
  ...args
}: CheckArgs & { reply: string | null }): MoneyWarning[] {
  if (!reply) return [];
  const seen = new Set<string>();
  return [
    ...problemsIn(reply, args).map((item) => item.warning),
    ...misleadingShrink(reply, args.toolEvents),
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

// 照らせなかった金額と日付、計算と合わない範囲を伏せる。重なった範囲（「12/25（日）」の日付と曜日、
// 範囲とその中の額など）は、つないで 1 回だけ伏せる。注記は足さない。
export function maskProblems({
  text,
  ...args
}: CheckArgs & { text: string }): { text: string; masked: number } {
  const items = problemsIn(text, args);
  if (items.length === 0) return { text, masked: 0 };
  const spans: { start: number; end: number; amount: boolean }[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    const amount = item.warning.kind === "amount";
    const last = spans.at(-1);
    if (last && item.start < last.end) {
      last.end = Math.max(last.end, item.end);
      last.amount ||= amount;
    } else spans.push({ start: item.start, end: item.end, amount });
  }
  let masked = text;
  for (const span of spans.reverse())
    masked =
      masked.slice(0, span.start) +
      (span.amount ? MASKED_AMOUNT : MASKED_DATE) +
      masked.slice(span.end);
  return { text: masked, masked: items.length };
}

// 返答の本文から、照らせなかった金額と日付を伏せる（#59 の指摘 1）。伏せたら短い注記を足す。
export function maskUnverified({
  reply,
  ...args
}: CheckArgs & { reply: string }): { text: string; masked: number } {
  const result = maskProblems({ ...args, text: reply });
  if (result.masked === 0) return result;
  return { text: `${result.text}\n${MASK_NOTE}`, masked: result.masked };
}

const ELLIPSIS = "…";
// 途中で切れた数（「11万」「115,6」「１１５，」など）を、数ごと残さないために末尾から外す文字。
// 全角の数字・区切り・円記号と、範囲の印も含める（3 回目の指摘 5）。
const TRAILING_NUMBER =
  /[\d,.０-９，．〇一二三四五六七八九十百千万億¥￥〜～~\s]+$/;

// 伏字・注記・固定の案内で字数が増えても、画面の形の上限に収める（#61 の指摘 3）。
// 文の終わりで切れるなら、そこで切る。注記は残す。
export function fitLength(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = text.endsWith(`\n${MASK_NOTE}`) ? `\n${MASK_NOTE}` : "";
  const body = text.slice(0, text.length - tail.length);
  const room = Math.max(limit - tail.length - ELLIPSIS.length, 0);
  let cut = body.slice(0, room);
  const ends = [...cut.matchAll(/[。！？!?\n]）?/g)];
  const lastEnd = ends.at(-1);
  if (lastEnd && lastEnd.index + lastEnd[0].length >= room / 2)
    cut = cut.slice(0, lastEnd.index + lastEnd[0].length);
  else {
    // 括弧の途中（伏字や案内の途中）で切れたら、括弧の前まで戻す。
    const open = cut.lastIndexOf("（");
    if (open > cut.lastIndexOf("）")) cut = cut.slice(0, open);
    cut = cut.replace(TRAILING_NUMBER, "");
  }
  return `${cut}${ELLIPSIS}${tail}`;
}

// 給付が受けられると言い切る文と、連絡や申請を済ませたと言う文（#59 の指摘 7、#61 の指摘 5・6）。
// このアプリは給付を判断せず、連絡も申請もしないので、出たら固定の案内に置き換える。
// 「申請しましたか」のような問いかけや、「必ず確かめてください」のような勧めは置き換えない。
const BENEFIT_CLAIMS = [
  /(?:必ず|確実に|間違いなく|絶対に?)[^。！？\n]{0,24}?(?:受けられ|受け取れ|もらえ|支給され|支払われ|振り込まれ|戻ってき|戻ります|下ります|下りる|出ます|入ります)/,
  // 強調の語が無くても、給付が出ると言い切る文。
  /(?:給付金?|保険金|手当金?|見舞金|一時金)(?:は|が|も)[^。！？\n]{0,12}?(?:支給されます|支払われます|振り込まれます|受けられます|受け取れます|もらえます|出ます|下ります|入ります)(?!か|ように)/,
  // 給付が決まっていると言い切る文（「給付は確定しています」）（#76）。
  /(?:給付金?|保険金|手当金?|見舞金|一時金|払い戻し)(?:は|が|も)[^。！？\n]{0,12}?(?:確定しています|確定しました|確定です|決まっています|決定しています|決定しました)(?!か)/,
  // 主語を書かずに「必ず支給されます」と言い切る文（#76）。
  /^\s*(?:必ず|確実に|間違いなく|絶対に?)?\s*(?:支給されます|支払われます|振り込まれます|給付されます)(?!か)/,
];
const ACTION = "申請|連絡|予約|請求|送信|送付|手続き|問い合わせ|電話|手配";
const DONE_CLAIM = new RegExp(
  `(${ACTION})(?:は|も|を)?(?:済ませました|済ませておきました|済みです|完了しました|しておきました|しました|行いました)(?!か)`,
);
// アプリが行ったと読める文。「あなたが」などがあっても置き換える（3 回目の指摘 2）。
const APP_ACTIONS = [
  new RegExp(`(?:代わりに|こちらで|こちらから)[^。！？\\n]{0,16}?(?:${ACTION})(?:を|は)?(?:しました|しておきました|します|しておきます|済ませ|済み|完了)`),
  new RegExp(`(?:${ACTION})(?:を|は)?(?:しておきました|済ませておきました|しておきます)`),
];
// 済ませた人。返答（アプリの声）の「私」はアプリ、カード（本人がそのまま使う下書き）の「私」は本人。
const ACTORS: [RegExp, string][] = [
  [/^(?:ご本人|本人)/, "self"],
  [/^(?:奥様|奥さん|家内|妻)/, "wife"],
  [/^(?:ご主人|旦那さん|旦那|主人|夫)/, "husband"],
  [/^(?:お母さん|母親|義母|祖母|母)/, "mother"],
  [/^(?:お父さん|父親|義父|祖父|父)/, "father"],
  [/^(?:子ども|子供|息子|娘|長男|長女|次男|次女)/, "child"],
  [/^(?:兄|姉|弟|妹)/, "sibling"],
  [/^(?:ご家族|家族)/, "family"],
];
const ACTOR_AT = /(?:ご本人|本人|奥様|奥さん|家内|妻|ご主人|旦那さん|旦那|主人|夫|お母さん|母親|義母|祖母|母|お父さん|父親|義父|祖父|父|子ども|子供|息子|娘|長男|長女|次男|次女|兄|姉|弟|妹|ご家族|家族|あなた|私|わたし|僕|ぼく|自分)(?:は|が|も|から)/;
const ACTION_GROUP: Record<string, string> = {
  申請: "apply",
  請求: "apply",
  手続き: "apply",
  連絡: "contact",
  問い合わせ: "contact",
  電話: "contact",
  手配: "apply",
  送信: "send",
  送付: "send",
  予約: "reserve",
};

// 主語のすぐあとに述語と従属節の印（「入院している間に」「退院したので」）が続けば、その主語は従属節の主語。
// 「退院前に」「仕事の合間に」のような時を示す語だけでは、従属節とみなさない（#67 の Codex③）。
const SUBORDINATE_AFTER =
  /^[^、。]*?(?:る|た|ない|ている|ていた|てる)(?:間に|あいだに|ときに|時に|とき、|うちに|ので|ため|前に|後に|あとに|あとで)|^[^、。]*?(?:てから|ながら)/;

// 文の中で、済ませた人を読む。完了した行為（at の位置）のすぐ前の主語を使う（4 回目の指摘②）。
// 従属節の主語は外す。「は」の主語は文全体の主語として残す（#66 の A-2②）。
// 主語が書かれていなければ、返答ではアプリ、本人の文では本人。主語はあるのに判別できなければ null。
function actorOf(sentence: string, voice: "reply" | "card", at: number): string | null {
  const head = sentence.slice(0, at);
  const mentions = [...head.matchAll(new RegExp(ACTOR_AT.source, "g"))];
  if (mentions.length === 0) return voice === "reply" ? "app" : "self";
  // 従属節の主語として外すのは、ほかにも主語が書かれていて、その主語のすぐあとに述語と従属節の印があるときだけ。
  const subordinate = (mention: RegExpExecArray) =>
    mentions.length >= 2 &&
    !mention[0].endsWith("は") &&
    SUBORDINATE_AFTER.test(head.slice(mention.index + mention[0].length));
  const found = mentions.filter((mention) => !subordinate(mention)).at(-1);
  if (!found) return null;
  const word = found[0].replace(/(?:は|が|も|から)$/, "");
  if (word === "あなた") return voice === "reply" ? "self" : "other";
  if (/^(?:私|わたし|僕|ぼく|自分)$/.test(word)) return voice === "reply" ? "app" : "self";
  return ACTORS.find(([pattern]) => pattern.test(word))?.[1] ?? "other";
}

// 家族を言う主語と、本人を言う主語（本人の発言の中で）。
const FAMILY_SUBJECT =
  /(?:奥様|奥さん|家内|妻|ご主人|旦那|主人|夫|お母さん|母親|義母|祖母|母|お父さん|父親|義父|祖父|父|子ども|子供|息子|娘|長男|長女|次男|次女|兄|姉|弟|妹|ご家族|家族)(?:は|が|も|から)/;
// 済ませた人を判別できない形は「（家族）は私が…（間に・ときに・うちに）」だけ（#76）。
// 「夫は私が留守の間に、保険会社に連絡しました。」
const AMBIGUOUS_REPORT = new RegExp(
  `${FAMILY_SUBJECT.source.replace("(?:は|が|も|から)", "は")}[^。！？\\n]*?(?:私|わたし|僕|ぼく|自分)が[^。！？\\n]*?(?:間に|あいだに|ときに|時に|うちに)`,
);
// 本人がした・していないと明示した文（「私はまだ連絡していません」）は、判別できるので例外にしない（#76）。
const SELF_DENIED = /(?:私|わたし|僕|ぼく|自分)は(?:まだ)?[^。！？\n]*?(?:ていません|ていない|してない|しません|しておりません)/;

// 本人の発言にある完了の報告（誰が・何を）。家族と本人の両方が主語に出てくる報告
// （「夫は私が留守の間に、保険会社に連絡しました。」）は、済ませた人を判別できないので「ambiguous:手続き」として持つ（#71）。
function reportsIn(userTexts: readonly string[]): Set<string> {
  const reports = new Set<string>();
  for (const sentence of userTexts.flatMap((text) => text.match(/[^。！？\n]+[。！？]?/g) ?? [])) {
    const done = DONE_CLAIM.exec(sentence);
    if (done && AMBIGUOUS_REPORT.test(sentence) && !SELF_DENIED.test(sentence))
      reports.add(`ambiguous:${ACTION_GROUP[done[1]]}`);
    const actor = done ? actorOf(sentence, "card", done.index) : null;
    if (done && actor) reports.add(`${actor}:${ACTION_GROUP[done[1]]}`);
  }
  return reports;
}
export const SOFTENED_CLAIM =
  "（給付が受けられるか、手続きが済んだかは、ここでは確かめられません。加入先や窓口に確かめてください。このアプリは、連絡や申請を代わりに行いません。）";
export const SOFTENED_TITLE = "給付と手続きは、加入先や窓口で確かめる";

export interface SoftenOptions {
  // reply: アプリの返答。card: 本人がそのまま使う下書き。
  voice?: "reply" | "card";
  // 本人の発言。カードが写した発言の文は、本人の報告なので置き換えない。
  userTexts?: readonly string[];
}

const PURPOSE_AFTER = /^[^、。！？\n]*?(?:よう|ため|ので|間に|あいだに|ときに|うちに)/;

function otherActorDid(sentence: string, voice: "reply" | "card"): boolean {
  const mentions = [...sentence.matchAll(new RegExp(ACTOR_AT.source, "g"))].filter(
    (mention) => !PURPOSE_AFTER.test(sentence.slice(mention.index + mention[0].length)),
  );
  const last = mentions.at(-1);
  if (!last) return false;
  const word = last[0].replace(/(?:は|が|も|から)$/, "");
  if (word === "あなた") return voice === "reply";
  if (/^(?:私|わたし|僕|ぼく|自分)$/.test(word)) return voice === "card";
  return ACTORS.some(([pattern]) => pattern.test(word));
}

function overclaims(
  sentence: string,
  { voice = "reply", userTexts = [] }: SoftenOptions,
): boolean {
  if (BENEFIT_CLAIMS.some((pattern) => pattern.test(sentence))) return true;
  const done = DONE_CLAIM.exec(sentence);
  const appAction = APP_ACTIONS.some((pattern) => pattern.test(sentence));
  if (!done && !appAction) return false;
  // 本人の発言をそのまま写した文は、本人の報告なので残す。
  const trimmed = sentence.trim();
  if (trimmed && userTexts.some((text) => text.includes(trimmed))) return false;
  // 利用者や家族が主語の文（「夫が電話しておきました」）は、アプリが行ったと読めないので置き換えない（#76）。
  // 「あなたが安心できるよう、代わりに…」のように、主語のすぐあとに目的や理由の節が続くものは主語とみなさない。
  if (appAction) return !otherActorDid(sentence, voice);
  if (!done) return true;
  // 本人や家族の完了の報告は、本人が同じこと（同じ人が、同じ手続きを）を話していれば残す。
  const actor = actorOf(sentence, voice, done.index);
  // 済ませた人を判別できなければ、置き換えない（ADR 0018: 迷ったら伏せない・置き換えない側に倒す）。
  if (actor === null) return false;
  if (actor === "app" || actor === "other") return true;
  const reports = reportsIn(userTexts);
  const group = ACTION_GROUP[done[1]];
  // 本人の報告で済ませた人を判別できないときは、置き換えない（ADR 0018: 迷ったら置き換えない側に倒す）。
  if (reports.has(`ambiguous:${group}`)) return false;
  return !reports.has(`${actor}:${group}`);
}

export function softenClaims(
  text: string,
  options: SoftenOptions = {},
): { text: string; replaced: number } {
  let replaced = 0;
  const sentences = text.match(/[^。！？\n]+[。！？]?|\n/g) ?? [];
  const softened = sentences.map((sentence) => {
    if (!overclaims(sentence, options)) return sentence;
    replaced += 1;
    // 続けて置き換えるときは、案内を 1 回だけにする。
    return replaced === 1 ? SOFTENED_CLAIM : "";
  });
  return replaced === 0 ? { text, replaced } : { text: softened.join(""), replaced };
}

// カードの見出しは短いので、断定があれば見出しごと決まった短い文にする（#61 の指摘 6）。
export function softenTitle(title: string, options: SoftenOptions = {}): string {
  return softenClaims(title, { voice: "card", ...options }).replaced > 0
    ? SOFTENED_TITLE
    : title;
}

// 足りない額を「足ります」、残る額を「足りません」のように、向きを逆に書いた文を見つけて、
// 計算から作った文に置き換える（#66 の A-3）。数字は計算と合うので、金額の照合では見つからない。
// 足りる側と足りない側の言い方がまざって判別できない文は、置き換えない。
const SHORT_WORDS = /足りません|足りない|足りなく|足らない|足らず|不足/;
const ENOUGH_WORDS = /足ります|足りる|足りています|間に合います|間に合う|収まります|収まる|残ります|残る|余ります|余る/;

// 条件や問いの形の文（「追加すれば」「足りるかどうか」）は、向きを判別できないので置き換えない（#67）。
const UNDECIDABLE_GAP = /れば|たら|ても|でも|かどうか|か[、。？?]|ますか|でしょうか/;
// 資金を足す動詞のあとに条件の語（ば・と・たら・なら・ことで）が続く文も、条件の文とみなす（#76）。
// 「10,180円を補っておくと」「追加することで」。
const FUND_CONDITION =
  /(?:追加|用意|足す|足し|足せ|補|準備|工面|借り|借入|立て替)[^。！？\n、]{0,8}?(?:ば|と[、,]|と\s|たら|なら|ことで)/;
// 資金を足すことを打ち消す文（「追加の用意はいりません」）は、条件の文とみなさず、向きを照らす（#76）。
const FUND_NEGATED =
  /(?:追加|用意|補|準備|工面|借り|借入|足さ)[^。！？\n]{0,12}?(?:いりません|いらない|要りません|要らない|不要|必要(?:は|も)?(?:ありません|ない)|しなくて|せずに|せず|なくても)/;

interface Gap {
  name: string;
  cash: number;
  needLow: number;
  needHigh: number;
}

function latestGaps(toolEvents: readonly GuardToolEvent[]): Gap[] {
  for (const event of [...toolEvents].reverse()) {
    const parsed = cashflowOutputSchema.safeParse(event.output);
    if (!parsed.success) continue;
    const cash = parsed.data.cash_on_hand;
    if (cash === null) return [];
    return parsed.data.scenarios.map((scenario) => ({
      name: scenario.name,
      cash,
      needLow: scenario.low_case.need,
      needHigh: scenario.high_case.need,
    }));
  }
  return [];
}

export function fixGapDirection(
  text: string,
  toolEvents: readonly GuardToolEvent[],
): { text: string; replaced: number; sentences: string[] } {
  const gaps = latestGaps(toolEvents);
  if (gaps.length === 0) return { text, replaced: 0, sentences: [] };
  const short = (value: number) =>
    gaps.filter((gap) => [gap.needLow, gap.needHigh].some((need) => need - gap.cash === value));
  const remain = (value: number) =>
    gaps.filter((gap) => [gap.needLow, gap.needHigh].some((need) => gap.cash - need === value));
  const sentences: string[] = [];
  const pieces = (text.match(/[^。！？\n]+[。！？]?|\n/g) ?? []).map((sentence) => {
    const saysShort = SHORT_WORDS.test(sentence);
    const saysEnough = ENOUGH_WORDS.test(sentence);
    if (saysShort === saysEnough) return sentence;
    // 準備の方法を言う条件の文（「追加すれば」「用意したら」）と、問いの形の文（「足りるかどうか」）は、
    // 向きを判別できないので置き換えない（#67 の Codex②）。
    if (
      !FUND_NEGATED.test(sentence) &&
      (UNDECIDABLE_GAP.test(sentence) || FUND_CONDITION.test(sentence))
    )
      return sentence;
    for (const { value } of amountsIn(sentence)) {
      if (value <= 0) continue;
      const shortOf = short(value);
      const remainOf = remain(value);
      if (shortOf.length > 0 && remainOf.length > 0) continue;
      const wrong = saysEnough ? shortOf : remainOf;
      if (wrong.length === 0) continue;
      sentences.push(sentence.trim());
      return wrong
        .map(
          (gap) =>
            `「${gap.name}」なら、手元の ${yen(gap.cash)}では ${cashGapText(gap.cash, gap.needLow, gap.needHigh)}。`,
        )
        .join("");
    }
    return sentence;
  });
  return sentences.length === 0
    ? { text, replaced: 0, sentences }
    : { text: pieces.join(""), replaced: sentences.length, sentences };
}
