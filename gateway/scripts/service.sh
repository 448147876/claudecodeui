#!/usr/bin/env bash
# cloudcli-multi 服务管理：后台启动、停止、重启、状态、日志、更新。运维说明见 mydocs/08-运维部署维护.md。
# 全局命令 ~/.local/bin/cloudcli-multi 是指向本文件的软链接；源码目录由软链接解析得到，改源码后 update 即可生效。
#
#   cloudcli-multi start | stop [--force] | restart | status | logs [-f] [行数] | update [--check] | run
#   cloudcli-multi check [参数]       隔离检查；服务运行中会先暂停、检查完自动恢复
#   cloudcli-multi backups | restore <备份名> | help      其余命令原样交给 gateway/bin.mjs
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
ENV_FILE="${CLOUDCLI_MULTI_ENV:-$HOME/.config/cloudcli-multi/env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

# 固定使用 Node 22（node_modules 中的原生模块按 Node 22 编译），不依赖系统 node 版本
NODE_BIN="${CLOUDCLI_MULTI_NODE:-$HOME/.local/share/cloudcli-multi/node/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
export PATH="$(dirname "$NODE_BIN"):$PATH"

DATA="${CLOUDCLI_MULTI_HOME:-$HOME/.cloudcli-multi}"; DATA="${DATA/#\~/$HOME}"
PORT="${CLOUDCLI_MULTI_PORT:-3001}"
LOCK="$DATA/run/gateway.lock"
LOG="$DATA/gateway.log"
BIN=("$NODE_BIN" "$APP_ROOT/gateway/bin.mjs")

pid() { [ -f "$LOCK" ] && p="$(cat "$LOCK" 2>/dev/null)" && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; }
healthy() { curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$PORT/__gw/login" 2>/dev/null | grep -q '^200$'; }

start() {
  if p="$(pid)"; then echo "已在运行 (pid $p, 端口 $PORT)"; return 0; fi
  [ -f "$APP_ROOT/dist/index.html" ] || { echo "缺少构建产物 dist/，先运行: cloudcli-multi update"; exit 1; }
  mkdir -p "$DATA"; chmod 700 "$DATA"
  # 日志超过 10 MB 时轮转一份
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 10485760 ]; then mv -f "$LOG" "$LOG.1"; fi
  echo "[service] $(date -Is) start ($("$NODE_BIN" -v), $APP_ROOT)" >> "$LOG"
  (cd "$APP_ROOT" && nohup setsid "${BIN[@]}" start >> "$LOG" 2>&1 < /dev/null &)
  for _ in $(seq 1 60); do
    if healthy; then echo "已启动 (pid $(pid), http://127.0.0.1:$PORT)"; return 0; fi
    sleep 0.5
  done
  echo "启动失败或超时，最近日志："; tail -n 20 "$LOG"; exit 1
}

stop() {
  local p; p="$(pid)" || { echo "未运行"; return 0; }
  kill -TERM "$p"   # 网关收到 SIGTERM 会先停掉所有账号子进程再退出
  for _ in $(seq 1 60); do kill -0 "$p" 2>/dev/null || { echo "已停止"; return 0; }; sleep 0.5; done
  if [ "${1:-}" = "--force" ]; then
    kill -KILL "$p"; echo "已强制停止（遗留的账号子进程会在下次启动时自动清理）"
  else
    echo "30 秒内未退出 (pid $p)；确认无误后可用: cloudcli-multi stop --force"; exit 1
  fi
}

status() {
  local p
  if p="$(pid)"; then
    echo "运行中  pid $p  已运行 $(ps -o etime= -p "$p" | tr -d ' ')  http://127.0.0.1:$PORT  $(healthy && echo 健康 || echo 无响应)"
  else
    echo "未运行"
  fi
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
  echo "== 重启"; if pid > /dev/null; then stop; fi
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
  run) cd "$APP_ROOT"; exec "${BIN[@]}" start ;;   # 前台运行，调试用
  help|-h|--help)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; echo; "${BIN[@]}" help ;;
  *) cd "$APP_ROOT"; exec "${BIN[@]}" "$@" ;;
esac
