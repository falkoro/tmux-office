#!/usr/bin/env bash
# Demo office for UI work and screenshots: a private tmux server and a throwaway HOME
# shaped like emperor's live sessions. It never touches the default tmux server or ~/.claude*.
# Rooms follow PIXEL_AGENTS_OFFICE_ROOMS (default emperor=emperor-*; set it empty for one room per session)
# and pins follow PIXEL_AGENTS_OFFICE_PINNED (default emperor-8).
#
#   scripts/office-demo-rig.sh start [name] [port]   prints the office URL
#   scripts/office-demo-rig.sh stop  [name]
set -euo pipefail

cmd="${1:-}"
name="${2:-demo}"
port="${3:-3199}"
sock="pa-demo-${name}"
dir="${TMPDIR:-/tmp}/pa-demo-${name}"
root="${PA_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# session|window name|config dir|state|cols|rows
agents=(
  "emperor-1|api-refactor-e9|.claude-work|working|237|58"
  "emperor-1|release-notes-1d|.claude-work|done|237|58"
  "emperor-2|triage-c9|.claude-side|permission|237|58"
  "emperor-3|checkout-flow-5c|.claude-client|working|237|58"
  "emperor-5|design-review-13|.claude-ops|asking|237|58"
  "emperor-6|bug-hunt-3b|.claude|subagent|237|58"
  "emperor-6|reddit-fetch-88|.claude|done|80|24"
  "emperor-7|temple-trim-7a|.claude|working|80|24"
  "emperor-8|on-call-b4|.claude|working|80|24"
  "ops|deploy-watch-21|.claude|working|80|24"
  "scratch|try-vite-02|.claude|done|80|24"
  "-|nightly-digest|.claude|working|0|0"
  "emperor-4|reviewer-api-3f|.claude-client|working|237|58"
  "emperor-4|reviewer-web-8a|.claude-client|done|237|58"
  "emperor-4|docs-sweep-41|.claude|working|80|24"
  "emperor-4|ci-babysit-d2|.claude|permission|80|24"
  "emperor-4|ux-notes-77|.claude|asking|80|24"
)
tools=(Read Grep Edit Bash Glob Write WebFetch)
targets=(server/src/httpServer.ts useExtensionMessages webview-ui/src/App.tsx "npm test" "**/*.tsx" docs/notes.md https://example.com)

stop_rig() {
  for f in "$dir"/server.pid "$dir"/animate.pid "$dir"/panes/*.headless.pid; do
    [[ -f "$f" ]] && kill "$(cat "$f")" 2>/dev/null || true
  done
  tmux -L "$sock" kill-server 2>/dev/null || true
  rm -rf "$dir"
}

now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

line() {
  printf '%s\n' "$2" >> "$1"
}

tool_use() {
  local file="$1" sid="$2" id="$3" tool="$4" input="$5"
  line "$file" "{\"type\":\"assistant\",\"sessionId\":\"$sid\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$id\",\"name\":\"$tool\",\"input\":$input}]}}"
}

tool_result() {
  line "$1" "{\"type\":\"user\",\"sessionId\":\"$2\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$3\",\"content\":\"ok\"}]}}"
}

input_for() {
  case "$1" in
    Bash) printf '{"command":"%s"}' "$2" ;;
    Grep | Glob) printf '{"pattern":"%s"}' "$2" ;;
    WebFetch) printf '{"url":"%s"}' "$2" ;;
    *) printf '{"file_path":"%s"}' "$2" ;;
  esac
}

start_rig() {
  stop_rig
  mkdir -p "$dir/home" "$dir/panes"
  [[ -f "$root/dist/cli.js" ]] || { echo "build first: npm run build" >&2; exit 1; }

  local i=0 spec session window cfg state cols rows sid cwd proj file pid loc
  for spec in "${agents[@]}"; do
    IFS='|' read -r session window cfg state cols rows <<< "$spec"
    sid="$(printf '%08d-0000-4000-8000-%012d' "$i" "$i")"
    cwd="$dir/repos/$window"
    mkdir -p "$cwd" "$dir/home/$cfg/sessions"
    proj="$dir/home/$cfg/projects/$(sed 's/[^a-zA-Z0-9-]/-/g' <<< "$cwd")"
    mkdir -p "$proj"
    file="$proj/$sid.jsonl"
    printf '%s\n' "$file" > "$dir/panes/$i.transcript"
    printf '%s\n' "$sid" > "$dir/panes/$i.sid"
    printf '%s\n' "$state" > "$dir/panes/$i.state"
    printf '\033[1;38;5;208m✻ Claude Code\033[0m  %s\n\n> %s\n\n' "$window" "keep going on the $window task" > "$dir/panes/$i.log"

    line "$file" "{\"type\":\"user\",\"sessionId\":\"$sid\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"user\",\"content\":\"keep going on the $window task\"}}"

    if [[ "$session" == "-" ]]; then
      sleep infinity > /dev/null 2>&1 &
      pid=$!
      echo "{\"pid\":$pid,\"sessionId\":\"$sid\",\"cwd\":\"$cwd\",\"status\":\"busy\",\"name\":\"$window\"}" > "$dir/home/$cfg/sessions/$pid.json"
      echo "$pid" > "$dir/panes/$i.headless.pid"
    else
      local run="exec tail -n 200 -f '$dir/panes/$i.log'"
      if tmux -L "$sock" has-session -t "=$session" 2>/dev/null; then
        tmux -L "$sock" new-window -d -t "$session" -n "$window" -c "$cwd" "$run"
      else
        tmux -L "$sock" new-session -d -s "$session" -n "$window" -x "$cols" -y "$rows" -c "$cwd" "$run"
      fi
      read -r loc pid <<< "$(tmux -L "$sock" display-message -p -t "=$session:$window" '#{session_name}:#{window_id}.#{pane_id} #{pane_pid}')"
      local status=busy
      [[ "$state" == done ]] && status=idle
      echo "{\"pid\":$pid,\"sessionId\":\"$sid\",\"cwd\":\"$cwd\",\"tmux\":\"$loc\",\"status\":\"$status\",\"name\":\"$window\"}" > "$dir/home/$cfg/sessions/$pid.json"
    fi
    i=$((i + 1))
  done

  (HOME="$dir/home" PIXEL_AGENTS_TMUX_SOCKET="$sock" \
    PIXEL_AGENTS_OFFICE_ROOMS="${PIXEL_AGENTS_OFFICE_ROOMS-emperor=emperor-*}" \
    PIXEL_AGENTS_OFFICE_PINNED="${PIXEL_AGENTS_OFFICE_PINNED-emperor-8}" nohup node "$root/dist/cli.js" \
    --port "$port" --host 127.0.0.1 --watch-all --live-only --insecure-local-terminal > "$dir/server.log" 2>&1 &
    echo $! > "$dir/server.pid")
  for _ in $(seq 1 40); do
    grep -q "http://127.0.0.1:$port/?token=" "$dir/server.log" 2>/dev/null && break
    sleep 0.25
  done
  sleep 6
  seed_states
  animate > /dev/null 2>&1 &
  echo $! > "$dir/animate.pid"
  grep -o "http://127.0.0.1:$port/?token=[^ ]*" "$dir/server.log" | head -1
}

# Adopted sessions start reading at end of file, so state lines must land after adoption.
seed_states() {
  local i state file sid
  for ((i = 0; i < ${#agents[@]}; i++)); do
    state="$(cat "$dir/panes/$i.state")"
    file="$(cat "$dir/panes/$i.transcript")"
    sid="$(cat "$dir/panes/$i.sid")"
    case "$state" in
      working) tool_use "$file" "$sid" "toolu_${i}_0" Read '{"file_path":"README.md"}' ;;
      permission) tool_use "$file" "$sid" "toolu_${i}_0" Bash '{"command":"git push --force-with-lease"}' ;;
      asking) tool_use "$file" "$sid" "toolu_${i}_0" AskUserQuestion '{"questions":[{"question":"Ship it?"}]}' ;;
      subagent) tool_use "$file" "$sid" "toolu_${i}_0" Agent '{"description":"Audit the tunnel config","subagent_type":"general-purpose","prompt":"audit"}' ;;
      done)
        line "$file" "{\"type\":\"assistant\",\"sessionId\":\"$sid\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Done.\"}]}}"
        line "$file" "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"sessionId\":\"$sid\",\"timestamp\":\"$(now)\",\"durationMs\":42000}"
        ;;
    esac
  done
}

# Keeps the "working" agents busy so the office shows live tool changes.
animate() {
  local step=1 i file sid tool target
  while sleep 2.5; do
    for ((i = 0; i < ${#agents[@]}; i++)); do
      [[ "$(cat "$dir/panes/$i.state" 2>/dev/null)" == working ]] || continue
      file="$(cat "$dir/panes/$i.transcript")"
      sid="$(cat "$dir/panes/$i.sid")"
      tool_result "$file" "$sid" "toolu_${i}_$((step - 1))"
      local k=$(((step + i) % ${#tools[@]}))
      tool="${tools[$k]}"
      target="${targets[$k]}"
      [[ "$tool" == WebFetch && $i -ne 9 ]] && { tool=Read; target=CHANGELOG.md; }
      tool_use "$file" "$sid" "toolu_${i}_$step" "$tool" "$(input_for "$tool" "$target")"
      printf '\033[32m●\033[0m %s(%s)\n  ⎿ ok\n' "$tool" "$target" >> "$dir/panes/$i.log"
    done
    step=$((step + 1))
  done
}

case "$cmd" in
  start) start_rig ;;
  stop) stop_rig ;;
  *) echo "usage: $0 start|stop [name] [port]" >&2; exit 2 ;;
esac
