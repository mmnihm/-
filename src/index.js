import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";

try { dns.setDefaultResultOrder("ipv4first"); } catch {}

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const CONFIG_DATA_FILE = process.env.DATA_FILE || "/data/database.json";
let DATA_FILE = CONFIG_DATA_FILE;
try {
  fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
  fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK);
} catch {
  // 不再使用 /tmp 保存正式数据，避免重启/换容器后数据悄悄消失。
  // 如果 /data 不可写，则退回项目目录 ./data，并明确给出警告。
  DATA_FILE = path.resolve(process.env.LOCAL_DATA_DIR || "./data", "database.json");
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
    fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK);
  } catch (e) {
    console.error("❌ 数据目录不可写:", e.message);
    console.error("❌ 请给 DATA_FILE 配置一个真正可持久化的目录。");
  }
}
const BACKUP_FILE = process.env.DATA_BACKUP_FILE || (DATA_FILE + ".bak");
const SECRET = process.env.STORAGE_KEY || "telegram-clone-platform-v2";
const MAX_RESOURCES = Number(process.env.MAX_RESOURCES || 20000);
const UPLOAD_IDLE_SECONDS = Math.max(15, Number(process.env.UPLOAD_IDLE_SECONDS || 180));
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || "";

const runtime = {
  startedAt: Date.now(),
  lastPollAt: 0,
  lastUpdateAt: 0,
  lastTelegramOkAt: 0,
  lastError: "",
  mainConnected: false
};

function runtimeStatus() {
  return {
    ok: runtime.mainConnected && !runtime.lastError,
    startedAt: new Date(runtime.startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - runtime.startedAt) / 1000),
    mainConnected: runtime.mainConnected,
    lastPollAt: runtime.lastPollAt ? new Date(runtime.lastPollAt).toISOString() : null,
    lastUpdateAt: runtime.lastUpdateAt ? new Date(runtime.lastUpdateAt).toISOString() : null,
    lastTelegramOkAt: runtime.lastTelegramOkAt ? new Date(runtime.lastTelegramOkAt).toISOString() : null,
    lastError: runtime.lastError || null,
    dataFile: DATA_FILE,
    backupFile: BACKUP_FILE,
    dataFileExists: fs.existsSync(DATA_FILE),
    backupFileExists: fs.existsSync(BACKUP_FILE),
    baserow: {
      enabled: baserow.enabled,
      connected: baserow.connected,
      tableId: BASEROW_TABLE_ID || null,
      lastOkAt: baserow.lastOkAt ? new Date(baserow.lastOkAt).toISOString() : null,
      lastError: baserow.lastError || null
    }
  };
}

console.log("🚀 Telegram Clone Platform v2 starting...");
console.log("📦 Node:", process.version);
console.log("🔐 BOT_TOKEN:", TOKEN ? "已配置" : "❌ 未配置");
console.log("👑 ADMIN_IDS:", ADMIN_IDS.size ? "已配置" : "❌ 未配置");
// Baserow 连接检查仅在机器人启动完成后异步执行，不阻塞主进程启动。
Promise.resolve().then(() => checkBaserowConnection()).catch(e => console.error("BASEROW CHECK:", e.message));

process.on("uncaughtException", e => console.error("UNCAUGHT:", e));
process.on("unhandledRejection", e => console.error("UNHANDLED:", e));

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const status = runtimeStatus();
    res.writeHead(200, {"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify(status, null, 2) + "\n");
  } else {
    res.writeHead(404, {"content-type":"text/plain; charset=utf-8"});
    res.end("Not Found\n");
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`🌐 HTTP server: 0.0.0.0:${PORT}`));

if (!TOKEN) {
  console.error("❌ BOT_TOKEN 未配置，请在 Deplexo 环境变量中设置 BOT_TOKEN");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const TELEGRAM_API_HOSTS = [
  "https://api.telegram.org",
  "https://api.telegram.org"
];

async function telegramHttpsRequest(token, method, body, timeoutMs) {
  const payload = JSON.stringify(body || {});
  return await new Promise((resolve, reject) => {
    const req = https.request(
      api(token, method),
      {
        method: "POST",
        family: 4,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "accept": "application/json",
          "connection": "keep-alive"
        }
      },
      res => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            resolve({status: res.statusCode || 0, json: JSON.parse(data || "{}")});
          } catch (e) {
            reject(new Error("Telegram 响应解析失败: " + (e?.message || e)));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("ETIMEDOUT")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function safeEdit(token, body, fallbackText = "") {
  try {
    const formattedBody = body && typeof body === "object" && typeof body.text === "string"
      ? {...body, text:prettyText(body.text)}
      : body;
    return await tg(token, "editMessageText", formattedBody);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/message.*(can't|cannot).*edit|message is not modified|MESSAGE_ID_INVALID|message to edit not found/i.test(msg)) {
      console.warn("⚠️ Telegram 进度消息无法编辑，继续任务：", msg);
      if (fallbackText && body?.chat_id) {
        try {
          return await tg(token, "sendMessage", {
            chat_id: body.chat_id,
            text: prettyText(fallbackText),
            parse_mode: body.parse_mode,
            reply_markup: body.reply_markup
          });
        } catch (sendErr) {
          console.warn("⚠️ 备用进度消息发送失败，继续任务：", String(sendErr?.message || sendErr));
        }
      }
      return null;
    }
    throw e;
  }
}

async function tg(token, method, body = {}) {
  const maxAttempts = method === "getUpdates" ? 8 : 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const timeoutMs = method === "getUpdates" ? 50000 : 20000;
    try {
      const r = await telegramHttpsRequest(token, method, body, timeoutMs);
      const j = r.json;
      if (j.ok) return j.result;

      const retryAfter = Number(j.parameters?.retry_after || 0);
      if (r.status === 429 && retryAfter > 0 && attempt < maxAttempts - 1) {
        console.warn("⏳ Telegram 限流，"+method+" 等待 "+retryAfter+" 秒后自动重试");
        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      // 4xx 是 Telegram 明确拒绝请求，不属于网络故障，不再重复重试。
      // 特别是“message can't be edited”通常表示消息已过期、已删除、
      // 内容没有变化或该消息不是机器人可编辑的消息。
      if (r.status >= 400 && r.status < 500) {
        const err = new Error(j.description || method + " failed");
        err.telegramStatus = r.status;
        err.telegramDescription = j.description || "";
        // Telegram 对 editMessageText 的“消息无法编辑”属于业务状态，
        // 不是网络故障：立即交给 safeEdit 处理，绝不重试 4 次。
        if (
          method === "editMessageText" &&
          /message.*(can't|cannot).*edit|message is not modified|MESSAGE_ID_INVALID|message to edit not found/i.test(
            String(j.description || "")
          )
        ) {
          err.noRetry = true;
        }
        throw err;
      }

      throw new Error(j.description || method + " failed");
    } catch (e) {
      const code = e?.code || "";
      const msg = String(e?.message || e);
      if (e?.noRetry) {
        throw e;
      }
      console.warn("⚠️ Telegram HTTPS 请求失败:", method, "attempt="+(attempt+1)+"/"+maxAttempts, code ? code+" | " : "", msg);
      if (attempt >= maxAttempts - 1) {
        throw new Error(method + " 网络请求失败: " + (code ? code+" | " : "") + msg);
      }
      await sleep(Math.min(10000, 1000 * Math.pow(2, attempt)));
    }
  }
  throw new Error(method + " failed after retries");
}
const main = (method, body = {}) => tg(TOKEN, method, body);

const BASEROW_API_URL = String(process.env.BASEROW_API_URL || "https://api.baserow.io").replace(/\/$/, "");
const BASEROW_TOKEN = String(process.env.BASEROW_TOKEN || "").trim();
const BASEROW_TABLE_ID = String(process.env.BASEROW_TABLE_ID || "1229166").trim();

const baserow = {
  enabled: Boolean(BASEROW_TOKEN && BASEROW_TABLE_ID),
  connected: false,
  lastError: "",
  lastOkAt: 0
};

async function baserowRequest(method, pathName, body) {
  if (!BASEROW_TOKEN || !BASEROW_TABLE_ID) {
    throw new Error("Baserow 环境变量未配置");
  }
  const options = {
    method,
    headers: {
      "Authorization": "Token " + BASEROW_TOKEN,
      "Accept": "application/json"
    }
  };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const r = await fetch(BASEROW_API_URL + pathName, options);
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text || "{}"); } catch {}
  if (!r.ok) {
    throw new Error("Baserow " + r.status + ": " + String(data?.detail || data?.error || text || "请求失败").slice(0, 300));
  }
  return data;
}

async function checkBaserowConnection() {
  if (!BASEROW_TOKEN || !BASEROW_TABLE_ID) {
    baserow.enabled = false;
    baserow.connected = false;
    baserow.lastError = "未配置 BASEROW_TOKEN / BASEROW_TABLE_ID";
    return false;
  }
  try {
    await baserowRequest(
      "GET",
      "/api/database/rows/table/" + encodeURIComponent(BASEROW_TABLE_ID) + "/?user_field_names=true&size=1"
    );
    baserow.enabled = true;
    baserow.connected = true;
    baserow.lastError = "";
    baserow.lastOkAt = Date.now();
    console.log("🗄️ Baserow: 已连接，table=" + BASEROW_TABLE_ID);
    return true;
  } catch (e) {
    baserow.enabled = true;
    baserow.connected = false;
    baserow.lastError = String(e?.message || e);
    console.error("❌ Baserow 连接失败:", baserow.lastError);
    return false;
  }
}

// Baserow 资源同步：扫描/监听到资源后自动写入资源表。
// 兼容不同模板字段名称；不会覆盖用户已有的其他字段。
let baserowFieldsCache = null;
let baserowSyncQueue = Promise.resolve();

function baserowNormName(v) {
  return String(v || "").trim().toLowerCase().replace(/[\\s_\-\/（）()：:]+/g, "");
}

async function getBaserowFields(force=false) {
  if (baserowFieldsCache && !force) return baserowFieldsCache;
  const fields = await baserowRequest(
    "GET",
    "/api/database/fields/table/" + encodeURIComponent(BASEROW_TABLE_ID) + "/"
  );
  baserowFieldsCache = Array.isArray(fields) ? fields : [];
  console.log("🗄️ Baserow 字段:", baserowFieldsCache.map(x => x.name).join(" | "));
  return baserowFieldsCache;
}

function baserowPickField(fields, aliases) {
  const wanted = aliases.map(baserowNormName);
  return fields.find(f => wanted.includes(baserowNormName(f.name))) || null;
}

function baserowValueForField(field, value, fallbackType="text") {
  if (!field) return undefined;
  const type = String(field.type || fallbackType);
  if (value === undefined || value === null) return null;
  if (type === "number" || type === "rating") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "boolean") return Boolean(value);
  // Baserow 单选/多选字段必须使用表格中已经存在的选项，不能直接写入任意字符串。
  if (type === "single_select" || type === "multiple_select") {
    const options = Array.isArray(field.select_options) ? field.select_options
      : Array.isArray(field.options) ? field.options : [];
    const raw = String(value).trim();
    if (!options.length) return undefined;
    const findOption = (v) => options.find(o => String(o?.value ?? o?.name ?? "").trim().toLowerCase() === String(v).trim().toLowerCase());
    if (type === "single_select") {
      const option = findOption(raw);
      return option ? String(option.value ?? option.name) : undefined;
    }
    const values = Array.isArray(value) ? value : [value];
    return values.map(v => findOption(v)).filter(Boolean).map(o => String(o.value ?? o.name));
  }
  if (type === "date" || type === "last_modified" || type === "created_on") {
    const d = value instanceof Date ? value : new Date(Number(value) > 10000000000 ? Number(value) : Number(value) * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return String(value).slice(0, 2000);
}

async function baserowSyncResource(item) {
  if (!BASEROW_TOKEN || !BASEROW_TABLE_ID || !item) return;
  try {
    const fields = await getBaserowFields();
    if (!fields.length) throw new Error("Baserow 表没有可用字段");

    const titleField = baserowPickField(fields, ["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"]);
    const chatField = baserowPickField(fields, ["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
    const messageField = baserowPickField(fields, ["消息ID","资源ID","Message ID","MessageID"]);
    const captionField = baserowPickField(fields, ["描述","说明","备注","Caption","Description"]);
    const folderField = baserowPickField(fields, ["文件夹","目录","分类","Folder","Directory","Category"]);
    const dateField = baserowPickField(fields, ["日期","时间","创建时间","资源日期","Date","Created","Created At"]);
    const typeField = baserowPickField(fields, ["类型","文件类型","Type","File Type"]);
    const fileIdField = baserowPickField(fields, ["文件ID","File ID","FileID"]);
    const downloadField = baserowPickField(fields, ["下载","下载次数","Downloads"]);

    // 如果模板没有匹配名称字段，使用第一个可写文本字段作为主字段，确保扫描结果至少能落一行。
    const primary = titleField || fields.find(f => !f.read_only && ["text","long_text","url"].includes(String(f.type||"")));
    if (!primary) throw new Error("Baserow 没有可写的文本字段，请在表格增加“资源名称”字段");

    const payload = {};
    payload[primary.name] = baserowValueForField(primary, item.title || "未命名资源");
    if (chatField) payload[chatField.name] = baserowValueForField(chatField, item.chatId);
    if (messageField) payload[messageField.name] = baserowValueForField(messageField, item.messageId);
    if (captionField) payload[captionField.name] = baserowValueForField(captionField, item.caption || "");
    if (folderField) {
      const d = db.directories.find(x => String(x.id) === String(item.directoryId || ""));
      const folderValue = baserowValueForField(folderField, d?.name || "");
      if (folderValue !== undefined) payload[folderField.name] = folderValue;
    }
    if (dateField) payload[dateField.name] = baserowValueForField(dateField, item.date);
    if (typeField) {
      const typeValue = baserowValueForField(typeField, item.fileType || "Resource");
      if (typeValue !== undefined) payload[typeField.name] = typeValue;
    }
    if (fileIdField) payload[fileIdField.name] = baserowValueForField(fileIdField, item.fileId || "");
    if (downloadField) payload[downloadField.name] = baserowValueForField(downloadField, Number(item.downloads || 0));

    // 优先使用本地保存的 Baserow 行 ID 更新，避免重复。
    if (item.baserowRowId) {
      try {
        const updated = await baserowRequest(
          "PATCH",
          "/api/database/rows/table/" + encodeURIComponent(BASEROW_TABLE_ID) + "/" + encodeURIComponent(item.baserowRowId) + "/?user_field_names=true",
          payload
        );
        baserow.connected = true;
        baserow.lastOkAt = Date.now();
        return updated;
      } catch (e) {
        // 行可能已被人工删除，清掉 ID 后重新创建。
        item.baserowRowId = null;
      }
    }

    // 新资源创建一行，并把行 ID 保存回本地资源。
    const created = await baserowRequest(
      "POST",
      "/api/database/rows/table/" + encodeURIComponent(BASEROW_TABLE_ID) + "/?user_field_names=true",
      payload
    );
    item.baserowRowId = created?.id || null;
    baserow.connected = true;
    baserow.lastError = "";
    baserow.lastOkAt = Date.now();
    return created;
  } catch (e) {
    baserow.connected = false;
    baserow.lastError = String(e?.message || e);
    console.error("❌ Baserow 资源同步失败:", baserow.lastError);
    return null;
  }
}

function queueBaserowResourceSync(item) {
  if (!BASEROW_TOKEN || !BASEROW_TABLE_ID || !item) return;
  baserowSyncQueue = baserowSyncQueue
    .then(() => baserowSyncResource(item))
    .catch(e => console.error("❌ Baserow 同步队列:", e.message));
}

async function waitBaserowSyncQueue() {
  await baserowSyncQueue;
}


async function ensureStartCommand(token) {
  try {
    const commands = await tg(token, "getMyCommands");
    const list = Array.isArray(commands) ? commands : [];
    if (!list.some(x => x.command === "start")) {
      await tg(token, "setMyCommands", {
        commands: [
          {command:"start", description:"🏠 开始使用"},
          ...list.filter(x => x.command !== "start")
        ]
      });
    }
  } catch (e) {
    console.error("COMMAND MENU:", e.message);
  }
}

async function tgUploadBuffer(token, method, chatId, buffer, fileName, caption="") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(method === "sendVideo" ? "video" : "document", new Blob([buffer]), fileName || "resource");
  if (caption) form.append("caption", String(caption).slice(0,1024));
  if (contentProtectionEnabled()) form.append("protect_content", "true");
  const r = await fetch(api(token, method), {method:"POST", body:form});
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || method + " failed");
  if (j.result?.message_id) scheduleAutoDelete(token,chatId,[j.result.message_id]);
  return j.result;
}
function normalizeText(text) {
  return String(text ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function prettyText(text) {
  return normalizeText(text);
}

const send = (token, chat_id, text, extra = {}) =>
  tg(token, "sendMessage", {chat_id, text:prettyText(text), ...extra});

const sendHtml = (token, chat_id, text, extra = {}) =>
  tg(token, "sendMessage", {chat_id, text:normalizeText(text), parse_mode:"HTML", ...extra});

function emptyDb() {
  return {offset:0, users:[], children:[], resources:[], directories:[], settings:{requiredGroup:null, repository:null, historyAuth:null, historyScan:{status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""},broadcastPin:false,admins:[],logs:[],stats:{downloads:0,searches:0,uploads:0,uploadedResources:0,userActions:{}},userFavorites:{},userRecent:{},sharedData:{version:1,lastChangedAt:Date.now(),lastChangedBy:"system"},nonMemberMessage:"🔐 <b>请先加入指定会员群</b>\n\n加入后即可继续使用资源功能。",postResourceMessage:"✨ <b>更多资源</b>\n\n欢迎继续浏览资源库。",nonMemberDailyLimit:3,nonMemberDailyUsage:{},contentProtection:true,autoDeleteMinutes:1440,autoDeleteQueue:[]}};
}
function logAdmin(uid,action,detail="") {
  if(!db.settings.logs) db.settings.logs=[];
  db.settings.logs.unshift({uid:String(uid),action:String(action),detail:String(detail).slice(0,300),at:Date.now()});
  db.settings.logs=db.settings.logs.slice(0,200);
}
function recordStat(uid,type,count=1) {
  if(!db.settings.stats || typeof db.settings.stats!=="object") db.settings.stats={downloads:0,searches:0,uploads:0,uploadedResources:0,userActions:{}};
  const stats=db.settings.stats;
  if(!stats.userActions || typeof stats.userActions!=="object") stats.userActions={};
  const id=String(uid||"");
  if(!id) return;
  if(type==="download") stats.downloads+=Number(count)||0;
  if(type==="search") stats.searches+=Number(count)||0;
  if(type==="upload") stats.uploads+=Number(count)||0;
  if(type==="uploadedResource") stats.uploadedResources+=Number(count)||0;
  if(!stats.userActions[id]) stats.userActions[id]={downloads:0,searches:0,uploads:0,uploadedResources:0,lastActive:0};
  const u=stats.userActions[id];
  if(type==="download") u.downloads+=Number(count)||0;
  if(type==="search") u.searches+=Number(count)||0;
  if(type==="upload") u.uploads+=Number(count)||0;
  if(type==="uploadedResource") u.uploadedResources+=Number(count)||0;
  u.lastActive=Date.now();
}
function recordUserActivity(uid) {
  if(!uid) return;
  if(!db.settings.stats || typeof db.settings.stats!=="object") db.settings.stats={downloads:0,searches:0,uploads:0,uploadedResources:0,userActions:{}};
  if(!db.settings.stats.userActions || typeof db.settings.stats.userActions!=="object") db.settings.stats.userActions={};
  const id=String(uid);
  if(!db.settings.stats.userActions[id]) db.settings.stats.userActions[id]={downloads:0,searches:0,uploads:0,uploadedResources:0,lastActive:0};
  db.settings.stats.userActions[id].lastActive=Date.now();
}
function normalizeDb(raw) {
  const base = emptyDb();
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    ...base,
    ...value,
    settings: {
      ...base.settings,
      ...(value.settings && typeof value.settings === "object" ? value.settings : {})
    }
  };
}
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function loadDb() {
  const primary = readJsonFile(DATA_FILE);
  if (primary) return normalizeDb(primary);

  // 主文件损坏/不存在时，自动尝试最近一次备份。
  const backup = readJsonFile(BACKUP_FILE);
  if (backup) {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
      const tmp = DATA_FILE + ".recovered.tmp";
      fs.writeFileSync(tmp, JSON.stringify(normalizeDb(backup), null, 2));
      fs.renameSync(tmp, DATA_FILE);
      console.warn("⚠️ 主数据库不可用，已从备份恢复:", BACKUP_FILE);
    } catch (e) {
      console.error("❌ 数据库恢复失败:", e.message);
    }
    return normalizeDb(backup);
  }

  console.warn("⚠️ 未找到数据库文件，将创建新的数据库:", DATA_FILE);
  return emptyDb();
}
let lastSavedJson = "";
function saveDb() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
    const json = JSON.stringify(db, null, 2);
    if (json === lastSavedJson) return;
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DATA_FILE);

    // 每次成功保存后同步生成一份可恢复备份。
    if (BACKUP_FILE !== DATA_FILE) {
      fs.mkdirSync(path.dirname(BACKUP_FILE), {recursive:true});
      const backupTmp = BACKUP_FILE + ".tmp";
      fs.writeFileSync(backupTmp, json);
      fs.renameSync(backupTmp, BACKUP_FILE);
    }
    lastSavedJson = json;
  } catch (e) {
    console.error("❌ SAVE:", e.message);
    console.error("❌ 当前数据文件:", DATA_FILE);
    console.error("❌ 备份文件:", BACKUP_FILE);
  }
}
const db = loadDb();
if (!db.settings) db.settings = emptyDb().settings;
if (!Array.isArray(db.settings.admins)) db.settings.admins = [];
if (!Array.isArray(db.settings.logs)) db.settings.logs = [];
if (!("historyAuth" in db.settings)) db.settings.historyAuth = null;
if (!db.settings.historyScan) db.settings.historyScan = {status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:"",lastMessageId:0};
if (!("lastMessageId" in db.settings.historyScan)) db.settings.historyScan.lastMessageId = 0;
if (!db.settings.userFavorites || typeof db.settings.userFavorites!=="object") db.settings.userFavorites={};
if (!db.settings.userRecent || typeof db.settings.userRecent!=="object") db.settings.userRecent={};
if (typeof db.settings.contentProtection !== "boolean") db.settings.contentProtection = true;
if (!Number.isFinite(Number(db.settings.autoDeleteMinutes))) db.settings.autoDeleteMinutes = 1440;
if (!Array.isArray(db.settings.autoDeleteQueue)) db.settings.autoDeleteQueue = [];
if (!db.settings.sharedData || typeof db.settings.sharedData!=="object") db.settings.sharedData={version:1,lastChangedAt:Date.now(),lastChangedBy:"system"};
if (!Number.isFinite(Number(db.settings.sharedData.version))) db.settings.sharedData.version=1;
if (!db.settings.sharedData.lastChangedAt) db.settings.sharedData.lastChangedAt=Date.now();
function touchSharedData(uid="system") {
  if(!db.settings.sharedData || typeof db.settings.sharedData!=="object") db.settings.sharedData={version:1,lastChangedAt:Date.now(),lastChangedBy:String(uid)};
  db.settings.sharedData.version=Number(db.settings.sharedData.version||0)+1;
  db.settings.sharedData.lastChangedAt=Date.now();
  db.settings.sharedData.lastChangedBy=String(uid||"system");
}

