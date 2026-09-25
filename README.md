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

## 真实历史扫描

项目现在加入了真正的 Telegram MTProto 历史扫描，不是假的进度条。

- 使用 `teleproto` 以管理员指定的真实 Telegram 用户账号登录。
- 通过 `iterMessages` 实际读取该账号能够访问的仓库历史消息。
- 扫描到的文件/媒体会按真实的 `chat_id + message_id` 建立索引。
- 已有资源会去重，不会重复增加同一条消息。
- 管理员可以在主机器人中使用「🔗 绑定扫描账号」或发送 `/绑定扫描账号`。
- 登录完成后使用「🔍 历史扫描」或 `/历史扫描`。
- 扫描数量可以指定；输入 0 时按 `MAX_HISTORY_SCAN` 上限扫描。
- 可发送「🛑 停止扫描」或 `/停止扫描` 停止正在进行的扫描。
- 扫描账号的 MTProto Session 会使用现有的 `STORAGE_KEY` 加密后保存，不写入代码。
- 扫描账号必须自己已经加入资源仓库，并且能够正常查看历史消息。

### MTProto 环境变量

```
MT_API_ID=
MT_API_HASH=
MAX_HISTORY_SCAN=50000
```

`MT_API_ID` 和 `MT_API_HASH` 需要在 Telegram 的 API development tools 中创建应用后获得。不要把 API Hash、手机号验证码、两步验证密码或 Session 字符串提交到 GitHub。

### 真实扫描的边界

这是使用真实 Telegram 用户账号读取历史消息，不是 Bot API 的历史消息伪造。

如果这个用户账号本身看不到某个群/频道的历史内容，扫描器也无法扫描；程序不会绕过 Telegram 的权限。


## 安全

不要把任何 Bot Token 提交到 GitHub。主机器人只接受私聊中的 Token，并先调用 getMe 验证；保存时使用 AES-256-GCM 加密。建议配置 STORAGE_KEY，并定期轮换子机器人 Token。

