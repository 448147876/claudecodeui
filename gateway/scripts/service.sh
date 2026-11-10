#!/usr/bin/env bash
# cloudcli-multi 服务管理：后台启动、停止、重启、状态、日志、更新。运维说明见 mydocs/08-运维部署维护.md。
# 全局命令 ~/.local/bin/cloudcli-multi 是指向本文件的软链接；源码目录由软链接解析得到，改源码后 update 即可生效。
#
#   cloudcli-multi start | stop [--force] | restart | status | logs [-f] [行数] | update [--check] | run
#   cloudcli-multi check [参数]       隔离检查；服务运行中会先暂停、检查完自动恢复
#   cloudcli-multi backups | restore <备份名> | help      其余命令原样交给 gateway/bin.mjs
#   start 同时拉起保活进程：网关退出或持续无响应时自动重启；stop 先停保活再停网关
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
SELF="$APP_ROOT/gateway/scripts/service.sh"
ENV_FILE="${CLOUDCLI_MULTI_ENV:-$HOME/.config/cloudcli-multi/env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

# 固定使用 Node 22（node_modules 中的原生模块按 Node 22 编译），不依赖系统 node 版本
NODE_BIN="${CLOUDCLI_MULTI_NODE:-$HOME/.local/share/cloudcli-multi/node/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
export PATH="$(dirname "$NODE_BIN"):$PATH"

DATA="${CLOUDCLI_MULTI_HOME:-$HOME/.cloudcli-multi}"; DATA="${DATA/#\~/$HOME}"
PORT="${CLOUDCLI_MULTI_PORT:-3001}"
LOCK="$DATA/run/gateway.lock"
SUP_PID="$DATA/run/supervisor.pid"
LOG="$DATA/gateway.log"
BIN=("$NODE_BIN" "$APP_ROOT/gateway/bin.mjs")

# pid 文件里的进程号在重启后可能被复用（甚至是别的进程里的线程，kill -0 也会成功），
# 所以除了存活还要核对命令行；ps -p 只认进程号，不认线程号。
owned_pid() { local p; [ -f "$1" ] && p="$(cat "$1" 2>/dev/null)" && [ -n "$p" ] && ps -p "$p" -o args= 2>/dev/null | grep -qF -- "$2" && echo "$p"; }
pid() { owned_pid "$LOCK" "gateway/bin.mjs"; }
sup_pid() { owned_pid "$SUP_PID" "service.sh supervise"; }
healthy() { curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT/__gw/login" 2>/dev/null | grep -qE '^(200|302)$'; }   # 未建管理员时 login 会 302 到 setup

launch() {
  # 日志超过 10 MB 时轮转一份
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 10485760 ]; then mv -f "$LOG" "$LOG.1"; fi
  echo "[service] $(date -Is) start ($("$NODE_BIN" -v), $APP_ROOT)" >> "$LOG"
  (exec 9>&-; cd "$APP_ROOT" && nohup setsid "${BIN[@]}" start >> "$LOG" 2>&1 < /dev/null &)
}

wait_healthy() {
  for _ in $(seq 1 "${1:-60}"); do healthy && return 0; (( ${stopping:-0} )) && return 1; sleep 0.5; done
  return 1
}

# 保活循环：每 10 秒检查一次。网关进程不在就重新拉起（连续快速失败时退避，最长 5 分钟）；
# 进程在但连续 6 次（约 1 分钟）健康检查失败，视为卡死，结束后重启。
supervise() {
  local stopping=0 fails=0 backoff=5 started_at=0 p
  trap 'stopping=1; [ -n "${nap:-}" ] && kill "$nap" 2>/dev/null; true' TERM INT
  echo "$$" > "$SUP_PID"
  say() { echo "[supervisor] $(date -Is) $*" >> "$LOG"; }   # 每次重新打开，日志轮转后仍写进新文件
  say "保活启动 (pid $$)"
  nap_for() { sleep "$1" & nap=$!; wait "$nap" 2>/dev/null || true; nap=; }
  while (( ! stopping )); do
    if ! p="$(pid)"; then
      if (( started_at && $(date +%s) - started_at < 60 )); then
        backoff=$(( backoff * 2 > 300 ? 300 : backoff * 2 ))
      else
        backoff=5
      fi
      (( started_at )) && say "网关已退出，${backoff} 秒后重启"
      (( started_at )) && nap_for "$backoff"
      (( stopping )) && break
      launch; started_at="$(date +%s)"; fails=0
      wait_healthy 120 || say "网关 60 秒内未通过健康检查"
    elif healthy; then
      fails=0
    elif (( ++fails >= 6 )); then
      say "网关 (pid $p) 连续 $fails 次无响应，结束后重启"
      kill -TERM "$p" 2>/dev/null || true
      for _ in $(seq 1 60); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
      kill -KILL "$p" 2>/dev/null || true
      fails=0; started_at=0
      continue
    fi
    nap_for 10
  done
  rm -f "$SUP_PID"
  say "保活停止"
}

