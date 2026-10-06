#!/bin/bash
set -e
cd /root/bot
echo ">>> 拉取最新代码"
git checkout -- src/index.js
git pull --ff-only
echo ">>> 安装依赖"
npm install --omit=dev
echo ">>> 重启机器人"
pm2 delete bot >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save
echo ">>> 最近日志"
pm2 logs bot --lines 15 --nostream
