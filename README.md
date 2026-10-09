# Telegram Clone Platform

主机器人 + 可克隆子机器人 + 中央 Telegram 资源库。

## 已实现

- 指定群成员验证
- 管理员可在群内使用命令绑定/解绑指定群和资源仓库，无需手填聊天 ID
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
- REQUIRED_GROUP_ID / REQUIRED_GROUP_URL / REPOSITORY_CHAT_ID：兼容旧配置，可不填写；推荐部署后由管理员在群内使用绑定命令自动保存
- STORAGE_KEY：可选。现在项目内置固定加密密钥，正常部署无需填写；如果你主动设置此环境变量，它会覆盖内置密钥，且以后必须保持不变。
- DATA_FILE：数据文件路径，默认 /data/database.json；必须放在部署平台的持久化磁盘/目录中
- DATA_BACKUP_FILE：可选，数据库自动备份文件路径，默认 DATA_FILE + .bak
- 如果 DATA_FILE 目录不可写，程序不再使用 /tmp 临时目录，而是退回项目目录 ./data 并打印警告；这仍不能保证换服务器后数据保留
- MAX_RESOURCES：资源索引上限，默认 20000；达到上限前请做好 JSON 备份并评估磁盘/内存容量。

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

## 数据主从关系（重要）

- `DATA_FILE` 指向的 JSON 是机器人运行时的主数据源；目录、资源索引、用户状态和设置以 JSON 为准。
- `database.json.bak` 和按小时生成的 JSON 快照用于本地恢复。建议定期把 JSON 与备份复制到另一台服务器或独立存储。
- Google Sheets 仅作为外部备份/查看副本：机器人启动时只把 JSON 中的目录和资源写入表格，不会自动从 Google Sheets 导入或覆盖 JSON。表格连接失败不应阻止机器人启动和用户使用。
- MySQL 仍保留为辅助持久化/兼容层；切换服务器前应先确认 JSON 文件及备份完整，不要只依赖外部表格或 MySQL。
- 需要从 Google Sheets 手动恢复数据时，应先备份当前 JSON，再执行明确的人工恢复流程；不要把自动同步表格当作主库。

## 重要设置

1. 主机器人必须正常运行。
2. 将主机器人加入指定群并给管理员权限，在群内发送 /绑定指定群；将主机器人加入资源仓库超级群并给管理员权限，在仓库群内发送 /绑定仓库。
3. 管理员可私聊主机器人发送 /查看配置、/解绑指定群、/解绑仓库。
4. 主机器人加入资源仓库群；当前命令绑定方案支持普通群/超级群仓库。频道仍可作为兼容场景，但不能在频道内直接发送绑定命令。
5. 主机器人加入指定权限群，并至少具备读取成员状态所需的管理员权限；Telegram 文档说明，机器人查询其他用户的成员状态通常需要在该群拥有管理员权限。
6. 子机器人也需要加入指定权限群，否则用户无法使用资源功能。
7. 资源通过仓库群/频道的新消息建立索引；Telegram Bot API 不提供让机器人直接读取任意历史频道消息的通用历史浏览接口，因此部署后新发布的资源会自动进入索引。
8. 程序现在会在每次成功保存后自动生成 database.json.bak，并在主数据库不存在或损坏时尝试自动恢复。注意：备份文件仍然与 DATA_FILE 一起保存在同一存储位置；如果整个服务器/磁盘被删除，仍需要把 database.json 和 database.json.bak 迁移到新服务器。生产环境建议把 DATA_FILE 放到持久化存储或改用外部数据库。

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
- 扫描账号的 MTProto Session 会使用项目内置的固定加密密钥（也可由 `STORAGE_KEY` 覆盖）加密后保存。
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

