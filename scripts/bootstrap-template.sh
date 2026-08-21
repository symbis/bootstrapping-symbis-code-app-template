#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

node_status() {
  if ! command -v node >/dev/null 2>&1; then printf 'missing'; return; fi
  if [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22' 2>/dev/null)" = "true" ]; then printf 'installed'; else printf 'upgradeRequired'; fi
}

node_supported() { [ "$(node_status)" = 'installed' ]; }

argument_present() {
  local expected="$1"
  shift
  for argument in "$@"; do [ "$argument" = "$expected" ] && return 0; done
  return 1
}

argument_value() {
  local expected="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$expected" ]; then shift; [ "$#" -gt 0 ] && printf '%s' "$1"; return; fi
    shift
  done
}

json_escape() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

command_status() { if command -v "$1" >/dev/null 2>&1; then printf 'installed'; else printf 'missing'; fi; }

gnu_make_status() {
  if command -v make >/dev/null 2>&1 && make --version 2>/dev/null | grep -q '^GNU Make '; then
    printf 'installed'
  elif command -v gmake >/dev/null 2>&1 && gmake --version 2>/dev/null | grep -q '^GNU Make '; then
    printf 'installed'
  else
    printf 'missing'
  fi
}

append_action() {
  local id="$1" system_change="${2:-false}" conditional="${3:-false}"
  ACTIONS+=("{\"id\":\"$id\",\"systemChange\":$system_change,\"conditional\":$conditional}")
  if [ "$system_change" = 'true' ]; then REQUIRES_APPROVAL=true; fi
}

print_plan_without_node() {
  local target mode auth git_state node_state make_state az_state brew_state needs_brew joined separator item
  target="$(argument_value --target "$@")"
  case "$target" in /*) ;; *) echo '--target must be an absolute path.' >&2; exit 1 ;; esac
  mode="$(argument_value --mode "$@")"; [ -n "$mode" ] || mode='auto'
  auth="$(argument_value --auth "$@")"; [ -n "$auth" ] || auth='auto'
  if [ "$mode" = 'auto' ]; then
    if [ ! -e "$target" ] || { [ -d "$target" ] && [ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; }; then
      mode='new'
    elif [ -f "$target/Makefile" ] && [ -f "$target/package.json" ]; then
      mode='existing'
    else
      echo "Target $target is not empty and is not a recognized template checkout" >&2
      exit 1
    fi
  fi
  git_state="$(command_status git)"; node_state="$(node_status)"; make_state="$(gnu_make_status)"; az_state="$(command_status az)"
  if command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ]; then brew_state='installed'; else brew_state='missing'; fi

  ACTIONS=(); REQUIRES_APPROVAL=false
  [ "$mode" = 'existing' ] && append_action preflight-existing-checkout
  needs_brew=false
  [ "$git_state" != 'installed' ] && needs_brew=true
  [ "$node_state" != 'installed' ] && needs_brew=true
  [ "$make_state" != 'installed' ] && needs_brew=true
  [ "$auth" = 'azure-cli' ] && [ "$az_state" != 'installed' ] && needs_brew=true
  [ "$needs_brew" = 'true' ] && [ "$brew_state" != 'installed' ] && append_action install-homebrew true
  [ "$git_state" != 'installed' ] && append_action install-git true
  [ "$node_state" != 'installed' ] && append_action install-node true
  [ "$make_state" != 'installed' ] && append_action install-gnu-make true
  [ "$auth" = 'azure-cli' ] && [ "$az_state" != 'installed' ] && append_action install-azure-cli true
  if [ "$mode" = 'new' ]; then
    append_action prove-repository-access; append_action clone-template; append_action verify-symlinks
    append_action inspect-safe-chain-choice; append_action run-make-install; append_action validate-install-drift
    append_action initialize-application-repository
    [ "$auth" = 'auto' ] && [ "$az_state" != 'installed' ] && append_action conditional-azure-cli-fallback false true
  else
    append_action repair-symlinks; append_action resolve-safe-chain-choice; append_action run-make-install
  fi

  joined=''; separator=''
  for item in "${ACTIONS[@]}"; do joined="$joined$separator$item"; separator=','; done
  printf '{"platform":"darwin","mode":"%s","target":"%s","auth":{"strategy":"%s","attempted":[],"selected":null,"repositoryReadAccess":null},"prerequisites":{"homebrew":"%s","git":"%s","node":"%s","gnuMake":"%s","azureCli":"%s"},"requiresSystemApproval":%s,"actions":[%s]}\n' \
    "$(json_escape "$mode")" "$(json_escape "$target")" "$(json_escape "$auth")" "$brew_state" "$git_state" "$node_state" "$make_state" "$az_state" "$REQUIRES_APPROVAL" "$joined"
}

target="$(argument_value --target "$@")"
[ -n "$target" ] || { echo '--target is required.' >&2; exit 1; }
case "$target" in /*) ;; *) echo '--target must be an absolute path.' >&2; exit 1 ;; esac

if node_supported; then exec node "$SCRIPT_DIR/bootstrap-template.mjs" "$@"; fi
if argument_present --plan "$@"; then print_plan_without_node "$@"; exit 0; fi
if ! argument_present --approve-system-changes "$@"; then
  echo 'Node.js 22+ is missing. Review --plan and approve the listed system changes before installing Node.' >&2
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