start() {
  mkdir -p "$DATA/run"; chmod 700 "$DATA"
  exec 9> "$DATA/run/start.lock"; flock 9   # 开机时多个 SSH 连接会同时触发 start，只允许一个拉起保活
  local p was_running=0
  if p="$(pid)"; then was_running=1; fi
  if ! sup_pid > /dev/null; then
    (( was_running )) || [ -f "$APP_ROOT/dist/index.html" ] || { echo "缺少构建产物 dist/，先运行: cloudcli-multi update"; exit 1; }
    (exec 9>&-; cd "$APP_ROOT" && nohup setsid bash "$SELF" supervise >> "$LOG" 2>&1 < /dev/null &)
    for _ in $(seq 1 20); do sup_pid > /dev/null && break; sleep 0.1; done
  fi
  if (( was_running )); then echo "已在运行 (pid $p, 端口 $PORT)，保活 pid $(sup_pid || echo 启动中)"; return 0; fi
  # 保活进程负责拉起网关，这里只等健康检查
  if wait_healthy 60; then echo "已启动 (pid $(pid), http://127.0.0.1:$PORT)，保活 pid $(sup_pid)"; return 0; fi
  echo "启动失败或超时，最近日志："; tail -n 20 "$LOG"; exit 1
}

stop() {
  local s p
  if s="$(sup_pid)"; then
    kill -TERM "$s"
    for _ in $(seq 1 20); do kill -0 "$s" 2>/dev/null || break; sleep 0.5; done
  fi
  p="$(pid)" || { echo "未运行"; return 0; }
  kill -TERM "$p"   # 网关收到 SIGTERM 会先停掉所有账号子进程再退出
  for _ in $(seq 1 60); do kill -0 "$p" 2>/dev/null || { echo "已停止"; return 0; }; sleep 0.5; done
  if [ "${1:-}" = "--force" ]; then
    kill -KILL "$p"; echo "已强制停止（遗留的账号子进程会在下次启动时自动清理）"
  else
    echo "30 秒内未退出 (pid $p)；保活已停，确认无误后可用: cloudcli-multi stop --force"; exit 1
  fi
}

status() {
  local p s
  if p="$(pid)"; then
    echo "运行中  pid $p  已运行 $(ps -o etime= -p "$p" | tr -d ' ')  http://127.0.0.1:$PORT  $(healthy && echo 健康 || echo 无响应)"
  else
    echo "未运行"
  fi
  if s="$(sup_pid)"; then echo "保活    pid $s  已运行 $(ps -o etime= -p "$s" | tr -d ' ')"; else echo "保活    未运行"; fi
  echo "源码 $APP_ROOT ($(git -C "$APP_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git -C "$APP_ROOT" rev-parse --short HEAD 2>/dev/null))  Node $("$NODE_BIN" -v)  数据 $DATA"
  local f
  for f in "$DATA"/run/*.json; do
    [ -e "$f" ] || continue
    "$NODE_BIN" -e 'const r=require(process.argv[1]);let a=false;try{process.kill(r.pid,0);a=true}catch{};console.log(`  账号 ${require("path").basename(process.argv[1],".json").padEnd(16)} pid ${r.pid}  端口 ${r.port}  ${a?"运行中":"已退出"}`)' "$f"
  done
}

# 检查脚本要求真实数据目录在检查期间不被改动（UPG-09），运行中的账号子进程会写 auth.db，
# 所以服务在运行时先停掉，检查结束（无论成败）再恢复。
check() {
  local was_running=0 status=0
  if pid > /dev/null; then
    was_running=1
    echo "== 检查期间暂停服务（约 3～5 分钟），结束后自动恢复"
    stop
  fi
  (cd "$APP_ROOT" && "${BIN[@]}" check "$@") || status=$?
  if (( was_running )); then echo "== 恢复服务"; start; fi
  return "$status"
}

update() {
  cd "$APP_ROOT"
  # 依赖有变化（package-lock.json 比 node_modules 新）时才重装
  if [ package-lock.json -nt node_modules/.package-lock.json ]; then echo "== npm ci"; npm ci; fi
  echo "== 构建"; npm run build:multi   # 构建失败会在这里退出，正在运行的服务不受影响
  echo "== 重启"; stop
  if [ "${1:-}" = "--check" ]; then echo "== 检查（服务已停，不会改动真实数据）"; "${BIN[@]}" check || { echo "检查未全部通过，仍启动服务；详情见上方输出"; }; fi
  start
}

case "${1:-help}" in
  start) start ;;
  stop) stop "${2:-}" ;;
  restart) stop; start ;;
  status) status ;;
  logs) if [ "${2:-}" = "-f" ]; then tail -n "${3:-100}" -f "$LOG"; else tail -n "${2:-100}" "$LOG"; fi ;;
  update) update "${2:-}" ;;
  check) shift; check "$@" ;;
  supervise) supervise; exit 0 ;;   # 内部命令，由 start 在后台拉起；显式 exit，长驻期间源码被改也不会读到新内容
  run) cd "$APP_ROOT"; exec "${BIN[@]}" start ;;   # 前台运行，调试用
  help|-h|--help)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; echo; "${BIN[@]}" help ;;
  *) cd "$APP_ROOT"; exec "${BIN[@]}" "$@" ;;
esac