let historyClient = null;
let historyConnecting = null;
let TelegramClientClass = null;
let StringSessionClass = null;
const historyInputs = new Map();
const uploadTimers = new Map();
const uploadAckTimers = new Map();
const finalizingUploads = new Set();
const childRunners = new Map();
const UPLOAD_TIMEOUT_MS = UPLOAD_IDLE_SECONDS * 1000;

function askHistoryInput(uid, step, prompt) {
  return new Promise(resolve => {
    historyInputs.set(String(uid), {step, resolve});
    send(TOKEN, uid, prompt).catch(() => {});
  });
}

async function loadTeleproto() {
  if (TelegramClientClass && StringSessionClass) return;
  const mod = await import("teleproto");
  const sessions = await import("teleproto/sessions/index.js");
  TelegramClientClass = mod.TelegramClient;
  StringSessionClass = sessions.StringSession;
  if (!TelegramClientClass || !StringSessionClass) throw new Error("teleproto 模块加载失败");
}

async function createHistoryClient() {
  await loadTeleproto();
  const auth = db.settings.historyAuth || {};
  const apiId = Number(auth.apiId || TG_API_ID || 0);
  const apiHash = auth.apiHash ? decrypt(auth.apiHash) : TG_API_HASH;
  const session = auth.session ? decrypt(auth.session) : (process.env.TG_SESSION || "");
  if (!apiId || !apiHash) throw new Error("未配置 TG_API_ID / TG_API_HASH");
  const client = new TelegramClientClass(new StringSessionClass(session), apiId, apiHash, {connectionRetries:5, autoReconnect:true});
  return {client, apiId, apiHash};
}

async function ensureHistoryClient(uid) {
  if (historyClient) return historyClient;
  if (historyConnecting) return historyConnecting;
  historyConnecting = (async () => {
    const connectionTimeout = (promise, ms, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + "（超过 " + Math.round(ms/1000) + " 秒）")), ms))
    ]);
    const auth = db.settings.historyAuth || {};
    const hasApi = Boolean(auth.apiId || TG_API_ID) && Boolean(auth.apiHash || TG_API_HASH);
    if (!hasApi) {
      const apiIdText = await askHistoryInput(uid, "api_id", "🔐 历史扫描首次授权\n\n请发送你的 Telegram API ID。\n\n获取位置：my.telegram.org → API development tools");
      const apiId = Number(String(apiIdText).trim());
      if (!Number.isInteger(apiId) || apiId <= 0) throw new Error("API ID 格式不正确");
      const apiHash = await askHistoryInput(uid, "api_hash", "现在发送 Telegram API HASH。\n\n⚠️ 不要把 Bot Token 发到这里。");
      if (!String(apiHash).trim()) throw new Error("API HASH 不能为空");
      db.settings.historyAuth = {apiId, apiHash:encrypt(String(apiHash).trim()), session:null, phone:null};
      saveDb();
    }

    const current = db.settings.historyAuth || {};
    const {client, apiId, apiHash} = await createHistoryClient();
    let authorized = false;
    try {
      await connectionTimeout(client.connect(), 20000, "Telegram 扫描账号连接超时");
      await connectionTimeout(client.getMe(), 10000, "Telegram 扫描账号登录状态检查超时");
      authorized = true;
      try {
        const me = await client.getMe();
        console.log("✅ MTProto 扫描账号已连接:", me?.username ? "@" + me.username : String(me?.id || ""));
      } catch {}
    } catch {}

    if (!authorized) {
      const phone = current.phone || await askHistoryInput(uid, "phone", "📱 请输入用于历史扫描的 Telegram 手机号（含国家区号，例如 +886...）。");
      db.settings.historyAuth = {...current, apiId, apiHash:encrypt(apiHash), phone:String(phone).trim()};
      saveDb();
      await client.start({
        phoneNumber: () => Promise.resolve(db.settings.historyAuth.phone),
        phoneCode: () => askHistoryInput(uid, "phone_code", "📩 Telegram 已发送登录验证码。\n\n请输入验证码："),
        password: () => askHistoryInput(uid, "password", "🔑 你的 Telegram 账号启用了两步验证。\n\n请输入 2FA 密码："),
        onError: e => console.error("MTProto AUTH:", e.message)
      });
      db.settings.historyAuth.session = encrypt(client.session.save());
      saveDb();
    }
    historyClient = client;
    console.log("✅ MTProto history client ready");
    return historyClient;
  })().catch(async e => {
    console.error("❌ MTProto SCAN ACCOUNT:", e?.message || e);
    try { await sendHtml(TOKEN, uid,
      "<b>❌ Telegram 扫描账号连接失败</b>\\n\\n" +
      "⚠️ " + escapeHtml(e?.message || "未知连接错误") + "\\n\\n" +
      "💡 如果这个账号已经在资源频道里，请先在 Telegram 客户端打开一次该频道，然后重新点击「🚀 扫描并上传」。"
    ); } catch {}
    throw e;
  });
  try { return await historyConnecting; }
  finally { historyConnecting = null; }
}

async function findHistoryEntity(client) {
  const r = repo();
  if (!r) throw new Error("尚未绑定资源仓库");

  const targetId = String(r.chatId || "").trim();
  const targetUsername = String(r.username || "").replace(/^@/, "").trim().toLowerCase();
  const targetTitle = String(r.title || "").trim().toLowerCase();

  const normalizeId = value => {
    const s = String(value ?? "").trim();
    if (!s) return "";
    if (s.startsWith("-100")) return s;
    if (/^\d+$/.test(s)) return "-100" + s;
    return s;
  };

  const sameId = (a, b) => {
    const x = String(a ?? "").trim();
    const y = String(b ?? "").trim();
    if (!x || !y) return false;
    return x === y || normalizeId(x) === normalizeId(y);
  };

  if (targetUsername) {
    try {
      const entity = await client.getEntity(targetUsername);
      console.log("✅ MTProto 仓库通过 username 找到:", targetUsername, "id=", String(entity?.id || ""));
      return entity;
    } catch (e) {
      console.warn("⚠️ MTProto username 获取失败，继续扫描 dialogs:", targetUsername, e?.message || e);
    }
  }

  const matches = [];
  let dialogCount = 0;

  // 不限制 1000 个对话，避免仓库不在前 1000 个时被误判为找不到。
  for await (const d of client.iterDialogs({})) {
    dialogCount++;
    const entity = d?.entity || d;
    const entityId = String(entity?.id ?? "").trim();
    const dialogId = String(d?.id ?? "").trim();
    const username = String(entity?.username || d?.username || "")
      .replace(/^@/, "").trim().toLowerCase();
    const title = String(entity?.title || d?.title || "").trim().toLowerCase();

    if (targetId && (sameId(entityId, targetId) || sameId(dialogId, targetId))) {
      console.log("✅ MTProto 仓库通过 chatId 找到:", {
        targetId, entityId, title: entity?.title || entity?.username || ""
      });
      return entity;
    }

    if (targetUsername && username === targetUsername) {
      console.log("✅ MTProto 仓库通过 dialog username 找到:", username, "id=", entityId);
      return entity;
    }

    if (targetTitle && title === targetTitle) matches.push(entity);
  }

  if (matches.length === 1) {
    const entity = matches[0];
    console.log("✅ MTProto 仓库通过唯一标题自动找到:", {
      title: entity?.title || "",
      id: String(entity?.id || "")
    });
    return entity;
  }

  console.error("❌ MTProto 仓库匹配失败:", {
    targetId, targetUsername, targetTitle, dialogCount, titleMatches: matches.length
  });

  if (matches.length > 1) {
    throw new Error("扫描账号看到了多个同名资源仓库，无法安全自动选择。请重新绑定当前资源仓库。");
  }

  throw new Error("MTProto 扫描账号已经登录，但没有匹配到当前资源仓库。请确认扫描账号已经加入当前仓库，并在 Telegram 客户端打开过该仓库。");
}

function indexHistoryMessage(message, chatId) {
  const id = Number(message?.id || 0);
  if (!id) return false;
  const text = String(message?.message || message?.text || "").trim();
  const fileName = message?.file?.name || message?.document?.attributes?.find?.(x => x.fileName)?.fileName || "";
  const hasMedia = Boolean(message?.media || message?.file);
  if (!text && !hasMedia) return false;
  const item = {
    chatId:String(chatId),
    messageId:id,
    title:String(fileName || text || ("历史资源 #" + id)).slice(0,200),
    caption:text.slice(0,500),
    date:message?.date ? Math.floor(new Date(message.date).getTime()/1000) : Math.floor(Date.now()/1000),
    directoryId:null
  };
  const i=db.resources.findIndex(x=>x.chatId===item.chatId&&x.messageId===item.messageId);
  if(i>=0) {
    db.resources[i]={...db.resources[i],...item,directoryId:item.directoryId ?? db.resources[i].directoryId ?? null};
  } else {
    db.resources.unshift(item);
  }
  queueBaserowResourceSync(db.resources.find(x=>x.chatId===item.chatId&&x.messageId===item.messageId) || item);
  return true;
}

async function scanHistory(uid) {
  if (db.settings.historyScan.status === "running") return send(TOKEN,uid,"🔍 历史扫描已经在进行中，请稍候。");
  const r = repo();
  if (!r) return send(TOKEN,uid,"❌ <b>尚未绑定资源仓库</b>\\n\\n请先进入「📦 资源仓库」完成绑定。",adminMenu());

  const previousCheckpoint=Number(db.settings.historyScan.lastMessageId||0);
  const startedAt=Date.now();
  db.settings.historyScan={status:"running",scanned:0,indexed:0,startedAt,finishedAt:null,error:"",lastMessageId:previousCheckpoint};
  saveDb();

  let progressMessage = null;
  const elapsedText = () => {
    const seconds=Math.max(0,Math.floor((Date.now()-startedAt)/1000));
    const mm=String(Math.floor(seconds/60)).padStart(2,"0");
    const ss=String(seconds%60).padStart(2,"0");
    return mm+":"+ss;
  };
  const updateProgress = async (scanned,indexed,boundary,force=false) => {
    db.settings.historyScan.scanned=scanned;
    db.settings.historyScan.indexed=indexed;
    db.settings.historyScan.lastMessageId=boundary;
    saveDb();
    const text =
      "🔄 <b>正在扫描历史资源</b>\\n"+
      "━━━━━━━━━━━━━━\\n"+
      "📦 仓库：<b>"+escapeHtml(r.title)+"</b>\\n"+
      "📨 已扫描：<b>"+scanned.toLocaleString()+"</b> 条\\n"+
      "✨ 已发现：<b>"+indexed.toLocaleString()+"</b> 条\\n"+
      "⏱️ 已用时：<b>"+elapsedText()+"</b>\\n"+
      "🆔 当前进度：<code>"+boundary+"</code>\\n"+
      "━━━━━━━━━━━━━━\\n\\n"+
      "⏳ 正在建立资源索引\\n"+
      "请稍候…";
    if(!progressMessage || force){
      if(!progressMessage){
        try {
          progressMessage=await sendHtml(TOKEN,uid,text,{reply_markup:{inline_keyboard:[]}});
        } catch(e) {
          console.warn("⚠️ 无法发送扫描进度消息：",e.message);
        }
      }
      return;
    }
    try {
      await safeEdit(TOKEN,{
        chat_id:uid,
        message_id:progressMessage.message_id,
        text,
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[]}
      });
    } catch(e) {
      console.warn("⚠️ 扫描进度更新失败，继续扫描：",e.message);
    }
  };

  try {
    console.log("🔎 HISTORY SCAN START:", { uid:String(uid), repoId:String(r.chatId||""), repoTitle:String(r.title||""), checkpoint:previousCheckpoint, baserow:Boolean(BASEROW_TOKEN && BASEROW_TABLE_ID) });
    await updateProgress(0,0,previousCheckpoint,true);
    console.log("🔎 HISTORY SCAN: progress message sent, connecting MTProto...");
    const client = await ensureHistoryClient(uid);
    console.log("🔎 HISTORY SCAN: MTProto ready, locating repository...");
    const entity = await findHistoryEntity(client);
    console.log("🔎 HISTORY SCAN: repository located, starting history iteration");
    let scanned = 0, indexed = 0, boundary = previousCheckpoint;
    for await (const message of client.iterMessages(entity,{limit:undefined})) {
      const messageId=Number(message?.id||0);
      if (previousCheckpoint > 0 && messageId > 0 && messageId <= previousCheckpoint) break;
      scanned++;
      if (indexHistoryMessage(message,r.chatId)) indexed++;
      if (messageId > 0) boundary=messageId;

      if (scanned % 100 === 0) {
        await updateProgress(scanned,indexed,boundary);
        console.log("🔎 HISTORY SCAN:", scanned, "indexed=", indexed, "checkpoint=", boundary);
      }
    }

    db.resources=db.resources.slice(0,MAX_RESOURCES);
    await waitBaserowSyncQueue();
    db.settings.historyScan={status:"completed",scanned,indexed,startedAt,finishedAt:Date.now(),error:"",lastMessageId:boundary};
    saveDb();

    const doneText =
      "✅ <b>历史资源扫描完成</b>\\n"+
      "━━━━━━━━━━━━━━\\n"+
      "📦 仓库：<b>"+escapeHtml(r.title)+"</b>\\n"+
      "📨 扫描消息：<b>"+scanned.toLocaleString()+"</b> 条\\n"+
      "✨ 新增 / 更新：<b>"+indexed.toLocaleString()+"</b> 条\\n"+
      "📚 当前资源：<b>"+db.resources.length.toLocaleString()+"</b> 条\\n"+
      "⏱️ 扫描耗时：<b>"+elapsedText()+"</b>\\n"+
      "━━━━━━━━━━━━━━\\n"+
      "📌 <i>历史消息已建立索引</i>\\n"+
      "👇 现在可以使用搜索、随机获取和最新资源功能。";

    if(progressMessage){
      await safeEdit(TOKEN,{
        chat_id:uid,
        message_id:progressMessage.message_id,
        text:doneText,
        parse_mode:"HTML",
        reply_markup:adminMenu().reply_markup
      });
      return progressMessage;
    }
    return sendHtml(TOKEN,uid,doneText,adminMenu());
  } catch(e) {
    db.settings.historyScan.status="error";
    db.settings.historyScan.error=e.message;
    db.settings.historyScan.finishedAt=Date.now();
    saveDb();
    console.error("❌ HISTORY SCAN:",e);

    const errorText =
      "<b>❌ 历史扫描失败</b>\\n\\n"+
      "📦 <b>资源仓库</b>："+escapeHtml(r.title)+"\\n"+
      "🔎 已扫描："+Number(db.settings.historyScan.scanned||0)+" 条\\n"+
      "📚 已发现："+Number(db.settings.historyScan.indexed||0)+" 条\\n"+
      "⏱️ 已运行："+elapsedText()+"\\n\\n"+
      "⚠️ "+escapeHtml(e.message||"未知错误")+"\\n\\n"+
      "<i>如果扫描账号已经加入仓库，请重点检查 Telegram 登录状态、频道权限和历史消息读取权限。</i>";

    if(progressMessage){
      await safeEdit(TOKEN,{
        chat_id:uid,
        message_id:progressMessage.message_id,
        text:errorText,
        parse_mode:"HTML",
        reply_markup:adminMenu().reply_markup
      });
      return progressMessage;
    }
    return sendHtml(TOKEN,uid,errorText,adminMenu());
  }
}
const isSuperAdmin = id => ADMIN_IDS.has(String(id));
const isAdmin = id => isSuperAdmin(id) || db.settings.admins.includes(String(id));
const group = () => db.settings.requiredGroup;
const repo = () => db.settings.repository;

