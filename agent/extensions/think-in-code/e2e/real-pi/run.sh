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

mkdir -p "$project/.pi/extensions" "$sessions"
ln -s "$agent_root/node_modules" "$project/node_modules"
cp "$script_dir/provider.ts" "$project/.pi/extensions/smoke-provider.ts"
printf 'FILE SMOKE PAYLOAD\n' >"$project/fixture.txt"
printf '%s\n' '{' \
    '  "sandbox": {' \
    '    "enabled": true,' \
    '    "network": { "allowedDomains": [], "deniedDomains": [] }' \
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

(
    cd "$project"
    PI_REAL_BIN="$real_pi_bun" \
        THINK_SMOKE_PHASE=functional THINK_SMOKE_TRACE="$trace" \
        "$pi_command" --mode json --print --session-dir "$sessions" \
        "${common[@]}" "Run the deterministic Think-in-Code acceptance smoke." \
        >"$output_dir/functional-events.jsonl" \
        2>"$output_dir/functional-stderr.log"
)

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
