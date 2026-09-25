# Telegram Clone Platform

多机器人平台 MVP。

## 功能
- 指定群成员验证
- 只有指定群成员可以进入克隆流程
- 主机器人统一入口
- 子机器人架构预留
- 中央资源库架构预留
- 管理员入口
- 环境变量配置

## 环境变量
- BOT_TOKEN：主机器人 Token
- ADMIN_IDS：管理员 Telegram Numeric User ID，多个用逗号分隔
- REQUIRED_GROUP_ID：指定群/频道 Chat ID
- REQUIRED_GROUP_URL：指定群邀请链接

## 重要说明
BotFather 创建子机器人仍需由用户本人完成。不要把 Bot Token 提交到 GitHub。
中央私有 Telegram 仓库的资源不能在没有访问权限的情况下被另一个 Bot API 身份直接复制发送，因此正式版需要单独的资源分发层。