function encrypt(value) {
  const key = crypto.createHash("sha256").update(SECRET).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return [iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
function decrypt(value) {
  const [iv, tag, data] = value.split(".");
  const key = crypto.createHash("sha256").update(SECRET).digest();
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString();
}

async function allowed(token, userId) {
  const g = group();
  if (!g) return true;
  try {
    const m = await tg(token, "getChatMember", {chat_id:g.chatId, user_id:userId});
    return ["creator","administrator","member"].includes(m.status) || (m.status === "restricted" && m.is_member === true);
  } catch { return false; }
}
function quotaDateKey() {
  const d=new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function nonMemberDailyLimit() {
  const n=Number(db.settings.nonMemberDailyLimit);
  return Number.isFinite(n) && n>=0 ? Math.floor(n) : 3;
}
function nonMemberDailyUsed(uid) {
  if(!db.settings.nonMemberDailyUsage || typeof db.settings.nonMemberDailyUsage!=="object") db.settings.nonMemberDailyUsage={};
  const row=db.settings.nonMemberDailyUsage[String(uid)];
  if(!row || row.date!==quotaDateKey()) return 0;
  return Math.max(0,Number(row.used)||0);
}
function nonMemberDailyRemaining(uid) {
  if(isAdmin(uid)) return Infinity;
  return Math.max(0,nonMemberDailyLimit()-nonMemberDailyUsed(uid));
}
function consumeNonMemberQuota(uid,count) {
  if(isAdmin(uid) || !(Number(count)>0)) return;
  if(!db.settings.nonMemberDailyUsage || typeof db.settings.nonMemberDailyUsage!=="object") db.settings.nonMemberDailyUsage={};
  const id=String(uid), today=quotaDateKey(), row=db.settings.nonMemberDailyUsage[id];
  if(!row || row.date!==today) db.settings.nonMemberDailyUsage[id]={date:today,used:Number(count)||0};
  else row.used=Math.max(0,Number(row.used)||0)+(Number(count)||0);
  saveDb();
}
function quotaNoticeText() {
  return "🎁 <b>今日免费额度已用完</b>\\n\\n非会员每天可免费获取 <b>"+nonMemberDailyLimit()+" 个资源</b>。\\n今日剩余：<b>0</b> 个\\n\\n加入指定会员群后即可继续无限获取。";
}
async function sendQuotaNotice(token,chatId,uid,menu) {
  const remaining=nonMemberDailyRemaining(uid);
  if(remaining<=0) return sendHtml(token,chatId,quotaNoticeText(),menu||{});
  return sendHtml(token,chatId,"🎁 <b>非会员免费额度</b>\\n\\n今日还可以免费获取 <b>"+remaining+"</b> 个资源。\\n加入指定会员群后可不限量获取。",menu||{});
}
function nonMemberMessage(menu) {
  const text = String(db.settings.nonMemberMessage || "").trim() || "🔐 <b>请先加入指定会员群</b>\\n\\n加入后即可继续使用资源功能。";
  return {text, extra:menu||{}};
}
function postResourceMessage() {
  return String(db.settings.postResourceMessage || "").trim();
}
async function sendNonMemberNotice(token, chatId, menu) {
  const n = nonMemberMessage(menu);
  return sendHtml(token, chatId, n.text, n.extra);
}


function resourceKey(item){return String(item?.chatId??"")+":"+String(item?.messageId??"");}
function resourceByKey(key){const s=String(key||"");const p=s.lastIndexOf(":");if(p<1)return null;const chatId=s.slice(0,p),messageId=Number(s.slice(p+1));return db.resources.find(x=>String(x.chatId)===chatId&&Number(x.messageId)===messageId)||null;}
function userFavorites(uid){const k=String(uid);const a=Array.isArray(db.settings.userFavorites?.[k])?db.settings.userFavorites[k]:[];const v=a.filter(x=>!!resourceByKey(x));db.settings.userFavorites[k]=v.slice(0,500);return db.settings.userFavorites[k];}
function isFavorite(uid,item){return userFavorites(uid).includes(resourceKey(item));}
function toggleFavorite(uid,item){const k=String(uid),rk=resourceKey(item),a=userFavorites(uid),i=a.indexOf(rk);if(i>=0)a.splice(i,1);else a.unshift(rk);db.settings.userFavorites[k]=a.slice(0,500);saveDb();return i<0;}
function recordRecent(uid,item){if(!item)return;const k=String(uid),rk=resourceKey(item),a=Array.isArray(db.settings.userRecent?.[k])?db.settings.userRecent[k]:[];db.settings.userRecent[k]=[rk,...a.filter(x=>x!==rk)].slice(0,30);}
function recordResourceDownload(item){if(item)item.downloads=Number(item.downloads||0)+1;}
function resourceTags(item){const a=[];const d=db.directories.find(x=>String(x.id)===String(item?.directoryId));if(d?.name)a.push(String(d.name));if(item?.fileType)a.push(String(item.fileType));const m=String(item?.title||"").match(/\.([a-z0-9]{1,8})(?:\s|$)/i);if(m)a.push("."+m[1].toLowerCase());return [...new Set(a)].slice(0,4);}
function allResourceTags(){const m={};for(const x of db.resources)for(const t of resourceTags(x))(m[t]??=[]).push(x);return m;}
function userFeatureKeyboard(){return{inline_keyboard:[
 [{text:"⭐ 我的收藏",callback_data:"hub:fav"},{text:"🕘 最近浏览",callback_data:"hub:recent"}],
 [{text:"🔥 热门资源",callback_data:"hub:hot"},{text:"🏷️ 标签分类",callback_data:"hub:tags"}],
 [{text:"⬅️ 返回资源目录",callback_data:"dirs"}]
]};}
function userFeatureText(){return"✨ <b>我的资源</b>\n━━━━━━━━━━━━━━\n\n⭐ 收藏、🕘 最近浏览、🔥 热门资源、🏷️ 标签分类\n\n👇 请选择功能";}
function userFeatureListKeyboard(items,prefix,back="hub"){const rows=[];const list=items.slice(0,20);for(let i=0;i<list.length;i+=2){const row=[];for(let j=i;j<i+2&&j<list.length;j++){const x=list[j];row.push({text:(j+1)+". "+String(x.title||"未命名资源").slice(0,24),callback_data:prefix+resourceKey(x)});}rows.push(row);}if(!rows.length)rows.push([{text:"📭 暂无资源",callback_data:"noop"}]);rows.push([{text:"⬅️ 返回",callback_data:back}]);return{inline_keyboard:rows};}
function userFeatureListText(title,items,extra=""){return"<b>"+title+"</b>\n━━━━━━━━━━━━━━\n\n📚 共 <b>"+items.length+"</b> 个资源"+(extra?"\n"+extra:"")+"\n\n👇 点击资源名称获取";}
function adminMaintenanceMenu(){return{inline_keyboard:[
 [{text:"🔄 重复资源检查",callback_data:"admin:dupes"},{text:"🧹 仓库健康检查",callback_data:"admin:health"}],
 [{text:"🏷️ 标签统计",callback_data:"admin:tags"}],
 [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
]};}
function adminRootInline(){return{inline_keyboard:[
 [{text:"📤 上传资源",callback_data:"admin:upload"},{text:"📦 资源管理",callback_data:"admin:resource"}],
 [{text:"📊 数据与运营",callback_data:"admin:ops"},{text:"⚙️ 系统设置",callback_data:"admin:settings"}],
 [{text:"🤖 机器人管理",callback_data:"admin:bot"}],
 [{text:"🏠 返回首页",callback_data:"admin:home"}]
]};}
function adminResourceInline(){return{inline_keyboard:[
 [{text:"✏️ 修改文件夹",callback_data:"adm:rename"},{text:"🗑️ 删除资源",callback_data:"adm:delete"}],
 [{text:"🔄 移动资源",callback_data:"adm:move"},{text:"📦 批量管理",callback_data:"adm:bulk"}],
 [{text:"🔗 分享资源",callback_data:"adm:share"},{text:"📦 资源仓库",callback_data:"adm:repo"}],
 [{text:"🔍 仓库扫描",callback_data:"adm:scan"},{text:"🧹 资源维护",callback_data:"admin:maintenance"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function adminSettingsInline(){return{inline_keyboard:[
 [{text:"🔐 指定群管理",callback_data:"adm:group"},{text:"👥 管理员管理",callback_data:"adm:admins"}],
 [{text:"🎁 会员/配额设置",callback_data:"adm:quota"}],
 [{text:"🛡️ 内容保护",callback_data:"adm:protect"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function adminOpsInline(){return{inline_keyboard:[
 [{text:"📊 数据统计",callback_data:"adm:stats"},{text:"📢 广播消息",callback_data:"adm:broadcast"}],
 [{text:"📜 操作日志",callback_data:"adm:logs"},{text:"📌 广播后置顶",callback_data:"adm:pin"}],
 [{text:"📝 用户提示",callback_data:"admin:prompts"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function adminBotInline(){return{inline_keyboard:[
 [{text:"🤖 克隆机器人",callback_data:"adm:clone"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function quotaSettingsText(){return"<b>🎁 会员 / 非会员额度</b>\n━━━━━━━━━━━━━━\n\n👤 非会员每日免费：<b>"+nonMemberDailyLimit()+"</b> 个资源\n💎 会员：不限量\n\n👇 修改额度";}

function userMenu() {
  return {reply_markup:{keyboard:[
    ["📂 资源目录","🔎 搜索资源"],
    ["🎲 随机获取","🆕 最新资源"],
    ["⭐ 我的资源","🤖 克隆机器人"],
    ["🏠 开始"]
  ],resize_keyboard:true,input_field_placeholder:"选择功能"}};
}
function childMenu() {
  return {reply_markup:{keyboard:[
    ["📂 资源目录","🔎 搜索资源"],
    ["🎲 随机获取","🆕 最新资源"],
    ["⭐ 我的资源","🏠 开始"]
  ],resize_keyboard:true,input_field_placeholder:"选择功能"}};
}
function backMenu(admin=false) {
  return admin
    ? {reply_markup:{inline_keyboard:[[{text:"⬅️ 返回管理",callback_data:"admin:root"}]]}}
    : userMenu();
}
function adminMenu(){return{reply_markup:adminRootInline()};}
function adminResourceMenu(){return{reply_markup:adminResourceInline()};}
function adminSettingsMenu(){return{reply_markup:adminSettingsInline()};}
function adminOpsMenu(){return{reply_markup:adminOpsInline()};}
function adminBotMenu(){return{reply_markup:adminBotInline()};}
function uploadFolderInlineMenu() {
  const rows=[];
  let row=[];
  for(const d of db.directories) {
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    const name=String(d.name||"未命名").slice(0,18);
    row.push({
      text:"📁 "+name+" · "+count,
      callback_data:"upload_dir:"+d.id
    });
    if(row.length===2) {
      rows.push(row);
      row=[];
    }
  }
  if(row.length) rows.push(row);
  rows.push([
    {text:"➕ 新建文件夹",callback_data:"upload_new"},
    {text:"❌ 取消",callback_data:"upload_cancel"}
  ]);
  return {inline_keyboard:rows};
}
function deleteResourceMenu() {
  const rows = [];
  for (const d of db.directories) {
    const count = db.resources.filter(r => String(r.directoryId) === String(d.id)).length;
    if (count) rows.push(["📁 " + d.name + "（" + count + "）"]);
  }
  if (!rows.length) rows.push(["📭 暂无资源"]);
  rows.push(["⬅️ 返回管理"]);
  return {reply_markup:{keyboard:rows,resize_keyboard:true,input_field_placeholder:"选择要管理的文件夹"}};
}
function scanMenu() {
  return {reply_markup:{keyboard:[
    ["🔍 开始历史扫描","🔐 扫描授权"],
    ["⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"仓库扫描"}};
}
function platformMenu() {
  return adminSettingsMenu();
}
function getDirectoryByName(name) { const n=String(name||"").replace(/^📁\s*/,"").replace(/[（(]\s*\d+\s*[）)]\s*$/,"").replace(/\s+/g," ").trim().toLowerCase(); return db.directories.find(d=>{ const dn=String(d.name||"").replace(/[（(]\s*\d+\s*[）)]\s*$/,"").replace(/\s+/g," ").trim().toLowerCase(); return dn===n || String(d.name||"").trim().toLowerCase()===n; })||null; }
function ensureDirectory(name) { const clean=String(name||"").trim().slice(0,80); if(!clean)return null; let d=getDirectoryByName(clean); if(d)return d; d={id:crypto.randomUUID(),name:clean,createdAt:Date.now()}; db.directories.push(d); touchSharedData("system"); saveDb(); return d; }
function getResourceByShareToken(token) {
  const t=String(token||"").trim();
  if(!t) return null;
  return db.resources.find(r=>String(r.shareToken||"")===t) || null;
}
function ensureShareToken(item) {
  if(!item.shareToken) {
    item.shareToken=crypto.randomBytes(9).toString("base64url");
    item.shareCreatedAt=Date.now();
    if(!Array.isArray(db.settings.sharedResources)) db.settings.sharedResources=[];
    if(!db.settings.sharedResources.includes(item.shareToken)) db.settings.sharedResources.push(item.shareToken);
    saveDb();
  }
  return item.shareToken;
}
async function botUsername() {
  try {
    const me=await tg(TOKEN,"getMe");
    return String(me.username||"").trim();
  } catch { return ""; }
}
async function makeShareLink(item) {
  const username=await botUsername();
  if(!username) throw new Error("无法获取主机器人用户名");
  const token=ensureShareToken(item);
  return "https://t.me/"+username+"?start=share_"+token;
}
function moveFolderMenu(excludeId=null) {
  const rows=[];
  for(const d of db.directories) {
    if(excludeId && String(d.id)===String(excludeId)) continue;
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    rows.push([{text:"📁 "+String(d.name||"未命名").slice(0,28)+" · "+count,callback_data:"move_to:"+d.id}]);
  }
  if(!rows.length) rows.push([{text:"📭 没有其他文件夹",callback_data:"noop"}]);
  rows.push([{text:"❌ 取消",callback_data:"move_cancel"}]);
  return {inline_keyboard:rows};
}
function resourceMoveMenu(items,page=0,selected=[]) {
  const start=page*10;
  const pageItems=items.slice(start,start+10);
  const rows=[];
  for(let i=0;i<pageItems.length;i+=2) {
    const row=[];
    for(let j=i;j<i+2 && j<pageItems.length;j++) {
      const item=pageItems[j];
      const id=String(item.messageId);
      const mark=selected.includes(id)?"☑️ ":"";
      row.push({text:mark+(start+j+1)+". "+String(item.title||"未命名").slice(0,22),callback_data:"bulk_toggle:"+page+":"+j});
    }
    rows.push(row);
  }
  const nav=[];
  if(page>0) nav.push({text:"⬅️ 上一页",callback_data:"bulk_page:"+(page-1)});
  if(start+10<items.length) nav.push({text:"下一页 ➡️",callback_data:"bulk_page:"+(page+1)});
  if(nav.length) rows.push(nav);
  rows.push([{text:"📦 移动已选资源",callback_data:"bulk_move"}]);
  rows.push([{text:"🗑️ 删除已选资源",callback_data:"bulk_delete"}]);
  rows.push([{text:"❌ 取消",callback_data:"bulk_cancel"}]);
  return {inline_keyboard:rows};
}
function shareResourceKeyboard(token) {
  return {inline_keyboard:[
    [{text:"🔗 打开分享链接",url:token}],
    [{text:"🏠 返回首页",callback_data:"batch:home"}]
  ]};
}
async function finalizeUploadUnlocked(uid, state) {
  const items = Array.isArray(state?.pendingUploads) ? state.pendingUploads : [];
  if (!items.length) {
    states.delete("m:"+uid);
    return send(TOKEN,uid,"📭 <b>本次没有收到资源</b>\\n\\n当前批次没有可入库的资源。",adminMenu());
  }
  const r = repo();
  if (!r) {
    states.delete("m:"+uid);
    return send(TOKEN,uid,"❌ <b>资源仓库未绑定</b>\\n\\n请先绑定资源仓库，再进行上传。",adminMenu());
  }

  let directoryName = String(state.directoryName || "").trim();
  if (!directoryName) {
    directoryName = "未命名-" + Math.random().toString(36).slice(2, 8);
  }
  const d = ensureDirectory(directoryName);
  if (!d) {
    states.delete("m:"+uid);
    return send(TOKEN,uid,"❌ <b>文件夹创建失败</b>\\n\\n请稍后重试。",adminMenu());
  }

  let stored = 0;
  let failed = 0;

  // Telegram 批量复制：一次请求最多 100 条，并保留原有媒体组。
  const sortedItems=[...items].sort((a,b)=>Number(a.messageId)-Number(b.messageId));
  for(let offset=0; offset<sortedItems.length; offset+=100) {
    const batch=sortedItems.slice(offset,offset+100);
    const ids=batch.map(x=>Number(x.messageId));
    try {
      const copiedIds=await tg(TOKEN,"copyMessages",{chat_id:r.chatId,from_chat_id:uid,message_ids:ids});
      if(!Array.isArray(copiedIds) || copiedIds.length!==batch.length) throw new Error("批量转存结果数量不一致");
      for(let n=0;n<batch.length;n++) {
        const copiedId=Number(copiedIds[n]?.message_id ?? copiedIds[n]);
        if(!Number.isFinite(copiedId)) throw new Error("批量转存消息ID无效");
        const resourceMsg={...batch[n].msg,chat:{...(batch[n].msg?.chat||{}),id:r.chatId},message_id:copiedId};
        indexResource(resourceMsg);
        const item=db.resources.find(x=>String(x.chatId)===String(r.chatId)&&Number(x.messageId)===copiedId);
        if(!item) throw new Error("资源索引写入失败");
        item.directoryId=d.id;
        item.repositoryMessageId=copiedId;
        item.sourceUserId=String(uid);
        item.indexedAt=Date.now();
        stored++;
      }
    } catch(e) {
      failed+=batch.length;
      console.error("UPLOAD BATCH FINALIZE:",e.message,"count=",batch.length);
    }
  }

  recordStat(uid,"upload",1);
  recordStat(uid,"uploadedResource",stored);
  saveDb();
  logAdmin(uid,"结束上传",d.name+" / 收到"+items.length+" / 入库"+stored);

  states.delete("m:"+uid);

  return sendHtml(TOKEN,uid,
    "<b>📦 本批上传完成</b>\\n\\n"+
    "📁 文件夹：<b>"+escapeHtml(d.name)+"</b>\\n"+
    "📥 收到资源：<b>"+items.length+"</b> 个\\n"+
    "💾 已存入资源库：<b>"+stored+"</b> 个\\n"+
    (failed ? "⚠️ 入库失败：<b>"+failed+"</b> 个\\n" : "")+
    "\\n📚 文件夹已建立，资源已统一整理入库。",
    adminMenu()
  );
}
async function finalizeUpload(uid, state) {
  const lockKey=String(uid);
  if(finalizingUploads.has(lockKey)) return send(TOKEN,uid,"⏳ 正在整理本批资源，请不要重复点击结束上传。");
  finalizingUploads.add(lockKey);
  try {
    return await finalizeUploadUnlocked(uid,state);
  } finally {
    finalizingUploads.delete(lockKey);
  }
}

function directoryKeyboard() {
  const rows=[];
  for(const d of db.directories){
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    if(count) rows.push(["📁 "+d.name+"（"+count+"）"]);
  }
  if(!rows.length) rows.push(["📭 暂无分类"]);
  rows.push(["🏠 开始"]);
  return {reply_markup:{keyboard:rows,resize_keyboard:true,input_field_placeholder:"选择文件夹"}};
}
function folderFileKeyboard(items) {
  const rows=items.map((x,i)=>[(i+1)+". "+String(x.title||"未命名资源").slice(0,42)]);
  rows.push(["⬅️ 返回文件夹"]);
  return {reply_markup:{keyboard:rows,resize_keyboard:true,input_field_placeholder:"选择文件"}};
}
function directoryInlineKeyboard(page=0) {
  const all=db.directories.filter(d=>db.resources.some(r=>String(r.directoryId)===String(d.id)));
  const pageSize=20;
  const start=Math.max(0,Number(page)||0)*pageSize;
  const current=all.slice(start,start+pageSize);
  const rows=[];
  let row=[];
  for(const d of current){
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    row.push({text:"📁 "+String(d.name||"未命名").slice(0,18)+" · "+count,callback_data:"dir:"+d.id+":0"});
    if(row.length===2){ rows.push(row); row=[]; }
  }
  if(row.length) rows.push(row);
  if(!rows.length) rows.push([{text:"📭 暂无分类",callback_data:"noop"}]);
  const nav=[];
  if(start>0) nav.push({text:"⬅️ 上一页",callback_data:"dirsp:"+(page-1)});
  if(start+pageSize<all.length) nav.push({text:"下一页 ➡️",callback_data:"dirsp:"+(page+1)});
  if(nav.length) rows.push(nav);
  rows.push([{text:"⭐ 我的资源",callback_data:"hub"},{text:"🔥 热门",callback_data:"hub:hot"}]);
  return {inline_keyboard:rows};
}
function folderSummaryKeyboard(directoryId,count,offset=0) {
  const rows=[];
  if(offset<count) rows.push([{text:offset===0?"📦 获取全部资源":"➡️ 继续获取10个",callback_data:"get:"+directoryId+":"+offset}]);
  if(offset>0) rows.push([{text:"⬅️ 返回资源目录",callback_data:"dirs"}]);
  return {inline_keyboard:rows};
}
function folderProgressKeyboard(directoryId,count,nextOffset) {
  const rows=[];
  if(nextOffset<count) rows.push([{text:"➡️ 继续获取10个",callback_data:"get:"+directoryId+":"+nextOffset}]);
  else rows.push([{text:"✅ 已全部获取",callback_data:"done"}]);
  rows.push([{text:"⬅️ 返回资源目录",callback_data:"dirs"}]);
  return {inline_keyboard:rows};
}
function directoryItems(id) { return db.resources.filter(r=>String(r.directoryId)===String(id)).sort((a,b)=>Number(a.messageId)-Number(b.messageId)); }
function sendDirectoryBatch(token, chatId, items) {
  let sent = 0;
  return (async () => {
    for (const item of items) {
      try {
        await sendIndexedResource(token, chatId, item);
        sent++;
      } catch(e) {
        console.error("DIRECTORY SEND:",e.message,"chat=",item.chatId,"message=",item.messageId);
      }
      await sleep(80);
    }
    return sent;
  })();
}
function directoryText() {
  const dirs = Array.isArray(db.directories) ? db.directories : [];
  return ["📂 <b>资源目录</b>","━━━━━━━━━━━━━━","","📚 总资源：<b>"+db.resources.length+"</b> 条","📁 文件夹：<b>"+db.directories.length+"</b> 个","","👇 <i>请选择文件夹查看资源</i>"].join("\n");
}
function configText() {
  const g = group(), r = repo(), scan = db.settings.historyScan || {};
  return [
    "⚙️ <b>平台当前状态</b>",
    "",
    "🔐 <b>指定群</b>：" + (g ? "✅ " + g.title : "❌ 未绑定"),
    "📦 <b>资源仓库</b>：" + (r ? "✅ " + r.title : "❌ 未绑定"),
    "🔎 <b>历史扫描</b>：" + (scan.status==="completed" ? "✅ 已完成" : scan.status==="running" ? "⏳ 扫描中" : scan.status==="error" ? "⚠️ 上次失败" : "未执行"),
    "",
    "👤 用户：" + db.users.length,
    "🤖 子机器人：" + db.children.length,
    "📚 资源：" + db.resources.length
  ].join("\n");
}

function indexResource(msg) {
  const r = repo();
  if (!r || String(msg.chat?.id) !== String(r.chatId)) return;
  let fileType = null, fileId = null;
  if (msg.document) { fileType = "Document"; fileId = msg.document.file_id; }
  else if (msg.video) { fileType = "Video"; fileId = msg.video.file_id; }
  else if (msg.audio) { fileType = "Audio"; fileId = msg.audio.file_id; }
  else if (msg.animation) { fileType = "Animation"; fileId = msg.animation.file_id; }
  else if (msg.voice) { fileType = "Voice"; fileId = msg.voice.file_id; }
  else if (msg.video_note) { fileType = "VideoNote"; fileId = msg.video_note.file_id; }
  else if (msg.photo?.length) { fileType = "Photo"; fileId = msg.photo.at(-1).file_id; }
  const media = msg.document || msg.video || msg.audio || msg.animation || msg.voice || msg.video_note || msg.photo?.at(-1);
  if (!media && !msg.text) return;
  const item = {
    chatId:String(msg.chat.id),
    messageId:msg.message_id,
    title:(msg.document?.file_name || msg.audio?.file_name || msg.video?.file_name || msg.caption || msg.text || "未命名资源").slice(0,200),
    caption:(msg.caption || msg.text || "").slice(0,500),
    date:msg.date || Math.floor(Date.now()/1000),
    directoryId:null,
    fileType,
    fileId,
    textOnly:!media,
    downloads:0
  };
  const i=db.resources.findIndex(x=>x.chatId===item.chatId&&x.messageId===item.messageId);
  if(i>=0) {
    db.resources[i]={...db.resources[i],...item,directoryId:item.directoryId ?? db.resources[i].directoryId ?? null};
  } else {
    db.resources.unshift(item);
  }
  db.resources=db.resources.slice(0,MAX_RESOURCES);
  queueBaserowResourceSync(db.resources.find(x=>x.chatId===item.chatId&&x.messageId===item.messageId) || item);
  saveDb();
}
function contentProtectionEnabled() {
  return db.settings.contentProtection !== false;
}
function autoDeleteMinutes() {
  const n=Number(db.settings.autoDeleteMinutes);
  return Number.isFinite(n) && n>0 ? Math.floor(n) : 0;
}
function autoDeleteText() {
  const n=autoDeleteMinutes();
  if(!n) return "关闭";
  if(n<60) return n+" 分钟";
  if(n<1440) return Math.round(n/60)+" 小时";
  return Math.round(n/1440)+" 天";
}
function scheduleAutoDelete(token, chatId, messageIds) {
  const mins=autoDeleteMinutes();
  if(!contentProtectionEnabled() || mins<=0) return;
  const ids=(Array.isArray(messageIds)?messageIds:[messageIds]).map(Number).filter(Number.isFinite);
  if(!ids.length) return;
  if(!Array.isArray(db.settings.autoDeleteQueue)) db.settings.autoDeleteQueue=[];
  db.settings.autoDeleteQueue.push({
    token: encrypt(String(token||"")),
    chatId:String(chatId),
    messageIds:ids.slice(0,100),
    deleteAt:Date.now()+mins*60000,
    createdAt:Date.now()
  });
  db.settings.autoDeleteQueue=db.settings.autoDeleteQueue.slice(-5000);
  saveDb();
}
async function processAutoDeleteQueue() {
  const q=Array.isArray(db.settings.autoDeleteQueue)?db.settings.autoDeleteQueue:[];
  if(!q.length) return;
  const now=Date.now(), keep=[], due=[];
  for(const item of q) {
    if(Number(item.deleteAt||0)>now) keep.push(item);
    else due.push(item);
  }
  for(const item of due) {
    try {
      const token=decrypt(String(item.token||""));
      const ids=(Array.isArray(item.messageIds)?item.messageIds:[]).map(Number).filter(Number.isFinite);
      for(let i=0;i<ids.length;i+=100) {
        const batch=ids.slice(i,i+100);
        if(batch.length) await tg(token,"deleteMessages",{chat_id:item.chatId,message_ids:batch});
      }
    } catch(e) {
      console.warn("⚠️ 自动删除失败，5分钟后重试：",e.message);
      item.deleteAt=Date.now()+5*60000;
      keep.push(item);
    }
  }
  db.settings.autoDeleteQueue=keep.slice(-5000);
  if(due.length) saveDb();
}
function contentProtectionMenu() {
  const on=contentProtectionEnabled();
  const mins=autoDeleteMinutes();
  return {inline_keyboard:[
    [{text:(on?"🛡️ 内容保护：开启":"🔓 内容保护：关闭"),callback_data:"protect:toggle"}],
    [{text:"⏱️ 自动删除："+autoDeleteText(),callback_data:"protect:duration"}],
    [{text:"1小时",callback_data:"protect:set:60"},{text:"6小时",callback_data:"protect:set:360"},{text:"24小时",callback_data:"protect:set:1440"}],
    [{text:"3天",callback_data:"protect:set:4320"},{text:"关闭自动删除",callback_data:"protect:set:0"}],
    [{text:"⬅️ 返回系统设置",callback_data:"admin:settings"}]
  ]};
}
function contentProtectionText() {
  const protection = contentProtectionEnabled();
  const deletion = autoDeleteMinutes() > 0;
  return [
    "<b>🛡️ 内容保护</b>",
    "━━━━━━━━━━━━━━",
    "🛡️ 防转发/保存：<b>"+(protection ? "开启" : "关闭")+"</b>",
    "⏱️ 自动删除：<b>"+autoDeleteText()+"</b>",
    "━━━━━━━━━━━━━━",
    protection && deletion
      ? "📌 用户获取的资源将在 "+autoDeleteText()+" 后自动删除。"
      : "💡 开启内容保护后，可设置资源消息自动删除时间。"
  ].join("\\n");
}
async function sendIndexedResource(token, chatId, item) {
  // file_id 属于生成它的 Bot，不能直接跨 Bot 使用。
  // 子机器人没有加入资源仓库时，优先让主机器人代发资源。
  const sendWith = async (sendToken) => {
    if (item.fileId && item.fileType) {
      const field = item.fileType.toLowerCase();
      const body = {chat_id:chatId, [field]:item.fileId};
      if (item.caption) body.caption = String(item.caption).slice(0,1024);
      if (contentProtectionEnabled()) body.protect_content = true;
      const sent = await tg(sendToken, "send" + item.fileType, body);
      if (sent?.message_id) scheduleAutoDelete(sendToken,chatId,[sent.message_id]);
      return sent;
    }
    if (item.textOnly) {
      const sent = await tg(sendToken, "sendMessage", {chat_id:chatId, text:item.caption || item.title || "未命名资源", ...(contentProtectionEnabled()?{protect_content:true}:{})});
      if (sent?.message_id) scheduleAutoDelete(sendToken,chatId,[sent.message_id]);
      return sent;
    }
    const sent = await tg(sendToken, "copyMessage", {chat_id:chatId,from_chat_id:item.chatId,message_id:Number(item.messageId),...(contentProtectionEnabled()?{protect_content:true}:{})});
    if (sent?.message_id) scheduleAutoDelete(sendToken,chatId,[sent.message_id]);
    return sent;
  };

  if (token === TOKEN) {
    return sendWith(TOKEN);
  }

  try {
    return await sendWith(token);
  } catch (e) {
    const message = String(e?.message || e);
    if (/chat not found|file.?id|wrong file|message to copy not found/i.test(message)) {
      console.warn("⚠️ 子机器人无法直接发送主机器人资源，改由主机器人代发：", message);
      return sendWith(TOKEN);
    }
    throw e;
  }
}
function search(q) {
  q=String(q||"").trim().toLowerCase();
  if(!q) return [];
  return db.resources.filter(x=>(String(x.title||"")+" "+String(x.caption||"")+" "+String(x.directoryId||"")).toLowerCase().includes(q));
}
function random10(userId) {
  const arr=[...db.resources];
  if(!arr.length) return [];

  // 每个用户独立记录随机获取历史：资源未耗尽前尽量不重复。
  // 全部资源都获取过后自动开启下一轮，保证“每次随机获取”仍然随机。
  if(!db.settings.randomHistory || typeof db.settings.randomHistory!=="object") {
    db.settings.randomHistory={};
  }
  const key=String(userId);
  const validIds=new Set(arr.map(x=>String(x.id||x.messageId||"")));
  let history=Array.isArray(db.settings.randomHistory[key])
    ? db.settings.randomHistory[key].filter(id=>validIds.has(String(id)))
    : [];

  let pool=arr.filter(x=>!history.includes(String(x.id||x.messageId||"")));
  if(!pool.length) {
    history=[];
    pool=[...arr];
  }

  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }

  const batch=pool.slice(0,10);
  history.push(...batch.map(x=>String(x.id||x.messageId||"")));
  db.settings.randomHistory[key]=history.slice(-arr.length);
  saveDb();
  return batch;
}
function resourceInlineKeyboard(items,page=0) {
  const start=page*10;
  const pageItems=items.slice(start,start+10);
  const rows=[];
  for(let i=0;i<pageItems.length;i+=2) {
    const row=[];
    for(let j=i;j<i+2 && j<pageItems.length;j++) {
      const item=pageItems[j];
      row.push({
        text:(start+j+1)+". "+String(item.title||"未命名资源").slice(0,28),
        callback_data:"sr:"+page+":"+(j)
      });
    }
    rows.push(row);
  }
  const nav=[];
  if(page>0) nav.push({text:"⬅️ 上一页",callback_data:"srp:"+(page-1)});
  if(start+10<items.length) nav.push({text:"下一页 ➡️",callback_data:"srp:"+(page+1)});
  if(nav.length) rows.push(nav);
  rows.push([{text:"❌ 关闭搜索",callback_data:"src"}]);
  return {reply_markup:{inline_keyboard:rows}};
}
function escapeHtml(value) {
  return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function deliverFromHistory(token,chatId,userId,items,options={}) {
  const member=await allowed(TOKEN,userId);
  if (!items.length) return sendHtml(token,chatId,"<b>📭 暂无相关资源</b>\n\n暂时没有找到可用内容。",childMenu());
  if(!member && !isAdmin(userId)) {
    const remaining=nonMemberDailyRemaining(userId);
    if(remaining<=0) return sendQuotaNotice(token,chatId,userId,childMenu());
    items=items.slice(0,remaining);
  }
  try {
    const client=await ensureHistoryClient(userId);
    const entity=await findHistoryEntity(client);
    let ok=0,fail=0;
    for(const item of items){
      try{
        const found=await client.getMessages(entity,{ids:[Number(item.messageId)]});
        const message=Array.isArray(found)?found[0]:found;
        if(!message||!message.media) throw new Error("历史消息或媒体不存在");
        const buffer=await client.downloadMedia(message,{});
        if(!buffer||!buffer.length) throw new Error("媒体下载失败");
        const file=message.file||{},mime=String(file.mimeType||""),name=String(file.name||item.title||"resource");
        const method=mime.startsWith("video")?"sendVideo":"sendDocument";
        await tgUploadBuffer(token,method,chatId,buffer,name,item.caption||"");
        ok++;
        recordResourceDownload(item);
        recordRecent(userId,item);
      }catch(e){fail++;console.error("HISTORY SEND:",e.message,"message=",item.messageId);}
      await sleep(150);
    }
    if(ok>0){recordStat(userId,"download",ok); if(!member && !isAdmin(userId)) consumeNonMemberQuota(userId,ok); else saveDb();}
    const mode=options.mode==="random"?"random":"latest";
    const offset=Math.max(0,Number(options.offset)||0);
    const total=Math.max(0,Number(options.total)||db.resources.length);
    await sendHtml(token,chatId,
      "<b>📦 本批资源获取完成</b>\n━━━━━━━━━━━━━━\n\n📤 成功发送：<b>"+ok+"</b> 条\n⚠️ 失败："+fail+" 条\n📚 本批："+items.length+" 条\n\n"+
      (mode==="random"?"🎲 可以继续随机获取下一批。":"🆕 可以继续浏览下一批最新资源。"),
      batchNavigation(mode,offset,total));
    if(postResourceMessage()) await sendHtml(token,chatId,postResourceMessage());
    return;
  }catch(e){
    console.error("HISTORY DELIVERY:",e);
    return sendHtml(token,chatId,"<b>❌ 资源获取失败</b>\n\n原因："+escapeHtml(e.message||e),childMenu());
  }
}
function batchNavigation(mode,offset,total){
  const rows=[];
  const next=Number(offset||0)+10;
  if(mode==="random"){
    rows.push([{text:"🎲 再来10个",callback_data:"batch:random"}]);
  } else if(mode==="latest"){
    const nav=[];
    if(Number(offset||0)>0) nav.push({text:"⬅️ 上一批",callback_data:"batch:latest:"+Math.max(0,Number(offset||0)-10)});
    if(next<Number(total||0)) nav.push({text:"下一批 ➡️",callback_data:"batch:latest:"+next});
    if(nav.length) rows.push(nav);
  }
  rows.push([{text:"🏠 返回首页",callback_data:"batch:home"}]);
  return {reply_markup:{inline_keyboard:rows}};
}

async function deliver(token,chatId,userId,items,sourceToken=TOKEN,options={}) {
  const member=await allowed(TOKEN,userId);
  if(!items.length) return send(token,chatId,"📭 <b>暂无相关资源</b>\\n\\n暂时没有找到可用内容。");

  let valid = items.filter(x => x && x.chatId && Number(x.messageId) > 0);
  if(!member && !isAdmin(userId)) {
    const remaining=nonMemberDailyRemaining(userId);
    if(remaining<=0) return sendQuotaNotice(token,chatId,userId);
    valid=valid.slice(0,remaining);
  }
  if(!valid.length) return send(token,chatId,"📭 <b>暂无可发送的资源</b>\\n\\n请稍后再试。");

  let ok = 0, fail = 0, lastError = "";
  const batchSize = 10;

  // 同一资源仓库的资源按 10 条一组复制，避免随机获取逐条发送。
  // 如果数据库里存在多个来源仓库，则按 chatId 自动分组，避免 Telegram 拒绝跨仓库批量复制。
  const groups = [];
  const groupMap = new Map();
  for(const item of valid) {
    const sourceChatId = String(item.chatId);
    if(!groupMap.has(sourceChatId)) {
      const group = {chatId:sourceChatId, items:[]};
      groupMap.set(sourceChatId,group);
      groups.push(group);
    }
    groupMap.get(sourceChatId).items.push(item);
  }

  for(const group of groups) {
    for(let offset=0; offset<group.items.length; offset+=batchSize) {
      const batch=group.items.slice(offset,offset+batchSize);
      try {
        const orderedBatch=[...batch].sort((a,b)=>Number(a.messageId)-Number(b.messageId));
        const copied=await tg(sourceToken,"copyMessages",{
          chat_id:chatId,
          from_chat_id:group.chatId,
          message_ids:orderedBatch.map(x=>Number(x.messageId)),
          ...(contentProtectionEnabled()?{protect_content:true}:{})
        });
        const copiedCount=Array.isArray(copied)?copied.length:0;
        ok+=copiedCount;
        if(Array.isArray(copied) && copied.length) scheduleAutoDelete(sourceToken,chatId,copied.map(x=>x?.message_id).filter(Boolean));
        if(copiedCount<batch.length) {
          fail+=batch.length-copiedCount;
          lastError="批量复制结果数量不完整";
        }
      } catch(e) {
        fail+=batch.length;
        lastError=e.message||String(e);
        console.error("COPY BATCH:",lastError,"chat=",group.chatId,"count=",batch.length);
      }
      if(offset+batchSize<group.items.length) await sleep(300);
    }
  }

  if(ok>0 && !member && !isAdmin(userId)) consumeNonMemberQuota(userId,ok);

  if(fail>0) {
    const total=valid.length;
    if(ok===0) {
      const isChatNotFound=/chat not found/i.test(lastError);
      return send(token,chatId,
        "❌ <b>资源暂时无法发送</b>\\n\\n"+
        "📦 找到资源："+total+" 条\\n"+
        "📤 成功发送：0 条\\n"+
        "⚠️ 发送失败："+fail+" 条\\n\\n"+
        (isChatNotFound
          ? "🔧 <b>需要管理员处理</b>\\n\\n请把当前机器人加入「资源仓库」。如果仓库是频道，请将机器人添加为频道管理员。\\n\\n历史扫描账号能看到资源，只代表扫描账号能读取历史消息；用户获取资源时，机器人本身也必须能够访问仓库消息。"
          : "🔧 <b>资源仓库读取失败</b>\\n\\n请确认机器人仍在资源仓库中，并有读取消息的权限。\\n\\nTelegram：<code>"+String(lastError).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+"</code>")
      ,{parse_mode:"HTML"});
    }
    return send(token,chatId,
      "⚠️ <b>本批获取完成</b>\\n\\n"+
      "📦 本组："+valid.length+" 个资源\\n"+
      "📤 成功："+ok+" 个\\n"+
      "⚠️ 失败："+fail+" 个",
      {parse_mode:"HTML"});
  }

  recordStat(userId,"download",ok);
  saveDb();
  await send(token,chatId,
    "✅ <b>本批获取完成</b>\\n"+
    "━━━━━━━━━━━━━━\\n\\n"+
    "📦 本次资源：<b>"+valid.length+"</b> 个\\n"+
    "📤 已发送：<b>"+ok+"</b> 个\\n\\n"+
    "━━━━━━━━━━━━━━\\n"+
    (options.mode==="latest"
      ? "🆕 <i>这是最新资源的一批</i>"
      : options.mode==="random"
        ? "🎲 <i>这是本次随机获取的一批</i>"
        : "✨ <i>资源已发送完成</i>"),
    {parse_mode:"HTML",...(options.mode?batchNavigation(options.mode,options.offset||0,options.total||valid.length):{})});
  if(postResourceMessage()) await sendHtml(token,chatId,postResourceMessage());
  return;
}
const states=new Map();

async function binding(msg) {
  const admin=isAdmin(msg.from?.id);
  const rawText=(msg.text||"").trim();
  const t=(rawText.split(/\s+/)[0]||"").replace(/@[^\s]+$/,"");
  if(!admin) return false;

  const bindCommands=["/绑定指定群","/绑定仓库","/解绑指定群","/解绑仓库"];
  const isBindCommand=bindCommands.includes(t);
  const inGroup=["group","supergroup"].includes(msg.chat?.type);

  if(isBindCommand && !inGroup) {
    if(!admin) return false;
    return send(TOKEN,msg.from.id,"⚠️ 这个命令请在目标群里发送。");
  }

  if(isBindCommand && inGroup) {
    let groupOperatorAllowed=admin;
    try {
      const member=await tg(TOKEN,"getChatMember",{chat_id:msg.chat.id,user_id:msg.from.id});
      groupOperatorAllowed=groupOperatorAllowed || member.status==="creator" || member.status==="administrator";
    } catch(e) {
      console.warn("⚠️ 无法检查群操作员权限:",e.message);
    }
    if(!groupOperatorAllowed) {
      await send(TOKEN,msg.chat.id,"⛔ 只有群主/群管理员或平台管理员可以执行绑定命令。");
      return true;
    }
    if(t==="/绑定指定群") {
      db.settings.requiredGroup={chatId:String(msg.chat.id),title:msg.chat.title||String(msg.chat.id),username:msg.chat.username||"",type:msg.chat.type,url:msg.chat.username?"https://t.me/"+msg.chat.username:""};
      saveDb();
      await send(TOKEN,msg.chat.id,"✅ <b>指定群绑定成功</b>\\n\\n"+configText(),{parse_mode:"HTML"});
      return true;
    }
    if(t==="/绑定仓库") {
      db.settings.repository={chatId:String(msg.chat.id),title:msg.chat.title||String(msg.chat.id),username:msg.chat.username||"",type:msg.chat.type};
      saveDb();
      await send(TOKEN,msg.chat.id,"✅ <b>资源仓库绑定成功</b>\\n\\n"+configText(),{parse_mode:"HTML"});
      return true;
    }
    if(t==="/解绑指定群") db.settings.requiredGroup=null;
    if(t==="/解绑仓库") db.settings.repository=null;
    saveDb();
    await send(TOKEN,msg.from.id,"✅ 已解除绑定。\\n\\n"+configText());
    return true;
  }

  // 私聊点击“绑定资源仓库”后，转发仓库中的任意一条消息给主机器人即可绑定。
  if(msg.chat?.type==="private" && msg.forward_origin?.chat) {
    const fc=msg.forward_origin.chat;
    db.settings.repository={
      chatId:String(fc.id),
      title:fc.title||fc.username||String(fc.id),
      username:fc.username||"",
      type:fc.type||"channel"
    };
    saveDb();
    await send(TOKEN,msg.from.id,"✅ 资源仓库绑定成功。\\n\\n📦 "+(fc.title||fc.username||fc.id)+"\\n🆔 "+fc.id+"\\n\\n现在把主机器人加入该仓库并确保有读取消息权限。\\n新资源会自动建立索引。");
    return true;
  }

  return false;
}

async function mainMessage(msg) {
  if(await binding(msg)) return;
  if(msg.chat?.type!=="private") { indexResource(msg); return; }

  const uid=msg.from.id;
  if(!db.users.includes(uid)) { db.users.push(uid); saveDb(); }
  recordUserActivity(uid);
  const t=msg.text||"";
  const admin=isAdmin(uid);
  const key="m:"+uid;
  const s=states.get(key);

  if(admin && (t==="🏠 返回首页" || t==="⬅️ 返回首页")) {
    if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
    const bk=key+":broadcast";
    if(uploadTimers.has(bk)) { clearTimeout(uploadTimers.get(bk)); uploadTimers.delete(bk); }
    states.delete(key);
    return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n🤖 <b>平台功能</b>：管理后台 · 广播 · 克隆机器人\\n\\n👇 <i>请选择下方功能开始使用</i>",adminMenu());
  }
  if(admin && t==="⬅️ 返回管理") {
    if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
    const bk=key+":broadcast";
    if(uploadTimers.has(bk)) { clearTimeout(uploadTimers.get(bk)); uploadTimers.delete(bk); }
    states.delete(key);
    return sendHtml(TOKEN,uid,"<b>👑 管理后台</b>\\n\\n📦 资源：上传、目录、仓库与扫描\\n📊 运营：数据、广播与日志\\n⚙️ 设置：指定群、管理员与系统\\n🤖 机器人：克隆机器人\\n\\n👇 <i>请选择管理模块</i>",adminMenu());
  }
  const pendingHistory = historyInputs.get(String(uid));
  if (pendingHistory) {
    if (t === "/cancel") { historyInputs.delete(String(uid)); return send(TOKEN,uid,"❌ <b>已取消扫描授权</b>\\n\\n本次授权操作已结束。",adminMenu()); }
    historyInputs.delete(String(uid));
    pendingHistory.resolve(t);
    return;
  }

  if(t==="⭐ 我的资源") return sendHtml(TOKEN,uid,userFeatureText(),{reply_markup:userFeatureKeyboard()});
  if(t==="/start" || t==="🏠 开始") return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\n\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\n🤖 <b>平台功能</b>："+(admin ? "管理后台 · 广播 · 克隆机器人" : "克隆机器人")+"\n\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu());
  if(t==="/admin") {
  if(t.startsWith("/start share_")) {
    const shareToken=t.slice("/start share_".length).trim();
    const item=getResourceByShareToken(shareToken);
    if(!item) return sendHtml(TOKEN,uid,"<b>🔗 分享资源</b>\n\n❌ 这个分享链接已失效或资源不存在。",userMenu());
    try {
      await sendIndexedResource(TOKEN,uid,item);
      recordStat(uid,"download",1);
      recordResourceDownload(item);
      recordRecent(uid,item);
      saveDb();
      return sendHtml(TOKEN,uid,
        "<b>🔗 分享资源</b>\n"+
        "━━━━━━━━━━━━━━\n\n"+
        "📦 <b>"+escapeHtml(item.title||"未命名资源")+"</b>\n"+
        "📁 文件夹：<b>"+escapeHtml(db.directories.find(d=>String(d.id)===String(item.directoryId))?.name||"未分类")+"</b>\n\n"+
        "✅ 资源已发送。\n\n"+
        "━━━━━━━━━━━━━━",
        userMenu());
    } catch(e) {
      return sendHtml(TOKEN,uid,"<b>❌ 资源获取失败</b>\n\n请稍后重试。",userMenu());
    }
  }
    if(!admin) return send(TOKEN,uid,"⛔ <b>无管理员权限</b>\\n\\n此功能仅限管理员使用。");
    return sendHtml(TOKEN,uid,"<b>👑 管理员控制台</b>\n\n"+configText()+"\n\n👇 <i>请选择需要管理的功能</i>",adminMenu());
  }
  if(t==="/状态") {
    if(!admin) return send(TOKEN,uid,"⛔ <b>无管理员权限</b>\\n\\n此功能仅限管理员使用。");
    return sendHtml(TOKEN,uid,configText(),adminMenu());
  }
  if(t==="🔐 绑定指定群" && admin)
    return send(TOKEN,uid,"🔐 绑定指定群\n\n1. 把主机器人加入你要限制访问的群。\n2. 确保机器人能查看群成员。\n3. 在该群发送：\n\n/绑定指定群\n\n发送成功后会自动绑定。");

  if(t==="📦 绑定资源仓库" && admin)
    return send(TOKEN,uid,"📦 绑定资源仓库\n\n最简单的绑定方法：\n\n1. 先把主机器人加入资源仓库群/频道。\n2. 从资源仓库里转发任意一条消息给主机器人。\n3. 主机器人会自动识别并绑定这个群/频道。\n\n也可以直接在资源群里发送：/绑定仓库");

  if(t==="🤖 克隆机器人") {
    states.set(key,{step:"token"});
    return send(TOKEN,uid,"🤖 创建子机器人\n\n请把你在 BotFather 创建的 Bot Token 发给我。\n\n发送 /cancel 可取消。\n\n⚠️ Token 只用于启动你的子机器人，请勿把 Token 发给其他人。");
  }
  if(s?.step==="token") {
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消。",admin ? adminMenu() : userMenu()); }
    try {
      const me=await tg(t,"getMe");
      if(db.children.some(x=>x.botId===me.id)) throw new Error("already");
      const child={botId:me.id,username:me.username||"",ownerId:uid,token:encrypt(t),offset:0};
      db.children.push(child); saveDb(); states.delete(key); startChild(child);
      const botLink=me.username ? "https://t.me/"+me.username : "";
      return send(TOKEN,uid,
        "✅ 子机器人创建成功\\n\\n" +
        "🤖 @" + (me.username||me.first_name) + "\\n" +
        "🟢 已自动启动\\n\\n" +
        "点击下面按钮进入你的子机器人。",
        {reply_markup:{inline_keyboard:[[{
          text:"🚀 进入我的子机器人",
          ...(botLink ? {url:botLink} : {})
        }]]}}
      );
    } catch(e) {
      console.error("❌ CLONE:",e.message);
      return send(TOKEN,uid,"❌ 创建失败：Token 无效、机器人已绑定，或 Telegram 暂时无法连接。\\n\\n请重新发送 Token，或发送 /cancel 取消。");
    }
  }

  if(t==="📊 数据统计" && admin) {
    const stats=db.settings.stats||{};
    const users=stats.userActions||{};
    const now=Date.now(),day=86400000;
    const activeToday=Object.values(users).filter(x=>Number(x.lastActive||0)>=now-day).length;
    const active7d=Object.values(users).filter(x=>Number(x.lastActive||0)>=now-7*day).length;
    const topDownloads=Object.entries(users).sort((a,b)=>Number(b[1]?.downloads||0)-Number(a[1]?.downloads||0)).slice(0,5);
    const topSearch=Object.entries(users).sort((a,b)=>Number(b[1]?.searches||0)-Number(a[1]?.searches||0)).slice(0,5);
    const topUsers=topDownloads.map(([id,x],i)=>(i+1)+". <code>"+escapeHtml(id)+"</code> · 获取 "+Number(x.downloads||0)).join("\\n")||"暂无数据";
    const searchUsers=topSearch.map(([id,x],i)=>(i+1)+". <code>"+escapeHtml(id)+"</code> · 搜索 "+Number(x.searches||0)).join("\\n")||"暂无数据";
    return sendHtml(TOKEN,uid,
      "<b>📊 数据与运营</b>\\n"+
      "━━━━━━━━━━━━━━\\n\\n"+
      "👤 <b>用户数据</b>\\n"+
      "• 用户总数：<b>"+db.users.length+"</b>\\n"+
      "• 今日活跃：<b>"+activeToday+"</b>\\n"+
      "• 近7天活跃：<b>"+active7d+"</b>\\n\\n"+
      "📥 <b>获取统计</b>\\n"+
      "• 获取资源：<b>"+Number(stats.downloads||0)+"</b> 个\\n\\n"+
      "🔎 <b>搜索统计</b>\\n"+
      "• 搜索次数：<b>"+Number(stats.searches||0)+"</b> 次\\n\\n"+
      "📤 <b>上传统计</b>\\n"+
      "• 上传批次：<b>"+Number(stats.uploads||0)+"</b> 次\\n"+
      "• 上传资源：<b>"+Number(stats.uploadedResources||0)+"</b> 个\\n\\n"+
      "🏆 <b>获取最多的用户</b>\\n"+topUsers+"\\n\\n"+
      "🔍 <b>搜索最多的用户</b>\\n"+searchUsers+"\\n\\n"+
      "📚 资源库：<b>"+db.resources.length+"</b> 个 · 📂 文件夹：<b>"+db.directories.length+"</b> 个\\n"+
      "🤖 子机器人：<b>"+db.children.length+"</b> 个",
      {parse_mode:"HTML",...adminOpsMenu()}
    );
  }

  if(t==="📦 资源仓库" && admin)
    return send(TOKEN,uid,
      "📦 资源仓库设置\\n\\n"+
      "推荐：把主机器人加入资源频道并设为管理员，\\n"+
      "然后从频道转发任意一条消息给主机器人。\\n\\n"+
      "当前： "+(repo()?"✅ "+repo().title:"❌ 未绑定"));

  if(t==="🔐 指定群管理" && admin)
    return send(TOKEN,uid,
      "🔐 指定群设置\\n\\n"+
      "把主机器人加入目标群，然后在群里发送：\\n"+
      "/绑定指定群\\n\\n"+
      "当前： "+(group()?"✅ "+group().title:"❌ 未绑定"));

  if(t==="✏️ 非会员提示" && admin) {
    states.set(key,{step:"edit_nonmember_message"});
    return sendHtml(TOKEN,uid,
      "<b>✏️ 编辑非会员提示</b>\\n\\n"+
      "用户不在指定会员群时，会看到下面这条消息：\\n\\n"+
      (db.settings.nonMemberMessage || "🔐 <b>请先加入指定会员群</b>\\n\\n加入后即可继续使用资源功能。")+
      "\\n\\n请直接发送新的消息内容。\\n发送 /cancel 可取消。",
      {reply_markup:{remove_keyboard:true}});
  }

  if(t==="📣 获取后推广" && admin) {
    states.set(key,{step:"edit_post_resource_message"});
    return sendHtml(TOKEN,uid,
      "<b>📣 编辑获取资源后的推广消息</b>\\n\\n"+
      "用户成功获取资源后，会额外收到这条消息：\\n\\n"+
      (db.settings.postResourceMessage || "✨ <b>更多资源</b>\\n\\n欢迎继续浏览资源库。")+
      "\\n\\n请直接发送新的消息内容。\\n发送 /cancel 可取消。",
      {reply_markup:{remove_keyboard:true}});
  }

  if(s?.step==="edit_nonmember_message" && admin) {
    if(t==="/cancel") {
      states.delete(key);
      return send(TOKEN,uid,"❌ 已取消编辑。",adminSettingsMenu());
    }
    const value=String(t||"").trim();
    if(!value) return send(TOKEN,uid,"⚠️ 消息不能为空，请重新发送。");
    db.settings.nonMemberMessage=value.slice(0,4000);
    saveDb();
    logAdmin(uid,"修改非会员提示");
    states.delete(key);
    return sendHtml(TOKEN,uid,
      "<b>✅ 非会员提示已更新</b>\\n\\n"+
      db.settings.nonMemberMessage,
      adminSettingsMenu());
  }

  if(s?.step==="edit_post_resource_message" && admin) {
    if(t==="/cancel") {
      states.delete(key);
      return send(TOKEN,uid,"❌ 已取消编辑。",adminSettingsMenu());
    }
    const value=String(t||"").trim();
    if(!value) return send(TOKEN,uid,"⚠️ 消息不能为空，请重新发送。");
    db.settings.postResourceMessage=value.slice(0,4000);
    saveDb();
    logAdmin(uid,"修改获取后推广消息");
    states.delete(key);
    return sendHtml(TOKEN,uid,
      "<b>✅ 获取后推广消息已更新</b>\\n\\n"+
      db.settings.postResourceMessage,
      adminSettingsMenu());
  }

  if(t==="🔍 仓库扫描" && admin) {
    const scan=db.settings.historyScan;
    const auth=db.settings.historyAuth;
    return send(TOKEN,uid,
      "🔍 仓库扫描\\n\\n"+
      "📦 当前仓库： "+(repo()?repo().title:"❌ 未绑定")+"\\n"+
      "📚 当前索引： "+db.resources.length+" 条\\n"+
      "🕘 历史扫描： "+(scan.status==="completed"?"✅ 已完成":scan.status==="running"?"⏳ 扫描中":scan.status==="error"?"⚠️ 上次失败":"未执行")+"\\n"+
      (scan.scanned?`\\n最近一次：扫描 ${scan.scanned} 条，索引 ${scan.indexed} 条`:"")+"\\n\\n"+
      (auth?.session?"🔐 扫描账号：已授权":"🔐 扫描账号：首次使用需授权")+"\\n\\n"+
      "点击「🔍 开始历史扫描」即可把频道已有历史消息全部建立索引。",
      {reply_markup:{keyboard:[["🔍 开始历史扫描","🔐 扫描授权"],["📦 资源仓库","📊 数据统计"],["⚙️ 平台设置"]],resize_keyboard:true}});
  }

  if(t==="🔍 开始历史扫描" && admin) return scanHistory(uid);
  if(t==="🔐 扫描授权" && admin) {
    try { await ensureHistoryClient(uid); return send(TOKEN,uid,"✅ MTProto 扫描账号已授权。现在可以点击「🔍 开始历史扫描」。",adminMenu()); }
    catch(e) { return send(TOKEN,uid,"❌ 扫描授权失败：\\n\\n"+e.message,adminMenu()); }
  }



  if(t==="📂 资源目录") {

    states.delete(key);
    return sendHtml(TOKEN,uid,directoryText(),{reply_markup:directoryInlineKeyboard()});
  }
  if(t==="🏠 开始" && s?.step==="directory") {
    states.delete(key);
    return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n\\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu());
  }

  if(s?.step==="directory_page") {
    if(t==="🏠 开始") { states.delete(key); return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n\\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu()); }
    if(t==="📂 返回文件夹") { states.set(key,{step:"directory"}); return sendHtml(TOKEN,uid,directoryText(),directoryKeyboard()); }
    if(t!=="➡️ 下一步") return send(TOKEN,uid,"⚠️ 请点击「➡️ 下一步」继续。");

    const all=directoryItems(s.directoryId);
    const offset=Number(s.offset||0);
    if(offset>=all.length) {
      states.set(key,{step:"directory_page",directoryId:s.directoryId,offset});
      return send(TOKEN,uid,"🏁 <b>本文件夹已到末尾</b>\\n\\n没有更多资源可以获取了。");
    }

    const page=all.slice(offset,offset+10);
    const sent=await sendDirectoryBatch(TOKEN,uid,page);
    const nextOffset=offset+page.length;
    states.set(key,{step:"directory_page",directoryId:s.directoryId,offset:nextOffset});
    const d=db.directories.find(x=>String(x.id)===String(s.directoryId));
    const safe=String(d?.name||"资源文件夹").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    if(!sent) return send(TOKEN,uid,"❌ <b>本批资源发送失败</b>\\n\\n请检查资源仓库权限后再试。");
    return sendHtml(TOKEN,uid,
      "📁 <b>"+safe+"</b>\\n\\n"+
      "✅ 本次发送 <b>"+sent+"</b> 个资源。\\n"+
      "📦 进度："+nextOffset+" / "+all.length+"\\n\\n"+
      (nextOffset<all.length?"👇 点击「➡️ 下一步」继续获取。":"🏁 <b>本文件夹已到末尾</b>\\n\\n没有更多资源可以获取了。"),
      {reply_markup:{keyboard:nextOffset<all.length?[["➡️ 下一步"],["📂 返回文件夹","🏠 开始"]]:[["📂 返回文件夹","🏠 开始"]],resize_keyboard:true}}
    );
  }

  if(t==="🔎 搜索资源") {

    states.set(key,{step:"search"});
    return sendHtml(TOKEN,uid,
      "<b>🔎 搜索资源</b>\\n\\n"+
      "请输入关键词，例如：作者名、标题或关键词。\\n\\n"+
      "💡 支持模糊搜索，最多返回 10 条。\\n"+
      "↩️ 发送 <code>/cancel</code> 可退出搜索。",
      {reply_markup:{keyboard:[["❌ 取消搜索"],["🏠 开始"]],resize_keyboard:true,input_field_placeholder:"请输入搜索关键词"}}
    );
  }
  if(t==="🎲 随机获取") return deliver(TOKEN,uid,uid,random10(uid),TOKEN,{mode:"random",offset:0,total:db.resources.length});
  if(t==="🆕 最新资源") return deliver(TOKEN,uid,uid,db.resources.slice(0,10),TOKEN,{mode:"latest",offset:0,total:db.resources.length});
  if(s?.step==="search") {
    if(t==="/cancel" || t==="❌ 取消搜索" || t==="🏠 开始") {
      states.delete(key);
      if(t==="🏠 开始") return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n🤖 <b>平台功能</b>："+(admin ? "管理后台 · 广播 · 克隆机器人" : "克隆机器人")+"\\n\\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu());
      return send(TOKEN,uid,"↩️ <b>已退出搜索</b>\\n\\n👇 请选择其他功能。",admin?adminMenu():userMenu());
    }
    const query=t.trim();
    recordStat(uid,"search",1);
    saveDb();
    const results=search(query);
    if(!results.length) return sendHtml(TOKEN,uid,
      "<b>📭 没有找到相关资源</b>\\n\\n关键词：<code>"+escapeHtml(query)+"</code>\\n\\n💡 可以换一个更短的关键词再试。",
      userMenu()
    );
    states.set(key,{step:"search_results",query,results,page:0});
    return sendHtml(TOKEN,uid,
      "🔎 <b>搜索结果</b>\\n"+
      "━━━━━━━━━━━━━━\\n\\n"+
      "🔍 关键词：<code>"+escapeHtml(query)+"</code>\\n"+
      "📚 共找到：<b>"+results.length+"</b> 个资源\\n"+
      "📄 当前页面：<b>1 / "+Math.max(1,Math.ceil(results.length/10))+"</b>\\n\\n"+
      "━━━━━━━━━━━━━━\\n"+
      "👇 <i>点击资源名称获取</i>",
      resourceInlineKeyboard(results,0)
    );
  }
  if(s?.step==="search_results") {
    if(t==="/cancel" || t==="❌ 取消搜索" || t==="🏠 开始") {
      states.delete(key);
      return t==="🏠 开始"
        ? sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n🤖 <b>平台功能</b>："+(admin ? "管理后台 · 广播 · 克隆机器人" : "克隆机器人")+"\\n\\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu())
        : send(TOKEN,uid,"↩️ <b>已退出搜索</b>\\n\\n👇 请选择其他功能。",admin?adminMenu():userMenu());
    }
    return sendHtml(TOKEN,uid,"🔎 <b>搜索结果已显示在上方</b>\\n\\n👇 请直接点击内联按钮选择资源。",resourceInlineKeyboard(s.results,Number(s.page||0)));
  }

  if(t==="📂 资源目录"&&admin) {
    return send(TOKEN,uid,"🛠️ <b>资源管理</b>\\n\\n这里放不常用的管理功能。",{parse_mode:"HTML",...adminToolsMenu()});
  }
  if(t==="🔄 移动资源"&&admin) {
    const dirs=db.directories.filter(d=>db.resources.some(r=>String(r.directoryId)===String(d.id)));
    if(!dirs.length) return send(TOKEN,uid,"📭 <b>暂无可移动资源</b>\n\n请先建立文件夹并添加资源。",adminMenu());
    states.set(key,{step:"move_source"});
    return sendHtml(TOKEN,uid,"<b>🔄 移动资源</b>\n\n请选择资源所在的文件夹。",deleteResourceMenu());
  }
  if(s?.step==="move_source"&&admin) {
    const d=getDirectoryByName(t);
    if(!d) return send(TOKEN,uid,"⚠️ <b>文件夹不存在</b>\n\n请重新选择。",deleteResourceMenu());
    const items=directoryItems(d.id);
    if(!items.length) return send(TOKEN,uid,"📭 <b>这个文件夹没有资源</b>\n\n请选择其他文件夹。",deleteResourceMenu());
    states.set(key,{step:"move_item",sourceId:d.id,items});
    return sendHtml(TOKEN,uid,"<b>🔄 选择要移动的资源</b>\n\n📁 文件夹：<b>"+escapeHtml(d.name)+"</b>\n📦 共 "+items.length+" 个资源\n\n👇 请选择一个资源。",{reply_markup:{keyboard:items.slice(0,30).map((x,i)=>[(i+1)+". "+String(x.title||"未命名").slice(0,38)]).concat([["⬅️ 返回管理"]]),resize_keyboard:true}});
  }
  if(s?.step==="move_item"&&admin) {
    if(t==="⬅️ 返回管理") { states.delete(key); return send(TOKEN,uid,"↩️ 已返回管理后台。",adminMenu()); }
    const idx=parseInt((t.match(/^(\d+)\./)||[])[1],10)-1;
    if(!Number.isInteger(idx)||idx<0||idx>=s.items.length) return send(TOKEN,uid,"⚠️ <b>请选择有效的资源</b>。");
    const item=s.items[idx];
    states.set(key,{step:"move_target",sourceId:s.sourceId,itemId:item.messageId});
    return sendHtml(TOKEN,uid,"<b>🔄 选择目标文件夹</b>\n\n📦 资源：<b>"+escapeHtml(item.title||"未命名")+"</b>\n\n👇 请选择目标文件夹。",{reply_markup:moveFolderMenu(s.sourceId)});
  }

  if(t==="📦 批量管理"&&admin) {
    const dirs=db.directories.filter(d=>db.resources.some(r=>String(r.directoryId)===String(d.id)));
    if(!dirs.length) return send(TOKEN,uid,"📭 <b>暂无资源可管理</b>。",adminMenu());
    states.set(key,{step:"bulk_source"});
    return sendHtml(TOKEN,uid,"<b>📦 批量管理</b>\n\n请选择要批量处理的文件夹。",deleteResourceMenu());
  }
  if(s?.step==="bulk_source"&&admin) {
    const d=getDirectoryByName(t);
    if(!d) return send(TOKEN,uid,"⚠️ <b>文件夹不存在</b>。",deleteResourceMenu());
    const items=directoryItems(d.id);
    if(!items.length) return send(TOKEN,uid,"📭 <b>这个文件夹没有资源</b>。",deleteResourceMenu());
    states.set(key,{step:"bulk_select",sourceId:d.id,items,selected:[],page:0});
    return sendHtml(TOKEN,uid,"<b>📦 批量管理</b>\n\n📁 <b>"+escapeHtml(d.name)+"</b>\n📦 共 "+items.length+" 个资源\n\n☑️ 点击资源可多选。",{reply_markup:resourceMoveMenu(items,0,[])});
  }

  if(t==="🔗 分享资源"&&admin) {
    const dirs=db.directories.filter(d=>db.resources.some(r=>String(r.directoryId)===String(d.id)));
    if(!dirs.length) return send(TOKEN,uid,"📭 <b>暂无资源可分享</b>。",adminMenu());
    states.set(key,{step:"share_source"});
    return sendHtml(TOKEN,uid,"<b>🔗 分享资源</b>\n\n请选择文件夹。",deleteResourceMenu());
  }
  if(s?.step==="share_source"&&admin) {
    const d=getDirectoryByName(t);
    if(!d) return send(TOKEN,uid,"⚠️ <b>文件夹不存在</b>。",deleteResourceMenu());
    const items=directoryItems(d.id);
    states.set(key,{step:"share_item",items,directoryId:d.id});
    return sendHtml(TOKEN,uid,"<b>🔗 选择资源</b>\n\n📁 文件夹：<b>"+escapeHtml(d.name)+"</b>\n\n👇 点击资源名称。",{reply_markup:{keyboard:items.slice(0,30).map((x,i)=>[(i+1)+". "+String(x.title||"未命名").slice(0,38)]).concat([["⬅️ 返回管理"]]),resize_keyboard:true}});
  }
  if(s?.step==="share_item"&&admin) {
    if(t==="⬅️ 返回管理") { states.delete(key); return send(TOKEN,uid,"↩️ 已返回管理后台。",adminMenu()); }
    const idx=parseInt((t.match(/^(\d+)\./)||[])[1],10)-1;
    if(!Number.isInteger(idx)||idx<0||idx>=s.items.length) return send(TOKEN,uid,"⚠️ <b>请选择有效的资源</b>。");
    const item=s.items[idx];
    try {
      const link=await makeShareLink(item);
      return sendHtml(TOKEN,uid,
        "<b>🔗 资源分享</b>\n━━━━━━━━━━━━━━\n\n"+
        "📦 <b>"+escapeHtml(item.title||"未命名资源")+"</b>\n\n"+
        "🔗 <code>"+escapeHtml(link)+"</code>\n\n"+
        "👇 点击按钮打开分享链接。",
        shareResourceKeyboard(link)
      );
    } catch(e) {
      return send(TOKEN,uid,"❌ <b>分享链接生成失败</b>\n\n"+escapeHtml(e.message||"未知错误"));
    }
  }

  if(t==="✏️ 修改文件夹名称"&&admin) {
    states.set(key,{step:"rename_folder"});
    return send(TOKEN,uid,"✏️ <b>修改文件夹名称</b>\n\n请选择要修改名称的文件夹：",{parse_mode:"HTML",...deleteResourceMenu()});
  }
  if(s?.step==="rename_folder"&&admin) {
    if(t==="⬅️ 返回管理"||t==="🏠 开始") { states.delete(key); return send(TOKEN,uid,"↩️ 已返回管理后台。",adminMenu()); }
    if(t==="📭 暂无资源") return send(TOKEN,uid,"📭 当前没有可修改的文件夹。",deleteResourceMenu());
    const name=t.replace(/^📁\s*/,"").split("（")[0].trim();
    const d=getDirectoryByName(name);
    if(!d) return send(TOKEN,uid,"⚠️ <b>找不到这个文件夹</b>\\n\\n请重新选择。",deleteResourceMenu());
    states.set(key,{step:"rename_folder_name",directoryId:d.id});
    return send(TOKEN,uid,"✏️ 当前名称：<b>"+escapeHtml(d.name)+"</b>\n\n请输入新的文件夹名称。\n\n发送 /cancel 可取消。",{parse_mode:"HTML"});
  }
  if(s?.step==="rename_folder_name"&&admin) {
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ <b>已取消修改名称</b>\\n\\n文件夹名称未发生变化。",adminResourceMenu()); }
    const newName=t.trim().slice(0,80);
    if(!newName) return send(TOKEN,uid,"⚠️ <b>名称不能为空</b>\\n\\n请重新发送文件夹名称。");
    const d=db.directories.find(x=>String(x.id)===String(s.directoryId));
    if(!d) { states.delete(key); return send(TOKEN,uid,"⚠️ <b>文件夹不存在</b>\\n\\n请重新选择。",adminResourceMenu()); }
    const oldName=d.name;
    const existing=getDirectoryByName(newName);
    if(existing && String(existing.id)!==String(d.id)) return send(TOKEN,uid,"⚠️ 已存在同名文件夹，请换一个名称。");
    d.name=newName;
    touchSharedData(uid);
    saveDb();
    logAdmin(uid,"修改文件夹名称",oldName+" → "+newName);
    states.delete(key);
    return send(TOKEN,uid,"✅ 文件夹名称已修改。\n\n📁 <b>"+escapeHtml(oldName)+"</b>\n⬇️\n📁 <b>"+escapeHtml(newName)+"</b>",{parse_mode:"HTML",...adminResourceMenu()});
  }
  if(t==="🗑️ 删除资源"&&admin) {
    states.set(key,{step:"delete_folder"});
    return send(TOKEN,uid,"🗑️ <b>删除资源</b>\\n\\n先选择文件夹：\\n\\n进入文件夹后可以删除单个文件，或直接删除整个文件夹。",{parse_mode:"HTML",...deleteResourceMenu()});
  }
  if(s?.step==="delete_folder"&&admin) {
    if(t==="⬅️ 返回管理"||t==="🏠 开始") { states.delete(key); return send(TOKEN,uid,"↩️ 已返回管理后台。",adminMenu()); }
    if(t==="📭 暂无资源") return send(TOKEN,uid,"📭 当前没有可删除的资源。",deleteResourceMenu());
    const name=t.replace(/^📁\\s*/,"").split("（")[0].trim();
    const d=getDirectoryByName(name);
    if(!d) return send(TOKEN,uid,"⚠️ <b>找不到这个文件夹</b>\\n\\n请重新选择。",deleteResourceMenu());
    const items=directoryItems(d.id);
    const rows=items.slice(0,40).map((x,i)=>[(i+1)+". "+String(x.title||"未命名资源").slice(0,35)]);
    rows.push(["🗑️ 删除整个文件夹"],["⬅️ 返回文件夹"]);
    states.set(key,{step:"delete_file",directoryId:d.id});
    return send(TOKEN,uid,"📁 <b>"+d.name+"</b>\\n\\n共有 <b>"+items.length+"</b> 个资源。\\n请选择要删除的文件：",{parse_mode:"HTML",reply_markup:{keyboard:rows,resize_keyboard:true,input_field_placeholder:"选择文件"}});
  }
  if(s?.step==="delete_file"&&admin) {
    const d=db.directories.find(x=>String(x.id)===String(s.directoryId));
    if(!d) { states.delete(key); return send(TOKEN,uid,"⚠️ <b>文件夹不存在</b>\\n\\n请重新选择。",adminMenu()); }
    if(t==="⬅️ 返回文件夹") { states.set(key,{step:"delete_folder"}); return send(TOKEN,uid,"🗑️ <b>选择要管理的文件夹</b>",{parse_mode:"HTML",...deleteResourceMenu()}); }
    if(t==="🗑️ 删除整个文件夹") {
      states.set(key,{step:"confirm_delete_folder",directoryId:d.id});
      return send(TOKEN,uid,"⚠️ <b>确认删除整个文件夹？</b>\n\n📁 "+d.name+"\n📦 共 "+directoryItems(d.id).length+" 个资源\n\n删除后将同时删除仓库中的对应消息。",{parse_mode:"HTML",reply_markup:{keyboard:[["🗑️ 确认删除文件夹","❌ 取消"],["⬅️ 返回文件夹"]],resize_keyboard:true}});
    }
    if(t==="🗑️ 确认删除文件夹") {
      const items=directoryItems(d.id);
      let deleted=0;
      for(const item of items) { try { await tg(TOKEN,"deleteMessage",{chat_id:item.chatId,message_id:Number(item.messageId)}); deleted++; } catch(e) {} }
      db.resources=db.resources.filter(x=>String(x.directoryId)!==String(d.id));
      db.directories=db.directories.filter(x=>String(x.id)!==String(d.id));
      touchSharedData(uid);
      saveDb(); logAdmin(uid,"删除文件夹",d.name); states.set(key,{step:"delete_folder"});
      return send(TOKEN,uid,"✅ 已删除文件夹「"+d.name+"」。\\n\\n📚 已从资源索引移除："+items.length+" 个文件。\\n🗑️ 仓库消息成功删除："+deleted+" 个。",deleteResourceMenu());
    }
    const items=directoryItems(d.id);
    const idx=items.findIndex((x,i)=>(i+1)+". "+String(x.title||"未命名资源").slice(0,35)===t);
    if(idx<0) return send(TOKEN,uid,"⚠️ <b>请选择有效的文件</b>\\n\\n请重新选择要删除的资源。");
    const item=items[idx];
    try { await tg(TOKEN,"deleteMessage",{chat_id:item.chatId,message_id:Number(item.messageId)}); } catch(e) {}
    db.resources=db.resources.filter(x=>!(String(x.chatId)===String(item.chatId)&&Number(x.messageId)===Number(item.messageId)));
    touchSharedData(uid);
    saveDb(); logAdmin(uid,"删除资源",item.title);
    const left=directoryItems(d.id);
    const rows=left.slice(0,40).map((x,i)=>[(i+1)+". "+String(x.title||"未命名资源").slice(0,35)]);
    rows.push(["🗑️ 删除整个文件夹"],["⬅️ 返回文件夹"]);
    return send(TOKEN,uid,"✅ 已删除："+item.title+"\\n\\n📁 文件夹「"+d.name+"」剩余 "+left.length+" 个资源。",{reply_markup:{keyboard:rows,resize_keyboard:true,input_field_placeholder:"选择文件"}});
  }

  if(t==="⬅️ 返回管理"&&admin) return send(TOKEN,uid,"👑 <b>管理员控制台</b>\\n\\n请选择需要管理的项目。",{parse_mode:"HTML",...adminMenu()});

  if(t==="📜 操作日志"&&admin) {
    const logs=Array.isArray(db.settings.logs)?db.settings.logs:[];
    if(!logs.length) return send(TOKEN,uid,"📜 暂无操作日志。",adminToolsMenu());
    const text=logs.slice(0,30).map((x,i)=>{
      const when=new Date(x.at).toLocaleString("zh-CN",{hour12:false});
      return (i+1)+". "+when+"\\n👤 "+escapeHtml(x.uid)+"\\n🔧 "+escapeHtml(x.action)+(x.detail?"\\n📌 "+escapeHtml(x.detail):"");
    }).join("\\n\\n");
    return send(TOKEN,uid,"📜 <b>最近操作日志</b>\\n\\n"+text,{parse_mode:"HTML",...adminToolsMenu()});
  }
  if(t==="👥 管理员管理"&&admin) {
    if(!isSuperAdmin(uid)) return send(TOKEN,uid,"⛔ 只有主管理员可以管理其他管理员。",adminMenu());
    states.set(key,{step:"admin_manage"});
    const list=db.settings.admins.length?db.settings.admins.map((id,i)=>`${i+1}. ${id}`).join("\\n"):"暂无普通管理员";
    return send(TOKEN,uid,`👥 <b>管理员管理</b>\\n\\n当前普通管理员：\\n${list}\\n\\n请选择操作：`,{parse_mode:"HTML",reply_markup:{keyboard:[["➕ 添加管理员","➖ 删除管理员"],["❌ 取消","🏠 开始"]],resize_keyboard:true}});
  }
  if(s?.step==="admin_manage"&&admin&&isSuperAdmin(uid)) {
    if(t==="❌ 取消"||t==="🏠 开始"||t==="/cancel") { states.delete(key); return send(TOKEN,uid,"↩️ 已退出管理员管理。",adminMenu()); }
    if(t==="➕ 添加管理员") { states.set(key,{step:"admin_add"}); return send(TOKEN,uid,"➕ 请发送要添加的管理员 Telegram 数字 ID。\\n\\n例如：123456789\\n\\n发送 /cancel 可取消。"); }
    if(t==="➖ 删除管理员") { states.set(key,{step:"admin_remove"}); return send(TOKEN,uid,"➖ 请发送要删除的管理员 Telegram 数字 ID。\\n\\n发送 /cancel 可取消。"); }
    return send(TOKEN,uid,"请选择「➕ 添加管理员」或「➖ 删除管理员」。");
  }
  if(s?.step==="admin_add"&&admin&&isSuperAdmin(uid)) {
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消。",adminMenu()); }
    const id=t.trim();
    if(!/^\d+$/.test(id)) return send(TOKEN,uid,"⚠️ ID 格式不正确，请发送纯数字 Telegram ID。");
    if(isSuperAdmin(id)) { states.delete(key); return send(TOKEN,uid,"⚠️ 该账号已经是主管理员。",adminMenu()); }
    if(db.settings.admins.includes(id)) { states.delete(key); return send(TOKEN,uid,"⚠️ 该账号已经是管理员。",adminMenu()); }
    db.settings.admins.push(id); saveDb(); logAdmin(uid,"添加管理员",id); states.delete(key);
    return send(TOKEN,uid,`✅ 已添加管理员：<code>${id}</code>`,{parse_mode:"HTML",...adminMenu()});
  }
  if(s?.step==="admin_remove"&&admin&&isSuperAdmin(uid)) {
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消。",adminMenu()); }
    const id=t.trim();
    if(!/^\d+$/.test(id)) return send(TOKEN,uid,"⚠️ ID 格式不正确，请发送纯数字 Telegram ID。");
    if(isSuperAdmin(id)) { states.delete(key); return send(TOKEN,uid,"⛔ 不能删除主管理员。",adminMenu()); }
    const idx=db.settings.admins.indexOf(id);
    if(idx<0) { states.delete(key); return send(TOKEN,uid,"⚠️ 没找到这个管理员。",adminMenu()); }
    db.settings.admins.splice(idx,1); saveDb(); logAdmin(uid,"删除管理员",id); states.delete(key);
    return send(TOKEN,uid,`✅ 已删除管理员：<code>${id}</code>`,{parse_mode:"HTML",...adminMenu()});
  }
  if(t==="📦 资源管理"&&admin) return send(TOKEN,uid,"📦 <b>资源管理</b>\\n\\n上传资源、管理文件夹、资源仓库和历史扫描。\\n\\n👇 <i>请选择操作</i>",{parse_mode:"HTML",...adminResourceMenu()});
  if(t==="⚙️ 系统设置"&&admin) return send(TOKEN,uid,"⚙️ <b>平台设置</b>\\n\\n指定访问群、管理员和系统参数。\\n\\n👇 <i>请选择设置</i>",{parse_mode:"HTML",...adminSettingsMenu()});
  if(t==="📊 数据与运营"&&admin) return send(TOKEN,uid,"📊 <b>数据与运营</b>\\n\\n查看平台数据、操作记录和广播设置。\\n\\n👇 <i>请选择功能</i>",{parse_mode:"HTML",...adminOpsMenu()});
  if(t==="🤖 机器人管理"&&admin) return send(TOKEN,uid,"🤖 <b>机器人管理</b>\\n\\n创建和管理克隆机器人。\\n\\n👇 <i>请选择操作</i>",{parse_mode:"HTML",...adminBotMenu()});

  // 广播按钮必须优先于上传状态，避免“📢 广播消息”被当成文件夹名称。
  if(t==="📢 广播消息"&&admin) {
    if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
    states.set(key,{step:"broadcast"});
    const timerKey=key+":broadcast";
    if(uploadTimers.has(timerKey)) clearTimeout(uploadTimers.get(timerKey));
    uploadTimers.set(timerKey,setTimeout(()=>{
      uploadTimers.delete(timerKey);
      const current=states.get(key);
      if(current?.step==="broadcast") {
        states.delete(key);
        send(TOKEN,uid,"⏸️ <b>暂时没有收到新的广播内容</b>\\n\\n📢 广播模式已等待 3 分钟。\\n\\n还要继续广播吗？",{parse_mode:"HTML",reply_markup:{keyboard:[["▶️ 继续广播","✅ 结束广播"],["🏠 开始"]],resize_keyboard:true}}).catch(()=>{});
      }
    },UPLOAD_TIMEOUT_MS));
    return send(TOKEN,uid,"📢 <b>广播消息</b>\\n\\n现在请直接发送要广播的文字、图片、视频、音频、文件或其他消息。\\n⏱️ 连续 3 分钟没有收到新的广播内容，将自动结束本次广播。\\n\\n发送 /cancel 可取消。",{parse_mode:"HTML"});
  }

  if(t==="▶️ 继续广播"&&admin) {
    const timerKey=key+":broadcast";
    if(uploadTimers.has(timerKey)) clearTimeout(uploadTimers.get(timerKey));
    states.set(key,{step:"broadcast"});
    uploadTimers.set(timerKey,setTimeout(()=>{
      uploadTimers.delete(timerKey);
      const current=states.get(key);
      if(current?.step==="broadcast") {
        states.delete(key);
        send(TOKEN,uid,"⏸️ <b>暂时没有收到新的广播内容</b>\\n\\n📢 广播模式已等待 3 分钟。\\n\\n还要继续广播吗？",{parse_mode:"HTML",reply_markup:{keyboard:[["▶️ 继续广播","✅ 结束广播"],["🏠 开始"]],resize_keyboard:true}}).catch(()=>{});
      }
    },UPLOAD_TIMEOUT_MS));
    return send(TOKEN,uid,"📢 <b>广播消息</b>\\n\\n现在请继续发送要广播的文字、图片、视频、音频、文件或其他消息。\\n⏱️ 连续 3 分钟没有收到新的广播内容，将自动结束本次广播。\\n\\n发送 /cancel 可取消。",{parse_mode:"HTML"});
  }

  if(t==="✅ 结束广播"&&admin) {
    const timerKey=key+":broadcast";
    if(uploadTimers.has(timerKey)) { clearTimeout(uploadTimers.get(timerKey)); uploadTimers.delete(timerKey); }
    states.delete(key);
    logAdmin(uid,"结束广播");
    return send(TOKEN,uid,"✅ 已结束广播。",adminMenu());
  }

  if(t==="📤 上传资源"&&admin) {
    if(!repo()) return send(TOKEN,uid,"❌ 尚未绑定资源仓库。请先绑定资源仓库。",adminMenu());
    states.set(key,{step:"upload_folder"});
    return sendHtml(TOKEN,uid,
      "<b>📤 上传资源</b>\\n\\n"+
      "请选择要使用的文件夹：\\n"+
      "📁 点击已有文件夹，可继续向里面添加资源。\\n"+
      "➕ 点击「新建文件夹」创建新的文件夹。\\n\\n"+
      "也可以直接发送文件夹名称。\\n"+
      "发送 /cancel 可取消。",
      {reply_markup:uploadFolderInlineMenu()}
    );
  }
  if(s?.step==="upload_folder"&&admin) {
    if(t==="❌ 取消") { states.delete(key); return send(TOKEN,uid,"❌ <b>已取消上传</b>\\n\\n本次上传没有入库。",adminMenu()); }
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ <b>已取消上传</b>\\n\\n本次上传没有入库。",adminMenu()); }

    const media=msg.document||msg.video||msg.audio||msg.animation||msg.photo?.at(-1)||msg.voice||msg.video_note;
    let folder=t.trim().slice(0,80);
    if(folder.startsWith("📁 ")) folder=folder.slice(2).replace(/（\\d+）$/,"").trim();
    if(t==="➕ 新建文件夹") folder="";
    
    // 如果管理员没有输入文件夹名称，而是直接发送第一个文件，则自动创建随机文件夹。
    if(!folder && media) {
      folder="未命名-"+Math.random().toString(36).slice(2,8);
    }
    if(!folder && t==="➕ 新建文件夹") {
      return send(TOKEN,uid,"📁 <b>新建文件夹</b>\\n\\n请发送新的文件夹名称。\\n\\n发送 /cancel 可取消。",{parse_mode:"HTML",reply_markup:{remove_keyboard:true}});
    }
    if(!folder) return send(TOKEN,uid,"⚠️ 请选择已有文件夹、发送新的文件夹名称，或者直接发送第一个文件。");

    const cleanFolder=folder;
    const existing=getDirectoryByName(cleanFolder);
    const uploadKey=key;
    if(uploadTimers.has(uploadKey)) clearTimeout(uploadTimers.get(uploadKey));
    uploadTimers.set(uploadKey,setTimeout(()=>{
      uploadTimers.delete(uploadKey);
      const current=states.get(uploadKey);
      if(current?.step==="upload_file") {
        send(TOKEN,uid,"⏸️ <b>暂时没有收到新文件</b>\\n\\n📁 文件夹："+escapeHtml(current.directoryName)+"\\n📥 已收到：<b>"+(current.pendingUploads?.length||0)+"</b> 个资源\\n⏱️ 已等待 "+UPLOAD_IDLE_SECONDS+" 秒。\\n\\n还要继续上传吗？",{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}]]}}).catch(()=>{});
      }
    },UPLOAD_TIMEOUT_MS));

    const firstPending = media ? [{messageId:Number(msg.message_id),msg}] : [];
    states.set(key,{step:"upload_file",directoryId:existing?.id||null,directoryName:cleanFolder,pendingUploads:firstPending});
    if(media) {
      return send(TOKEN,uid,
        "📥 <b>已收到第 1 个资源</b>\\n\\n"+
        "📁 文件夹：<b>"+escapeHtml(cleanFolder)+"</b>\\n"+
        "📦 当前已收到：<b>1</b> 个资源\\n\\n"+
        "请选择下一步：",
        {parse_mode:"HTML",reply_markup:{inline_keyboard:[
  [{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}]
]}}
      );
    }
    return send(TOKEN,uid,"📁 文件夹：<b>"+escapeHtml(cleanFolder)+"</b>\\n\\n现在请发送要上传的文件、图片、视频、音频或其他资源。\\n\\n📥 每收到一个资源都会告诉你当前数量。\\n\\n发送 /cancel 可取消。",{parse_mode:"HTML"});
  }
  if(s?.step==="upload_file"&&admin) {
    if(t==="/cancel") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      states.delete(key);
      return send(TOKEN,uid,"❌ <b>已取消本次上传</b>\\n\\n未入库的资源不会保存。",adminMenu());
    }
    if(t==="▶️ 继续上传") {
      if(uploadTimers.has(key)) clearTimeout(uploadTimers.get(key));
      uploadTimers.set(key,setTimeout(()=>{
        uploadTimers.delete(key);
        const current=states.get(key);
        if(current?.step==="upload_file") {
          send(TOKEN,uid,"⏸️ <b>暂时没有收到新文件</b>\\n\\n📁 文件夹："+escapeHtml(current.directoryName)+"\\n📥 已收到：<b>"+(current.pendingUploads?.length||0)+"</b> 个资源\\n⏱️ 已等待 "+UPLOAD_IDLE_SECONDS+" 秒。\\n\\n还要继续上传吗？",{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}]]}}).catch(()=>{});
        }
      },UPLOAD_TIMEOUT_MS));
      return send(TOKEN,uid,"▶️ <b>可以继续上传</b>\\n\\n请继续发送资源。");
    }
    if(t==="✅ 结束上传") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      return finalizeUpload(uid,s);
    }
    if(!repo()) {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      states.delete(key);
      return send(TOKEN,uid,"❌ <b>资源仓库未绑定</b>\\n\\n请先完成仓库绑定。",adminMenu());
    }
    const media=msg.document||msg.video||msg.audio||msg.animation||msg.photo?.at(-1)||msg.voice||msg.video_note;
    if(!media && !msg.text) return send(TOKEN,uid,"⚠️ <b>内容格式不正确</b>\\n\\n请发送文件、图片、视频、音频或带文字的资源。");
    try {
      const pending=Array.isArray(s.pendingUploads)?s.pendingUploads:[];
      pending.push({messageId:Number(msg.message_id),msg});
      if(uploadTimers.has(key)) clearTimeout(uploadTimers.get(key));
      uploadTimers.set(key,setTimeout(()=>{
        uploadTimers.delete(key);
        const current=states.get(key);
        if(current?.step==="upload_file") {
          send(TOKEN,uid,"⏸️ <b>暂时没有收到新文件</b>\\n\\n📁 文件夹："+escapeHtml(current.directoryName)+"\\n📥 已收到：<b>"+(current.pendingUploads?.length||0)+"</b> 个资源\\n⏱️ 已等待 "+UPLOAD_IDLE_SECONDS+" 秒。\\n\\n还要继续上传吗？",{parse_mode:"HTML",reply_markup:{keyboard:[["▶️ 继续上传","✅ 结束上传"],["🏠 开始"]],resize_keyboard:true}}).catch(()=>{});
        }
      },UPLOAD_TIMEOUT_MS));
      states.set(key,{step:"upload_file",directoryId:s.directoryId,directoryName:s.directoryName,pendingUploads:pending});
      console.log("📥 RESOURCE RECEIVED:", "folder=",s.directoryName, "message=",msg.message_id, "pending=",pending.length);
      // 同一次转发可能会连续收到多条 Telegram 消息。
      // 延迟短暂时间，等这一批消息收齐后只询问一次，避免每个文件都弹一次。
      if(uploadAckTimers.has(key)) clearTimeout(uploadAckTimers.get(key));
      uploadAckTimers.set(key,setTimeout(()=>{
        uploadAckTimers.delete(key);
        const current=states.get(key);
        if(current?.step==="upload_file") {
          send(TOKEN,uid,
            "📥 <b>已收到 "+(current.pendingUploads?.length||0)+" 个文件</b>\\n\\n"+
            "📁 文件夹："+escapeHtml(current.directoryName)+"\\n\\n"+
            "还要继续上传，还是现在结束上传？",
            {parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}]]}}
          ).catch(()=>{});
        }
      },1500));
      return;
    } catch(e) {
      return send(TOKEN,uid,"❌ 接收资源失败：\\n"+String(e.message||e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),{parse_mode:"HTML"});
    }
  }

  if(t==="📌 广播后置顶"&&admin) {
    db.settings.broadcastPin = !Boolean(db.settings.broadcastPin);
    saveDb();
    logAdmin(uid,"切换广播自动置顶",db.settings.broadcastPin ? "开启" : "关闭");
    return sendHtml(TOKEN,uid,
      "<b>📌 广播自动置顶</b>\n\n"+
      (db.settings.broadcastPin
        ? "✅ <b>已开启</b>\n以后使用「📢 广播消息」发送内容后，机器人会自动把本次广播在用户私聊中置顶。"
        : "❌ <b>已关闭</b>\n以后广播只发送，不自动置顶。"),
      adminOpsMenu()
    );
  }

  if(s?.step==="broadcast"&&admin) {
    const timerKey=key+":broadcast";
    if(t==="/cancel") {
      if(uploadTimers.has(timerKey)) { clearTimeout(uploadTimers.get(timerKey)); uploadTimers.delete(timerKey); }
      states.delete(key);
      logAdmin(uid,"取消广播");
      return send(TOKEN,uid,"❌ <b>已取消广播</b>\\n\\n本次广播未继续发送。",adminMenu());
    }
    let ok=0,fail=0;
    for(const id of db.users){
      try {
        const copied = await tg(TOKEN,"copyMessage",{chat_id:id,from_chat_id:uid,message_id:msg.message_id});
        if (db.settings.broadcastPin && copied?.message_id) {
          try {
            await tg(TOKEN,"pinChatMessage",{
              chat_id:id,
              message_id:copied.message_id,
              disable_notification:true
            });
          } catch (pinError) {
            console.error("BROADCAST PIN:",pinError.message,"user=",id);
          }
        }
        ok++;
      } catch(e) {
        fail++;
        console.error("BROADCAST:",e.message,"user=",id);
      }
      await sleep(50);
    }
    if(uploadTimers.has(timerKey)) clearTimeout(uploadTimers.get(timerKey));
    uploadTimers.set(timerKey,setTimeout(()=>{
      uploadTimers.delete(timerKey);
      const current=states.get(key);
      if(current?.step==="broadcast") {
        states.delete(key);
        send(TOKEN,uid,"⏸️ <b>暂时没有收到新的广播内容</b>\\n\\n📢 广播模式已等待 3 分钟。\\n\\n还要继续广播吗？",{parse_mode:"HTML",reply_markup:{keyboard:[["▶️ 继续广播","✅ 结束广播"],["🏠 开始"]],resize_keyboard:true}}).catch(()=>{});
      }
    },UPLOAD_TIMEOUT_MS));
    states.set(key,{step:"broadcast"});
    console.log("📢 BROADCAST SENT:", "message=",msg.message_id, "success=",ok, "fail=",fail, "users=",db.users.length);
    return send(TOKEN,uid,"📢 <b>广播发送完成</b>\\n\\n✅ 成功发送：<b>"+ok+"</b> 人\\n❌ 发送失败：<b>"+fail+"</b> 人\\n👥 用户总数：<b>"+db.users.length+"</b> 人\\n\\n你可以继续发送下一条广播。\\n⏱️ 连续 3 分钟没有新内容将自动结束。",{parse_mode:"HTML"});
  }

  if((t==="⚙️ 平台设置" || t==="⚙️ 平台管理")&&admin) {
    return send(TOKEN,uid,
      "⚙️ <b>平台管理</b>\\n\\n"+
      "📦 资源仓库 · 管理资源来源\\n"+
      "🔐 指定群 · 管理访问资格\\n"+
      "🔍 仓库扫描 · 建立历史索引\\n"+
      "📊 数据统计 · 查看平台数据\\n\\n"+
      configText(),
      {parse_mode:"HTML",...platformMenu()}
    );
  }
  if(t==="⬅️ 返回管理"&&admin) return send(TOKEN,uid,"👑 <b>管理员控制台</b>\\n\\n请选择需要管理的项目。",{parse_mode:"HTML",...adminMenu()});
}

async function childMessage(child,msg,token) {
  if(msg.chat?.type!=="private") return;
  const uid=msg.from.id,t=msg.text||"",key="c:"+child.botId+":"+uid,s=states.get(key);
  const startCommand=t.split(" ")[0].split("@")[0];

  // 主机器人和所有子机器人共用同一个 db.resources / db.directories。
  if(startCommand==="/start" && t.startsWith("/start share_")) {
    const shareToken=t.slice("/start share_".length).trim();
    const item=getResourceByShareToken(shareToken);
    if(!item) return sendHtml(token,uid,"<b>🔗 分享资源</b>\n\n❌ 这个分享链接已失效或资源不存在。",childMenu());
    try {
      await sendIndexedResource(token,uid,item);
      recordStat(uid,"download",1);
      recordResourceDownload(item);
      recordRecent(uid,item);
      saveDb();
      return sendHtml(token,uid,"<b>🔗 分享资源</b>\n━━━━━━━━━━━━━━\n\n📦 <b>"+escapeHtml(item.title||"未命名资源")+"</b>\n📁 文件夹：<b>"+escapeHtml(db.directories.find(d=>String(d.id)===String(item.directoryId))?.name||"未分类")+"</b>\n\n✅ 资源已发送。",childMenu());
    } catch {
      return sendHtml(token,uid,"<b>❌ 资源获取失败</b>\n\n请稍后重试。",childMenu());
    }
  }

  if(t==="⭐ 我的资源") return sendHtml(token,uid,userFeatureText(),{reply_markup:userFeatureKeyboard()});

  if(startCommand==="/start" || t==="🏠 开始") return sendHtml(token,uid,
    "<b>👋 欢迎使用资源机器人</b>\n\n📚 <b>共享资源功能</b>：目录 · 搜索 · 随机 · 最新\n\n👇 <i>请选择下方功能</i>",childMenu());

  if(!(await allowed(TOKEN,uid))) return sendHtml(token,uid,"<b>🔐 请先加入指定群</b>\n\n加入后即可继续使用资源功能。",childMenu());

  if(t==="📂 资源目录") {
    if(!db.directories.length) return sendHtml(token,uid,"<b>📂 暂无资源目录</b>\n\n管理员创建目录后，所有机器人会自动同步看到。",childMenu());
    return sendHtml(token,uid,directoryText(),{reply_markup:directoryInlineKeyboard()});
  }
  if(t==="🔎 搜索资源"){
    states.set(key,{step:"search"});
    return sendHtml(token,uid,"<b>🔎 搜索资源</b>\n\n请输入关键词，例如：作者名、标题或关键词。\n\n发送 /cancel 可取消。");
  }
  if(t==="🎲 随机获取") return deliverFromHistory(token,uid,uid,random10(uid),{mode:"random",offset:0,total:db.resources.length});
  if(t==="🆕 最新资源") return deliverFromHistory(token,uid,uid,db.resources.slice(0,10),{mode:"latest",offset:0,total:db.resources.length});
  if(s?.step==="nonmember_quota_edit"){
    if(t==="/cancel"){states.delete(key);return sendHtml(token,uid,"<b>↩️ 已取消修改</b>",adminMenu());}
    if(!isAdmin(uid)){states.delete(key);return;}
    const n=Number(t);if(!Number.isInteger(n)||n<0||n>100)return sendHtml(token,uid,"❌ 请输入 0～100 的整数。",adminMenu());
    db.settings.nonMemberDailyLimit=n;states.delete(key);saveDb();logAdmin(uid,"修改非会员额度","每日 "+n+" 个");
    return sendHtml(token,uid,"<b>✅ 非会员每日额度已修改</b>\n\n📦 每日免费：<b>"+n+"<\/b> 个资源",adminMenu());
  }

  if(s?.step==="search"){
    if(t==="/cancel"){states.delete(key);return sendHtml(token,uid,"<b>↩️ 已退出搜索</b>\n\n👇 请选择其他功能。",childMenu());}
    recordStat(uid,"search",1);
    saveDb();
    const results=search(t);
    if(!results.length) return sendHtml(token,uid,"<b>📭 没有找到相关资源</b>\n\n关键词：<code>"+escapeHtml(t)+"</code>\n\n💡 可以换一个更短的关键词再试。",childMenu());
    states.set(key,{step:"search_results",query:t,results,page:0});
    return sendHtml(token,uid,
      "🔎 <b>搜索资源</b>\n━━━━━━━━━━━━━━\n🔍 关键词：<b>"+escapeHtml(t)+"</b>\n📚 共找到 <b>"+results.length+"</b> 个结果\n📄 第 <b>1 / "+Math.max(1,Math.ceil(results.length/10))+"</b> 页\n\n👇 <b>点击下方资源名称获取</b>",
      resourceInlineKeyboard(results,0));
  }
}
async function handleDirectoryCallback(token, q, child=false) {
  const uid=q.from?.id;
  const data=String(q.data||"");
  const callbackId=q.id;
  const chatId=q.message?.chat?.id;
  const messageId=q.message?.message_id;

  if(!uid || !callbackId || !chatId || !messageId) return;

  const answer=async(text="",showAlert=false)=>{
    try {
      const body={callback_query_id:callbackId};
      if(text) { body.text=text; body.show_alert=showAlert; }
      await tg(token,"answerCallbackQuery",body);
    } catch {}
  };


  if(data==="hub"||data.startsWith("hub:")){await answer();
    const mode=data.split(":")[1]||"home";
    if(mode==="home")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureText(),parse_mode:"HTML",reply_markup:userFeatureKeyboard()});
    if(mode==="fav"){const items=userFavorites(uid).map(resourceByKey).filter(Boolean);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("⭐ 我的收藏",items),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"getfav:")});}
    if(mode==="recent"){const ids=Array.isArray(db.settings.userRecent?.[String(uid)])?db.settings.userRecent[String(uid)]:[];const items=ids.map(resourceByKey).filter(Boolean);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("🕘 最近浏览",items),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"getrecent:")});}
    if(mode==="hot"){const items=[...db.resources].sort((a,b)=>Number(b.downloads||0)-Number(a.downloads||0)).slice(0,20);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("🔥 热门资源",items,"按获取次数排序"),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"gethot:")});}
    if(mode==="tags"){const map=allResourceTags();const tags=Object.keys(map).sort((a,b)=>map[b].length-map[a].length).slice(0,30);const rows=[];for(let i=0;i<tags.length;i+=2)rows.push(tags.slice(i,i+2).map(t=>({text:"🏷️ "+t.slice(0,18)+" · "+map[t].length,callback_data:"tag:"+t.slice(0,40)})));if(!rows.length)rows.push([{text:"📭 暂无标签",callback_data:"noop"}]);rows.push([{text:"⬅️ 返回",callback_data:"hub"}]);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🏷️ 标签分类</b>\n━━━━━━━━━━━━━━\n\n📚 标签数：<b>"+tags.length+"</b>\n\n👇 请选择标签",parse_mode:"HTML",reply_markup:{inline_keyboard:rows}});}
  }
  if(data.startsWith("tag:")){await answer();const tag=data.slice(4),items=db.resources.filter(x=>resourceTags(x).includes(tag)).slice(0,20);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("🏷️ "+escapeHtml(tag),items),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"gettag:","hub:tags")});}
  if(data.startsWith("favtoggle:")){const item=resourceByKey(data.slice(10));if(!item){await answer("资源不存在",true);return;}const on=toggleFavorite(uid,item);await answer(on?"⭐ 已收藏":"☆ 已取消收藏");return;}
  for(const prefix of ["getfav:","getrecent:","gethot:","gettag:"]){
    if(data.startsWith(prefix)){
      const item=resourceByKey(data.slice(prefix.length));if(!item){await answer("资源不存在或已删除",true);return;}
      const member=await allowed(TOKEN,uid);if(!member&&!isAdmin(uid)&&nonMemberDailyRemaining(uid)<=0){await answer("今日免费额度已用完",true);return sendQuotaNotice(token,chatId,uid,userMenu());}
      try{await answer("正在获取资源…");await sendIndexedResource(token,chatId,item);recordStat(uid,"download",1);recordResourceDownload(item);recordRecent(uid,item);if(!member&&!isAdmin(uid))consumeNonMemberQuota(uid,1);else saveDb();return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>✅ 已发送资源</b>\n\n📦 "+escapeHtml(item.title||"未命名资源")+"\n\n👇 可以继续浏览",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:isFavorite(uid,item)?"⭐ 已收藏":"☆ 收藏",callback_data:"favtoggle:"+resourceKey(item)}],
        [{text:"⬅️ 返回我的资源",callback_data:"hub"}]
      ]}});}catch(e){await answer("获取失败："+String(e.message||e),true);return;}
    }
  }
  if(data.startsWith("admin:")||data.startsWith("adm:")){await answer();
    if(child||!isAdmin(uid)){await answer("无权限",true);return;}
    const route=data.slice(data.indexOf(":")+1);
    if(data==="admin:root")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>⚙️ 管理中心</b>\n━━━━━━━━━━━━━━\n\n👇 请选择管理功能",parse_mode:"HTML",reply_markup:adminRootInline()});
    if(data==="admin:home")return sendHtml(token,uid,"<b>👋 已返回首页</b>\n\n请选择功能。",userMenu());
    if(data==="admin:resource")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📦 资源管理</b>\n━━━━━━━━━━━━━━\n\n👇 请选择操作",parse_mode:"HTML",reply_markup:adminResourceInline()});
    if(data==="admin:ops")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📊 数据与运营</b>\n━━━━━━━━━━━━━━\n\n👇 请选择操作",parse_mode:"HTML",reply_markup:adminOpsInline()});
    if(data==="admin:settings")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>⚙️ 系统设置</b>\n━━━━━━━━━━━━━━\n\n👇 请选择设置",parse_mode:"HTML",reply_markup:adminSettingsInline()});
    if(data==="admin:bot")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🤖 机器人管理</b>\n━━━━━━━━━━━━━━\n\n👇 请选择操作",parse_mode:"HTML",reply_markup:adminBotInline()});
    if(data==="admin:maintenance")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🧹 资源维护</b>\n━━━━━━━━━━━━━━\n\n👇 选择检查项目",parse_mode:"HTML",reply_markup:adminMaintenanceMenu()});
    if(data==="admin:upload")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📤 上传资源</b>\n━━━━━━━━━━━━━━\n\n👇 请选择文件夹",parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
    if(data==="admin:prompts")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📝 用户提示</b>\n━━━━━━━━━━━━━━\n\n👇 请选择要编辑的提示",parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"✏️ 非会员提示",callback_data:"adm:nonmember"},{text:"✏️ 获取后提示",callback_data:"adm:post"}],
      [{text:"⬅️ 返回",callback_data:"admin:ops"}]
    ]}});
    if(data==="adm:nonmember")return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"✏️ 非会员提示"});
    if(data==="adm:post")return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📣 获取后推广"});
    const syn={rename:"✏️ 修改文件夹名称",delete:"🗑️ 删除资源",move:"🔄 移动资源",bulk:"📦 批量管理",share:"🔗 分享资源",repo:"📦 资源仓库",scan:"🔍 仓库扫描",group:"🔐 指定群管理",admins:"👥 管理员管理",stats:"📊 数据统计",broadcast:"📢 广播消息",logs:"📜 操作日志",pin:"📌 广播后置顶",post:"📣 获取后推广",clone:"🤖 克隆机器人"};
    if(syn[route])return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:syn[route]});
    if(route==="protect")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:contentProtectionText(),parse_mode:"HTML",reply_markup:contentProtectionMenu()});
    if(route==="quota")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:quotaSettingsText(),parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"➕ +1",callback_data:"quota:+1"},{text:"➖ -1",callback_data:"quota:-1"}],
      [{text:"✏️ 自定义",callback_data:"quota:set"}],
      [{text:"⬅️ 返回系统设置",callback_data:"admin:settings"}]
    ]}});
    if(route==="dupes"){
      const map={};for(const x of db.resources){const k=x.fileId?"file:"+x.fileId:"name:"+String(x.title||"").trim().toLowerCase();(map[k]??=[]).push(x);}
      const groups=Object.values(map).filter(x=>x.length>1),dup=groups.reduce((n,g)=>n+g.length-1,0);
      const kb={inline_keyboard:[]};if(groups.length)kb.inline_keyboard.push([{text:"🧹 清理重复索引",callback_data:"admin:dupeclean"}]);kb.inline_keyboard.push([{text:"⬅️ 返回资源维护",callback_data:"admin:maintenance"}]);
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🔄 重复资源检查</b>\n━━━━━━━━━━━━━━\n\n📚 资源总数："+db.resources.length+"\n♻️ 重复组："+groups.length+"\n🗑️ 可清理："+dup+"\n\n"+(groups.length?"清理只影响数据库索引，不删除仓库消息。":"✅ 暂未发现重复资源。"),parse_mode:"HTML",reply_markup:kb});
    }
    if(route==="dupeclean"){
      const seen=new Set(),before=db.resources.length;db.resources=[...db.resources].filter(x=>{const k=x.fileId?"file:"+x.fileId:"name:"+String(x.title||"").trim().toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});touchSharedData(uid);saveDb();logAdmin(uid,"清理重复索引","移除 "+(before-db.resources.length)+" 条");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>✅ 重复索引清理完成</b>\n\n🗑️ 移除："+(before-db.resources.length)+" 条\n📚 剩余："+db.resources.length+"\n\n⚠️ Telegram 仓库消息未删除。",parse_mode:"HTML",reply_markup:adminMaintenanceMenu()});
    }
    if(route==="health"){
      const rr=repo(),orphan=db.resources.filter(x=>x.directoryId&&!db.directories.some(d=>String(d.id)===String(x.directoryId))).length,empty=db.directories.filter(d=>!db.resources.some(x=>String(x.directoryId)===String(d.id))).length,missing=db.resources.filter(x=>!x.chatId||!x.messageId).length;
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🧹 仓库健康检查</b>\n━━━━━━━━━━━━━━\n\n📚 资源索引："+db.resources.length+"\n📁 文件夹："+db.directories.length+"\n🏠 仓库："+(rr?"已绑定":"未绑定")+"\n⚠️ 孤立资源："+orphan+"\n📭 空文件夹："+empty+"\n🔗 无消息指针："+missing+"\n\n<i>不会自动删除 Telegram 仓库消息。</i>",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:"🔄 重新检查",callback_data:"admin:health"}],
        [{text:"⬅️ 返回资源维护",callback_data:"admin:maintenance"}]
      ]}});
    }
    if(route==="tags"){
      const map=allResourceTags(),tags=Object.entries(map).sort((a,b)=>b[1].length-a[1].length).slice(0,20),body=tags.length?tags.map(([k,v])=>"🏷️ "+escapeHtml(k)+"：<b>"+v.length+"</b>").join("\n"):"📭 暂无标签";
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🏷️ 标签统计</b>\n━━━━━━━━━━━━━━\n\n"+body,parse_mode:"HTML",reply_markup:adminMaintenanceMenu()});
    }
  }
  if(data.startsWith("protect:")){
    if(!isAdmin(uid) || child){await answer("无权限",true);return;}
    const op=data.slice("protect:".length);
    if(op==="toggle"){
      db.settings.contentProtection=!contentProtectionEnabled();
      if(!contentProtectionEnabled()) db.settings.autoDeleteMinutes=0;
      else if(!autoDeleteMinutes()) db.settings.autoDeleteMinutes=1440;
      saveDb(); logAdmin(uid,"内容保护",contentProtectionEnabled()?"开启":"关闭");
      await answer(contentProtectionEnabled()?"已开启":"已关闭");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:contentProtectionText(),parse_mode:"HTML",reply_markup:contentProtectionMenu()});
    }
    if(op==="duration"){
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:contentProtectionText(),parse_mode:"HTML",reply_markup:contentProtectionMenu()});
    }
    if(op.startsWith("set:")){
      const n=Math.max(0,Number(op.slice(4))||0);
      db.settings.autoDeleteMinutes=n;
      if(n>0) db.settings.contentProtection=true;
      saveDb(); logAdmin(uid,"自动删除",n?autoDeleteText():"关闭");
      await answer(n?("自动删除："+autoDeleteText()):"已关闭自动删除");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:contentProtectionText(),parse_mode:"HTML",reply_markup:contentProtectionMenu()});
    }
  }

  if(data.startsWith("quota:")){
    if(child||!isAdmin(uid)){await answer("无权限",true);return;}
    const op=data.slice(6);
    if(op==="+1"||op==="-1"){db.settings.nonMemberDailyLimit=Math.max(0,nonMemberDailyLimit()+(op==="+1"?1:-1));saveDb();return safeEdit(token,{chat_id:chatId,message_id:messageId,text:quotaSettingsText(),parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"➕ +1",callback_data:"quota:+1"},{text:"➖ -1",callback_data:"quota:-1"}],
      [{text:"✏️ 自定义",callback_data:"quota:set"}],
      [{text:"⬅️ 返回系统设置",callback_data:"admin:settings"}]
    ]}});}
    if(op==="set"){states.set("m:"+uid,{step:"nonmember_quota_edit"});await answer("请输入新的每日额度");return sendHtml(token,uid,"<b>🎁 修改非会员每日额度</b>\n\n请发送 0～100 的整数。",adminMenu());}
  }

  if(data==="move_cancel" || data.startsWith("move_to:")) {
    if(!isAdmin(uid) || child) { await answer("无权限",true); return; }
    const key="m:"+uid;
    const st=states.get(key);
    if(!st || (st.step!=="move_target" && st.step!=="bulk_target")) { await answer("操作已过期",true); return; }
    if(data==="move_cancel") { states.delete(key); await answer("已取消"); return send(TOKEN,uid,"❌ 已取消移动。",adminResourceMenu()); }
    const targetId=data.slice("move_to:".length);
    const target=db.directories.find(d=>String(d.id)===String(targetId));
    const item=db.resources.find(r=>Number(r.messageId)===Number(st.itemId)&&String(r.directoryId)===String(st.sourceId));
    if(!target||!item) { await answer("资源或目标文件夹不存在",true); return; }
    item.directoryId=target.id;
    saveDb();
    logAdmin(uid,"移动资源",(item.title||"未命名")+" → "+target.name);
    states.delete(key);
    await answer("移动完成");
    return sendHtml(TOKEN,uid,"<b>✅ 资源移动完成</b>\n━━━━━━━━━━━━━━\n\n📦 "+escapeHtml(item.title||"未命名")+"\n📁 目标文件夹：<b>"+escapeHtml(target.name)+"</b>",adminResourceMenu());
  }

  if(data.startsWith("bulk_toggle:") || data.startsWith("bulk_page:") || data==="bulk_move" || data==="bulk_delete" || data==="bulk_delete_confirm" || data==="bulk_delete_cancel" || data==="bulk_cancel") {
    if(!isAdmin(uid) || child) { await answer("无权限",true); return; }
    const key="m:"+uid;
    const st=states.get(key);
    if(!st || st.step!=="bulk_select") { await answer("操作已过期",true); return; }
    if(data==="bulk_cancel") { states.delete(key); await answer("已取消"); return send(TOKEN,uid,"❌ 已取消批量管理。",adminResourceMenu()); }
    if(data.startsWith("bulk_page:")) {
      const page=Math.max(0,Number(data.slice(10))||0);
      st.page=page; states.set(key,st);
      await answer("已切换");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📦 <b>批量管理</b>\n\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\n\n👇 点击资源进行多选。",parse_mode:"HTML",reply_markup:resourceMoveMenu(st.items,page,st.selected)});
    }
    if(data.startsWith("bulk_toggle:")) {
      const p=Number(data.split(":")[1])||0, idx=Number(data.split(":")[2])||0;
      const item=st.items[p*10+idx];
      if(!item) { await answer("资源不存在",true); return; }
      const id=String(item.messageId), at=st.selected.indexOf(id);
      if(at>=0) st.selected.splice(at,1); else st.selected.push(id);
      st.page=p; states.set(key,st);
      await answer(at>=0?"已取消选择":"已选择");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📦 <b>批量管理</b>\n\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\n\n👇 点击资源进行多选。",parse_mode:"HTML",reply_markup:resourceMoveMenu(st.items,p,st.selected)});
    }
    if(data==="bulk_delete") {
      if(!st.selected.length) { await answer("请先选择资源",true); return; }
      st.step="bulk_delete_confirm"; states.set(key,st);
      await answer("请确认删除");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,
        text:"⚠️ <b>确认批量删除？</b>\\n\\n"+
          "📁 文件夹："+escapeHtml(db.directories.find(d=>String(d.id)===String(st.sourceId))?.name||"未命名")+"\\n"+
          "🗑️ 将删除资源：<b>"+st.selected.length+"</b> 个\\n\\n"+
          "此操作会尝试删除仓库中的对应消息。",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[
          [{text:"🗑️ 确认删除",callback_data:"bulk_delete_confirm"},{text:"❌ 取消",callback_data:"bulk_delete_cancel"}]
        ]}});
    }
    if(data==="bulk_delete_cancel") {
      st.step="bulk_select"; states.set(key,st);
      await answer("已取消");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,
        text:"📦 <b>批量管理</b>\\n\\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\\n\\n👇 点击资源进行多选。",
        parse_mode:"HTML",reply_markup:resourceMoveMenu(st.items,st.page,st.selected)});
    }
    if(data==="bulk_delete_confirm") {
      if(st.step!=="bulk_delete_confirm") { await answer("操作已过期",true); return; }
      const selected=new Set(st.selected.map(String));
      const targets=st.items.filter(x=>selected.has(String(x.messageId)));
      let deleted=0;
      for(const item of targets) {
        try { await tg(TOKEN,"deleteMessage",{chat_id:item.chatId,message_id:Number(item.messageId)}); } catch(e) {}
        const before=db.resources.length;
        db.resources=db.resources.filter(x=>!(String(x.chatId)===String(item.chatId)&&Number(x.messageId)===Number(item.messageId)));
        if(db.resources.length<before) deleted++;
      }
      touchSharedData(uid);
      saveDb();
      logAdmin(uid,"批量删除资源","删除 "+targets.length+" 个，索引移除 "+deleted+" 个");
      states.delete(key);
      await answer("删除完成");
      return sendHtml(TOKEN,uid,
        "<b>🗑️ 批量删除完成</b>\\n━━━━━━━━━━━━━━\\n\\n"+
        "📦 选择资源："+targets.length+" 个\\n"+
        "🗑️ 已从资源索引移除："+deleted+" 个\\n\\n"+
        "📁 其余资源保持不变。",
        adminResourceMenu());
    }

    if(data==="bulk_move") {
      if(!st.selected.length) { await answer("请先选择资源",true); return; }
      st.step="bulk_target"; states.set(key,st);
      await answer("请选择目标文件夹");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📦 <b>批量移动</b>\n\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\n\n👇 请选择目标文件夹。",parse_mode:"HTML",reply_markup:moveFolderMenu(st.sourceId)});
    }
  }

  if(data==="batch:random" || data.startsWith("batch:latest:") || data==="batch:home"){
    if(data==="batch:home"){
      await answer("返回首页");
      return sendHtml(token,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n\\n👇 <i>请选择下方功能开始使用</i>",child ? childMenu() : userMenu());
    }
    if(child){
      if(data==="batch:random"){
        await answer("正在随机获取…");
        return deliverFromHistory(token,uid,uid,random10(uid),{mode:"random",offset:0,total:db.resources.length});
      }
      const offset=Math.max(0,Number(data.split(":")[2])||0);
      await answer("正在获取最新资源…");
      return deliverFromHistory(token,uid,uid,db.resources.slice(offset,offset+10),{mode:"latest",offset,total:db.resources.length});
    }
    if(data==="batch:random"){
      await answer("正在随机获取…");
      return deliver(token,uid,uid,random10(uid),TOKEN,{mode:"random",offset:0,total:db.resources.length});
    }
    const offset=Math.max(0,Number(data.split(":")[2])||0);
    await answer("正在获取最新资源…");
    return deliver(token,uid,uid,db.resources.slice(offset,offset+10),TOKEN,{mode:"latest",offset,total:db.resources.length});
  }

  // 用户搜索结果使用内联按钮：两列排列，结果多时分页，不再占用底部键盘。
  if(data==="src" || data.startsWith("srp:") || data.startsWith("sr:")) {
    const key=(child ? "c:" : "m:")+uid;
    const s=states.get(key);
    if(!s || s.step!=="search_results") {
      await answer("搜索结果已过期，请重新搜索",true);
      return;
    }
    if(data==="src") {
      states.delete(key);
      await answer("已关闭搜索");
      return sendHtml(token,uid,"<b>↩️ 已退出搜索</b>\n\n👇 请选择其他功能。",child ? childMenu() : userMenu());
    }
    if(data.startsWith("srp:")) {
      const page=Math.max(0,Number(data.slice(4))||0);
      const maxPage=Math.max(0,Math.ceil(s.results.length/10)-1);
      const next=Math.min(page,maxPage);
      states.set(key,{step:"search_results",query:s.query,results:s.results,page:next});
      await answer("已切换到第 "+(next+1)+" 页");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"🔎 <b>搜索结果</b>\n━━━━━━━━━━━━━━\n🔍 关键词：<b>"+escapeHtml(s.query)+"</b>\n📚 找到 <b>"+s.results.length+"</b> 个资源\n📄 第 <b>"+(next+1)+" / "+(maxPage+1)+"</b> 页\n\n👇 <b>点击下方资源名称获取</b>",
        parse_mode:"HTML",
        reply_markup:resourceInlineKeyboard(s.results,next)
      });
    }
    const parts=data.split(":");
    const page=Math.max(0,Number(parts[1])||0);
    const idx=Math.max(0,Number(parts[2])||0);
    const pageItems=s.results.slice(page*10,page*10+10);
    const item=pageItems[idx];
    if(!item) {
      await answer("这个搜索结果不存在或已更新",true);
      return;
    }
    const member=await allowed(TOKEN,uid);
    if(!member && !isAdmin(uid) && nonMemberDailyRemaining(uid)<=0) {
      await answer("今日免费额度已用完",true);
      return sendQuotaNotice(token,chatId,uid,child ? childMenu() : userMenu());
    }
    await answer("正在获取资源…");
    try {
      await sendIndexedResource(token,chatId,item);
      recordStat(uid,"download",1);
      recordResourceDownload(item);
      recordRecent(uid,item);
      if(!member && !isAdmin(uid)) consumeNonMemberQuota(uid,1); else saveDb();
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"🔎 <b>搜索结果</b>\n━━━━━━━━━━━━━━\n🔍 关键词：<b>"+escapeHtml(s.query)+"</b>\n📚 找到 <b>"+s.results.length+"</b> 个资源\n📄 第 <b>"+(page+1)+" / "+Math.max(1,Math.ceil(s.results.length/10))+"</b> 页\n\n✅ 已发送：<b>"+escapeHtml(item.title||"未命名资源")+" </b>\n👇 可继续选择其他资源",
        parse_mode:"HTML",
        reply_markup:resourceInlineKeyboard(s.results,page)
      });
    } catch(e) {
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"🔎 <b>搜索结果</b>\n━━━━━━━━━━━━━━\n🔍 关键词：<b>"+escapeHtml(s.query)+"</b>\n📄 第 <b>"+(page+1)+" / "+Math.max(1,Math.ceil(s.results.length/10))+"</b> 页\n\n❌ 获取资源失败：<code>"+escapeHtml(e.message)+"</code>\n👇 请重试或选择其他资源",
        parse_mode:"HTML",
        reply_markup:resourceInlineKeyboard(s.results,page)
      });
    }
  }

  // 管理员上传资源使用内联按钮，不要求额外点击底部键盘。
  if(!child && isAdmin(uid) && (data==="upload_continue" || data==="upload_finish")) {
    const key="m:"+uid;
    const s=states.get(key);
    if(!s || s.step!=="upload_file") {
      await answer("当前没有进行中的上传",true);
      return;
    }
    if(data==="upload_continue") {
      if(uploadTimers.has(key)) clearTimeout(uploadTimers.get(key));
      uploadTimers.set(key,setTimeout(()=>{
        uploadTimers.delete(key);
        const current=states.get(key);
        if(current?.step==="upload_file") {
          send(TOKEN,uid,
            "⏸️ <b>暂时没有收到新文件</b>\n\n"+
            "📁 文件夹："+escapeHtml(current.directoryName)+"\n"+
            "📥 已收到：<b>"+(current.pendingUploads?.length||0)+"</b> 个资源\n\n"+
            "还要继续上传吗？",
            {parse_mode:"HTML",reply_markup:{inline_keyboard:[[
              {text:"▶️ 继续上传",callback_data:"upload_continue"},
              {text:"✅ 结束上传",callback_data:"upload_finish"}
            ]]}}
          ).catch(()=>{});
        }
      },UPLOAD_TIMEOUT_MS));
      await answer("可以继续上传");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"📁 <b>"+escapeHtml(s.directoryName)+"</b>\n\n📤 <b>继续发送文件</b>\n收到的文件都会自动归入当前文件夹。",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[[
          {text:"▶️ 继续上传",callback_data:"upload_continue"},
          {text:"✅ 结束上传",callback_data:"upload_finish"}
        ]]}
      });
    }
    if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
    if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
    await answer("正在结束上传");
    await finalizeUpload(uid,s);
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"✅ <b>已结束本次上传</b>",
      parse_mode:"HTML",
      reply_markup:{inline_keyboard:[]}
    });
  }

  // 管理员上传资源使用内联按钮，不要求额外点击底部键盘。
  if(!child && isAdmin(uid) && (data.startsWith("upload_dir:") || data==="upload_new" || data==="upload_cancel")) {
    if(data==="upload_cancel") {
      states.delete("m:"+uid);
      await answer("已取消上传");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"❌ <b>已取消上传</b>",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[]}
      });
    }
    if(data==="upload_new") {
      states.set("m:"+uid,{step:"upload_folder"});
      await answer("请输入新文件夹名称");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"📁 <b>新建文件夹</b>\\n\\n请直接发送新的文件夹名称。\\n\\n发送 /cancel 可取消。",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[]}
      });
    }
    const directoryId=data.slice("upload_dir:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d) {
      await answer("文件夹不存在，请重新选择",true);
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"⚠️ 这个文件夹已经不存在，请重新选择。",
        parse_mode:"HTML",
        reply_markup:uploadFolderInlineMenu()
      });
    }
    states.set("m:"+uid,{step:"upload_file",directoryId:d.id,directoryName:d.name,pendingUploads:[]});
    await answer("已选择："+d.name);
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"📁 <b>"+escapeHtml(d.name)+"</b>\n\n"+
        "已选择此文件夹，现在可以直接发送文件。\n\n"+
        "📤 <b>发送文件 → 自动归入此文件夹</b>\n\n"+
        "完成后点击：\n"+
        "<b>✅ 结束上传</b>",
      parse_mode:"HTML",
      reply_markup:{inline_keyboard:[]}
    });
  }

  await answer();

  console.log("🔘 DIRECTORY CALLBACK:", {
    bot: child ? "child" : "main",
    user: uid,
    data,
    chatId,
    messageId,
    directories: db.directories.length,
    resources: db.resources.length
  });

  if(data==="noop" || data==="done") return;

  if(data.startsWith("dirsp:")) {
    const page=Math.max(0,Number(data.slice(6))||0);
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:directoryText(),
      parse_mode:"HTML",
      reply_markup:directoryInlineKeyboard(page)
    });
  }

  if(data==="dirs") {
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:directoryText(),
      parse_mode:"HTML",
      reply_markup:directoryInlineKeyboard()
    });
  }

  const m=data.match(/^(?:dir|get):([^:]+):(\d+)$/);
  if(!m) {
    console.warn("⚠️ UNKNOWN DIRECTORY CALLBACK:",data);
    return;
  }

  const directoryId=m[1];
  const offset=Number(m[2]||0);
  const d=db.directories.find(x=>String(x.id)===String(directoryId));

  if(!d) {
    console.warn("⚠️ DIRECTORY NOT FOUND:", {
      directoryId,
      data,
      knownDirectories: db.directories.map(x=>({id:x.id,name:x.name}))
    });
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"⚠️ 这个文件夹记录已经更新，请重新选择当前文件夹。",
      reply_markup:directoryInlineKeyboard()
    });
  }

  const all=directoryItems(d.id);
  const safe=String(d.name).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  if(data.startsWith("dir:")) {
    if(!all.length) {
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"📁 <b>"+safe+"</b>\\n\\n📭 这个文件夹目前没有可获取的资源。",
        parse_mode:"HTML",
        reply_markup:directoryInlineKeyboard()
      });
    }

    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"📁 <b>"+safe+"</b>\n\n━━━━━━━━━━━━\n📦 共 <b>"+all.length+"</b> 个资源\n📤 每次获取 <b>10 个</b>\n\n👇 点击下方按钮开始获取\n━━━━━━━━━━━━",
      parse_mode:"HTML",
      reply_markup:folderSummaryKeyboard(d.id,all.length,0)
    });
  }

  if(offset>=all.length) return;

  const member=await allowed(TOKEN,uid);
  let batch=all.slice(offset,offset+10);
  if(!member && !isAdmin(uid)) {
    const remaining=nonMemberDailyRemaining(uid);
    if(remaining<=0) {
      await answer("今日免费额度已用完",true);
      return sendQuotaNotice(token,chatId,uid);
    }
    batch=batch.slice(0,remaining);
  }
  let sent=0;
  for(const item of batch) {
    try {
      await sendIndexedResource(token,chatId,item);
      sent++;
      recordStat(uid,"download",1);
    } catch(e) {
      console.error("FOLDER BATCH SEND:",e.message,"chat=",chatId,"resource=",item.messageId);
    }
    await sleep(80);
  }

  const next=Math.min(offset+batch.length,all.length);
  if(sent) {
    if(!member && !isAdmin(uid)) consumeNonMemberQuota(uid,sent);
    else saveDb();
  }
  return safeEdit(token,{
    chat_id:chatId,
    message_id:messageId,
    text:"📁 <b>"+safe+"</b>\\n\\n📚 共 <b>"+all.length+"</b> 个资源。\\n📤 本次已发送：<b>"+sent+"</b> 个。\\n📦 已发送：<b>"+next+"</b> / <b>"+all.length+"</b>",
    parse_mode:"HTML",
    reply_markup:folderProgressKeyboard(d.id,all.length,next)
  });
}

