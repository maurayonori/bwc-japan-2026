import { FACTS } from './facts.mjs';

// 返答に書かれた金額と日付が、プログラムの計算結果・利用者の発言・持っている事実のどれかにあるかを照らす。
// 「金額と日付は、プログラムが計算したものだけを見せる」という約束を、目で確かめられるようにするため。
// 見つからないものは、返答を止めずに、注意として画面に出す。

const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const AMOUNT_PATTERN = new RegExp(String.raw`(${NUMBER})\s*(万)?\s*(円)?(\s*[〜～~]\s*)?`, 'g');
const ISO_DATE_PATTERN = /(\d{4})-(\d{2})-(\d{2})/g;
const SLASH_DATE_PATTERN = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g;
const KANJI_DATE_PATTERN = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;

// 全角の数字・区切りを半角にそろえる。
function normalize(text) {
  return text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/，/g, ',')
    .replace(/．/g, '.')
    .replace(/／/g, '/');
}

const toYen = (number, hasMan) => Math.round(Number(number.replace(/,/g, '')) * (hasMan ? 10_000 : 1));

// 文章から「◯円」「◯万円」「A〜B 円」の金額を取り出す。円の付かない数字は金額として扱わない。
function amountsIn(text) {
  const matches = [...normalize(text).matchAll(AMOUNT_PATTERN)];
  return matches.flatMap((match, index) => {
    const [, number, man, yen, rangeMark] = match;
    if (yen) return [{ value: toYen(number, Boolean(man)), shown: `${number}${man ? ' 万' : ' '}円` }];
    // 「A〜B 円」の A。単位（万）が A に無ければ、B の単位を借りる。
    const next = matches[index + 1];
    if (rangeMark && next && next[3] && next.index === match.index + match[0].length) {
      const hasMan = Boolean(man || next[2]);
      return [{ value: toYen(number, hasMan), shown: `${number}${hasMan ? ' 万' : ' '}円` }];
    }
    return [];
  });
}

// 利用者の発言では、円が付いていない数字も、利用者が言った額として受け取る。
function looseAmountsIn(text) {
  return [...normalize(text).matchAll(AMOUNT_PATTERN)]
    .flatMap(([, number, man]) => [toYen(number, false), ...(man ? [toYen(number, true)] : [])]);
}

function validMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? [`${month}/${day}`] : [];
}

// 文章から日付を取り出し、「月/日」の形にそろえる。
function datesIn(text) {
  const normalized = normalize(text);
  return [
    ...[...normalized.matchAll(ISO_DATE_PATTERN)].flatMap((match) => validMonthDay(Number(match[2]), Number(match[3]))),
    ...[...normalized.matchAll(SLASH_DATE_PATTERN)].flatMap((match) => validMonthDay(Number(match[1]), Number(match[2]))),
    ...[...normalized.matchAll(KANJI_DATE_PATTERN)].flatMap((match) => validMonthDay(Number(match[1]), Number(match[2]))),
  ];
}

// 道具の入力と結果を端までたどり、数と文字列を集める。
function leavesOf(value) {
  if (typeof value === 'number' || typeof value === 'string') return [value];
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leavesOf);
  return [];
}

const FACT_TEXTS = FACTS.map((fact) => fact.text);

function allowedValues({ toolEvents, userTexts, today }) {
  const leaves = toolEvents.flatMap((event) => [...leavesOf(event.input), ...leavesOf(event.output ?? null)]);
  const toolStrings = leaves.filter((leaf) => typeof leaf === 'string');
  const strings = [...toolStrings, ...userTexts, ...FACT_TEXTS, today];
  return {
    amounts: new Set([
      // 累計や差額は、結果では負の値。返答では「◯円少ない」のように符号なしで書くので、大きさで照らす。
      ...leaves.filter((leaf) => typeof leaf === 'number').map(Math.abs),
      // 道具の結果の説明文（区分の条件「28 万〜50 万円」など）と、持っている事実の文にある金額。
      ...[...toolStrings, ...FACT_TEXTS].flatMap((text) => amountsIn(text).map((amount) => amount.value)),
      ...userTexts.flatMap(looseAmountsIn),
    ]),
    dates: new Set(strings.flatMap(datesIn)),
  };
}

export function checkReply({ reply, toolEvents, userTexts, today }) {
  if (!reply) return [];
  const allowed = allowedValues({ toolEvents, userTexts, today });

  const unknownAmounts = amountsIn(reply)
    .filter((amount) => !allowed.amounts.has(amount.value))
    .map((amount) => ({
      kind: 'amount',
      shown: amount.shown,
      message: `「${amount.shown}」は、計算結果・あなたの発言・出典のどれにも見当たらない金額です。計算し直すように頼んでください。`,
    }));

  const unknownDates = datesIn(reply)
    .filter((date) => !allowed.dates.has(date))
    .map((date) => ({
      kind: 'date',
      shown: date,
      message: `「${date}」は、計算結果にも、あなたの発言にも見当たらない日付です。計算し直すように頼んでください。`,
    }));

  const seen = new Set();
  return [...unknownAmounts, ...unknownDates].filter((warning) => {
    const key = `${warning.kind}:${warning.shown}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
