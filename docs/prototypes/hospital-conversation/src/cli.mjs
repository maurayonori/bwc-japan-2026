import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayInJapan } from './dates.mjs';
import { buildSystem } from './prompt.mjs';
import { TOOLS, executeTool } from './tools.mjs';

// 計算の道具と、Claude に渡す指示を、API を呼ばずに確かめるための入口。
// 計算だけを見直したいとき、ほかのアプリから同じ計算を使いたいときに使う。

const USAGE = `使い方:
  node src/cli.mjs tool                          使える道具の名前と説明を出す
  node src/cli.mjs tool <道具の名前> '<JSON>'    道具を 1 回実行して、結果を JSON で出す（API は呼ばない）
  node src/cli.mjs prompt                        Claude に渡す指示（システムプロンプト）を出す`;

const firstSentence = (text) => `${text.split('。')[0]}。`;

function runTool([name, json], io) {
  if (name === undefined) {
    for (const tool of TOOLS) io.out(`${tool.name}\n  ${firstSentence(tool.description)}`);
    return 0;
  }
  if (json === undefined) {
    io.err(USAGE);
    return 1;
  }
  let input;
  try {
    input = JSON.parse(json);
  } catch {
    io.err('入力を JSON として読めませんでした。');
    return 1;
  }
  const result = executeTool(name, input);
  if (!result.ok) {
    io.err(result.error);
    return 1;
  }
  io.out(JSON.stringify(result.output, null, 2));
  return 0;
}

// 終了コード（0: 成功、1: 失敗）を返す。出力先と今日の日付は、呼び出し側が渡す。
export function runCli(args, io) {
  const [command, ...rest] = args;
  if (command === 'tool') return runTool(rest, io);
  if (command === 'prompt') {
    io.out(buildSystem(io.today()).map((block) => block.text).join('\n\n'));
    return 0;
  }
  io.err(USAGE);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    today: todayInJapan,
  });
}