async function pollMain() {
  try {
    await main("deleteWebhook",{drop_pending_updates:false});
  } catch (e) {
    runtime.lastError = String(e.message || e);
    console.error("MAIN WEBHOOK:", runtime.lastError);
    await sleep(3000);
  }
  console.log("🌐 Telegram API: https://api.telegram.org");
  console.log("🌐 DNS order:", (() => { try { return dns.getDefaultResultOrder(); } catch { return "unknown"; } })());
  console.log("✅ MAIN POLLING READY");
  while(true){
    try{
      runtime.lastPollAt = Date.now();
      const updates=await main("getUpdates",{offset:db.offset,timeout:25,allowed_updates:["message","callback_query","channel_post","edited_channel_post"]});
      runtime.lastTelegramOkAt = Date.now();
      runtime.lastError = "";
      if (updates.length) runtime.lastUpdateAt = Date.now();
      for(const u of updates){
        console.log("📩 MAIN UPDATE:", u.update_id, u.channel_post ? "channel_post" : u.edited_channel_post ? "edited_channel_post" : u.message ? "message" : "other");
        if(u.channel_post) {
          console.log("📦 CHANNEL POST:", String(u.channel_post.chat?.id), u.channel_post.chat?.title || u.channel_post.chat?.username || "");
          indexResource(u.channel_post);
        }
        if(u.edited_channel_post) {
          console.log("✏️ EDITED CHANNEL POST:", String(u.edited_channel_post.chat?.id));
          indexResource(u.edited_channel_post);
        }
        if(u.callback_query) handleDirectoryCallback(TOKEN,u.callback_query,false).catch(e=>console.error("MAIN CALLBACK:",e.message));
        if(u.message) mainMessage(u.message).catch(e=>console.error("MAIN MESSAGE:",e.message));
        db.offset=u.update_id+1;
      }
      saveDb();
    }catch(e){
      runtime.lastError = String(e.message || e);
      console.error("MAIN POLLING:", e.message);
      console.error("MAIN POLLING DETAIL:", e?.cause || e);
      await sleep(3000);
    }
  }
}

