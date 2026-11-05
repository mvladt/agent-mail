#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mail="$PWD/agent-mail"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export MAIL_ROOT="$root/mail with spaces" AGENT_NAME=sender

expect_status() {
  local expected="$1" actual=0
  shift
  "$@" > "$root/output" 2>&1 || actual=$?
  [ "$actual" -eq "$expected" ] || {
    cat "$root/output" >&2
    printf 'expected %s, got %s: %s\n' "$expected" "$actual" "$*" >&2
    exit 1
  }
}
expect_status 0 env -u MAIL_ROOT -u AGENT_NAME "$mail" --help
expect_status 2 env -u AGENT_NAME "$mail" check
expect_status 2 env AGENT_NAME=../escape "$mail" check
expect_status 2 env MAIL_ROOT=relative "$mail" check
expect_status 2 "$mail" send --to
expect_status 2 "$mail" send --to ../escape
expect_status 2 "$mail" done
expect_status 2 "$mail" done ../escape.md
expect_status 2 "$mail" wait --timeout -1
expect_status 2 "$mail" wait --timeout text
expect_status 2 "$mail" check extra
expect_status 2 "$mail" send --to receiver --body "$root/missing"
expect_status 2 "$mail" send --to receiver --subject $'bad\nheader' <<< body
[ -z "$(find "$MAIL_ROOT" -type f -print)" ]

printf 'Тело письма\n' > "$root/body"
"$mail" send --to receiver --subject "It's: YAML" --body "$root/body" > /dev/null
export AGENT_NAME=receiver
"$mail" check > "$root/first"
"$mail" check > "$root/second"
cmp "$root/first" "$root/second"
grep 'Тело письма' "$root/first" > /dev/null
grep "subject: 'It''s: YAML'" "$root/first" > /dev/null
set -- "$MAIL_ROOT/mailbox/receiver/"*.md
id="${1##*/}"
"$mail" done "$id" > /dev/null
[ -f "$MAIL_ROOT/mailbox/receiver/archive/$id" ]
"$mail" check | grep 'новых писем нет' > /dev/null
expect_status 1 "$mail" wait --timeout 0
expect_status 1 "$mail" wait --timeout 1

printf 'Ответ\n' | "$mail" send --to sender --reply-to "$id" > /dev/null
AGENT_NAME=sender "$mail" check | grep "reply-to: '$id'" > /dev/null

"$mail" wait --timeout 10 > "$root/wait" &
waiter=$!
sleep 1
printf 'Проснись\n' | AGENT_NAME=sender "$mail" send --to receiver > /dev/null
wait "$waiter"
grep 'Проснись' "$root/wait" > /dev/null
expect_status 0 "$mail" wait --timeout 0

pids=()
for n in {1..20}; do
  printf '%s\n' "$n" | "$mail" send --to parallel > /dev/null &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
set -- "$MAIL_ROOT/mailbox/parallel/"*.md
[ "$#" -eq 20 ]
[ -z "$(find "$MAIL_ROOT" -name '.msg-*' -print)" ]
"$mail" ls | grep '^receiver$' > /dev/null
printf 'OK: доставка, подтверждение, ответ, ожидание, параллельная отправка, ошибки\n'
