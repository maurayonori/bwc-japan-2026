#!/bin/bash
# PreToolUse(Bash) フック: git push の前に check-public を走らせ、落ちたら止める（exit 2）。
# 入力は標準入力の JSON（tool_input.command）。git push 以外は何もしない。
input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

# 先頭または ; && || | ( の直後にある git push（git -C dir push 等のオプション付きも含む）
if ! printf '%s' "$command" | grep -Eq '(^|[;&|(]|&&|\|\|)[[:space:]]*git([[:space:]]+(-C|-c)[[:space:]]+[^[:space:]]+|[[:space:]]+--[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)'; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-${cwd:-.}}"
out=$(node "$root/scripts/check-public.mjs" --root="${cwd:-$root}" 2>&1)
status=$?
if [ $status -ne 0 ]; then
  {
    echo "git push を止めました。公開前の検査 (scripts/check-public.mjs) が失敗しています。"
    echo "$out"
  } >&2
  exit 2
fi
exit 0
