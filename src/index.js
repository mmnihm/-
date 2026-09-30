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
      tokenConfigured: Boolean(BASEROW_TOKEN),
      permissionHint: baserow.lastError && /TABLE_PERMISSION_DENIED|没有表 .*权限/.test(baserow.lastError) ? "请检查 Baserow 数据库令牌的表权限" : null,
      lastOkAt: baserow.lastOkAt ? new Date(baserow.lastOkAt).toISOString() : null,
      lastError: baserow.lastError || null
    }
  };
}

function tokenFingerprint(token) {
  const s = String(token || "").trim();
  return s ? crypto.createHash("sha1").update(s).digest("hex").slice(0, 10) : "未配置";
}

const PROCESS_ID = process.pid;
const TOKEN_FINGERPRINT = tokenFingerprint(TOKEN);

console.log("🚀 Telegram Clone Platform v2 starting...");
console.log("🧩 PROCESS:", "pid=" + PROCESS_ID, "token=" + TOKEN_FINGERPRINT);
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

      if (method === "getUpdates" && /409|Conflict|terminated by other getUpdates request/i.test(String(j.description || ""))) {
        console.error("🚨 Telegram 轮询冲突：同一个 BOT_TOKEN 可能正在另一个进程/部署中运行",
          "pid=" + PROCESS_ID, "token=" + TOKEN_FINGERPRINT);
      }

      const retryAfter = Number(j.parameters?.retry_after || 0);
      if (r.status === 429 && retryAfter > 0 && attempt < maxAttempts - 1) {
        console.warn("⏳ Telegram 限流，"+method+" 等待 "+retryAfter+" 秒后自动重试");
        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      // Telegram 业务拒绝不是网络故障：被踢出频道、chat not found、
      // token 无效、callback 过期等，重试同一个请求没有意义。
      if (r.status >= 400 && r.status < 500) {
        const description = String(j.description || "");
        const err = new Error(description || method + " failed");
        err.telegramStatus = r.status;
        err.telegramDescription = description;
        err.noRetry = true;
        throw err;
      }

      // 部分网关可能用 HTTP 200 返回 Telegram 的业务错误。
      // ok=false 且不是 429 时也不再重复请求。
      if (j.ok === false) {
        const description = String(j.description || "");
        const err = new Error(description || method + " failed");
        err.telegramStatus = r.status;
        err.telegramDescription = description;
        err.noRetry = true;
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

function normalizeBaserowApiUrl(value) {
  let raw=String(value||"https://api.baserow.io").trim();
  // 防止部署平台把多个环境变量错误拼到 BASEROW_API_URL 中。
  raw=raw.replace(/^BASEROW_API_URL\s*=\s*/i,"").trim();
  raw=raw.replace(/\s+BASEROW_TABLE_ID\s*=.*$/i,"").trim();
  raw=raw.replace(/[？?].*$/,"").replace(/\/$/,"");
  if(!/^https?:\/\//i.test(raw)) raw="https://"+raw;
  try {
    const u=new URL(raw);
    return u.origin;
  } catch {
    return "https://api.baserow.io";
  }
}
function normalizeBaserowTableId(value) {
  const raw=String(value||"").trim();
  const m=raw.match(/(?:BASEROW_TABLE_ID\s*=\s*)?(\d+)/i);
  return m ? m[1] : "";
}

const BASEROW_API_URL = normalizeBaserowApiUrl(process.env.BASEROW_API_URL);
const BASEROW_TOKEN = String(process.env.BASEROW_TOKEN || process.env.BASEROW_API_TOKEN || "").trim();
const BASEROW_TABLE_ID = normalizeBaserowTableId(process.env.BASEROW_TABLE_ID);

console.log("🧪 BASEROW ENV:",
  "token=" + (BASEROW_TOKEN ? "已读取" : "❌未读取"),
  "tokenLength=" + BASEROW_TOKEN.length,
  "table=" + (BASEROW_TABLE_ID || "❌未配置"),
  "api=" + BASEROW_API_URL
);

const baserow = {
  enabled: Boolean(BASEROW_TOKEN && BASEROW_TABLE_ID),
  connected: false,
  lastError: "",
  lastOkAt: 0
};

async function baserowRequest(method, pathName, body) {
  if (!BASEROW_TOKEN) {
    const e=new Error("Baserow 未配置 BASEROW_TOKEN");
    e.baserowCode="CONFIG_MISSING";
    throw e;
  }
  if (!BASEROW_TABLE_ID && /\/table\//.test(pathName)) {
    const e=new Error("Baserow 未配置 BASEROW_TABLE_ID");
    e.baserowCode="TABLE_ID_MISSING";
    throw e;
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

  const url=BASEROW_API_URL + pathName;
  const r = await fetch(url, options);
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text || "{}"); } catch {}

  if (!r.ok) {
    const detail=String(data?.description || data?.detail || data?.error || text || "请求失败").slice(0, 500);
    const err=new Error("Baserow " + r.status + ": " + detail);
    err.baserowStatus=r.status;
    err.baserowCode=String(data?.error || "");
    err.baserowTableId=BASEROW_TABLE_ID;
    if(r.status===401 && /NO_PERMISSION_TO_TABLE|does not have permissions to the table|permission/i.test(detail+" "+String(data?.error||""))) {
      err.baserowCode="TABLE_PERMISSION_DENIED";
      err.message="Baserow 401：当前 Token 没有表 "+BASEROW_TABLE_ID+" 的权限。请在 Baserow「数据库令牌」中给该表开启至少 Read；恢复/同步写入还需要 Create、Update，删除资源需要 Delete。";
    }
    throw err;
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
    if(e?.baserowCode==="TABLE_PERMISSION_DENIED") {
      baserow.lastError += " | 请检查 BASEROW_TABLE_ID 是否属于当前 Token 所在 workspace，以及 Token 是否勾选该表的 Read 权限";
    }
    console.error("❌ Baserow 连接失败:", baserow.lastError);
    return false;
  }
}

// Baserow 资源同步：扫描/监听到资源后自动写入资源表。
// 兼容不同模板字段名称；不会覆盖用户已有的其他字段。
let baserowFieldsCache = null;
let baserowSyncQueue = Promise.resolve();
// 文件夹同步使用独立队列，不能被数千条资源同步长期堵塞。
let baserowDirectorySyncQueue = Promise.resolve();

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

async function ensureBaserowRecoveryFields() {
  if(!BASEROW_TOKEN || !BASEROW_TABLE_ID) return [];
  const required=[
    {name:"文件夹",type:"text"},
    {name:"聊天ID",type:"text"},
    {name:"消息ID",type:"text"}
  ];
  let fields=await getBaserowFields(true);
  const created=[];

  for(const spec of required){
    if(baserowPickField(fields,[spec.name])) continue;

    // 数据库 Token 主要用于行数据 CRUD；字段结构修改可能需要更高权限。
    // 不让“自动创建字段”把整个恢复流程打断：已有字段照常使用，缺失字段由恢复逻辑自行降级。
    try{
      const field=await baserowRequest(
        "POST",
        "/api/database/fields/table/"+encodeURIComponent(BASEROW_TABLE_ID)+"/",
        {name:spec.name,type:spec.type}
      );
      created.push(field);
      console.log("🛠️ Baserow 自动创建字段:",spec.name);
      fields=await getBaserowFields(true);
    }catch(e){
      console.warn("⚠️ Baserow 无法自动创建字段「"+spec.name+"」：",String(e?.message||e));
      try {
        fields=await getBaserowFields(true);
      } catch(refreshError) {
        // 如果连字段读取都无权限，交给上层统一处理 401。
        throw refreshError;
      }
      if(!baserowPickField(fields,[spec.name])) {
        console.warn("ℹ️ 缺少字段「"+spec.name+"」，继续使用现有字段，不中断恢复。");
      }
    }
  }

  if(created.length){
    baserowFieldsCache=await getBaserowFields(true);
    console.log("✅ Baserow 恢复字段检查完成：",created.map(x=>x?.name).filter(Boolean).join("、"));
  }
  return created;
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
    const urlField = baserowPickField(fields, ["网址","链接","链接地址","URL","Url","Link"]);
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
    if (urlField) {
      const cid=String(item.chatId||"").trim();
      const mid=Number(item.messageId||0);
      let telegramUrl="";
      if(/^-100\d+$/.test(cid) && mid>0) telegramUrl="https://t.me/c/"+cid.slice(4)+"/"+mid;
      else if(item.chatUsername && mid>0) telegramUrl="https://t.me/"+String(item.chatUsername).replace(/^@/,"")+"/"+mid;
      if(telegramUrl) payload[urlField.name]=baserowValueForField(urlField,telegramUrl);
    }
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

    // 优先使用本地保存的 Baserow 行 ID；如果本地没有，使用共享缓存按 chatId+messageId 查找。
    if (!item.baserowRowId) {
      const key=String(item.chatId)+":"+String(item.messageId);
      const cached=baserowRowsCache.get(key);
      if(cached?.id) item.baserowRowId=cached.id;
    }
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
    if(item.baserowRowId) baserowRowsCache.set(String(item.baserowRowId),created);
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

function requestSharedDataRefresh() {
  if (!BASEROW_TOKEN || !BASEROW_TABLE_ID) return;
  if (sharedImmediateRefreshTimer) clearTimeout(sharedImmediateRefreshTimer);
  sharedImmediateRefreshTimer = setTimeout(() => {
    sharedImmediateRefreshTimer = null;
    refreshSharedData(true).catch(e => console.warn("⚠️ 操作后立即刷新异常:", String(e?.message || e)));
  }, 1200);
}

function queueBaserowResourceSync(item) {
  if (!BASEROW_TOKEN || !BASEROW_TABLE_ID || !item) return;
  baserowSyncQueue = baserowSyncQueue
    .then(() => baserowSyncResource(item))
    .catch(e => console.error("❌ Baserow 同步队列:", e.message));
  requestSharedDataRefresh();
}

async function waitBaserowSyncQueue() {
  await baserowSyncQueue;
}

/* ===== 共享资源中心：Baserow 作为唯一共享数据源 ===== */
let baserowRowsCache = new Map();
let sharedRefreshAt = 0;
let sharedRefreshPromise = null;
let sharedImmediateRefreshTimer = null;
let sharedSyncLock = false;

function sharedDirectoryId(name) {
  const clean=String(name||"").trim().replace(/\s+/g," ").toLowerCase();
  return "dir_"+crypto.createHash("sha1").update("baserow-folder:"+clean).digest("hex").slice(0,24);
}

function sharedFolderName(value) {
  if (value && typeof value === "object") return String(value.value ?? value.name ?? "").trim();
  return String(value ?? "").trim();
}

function normalizeSharedDirectories() {
  const oldToNew=new Map();
  const next=[];
  for(const d of Array.isArray(db.directories)?db.directories:[]) {
    const name=String(d?.name||"").trim();
    if(!name) continue;
    const id=sharedDirectoryId(name);
    oldToNew.set(String(d.id),id);
    const exists=next.find(x=>String(x.id)===id);
    if(!exists) next.push({...d,id,name,createdAt:d.createdAt||Date.now()});
  }
  db.directories=next;
  for(const item of db.resources||[]) {
    if(item.directoryId && oldToNew.has(String(item.directoryId))) item.directoryId=oldToNew.get(String(item.directoryId));
  }
}

async function listAllBaserowRows() {
  const rows=[];
  for(let page=1; page<=1000; page++) {
    const data=await baserowRequest(
      "GET",
      "/api/database/rows/table/"+encodeURIComponent(BASEROW_TABLE_ID)+"/?user_field_names=true&size=200&page="+page
    );
    const part=Array.isArray(data?.results)?data.results:[];
    rows.push(...part);
    if(!data?.next || part.length<200) break;
  }
  return rows;
}

function baserowRowKey(row, fields) {
  const chatField=baserowPickField(fields,["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
  const messageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
  const chat=chatField ? String(row?.[chatField.name]??"").trim() : "";
  const message=messageField ? Number(row?.[messageField.name]??0) : 0;
  return chat && message ? chat+":"+message : "";
}

async function baserowSyncDirectory(directory) {
  if(!BASEROW_TOKEN || !BASEROW_TABLE_ID || !directory) return;
  try {
    console.log("📁 Baserow 文件夹同步:", String(directory.name||""), "id="+String(directory.id||""));
    const fields=await getBaserowFields();
    const titleField=baserowPickField(fields,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"]);
    const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
    const messageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
    const chatField=baserowPickField(fields,["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
    const primary=titleField || fields.find(f=>!f.read_only && ["text","long_text"].includes(String(f.type||"")));
    if(!primary || !folderField) throw new Error("Baserow 缺少可用于共享文件夹的“资源名称/文件夹”字段");

    const markerTitle="__FOLDER__:"+directory.id+":"+Buffer.from(String(directory.name)).toString("base64url");
    const existing=Array.from(baserowRowsCache.values()).find(row=>{
      return String(row?.[primary.name]||"").startsWith("__FOLDER__:"+directory.id+":");
    });
    const payload={};
    payload[primary.name]=baserowValueForField(primary,markerTitle);
    const fv=baserowValueForField(folderField,directory.name);
    if(fv!==undefined) payload[folderField.name]=fv;
    if(messageField) payload[messageField.name]=baserowValueForField(messageField,0);
    if(chatField) payload[chatField.name]=baserowValueForField(chatField,repo()?.chatId||"");
    if(existing?.id) {
      await baserowRequest("PATCH","/api/database/rows/table/"+encodeURIComponent(BASEROW_TABLE_ID)+"/"+existing.id+"/?user_field_names=true",payload);
      baserowRowsCache.set("folder:"+directory.id,{...existing,...payload});
    } else {
      const created=await baserowRequest("POST","/api/database/rows/table/"+encodeURIComponent(BASEROW_TABLE_ID)+"/?user_field_names=true",payload);
      baserowRowsCache.set("folder:"+directory.id,created);
    }
    baserow.connected=true; baserow.lastOkAt=Date.now(); baserow.lastError="";
  } catch(e) {
    baserow.lastError=String(e?.message||e);
    console.error("❌ Baserow 文件夹同步失败:",baserow.lastError);
  }
}

function queueBaserowDirectorySync(directory) {
  if(!BASEROW_TOKEN || !BASEROW_TABLE_ID || !directory) return;
  // 文件夹必须优先于资源批量写入，否则历史扫描/迁移后的大量资源会把目录同步堵住。
  baserowDirectorySyncQueue=baserowDirectorySyncQueue
    .then(()=>baserowSyncDirectory(directory))
    .catch(e=>console.error("❌ Baserow 文件夹队列:",e.message));
  requestSharedDataRefresh();
}

async function waitBaserowDirectorySyncQueue() {
  await baserowDirectorySyncQueue;
}

async function baserowDeleteRow(rowId) {
  if(!rowId || !BASEROW_TOKEN || !BASEROW_TABLE_ID) return;
  try {
    await baserowRequest("DELETE","/api/database/rows/table/"+encodeURIComponent(BASEROW_TABLE_ID)+"/"+encodeURIComponent(rowId)+"/");
    baserowRowsCache.delete(String(rowId));
  } catch(e) {
    console.warn("⚠️ Baserow 删除行失败:",String(e?.message||e));
  }
}

function queueBaserowDeleteResource(item) {
  if(!item || !BASEROW_TOKEN || !BASEROW_TABLE_ID) return;
  const rowId=item.baserowRowId;
  if(!rowId) return;
  baserowSyncQueue=baserowSyncQueue.then(()=>baserowDeleteRow(rowId)).catch(e=>console.error("❌ Baserow 删除队列:",e.message));
  requestSharedDataRefresh();
}

async function repairLostFolderAssignments(uid) {
  const started=Date.now();
  try {
    await ensureBaserowRecoveryFields();
    const fields=await getBaserowFields(true);
    const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
    const chatField=baserowPickField(fields,["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
    const messageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
    const urlField=baserowPickField(fields,["网址","链接","链接地址","URL","Url","Link"]);
    const titleField=baserowPickField(fields,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"]);

    // 新表优先使用“聊天ID + 消息ID”；旧表没有这两个字段时，
    // 直接从“网址/链接”里的 Telegram 消息链接恢复，避免强制改表结构。
    if(!folderField) {
      throw new Error("Baserow 恢复需要字段：文件夹。请在表中保留“文件夹”字段。");
    }
    if((!chatField || !messageField) && !urlField) {
      const missing=[!chatField?"聊天ID":"",!messageField?"消息ID":""].filter(Boolean).join("、");
      throw new Error("Baserow 恢复需要字段："+missing+"。当前表也没有“网址/链接”字段可用于兼容恢复。");
    }

    const rows=await listAllBaserowRows();
    const backup=readJsonFile(BACKUP_FILE);
    const dirs=[...(db.directories||[]),...((backup&&Array.isArray(backup.directories))?backup.directories:[])];
    const dirNameById=new Map();
    for(const d of dirs) if(d?.id&&d?.name&&!dirNameById.has(String(d.id))) dirNameById.set(String(d.id),String(d.name).trim());

    const key=(chat,msg)=>{
      const c=String(chat??"").trim(),m=Number(msg||0);
      return c&&m>0?c+":"+m:"";
    };
    const normalizeChat=v=>{
      const s=String(v??"").trim();
      return /^\d{10,}$/.test(s)&&!s.startsWith("-")?"-"+s:s;
    };
    const parseTelegramUrl=url=>{
      const s=String(url||"").trim();
      let m=s.match(/t\.me\/c\/(\d+)\/(\d+)/i);
      if(m) return {chat:"-100"+m[1],message:Number(m[2])};
      m=s.match(/t\.me\/([A-Za-z0-9_]{3,})\/(\d+)/i);
      if(m) return {chat:"@"+m[1],message:Number(m[2])};
      return null;
    };

    const current=new Map((db.resources||[])
      .map(x=>[key(normalizeChat(x.chatId),x.messageId),x])
      .filter(x=>x[0]));
    const backupMap=new Map(((backup&&Array.isArray(backup.resources))?backup.resources:[])
      .map(x=>[key(normalizeChat(x.chatId),x.messageId),x])
      .filter(x=>x[0]));

    let found=0,written=0,localFixed=0,urlRecovered=0;
    const updates=[];

    for(const row of rows){
      if(!row?.id) continue;
      const title=titleField?String(row?.[titleField.name]??"").trim():"";
      if(title.startsWith("__FOLDER__:")) continue;

      let chat=chatField?normalizeChat(row?.[chatField.name]):"";
      let message=messageField?Number(row?.[messageField.name]??0):0;

      if((!chat || !Number.isFinite(message) || message<=0) && urlField){
        const parsed=parseTelegramUrl(row?.[urlField.name]);
        if(parsed){
          chat=parsed.chat;
          message=parsed.message;
          urlRecovered++;
        }
      }

      const k=key(chat,message);
      if(!k) continue;

      const item=current.get(k),old=backupMap.get(k);
      let folder=sharedFolderName(row?.[folderField.name]);
      if(!folder&&item?.directoryId) folder=dirNameById.get(String(item.directoryId))||"";
      if(!folder&&old?.directoryId) folder=dirNameById.get(String(old.directoryId))||"";
      if(!folder) continue;

      if(item&&!item.directoryId){
        let d=(db.directories||[]).find(x=>String(x.name||"").trim()===folder);
        if(!d) d=ensureDirectory(folder);
        item.directoryId=d.id;
        localFixed++;
      }

      if(!sharedFolderName(row?.[folderField.name])){
        const value=baserowValueForField(folderField,folder);
        if(value!==undefined) updates.push({id:row.id,payload:{[folderField.name]:value}});
        found++;
      }
    }

    for(let i=0;i<updates.length;i+=20){
      await Promise.all(updates.slice(i,i+20).map(async u=>{
        try{
          await baserowRequest(
            "PATCH",
            "/api/database/rows/table/"+encodeURIComponent(BASEROW_TABLE_ID)+"/"+encodeURIComponent(u.id)+"/?user_field_names=true",
            u.payload
          );
          written++;
        }catch(e){
          console.warn("⚠️ 文件夹关联写回失败:",String(e?.message||e));
        }
      }));
    }

    saveDb();
    try{await refreshSharedData(true);}catch(e){console.warn("⚠️ 恢复后刷新失败:",String(e?.message||e));}

    return sendHtml(
      TOKEN,
      uid,
      "<b>🛠️ 文件夹资源恢复完成</b>\n━━━━━━━━━━━━━━\n"+
      "📦 Baserow 资源行：<b>"+rows.length+"</b>\n"+
      "📁 当前文件夹：<b>"+db.directories.length+"</b>\n"+
      "♻️ 找回文件夹关联：<b>"+found+"</b>\n"+
      "🔗 网址兼容恢复：<b>"+urlRecovered+"</b>\n"+
      "💾 已写回 Baserow：<b>"+written+"</b>\n"+
      "🧩 本地索引修复：<b>"+localFixed+"</b>\n"+
      "🗃️ 备份："+(backup?"<b>已读取</b>":"<b>未找到</b>")+"\n"+
      "⏱️ 用时："+Math.round((Date.now()-started)/1000)+" 秒",
      adminMenu()
    );
  }catch(e){
    console.error("❌ 文件夹资源恢复失败:",e);
    return sendHtml(TOKEN,uid,"<b>❌ 恢复失败</b>\n\n<code>"+escapeHtml(String(e?.message||e))+"</code>",adminMenu());
  }
}

async function backfillBaserowFolderAssignments(rows, fields, folderField, titleField) {
  if(!folderField || !titleField || !Array.isArray(rows)) return 0;
  const localByTitle=new Map();
  for(const item of (db.resources||[])) {
    const title=String(item?.title||"").trim().toLowerCase();
    if(title && item?.directoryId && !localByTitle.has(title)) localByTitle.set(title,item);
  }
  const updates=[];
  for(const row of rows) {
    if(!row?.id) continue;
    const title=String(row?.[titleField.name]??"").trim();
    if(!title || title.startsWith("__FOLDER__:")) continue;
    const item=localByTitle.get(title.toLowerCase());
    if(!item?.directoryId) continue;
    const d=(db.directories||[]).find(x=>String(x.id)===String(item.directoryId));
    if(!d?.name) continue;
    const current=sharedFolderName(row?.[folderField.name]);
    if(current===d.name) continue;
    const value=baserowValueForField(folderField,d.name);
    if(value===undefined) continue;
    updates.push({id:row.id,payload:{[folderField.name]:value}});
  }
  let done=0;
  for(let i=0;i<updates.length;i+=20) {
    const batch=updates.slice(i,i+20);
    await Promise.all(batch.map(async u=>{
      try {
        await baserowRequest("PATCH","/api/database/rows/table/"+encodeURIComponent(BASEROW_TABLE_ID)+"/"+encodeURIComponent(u.id)+"/?user_field_names=true",u.payload);
        done++;
      } catch(e) {
        console.warn("⚠️ Baserow 文件夹回填失败 row="+u.id+":",String(e?.message||e));
      }
    }));
  }
  if(done) console.log("📁 Baserow 文件夹关联回填完成："+done+" 条");
  return done;
}

async function pullBaserowSharedData() {
  if(!BASEROW_TOKEN || !BASEROW_TABLE_ID || sharedSyncLock) return false;
  sharedSyncLock=true;
  try {
    const fields=await getBaserowFields();
    const rows=await listAllBaserowRows();
    const titleField=baserowPickField(fields,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"]);
    const chatField=baserowPickField(fields,["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
    const messageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
    const urlField=baserowPickField(fields,["网址","链接","链接地址","URL","Url","Link"]);
    const captionField=baserowPickField(fields,["描述","说明","备注","Caption","Description"]);
    const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
    const dateField=baserowPickField(fields,["日期","时间","创建时间","资源日期","Date","Created","Created At"]);
    const typeField=baserowPickField(fields,["类型","文件类型","Type","File Type"]);
    const fileIdField=baserowPickField(fields,["文件ID","File ID","FileID"]);
    const downloadField=baserowPickField(fields,["下载","下载次数","Downloads"]);

    const byKey=new Map();
    const folderNames=new Map();
    let urlNonEmpty=0, telegramPrivateMatches=0, telegramUrlMatches=0;
    baserowRowsCache=new Map();

    for(const row of rows) {
      if(row?.id) baserowRowsCache.set(String(row.id),row);
      const title=titleField ? String(row?.[titleField.name]??"").trim() : "";
      if(title.startsWith("__FOLDER__:")) {
        let folderValue=folderField ? sharedFolderName(row?.[folderField.name]) : "";
        if(!folderValue) {
          const encoded=title.split(":")[2] || "";
          try { folderValue=Buffer.from(encoded,"base64url").toString("utf8").trim(); } catch {}
        }
        if(folderValue) folderNames.set(sharedDirectoryId(folderValue),folderValue);
        continue;
      }
      let chat=chatField ? String(row?.[chatField.name]??"").trim() : "";
      let message=messageField ? Number(row?.[messageField.name]??0) : 0;
      // 兼容旧表：如果没有聊天ID/消息ID，尝试从“网址”中的 Telegram 消息链接恢复。
      if((!chat || !Number.isFinite(message) || message<=0) && urlField) {
        const url=String(row?.[urlField.name]??"").trim();
        if(url) urlNonEmpty++;
        let m=url.match(/t\.me\/c\/(\d+)\/(\d+)/i);
        if(m) { chat="-100"+m[1]; message=Number(m[2]); telegramPrivateMatches++; }
        else {
          m=url.match(/t\.me\/([A-Za-z0-9_]{3,})\/(\d+)/i);
          if(m) { chat="@"+m[1]; message=Number(m[2]); telegramUrlMatches++; }
        }
      }
      if(!chat || !Number.isFinite(message) || message<=0) continue;
      const key=chat+":"+message;
      const folderName=folderField ? sharedFolderName(row?.[folderField.name]) : "";
      if(folderName) folderNames.set(sharedDirectoryId(folderName),folderName);
      byKey.set(key,{row,title,chat,message,folderName});
    }

    console.log("🧪 Baserow 资源恢复诊断：网址非空="+urlNonEmpty+" 私有链接匹配="+telegramPrivateMatches+" 公开链接匹配="+telegramUrlMatches+" 可恢复="+byKey.size+" 总行="+rows.length);
    const oldByKey=new Map((db.resources||[]).map(x=>[String(x.chatId)+":"+String(x.messageId),x]));
    const merged=[];
    for(const [key,v] of byKey) {
      const old=oldByKey.get(key)||{};
      const directoryId=v.folderName ? sharedDirectoryId(v.folderName) : null;
      merged.push({
        ...old,
        chatId:v.chat,
        messageId:v.message,
        title:v.title || old.title || ("资源 #"+v.message),
        caption:captionField ? String(v.row?.[captionField.name]??old.caption??"") : String(old.caption||""),
        date:dateField ? (Number(v.row?.[dateField.name]) || (new Date(v.row?.[dateField.name]||0).getTime()/1000) || old.date || Math.floor(Date.now()/1000)) : (old.date||Math.floor(Date.now()/1000)),
        directoryId,
        fileType:typeField ? String(v.row?.[typeField.name]??old.fileType??"") : old.fileType,
        fileId:fileIdField ? String(v.row?.[fileIdField.name]??old.fileId??"") : old.fileId,
        downloads:downloadField ? Number(v.row?.[downloadField.name]??old.downloads??0) : Number(old.downloads||0),
        baserowRowId:v.row.id
      });
    }

    const dirsById=new Map();
    for(const d of db.directories||[]) {
      const id=sharedDirectoryId(d.name);
      dirsById.set(id,{...d,id});
    }
    for(const [id,name] of folderNames) {
      if(!dirsById.has(id)) dirsById.set(id,{id,name,createdAt:Date.now()});
    }
    db.directories=Array.from(dirsById.values());
    if((chatField && messageField) || urlField) {
      // 关键保护：Baserow 结构异常、旧表缺少定位字段、或当前只解析出少量无效网址时，
      // 绝不能用空的 merged 覆盖本地资源，否则机器人启动后目录会“全部消失”。
      if(merged.length>0 || (db.resources||[]).length===0) {
        db.resources=merged.slice(0,MAX_RESOURCES);
        if(!chatField || !messageField) console.log("🔗 已从 Baserow 网址恢复 Telegram 资源："+db.resources.length);
        if(!chatField || !messageField) await backfillBaserowFolderAssignments(rows,fields,folderField,titleField);
      } else {
        console.warn("⚠️ Baserow 本次未恢复到有效资源，保留本地资源："+String((db.resources||[]).length));
      }
    } else {
      console.warn("⚠️ Baserow 缺少聊天ID/消息ID/网址字段，无法恢复 Telegram 资源；保留本地资源："+String((db.resources||[]).length));
    }
    db.settings.sharedData={...(db.settings.sharedData||{}),version:Number(db.settings.sharedData?.version||0)+1,lastChangedAt:Date.now(),lastChangedBy:"baserow"};
    saveDb();
    console.log("🔄 Baserow 共享数据已刷新：资源="+db.resources.length+"，文件夹="+db.directories.length);
    return true;
  } catch(e) {
    baserow.connected=false;
    baserow.lastError=String(e?.message||e);
    console.error("❌ Baserow 共享数据刷新失败:",baserow.lastError);
    return false;
  } finally {
    sharedSyncLock=false;
  }
}

async function initializeSharedBaserow() {
  if(!BASEROW_TOKEN || !BASEROW_TABLE_ID) return;
  try {
    // 先完成一次真实连接检查，再进入共享初始化。
    // 避免启动初期 checkBaserowConnection() 仍在异步执行时，
    // 日志暂时显示 enabled=false，导致误判为没有启用共享。
    const connected = await checkBaserowConnection();
    if(!connected) {
      console.error("❌ Baserow 共享初始化终止：连接检查未通过", baserow.lastError || "");
      return;
    }
    console.log("🔗 Baserow 共享连接确认：enabled="+String(baserow.enabled)+" connected="+String(baserow.connected)+" table="+BASEROW_TABLE_ID);
    await ensureBaserowRecoveryFields();
    normalizeSharedDirectories();
    // 首次切换共享模式时，先保留本地快照，再与 Baserow 做并集合并，绝不因为远端为空而丢失本地资源。
    const localResources=(db.resources||[]).map(x=>({...x}));
    const localDirectories=(db.directories||[]).map(x=>({...x}));
    await pullBaserowSharedData();

    const remoteKeys=new Set(db.resources.map(x=>String(x.chatId)+":"+String(x.messageId)));
    for(const item of localResources) {
      const key=String(item.chatId)+":"+String(item.messageId);
      if(!remoteKeys.has(key)) {
        db.resources.push(item);
        queueBaserowResourceSync(item);
      }
    }

    const dirMap=new Map(db.directories.map(d=>[sharedDirectoryId(d.name),d]));
    for(const d of localDirectories) {
      const id=sharedDirectoryId(d.name);
      if(!dirMap.has(id)) {
        const nd={...d,id};
        db.directories.push(nd);
        dirMap.set(id,nd);
      }
      queueBaserowDirectorySync(dirMap.get(id));
    }

    db.resources=db.resources.slice(0,MAX_RESOURCES);
    saveDb();
    await waitBaserowSyncQueue();
    await waitBaserowDirectorySyncQueue();
    await pullBaserowSharedData();
  } catch(e) {
    console.error("❌ 共享数据初始化失败:",String(e?.message||e));  }
}

function getBaserowFieldsCacheForSync() { return Array.isArray(baserowFieldsCache)?baserowFieldsCache:[]; }

async function refreshSharedData(force=false) {
  if(!BASEROW_TOKEN || !BASEROW_TABLE_ID) return;
  const now=Date.now();
  if(!force && now-sharedRefreshAt<300000) return;
  if(sharedRefreshPromise) return sharedRefreshPromise;
  sharedRefreshPromise=(async()=>{
    const started=Date.now();
    try {
      // 共享目录读取不能等待资源写入队列；否则历史扫描/批量同步时，
      // 前面的几千条 Baserow 写入会把目录刷新一直排队，导致其他机器人看不到新目录。
      if(db.settings.historyScan?.status==="running" || db.settings.baserowRecovery?.status==="running") {
        console.log("⏸️ Baserow 共享刷新：后台历史任务进行中，跳过本轮");
        return;
      }
      console.log("🔄 Baserow 共享刷新开始");
      await pullBaserowSharedData();
      sharedRefreshAt=Date.now();
      console.log("✅ Baserow 共享刷新完成：耗时="+(Date.now()-started)+"ms 文件夹="+db.directories.length+" 资源="+db.resources.length);
    } catch(e) {
      console.error("❌ Baserow 共享刷新异常:",String(e?.message||e));
    } finally {
      sharedRefreshPromise=null;
    }
  })();
  return sharedRefreshPromise;
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
  return {offset:0, users:[], children:[], resources:[], directories:[], settings:{requiredGroup:null, repository:null, historyAuth:null, historyScan:{status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""},broadcastPin:false,admins:[],logs:[],stats:{downloads:0,searches:0,uploads:0,uploadedResources:0,userActions:{}},userFavorites:{},userRecent:{},sharedData:{version:1,lastChangedAt:Date.now(),lastChangedBy:"system"},nonMemberMessage:"🔐 <b>请先加入指定会员群</b>\n\n加入后即可继续使用资源功能。",postResourceMessage:"✨ <b>更多资源</b>\n\n欢迎继续浏览资源库。",nonMemberDailyLimit:3,nonMemberDailyUsage:{},contentProtection:true,autoDeleteMinutes:1440,autoDeleteQueue:[],resourceSources:[],repositoryMigration:{status:"idle",taskKey:"",ownerId:"",source:null,target:null,sourceId:null,targetId:null,sourceTitle:"",targetTitle:"",scanned:0,queued:0,migrated:0,skipped:0,failed:0,current:0,total:0,startedAt:null,finishedAt:null,error:"",lastError:"",folderMap:{},completedKeys:[],failedKeys:[],progressMessageId:null,autoSync:false},repositoryAutoSync:{enabled:false,status:"idle",ownerId:"",sourceId:"",targetId:"",sourceTitle:"",targetTitle:"",lastMessageId:0,queue:[],copied:0,failed:0,lastError:"",updatedAt:0}}};
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
  db.settings.sharedData.lastChangedBy=String(uid||"system");}

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
      "💡 请确认扫描账号已经加入目标仓库，并在 Telegram 客户端打开过该仓库；如果提示 API 配置错误，请检查 TG_API_ID / TG_API_HASH。"
    ); } catch {}
    throw e;
  });
  try { return await historyConnecting; }
  finally { historyConnecting = null; }
}

async function findHistoryEntity(client, targetRepo=null) {
  const r = targetRepo || repo();
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

async function recoverBaserowHistory(uid, targetRepo=null) {
  if(!BASEROW_TOKEN || !BASEROW_TABLE_ID) return sendHtml(TOKEN,uid,"❌ <b>Baserow 共享未配置</b>\\n\\n请先配置 BASEROW_TOKEN 和 BASEROW_TABLE_ID。",adminMenu());
  const r=targetRepo || repo();
  if(!r) return sendHtml(TOKEN,uid,"❌ <b>没有可恢复的资源仓库</b>\\n\\n请先绑定原来的 Telegram 资源仓库。",adminMenu());
  const current=db.settings.baserowRecovery||{};
  if(String(current.status||"")==="running") {
    const started=Number(current.startedAt||0);
    const last=Number(current.lastMessageId||0);
    const stale=started>0 && (Date.now()-started)>2*60*1000;
    if(!stale) return sendHtml(TOKEN,uid,"🔄 <b>Baserow 历史恢复已经在运行</b>\\n\\n📨 已扫描："+Number(current.scanned||0).toLocaleString()+" 条\\n🔗 已匹配："+Number(current.matched||0).toLocaleString()+" 条\\n🆔 当前进度："+last+"\\n\\n请等待任务继续。",adminMenu());
    console.warn("⚠️ Baserow 历史恢复检测到旧任务卡住，自动从断点继续：", {scanned:Number(current.scanned||0),matched:Number(current.matched||0),lastMessageId:last});
    current.status="error";
    current.error="上一次恢复进程疑似中断，自动从断点继续。";
    current.finishedAt=Date.now();
    db.settings.baserowRecovery=current;
    saveDb();
  }

  let fields, rows;
  try {
    await ensureBaserowRecoveryFields();
    fields=await getBaserowFields(true);
    rows=await listAllBaserowRows();
  }
  catch(e) { return sendHtml(TOKEN,uid,"❌ <b>读取 Baserow 失败</b>\\n\\n"+escapeHtml(e?.message||e),adminMenu()); }

  const titleField=baserowPickField(fields,["名称","资源名称","资源名","标题","资源标题","文件名","文件名称","资源","Name","Title","Resource","Resource Name","File Name"]);
  const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
  const dateField=baserowPickField(fields,["日期","时间","创建时间","资源日期","Date","Created","Created At"]);

  // 兼容旧 Baserow 表：历史数据可能没有“资源名称”字段。
  // 恢复时优先使用 Telegram 定位信息（聊天ID+消息ID/网址），只有没有定位信息时才使用名称匹配。
  const normalizeMatchTitle = value => String(value||"").replace(/\u200b/g,"").replace(/[^\p{L}\p{N}]+/gu,"").trim().toLowerCase();
  const parseRowDate = row => {
    if(!dateField) return 0;
    const raw=row?.[dateField.name], n=Number(raw);
    if(Number.isFinite(n) && n>0) return n>10000000000 ? Math.floor(n/1000) : Math.floor(n);
    const t=new Date(raw||0).getTime();
    return Number.isFinite(t) && t>0 ? Math.floor(t/1000) : 0;
  };

  const candidatesByTitle=new Map();
  const candidatesByIdentity=new Map();
  let folderRowCount=0, resourceRowCount=0;
  const recoveryChatField=baserowPickField(fields,["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
  const recoveryMessageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
  const recoveryUrlField=baserowPickField(fields,["网址","链接","链接地址","URL","Url","Link"]);

  const parseTelegramUrlIdentity = value => {
    const url=String(value||"").trim();
    let m=url.match(/t\.me\/c\/(\d+)\/(\d+)/i);
    if(m) return {chat:"-100"+m[1],message:Number(m[2])};
    m=url.match(/t\.me\/([A-Za-z0-9_]{3,})\/(\d+)/i);
    if(m) return {chat:"@"+m[1],message:Number(m[2])};
    return null;
  };

  for(const row of rows) {
    const rawTitle=titleField ? String(row?.[titleField.name]??"").trim() : "";
    if(rawTitle.startsWith("__FOLDER__:")) { folderRowCount++; continue; }

    const folderName=folderField ? sharedFolderName(row?.[folderField.name]) : "";
    const candidate={id:String(row.id),title:rawTitle,folderName,date:parseRowDate(row),row};
    let chat=recoveryChatField ? String(row?.[recoveryChatField.name]??"").trim() : "";
    let message=recoveryMessageField ? Number(row?.[recoveryMessageField.name]??0) : 0;
    if((!chat || !Number.isFinite(message) || message<=0) && recoveryUrlField) {
      const identity=parseTelegramUrlIdentity(row?.[recoveryUrlField.name]);
      if(identity) { chat=identity.chat; message=identity.message; }
    }
    if(chat && Number.isFinite(message) && message>0) {
      candidatesByIdentity.set(chat+":"+message,candidate);
      resourceRowCount++;
    } else if(rawTitle) {
      const key=normalizeMatchTitle(rawTitle);
      if(key) {
        if(!candidatesByTitle.has(key)) candidatesByTitle.set(key,[]);
        candidatesByTitle.get(key).push(candidate);
        resourceRowCount++;
      }
    }
  }

  const previousLast=Number(current.lastMessageId||0);
  const usedRowIds=new Set(Array.isArray(current.usedRowIds)?current.usedRowIds.map(String):[]);
  const startedAt=Number(current.startedAt)>0 ? Number(current.startedAt) : Date.now();
  const state={status:"running",repositoryId:String(r.chatId||""),repositoryTitle:String(r.title||r.username||r.chatId||""),startedAt,finishedAt:null,lastMessageId:previousLast,scanned:Number(current.scanned||0),matched:Number(current.matched||0),unmatched:Number(current.unmatched||0),folderMatched:Number(current.folderMatched||0),duplicateTitle:Number(current.duplicateTitle||0),usedRowIds:[...usedRowIds].slice(-30000),error:""};
  db.settings.baserowRecovery=state; saveDb();

  let progressMessage=null;
  const elapsedText=()=>{const sec=Math.max(0,Math.floor((Date.now()-startedAt)/1000));return String(Math.floor(sec/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0");};
  const render=done=>"<b>"+(done?"✅ ":"🔄 ")+"Baserow 历史资源恢复</b>\\n━━━━━━━━━━━━━━\\n📦 仓库：<b>"+escapeHtml(state.repositoryTitle)+"</b>\\n🗃️ Baserow 资源行：<b>"+resourceRowCount.toLocaleString()+"</b>\\n📨 已扫描：<b>"+Number(state.scanned).toLocaleString()+"</b>\\n🔗 已匹配：<b>"+Number(state.matched).toLocaleString()+"</b>\\n📁 已恢复文件夹：<b>"+Number(state.folderMatched).toLocaleString()+"</b>\\n⚠️ 未匹配：<b>"+Number(state.unmatched).toLocaleString()+"</b>\\n♻️ 同名候选：<b>"+Number(state.duplicateTitle).toLocaleString()+"</b>\\n🆔 当前进度：<code>"+Number(state.lastMessageId||0)+"</code>\\n⏱️ 用时：<b>"+elapsedText()+"</b>\\n━━━━━━━━━━━━━━\\n"+(done?"📌 Baserow 原有记录未删除，仅补回 Telegram 定位信息。":"⏳ 正在从 Telegram 历史消息匹配 Baserow 记录…");

  const updateProgress=async force=>{
    saveDb();
    if(!progressMessage || force) {
      if(!progressMessage) { try { progressMessage=await sendHtml(TOKEN,uid,render(false),{reply_markup:{inline_keyboard:[]}}); } catch {} }
      return;
    }
    await safeEdit(TOKEN,{chat_id:uid,message_id:progressMessage.message_id,text:render(false),parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{});
  };

  const addRecoveredItem=(message,rowCandidate)=>{
    const messageId=Number(message?.id||0); if(!messageId) return false;
    const text=String(message?.message||message?.text||"").trim();
    const fileName=message?.file?.name || message?.document?.attributes?.find?.(x=>x.fileName)?.fileName || "";
    const hasMedia=Boolean(message?.media||message?.file);
    if(!text && !hasMedia) return false;
    let directoryId=null;
    const folderName=String(rowCandidate?.folderName||"").trim();
    if(folderName) { const d=ensureDirectory(folderName); if(d) {directoryId=String(d.id); state.folderMatched++;} }
    const item={chatId:String(r.chatId),messageId,title:String(fileName||text||("历史资源 #"+messageId)).slice(0,200),caption:text.slice(0,500),date:message?.date ? Math.floor(new Date(message.date).getTime()/1000) : Math.floor(Date.now()/1000),directoryId,fileType:null,fileId:null,textOnly:!hasMedia,downloads:0,baserowRowId:rowCandidate?.id||null};
    const i=db.resources.findIndex(x=>String(x.chatId)===item.chatId&&Number(x.messageId)===item.messageId);
    if(i>=0) db.resources[i]={...db.resources[i],...item}; else db.resources.unshift(item);
    const saved=db.resources.find(x=>String(x.chatId)===item.chatId&&Number(x.messageId)===item.messageId)||item;
    queueBaserowResourceSync(saved);
    return true;
  };

  try {
    console.log("🔄 BASEROW HISTORY RECOVERY START:",{repoId:String(r.chatId||""),rows:resourceRowCount,folders:folderRowCount,checkpoint:previousLast});
    await updateProgress(true);
    const client=await ensureHistoryClient(uid);
    const entity=await findHistoryEntity(client,r);
    let lastProgressAt=Date.now();

    // 不再一次性要求 MTProto 无限历史迭代到底；每个批次最多处理 500 条，
    // 批次之间主动保存断点，避免卡在 Telegram 历史接口的下一页请求时整项任务看起来“死掉”。
    let resumeMessageId=previousLast;
    let reachedEnd=false;
    while(!reachedEnd) {
      let batchCount=0;
      for await(const message of client.iterMessages(entity,{limit:500,offsetId:resumeMessageId||0})) {
        const messageId=Number(message?.id||0);
        if(!messageId) continue;

        // offsetId 已经负责从上一次断点继续，这里不要再用 previousLast 比较，
        // 否则 Telegram 的降序历史消息会在第一条就被错误 break。
        state.scanned++;
        state.lastMessageId=messageId;
        batchCount++;

        const text=String(message?.message||message?.text||"").trim();
        const fileName=message?.file?.name || message?.document?.attributes?.find?.(x=>x.fileName)?.fileName || "";
        const msgTitle=String(fileName||text||("历史资源 #"+messageId)).slice(0,200);
        const identityKey=String(r.chatId)+":"+messageId;
        let candidates=[];
        const exactCandidate=candidatesByIdentity.get(identityKey);
        if(exactCandidate && !usedRowIds.has(String(exactCandidate.id))) candidates=[exactCandidate];

        if(!candidates.length) {
          const matchKey=normalizeMatchTitle(msgTitle);
          candidates=(candidatesByTitle.get(matchKey)||[]).filter(x=>!usedRowIds.has(String(x.id)));
        }

        if(candidates.length) {
          if(candidates.length>1) {
            state.duplicateTitle++;
            const msgDate=message?.date ? Math.floor(new Date(message.date).getTime()/1000) : 0;
            if(msgDate) candidates.sort((a,b)=>Math.abs((a.date||msgDate)-msgDate)-Math.abs((b.date||msgDate)-msgDate));
          }
          const picked=candidates[0];
          usedRowIds.add(String(picked.id));
          state.usedRowIds=[...usedRowIds].slice(-30000);
          if(addRecoveredItem(message,picked)) state.matched++;
        } else {
          state.unmatched++;
        }

        if(state.scanned%100===0 || Date.now()-lastProgressAt>=15000) {
          lastProgressAt=Date.now();
          await updateProgress(false);
          console.log("🔄 BASEROW HISTORY RECOVERY:",state.scanned,"matched=",state.matched,"unmatched=",state.unmatched,"checkpoint=",state.lastMessageId);
        }
      }

      if(batchCount===0) {
        reachedEnd=true;
      } else {
        resumeMessageId=Number(state.lastMessageId||0);
        state.lastMessageId=resumeMessageId;
        saveDb();
        await updateProgress(false);
      }
    }

    db.resources=db.resources.slice(0,MAX_RESOURCES);
    await waitBaserowSyncQueue(); await waitBaserowDirectorySyncQueue();
    state.status="completed"; state.finishedAt=Date.now(); state.usedRowIds=[...usedRowIds].slice(-30000); saveDb();
    const doneText=render(true)+"\\n\\n📚 当前资源索引：<b>"+db.resources.length.toLocaleString()+"</b> 条";
    if(progressMessage) return safeEdit(TOKEN,{chat_id:uid,message_id:progressMessage.message_id,text:doneText,parse_mode:"HTML",reply_markup:adminMenu().reply_markup});
    return sendHtml(TOKEN,uid,doneText,adminMenu());
  } catch(e) {
    state.status="error"; state.error=String(e?.message||e); state.finishedAt=Date.now(); state.usedRowIds=[...usedRowIds].slice(-30000); saveDb();
    console.error("❌ BASEROW HISTORY RECOVERY:",e);
    const errorText="<b>❌ Baserow 历史恢复中断</b>\\n\\n"+render(false)+"\\n\\n⚠️ "+escapeHtml(e?.message||e)+"\\n\\n再次点击“恢复历史资源”会从当前断点继续。";
    if(progressMessage) return safeEdit(TOKEN,{chat_id:uid,message_id:progressMessage.message_id,text:errorText,parse_mode:"HTML",reply_markup:adminMenu().reply_markup});
    return sendHtml(TOKEN,uid,errorText,adminMenu());
  }
}

async function scanHistory(uid, targetRepo=null) {
  const historyState = db.settings.historyScan || {};
  if (historyState.status === "running") {
    const started = Number(historyState.startedAt || 0);
    const stale = started > 0 && (Date.now() - started) > 10 * 60 * 1000;
    if (!stale) return send(TOKEN,uid,"🔍 历史扫描已经在进行中，请稍候。");
    console.warn("⚠️ 检测到上一次历史扫描状态卡住，自动恢复扫描：", {
      startedAt: started ? new Date(started).toISOString() : null,
      scanned: Number(historyState.scanned || 0),
      indexed: Number(historyState.indexed || 0),
      lastMessageId: Number(historyState.lastMessageId || 0)
    });
    historyState.status = "error";
    historyState.error = "上一次扫描进程已中断，已自动恢复。";
    historyState.finishedAt = Date.now();
    db.settings.historyScan = historyState;
    saveDb();
  }
  const r = targetRepo || repo();
  if (!r) return send(TOKEN,uid,"❌ <b>没有可扫描的资源仓库</b>\\n\\n请先绑定仓库，或从「🔄 迁移仓库」指定旧仓库。",adminMenu());

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
    console.log("🔎 HISTORY SCAN START:", { uid:String(uid), repoId:String(r.chatId||""), repoTitle:String(r.title||""), repoUsername:String(r.username||""), checkpoint:previousCheckpoint, baserow:Boolean(BASEROW_TOKEN && BASEROW_TABLE_ID) });
    await updateProgress(0,0,previousCheckpoint,true);
    try {
      await sendHtml(TOKEN,uid,"<b>🚀 扫描任务已启动</b>\\n\\n📦 仓库："+escapeHtml(r.title||String(r.chatId))+"\\n🔐 正在连接扫描账号，请稍候…");
    } catch {}
    console.log("🔎 HISTORY SCAN: progress message sent, connecting MTProto...");
    const client = await ensureHistoryClient(uid);
    console.log("🔎 HISTORY SCAN: MTProto ready, locating repository...");
    const entity = await findHistoryEntity(client, r);
    console.log("🔎 HISTORY SCAN: repository located, starting history iteration");
    let scanned = 0, indexed = 0, boundary = previousCheckpoint;
    let lastProgressAt = Date.now();
    console.log("🔎 HISTORY SCAN: iterMessages 开始，checkpoint=", previousCheckpoint);
    for await (const message of client.iterMessages(entity,{limit:undefined})) {
      const messageId=Number(message?.id||0);
      if (previousCheckpoint > 0 && messageId > 0 && messageId <= previousCheckpoint) break;
      scanned++;
      if (indexHistoryMessage(message,r.chatId)) indexed++;
      if (messageId > 0) boundary=messageId;

      if (scanned % 100 === 0 || Date.now() - lastProgressAt >= 15000) {
        lastProgressAt = Date.now();
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
let repositoryMigrationRunning=false;


let repositoryAutoSyncRunning = false;
let repositoryAutoSyncQueue = Promise.resolve();
function repositoryAutoSyncState() {
  const base={enabled:false,status:"idle",ownerId:"",sourceId:"",targetId:"",sourceTitle:"",targetTitle:"",lastMessageId:0,queue:[],copied:0,failed:0,lastError:"",updatedAt:0};
  const current=db.settings.repositoryAutoSync;
  const state=current&&typeof current==="object"?current:{};
  db.settings.repositoryAutoSync={...base,...state};
  if(!Array.isArray(db.settings.repositoryAutoSync.queue)) db.settings.repositoryAutoSync.queue=[];
  return db.settings.repositoryAutoSync;
}
function repositoryAutoSyncKey(chatId,messageId){return String(chatId)+":"+String(messageId);}
function repositoryAutoSyncFolderId(sourceItem,targetId){
  const sourceDir=db.directories.find(d=>String(d.id)===String(sourceItem?.directoryId||""));
  const folderName=String(sourceDir?.name||"").trim();
  if(!folderName)return null;
  const normalized=folderName.replace(/\s+/g," ").trim().toLowerCase();
  let targetDir=db.directories.find(d=>String(d.name||"").replace(/\s+/g," ").trim().toLowerCase()===normalized);
  if(!targetDir){targetDir={id:sharedDirectoryId(folderName),name:folderName,createdAt:Date.now(),sourceMigration:"auto:"+String(targetId)};db.directories.push(targetDir);queueBaserowDirectorySync(targetDir);}
  return String(targetDir.id);
}
async function repositoryAutoSyncOne(job){
  const state=repositoryAutoSyncState(),sourceId=String(state.sourceId||""),targetId=String(state.targetId||""),messageId=Number(job?.messageId||0);
  if(!state.enabled||!sourceId||!targetId||!messageId)return false;
  const already=db.resources.some(x=>String(x.chatId)===targetId&&Number(x.migratedFrom?.chatId||0)===Number(sourceId)&&Number(x.migratedFrom?.messageId||0)===messageId);
  if(already)return true;
  const sourceItem=db.resources.find(x=>String(x.chatId)===sourceId&&Number(x.messageId)===messageId);
  if(!sourceItem){state.lastError="找不到源消息索引："+repositoryAutoSyncKey(sourceId,messageId);state.failed=Number(state.failed||0)+1;saveDb();return false;}
  let copied=null,lastError=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{copied=await main("copyMessage",{chat_id:targetId,from_chat_id:sourceId,message_id:messageId,...(contentProtectionEnabled()?{protect_content:true}:{})});if(!copied?.message_id)throw new Error("Telegram 未返回目标消息ID");break;}
    catch(e){lastError=e;if(attempt<3)await sleep(1500*attempt);}
  }
  if(!copied?.message_id){state.lastError=String(lastError?.message||lastError||"复制失败");state.failed=Number(state.failed||0)+1;state.status="waiting_retry";saveDb();return false;}
  const directoryId=repositoryAutoSyncFolderId(sourceItem,targetId);
  const targetItem={...sourceItem,chatId:targetId,messageId:Number(copied.message_id),directoryId:directoryId||null,fileId:null,baserowRowId:null,migratedFrom:{chatId:sourceId,messageId,at:Date.now()}};
  if(!db.resources.some(x=>String(x.chatId)===targetId&&Number(x.messageId)===Number(copied.message_id))){db.resources.unshift(targetItem);db.resources=db.resources.slice(0,MAX_RESOURCES);queueBaserowResourceSync(targetItem);}
  state.copied=Number(state.copied||0)+1;state.lastError="";state.updatedAt=Date.now();state.lastMessageId=Math.max(Number(state.lastMessageId||0),messageId);saveDb();
  console.log("⚡ AUTO MIGRATION:",sourceId+"#"+messageId,"->",targetId+"#"+Number(copied.message_id));
  return true;
}
async function processRepositoryAutoSyncQueue(){
  if(repositoryAutoSyncRunning)return repositoryAutoSyncQueue;
  repositoryAutoSyncRunning=true;
  repositoryAutoSyncQueue=repositoryAutoSyncQueue.then(async()=>{
    const state=repositoryAutoSyncState();
    if(!state.enabled)return;
    while(state.queue.length){
      const ok=await repositoryAutoSyncOne(state.queue[0]);
      if(!ok)break;
      state.queue.shift();state.updatedAt=Date.now();saveDb();
    }
    state.status=state.queue.length?"waiting_retry":"running";state.updatedAt=Date.now();saveDb();
  }).catch(e=>{const state=repositoryAutoSyncState();state.lastError=String(e?.message||e);state.status="error";state.updatedAt=Date.now();saveDb();}).finally(()=>{repositoryAutoSyncRunning=false;});
  return repositoryAutoSyncQueue;
}
function queueRepositoryAutoSyncMessage(msg){
  if(!msg?.chat?.id||!msg?.message_id)return;
  const state=repositoryAutoSyncState();
  if(!state.enabled||String(msg.chat.id)!==String(state.sourceId))return;
  const messageId=Number(msg.message_id);if(!messageId)return;
  const exists=state.queue.some(x=>Number(x.messageId)===messageId);
  const already=db.resources.some(x=>String(x.chatId)===String(state.targetId)&&Number(x.migratedFrom?.chatId||0)===Number(state.sourceId)&&Number(x.migratedFrom?.messageId||0)===messageId);
  if(!exists&&!already)state.queue.push({messageId,queuedAt:Date.now()});
  state.lastMessageId=Math.max(Number(state.lastMessageId||0),messageId);state.status="queued";state.updatedAt=Date.now();saveDb();processRepositoryAutoSyncQueue().catch(()=>{});
}
async function enableRepositoryAutoSync(uid,sourceId,targetId,sourceTitle,targetTitle,lastMessageId=0){
  const state=repositoryAutoSyncState();state.enabled=true;state.status="running";state.ownerId=String(uid);state.sourceId=String(sourceId);state.targetId=String(targetId);state.sourceTitle=String(sourceTitle||sourceId);state.targetTitle=String(targetTitle||targetId);state.lastMessageId=Math.max(Number(state.lastMessageId||0),Number(lastMessageId||0));state.updatedAt=Date.now();saveDb();return state;
}
async function stopRepositoryAutoSync(){const state=repositoryAutoSyncState();state.enabled=false;state.status="stopped";state.updatedAt=Date.now();saveDb();return state;}
async function showRepositoryAutoSyncStatus(uid){
  const state=repositoryAutoSyncState();
  return sendHtml(TOKEN,uid,"<b>⚡ 自动同步</b>\n━━━━━━━━━━━━━━\n\n"+(state.enabled?"🟢 状态：运行中":"⏸️ 状态："+(state.status==="stopped"?"已停止":"未启用"))+"\n📤 旧仓库："+escapeHtml(state.sourceTitle||"-")+"\n📥 新仓库："+escapeHtml(state.targetTitle||"-")+"\n📌 最后消息："+Number(state.lastMessageId||0)+"\n📦 已自动同步："+Number(state.copied||0)+"\n⏳ 待处理："+state.queue.length+"\n⚠️ 失败次数："+Number(state.failed||0)+(state.lastError?"\n\n❌ "+escapeHtml(state.lastError):""),{reply_markup:{inline_keyboard:[[{text:"⏸️ 停止同步",callback_data:"adm:auto_stop"}],[{text:"▶️ 继续同步",callback_data:"adm:auto_resume"}],[{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]]}});
}
async function repositoryMigration(uid, sourceValue, targetValue) {
  const sourceRaw=String(sourceValue||"").trim(), targetRaw=String(targetValue||"").trim();
  if(!sourceRaw || !targetRaw) throw new Error("旧仓库和新仓库都不能为空");
  if(sourceRaw===targetRaw) throw new Error("旧仓库和新仓库不能是同一个");
  if(repositoryMigrationRunning) throw new Error("已有一个仓库迁移任务正在运行，请等待当前任务完成。");

  let sc,tc;
  try{sc=await main("getChat",{chat_id:sourceRaw});}
  catch(e){throw new Error("旧仓库无法访问："+String(e?.telegramDescription||e?.message||e));}
  try{tc=await main("getChat",{chat_id:targetRaw});}
  catch(e){throw new Error("新仓库无法访问："+String(e?.telegramDescription||e?.message||e));}

  const sourceId=String(sc.id),targetId=String(tc.id);
  if(sourceId===targetId) throw new Error("旧仓库和新仓库不能是同一个");
  const sourceTitle=String(sc.title||sc.username||sourceId),targetTitle=String(tc.title||tc.username||targetId);
  const taskKey=sourceId+"->"+targetId;
  const previous=db.settings.repositoryMigration||{};
  const sameTask=String(previous.taskKey||"")===taskKey;
  const resumableStatuses=new Set(["running","completed_with_errors","completed"]);
  const canResume=sameTask && resumableStatuses.has(String(previous.status||""));
  const startedAt=canResume && Number(previous.startedAt)>0 ? Number(previous.startedAt) : Date.now();

  const state=canResume?previous:{
    status:"running",taskKey,ownerId:String(uid),source:sourceId,target:targetId,sourceId,targetId,
    sourceTitle,targetTitle,scanned:0,queued:0,migrated:0,skipped:0,failed:0,current:0,total:0,
    startedAt,finishedAt:null,error:"",lastError:"",folderMap:{},completedKeys:[],failedKeys:[],progressMessageId:null,autoSync:Boolean(previous.autoSync)
  };

  state.status="running";
  state.taskKey=taskKey;
  state.ownerId=String(state.ownerId||uid);
  state.source=sourceId;state.target=targetId;state.sourceId=sourceId;state.targetId=targetId;
  state.sourceTitle=sourceTitle;state.targetTitle=targetTitle;
  state.startedAt=Number(state.startedAt)>0?Number(state.startedAt):startedAt;
  state.finishedAt=null;state.error="";
  state.completedKeys=Array.isArray(state.completedKeys)?state.completedKeys:[];
  state.failedKeys=Array.isArray(state.failedKeys)?state.failedKeys:[];
  state.folderMap=state.folderMap&&typeof state.folderMap==="object"?state.folderMap:{};
  db.settings.repositoryMigration=state;saveDb();
  repositoryMigrationRunning=true;

  try {
    let items=db.resources.filter(x=>String(x.chatId)===sourceId&&Number(x.messageId)>0);
    if(!items.length){
      await sendHtml(TOKEN,uid,"🔎 <b>正在建立旧仓库索引</b>\n\n📤 旧仓库："+escapeHtml(sourceTitle)+"\n🔐 将使用历史扫描账号读取旧仓库消息。\n\n请稍候…");
      await scanHistory(uid,{chatId:sourceId,title:sourceTitle,username:sc.username||"",type:sc.type||""});
      items=db.resources.filter(x=>String(x.chatId)===sourceId&&Number(x.messageId)>0);
    }
    if(!items.length) throw new Error("旧仓库没有找到可迁移的资源");

    const ordered=[...items].sort((a,b)=>Number(a.messageId)-Number(b.messageId));
    const completed=new Set(state.completedKeys.map(String));
    const failedKeys=new Set(state.failedKeys.map(String));

    state.scanned=ordered.length;
    state.total=ordered.length;
    console.log("🔄 MIGRATION CHECKPOINT:", {taskKey, completed:completed.size, failed:failedKeys.size, total:ordered.length, current:Number(state.current||0)});
    state.queued=ordered.filter(x=>!completed.has(resourceKey(x))).length;
    state.migrated=Math.max(0,Number(state.migrated)||0);
    state.skipped=Math.max(0,Number(state.skipped)||0);
    state.failed=failedKeys.size;
    state.current=Math.min(Number(state.current)||0, ordered.length);
    saveDb();

    const ensureTargetDirectory=(sourceItem)=>{
      const sourceDir=db.directories.find(d=>String(d.id)===String(sourceItem?.directoryId||""));
      const folderName=String(sourceDir?.name||"").trim();
      if(!folderName)return null;
      const normalized=folderName.replace(/\s+/g," ").trim().toLowerCase();
      if(state.folderMap[normalized])return state.folderMap[normalized];

      let targetDir=db.directories.find(d=>String(d.name||"").replace(/\s+/g," ").trim().toLowerCase()===normalized);
      if(!targetDir){
        targetDir={id:sharedDirectoryId(folderName),name:folderName,createdAt:Date.now(),sourceMigration:taskKey};
        db.directories.push(targetDir);
        queueBaserowDirectorySync(targetDir);
      }
      state.folderMap[normalized]=String(targetDir.id);
      return String(targetDir.id);
    };

    const renderProgress=(phase)=>{
      const done=Math.min(Number(state.total||ordered.length),Number(state.migrated||0)+Number(state.skipped||0));
      const total=Number(state.total||ordered.length);
      const percent=total?Math.min(100,Math.floor(done/total*100)):100;
      const filled=Math.round(percent/10);
      const bar="▰".repeat(filled)+"▱".repeat(Math.max(0,10-filled));
      const elapsed=Math.max(0,Math.floor((Date.now()-Number(state.startedAt||startedAt))/1000));
      const mm=String(Math.floor(elapsed/60)).padStart(2,"0"),ss=String(elapsed%60).padStart(2,"0");
      return "<b>🔄 正在迁移仓库</b>\n━━━━━━━━━━━━━━\n📤 旧仓库：<b>"+escapeHtml(sourceTitle)+"</b>\n📥 新仓库：<b>"+escapeHtml(targetTitle)+"</b>\n\n📚 总资源："+total.toLocaleString()+"\n📊 进度："+bar+" <b>"+percent+"%</b>\n✅ 已迁移："+Number(state.migrated||0).toLocaleString()+"\n⏭️ 已跳过："+Number(state.skipped||0).toLocaleString()+"\n⚠️ 失败："+Number(state.failed||0).toLocaleString()+"\n📁 文件夹："+Object.keys(state.folderMap||{}).length.toLocaleString()+"\n⏱️ 用时："+mm+":"+ss+"\n\n"+(phase==="retry"?"🔁 正在重试失败项…":"⏳ 正在处理资源…");
    };

    const progress=await sendHtml(TOKEN,uid,renderProgress(canResume?"resume":"processing"),{reply_markup:{inline_keyboard:[[{text:"⏳ 后台运行",callback_data:"admin:root"}]]}});
    state.progressMessageId=Number(progress?.message_id||0)||null;
    saveDb();

    const targetExistingMigrationKeys=new Set(
      db.resources
        .filter(x=>String(x.chatId)===targetId&&x.migratedFrom)
        .map(x=>resourceKey(x.migratedFrom))
        .filter(Boolean)
    );

    const copyOneBatch=async batch=>{
      const ids=batch.map(x=>Number(x.messageId)).filter(x=>x>0).sort((a,b)=>a-b);
      if(!ids.length) return [];
      let last;
      for(let attempt=1;attempt<=3;attempt++){
        try{
          const copied=await main("copyMessages",{chat_id:targetId,from_chat_id:sourceId,message_ids:ids,...(contentProtectionEnabled()?{protect_content:true}:{})});
          if(!Array.isArray(copied)) throw new Error("Telegram 返回结果异常");
          if(copied.length!==batch.length) throw new Error("批量复制结果数量不完整："+copied.length+"/"+batch.length);
          return copied;
        }catch(e){
          last=e;
          console.warn("MIGRATION BATCH RETRY",attempt,"size=",batch.length,e?.message||e);
          if(attempt<3) await sleep(2500*attempt);
        }
      }
      throw last||new Error("复制批次失败");
    };

    const copyOneSingle=async item=>{
      let last;
      for(let attempt=1;attempt<=3;attempt++){
        try{
          const copied=await main("copyMessage",{chat_id:targetId,from_chat_id:sourceId,message_id:Number(item.messageId),...(contentProtectionEnabled()?{protect_content:true}:{})});
          if(!copied?.message_id) throw new Error("单条复制没有返回 message_id");
          return copied;
        }catch(e){
          last=e;
          console.warn("MIGRATION SINGLE RETRY",attempt,"resource=",resourceKey(item),e?.message||e);
          if(attempt<3) await sleep(2000*attempt);
        }
      }
      throw last||new Error("单条复制失败");
    };

    const applyCopied=async(batch,copied)=>{
      if(!Array.isArray(copied)||copied.length!==batch.length) return 0;
      let ok=0;
      for(let j=0;j<batch.length;j++){
        const item=batch[j],messageId=Number(copied[j]?.message_id||copied[j]||0);
        if(!messageId) continue;
        const key=resourceKey(item);
        const directoryId=ensureTargetDirectory(item);
        const targetItem={...item,chatId:targetId,messageId,directoryId:directoryId||null,fileId:null,baserowRowId:null,migratedFrom:{chatId:sourceId,messageId:Number(item.messageId),at:Date.now()}};
        if(!db.resources.some(x=>String(x.chatId)===targetId&&Number(x.messageId)===messageId)){
          db.resources.unshift(targetItem);
          queueBaserowResourceSync(targetItem);
        }
        completed.add(key);
        failedKeys.delete(key);
        if(ok % 5 === 0) { state.completedKeys=[...completed].slice(-Math.max(MAX_RESOURCES,25000)); state.failedKeys=[...failedKeys].slice(-Math.max(MAX_RESOURCES,25000)); saveDb(); }
        state.migrated++;
        ok++;
      }
      return ok;
    };
    const applySingle=async item=>{
      const key=resourceKey(item);
      const copied=await copyOneSingle(item);
      const ok=await applyCopied([item],[copied]);
      if(!ok) throw new Error("单条复制结果无效");
    };

    const processBatch=async batch=>{
      const pending=batch.filter(x=>!completed.has(resourceKey(x)));
      if(!pending.length){
        state.skipped+=batch.length;
        return;
      }

      const needCopy=[];
      for(const item of pending){
        const key=resourceKey(item);
        if(targetExistingMigrationKeys.has(key)){
          completed.add(key);
          failedKeys.delete(key);
          state.skipped++;
        }else{
          needCopy.push(item);
        }
      }
      if(!needCopy.length) return;

      try{
        const copied=await copyOneBatch(needCopy);
        const ok=await applyCopied(needCopy,copied);
        if(ok!==needCopy.length) throw new Error("批量复制结果未能完整写入索引");
      }catch(e){
        console.error("MIGRATION BATCH FAILED:",e?.message||e);
        for(const item of needCopy){
          const key=resourceKey(item);
          if(completed.has(key)) continue;
          try{
            await applySingle(item);
          }catch(err){
            failedKeys.add(key);
            console.error("MIGRATION ITEM FAILED:",key,err?.message||err);
          }
        }
      }
    };

    let lastUi=0;
    for(let i=0;i<ordered.length;i+=10){
      const batch=ordered.slice(i,i+10);
      state.current=Math.min(i+batch.length,ordered.length);
      state.queued=Math.max(0,ordered.length-completed.size);
      state.completedKeys=[...completed].slice(-Math.max(MAX_RESOURCES,25000));
      state.failedKeys=[...failedKeys].slice(-Math.max(MAX_RESOURCES,25000));
      saveDb();
      await processBatch(batch);
      state.failed=failedKeys.size;
      state.current=Math.min(i+batch.length,ordered.length);
      state.completedKeys=[...completed].slice(-Math.max(MAX_RESOURCES,25000));
      state.failedKeys=[...failedKeys].slice(-Math.max(MAX_RESOURCES,25000));
      state.queued=Math.max(0,ordered.length-completed.size);
      state.lastError=state.failed?"仍有 "+state.failed+" 条资源待重试":"";
      saveDb();

      if(i===0||i+10>=ordered.length||Date.now()-lastUi>=10000){
        lastUi=Date.now();
        await safeEdit(TOKEN,{chat_id:uid,message_id:progress.message_id,text:renderProgress("processing"),parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:state.failed?"🔁 正在处理失败项":"⏳ 迁移进行中",callback_data:"admin:root"}]]}}).catch(()=>{});
      }
    }

    for(let round=1;round<=2&&failedKeys.size;round++){
      state.failed=failedKeys.size;
      await safeEdit(TOKEN,{chat_id:uid,message_id:progress.message_id,text:renderProgress("retry"),parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{});
      const retryItems=ordered.filter(x=>failedKeys.has(resourceKey(x)));
      const beforeSize=failedKeys.size;
      for(const item of retryItems){
        const key=resourceKey(item);
        try{
          await applySingle(item);
          failedKeys.delete(key);
        }catch(e){
          console.warn("MIGRATION FINAL RETRY",key,e?.message||e);
        }
        state.failed=failedKeys.size;
        state.completedKeys=[...completed].slice(-Math.max(MAX_RESOURCES,25000));
        state.failedKeys=[...failedKeys].slice(-Math.max(MAX_RESOURCES,25000));
        state.queued=Math.max(0,ordered.length-completed.size);
        saveDb();
      }
      if(failedKeys.size===beforeSize) break;
    }

    state.failed=failedKeys.size;
    state.status=state.failed?"completed_with_errors":"completed";
    if(state.autoSync) await enableRepositoryAutoSync(uid,sourceId,targetId,sourceTitle,targetTitle,ordered.length?Math.max(...ordered.map(x=>Number(x.messageId)||0)):0);
    state.finishedAt=Date.now();
    state.error=state.failed?"部分资源无法复制，请再次执行同一组旧/新仓库迁移以继续失败项。":"";
    state.lastError=state.error;
    state.completedKeys=[...completed].slice(-Math.max(MAX_RESOURCES,25000));
    state.failedKeys=[...failedKeys].slice(-Math.max(MAX_RESOURCES,25000));
    state.queued=Math.max(0,ordered.length-completed.size);
    saveDb();
    await waitBaserowSyncQueue();

    const elapsed=Math.max(0,Math.floor((state.finishedAt-state.startedAt)/1000));
    const mm=String(Math.floor(elapsed/60)).padStart(2,"0"),ss=String(elapsed%60).padStart(2,"0");
    const doneText="<b>"+(state.failed?"⚠️ 仓库迁移完成（有待处理项）":"✅ 仓库迁移完成")+"</b>\n━━━━━━━━━━━━━━\n📤 旧仓库："+escapeHtml(sourceTitle)+"\n📥 新仓库："+escapeHtml(targetTitle)+"\n\n📚 总资源："+ordered.length.toLocaleString()+"\n📊 完成度："+Math.min(100,Math.floor((Math.min(ordered.length,completed.size)/Math.max(1,ordered.length))*100))+"%\n✅ 已迁移："+Number(state.migrated||0).toLocaleString()+"\n⏭️ 已跳过："+Number(state.skipped||0).toLocaleString()+"\n⚠️ 失败："+Number(state.failed||0).toLocaleString()+"\n📁 文件夹："+Object.keys(state.folderMap||{}).length.toLocaleString()+"\n⏱️ 总耗时："+mm+":"+ss+"\n\n"+(state.failed?"🔁 再次执行相同的迁移任务即可继续失败项，不会重复已完成资源。":"🎉 所有可迁移资源已处理完成。")+"\n\n📌 旧仓库不会删除\n📁 同名文件夹自动对应，不存在时自动创建";
    return safeEdit(TOKEN,{chat_id:uid,message_id:progress.message_id,text:doneText,parse_mode:"HTML",reply_markup:adminMenu().reply_markup});
  } finally {
    repositoryMigrationRunning=false;
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
 [{text:"🗃️ 备份恢复",callback_data:"admin:backup"}],
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
 [{text:"🔍 仓库扫描",callback_data:"adm:scan"},{text:"🧩 恢复历史资源",callback_data:"adm:recover"}],
 [{text:"🛠️ 恢复文件夹资源",callback_data:"adm:folder_repair"}],
 [{text:"🔄 迁移仓库",callback_data:"adm:migrate"},{text:"⚡ 自动同步",callback_data:"adm:auto"}],
 [{text:"🧹 资源维护",callback_data:"admin:maintenance"}],
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

function userHomeInlineKeyboard() {
  return {reply_markup:{inline_keyboard:[
    [{text:"📂 资源目录",callback_data:"user:dirs"},{text:"🔎 搜索资源",callback_data:"user:search"}],
    [{text:"🎲 随机获取",callback_data:"user:random"},{text:"🆕 最新资源",callback_data:"user:latest"}],
    [{text:"⭐ 我的资源",callback_data:"hub"},{text:"🤖 克隆机器人",callback_data:"user:clone"}]
  ]}};
}
function userMenu() {
  return userHomeInlineKeyboard();
}
function childMenu() {
  return userHomeInlineKeyboard();
}

const replyKeyboardClearedChats = new Set();
async function ensureUserInlineMode(token, chatId) {
  const key = tokenFingerprint(token) + ":" + String(chatId);
  if (replyKeyboardClearedChats.has(key)) return;
  try {
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: "\u2063",
      reply_markup: {remove_keyboard:true}
    });
    replyKeyboardClearedChats.add(key);
  } catch (e) {
    console.warn("⚠️ 清理旧键盘失败:", String(e?.message || e));
  }
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
function uploadFolderInlineMenu(page=0) {
  const all=db.directories;
  const pageSize=10;
  const currentPage=Math.max(0,Number(page)||0);
  const start=currentPage*pageSize;
  const current=all.slice(start,start+pageSize);
  const rows=[];
  let row=[];
  for(const d of current) {
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
  if(!rows.length) rows.push([{text:"📭 暂无文件夹",callback_data:"noop"}]);

  const nav=[];
  if(start>0) nav.push({text:"⬅️ 上一页",callback_data:"uploadsp:"+(currentPage-1)});
  if(start+pageSize<all.length) nav.push({text:"下一页 ➡️",callback_data:"uploadsp:"+(currentPage+1)});
  if(nav.length) rows.push(nav);

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
function ensureDirectory(name) {
  const clean=String(name||"").trim().slice(0,80);
  if(!clean)return null;
  let d=getDirectoryByName(clean);
  if(d)return d;
  d={id:sharedDirectoryId(clean),name:clean,createdAt:Date.now()};
  db.directories.push(d);
  touchSharedData("system");
  saveDb();
  queueBaserowDirectorySync(d);
  return d;
}
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
function folderManageMenu(directoryId) {
  const d=db.directories.find(x=>String(x.id)===String(directoryId));
  if(!d) return {inline_keyboard:[[{text:"⬅️ 返回文件夹",callback_data:"upload_folder_back"}]]};
  const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
  return {inline_keyboard:[
    [{text:"📤 继续上传",callback_data:"folder_manage_upload:"+d.id}],
    [{text:"📂 查看资源",callback_data:"folder_manage_view:"+d.id}],
    [{text:"✏️ 修改名称",callback_data:"folder_manage_rename:"+d.id},{text:"🔄 移动资源",callback_data:"folder_manage_move:"+d.id}],
    [{text:"🗑️ 删除文件夹",callback_data:"folder_manage_delete:"+d.id}],
    [{text:"⬅️ 返回文件夹列表",callback_data:"admin:upload"}]
  ]};
}
function folderManageText(directoryId) {
  const d=db.directories.find(x=>String(x.id)===String(directoryId));
  if(!d) return "<b>⚠️ 文件夹不存在</b>";
  const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
  return "<b>📁 "+escapeHtml(d.name)+"</b>\\n━━━━━━━━━━━━━━\\n\\n📦 资源数量：<b>"+count+"</b>\\n\\n👇 请选择操作";
}
function folderMoveTargetMenu(sourceId) {
  const rows=[];
  for(const d of db.directories) {
    if(String(d.id)===String(sourceId)) continue;
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    rows.push([{text:"📁 "+String(d.name||"未命名").slice(0,24)+" · "+count,callback_data:"folder_move_to:"+d.id}]);
  }
  if(!rows.length) rows.push([{text:"📭 没有其他文件夹",callback_data:"noop"}]);
  rows.push([{text:"❌ 取消",callback_data:"folder_manage_back:"+sourceId}]);
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
    [{text:"🔗 打开分享链接",url:token}],    [{text:"🏠 返回首页",callback_data:"batch:home"}]
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
    let copiedIds = null;
    let usedFallback = false;

    try {
      // 优先批量转存，速度最快。
      copiedIds=await tg(TOKEN,"copyMessages",{
        chat_id:r.chatId,
        from_chat_id:uid,
        message_ids:ids
      });
      if(!Array.isArray(copiedIds) || copiedIds.length!==batch.length) {
        throw new Error("批量转存结果数量不一致");
      }
    } catch(e) {
      // 某些消息类型/Telegram 环境下 copyMessages 可能失败。
      // 不让整批直接判定失败，逐条 copyMessage 兜底；这样即使只有一条异常，
      // 其他资源仍然可以正常进入仓库。
      usedFallback = true;
      console.warn(
        "⚠️ UPLOAD BATCH FINALIZE 批量转存失败，启动逐条兜底：",
        e?.message || e,
        "count=",batch.length
      );
    }

    if(!usedFallback) {
      for(let n=0;n<batch.length;n++) {
        try {
          const copiedId=Number(copiedIds[n]?.message_id ?? copiedIds[n]);
          if(!Number.isFinite(copiedId)) throw new Error("批量转存消息ID无效");

          const resourceMsg={
            ...batch[n].msg,
            chat:{
              ...(batch[n].msg?.chat||{}),
              id:r.chatId,
              title:r.title||batch[n].msg?.chat?.title||r.chatId,
              username:r.username||batch[n].msg?.chat?.username||"",
              type:r.type||"supergroup"
            },
            message_id:copiedId
          };
          indexResource(resourceMsg);

          const item=db.resources.find(x=>String(x.chatId)===String(r.chatId)&&Number(x.messageId)===copiedId);
          if(!item) throw new Error("资源索引写入失败");

          item.directoryId=d.id;
          item.repositoryMessageId=copiedId;
          item.sourceUserId=String(uid);
          item.indexedAt=Date.now();
          queueBaserowResourceSync(item);
          stored++;
        } catch(e) {
          failed++;
          console.error("❌ UPLOAD RESOURCE INDEX:",e?.message||e,"sourceMessage=",batch[n]?.messageId);
        }
      }
    } else {
      // 逐条兜底：copyMessage 不依赖 copyMessages 的批量返回结构。
      for(const entry of batch) {
        try {
          const copied=await tg(TOKEN,"copyMessage",{
            chat_id:r.chatId,
            from_chat_id:uid,
            message_id:Number(entry.messageId),
            // 仓库中的原始副本不受用户侧“内容保护”设置影响；
            // 用户获取资源时仍由 sendIndexedResource 决定 protect_content。
            protect_content:false
          });
          const copiedId=Number(copied?.message_id);
          if(!Number.isFinite(copiedId)) throw new Error("逐条转存消息ID无效");

          const resourceMsg={
            ...entry.msg,
            chat:{
              ...(entry.msg?.chat||{}),
              id:r.chatId,
              title:r.title||entry.msg?.chat?.title||r.chatId,
              username:r.username||entry.msg?.chat?.username||"",
              type:r.type||"supergroup"
            },
            message_id:copiedId
          };
          indexResource(resourceMsg);

          const item=db.resources.find(x=>String(x.chatId)===String(r.chatId)&&Number(x.messageId)===copiedId);
          if(!item) throw new Error("资源索引写入失败");

          item.directoryId=d.id;
          item.repositoryMessageId=copiedId;
          item.sourceUserId=String(uid);
          item.indexedAt=Date.now();
          queueBaserowResourceSync(item);
          stored++;
        } catch(e) {
          failed++;
          console.error(
            "❌ UPLOAD RESOURCE FALLBACK:",
            e?.message||e,
            "sourceMessage=",entry.messageId
          );
        }
      }
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
  const pageSize=10;
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

function resourceSourceChats() {
  const set = new Set();
  const r = repo();
  if (r?.chatId) set.add(String(r.chatId));
  const list = Array.isArray(db.settings.resourceSources) ? db.settings.resourceSources : [];
  for (const x of list) {
    const id = typeof x === "object" ? x.chatId : x;
    if (id !== undefined && id !== null && String(id).trim()) set.add(String(id).trim());
  }
  return set;
}

function indexResource(msg) {
  if (!msg?.chat?.id || !["group","supergroup","channel"].includes(String(msg.chat.type))) return;
  if (!Array.isArray(db.settings.resourceSources)) db.settings.resourceSources = [];
  if (!db.settings.resourceSources.some(x => String(x?.chatId ?? x) === String(msg.chat.id))) {
    db.settings.resourceSources.push({chatId:String(msg.chat.id),title:String(msg.chat.title || msg.chat.username || msg.chat.id),username:String(msg.chat.username || ""),type:String(msg.chat.type || "")});
    db.settings.resourceSources = db.settings.resourceSources.slice(-100);
  }
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
    const total=valid.length;    if(ok===0) {
      const isChatNotFound=/chat not found/i.test(lastError);
      const isKicked=/bot was kicked|bot is not a member|kicked from the channel|Forbidden/i.test(lastError);
      return send(token,chatId,
        "❌ <b>资源暂时无法发送</b>\\n\\n"+
        "📦 找到资源："+total+" 条\\n"+
        "📤 成功发送：0 条\\n"+
        "⚠️ 发送失败："+fail+" 条\\n\\n"+
        (isKicked
          ? "🔧 <b>机器人已失去资源仓库权限</b>\\n\\n请把当前机器人重新加入资源仓库。\\n如果资源仓库是频道，请将机器人重新添加为频道管理员后再试。\\n\\n⚠️ Baserow 里仍然可以保存资源记录，但 Telegram 发送资源时，机器人必须还能访问原始消息。"
          : isChatNotFound
            ? "🔧 <b>需要管理员处理</b>\\n\\n请把当前机器人加入「资源仓库」。如果仓库是频道，请将机器人加入并确认有读取消息权限。\\n\\n历史扫描账号能看到资源，只代表扫描账号能读取历史消息；用户获取资源时，机器人本身也必须能够访问仓库消息。"
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

  // 上传会话优先于“转发消息绑定仓库”。
  // 上传期间管理员转发/发送的文件属于待上传资源，绝不能被当成绑定仓库消息。
  if(msg.chat?.type==="private") {
    const uploadState=states.get("m:"+String(msg.from?.id||""));
    if(uploadState?.step==="upload_folder" || uploadState?.step==="upload_file") return false;
  }

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

  return false;
}

async function backupRecoveryPreview(uid) {
  const backup = readJsonFile(BACKUP_FILE);
  if (!backup || typeof backup !== "object") {
    return sendHtml(TOKEN,uid,
      "<b>🗃️ 备份恢复</b>\n━━━━━━━━━━━━━━\n\n❌ 没有找到可读取的备份文件。\n\n📁 文件："+escapeHtml(BACKUP_FILE),
      adminMenu());
  }
  const currentResources = Array.isArray(db.resources) ? db.resources : [];
  const currentDirs = Array.isArray(db.directories) ? db.directories : [];
  const backupResources = Array.isArray(backup.resources) ? backup.resources : [];
  const backupDirs = Array.isArray(backup.directories) ? backup.directories : [];
  const currentKeys = new Set(currentResources.map(x=>String(x.chatId||"")+":"+String(x.messageId||"")));
  const missingResources = backupResources.filter(x=>{
    const k=String(x.chatId||"")+":"+String(x.messageId||"");
    return k !== ":" && !currentKeys.has(k);
  });
  const currentDirNames = new Set(currentDirs.map(x=>String(x.name||"").trim().replace(/\s+/g," ").toLowerCase()).filter(Boolean));
  const missingDirs = backupDirs.filter(x=>{
    const n=String(x.name||"").trim().replace(/\s+/g," ").toLowerCase();
    return n && !currentDirNames.has(n);
  });
  const backupSavedAt = Number(backup?.settings?.lastSavedAt || backup?.savedAt || 0);
  return sendHtml(TOKEN,uid,
    "<b>🗃️ 备份恢复</b>\n━━━━━━━━━━━━━━\n\n"+
    "💾 备份文件：<b>已找到</b>\n"+
    (backupSavedAt ? "🕐 备份时间："+escapeHtml(new Date(backupSavedAt).toLocaleString("zh-CN"))+"\n" : "")+
    "📚 当前资源："+currentResources.length+"\n"+
    "📚 备份资源："+backupResources.length+"\n"+
    "➕ 可恢复资源："+missingResources.length+"\n"+
    "📁 当前目录："+currentDirs.length+"\n"+
    "📁 备份目录："+backupDirs.length+"\n"+
    "➕ 可恢复目录："+missingDirs.length+"\n\n"+
    "⚠️ <b>安全模式</b>：只合并当前缺少的数据，不删除当前资源、不覆盖当前仓库绑定。",
    {reply_markup:{inline_keyboard:[
      [{text:"♻️ 合并恢复备份",callback_data:"admin:backup_restore"}],
      [{text:"🔄 重新检查",callback_data:"admin:backup"}],
      [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
    ]}});
}

async function backupRecoveryMerge(uid) {
  const backup = readJsonFile(BACKUP_FILE);
  if (!backup || typeof backup !== "object") return backupRecoveryPreview(uid);
  const backupDirs = Array.isArray(backup.directories) ? backup.directories : [];
  const backupResources = Array.isArray(backup.resources) ? backup.resources : [];
  const currentDirByName = new Map((db.directories||[]).map(d=>[String(d.name||"").trim().replace(/\s+/g," ").toLowerCase(),d]));
  const dirMap = new Map();
  let restoredDirs=0, restoredResources=0;
  for (const bd of backupDirs) {
    const name=String(bd?.name||"").trim();
    if(!name) continue;
    const norm=name.replace(/\s+/g," ").toLowerCase();
    let d=currentDirByName.get(norm);
    if(!d) {
      d={...bd,id:bd.id||sharedDirectoryId(name),name,createdAt:bd.createdAt||Date.now(),restoredFromBackup:true};
      db.directories.push(d);
      currentDirByName.set(norm,d);
      restoredDirs++;
    }
    if(bd?.id) dirMap.set(String(bd.id),String(d.id));
  }
  const currentKeys = new Set((db.resources||[]).map(x=>String(x.chatId||"")+":"+String(x.messageId||"")));
  for (const br of backupResources) {
    const k=String(br?.chatId||"")+":"+String(br?.messageId||"");
    if(k===":" || currentKeys.has(k)) continue;
    const item={...br};
    if(br?.directoryId && dirMap.has(String(br.directoryId))) item.directoryId=dirMap.get(String(br.directoryId));
    db.resources.push(item);
    currentKeys.add(k);
    restoredResources++;
  }
  touchSharedData(uid);
  saveDb();
  try { await refreshSharedData(true); } catch {}
  logAdmin(uid,"合并恢复备份","恢复目录 "+restoredDirs+" 个，资源 "+restoredResources+" 个");
  return sendHtml(TOKEN,uid,
    "<b>✅ 备份合并恢复完成</b>\n━━━━━━━━━━━━━━\n\n"+
    "📁 恢复目录：<b>"+restoredDirs+"</b> 个\n"+
    "📦 恢复资源：<b>"+restoredResources+"</b> 个\n\n"+
    "🛡️ 当前已有资源未覆盖\n🛡️ 当前仓库绑定未修改\n\n<i>如果上午的资源就在备份中，现在即可重新出现在目录。</i>",
    adminMenu());
}

async function mainMessage(msg) {
  // 共享数据刷新放到后台，绝不能阻塞 Telegram 菜单响应；后台每 5 秒也会自动同步。
  refreshSharedData(false).catch(e=>console.warn("⚠️ 主机器人共享数据刷新失败:",String(e?.message||e)));
  // Telegram 消息处理不能等待 Baserow；共享数据在后台同步。
  if(await binding(msg)) return;
  if(msg.chat?.type!=="private") { indexResource(msg); queueRepositoryAutoSyncMessage(msg); return; }

  const uid=msg.from.id;
  if(!db.users.includes(uid)) { db.users.push(uid); saveDb(); }
  recordUserActivity(uid);
  const t=msg.text||"";
  const admin=isAdmin(uid);
  if (!admin) await ensureUserInlineMode(TOKEN, uid);
  const key="m:"+uid;
  const s=states.get(key);

  if(admin && s?.step==="bind_repository") {
    if(t==="/cancel") {
      states.delete(key);
      return sendHtml(TOKEN,uid,"↩️ <b>已取消绑定资源仓库</b>\n\n当前仓库："+(repo()?.title ? "✅ "+escapeHtml(repo().title) : "❌ 未绑定"),adminMenu());
    }
    // 只有明确进入“绑定仓库”状态后，才允许用 Chat ID/@用户名/转发消息完成绑定。
    // 普通转发消息绝不能自动触发绑定。
    let target=String(t||"").trim();
    if(!target && msg.forward_origin?.chat) target=String(msg.forward_origin.chat.id||"").trim();
    if(!target) return send(TOKEN,uid,"⚠️ 请发送 Chat ID、@用户名，或在点击「📦 绑定资源仓库」后转发仓库消息。");
    try {
      const chat=await main("getChat",{chat_id:target});
      const me=await main("getMe");
      let membership=null;
      try { membership=await main("getChatMember",{chat_id:chat.id,user_id:me.id}); } catch {}
      if(membership && ["left","kicked"].includes(String(membership.status||""))) {
        return sendHtml(TOKEN,uid,"<b>❌ 绑定失败</b>\n\n机器人不在这个仓库中。\n请先把主机器人加入仓库，再重新发送。");
      }
      db.settings.repository={chatId:String(chat.id),title:String(chat.title||chat.username||chat.id),username:String(chat.username||""),type:String(chat.type||"")};
      saveDb(); states.delete(key);
      try { await refreshSharedData(true); } catch {}
      return sendHtml(TOKEN,uid,
        "<b>✅ 资源仓库绑定成功</b>\n\n"+
        "📦 仓库：<b>"+escapeHtml(chat.title||chat.username||String(chat.id))+"</b>\n"+
        "🆔 Chat ID：<code>"+escapeHtml(String(chat.id))+"</code>\n"+
        "🔗 类型："+escapeHtml(String(chat.type||""))+"\n\n"+
        "📌 现在可以使用「仓库扫描 / 历史恢复」。",
        adminMenu());
    } catch(e) {
      return sendHtml(TOKEN,uid,
        "<b>❌ 仓库绑定失败</b>\n\n⚠️ "+escapeHtml(e?.telegramDescription||e?.message||e)+"\n\n请检查 Chat ID/@用户名是否正确，以及机器人是否已经加入仓库。");
    }
  }

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
  if (admin && s?.step === "scan_target") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消历史扫描。",adminMenu()); }
    const target=String(t||"").trim();
    if(!target) return send(TOKEN,uid,"⚠️ 请输入仓库 Chat ID 或 @用户名。");
    states.delete(key);
    try {
      const chat=await main("getChat",{chat_id:target});
      return await scanHistory(uid,{chatId:String(chat.id),title:String(chat.title||chat.username||chat.id),username:String(chat.username||""),type:String(chat.type||"")});
    } catch(e) {
      return sendHtml(TOKEN,uid,"<b>❌ 历史扫描失败</b>\n\n⚠️ "+escapeHtml(e?.telegramDescription||e?.message||e)+"\n\n请确认机器人/扫描账号可以访问这个仓库。",adminMenu());
    }
  }

  if (admin && s?.step === "auto_migration_source") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消自动同步设置。",adminMenu()); }
    const source=String(t||"").trim();
    if(!source) return send(TOKEN,uid,"⚠️ 请输入旧仓库 Chat ID 或 @用户名。");
    states.set(key,{step:"auto_migration_target",source});
    return sendHtml(TOKEN,uid,"<b>📥 现在发送新仓库</b>\n\n请输入新仓库 Chat ID 或 @用户名。\n\n机器人必须同时在两个仓库里。发送 /cancel 可取消。");
  }
  if (admin && s?.step === "auto_migration_target") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消自动同步设置。",adminMenu()); }
    const target=String(t||"").trim(), source=String(s?.source||"").trim();
    if(!target) return send(TOKEN,uid,"⚠️ 请输入新仓库 ID 或 @用户名。");
    states.delete(key);
    try {
      const sc=await main("getChat",{chat_id:source}),tc=await main("getChat",{chat_id:target});
      const previous=db.settings.repositoryMigration||{};
      db.settings.repositoryMigration={...previous,autoSync:true};
      saveDb();
      return await repositoryMigration(uid,String(sc.id),String(tc.id));
    } catch(e) {
      const m=db.settings.repositoryMigration||{};
      db.settings.repositoryMigration={...m,autoSync:false,status:"error",finishedAt:Date.now(),error:String(e?.message||e)};
      saveDb();
      return sendHtml(TOKEN,uid,"<b>❌ 自动同步启动失败</b>\n\n⚠️ "+escapeHtml(e?.message||e)+"\n\n请确认机器人同时在旧仓库和新仓库里。",adminMenu());
    }
  }

  if (admin && s?.step === "migration_source") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消仓库迁移。",adminMenu()); }
    const source=String(t||"").trim();
    if(!source) return send(TOKEN,uid,"⚠️ 请输入旧仓库 Chat ID 或 @用户名。");
    states.set(key,{step:"migration_target",source});
    return sendHtml(TOKEN,uid,"<b>📥 现在发送新仓库</b>\\n\\n请输入新仓库 Chat ID 或 @用户名。\\n\\n例如：<code>-1001234567890</code>\\n\\n机器人必须同时在两个仓库里。发送 /cancel 可取消。");
  }
  if (admin && s?.step === "migration_target") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消仓库迁移。",adminMenu()); }
    const target=String(t||"").trim(), source=String(s?.source||"").trim();
    if(!target) return send(TOKEN,uid,"⚠️ 请输入新仓库 ID 或 @用户名。");
    states.delete(key);
    try { return await repositoryMigration(uid,source,target); }
    catch(e) { const m=db.settings.repositoryMigration||{}; if(!repositoryMigrationRunning) { db.settings.repositoryMigration={...m,status:"error",finishedAt:Date.now(),error:String(e?.message||e)}; saveDb(); } return sendHtml(TOKEN,uid,"<b>❌ 仓库迁移失败</b>\\n\\n⚠️ "+escapeHtml(e?.message||e)+"\\n\\n请确认机器人同时在旧仓库和新仓库里，并具有读取消息权限。",adminMenu()); }
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

  if(t==="📦 绑定资源仓库" && admin) {
    states.set(key,{step:"bind_repository"});
    return sendHtml(TOKEN,uid,
      "<b>📦 绑定资源仓库</b>\n\n"+
      "请选择下面任意一种方式：\n\n"+
      "① <b>直接发送仓库 Chat ID / @用户名</b>\n"+
      "例如：<code>-1001234567890</code> 或 <code>@my_channel</code>\n\n"+
      "② <b>转发仓库中的任意一条消息</b>给我\n"+
      "仅在当前处于“绑定仓库”状态时才会执行绑定；普通转发不会绑定。\n\n"+
      "⚠️ 绑定前请先把主机器人加入仓库；频道建议设为管理员。\n\n"+
      "发送 <code>/cancel</code> 可取消。",
      {reply_markup:{inline_keyboard:[[{text:"❌ 取消绑定",callback_data:"bind_repo_cancel"}]]}});
  }

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

  if(t==="📦 资源仓库" && admin) {
    states.set(key,{step:"bind_repository"});
    return sendHtml(TOKEN,uid,
      "<b>📦 绑定资源仓库</b>\\n━━━━━━━━━━━━━━\\n\\n"+
      "当前仓库："+(repo()?"✅ <b>"+escapeHtml(repo().title)+"</b>\\n🆔 <code>"+escapeHtml(String(repo().chatId||""))+"</code>":"❌ 未绑定")+"\\n\\n"+
      "请选择一种方式：\\n"+
      "① 直接发送仓库 Chat ID 或 @用户名\\n"+
      "② 从目标频道/群转发任意一条消息给机器人\\n\\n"+
      "⚠️ 请先确保机器人已经加入目标仓库并拥有读取消息权限。\\n"+
      "发送 <code>/cancel</code> 可取消。",
      {reply_markup:{inline_keyboard:[
        [{text:"🔄 重新绑定",callback_data:"adm:repo_bind"}],
        [{text:"❌ 取消",callback_data:"admin:resource"}]
      ]}});
  }

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

  if(t==="⚡ 自动同步" && admin) {
    const a=repositoryAutoSyncState();
    if(a.enabled||a.sourceId) return showRepositoryAutoSyncStatus(uid);
    states.set(key,{step:"auto_migration_source"});
    return sendHtml(TOKEN,uid,"<b>⚡ 自动同步</b>\n━━━━━━━━━━━━━━\n\n📤 第一步：发送旧仓库 Chat ID 或 @用户名。\n📥 首次会先迁移历史资源，完成后以后出现的新资源会自动复制到新仓库。\n\n⚠️ 机器人必须同时在两个仓库里。\n📌 旧仓库不会删除。\n\n发送 /cancel 可取消。");
  }

  if(t==="🔄 迁移仓库" && admin) {
    states.set(key,{step:"migration_source"});
    return sendHtml(TOKEN,uid,"<b>🔄 旧仓库 → 新仓库</b>\\n━━━━━━━━━━━━━━\\n\\n📤 第一步：发送旧仓库 Chat ID 或 @用户名。\\n\\n例如：<code>-1001234567890</code>\\n\\n⚠️ 机器人必须同时在旧仓库和新仓库里。\\n📌 旧仓库不会删除。\\n📁 文件夹归属会保留。\\n\\n发送 /cancel 可取消。",{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{"text":"❌ 取消","callback_data":"admin:root"}]]}});
  }

  if(t==="🔄 迁移仓库" && admin) {
    states.set(key,{step:"migration_source"});
    return sendHtml(TOKEN,uid,"<b>🔄 旧仓库 → 新仓库</b>\n━━━━━━━━━━━━━━\n\n📤 第一步：发送旧仓库 Chat ID 或 @用户名。\n\n例如：<code>-1001234567890</code>\n\n⚠️ 机器人必须同时在旧仓库和新仓库里。\n📌 旧仓库不会删除。\n📁 文件夹归属会保留。\n\n发送 /cancel 可取消。",{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{"text":"❌ 取消","callback_data":"admin:root"}]]}});
  }

  if(t==="🔍 仓库扫描" && admin) {
    const scan=db.settings.historyScan;
    const auth=db.settings.historyAuth;
    const scanTargetButton=repo() ? "🔍 开始历史扫描" : "🔎 扫描指定仓库";
    return send(TOKEN,uid,
      "🔍 仓库扫描\n\n"+
      "📦 当前仓库： "+(repo()?repo().title:"❌ 未绑定")+"\n"+
      "📚 当前索引： "+db.resources.length+" 条\n"+
      "🕘 历史扫描： "+(scan.status==="completed"?"✅ 已完成":scan.status==="running"?"⏳ 扫描中":scan.status==="error"?"⚠️ 上次失败":"未执行")+"\n"+
      (scan.scanned?("\n最近一次：扫描 "+scan.scanned+" 条，索引 "+scan.indexed+" 条"):"")+"\n\n"+
      (auth?.session?"🔐 扫描账号：已授权":"🔐 扫描账号：首次使用需授权")+"\n\n"+
      (repo()?"点击「🔍 开始历史扫描」即可扫描当前仓库历史消息。":"未绑定仓库时也可以直接指定要扫描的仓库。"),
      {reply_markup:{keyboard:[[scanTargetButton,"🔐 扫描授权"],["📦 资源仓库","📊 数据统计"],["⚙️ 平台设置"]],resize_keyboard:true}});
  }

  if(t==="🔎 扫描指定仓库" && admin) {
    states.set(key,{step:"scan_target"});
    return sendHtml(TOKEN,uid,"<b>🔎 扫描指定仓库</b>\n\n请输入仓库 Chat ID 或 @用户名。\n\n例如：<code>-1001234567890</code>\n\n发送 /cancel 可取消。");
  }

  if(t==="🔍 开始历史扫描" && admin) return scanHistory(uid);
  if(t==="🔐 扫描授权" && admin) {
    try { await ensureHistoryClient(uid); return send(TOKEN,uid,"✅ MTProto 扫描账号已授权。现在可以点击「🔍 开始历史扫描」。",adminMenu()); }
    catch(e) { return send(TOKEN,uid,"❌ 扫描授权失败：\n\n"+e.message,adminMenu()); }
  }

  if(t==="📂 资源目录") {
    states.delete(key);
    console.log("📂 资源目录：用户="+uid+" 文件夹="+db.directories.length+" 资源="+db.resources.length);
    try {
      return await sendHtml(TOKEN,uid,directoryText(),{reply_markup:directoryInlineKeyboard()});
    } catch(e) {
      console.error("❌ 资源目录发送失败:",String(e?.telegramDescription||e?.message||e));
      return send(TOKEN,uid,"❌ 资源目录暂时无法打开，请稍后再试。");
    }
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
      return send(TOKEN,uid,"↩️ <b>已退出搜索</b>\\n\\n👇 请选择其他功能。",admin?adminMenu():userMenu());    }
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
    const oldDirectoryId=String(d.id);
    const oldMarker=Array.from(baserowRowsCache.values()).find(row=>{
      const f=baserowPickField(baserowFieldsCache,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"]);
      return f && String(row?.[f.name]||"").startsWith("__FOLDER__:"+oldDirectoryId+":");
    });
    if(oldMarker?.id) baserowSyncQueue=baserowSyncQueue.then(()=>baserowDeleteRow(oldMarker.id));
    const existing=getDirectoryByName(newName);
    if(existing && String(existing.id)!==String(d.id)) return send(TOKEN,uid,"⚠️ 已存在同名文件夹，请换一个名称。");
    d.name=newName;
    d.id=sharedDirectoryId(newName);
    for(const item of db.resources) if(String(item.directoryId)===oldDirectoryId) item.directoryId=d.id;
    touchSharedData(uid);
    queueBaserowDirectorySync(d);
    for(const item of db.resources.filter(item=>String(item.directoryId)===String(d.id))) queueBaserowResourceSync(item);
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
      for(const item of items) queueBaserowDeleteResource(item);
      const marker=Array.from(baserowRowsCache.values()).find(row=>String(row?.[baserowPickField(baserowFieldsCache,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"] )?.name]||"").startsWith("__FOLDER__:"+d.id+":"));
      if(marker?.id) baserowSyncQueue=baserowSyncQueue.then(()=>baserowDeleteRow(marker.id));
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
    queueBaserowDeleteResource(item);
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
    if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
    if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
    states.set(key,{step:"upload_folder",pendingUploads:[]});
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
  if(s?.step==="folder_rename"&&admin) {
    if(t==="/cancel" || t==="❌ 取消") {
      states.delete(key);
      return sendHtml(TOKEN,uid,"❌ 已取消修改文件夹名称。",{reply_markup:uploadFolderInlineMenu()});
    }
    const d=db.directories.find(x=>String(x.id)===String(s.directoryId));
    const newName=String(t||"").trim().slice(0,80);
    if(!d) {
      states.delete(key);
      return sendHtml(TOKEN,uid,"⚠️ 文件夹不存在。",{reply_markup:uploadFolderInlineMenu()});
    }
    if(!newName) return sendHtml(TOKEN,uid,"⚠️ 文件夹名称不能为空，请重新发送。");
    const same=db.directories.find(x=>String(x.id)!==String(d.id)&&String(x.name||"").trim().toLowerCase()===newName.toLowerCase());
    if(same) return sendHtml(TOKEN,uid,"⚠️ 已存在同名文件夹，请换一个名称。");
    const oldName=d.name;
    d.name=newName;
    for(const item of db.resources.filter(r=>String(r.directoryId)===String(d.id))) queueBaserowResourceSync(item);
    queueBaserowDirectorySync(d);
    touchSharedData(uid);
    saveDb();
    states.delete(key);
    logAdmin(uid,"修改文件夹名称",oldName+" → "+newName);
    return sendHtml(TOKEN,uid,"✅ <b>文件夹名称已修改</b>\\n\\n📁 原名称："+escapeHtml(oldName)+"\\n📁 新名称："+escapeHtml(newName),{reply_markup:uploadFolderInlineMenu()});
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
    console.log("📤 UPLOAD SESSION START:", "uid="+uid, "folder="+cleanFolder, "first="+(media?"yes":"no"), "pending="+firstPending.length);
    if(media) {
      // 第一个文件也不单独回复，后续文件直接进入同一个上传会话。
      return;
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
      return;
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
          send(TOKEN,uid,"⏸️ <b>暂时没有收到新文件</b>\\n\\n📁 文件夹："+escapeHtml(current.directoryName)+"\\n📥 已收到：<b>"+(current.pendingUploads?.length||0)+"</b> 个资源\\n⏱️ 已等待 "+UPLOAD_IDLE_SECONDS+" 秒。\\n\\n还要继续上传吗？",{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}]]}}).catch(()=>{});
        }
      },UPLOAD_TIMEOUT_MS));
      states.set(key,{step:"upload_file",directoryId:s.directoryId,directoryName:s.directoryName,pendingUploads:pending});
      console.log("📥 RESOURCE RECEIVED:", "folder=",s.directoryName, "message=",msg.message_id, "pending=",pending.length);
      // 同一次转发可能会连续收到多条 Telegram 消息。
      // 延迟短暂时间，等这一批消息收齐后只询问一次，避免每个文件都弹一次。
      // 收到文件后不逐条回复，避免连续上传时产生大量提示消息。
      // 当前批次只在空闲超时后统一显示“继续/结束”按钮，管理员也可以随时点击“结束上传”。
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

  if(s?.step==="broadcast"&&admin) {    const timerKey=key+":broadcast";
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
  // 目录/资源以 Baserow 为跨机器人共享源；刷新放后台，不能阻塞 /start 和菜单按钮。
  refreshSharedData(false).catch(e=>console.warn("⚠️ 子机器人共享目录刷新失败:",String(e?.message||e)));
  // 子机器人消息处理同样不能等待 Baserow，避免 /start 和菜单被共享同步卡住。
  if(msg.chat?.type!=="private") return;
  const uid=msg.from.id;
  await ensureUserInlineMode(token, uid);
  const t=msg.text||"",key="c:"+child.botId+":"+uid,s=states.get(key);
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

  // 回调必须独立于 Baserow：先确认点击，再执行按钮逻辑。
  console.log("🔘 CALLBACK:", data, "uid="+uid, "chat="+chatId);
  const answer=async(text="",showAlert=false)=>{
    try {
      const body={callback_query_id:callbackId};
      if(text) { body.text=text; body.show_alert=showAlert; }
      await tg(token,"answerCallbackQuery",body);
    } catch(e) {
      // 查询过期/ID无效属于 Telegram 正常业务拒绝，不影响按钮后续逻辑。
      console.warn("⚠️ callback确认失败（继续处理按钮）:", String(e?.telegramDescription || e?.message || e));
    }
  };
  await answer();
  // 按钮回调绝不能等待 Baserow。先立即响应 Telegram，目录共享数据在后台刷新。
  // 否则 Baserow 网络延迟会让每一次按钮点击都出现明显卡顿。
  void refreshSharedData(false);

  if(data==="user:dirs") {
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:directoryText(),parse_mode:"HTML",reply_markup:directoryInlineKeyboard()});
  }
  if(data==="user:search") {
    states.set("m:"+uid,{step:"search"});
    return safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"<b>🔎 搜索资源</b>\n\n请输入关键词，例如：作者名、标题或关键词。\n\n💡 支持模糊搜索，最多返回 10 条。\n↩️ 发送 <code>/cancel</code> 可退出搜索。",
      parse_mode:"HTML",
      reply_markup:{inline_keyboard:[[{text:"⬅️ 返回首页",callback_data:"user:home"}]]}});
  }
  if(data==="user:random") {
    return deliver(token,uid,uid,random10(uid),token,{mode:"random",offset:0,total:db.resources.length});
  }
  if(data==="user:latest") {
    return deliver(token,uid,uid,db.resources.slice(0,10),token,{mode:"latest",offset:0,total:db.resources.length});
  }
  if(data==="user:clone") {
    states.set("m:"+uid,{step:"token"});
    return send(token,uid,"🤖 创建子机器人\n\n请把你在 BotFather 创建的 Bot Token 发给我。\n\n发送 /cancel 可取消。");
  }
  if(data==="user:home") {
    states.delete("m:"+uid);
    return safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"<b>👋 欢迎使用资源平台</b>\n\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\n🤖 <b>平台功能</b>：克隆机器人\n\n👇 <i>请选择下方功能开始使用</i>",
      parse_mode:"HTML",
      reply_markup:userHomeInlineKeyboard().reply_markup});
  }

  if(data==="hub"||data.startsWith("hub:")){
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
    if(data==="admin:backup") return backupRecoveryPreview(uid);
    if(data==="admin:backup_restore") return backupRecoveryMerge(uid);
    if(data==="admin:upload"){
      if(!repo()){
        await answer("尚未绑定资源仓库",true);
        return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>❌ 尚未绑定资源仓库</b>\n\n请先绑定资源仓库。",parse_mode:"HTML",reply_markup:adminResourceInline()});
      }
      const key="m:"+uid;
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      states.set(key,{step:"upload_folder",pendingUploads:[]});
      await answer("已进入上传模式");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"<b>📤 上传资源</b>\n━━━━━━━━━━━━━━\n\n👇 请选择文件夹\n\n📁 选择后直接连续发送文件\n📌 上传过程中不会逐条回复。",
        parse_mode:"HTML",
        reply_markup:uploadFolderInlineMenu()
      });
    }
    if(data==="admin:prompts")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📝 用户提示</b>\n━━━━━━━━━━━━━━\n\n👇 请选择要编辑的提示",parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"✏️ 非会员提示",callback_data:"adm:nonmember"},{text:"✏️ 获取后提示",callback_data:"adm:post"}],
      [{text:"⬅️ 返回",callback_data:"admin:ops"}]
    ]}});
    if(data==="adm:nonmember")return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"✏️ 非会员提示"});
    if(data==="adm:post")return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📣 获取后推广"});
    if(route==="recover") { sendHtml(TOKEN,uid,"<b>🔄 Baserow 历史恢复已启动</b>\\n\\n📚 读取现有 Baserow 资源名称\\n🔎 扫描原 Telegram 仓库\\n📁 自动恢复文件夹归属\\n🔗 自动补回聊天ID/消息ID\\n\\n⏳ 任务将在后台继续运行…",adminMenu()).catch(()=>{}); recoverBaserowHistory(uid).catch(e=>console.error("❌ RECOVERY TASK:",e)); return; }
    if(route==="folder_repair") return repairLostFolderAssignments(uid);
    if(route==="auto_status") return showRepositoryAutoSyncStatus(uid);
    if(route==="auto_stop") { await stopRepositoryAutoSync(); return showRepositoryAutoSyncStatus(uid); }
    if(route==="auto_resume") { const a=repositoryAutoSyncState(); if(!a.sourceId||!a.targetId) return showRepositoryAutoSyncStatus(uid); a.enabled=true; a.status="running"; a.updatedAt=Date.now(); saveDb(); processRepositoryAutoSyncQueue().catch(()=>{}); return showRepositoryAutoSyncStatus(uid); }
    const syn={rename:"✏️ 修改文件夹名称",delete:"🗑️ 删除资源",move:"🔄 移动资源",bulk:"📦 批量管理",share:"🔗 分享资源",repo:"📦 资源仓库",scan:"🔍 仓库扫描",recover:"🧩 恢复历史资源",group:"🔐 指定群管理",admins:"👥 管理员管理",stats:"📊 数据统计",broadcast:"📢 广播消息",logs:"📜 操作日志",pin:"📌 广播后置顶",post:"📣 获取后推广",clone:"🤖 克隆机器人",migrate:"🔄 迁移仓库",auto:"⚡ 自动同步",auto_status:"⚡ 自动同步",auto_stop:"⏸️ 停止自动同步",auto_resume:"▶️ 继续自动同步"};
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
    queueBaserowResourceSync(item);
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
        queueBaserowDeleteResource(item);
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

  // 上传资源的文件夹选择最多显示 10 个，超过后使用分页。
  if(!child && isAdmin(uid) && data.startsWith("uploadsp:")) {
    const page=Math.max(0,Number(data.slice("uploadsp:".length))||0);
    await answer();
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"<b>📤 上传资源</b>\\n━━━━━━━━━━━━━━\\n\\n👇 请选择文件夹\\n\\n📁 每页最多显示 <b>10</b> 个\\n📌 选择后可连续发送文件",
      parse_mode:"HTML",
      reply_markup:uploadFolderInlineMenu(page)
    });
  }

  // 文件夹管理：继续上传、查看、改名、移动、删除。
  if(!child && isAdmin(uid) && data.startsWith("folder_manage:")) {
    return;
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_upload:")) {
    const directoryId=data.slice("folder_manage_upload:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){await answer("文件夹不存在",true);return;}
    states.set("m:"+uid,{step:"upload_file",directoryId:d.id,directoryName:d.name,pendingUploads:[]});
    await answer("已进入上传");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📁 <b>"+escapeHtml(d.name)+"</b>\\n\\n📤 <b>继续发送文件</b>\\n收到的文件会自动归入此文件夹。\\n\\n完成后点击「✅ 结束上传」。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}]]}});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_view:")) {
    const directoryId=data.slice("folder_manage_view:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){await answer("文件夹不存在",true);return;}
    const all=directoryItems(d.id);
    await answer();
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📁 <b>"+escapeHtml(d.name)+"</b>\\n\\n📦 共 <b>"+all.length+"</b> 个资源\\n📤 每次获取 <b>10 个</b>\\n\\n👇 点击下方开始获取",parse_mode:"HTML",reply_markup:folderSummaryKeyboard(d.id,all.length,0)});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_rename:")) {
    const directoryId=data.slice("folder_manage_rename:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){await answer("文件夹不存在",true);return;}
    states.set("m:"+uid,{step:"folder_rename",directoryId:d.id,oldName:d.name});
    await answer("请输入新的文件夹名称");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"✏️ <b>修改文件夹名称</b>\\n\\n当前名称：<b>"+escapeHtml(d.name)+"</b>\\n\\n请直接发送新的名称。\\n发送 /cancel 可取消。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"❌ 取消",callback_data:"folder_manage_back:"+d.id}]]}});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_move:")) {
    const directoryId=data.slice("folder_manage_move:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){await answer("文件夹不存在",true);return;}
    await answer();
    states.set("m:"+uid,{step:"folder_move",sourceId:d.id});
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"🔄 <b>移动文件夹内资源</b>\\n\\n📁 来源：<b>"+escapeHtml(d.name)+"</b>\\n📦 资源：<b>"+db.resources.filter(r=>String(r.directoryId)===String(d.id)).length+"</b>\\n\\n👇 请选择目标文件夹",parse_mode:"HTML",reply_markup:folderMoveTargetMenu(d.id)});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_move_to:")) {
    const targetId=data.slice("folder_move_to:".length);
    const sourceId=String(data.match(/^folder_move_to:(.+)$/)?.[1]||"");
    const st=states.get("m:"+uid);
    if(!st || st.step!=="folder_move" || !st.sourceId){await answer("操作已过期，请重新选择",true);return;}
    const target=db.directories.find(x=>String(x.id)===String(targetId));
    const source=db.directories.find(x=>String(x.id)===String(st.sourceId));
    if(!target||!source){await answer("文件夹不存在",true);return;}
    const items=db.resources.filter(r=>String(r.directoryId)===String(source.id));
    for(const item of items){item.directoryId=target.id;queueBaserowResourceSync(item);}
    touchSharedData(uid);saveDb();states.delete("m:"+uid);
    await answer("已移动 "+items.length+" 个资源");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"✅ <b>移动完成</b>\\n\\n📁 原文件夹："+escapeHtml(source.name)+"\\n📁 目标文件夹："+escapeHtml(target.name)+"\\n📦 已移动："+items.length+" 个资源",parse_mode:"HTML",reply_markup:folderManageMenu(target.id)});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_delete:")) {
    const directoryId=data.slice("folder_manage_delete:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){await answer("文件夹不存在",true);return;}
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    await answer();
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"🗑️ <b>删除文件夹</b>\\n\\n📁 "+escapeHtml(d.name)+"\\n📦 当前资源：<b>"+count+"</b>\\n\\n请选择删除方式：",parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"🗑️ 只删文件夹，保留资源",callback_data:"folder_delete_keep:"+d.id}],
      [{text:"⚠️ 文件夹 + 资源一起删除",callback_data:"folder_delete_all:"+d.id}],
      [{text:"⬅️ 返回",callback_data:"folder_manage_back:"+d.id}]
    ]}});
  }
  if(!child && isAdmin(uid) && (data.startsWith("folder_delete_keep:") || data.startsWith("folder_delete_all:"))) {
    const allDelete=data.startsWith("folder_delete_all:");
    const directoryId=data.slice((allDelete?"folder_delete_all:":"folder_delete_keep:").length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){await answer("文件夹不存在",true);return;}
    const items=db.resources.filter(r=>String(r.directoryId)===String(d.id));
    if(allDelete){for(const item of items)queueBaserowDeleteResource(item);db.resources=db.resources.filter(r=>String(r.directoryId)!==String(d.id));}
    else {for(const item of items){item.directoryId=null;queueBaserowResourceSync(item);}}
    db.directories=db.directories.filter(x=>String(x.id)!==String(d.id));
    touchSharedData(uid);saveDb();
    await answer("删除完成");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"✅ <b>文件夹已删除</b>\\n\\n📁 "+escapeHtml(d.name)+"\\n📦 "+(allDelete?"同时删除资源："+items.length:"资源已保留："+items.length),parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_back:")) {
    const directoryId=data.slice("folder_manage_back:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(d){await answer();return safeEdit(token,{chat_id:chatId,message_id:messageId,text:folderManageText(d.id),parse_mode:"HTML",reply_markup:folderManageMenu(d.id)});}
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📤 上传资源</b>\\n\\n👇 请选择文件夹",parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
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
    await answer("已打开文件夹");
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:folderManageText(d.id),
      parse_mode:"HTML",
      reply_markup:folderManageMenu(d.id)
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

let mainPollingActive = false;
const mainProcessedUpdates = new Set();

async function pollMain() {
  if (mainPollingActive) {
    console.warn("⚠️ MAIN POLLING 已经运行，忽略重复启动");
    return;
  }
  mainPollingActive = true;
  try {
    await main("deleteWebhook",{drop_pending_updates:false});
  } catch (e) {
    runtime.lastError = String(e.message || e);
    console.error("MAIN WEBHOOK:", runtime.lastError);
    await sleep(3000);
  }
  console.log("🌐 Telegram API: https://api.telegram.org");
  console.log("🌐 DNS order:", (() => { try { return dns.getDefaultResultOrder(); } catch { return "unknown"; } })());
  console.log("🧩 MAIN POLLING:", "pid=" + PROCESS_ID, "token=" + TOKEN_FINGERPRINT);
  console.log("✅ MAIN POLLING READY");
  while(true){
    try{
      runtime.lastPollAt = Date.now();
      const updates=await main("getUpdates",{offset:db.offset,timeout:25,allowed_updates:["message","callback_query","channel_post","edited_channel_post"]});
      runtime.lastTelegramOkAt = Date.now();
      runtime.mainConnected = true;
      runtime.lastError = "";
      if (updates.length) runtime.lastUpdateAt = Date.now();
      for(const u of updates){
        const updateId=Number(u.update_id);
        if(Number.isFinite(updateId)) {
          if(mainProcessedUpdates.has(updateId)) {
            console.warn("⚠️ MAIN DUPLICATE UPDATE 已忽略:", updateId);
            continue;
          }
          mainProcessedUpdates.add(updateId);
          // 只保留最近一批，避免长期占用内存。
          if(mainProcessedUpdates.size>2000) {
            const first=mainProcessedUpdates.values().next().value;
            mainProcessedUpdates.delete(first);
          }
        }
        console.log("📩 MAIN UPDATE:", u.update_id, u.callback_query ? "callback_query" : u.channel_post ? "channel_post" : u.edited_channel_post ? "edited_channel_post" : u.message ? "message" : "other");
        if(u.channel_post) {
          console.log("📦 CHANNEL POST:", String(u.channel_post.chat?.id), u.channel_post.chat?.title || u.channel_post.chat?.username || "");
          indexResource(u.channel_post);
          queueRepositoryAutoSyncMessage(u.channel_post);
        }
        if(u.edited_channel_post) {
          console.log("✏️ EDITED CHANNEL POST:", String(u.edited_channel_post.chat?.id));
          indexResource(u.edited_channel_post);
          queueRepositoryAutoSyncMessage(u.edited_channel_post);
        }
        if(u.callback_query) {
          console.log("🔘 MAIN CALLBACK RECEIVED:", String(u.callback_query.data||""));
          // 回调后台执行，不阻塞 getUpdates；Telegram 按钮可连续点击，长任务不会卡住整个机器人。
          void handleDirectoryCallback(TOKEN,u.callback_query,false);
        }
        if(u.message) {
          console.log("📨 MAIN MESSAGE RECEIVED:", String(u.message.text||u.message.caption||"").slice(0,80));
          try {
            await mainMessage(u.message);
          } catch(e) {
            console.error("MAIN MESSAGE:",e.message);
          }
        }
        db.offset=u.update_id+1;
      }
      saveDb();
    }catch(e){
      // 长轮询/网络异常时不要继续显示“真实连接”，否则心跳会产生假在线状态。
      runtime.mainConnected = false;
      runtime.lastError = String(e.message || e);
      if (/409|Conflict|terminated by other getUpdates request/i.test(String(e?.message || e))) {
        console.error("🚨 检测到同一 BOT_TOKEN 的 getUpdates 冲突：请确认这个 token 没有在另一个部署/进程中同时运行",
          "pid=" + PROCESS_ID, "token=" + TOKEN_FINGERPRINT);
      }
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
        if(u.callback_query) {
          // 子机器人回调同样后台执行，避免一个慢操作堵住后续按钮。
          void handleDirectoryCallback(token,u.callback_query,true);
        }
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

let bootActive = false;
let backgroundTimersStarted = false;
let sharedBaserowInitStarted = false;
let sharedBaserowRefreshTimerStarted = false;

async function boot(){
  if (bootActive) {
    console.warn("⚠️ BOOT 已经运行，忽略重复启动", "pid=" + PROCESS_ID);
    return;
  }
  bootActive = true;
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  saveDb();

  if (!TOKEN) {
    runtime.lastError = "BOT_TOKEN 未配置";
    console.error("❌ BOT_TOKEN 未配置，等待环境变量后自动重试");
  }

  console.log("🛡️ 内容保护：", contentProtectionEnabled() ? "开启" : "关闭", "自动删除：", autoDeleteText());
  if (!backgroundTimersStarted) {
    backgroundTimersStarted = true;
    setInterval(() => { processAutoDeleteQueue().catch(e=>console.warn("⚠️ 自动删除任务异常：",e.message)); }, 30000);
    setInterval(() => {
      const s = runtimeStatus();
      console.log("🫀 HEARTBEAT:", "connected="+s.mainConnected, "uptime="+s.uptimeSeconds+"s", "lastPoll="+(s.lastPollAt||"-"), "lastUpdate="+(s.lastUpdateAt||"-"), "error="+(s.lastError||"-"));
    }, 30000);
  }

  // Baserow 共享刷新独立于其他后台定时器，避免被后台初始化状态影响。
  if (!sharedBaserowRefreshTimerStarted) {
    sharedBaserowRefreshTimerStarted = true;
    console.log("🔁 Baserow 共享刷新定时器已启动：每 5 分钟检查一次；资源/文件夹操作后立即刷新");
    setInterval(() => {
      refreshSharedData(false).catch(e => console.warn("⚠️ 跨机器人目录同步异常:", String(e?.message || e)));
    }, 300000);
  }
  processAutoDeleteQueue().catch(e=>console.warn("⚠️ 自动删除初始化失败：",e.message));

  console.log("🫀 BOT HEARTBEAT ENABLED");
  if (backgroundTimersStarted) {
    const s = runtimeStatus();
    console.log("🫀 HEARTBEAT:", "connected="+s.mainConnected, "uptime="+s.uptimeSeconds+"s", "lastPoll="+(s.lastPollAt||"-"), "lastUpdate="+(s.lastUpdateAt||"-"), "error="+(s.lastError||"-"));
  }

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
      const autoSyncState=repositoryAutoSyncState();
      if(autoSyncState.enabled && autoSyncState.sourceId && autoSyncState.targetId) processRepositoryAutoSyncQueue().catch(e=>console.error("❌ 自动同步恢复失败:",String(e?.message||e)));
      const migrationState=db.settings.repositoryMigration||{};
      if(String(migrationState.status||"")==="running" && migrationState.sourceId && migrationState.targetId && migrationState.ownerId) {
        console.log("🔄 检测到未完成迁移，启动断点恢复：",migrationState.sourceId+"->"+migrationState.targetId);
        repositoryMigration(Number(migrationState.ownerId),migrationState.sourceId,migrationState.targetId)
          .catch(e=>console.error("❌ 迁移断点恢复失败:",String(e?.message||e)));
      }
      // Telegram 轮询必须优先启动，Baserow 同步不得阻塞机器人按钮和消息。
      if (!sharedBaserowInitStarted) {
        sharedBaserowInitStarted = true;
        console.log("🔄 Baserow 共享模式：后台初始化，不阻塞 Telegram", "pid=" + PROCESS_ID);
        initializeSharedBaserow()
          .then(async()=>{
            console.log("✅ Baserow 共享初始化完成", "pid=" + PROCESS_ID);
            console.log("🔎 Baserow 共享配置:", "enabled="+baserow.enabled, "table="+BASEROW_TABLE_ID);
            // 初始化完成后立即强制刷新一次，确保刚启动的机器人立刻拿到其他机器人已经写入的目录。
            await refreshSharedData(true);
            console.log("✅ Baserow 启动后首次强制刷新完成", "pid=" + PROCESS_ID);
          })
          .catch(e=>console.error("❌ Baserow 后台初始化异常:",String(e?.message||e)));
      }
      console.log("✅ 主机器人已连接:","@"+(me.username||me.first_name), "pid=" + PROCESS_ID, "token=" + TOKEN_FINGERPRINT);
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