#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# FluidForm's data. It was .super-partner: moved here (with a link from the old name) the first
# time this version starts.
DATA_DIR="$PROJECT_DIR/.fluidform"
FORMER_DATA_DIR="$PROJECT_DIR/.super-partner"
RUNTIME_DIR="$DATA_DIR/runtime"
LOG_DIR="$DATA_DIR/logs"
API_PID_FILE="$RUNTIME_DIR/api.pid"
WEB_PID_FILE="$RUNTIME_DIR/web.pid"
API_URL="http://127.0.0.1:8000"
# The web console is a capability package FluidForm serves itself (server/packages/web), at the API.
WEB_URL="$API_URL/"
UNIT_HASH="$(printf '%s' "$PROJECT_DIR" | cksum | cut -d ' ' -f 1)"
UNIT_PREFIX="fluidform-$UNIT_HASH"
# What its services were called before the rename: stopped too, so the new ones get the port.
FORMER_UNIT_PREFIX="super-partner-$UNIT_HASH"
USE_SYSTEMD=0
if command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 \
  && systemctl --user show-environment >/dev/null 2>&1; then
  USE_SYSTEMD=1
fi

# A setting (FLUIDFORM_NAME, or the former SUPER_PARTNER_NAME) from the environment, else this
# machine's .env, else the default given.
setting() {
  local name="$1" fallback="$2" value="" prefix
  for prefix in FLUIDFORM_ SUPER_PARTNER_; do
    local key="$prefix$name"
    value="${!key:-}"
    if [[ -z "$value" && -f "$PROJECT_DIR/.env" ]]; then
      value="$(sed -n "s/^${key}=//p" "$PROJECT_DIR/.env" | tail -n 1)"
    fi
    [[ -n "$value" ]] && break
  done
  echo "${value:-$fallback}"
}

# Where tasks' folders are: set FLUIDFORM_WORKSPACE_ROOT in .env to keep them outside the
# platform's repository (CLI agents there would read its AGENTS.md and CLAUDE.md).
WORKSPACE_ROOT="$(setting WORKSPACE_ROOT "$PROJECT_DIR/workspaces")"

# The data folder under its former name, moved to the new one and linked from the old (records
# keep paths into it). Only once nothing runs from it.
move_data() {
  if [[ -d "$FORMER_DATA_DIR" && ! -L "$FORMER_DATA_DIR" && ! -e "$DATA_DIR" ]]; then
    echo "[setup] Moving $FORMER_DATA_DIR to $DATA_DIR (FluidForm's new name)..."
    mv "$FORMER_DATA_DIR" "$DATA_DIR"
    ln -s "$DATA_DIR" "$FORMER_DATA_DIR"
  fi
  mkdir -p "$RUNTIME_DIR" "$LOG_DIR"
}

# Services started under the former name, by a version before the rename.
stop_former() {
  local unit pid_file
  if [[ "$USE_SYSTEMD" -eq 1 ]]; then
    for unit in "$FORMER_UNIT_PREFIX-web.service" "$FORMER_UNIT_PREFIX-api.service"; do
      if [[ "$(systemctl --user show "$unit" --property=ActiveState --value 2>/dev/null || true)" =~ ^(active|activating|reloading)$ ]]; then
        echo "[stop] Stopping $unit (started before the rename)..."
        systemctl --user stop "$unit"
      fi
    done
  fi
  for pid_file in "$FORMER_DATA_DIR/runtime/web.pid" "$FORMER_DATA_DIR/runtime/api.pid"; do
    [[ -L "$FORMER_DATA_DIR" ]] && break
    if [[ -f "$pid_file" ]] && [[ "$(<"$pid_file")" =~ ^[0-9]+$ ]] && kill -0 "$(<"$pid_file")" 2>/dev/null; then
      kill "$(<"$pid_file")"
    fi
  done
}

unit_for() {
  if [[ "$1" == "$API_PID_FILE" ]]; then
    echo "$UNIT_PREFIX-api.service"
  else
    echo "$UNIT_PREFIX-web.service"
  fi
}