async function childLoop(child) {
  let token;
  try {
    token = decrypt(child.token);
    const me = await tg(token, "getMe");
    child.username = me.username || child.username || "";
    child.botId = me.id;
    saveDb();
    await tg(token, "deleteWebhook", {drop_pending_updates:false});
    console.log("🤖 CHILD CONNECTED:", "@" + (me.username || me.first_name), "id=" + me.id);
    await ensureStartCommand(token);
  } catch (e) {
    child.lastError=String(e?.message||e);
    child.status="dead";
    child.running=false;
    child.restartCount=Number(child.restartCount||0)+1;
    saveDb();
    console.error("❌ CHILD START FAILED:", child.username ? "@" + child.username : "(unknown)", e.message);
    console.warn("⚠️ 子机器人已停止运行，不影响主机器人启动：", child.username ? "@" + child.username : "(unknown)");
    return;
  }

  child.status="running";
  child.running=true;
  while(true){
    try{
      const updates=await tg(token,"getUpdates",{offset:Number(child.offset||0),timeout:25,allowed_updates:["message","callback_query"]});
      if (updates.length) console.log("📩 CHILD UPDATE:", "@" + (child.username || child.botId), "count=" + updates.length);
      for(const u of updates){
        child.offset=u.update_id+1;
        if(u.callback_query) await handleDirectoryCallback(token,u.callback_query,true);
        if(u.message) await childMessage(child,u.message,token);
      }
      saveDb();
    }catch(e){
      console.error("❌ CHILD @" + (child.username || child.botId) + ":",e.message);
      await sleep(3000);
    }
  }
}
function startChild(child){
  const runnerId=String(child.id||child.botId||child.username||"child");
  if(childRunners.has(runnerId)) return;
  const runner=childLoop(child)
    .catch(e=>{
      console.error("❌ CHILD FATAL:",child.username ? "@"+child.username : child.botId,e);
      child.lastError=String(e?.message||e);
      child.status="dead";
      child.running=false;
      child.restartCount=Number(child.restartCount||0)+1;
      saveDb();
    })
    .finally(()=>childRunners.delete(runnerId));
  childRunners.set(runnerId,runner);
}

