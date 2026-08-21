#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

node_supported() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22' 2>/dev/null)" = "true" ]
}

argument_present() {
  local expected="$1"
  shift
  for argument in "$@"; do
    [ "$argument" = "$expected" ] && return 0
  done
  return 1
}

argument_value() {
  local expected="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$expected" ]; then
      shift
      [ "$#" -gt 0 ] && printf '%s' "$1"
      return
    fi
    shift
  done
}

json_escape() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

if node_supported; then
  exec node "$SCRIPT_DIR/bootstrap-template.mjs" "$@"
fi

if argument_present --plan "$@"; then
  target="$(argument_value --target "$@")"
  mode="$(argument_value --mode "$@")"
  [ -n "$mode" ] || mode="auto"
  printf '{"platform":"darwin","mode":"%s","target":"%s","requiresSystemApproval":true,"actions":[{"id":"install-homebrew"},{"id":"install-node"},{"id":"continue-bootstrap"}]}' \
    "$(json_escape "$mode")" "$(json_escape "$target")"
  printf '\n'
  exit 0
fi

if ! argument_present --approve-system-changes "$@"; then
  echo 'Node.js 22+ is missing. Review --plan and approve system changes before bootstrapping Node.' >&2
  exit 1
fi

if command -v brew >/dev/null 2>&1; then
  BREW_COMMAND="$(command -v brew)"
elif [ -x /opt/homebrew/bin/brew ]; then
  BREW_COMMAND=/opt/homebrew/bin/brew
elif [ -x /usr/local/bin/brew ]; then
  BREW_COMMAND=/usr/local/bin/brew
else
  BOOTSTRAP_TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf -- "$BOOTSTRAP_TEMP_DIR"' EXIT
  curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$BOOTSTRAP_TEMP_DIR/install-homebrew.sh"
  /bin/bash "$BOOTSTRAP_TEMP_DIR/install-homebrew.sh"
  if [ -x /opt/homebrew/bin/brew ]; then BREW_COMMAND=/opt/homebrew/bin/brew; else BREW_COMMAND=/usr/local/bin/brew; fi
fi

"$BREW_COMMAND" install node@22
export PATH="$("$BREW_COMMAND" --prefix node@22)/bin:$PATH"
node_supported || { echo 'Node.js 22+ is not available after Homebrew installation.' >&2; exit 1; }
exec node "$SCRIPT_DIR/bootstrap-template.mjs" "$@"
