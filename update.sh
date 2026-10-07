#!/bin/bash
set -e
cd /root/bot
echo ">>> 拉取最新代码"
if ! git pull --ff-only; then
  echo ">>> 本地改动挡住了更新，改用仓库版本"
  git checkout -- src/index.js src/cloud123.js
  git pull --ff-only
fi
echo ">>> 安装依赖"
npm install --omit=dev
echo ">>> 重启机器人"
pm2 restart bot || pm2 start ecosystem.config.cjs
pm2 save
echo ">>> 最近日志"
pm2 logs bot --lines 12 --nostream