async function boot(){
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  saveDb();

  if (!TOKEN) {
    runtime.lastError = "BOT_TOKEN 未配置";
    console.error("❌ BOT_TOKEN 未配置，等待环境变量后自动重试");
  }

  console.log("🛡️ 内容保护：", contentProtectionEnabled() ? "开启" : "关闭", "自动删除：", autoDeleteText());
  setInterval(() => { processAutoDeleteQueue().catch(e=>console.warn("⚠️ 自动删除任务异常：",e.message)); }, 30000);
  processAutoDeleteQueue().catch(e=>console.warn("⚠️ 自动删除初始化失败：",e.message));

  console.log("🫀 BOT HEARTBEAT ENABLED");
  setInterval(() => {
    const s = runtimeStatus();
    console.log("🫀 HEARTBEAT:", "connected="+s.mainConnected, "uptime="+s.uptimeSeconds+"s", "lastPoll="+(s.lastPollAt||"-"), "lastUpdate="+(s.lastUpdateAt||"-"), "error="+(s.lastError||"-"));
  }, 30000);

  while (true) {
    try {
      if (!TOKEN) {
        runtime.mainConnected = false;
        runtime.lastError = "BOT_TOKEN 未配置";
        await sleep(10000);
        continue;
      }

      const me=await main("getMe");
      runtime.mainConnected = true;
      runtime.lastTelegramOkAt = Date.now();
      runtime.lastError = "";
      await ensureStartCommand(TOKEN);
      console.log("✅ 主机器人已连接:","@"+(me.username||me.first_name));
      console.log("📊 users="+db.users.length+" children="+db.children.length+" resources="+db.resources.length);
      console.log("⚙️ "+configText().replaceAll("\n"," | "));

      for(const child of db.children) startChild(child);
      await pollMain();
    } catch (e) {
      runtime.mainConnected = false;
      runtime.lastError = String(e.message || e);
      console.error("❌ MAIN BOOT RETRY:", runtime.lastError);
      console.error("❌ MAIN BOOT DETAIL:", e?.cause || e);
      await sleep(5000);
    }
  }
}
boot().catch(e=>console.error("❌ FATAL BOOT:",e));
process.on("SIGTERM",()=>{console.log("SIGTERM received");server.close(()=>process.exit(0));});