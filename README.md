# Telegram Clone Platform

Cloudflare Worker + D1 的多机器人资源平台。

## 已实现
- 主机器人：克隆入口、资源入口、平台管理、广播
- 子机器人：独立 Bot 身份、独立用户记录、共享中央资源索引
- 指定群实时会员检查
- 子机器人 Token 绑定时通过 Telegram getMe 校验
- 子机器人 Token 加密后存 D1
- 子机器人 Webhook 路由
- 用户端不显示广播
- D1 资源索引、文件夹、机器人和用户数据结构

## 必填配置
- BOT_TOKEN：主机器人 Token
- ADMIN_IDS：主机器人管理员 Numeric Telegram ID，多个逗号分隔
- REQUIRED_GROUP_ID：指定群/频道 Chat ID
- REQUIRED_GROUP_URL：指定群入口链接
- PUBLIC_BASE_URL：Worker 公网地址，例如 https://xxx.workers.dev
- TOKEN_ENCRYPTION_KEY：用于加密子机器人 Token 的随机长字符串
- WEBHOOK_SECRET：Telegram Webhook secret token

## D1
执行 schema.sql 初始化数据库，然后在 wrangler.toml 中填写真实 database_id。

## 重要限制
普通 Telegram Bot API 无法让一个未加入私有资源仓库的子机器人直接复制该私有仓库历史消息。因此本版本把“中央资源索引”和“资源发送层”分开：资源记录必须具有可由当前 Bot 合法发送的 file_id/来源。完整历史仓库扫描与跨 Bot 恢复需要额外的 MTProto/user-account 层，不能仅靠 Bot API 保证。

## 安全
不要把 BOT_TOKEN 或子机器人 Token 提交到 GitHub。曾经泄露过的 Token 应立即在 BotFather 中轮换。
