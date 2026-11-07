#!/bin/bash
# PreToolUse(*) フック: rules-auditor サブエージェントの道具の呼び出しだけを検査する。
# サブエージェントの呼び出しでは、入力の JSON の最上位に agent_type が入る。それ以外（本体の会話など）は何もしない。
# 検査の中身は rules-auditor-guard.mjs。検査できなかったとき（node が無い・ファイルが無いなど）も止める（exit 2）。
#
# サブエージェントのフロントマターの hooks を使わないのは、プロジェクトのフォルダーを信頼するまで
# Claude Code がそれを実行しないため（サブエージェントは制限なしで動いてしまう）。設定ファイルのフックはこの条件を受けない。
input=$(cat)

# 速く素通しするための絞り込み。エスケープされた文字列の中（\"agent_type\"）には当たらない
if ! printf '%s' "$input" | grep -Eq '"agent_type"[[:space:]]*:[[:space:]]*"rules-auditor"'; then
  exit 0
fi

cwd=$(printf '%s' "$input" | sed -nE 's/.*"cwd"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p')
root="${CLAUDE_PROJECT_DIR:-${cwd:-.}}"
printf '%s' "$input" | node "$root/.claude/hooks/rules-auditor-guard.mjs"
status=$?
if [ $status -eq 0 ]; then
  exit 0
fi
if [ $status -ne 2 ]; then
  echo "rules-auditor の道具の制限を検査できなかったので止めました（rules-auditor-guard.mjs の終了コード ${status}）。" >&2
fi
exit 2
