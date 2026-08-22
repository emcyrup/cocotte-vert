#!/usr/bin/env bash
# Docker の無いサーバーでアプリを動かすための起動スクリプト。
#
# 本番サーバー（AWS）は sudo が使えず、Docker も systemd のユニット登録もできない。
# そのため nohup で常駐させ、PID ファイルで止める。再起動後の自動復帰は crontab の
# @reboot に任せる（手順は docs/deploy-aws.md）。
#
#   ./scripts/serve.sh start|stop|restart|status|logs
#
# 起動前に必ずマイグレーションを流す。失敗したらアプリは起動しない
# （古いスキーマのまま動かすと、書き込みが中途半端に通ってしまうため）。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/run"
PID_FILE="$RUN_DIR/app.pid"
LOG_FILE="$RUN_DIR/app.log"
# ログが無制限に育つとディスクを圧迫する。sudo が無く logrotate を置けないため
# 起動のたびに大きくなりすぎた分を1世代だけ退避する
MAX_LOG_BYTES=$((20 * 1024 * 1024))

# 日付比較は JST 前提で書いてある。サーバーの既定が UTC でもここで揃える
export TZ=Asia/Tokyo

if [ ! -f "$ROOT/.env" ]; then
  echo "エラー: .env がありません（.env.example を写して埋めてください）" >&2
  exit 1
fi

# .env は source しない。値に記号（$ や !）が入っていると壊れるうえ、
# 秘密情報をシェルの環境へ広げたくないため、必要な1つだけを取り出す
PORT="$(sed -n 's/^PORT=//p' "$ROOT/.env" | tail -1)"
PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

rotate_log() {
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
}

start() {
  if pid="$(running_pid)"; then
    echo "すでに動いています（pid=$pid）"
    return 0
  fi
  mkdir -p "$RUN_DIR"
  rotate_log

  echo "マイグレーションを適用します…"
  node --env-file-if-exists=.env scripts/migrate.js

  echo "起動します（port=$PORT）…"
  nohup node --env-file-if-exists=.env src/index.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  # 起動できたかどうかをここで確かめる。黙って落ちていると気付けない
  for _ in $(seq 1 20); do
    sleep 0.5
    if curl -sf "$HEALTH_URL" > /dev/null; then
      echo "起動しました: $(curl -s "$HEALTH_URL")"
      return 0
    fi
    if ! running_pid > /dev/null; then
      echo "起動に失敗しました。ログの末尾:" >&2
      tail -20 "$LOG_FILE" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
  done
  echo "起動を確認できませんでした（プロセスは動いています）。ログを確認してください: $LOG_FILE" >&2
  exit 1
}

stop() {
  if ! pid="$(running_pid)"; then
    echo "動いていません"
    rm -f "$PID_FILE"
    return 0
  fi
  kill "$pid"
  for _ in $(seq 1 20); do
    sleep 0.5
    kill -0 "$pid" 2>/dev/null || break
  done
  # 落ちきらない場合だけ強制する（配信中に切ると途中で終わるため、まずは待つ）
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" || true
  rm -f "$PID_FILE"
  echo "止めました（pid=$pid）"
}

status() {
  if pid="$(running_pid)"; then
    echo "動いています（pid=$pid, port=$PORT）"
    curl -sf "$HEALTH_URL" && echo || echo "※ $HEALTH_URL に応答がありません"
  else
    echo "動いていません"
    exit 1
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -f "$LOG_FILE" ;;
  *)
    echo "使い方: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
