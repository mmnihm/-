# Telegram Clone Platform

Cloudflare Worker + D1 多机器人资源平台。

## 当前功能
- 主机器人：资源目录、搜索、随机、最新、克隆、管理员广播
- 子机器人：独立用户和 Bot 身份，共享中央资源索引
- 子机器人不显示广播
- 指定群实时会员检查；离群后资源/克隆功能失效
- 子机器人 Token 后端 AES-GCM 加密保存
- 主/子机器人 Webhook
- 文件夹、资源索引、仓库绑定、管理员上传入库
- 目录分类点击和资源按钮
- 广播预览、确认、取消
- 广播逐个失败不中断

## 环境变量
BOT_TOKEN=主机器人 Token
ADMIN_IDS=主机器人管理员 Numeric ID，多个用逗号
REQUIRED_GROUP_ID=必须加入的群/频道 Chat ID
REQUIRED_GROUP_URL=指定群邀请/公开链接
PUBLIC_BASE_URL=Worker 公网地址
TOKEN_ENCRYPTION_KEY=随机长密钥
WEBHOOK_SECRET=Webhook secret

## 部署
1. 创建 Cloudflare Worker。
2. 创建 D1 数据库。
3. 将 database_id 写入 wrangler.toml。
4. 执行 schema.sql。
5. 设置上面的 Worker Secrets/Variables。
6. 打开 https://你的Worker地址/setup 一次，自动注册主机器人 Webhook。
7. 用户通过主机器人创建子机器人并发送 Token，系统会自动注册子机器人 Webhook。

## 仓库和上传
主机器人加入资源仓库并有必要权限。
管理员进入「⚙️ 平台管理」后绑定仓库。
上传资源时，机器人会把管理员发送的文件复制到绑定仓库并建立索引。

## Telegram 限制
Telegram Bot API 的 file_id 是按 Bot 隔离的，不能可靠地把主 Bot 的 file_id 直接交给子 Bot 使用。因此“子机器人不加入私有仓库、又由子 Bot 自己直接发送中央仓库文件”无法仅靠 Bot API 完成。当前项目已经把中央资源索引与 Bot 身份分开；若要求每个子 Bot 都直接发送私有仓库大文件，需要额外的共享存储/分发层，或让子 Bot 具备资源来源访问权限。

普通 Bot API 也不能保证读取任意私有仓库的完整历史消息。完整历史恢复需要额外的 MTProto/user-account 层。

## 安全
不要把任何 Token 提交到 GitHub。曾经公开发送过的 Token 应立即在 BotFather 轮换。
