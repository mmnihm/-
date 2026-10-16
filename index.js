import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("请设置 BOT_TOKEN 环境变量");

const apiUrl = "https://api.telegram.org/bot" + token + "/";
const configuredDataDir = String(process.env.DATA_DIR || "/app/data");
// Hostless 偶尔会把环境变量的引号一起传入；彻底剥离引号和首尾空白。
const rawDataDir = configuredDataDir.replace(/[\u0000-\u001f]/g, "").replace(/["\']/g, "").trim();
const dir = path.resolve(rawDataDir || "/app/data");
const file = path.join(dir, "support-data.json");
fs.mkdirSync(dir, { recursive: true });
console.log("BOOT_VERSION=hostless-path-fix-2026-10-17");
console.log("DATA_DIR_CONFIG=" + JSON.stringify(configuredDataDir));
console.log("DATA_DIR_RESOLVED=" + JSON.stringify(dir));

const configuredAdminId = String(process.env.ADMIN_ID || "").trim();
let db = {
  adminId: configuredAdminId,
  users: {},
  replies: {},
  agents: {},
  blacklist: {},
  sessions: {},
  broadcastPending: false
};

if (fs.existsSync(file)) {
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  db = { ...db, ...saved };
}
// 环境变量优先，避免旧 JSON 中的管理员 ID 覆盖部署配置。
db.adminId = configuredAdminId || String(db.adminId || "");

function save() {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(method, body = {}) {
  const res = await fetch(apiUrl + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) {
    const error = new Error(data.description || "Telegram API error");
    error.retryAfter = data.parameters?.retry_after || 0;
    throw error;
  }
  return data.result;
}

const send = (id, text, extra = {}) => call("sendMessage", { chat_id: id, text, ...extra });
async function copyTo(from, to, messageId) {
  return call("copyMessage", { chat_id: to, from_chat_id: from, message_id: messageId });
}
const admin = id => String(id) === String(db.adminId) || Boolean(db.agents[String(id)]);
const isAdmin = id => String(id) === String(db.adminId);

function userName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "未知用户";
  return name + " (@" + (user.username || "无用户名") + ") ID:" + user.id;
}

async function broadcast(message) {
  const adminChatId = String(message.chat.id);
  const ids = Object.keys(db.users).filter(id => !db.blacklist[id]);
  await send(adminChatId, "📣 开始广播，共 " + ids.length + " 位用户。");
  let ok = 0;
  let fail = 0;

  for (const id of ids) {
    try {
      await copyTo(adminChatId, id, message.message_id);
      ok++;
    } catch (error) {
      fail++;
      if (error.retryAfter) await wait((error.retryAfter + 1) * 1000);
      else await wait(50);
    }
    if ((ok + fail) % 25 === 0) await wait(1000);
  }

  await send(adminChatId, "✅ 广播结束\n成功：" + ok + "\n失败：" + fail);
}

async function handleSupportGroupMessage(message) {
  const supportGroupId = String(process.env.SUPPORT_GROUP_ID || "").trim();
  if (!supportGroupId || String(message.chat.id) !== supportGroupId) return false;

  // 只处理客服对机器人转入群内的用户消息所作的“回复”。
  if (!message.reply_to_message) return true;
  const targetUserId = db.replies[String(message.reply_to_message.message_id)];
  if (!targetUserId) return true;

  if (db.sessions[targetUserId]?.status === "closed") {
    await send(message.chat.id, "⚠️ 该用户会话已结束。管理员可使用 /open " + targetUserId + " 重新开启。");
    return true;
  }

  try {
    await copyTo(message.chat.id, targetUserId, message.message_id);
    await send(message.chat.id, "✅ 已回复用户 " + targetUserId);
  } catch (error) {
    console.error("客服群回复用户失败：", error.message);
    await send(message.chat.id, "❌ 回复失败：" + error.message);
  }
  return true;
}

async function onMessage(message) {
  if (!message.chat) return;

  // 群组消息必须先处理，否则客服群回复会被 private 判断直接丢弃。
  if (message.chat.type !== "private") {
    await handleSupportGroupMessage(message);
    return;
  }

  const id = String(message.chat.id);
  const user = message.from;
  if (!user) return;

  db.users[id] = {
    id,
    username: user.username || "",
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    lastSeen: Date.now()
  };
  db.sessions[id] ||= { status: "open", createdAt: Date.now() };
  save();

  if (!db.adminId) {
    if (message.text?.startsWith("/start")) {
      db.adminId = id;
      save();
      await send(id, "✅ 你已成为管理员。请务必由你本人第一个启动机器人。\n\n/broadcast - 广播，随后发送要广播的消息\n/users - 用户统计\n/agents - 客服名单\n/addagent 用户ID - 添加客服\n/delagent 用户ID - 移除客服\n/blacklist 用户ID - 拉黑\n/unblacklist 用户ID - 解除拉黑\n/end 用户ID - 结束会话\n/open 用户ID - 重开会话");
    }
    return;
  }

  // 管理员和客服的私聊命令、对消息的直接回复。
  if (admin(id)) {
    if (message.text === "/start") {
      await send(id, isAdmin(id)
        ? "客服管理菜单：/broadcast /users /agents /addagent 用户ID /delagent 用户ID /blacklist 用户ID /unblacklist 用户ID /end 用户ID /open 用户ID"
        : "你已是客服。请在客服群中直接回复机器人转入的用户消息。");
      return;
    }

    if (isAdmin(id) && message.text?.startsWith("/broadcast")) {
      db.broadcastPending = true;
      save();
      await send(id, "请发送下一条要广播的消息（文字、图片、视频、文件等均可），发送 /cancel 取消。");
      return;
    }

    if (isAdmin(id) && db.broadcastPending) {
      if (message.text === "/cancel") {
        db.broadcastPending = false;
        save();
        await send(id, "已取消广播。");
        return;
      }
      db.broadcastPending = false;
      save();
      await broadcast(message);
      return;
    }

    if (isAdmin(id) && message.text === "/users") {
      await send(id, "登记用户：" + Object.keys(db.users).length
        + "\n客服：" + Object.keys(db.agents).length
        + "\n开放会话：" + Object.values(db.sessions).filter(session => session.status === "open").length);
      return;
    }

    if (isAdmin(id) && message.text === "/agents") {
      await send(id, Object.keys(db.agents).join("\n") || "暂无额外客服");
      return;
    }

    const command = isAdmin(id)
      ? message.text?.match(/^\/(addagent|delagent|blacklist|unblacklist|end|open)(?:@\w+)?\s+(\d+)\s*$/)
      : null;

    if (command) {
      const action = command[1];
      const target = command[2];

      if (action === "addagent") db.agents[target] = { addedAt: Date.now() };
      if (action === "delagent") delete db.agents[target];
      if (action === "blacklist") db.blacklist[target] = true;
      if (action === "unblacklist") delete db.blacklist[target];
      if (action === "end" || action === "open") {
        db.sessions[target] ||= { createdAt: Date.now() };
        db.sessions[target].status = action === "end" ? "closed" : "open";
        db.sessions[target][action === "end" ? "closedAt" : "openedAt"] = Date.now();
      }

      save();
      await send(id, "✅ 已执行 /" + action + " " + target);
      return;
    }

    if (message.reply_to_message) {
      const target = db.replies[String(message.reply_to_message.message_id)];
      if (target) {
        if (db.sessions[target]?.status === "closed") {
          await send(id, "⚠️ 该用户会话已结束。使用 /open " + target + " 重新开启。");
          return;
        }
        try {
          await copyTo(id, target, message.message_id);
          await send(id, "✅ 已回复用户 " + target);
        } catch (error) {
          await send(id, "❌ 回复失败：" + error.message);
        }
      }
    }
    // 不要把管理员或客服自己的普通消息再当作用户消息转发。
    return;
  }

  if (db.blacklist[id]) {
    await send(id, "当前无法使用客服服务。");
    return;
  }

  if (message.text === "/start") {
    if (db.sessions[id]?.status === "closed") {
      await send(id, "此客服会话已结束，请等待管理员重新开启。");
    } else {
      await send(id, "你好，这里是客服中心，请直接发送问题，客服收到后会回复。");
    }
    return;
  }

  // 已结束的会话不会因为用户再发消息而被静默自动开启。
  if (db.sessions[id]?.status === "closed") {
    await send(id, "此客服会话已结束，请等待管理员使用 /open " + id + " 重新开启。");
    return;
  }

  const destination = process.env.SUPPORT_GROUP_ID || db.adminId;
  try {
    const copied = await copyTo(id, destination, message.message_id);
    db.replies[String(copied.message_id)] = id;
    save();
    if (String(destination) === String(process.env.SUPPORT_GROUP_ID || "")) {
      await send(destination, "📩 客服新消息\n用户：" + userName(user) + "\n直接回复上方转来的消息即可回复用户。");
    }
  } catch (error) {
    console.error("客服消息转发失败：", error.message);
    try {
      await send(id, "暂时无法联系到客服，请稍后再试。");
    } catch {}
  }
}

let offset = 0;

async function loop() {
  while (true) {
    try {
      const updates = await call("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"]
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          try {
            await onMessage(update.message);
          } catch (error) {
            console.error("消息处理失败：", error.message);
          }
        }
      }
    } catch (error) {
      console.error("轮询异常：", error.message);
      await wait(error.retryAfter ? (error.retryAfter + 1) * 1000 : 2500);
    }
  }
}

process.on("SIGTERM", () => {
  try { save(); } finally { process.exit(0); }
});
process.on("SIGINT", () => {
  try { save(); } finally { process.exit(0); }
});

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  // Hostless 健康检查：让平台能确认进程已启动。
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    ok: true,
    service: "telegram-support-bot",
    status: "running"
  }));
});

server.listen(port, "0.0.0.0", () => {
  console.log("HTTP 健康检查服务已启动，监听端口：" + port);
  console.log("客服机器人启动，数据文件：" + file);
  loop();
});

server.on("error", error => {
  console.error("HTTP 服务启动失败：", error.message);
  process.exit(1);
});
