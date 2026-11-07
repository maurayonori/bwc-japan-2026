#!/bin/bash
# PostToolUse(Edit|Write) フック: lib/money/rules.ts を書き換えたあと、値が変わったのに
# 出典の確認日 (checked_on) が今日でなければ止める（exit 2。stderr が Claude に返る）。
# 入力は標準入力の JSON（tool_input.file_path）。rules.ts 以外のファイルは何もしない。
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

case "$file" in
  */lib/money/rules.ts) repo="${file%/lib/money/rules.ts}" ;;
  lib/money/rules.ts | ./lib/money/rules.ts) repo="${cwd:-.}" ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-${cwd:-.}}"
out=$(node "$root/scripts/check-rules-freshness.mjs" --root="$repo" 2>&1)
status=$?
if [ $status -eq 2 ]; then
  {
    echo "制度表の確認日の検査 (scripts/check-rules-freshness.mjs) に通りませんでした。"
    echo "$out"
  } >&2
  exit 2
fi
if [ $status -ne 0 ]; then
  # git が使えないなどで調べられないときは、編集を止めずに知らせるだけにする
  echo "$out" >&2
  exit 1
fi
exit 0
