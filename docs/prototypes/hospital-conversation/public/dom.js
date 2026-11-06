// 画面の部品。値はすべて文字として入れる（HTML として解釈させない）。

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const numberFormat = new Intl.NumberFormat("ja-JP");

let todayYear = null;

// 今年の日付は「11/30（月）」、ほかの年は「2027/1/6（水）」と出すために、今日の年を覚えておく。
export function setTodayYear(year) {
  todayYear = year;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  // null は「出すものが無い」の印として受け取り、何も足さない。
  node.append(...[children].flat().filter((child) => child !== null));
  return node;
}

export const count = (value) => numberFormat.format(value);

export const yen = (value) =>
  `${value < 0 ? "−" : ""}${count(Math.abs(value))} 円`;

export const signedYen = (value) => `${value > 0 ? "+" : ""}${yen(value)}`;

export const yenRange = (low, high) =>
  low === high ? yen(low) : `${count(low)}〜${count(high)} 円`;

export function showDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!match) return "—";
  const [year, month, day] = match.slice(1).map(Number);
  const weekday =
    WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${year === todayYear ? "" : `${year}/`}${month}/${day}（${weekday}）`;
}

// 外へのリンクは https だけ。別のタブで開き、開いた先からこの画面を触れないようにする。
export function externalLink(url, text, title) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return el("span", { text });
  }
  return el("a", {
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    ...(title ? { title } : {}),
    text,
  });
}

export const list = (items) =>
  el(
    "ul",
    {},
    items.map((item) => el("li", { text: item })),
  );

const YEN_CELL = /^[−+]?[\d,]+(?:〜[\d,]+)? 円$/;

// 1 列目は行の見出し。金額のセルがある列は、見出しごと右に寄せて桁をそろえる。
export function table(headers, rows) {
  const numeric = headers.map(
    (_, column) =>
      column > 0 && rows.some((cells) => YEN_CELL.test(cells[column])),
  );
  const className = (column) => (numeric[column] ? "num" : "");
  const head = el(
    "thead",
    {},
    el(
      "tr",
      {},
      headers.map((header, column) =>
        el("th", { scope: "col", class: className(column), text: header }),
      ),
    ),
  );
  const body = el(
    "tbody",
    {},
    rows.map((cells) =>
      el(
        "tr",
        {},
        cells.map((cell, column) =>
          column === 0
            ? el("th", { scope: "row", text: cell })
            : el("td", { class: className(column), text: cell }),
        ),
      ),
    ),
  );
  return el("div", { class: "table-wrap" }, el("table", {}, [head, body]));
}

export function foldout(summary, children) {
  return el("details", {}, [el("summary", { text: summary }), ...children]);
}

// 出典が無いとき（暦の足し引きだけの日付の計算など）は、行そのものを出さない。
export function sourceLine(sources, suffix = "") {
  if (sources.length === 0) return null;
  const links = sources.flatMap((source, index) => [
    ...(index > 0 ? ["、"] : []),
    externalLink(source.url, source.name),
    ...(source.checked_on ? [`（${source.checked_on} に確認）`] : []),
  ]);
  return el("p", { class: "sources" }, ["出典: ", ...links, suffix]);
}

export function card(title, lead, children) {
  return el("section", { class: "card" }, [
    el("h3", { text: title }),
    el("p", { class: "card-lead", text: lead }),
    ...children,
  ]);
}
