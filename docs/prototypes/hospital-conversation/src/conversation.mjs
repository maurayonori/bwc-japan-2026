// 利用者の 1 回の発言に対して、Claude の返答が出るまでの往復（道具の実行を含む）を進める。
//
// 履歴は後ろに足すだけにする。Claude Opus 5.5 / Sonnet 5.5 の思考ブロックは、
// それより前の system・tools・messages が 1 文字でも変わると無効になるので、
// 応答の content は思考ブロックごと、そのままの形で履歴に入れる。
// うまく終わらなかった往復（拒否、道具の呼び出しの途中での打ち切り、文章なし）は、
// 履歴に入れずに元のまま返す。途中の形を残すと、次のリクエストが通らなくなるため。

const DEFAULT_MAX_ITERATIONS = 8;
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
// 返答が最後まで書かれたとみなす stop_reason。これ以外（max_tokens など）は、途中で切れたものとして扱う。
const COMPLETED_STOP_REASONS = ['end_turn', 'stop_sequence', 'tool_use'];

const NOTICE_TEXT = {
  refused: 'この内容には返答できませんでした。言い方を変えて、もう一度送ってください。',
  truncated: '返答が長くなり、途中で切れました。続きが要るときは「続けて」と送ってください。',
  truncated_tool: '計算の途中で応答が切れました。もう一度送ってください。',
  empty: '返答が空でした。もう一度送ってください。',
  iteration_limit: '計算の往復が上限に達したので、いったん止めました。条件を絞って、もう一度送ってください。',
  tool_crash: '計算の途中で想定外のエラーが起きました。この返答の数字は、計算結果の表と照らして確かめてください。',
  history_mismatch: '会話の履歴が途中で変わったと API が判定しました。この試作の不具合の可能性があります。',
};

const notice = (kind, text = NOTICE_TEXT[kind]) => ({ kind, text });

function addUsage(total, usage = {}) {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, total[key] + (usage[key] ?? 0)]));
}

function textOf(content) {
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n').trim();
}

// 応答に付いてくる、利用者に知らせたほうがよい出来事。
function noticesFrom(response) {
  const servedByFallback = (response.usage?.iterations ?? []).some((entry) => entry.type === 'fallback_message');
  const historyChanged = (response.input_transformations ?? [])
    .some((entry) => entry.type === 'thinking_dropped' && entry.reason === 'prefix_binding_mismatch');
  return [
    ...(servedByFallback && response.stop_reason !== 'refusal'
      ? [notice('fallback', `この返答は、代わりのモデル（${response.model}）が作りました。`)]
      : []),
    ...(historyChanged ? [notice('history_mismatch')] : []),
  ];
}

// 道具を 1 つ実行し、画面用の記録と、Claude へ返す tool_result を作る。
function runTool(block, executeTool) {
  try {
    const result = executeTool(block.name, block.input);
    return {
      event: { id: block.id, name: block.name, input: block.input, ...result },
      resultBlock: result.ok
        ? { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result.output) }
        : { type: 'tool_result', tool_use_id: block.id, content: result.error, is_error: true },
      crash: null,
    };
  } catch (error) {
    const message = '計算の途中で想定外のエラーが起きました。この道具は、いま使えません。';
    return {
      event: { id: block.id, name: block.name, input: block.input, ok: false, error: message },
      resultBlock: { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true },
      crash: error,
    };
  }
}

export async function runTurn({
  createMessage, request, history, userText, executeTool, maxIterations = DEFAULT_MAX_ITERATIONS,
}) {
  let messages = [...history, { role: 'user', content: userText }];
  let usage = Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
  let toolEvents = [];
  let notices = [];
  let errors = [];

  const finish = (outcome, reply, keptHistory, extraNotices = []) => ({
    outcome, reply, history: keptHistory, toolEvents, notices: [...notices, ...extraNotices], errors, usage,
  });

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await createMessage({ ...request, messages });
    usage = addUsage(usage, response.usage);
    notices = [...notices, ...noticesFrom(response)];

    // 拒否は、content を読む前・道具を動かす前に見分ける。
    if (response.stop_reason === 'refusal') {
      return finish('refused', null, history, [notice('refused')]);
    }

    const toolUses = response.content.filter((block) => block.type === 'tool_use');

    if (response.stop_reason === 'tool_use' && toolUses.length > 0) {
      const runs = toolUses.map((block) => runTool(block, executeTool));
      toolEvents = [...toolEvents, ...runs.map((run) => run.event)];
      const crashes = runs.filter((run) => run.crash !== null).map((run) => run.crash);
      if (crashes.length > 0) {
        errors = [...errors, ...crashes];
        notices = [...notices, notice('tool_crash')];
      }
      // 道具の結果は、すべて 1 つの user メッセージにまとめて返す。
      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: runs.map((run) => run.resultBlock) },
      ];
      continue;
    }

    if (response.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: response.content }];
      continue;
    }

    const reply = textOf(response.content);
    const completed = COMPLETED_STOP_REASONS.includes(response.stop_reason);

    // ここまで来て道具の呼び出しが残っているのは、途中で切れた応答。実行せず、履歴にも入れない。
    if (toolUses.length > 0) {
      return finish('truncated', null, history, [notice('truncated', NOTICE_TEXT.truncated_tool)]);
    }
    if (reply === '') {
      return finish(completed ? 'empty' : 'truncated', null, history, [notice(completed ? 'empty' : 'truncated', NOTICE_TEXT.empty)]);
    }

    const kept = [...messages, { role: 'assistant', content: response.content }];
    return completed
      ? finish('answered', reply, kept)
      : finish('truncated', reply, kept, [notice('truncated')]);
  }

  return finish('iteration_limit', null, messages, [notice('iteration_limit')]);
}
