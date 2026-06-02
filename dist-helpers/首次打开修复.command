#!/bin/bash
# 智界桌面助手 — 首次打开修复脚本（未签名分发时使用）
#
# 背景：App 未经 Apple 签名/公证，macOS 会给它打上隔离(quarantine)标记，
# 双击时报「已损坏，无法打开」。本脚本移除隔离标记即可正常打开。
#
# 用法：把本脚本和 .app 放同一目录，双击运行；或在终端执行：
#   bash 首次打开修复.command
set -e

APP_NAME="智界桌面助手.app"
DIR="$(cd "$(dirname "$0")" && pwd)"

# 优先用脚本同目录的 App，其次找 /Applications
if [ -d "$DIR/$APP_NAME" ]; then
  TARGET="$DIR/$APP_NAME"
elif [ -d "/Applications/$APP_NAME" ]; then
  TARGET="/Applications/$APP_NAME"
else
  echo "未找到 $APP_NAME，请把本脚本与 App 放在同一目录，或先把 App 拖到「应用程序」。"
  read -n 1 -s -r -p "按任意键退出…"
  exit 1
fi

echo "正在解除隔离：$TARGET"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
# 重新做一次本地 ad-hoc 签名，避免「已损坏」
codesign --force --deep --sign - "$TARGET" 2>/dev/null || true

echo "完成！现在可以正常双击打开「$APP_NAME」了。"
read -n 1 -s -r -p "按任意键退出…"