is_running() {
  local pid_file="$1"
  if [[ "$USE_SYSTEMD" -eq 1 ]]; then
    local unit state
    unit="$(unit_for "$pid_file")"
    state="$(systemctl --user show "$unit" --property=ActiveState --value 2>/dev/null || true)"
    if [[ "$state" == "active" || "$state" == "activating" || "$state" == "reloading" ]]; then
      systemctl --user show "$unit" --property=MainPID --value >"$pid_file"
      return 0
    fi
  fi
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(<"$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

launch_service() {
  local pid_file="$1" log_file="$2"
  shift 2
  if [[ "$USE_SYSTEMD" -eq 1 ]]; then
    local unit name
    local -a inherited=() unset_proxy=()
    unit="$(unit_for "$pid_file")"
    # Preserve configured channels and local tools without placing credential values in
    # command arguments. --setenv=NAME reads the value from systemd-run's environment.
    while IFS= read -r name; do
      case "$name" in
        PATH|LANG|LC_*|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|SSH_AUTH_SOCK|FLUIDFORM_*|SUPER_PARTNER_*|*_API_KEY|GITHUB_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|VCS_HOME|VERDI_HOME|SNPSLMD_LICENSE_FILE|LM_LICENSE_FILE|LD_LIBRARY_PATH)
          inherited+=("--setenv=$name") ;;
      esac
    done < <(compgen -e)
    # The desktop manager may retain lowercase proxy variables that are absent from
    # this shell. Do not let those override the caller's uppercase proxy settings.
    for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
      if [[ ! -v "$name" ]]; then unset_proxy+=("$name"); fi
    done
    if [[ "${#unset_proxy[@]}" -gt 0 ]]; then
      inherited+=("--property=UnsetEnvironment=${unset_proxy[*]}")
    fi
    systemd-run --user --quiet --collect --unit="$unit" \
      --property=Type=exec --property="WorkingDirectory=$PROJECT_DIR" \
      --property=Restart=on-failure --property=RestartSec=2 \
      --property="StandardOutput=append:$log_file" \
      --property="StandardError=append:$log_file" \
      "${inherited[@]}" -- "$@"
    systemctl --user show "$unit" --property=MainPID --value >"$pid_file"
  else
    # For hosts without a user service manager, at least detach the process's session.
    local -a detached=()
    if command -v setsid >/dev/null 2>&1; then detached=(setsid); fi
    (cd "$PROJECT_DIR"; exec nohup "${detached[@]}" "$@") >>"$log_file" 2>&1 </dev/null &
    echo "$!" >"$pid_file"
  fi
}

# The API runs on Node: server/, built to server/dist.
prepare() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( major < 22 )); then
    echo "[error] The server needs Node.js 22 or newer."
    exit 1
  fi
  if [[ ! -d "$PROJECT_DIR/server/node_modules" ]]; then
    echo "[setup] Installing server dependencies..."
    npm install --prefix "$PROJECT_DIR/server"
  fi
  echo "[setup] Building the server..."
  npm run --silent --prefix "$PROJECT_DIR/server" build
  if [[ ! -x "$PROJECT_DIR/frontend/node_modules/.bin/vite" ]]; then
    echo "[setup] Installing frontend dependencies..."
    npm install --prefix "$PROJECT_DIR/frontend"
  fi
  # The web console package's page; FluidForm installs it again when it changed.
  echo "[setup] Building the web console package..."
  npm run --silent --prefix "$PROJECT_DIR/frontend" package >/dev/null
}

start() {
  local api_started=0
  stop_former
  move_data
  prepare
  # A web console run on its own by an earlier version: FluidForm serves it now.
  stop_process "web console" "$WEB_PID_FILE"
  if ! is_running "$API_PID_FILE"; then
    echo "[start] Starting API..."
    local -a api=("$(command -v node)" --disable-warning=ExperimentalWarning "$PROJECT_DIR/server/dist/main.js" --host 127.0.0.1 --port 8000)
    launch_service "$API_PID_FILE" "$LOG_DIR/api.log" /usr/bin/env \
      FLUIDFORM_DATA_DIR="$DATA_DIR" \
      FLUIDFORM_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
      "${api[@]}"
    api_started=1
  fi

  local ready=0
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if ! is_running "$API_PID_FILE"; then
      break
    fi
    if curl --noproxy '*' --connect-timeout 1 --max-time 2 \
      --silent --fail "$API_URL/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.25
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "[error] Services did not become healthy. See $LOG_DIR"
    [[ "$api_started" -eq 1 ]] && stop_process "API" "$API_PID_FILE"
    exit 1
  fi
  echo
  echo "FluidForm is ready: $WEB_URL (the web console, a capability; or the command line: fluidform --help)"
  echo "API: $API_URL"
  echo "Logs: $LOG_DIR"
  echo "Stop: ./stop.sh"
}

stop_process() {
  local name="$1"
  local pid_file="$2"
  local unit
  unit="$(unit_for "$pid_file")"
  if [[ "$USE_SYSTEMD" -eq 1 ]] && [[ "$(systemctl --user show "$unit" --property=LoadState --value 2>/dev/null || true)" == "loaded" ]]; then
    echo "[stop] Stopping $name ($unit)..."
    systemctl --user stop "$unit"
  elif is_running "$pid_file"; then
    local pid
    pid="$(<"$pid_file")"
    echo "[stop] Stopping $name ($pid)..."
    kill "$pid"
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$pid_file"
}

stop() {
  stop_process "web console" "$WEB_PID_FILE"
  stop_process "API" "$API_PID_FILE"
  stop_former
  echo "FluidForm stopped."
}

status() {
  if is_running "$API_PID_FILE"; then echo "API: running ($( <"$API_PID_FILE"))"; else echo "API: stopped"; fi
  echo "Web console: $WEB_URL (served by the API, when its capability is enabled)"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "Usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
