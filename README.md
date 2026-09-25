# Telegram Clone Platform

主机器人 + 可克隆子机器人 + 中央 Telegram 资源库。

## 已实现

- 指定群成员验证
- 主机器人广播
- 用户提交 BotFather Token 后自动验证
- 自动保存并启动子机器人
- 子机器人不显示、不执行广播功能
- 子机器人与主机器人共用中央资源索引
- 仓库群/频道新资源自动建立索引
- 最新资源、随机 10 个、关键词搜索
- 子机器人重启后自动恢复
- Bot Token 使用 AES-256-GCM 加密保存到运行时数据文件
- 无第三方 npm Telegram SDK，直接使用 Telegram Bot API

## 环境变量

- BOT_TOKEN：主机器人 Token
- ADMIN_IDS：管理员 Numeric User ID，多个用逗号分隔
- REQUIRED_GROUP_ID：用户必须加入的群/超级群 ID
- REQUIRED_GROUP_URL：指定群邀请链接
- REPOSITORY_CHAT_ID：资源仓库群/频道 ID
- STORAGE_KEY：建议设置一串随机长字符串，用于加密子机器人 Token
- DATA_FILE：数据文件路径，默认 ./data/database.json
- MAX_RESOURCES：最多保存多少条资源索引，默认 5000

## 部署

Node.js 18+。

```
npm install
npm run check
npm start
```

如果使用 Render，Start Command 使用：

```
npm start
```

不要再使用 wrangler.toml 部署这个版本；当前项目是 Node.js 长轮询版本。

## 重要设置

1. 主机器人必须正常运行。
2. 主机器人加入资源仓库群/频道；如果是频道，建议设为管理员，这样才能收到 channel_post 更新。
3. 主机器人加入指定权限群，并至少具备读取成员状态所需的管理员权限；Telegram 文档说明，机器人查询其他用户的成员状态通常需要在该群拥有管理员权限。
4. 子机器人也需要加入指定权限群，否则用户无法使用资源功能。
5. 资源通过仓库群/频道的新消息建立索引；Telegram Bot API 不提供让机器人直接读取任意历史频道消息的通用历史浏览接口，因此部署后新发布的资源会自动进入索引。
6. Render Free 等临时文件系统重启/重新部署后可能丢失 data/database.json。生产环境建议把 DATA_FILE 放到持久化存储或改用外部数据库。

## 安全

不要把任何 Bot Token 提交到 GitHub。主机器人只接受私聊中的 Token，并先调用 getMe 验证；保存时使用 AES-256-GCM 加密。建议配置 STORAGE_KEY，并定期轮换子机器人 Token。

