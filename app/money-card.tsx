"use client";

import { useEffect, useState } from "react";
import { FACTS } from "@/lib/money/facts";
import {
  CERTAINTY_TEXT,
  DIRECTION_TEXT,
  KOUGAKU_ROWS,
  cashflowPaths,
  cashflowRows,
  copayText,
  formulaText,
  inDisplayOrder,
  moneySources,
  monthText,
  needDifferenceText,
  readingGuide,
  showDate,
  stepText,
  toolTraceText,
  yen,
  yenRange,
  type CashflowScenario,
} from "@/lib/money/format";
import type {
  CalcDateOutput,
  CashflowOutput,
  KougakuOutput,
  MealOutput,
  Money,
  MoneyWarning,
  WhatToConfirm,
} from "@/lib/money/schema";
import "./money.css";

// 表に出す金額と日付は、すべてサーバーの計算結果。Claude が書いた数字は入らない。

const CITATION = /(\[F\d{2}(?:\s*[,、]\s*F\d{2})*\])/;
const WEEKEND_REASONS = ["土曜日", "日曜日"];
const MAX_SKIPPED_SHOWN = 6;
const HINT_AFTER_SECONDS = 5;
const OTHER_FACTORS_SHOWN = 3;

function Citation({ id }: { id: string }) {
  const fact = FACTS.find((item) => item.id === id);
  const source = fact?.sources[0];
  if (!fact || !source?.url.startsWith("https://"))
    return (
      <span className="fact-cite" title="この番号の事実は、持っていません">
        {id}
      </span>
    );
  return (
    <a
      className="fact-cite"
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${fact.topic}（${source.name}）`}
    >
      {id}
    </a>
  );
}

// 文章の [F03] を、出典へのリンクにする。
export function FactText({ text }: { text: string }) {
  return (
    <>
      {text.split(CITATION).map((part, index) =>
        CITATION.test(part) ? (
          <span key={index}>
            {(part.match(/F\d{2}/g) ?? []).map((id, position) => (
              <span key={id}>
                {position > 0 && " "}
                <Citation id={id} />
              </span>
            ))}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Table({
  headers,
  rows,
}: {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <table className="money-table">
      <thead>
        <tr>
          {headers.map((header, index) => (
            <th key={index} scope="col">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, index) =>
              index === 0 ? (
                <th key={index} scope="row" data-label={headers[0]}>
                  {cell}
                </th>
              ) : (
                // 値が 1 列だけの表では、列の名前を行ごとに繰り返さない。
                <td
                  key={index}
                  data-label={headers.length > 2 ? headers[index] : undefined}
                >
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Lines({ items }: { items: readonly string[] }) {
  return (
    <ul className="money-lines">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function KougakuSingle({ item }: { item: KougakuOutput["cases"][number] }) {
  const same = JSON.stringify(item.low) === JSON.stringify(item.high);
  const columns = same ? [item.low] : [item.low, item.high];
  return (
    <>
      <p className="money-lead">
        区分{item.category}（{item.condition}）
      </p>
      <Table
        headers={
          same ? ["", "金額"] : ["", "見積もりが少なめのとき", "多めのとき"]
        }
        rows={KOUGAKU_ROWS.map(([label, key]) => [
          label,
          ...columns.map((column) => yen(column[key])),
        ])}
      />
      <p className="money-muted">{formulaText(item.formula)}</p>
      {columns.some((column) => !column.cap_reduces_payment) && (
        <p className="money-muted">
          窓口負担が上限額より小さいときは、上限による軽減はなく、そのままの額を払います。
        </p>
      )}
    </>
  );
}

function KougakuAll({ output }: { output: KougakuOutput }) {
  const [first] = output.cases;
  const range = output.range_if_category_unknown;
  return (
    <>
      <p className="money-lead">
        所得の区分が分からないので、5
        つの区分を並べています。上限が無いときの窓口負担は{" "}
        {yenRange(first.low.copay_without_cap, first.high.copay_without_cap)}。
      </p>
      <Table
        headers={[
          "区分",
          "条件",
          "1 か月の上限額",
          "窓口で払う額（上限が適用されるとき）",
        ]}
        rows={output.cases.map((item) => [
          `区分${item.category}`,
          item.condition,
          yenRange(item.low.cap, item.high.cap),
          yenRange(item.low.pay_with_cap, item.high.pay_with_cap),
        ])}
      />
      {range && (
        <p>
          区分が分かるまでの幅:{" "}
          {yenRange(range.pay_with_cap_low, range.pay_with_cap_high)}
        </p>
      )}
    </>
  );
}

function KougakuBlock({ output }: { output: KougakuOutput }) {
  return (
    <section className="money-block">
      <h4>高額療養費の上限</h4>
      <p className="money-muted">
        {monthText(output.treatment_month)}の診療分・窓口負担{" "}
        {copayText(output.copay_percent)}・保険診療分だけ
      </p>
      {output.cases.length === 1 ? (
        <KougakuSingle item={output.cases[0]} />
      ) : (
        <KougakuAll output={output} />
      )}
      <details>
        <summary>前提</summary>
        <Lines items={output.assumptions} />
      </details>
    </section>
  );
}

function MealBlock({ output }: { output: MealOutput }) {
  const cases =
    output.low.days === output.high.days
      ? [output.low]
      : [output.low, output.high];
  return (
    <section className="money-block">
      <h4>入院中の食事代</h4>
      <p className="money-muted">1 日 3 食で数えた、多めの見積もり</p>
      <Lines
        items={cases.map(
          (item) =>
            `${item.days} 日間: ${yen(output.yen_per_meal)} × ${item.meals_max} 食 ＝ ${yen(item.cost_max)}`,
        )}
      />
      <details>
        <summary>前提</summary>
        <Lines items={output.notes} />
      </details>
    </section>
  );
}

function skippedText(
  skipped: CalcDateOutput["steps"][number]["skipped_non_business_days"],
  baseYear: number,
): string {
  const weekends = skipped.filter((day) =>
    WEEKEND_REASONS.includes(day.reason),
  );
  const others = skipped.filter((day) => !WEEKEND_REASONS.includes(day.reason));
  const shown = others
    .slice(0, MAX_SKIPPED_SHOWN)
    .map((day) => `${showDate(day.date, baseYear)} ${day.reason}`);
  return `数えなかった日: ${[
    ...(weekends.length > 0 ? [`土日 ${weekends.length} 日`] : []),
    ...shown,
    ...(others.length > shown.length
      ? [`ほか ${others.length - shown.length} 日`]
      : []),
  ].join("、")}`;
}

function DateBlock({ output }: { output: CalcDateOutput }) {
  const baseYear = Number(output.start.date.slice(0, 4));
  const { until } = output;
  return (
    <section className="money-block">
      <h4>日付の計算</h4>
      <p className="money-muted">
        起点: {showDate(output.start.date)}
        {output.steps.length > 1 &&
          "。上から順に、前の行の日付から数えています。"}
      </p>
      {output.steps.length > 0 && (
        <ol className="money-steps">
          {output.steps.map((step, index) => (
            <li key={index}>
              {step.label}: {stepText(step)} →{" "}
              <strong>{showDate(step.date, baseYear)}</strong>
              {step.skipped_non_business_days.length > 0 && (
                <span className="money-muted money-block-line">
                  {skippedText(step.skipped_non_business_days, baseYear)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {until && (
        <p>
          起点から {showDate(until.date, baseYear)} まで:{" "}
          {until.days_after_start} 日
          {until.days_inclusive !== null &&
            `（起点の日を入れると ${until.days_inclusive} 日間）`}
        </p>
      )}
      {output.business_day_rule && (
        <p className="money-muted">{output.business_day_rule}</p>
      )}
    </section>
  );
}

function PathTable({
  path,
  hasCash,
  baseYear,
}: {
  path: CashflowScenario["low_case"];
  hasCash: boolean;
  baseYear: number;
}) {
  return (
    <Table
      headers={[
        "内容",
        "日付",
        "出入り",
        "金額",
        "確かさ",
        "出入りの累計",
        ...(hasCash ? ["手元の残り"] : []),
      ]}
      rows={path.rows.map((row) => [
        row.label,
        showDate(row.date, baseYear),
        DIRECTION_TEXT[row.direction] ?? row.direction,
        yen(row.amount),
        CERTAINTY_TEXT[row.certainty] ?? row.certainty,
        yen(row.cumulative_net),
        ...(hasCash ? [yen(row.balance)] : []),
      ])}
    />
  );
}

function ScenarioBlock({
  scenario,
  hasCash,
  baseYear,
}: {
  scenario: CashflowScenario;
  hasCash: boolean;
  baseYear: number;
}) {
  const { headers, rows } = cashflowRows(scenario, hasCash, baseYear);
  return (
    <div className="money-scenario">
      <h5>{scenario.name}</h5>
      <Table headers={headers} rows={rows} />
      <details>
        <summary>日ごとの出入りを見る</summary>
        {cashflowPaths(scenario)
          .slice(0, 2)
          .map(({ label, path }, _index, shown) => (
            <div key={label}>
              {shown.length > 1 && <p className="money-fold-label">{label}</p>}
              <PathTable path={path} hasCash={hasCash} baseYear={baseYear} />
            </div>
          ))}
      </details>
    </div>
  );
}

function CashflowBlock({ output }: { output: CashflowOutput }) {
  const hasCash = output.cash_on_hand !== null;
  const baseYear = Number(output.start_date.slice(0, 4));
  return (
    <section className="money-block">
      <h4>お金の出入りの見通し</h4>
      <p className="money-muted">
        起点: {showDate(output.start_date)}。手元のお金:{" "}
        {hasCash
          ? yen(output.cash_on_hand)
          : "聞いていないので、要る額までを出しています"}
      </p>
      {output.scenarios.map((scenario) => (
        <ScenarioBlock
          key={scenario.name}
          scenario={scenario}
          hasCash={hasCash}
          baseYear={baseYear}
        />
      ))}
      {output.comparison_with_first.length > 0 && (
        <>
          <p className="money-fold-label">
            「{output.scenarios[0].name}」と比べた、手元に要る額の差
          </p>
          <Lines
            items={output.comparison_with_first.map(
              (item) => `${item.name}: ${needDifferenceText(item)}`,
            )}
          />
        </>
      )}
      <details>
        <summary>この表の読み方</summary>
        <Lines items={readingGuide(output)} />
      </details>
    </section>
  );
}

// 聞く相手にそのまま見せる質問文。会話で作った「確かめる・頼む」の文章を使う。
export interface AskQuestion {
  title: string;
  body: string;
}

// 「病院の会計に、このまま聞く」から、聞く相手の名前だけを取り出す。
function askWhom(title: string): string {
  return title.replace(/に、?\s*このまま聞く$/, "") || title;
}

function Bar({
  label,
  value,
  ratio,
  after = false,
}: {
  label: string;
  value: number;
  ratio: number;
  after?: boolean;
}) {
  // 0 でなければ、細くても見えるようにする。
  const percent = ratio > 0 ? Math.max(ratio * 100, 1.5) : 0;
  return (
    <div className="money-bar-row">
      <span className="money-bar-label">{label}</span>
      <span className="money-bar" aria-hidden="true">
        <span
          className={`money-bar-fill${after ? " after" : ""}`}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </span>
      <span className="money-bar-value">{yen(value)}</span>
    </div>
  );
}

function OtherFactors({ confirm }: { confirm: WhatToConfirm }) {
  const others = confirm.factors.slice(1, 1 + OTHER_FACTORS_SHOWN);
  const hidden =
    confirm.factors.length - 1 - others.length + confirm.omitted_factors;
  if (others.length === 0 && hidden === 0) return null;
  return (
    <details>
      <summary>ほかの不明点</summary>
      {others.map((factor) => (
        <div key={factor.name} className="money-confirm-other">
          <p>{factor.name}</p>
          <Bar
            label="確かめると残る幅"
            value={factor.width_if_resolved}
            ratio={
              confirm.width > 0 ? factor.width_if_resolved / confirm.width : 0
            }
            after
          />
        </div>
      ))}
      {hidden > 0 && (
        <p className="money-muted">
          ほかに {hidden} 件の不明点があります。幅の縮み方が小さいか、組み合わせが多くなるので、ここには並べていません。
        </p>
      )}
    </details>
  );
}

// 要る額の幅と、その幅を一番縮める確認を 1 つ。順位も額も、サーバーの計算結果だけを使う。
export function ConfirmBlock({
  output,
  question,
  onAsk,
  disabled = false,
}: {
  output: CashflowOutput;
  question?: AskQuestion | null;
  onAsk?: (text: string) => void;
  disabled?: boolean;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const confirm = output.what_to_confirm;
  if (!confirm) return null;
  const [top] = confirm.factors;
  const { width } = confirm;
  async function copyQuestion(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }
  return (
    <section className="money-block money-confirm decision">
      <h4>まず確かめる 1{"\u00a0"}つ</h4>
      {top && width > 0 && <p className="money-confirm-name">{top.name}</p>}
      <p className="decision-range">
        <span className="money-muted">手元に要る額の幅</span>{" "}
        <strong>{yenRange(confirm.need_low, confirm.need_high)}</strong>
        {width > 0 && <span className="money-muted">（幅 {yen(width)}）</span>}
      </p>
      {confirm.shortfall_low !== null && confirm.shortfall_high !== null && (
        <p className="money-muted">
          手元のお金と比べて足りない額:{" "}
          {yenRange(confirm.shortfall_low, confirm.shortfall_high)}
        </p>
      )}
      {width === 0 ? (
        <p>幅はありません。</p>
      ) : !top ? (
        <p>残る幅は、確かめた額の幅です。</p>
      ) : (
        <div className="decision-check">
          <div className="money-bars">
            <Bar label="いまの幅" value={width} ratio={1} />
            <Bar
              label="確かめると残る幅"
              value={top.width_if_resolved}
              ratio={top.width_if_resolved / width}
              after
            />
          </div>
          {top.shrink === 0 && (
            <p className="money-muted">
              この不明点だけが分かっても、答えによっては幅が縮みません。
            </p>
          )}
          <Table
            headers={["答え", "要る額"]}
            rows={top.branches.map((branch) => [
              branch.name,
              yenRange(branch.need_low, branch.need_high),
            ])}
          />
          {question ? (
            <div className="money-confirm-ask">
              <p>
                <span className="money-muted">聞く相手</span>{" "}
                {askWhom(question.title)}
              </p>
              <button
                type="button"
                className="secondary money-copy"
                onClick={() => void copyQuestion(question.body)}
              >
                {copy === "copied" ? "✓ コピーしました" : "質問文をコピー"}
              </button>
              {copy === "failed" && (
                <p className="money-muted" role="status">
                  コピーできませんでした。下の質問文を選んでコピーしてください。
                </p>
              )}
              <details open={copy === "failed"}>
                <summary>質問文を見る</summary>
                <p className="money-question">{question.body}</p>
              </details>
            </div>
          ) : (
            onAsk && (
              <div className="money-confirm-ask">
                <button
                  type="button"
                  className="secondary money-copy"
                  disabled={disabled}
                  onClick={() =>
                    onAsk(`『${top.name}』を確かめる質問文を作って`)
                  }
                >
                  質問文を作ってもらう
                </button>
                <p className="money-muted">
                  会話の入力欄に下書きを入れます。送るかどうかは自分で決められます。
                </p>
              </div>
            )
          )}
        </div>
      )}
      <OtherFactors confirm={confirm} />
      <details>
        <summary>読み方</summary>
        <Lines items={confirm.reading_guide} />
      </details>
    </section>
  );
}

export function MoneyDetails({
  money,
  text,
  question,
  onAsk,
  disabled,
}: {
  money: Money;
  text: string;
  question?: AskQuestion | null;
  onAsk?: (text: string) => void;
  disabled?: boolean;
}) {
  const calculations = inDisplayOrder(money.calculations);
  // 見通しが 2 つ以上あるときは、あとで計算したほうの順位を出す。
  const latest = calculations.findLast(
    (calculation) =>
      calculation.name === "simulate_cashflow" &&
      calculation.output.what_to_confirm !== undefined,
  );
  const notIncluded = [
    ...new Set(
      calculations.flatMap((calculation) =>
        calculation.name === "kougaku_gendo"
          ? calculation.output.not_included
          : [],
      ),
    ),
  ];
  const sources = moneySources(money, text);
  return (
    <div className="money">
      {latest?.name === "simulate_cashflow" && (
        <ConfirmBlock
          output={latest.output}
          question={question}
          onAsk={onAsk}
          disabled={disabled}
        />
      )}
      {calculations.map((calculation, index) => {
        switch (calculation.name) {
          case "simulate_cashflow":
            return <CashflowBlock key={index} output={calculation.output} />;
          case "kougaku_gendo":
            return <KougakuBlock key={index} output={calculation.output} />;
          case "meal_cost":
            return <MealBlock key={index} output={calculation.output} />;
          case "calc_date":
            return <DateBlock key={index} output={calculation.output} />;
        }
      })}
      {notIncluded.length > 0 && (
        <section className="money-block">
          <h4>この額に含まれない費用</h4>
          <Lines items={notIncluded} />
        </section>
      )}
      {sources.length > 0 && (
        <section className="money-block money-sources">
          <h4>出典と確認日</h4>
          <ul className="money-lines">
            {sources.map((source) => (
              <li key={source.url}>
                {/* 保存データから読むこともあるので、https だけをリンクにする。 */}
                {source.url.startsWith("https://") ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.name}
                  </a>
                ) : (
                  source.name
                )}
                （確認 {source.checked_on}）
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function WarningList({
  warnings,
}: {
  warnings?: readonly MoneyWarning[];
}) {
  if (!warnings?.length) return null;
  return (
    <div className="money-warnings">
      <span>確かめてほしいこと</span>
      <ul>
        {warnings.map((warning, index) => (
          <li key={index}>{warning.message}</li>
        ))}
      </ul>
    </div>
  );
}

// 返答の下に、この返答で呼んだ計算を出す。表の数字がプログラムの計算であることを、目で確かめられるように。
export function ToolTrace({ tools }: { tools?: readonly string[] }) {
  if (!tools?.length) return null;
  return (
    <p className="tool-trace">この返答で呼んだ計算: {toolTraceText(tools)}</p>
  );
}

// 進み具合は分からないので、経った秒数だけを出す。
export function WaitingNote() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <span>
      話してくれた内容から、使えるメモを整えています。
      <span aria-hidden="true" className="waiting-seconds">
        {seconds} 秒
      </span>
      {seconds >= HINT_AFTER_SECONDS && (
        <span className="waiting-hint">
          お金の計算が入ると、20〜30 秒かかることがあります。
        </span>
      )}
    </span>
  );
}
