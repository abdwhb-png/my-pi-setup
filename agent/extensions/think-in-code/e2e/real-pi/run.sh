#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_root="$(cd "$script_dir/../../../.." && pwd)"
pi_root="$(dirname "$agent_root")"
output_dir="${1:-}"

if [[ -z "$output_dir" ]]; then
    echo "usage: $0 <evidence-output-directory>" >&2
    exit 2
fi

mkdir -p "$output_dir" "$pi_root/.smoke"
output_dir="$(cd "$output_dir" && pwd)"
fixture_root="$(mktemp -d "$pi_root/.smoke/think-real-pi-XXXXXX")"
project="$fixture_root/project"
sessions="$fixture_root/sessions"
bash_sessions="$fixture_root/bash-sessions"
trace="$output_dir/provider-trace.jsonl"
pi_command="$pi_root/bin/pi"
real_pi_bun="$script_dir/real-pi-bun.ts"
store_root=""

cleanup() {
    if [[ -n "$store_root" && "$store_root" == "$HOME/.pi/agent/think-in-code/projects/"* ]]; then
        rm -rf -- "$store_root"
    fi
    if [[ "$fixture_root" == "$pi_root/.smoke/think-real-pi-"* ]]; then
        rm -rf -- "$fixture_root"
    fi
    rmdir "$pi_root/.smoke" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$project/.pi/extensions" "$sessions" "$bash_sessions"
ln -s "$agent_root/node_modules" "$project/node_modules"
cp "$script_dir/provider.ts" "$project/.pi/extensions/smoke-provider.ts"
printf 'FILE SMOKE PAYLOAD\n' >"$project/fixture.txt"
printf '%s\n' '{' \
    '  "sandbox": {' \
    '    "enabled": true,' \
    '    "network": { "allowedDomains": [], "deniedDomains": [] }' \
    '  },' \
    '  "safeBash": {' \
    '    "mode": "coexist",' \
    '    "telemetry": { "enabled": false }' \
    '  }' \
    '}' >"$project/.pi/settings.json"

canonical_project="$(cd "$project" && pwd -P)"
store_segment="$(printf '%s' "$canonical_project" | sha256sum | cut -d ' ' -f 1)"
if [[ ! "$store_segment" =~ ^[a-f0-9]{64}$ ]]; then
    echo "invalid project store hash" >&2
    exit 1
fi
store_root="$HOME/.pi/agent/think-in-code/projects/$store_segment"

common=(
    --provider think-smoke
    --model smoke
    --tools @think
    --dangerously-skip-permissions
    --verbose
    --approve
    --offline
)

bash_common=(
    --provider think-smoke
    --model smoke
    --tools bash,safe_bash
    --dangerously-skip-permissions
    --verbose
    --approve
    --offline
)

(
    cd "$project"
    PI_REAL_BIN="$real_pi_bun" \
        THINK_SMOKE_PHASE=functional THINK_SMOKE_TRACE="$trace" \
        "$pi_command" --mode json --print --session-dir "$sessions" \
        "${common[@]}" "Run the deterministic Think-in-Code acceptance smoke." \
        >"$output_dir/functional-events.jsonl" \
        2>"$output_dir/functional-stderr.log"
)

(
    cd "$project"
    PI_REAL_BIN="$real_pi_bun" \
        THINK_SMOKE_PHASE=bash-architecture THINK_SMOKE_TRACE="$trace" \
        "$pi_command" --mode json --print --session-dir "$bash_sessions" \
        "${bash_common[@]}" "Run the Bash Execution architecture smoke." \
        >"$output_dir/bash-events.jsonl" \
        2>"$output_dir/bash-stderr.log"
)

if ! jq -e '
    select(.phase == "bash-architecture" and .label == "bash-complete")
    | (.tools | sort) == ["bash", "safe_bash"]
      and ([.toolResults[] | select(.toolName == "bash" or .toolName == "safe_bash")] | length) == 2
      and all(.toolResults[]; .isError != true)
' "$trace" >/dev/null; then
    echo "Bash Execution architecture smoke did not complete through both tools" >&2
    exit 1
fi

if ! jq -e '
    select(.phase == "functional" and .label == "after-execute")
    | .toolResults[-1]
    | .toolName == "think_execute"
      and .isError != true
      and ((.contentText | split("\n")[0] | fromjson) as $header
        | $header.status == "success"
          and $header.action == "content"
          and $header.sourceStatus == "succeeded"
          and ($header.archiveIds | length) == 2)
      and (.contentText | split("\n")[1] == "3")
' "$trace" >/dev/null; then
    echo "Think success contract was not visible from content" >&2
    exit 1
fi

if ! jq -e '
    select(.phase == "functional" and .label == "after-partial")
    | .toolResults[-1]
    | .toolName == "think_execute"
      and .isError != true
      and ((.contentText | split("\n")[0] | fromjson) as $header
        | $header.status == "partial"
          and $header.action == "command"
          and $header.sourceStatus == "failed"
          and ($header.sourceBytes > 0)
          and ($header.resultBytes > 0))
      and (.contentText | contains("partial-source") | not)
' "$trace" >/dev/null; then
    echo "Think partial contract was not visible from content" >&2
    exit 1
fi

if ! jq -s -e '
    [.[]
      | select(.phase == "functional" and (.label == "after-file" or .label == "after-batch"))
      | {label, result: .toolResults[-1]}]
    | length == 2
      and all(.[].result; .isError != true and (.contentText | split("\n")[1] == "3"))
      and all(.[].result; (.contentText | contains("FILE SMOKE PAYLOAD") | not))
      and all(.[].result; (.contentText | contains("\nred") | not))
' "$trace" >/dev/null; then
    echo "Think file/batch derivations exposed raw source content" >&2
    exit 1
fi

if ! jq -e '
    select(.phase == "functional" and .label == "after-reanalysis")
    | .toolResults[-1]
    | .isError != true
      and ((.contentText | split("\n")[0] | fromjson) as $header
        | $header.status == "success"
          and $header.action == "archives"
          and ($header.archiveIds | length) == 2)
' "$trace" >/dev/null; then
    echo "Think archive ids were not reusable from content" >&2
    exit 1
fi

if ! jq -e '
    select(.phase == "functional" and .label == "functional-end")
    | .toolResults[-1]
    | .toolName == "think_execute"
      and .isError == true
      and ((.contentText | split("\n")[0] | fromjson) as $error
        | $error.status == "error"
          and $error.action == "content"
          and $error.stage == "analysis"
          and ($error.code | type) == "string"
          and ($error.reason | type) == "string"
          and (["restore_sandbox", "change_command", "change_program", "change_source", "repair_store", "retry"] | index($error.recovery)) != null)
      and (.contentText | contains("network must stay sealed") | not)
      and (.contentText | contains("example.com") | not)
' "$trace" >/dev/null; then
    echo "Think terminal error contract was not visible from content" >&2
    exit 1
fi

session="$(find "$sessions" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
if [[ -z "$session" ]]; then
    echo "Pi did not create a JSONL session" >&2
    exit 1
fi

(
    cd "$project"
    PI_REAL_BIN="$real_pi_bun" \
        THINK_SMOKE_PHASE=compact THINK_SMOKE_TRACE="$trace" \
        bun "$script_dir/rpc-driver.ts" "$real_pi_bun" "$session" \
        "$sessions" "$output_dir/compact-rpc.jsonl"
)

(
    cd "$project"
    PI_REAL_BIN="$real_pi_bun" \
        THINK_SMOKE_PHASE=reload THINK_SMOKE_TRACE="$trace" \
        "$pi_command" --mode json --print --session "$session" \
        --session-dir "$sessions" "${common[@]}" "prompt after reload" \
        >"$output_dir/reload-events.jsonl" \
        2>"$output_dir/reload-stderr.log"
)

(
    cd "$project"
    PI_REAL_BIN="$real_pi_bun" \
        THINK_SMOKE_PHASE=navigation THINK_SMOKE_TRACE="$trace" \
        "$pi_command" --mode json --print --fork "$session" \
        --session-dir "$sessions" "${common[@]}" "prompt after fork navigation" \
        >"$output_dir/navigation-events.jsonl" \
        2>"$output_dir/navigation-stderr.log"
)

cp "$session" "$output_dir/session.jsonl"
echo "Evidence written to $output_dir"
