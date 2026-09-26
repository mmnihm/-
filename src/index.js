import http from "node:http";
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
  DATA_FILE = "/tmp/mmnihm/database.json";
  console.warn("⚠️ 数据目录不可写，已切换到:", DATA_FILE);
}
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
    dataFile: DATA_FILE
  };
}

console.log("🚀 Telegram Clone Platform v2 starting...");
console.log("📦 Node:", process.version);
console.log("🔐 BOT_TOKEN:", TOKEN ? "已配置" : "❌ 未配置");
console.log("👑 ADMIN_IDS:", ADMIN_IDS.size ? "已配置" : "❌ 未配置");

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

async function tg(token, method, body = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timeoutMs = method === "getUpdates" ? 35000 : 20000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(api(token, method), {
        method: "POST",
        headers: {"content-type":"application/json"},
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      if (e?.name === "AbortError") throw new Error(method + " 请求超时");
      const cause = e?.cause;
      const detail = [e?.name, e?.message, cause?.code, cause?.message].filter(Boolean).join(" | ");
      console.error("❌ TELEGRAM FETCH:", method, detail);
      throw new Error(method + " 网络请求失败: " + detail);
    } finally {
      clearTimeout(timer);
    }
    const j = await r.json();

    if (j.ok) return j.result;

    const retryAfter = Number(j.parameters?.retry_after || 0);
    if (r.status === 429 && retryAfter > 0 && attempt < 3) {
      console.warn("⏳ Telegram 限流，"+method+" 等待 "+retryAfter+" 秒后自动重试");
      await sleep((retryAfter + 1) * 1000);
      continue;
    }

    throw new Error(j.description || method + " failed");
  }
  throw new Error(method + " failed after retries");
}
const main = (method, body = {}) => tg(TOKEN, method, body);

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
  const r = await fetch(api(token, method), {method:"POST", body:form});
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || method + " failed");
  return j.result;
}
function normalizeText(text) {
  return String(text ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
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
  return {offset:0, users:[], children:[], resources:[], directories:[], settings:{requiredGroup:null, repository:null, historyAuth:null, historyScan:{status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""},admins:[],logs:[]}};
}
function logAdmin(uid,action,detail="") {
  if(!db.settings.logs) db.settings.logs=[];
  db.settings.logs.unshift({uid:String(uid),action:String(action),detail:String(detail).slice(0,300),at:Date.now()});
  db.settings.logs=db.settings.logs.slice(0,200);
}
function loadDb() {
  try { return {...emptyDb(), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))}; }
  catch { return emptyDb(); }
}
function saveDb() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error("❌ SAVE:", e.message); }
}
const db = loadDb();
if (!db.settings) db.settings = emptyDb().settings;
if (!Array.isArray(db.settings.admins)) db.settings.admins = [];
if (!Array.isArray(db.settings.logs)) db.settings.logs = [];
if (!("historyAuth" in db.settings)) db.settings.historyAuth = null;
if (!db.settings.historyScan) db.settings.historyScan = {status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""};

let historyClient = null;
let historyConnecting = null;
let TelegramClientClass = null;
let StringSessionClass = null;
const historyInputs = new Map();
const uploadTimers = new Map();
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
      await client.connect();
      await client.getMe();
      authorized = true;
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
  })();
  try { return await historyConnecting; }
  finally { historyConnecting = null; }
}

async function findHistoryEntity(client) {
  const r = repo();
  if (!r) throw new Error("尚未绑定资源仓库");
  if (r.username) {
    try { return await client.getEntity(r.username); } catch {}
  }
  const dialogs = await client.getDialogs({limit:1000});
  for (const d of dialogs) {
    if (String(d.id) === String(r.chatId)) return d.entity;
  }
  throw new Error("MTProto 账号找不到该仓库。请先用这个账号加入仓库，并在 Telegram 客户端里打开过该频道/群。");
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
  if(i>=0) db.resources[i]=item; else db.resources.unshift(item);
  return true;
}

async function scanHistory(uid) {
  if (db.settings.historyScan.status === "running") return send(TOKEN,uid,"🔍 历史扫描已经在进行中，请稍候。");
  const r = repo();
  if (!r) return send(TOKEN,uid,"❌ 尚未绑定资源仓库。先绑定「📦 资源仓库」。",adminMenu());
  db.settings.historyScan={status:"running",scanned:0,indexed:0,startedAt:Date.now(),finishedAt:null,error:""};
  saveDb();
  try {
    const client = await ensureHistoryClient(uid);
    const entity = await findHistoryEntity(client);
    let scanned = 0, indexed = 0;
    for await (const message of client.iterMessages(entity,{limit:undefined})) {
      scanned++;
      if (indexHistoryMessage(message,r.chatId)) indexed++;
      if (scanned % 100 === 0) {
        db.settings.historyScan.scanned=scanned;
        db.settings.historyScan.indexed=indexed;
        saveDb();
        console.log("🔎 HISTORY SCAN:", scanned, "indexed=", indexed);
      }
    }
    db.resources=db.resources.slice(0,MAX_RESOURCES);
    db.settings.historyScan={status:"completed",scanned,indexed,startedAt:db.settings.historyScan.startedAt,finishedAt:Date.now(),error:""};
    saveDb();
    return sendHtml(TOKEN,uid,`<b>✅ 历史扫描完成</b>\n\n📦 <b>资源仓库</b>：${r.title}\n🔎 <b>扫描消息</b>：${scanned} 条\n📚 <b>新增 / 更新</b>：${indexed} 条\n📊 <b>当前资源</b>：${db.resources.length} 条\n\n━━━━━━━━━━━━━━\n✨ <i>历史消息已建立索引</i>\n现在可以直接使用搜索、随机获取和最新资源功能。`,adminMenu());;
  } catch(e) {
    db.settings.historyScan.status="error";
    db.settings.historyScan.error=e.message;
    db.settings.historyScan.finishedAt=Date.now();
    saveDb();
    console.error("❌ HISTORY SCAN:",e);
    return sendHtml(TOKEN,uid,"<b>❌ 历史扫描失败</b>\\n\\n"+e.message+"\\n\\n<i>如果扫描账号已经加入仓库，请重点检查 Telegram 登录状态、频道权限和历史消息读取权限。</i>",adminMenu());
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

function userMenu() {
  return {reply_markup:{keyboard:[
    ["🏠 开始","📂 资源目录"],
    ["🔎 搜索资源","🎲 随机获取"],
    ["🆕 最新资源","🤖 克隆机器人"]
  ],resize_keyboard:true,input_field_placeholder:"请选择功能"}};
}
function childMenu() {
  return {reply_markup:{keyboard:[
    ["🏠 开始","📂 资源目录"],
    ["🔎 搜索资源","🎲 随机获取"],
    ["🆕 最新资源"]
  ],resize_keyboard:true,input_field_placeholder:"请选择功能"}};
}
function backMenu(admin=false) {
  return admin
    ? {reply_markup:{keyboard:[["⬅️ 返回管理","🏠 开始"]],resize_keyboard:true,input_field_placeholder:"返回上一级"}}
    : userMenu();
}
function adminMenu() {
  return {reply_markup:{keyboard:[
    ["📤 上传资源","📦 资源管理"],
    ["⚙️ 平台设置","📊 数据与运营"],
    ["🤖 机器人管理"],
    ["🏠 返回首页"]
  ],resize_keyboard:true,input_field_placeholder:"选择管理分类"}};
}
function adminResourceMenu() {
  return {reply_markup:{keyboard:[
    ["📤 上传资源","📂 资源目录"],
    ["🗑️ 删除资源","🔍 仓库扫描"],
    ["📦 资源仓库","⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"资源管理"}};
}
function adminSettingsMenu() {
  return {reply_markup:{keyboard:[
    ["🔐 指定群管理","➕ 添加管理员"],
    ["➖ 删除管理员","⚙️ 系统设置"],
    ["⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"平台设置"}};
}
function adminOpsMenu() {
  return {reply_markup:{keyboard:[
    ["📊 数据统计","📜 操作日志"],
    ["📢 广播消息","⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"数据与运营"}};
}
function adminBotMenu() {
  return {reply_markup:{keyboard:[
    ["🤖 克隆机器人","⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"机器人管理"}};
}
function adminToolsMenu() {
  return {reply_markup:{keyboard:[
    ["📊 数据统计","🔍 仓库扫描"],
    ["📦 资源仓库","🔐 指定群管理"],
    ["🤖 克隆机器人","📢 广播消息"],
    ["⚙️ 系统设置","👥 管理员管理"],
    ["📜 操作日志","⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"其他管理功能"}};
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
    ["📦 资源仓库","📊 数据统计"],
    ["⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"仓库扫描"}};
}
function platformMenu() {
  return {reply_markup:{keyboard:[
    ["📦 资源仓库","🔐 指定群"],
    ["🔍 仓库扫描","📊 数据统计"],
    ["🤖 克隆机器人","📢 广播消息"],
    ["⬅️ 返回管理"]
  ],resize_keyboard:true,input_field_placeholder:"平台设置"}};
}
function getDirectoryByName(name) { const n=String(name||"").replace(/^📁\s*/,"").replace(/[（(]\s*\d+\s*[）)]\s*$/,"").replace(/\s+/g," ").trim().toLowerCase(); return db.directories.find(d=>{ const dn=String(d.name||"").replace(/[（(]\s*\d+\s*[）)]\s*$/,"").replace(/\s+/g," ").trim().toLowerCase(); return dn===n || String(d.name||"").trim().toLowerCase()===n; })||null; }
function ensureDirectory(name) { const clean=String(name||"").trim().slice(0,80); if(!clean)return null; let d=getDirectoryByName(clean); if(d)return d; d={id:crypto.randomUUID(),name:clean,createdAt:Date.now()}; db.directories.push(d); saveDb(); return d; }
async function finalizeUpload(uid, state) {
  const items = Array.isArray(state?.pendingUploads) ? state.pendingUploads : [];
  if (!items.length) {
    states.delete("m:"+uid);
    return send(TOKEN,uid,"📭 本次没有收到资源。",adminMenu());
  }
  const r = repo();
  if (!r) {
    states.delete("m:"+uid);
    return send(TOKEN,uid,"❌ 资源仓库未绑定，无法入库。",adminMenu());
  }

  let directoryName = String(state.directoryName || "").trim();
  if (!directoryName) {
    directoryName = "未命名-" + Math.random().toString(36).slice(2, 8);
  }
  const d = ensureDirectory(directoryName);
  if (!d) {
    states.delete("m:"+uid);
    return send(TOKEN,uid,"❌ 文件夹创建失败。",adminMenu());
  }

  let stored = 0;
  let failed = 0;
  for (const pending of items) {
    try {
      const copied = await tg(TOKEN,"copyMessage",{
        chat_id:r.chatId,
        from_chat_id:uid,
        message_id:Number(pending.messageId)
      });
      if (!copied?.message_id) throw new Error("仓库转存失败");

      const resourceMsg = {
        ...pending.msg,
        chat:{...(pending.msg?.chat || {}),id:r.chatId},
        message_id:Number(copied.message_id)
      };
      indexResource(resourceMsg);
      const item = db.resources.find(x =>
        String(x.chatId)===String(r.chatId) &&
        Number(x.messageId)===Number(copied.message_id)
      );
      if (!item) throw new Error("资源索引写入失败");
      item.directoryId=d.id;
      item.repositoryMessageId=Number(copied.message_id);
      item.sourceUserId=String(uid);
      item.indexedAt=Date.now();
      stored++;
    } catch (e) {
      failed++;
      console.error("UPLOAD FINALIZE:",e.message,"message=",pending.messageId);
    }
    await sleep(80);
  }

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
function directoryInlineKeyboard() {
  const rows=[];
  for(const d of db.directories){
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    if(count) rows.push([{text:"📁 "+d.name+"（"+count+"）",callback_data:"dir:"+d.id+":0"}]);
  }
  if(!rows.length) rows.push([{text:"📭 暂无分类",callback_data:"noop"}]);
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
  return ["📂 <b>资源目录</b>","","请选择下面的文件夹：","","📚 总资源："+db.resources.length+" 条"].join("\n");
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
    textOnly:!media
  };
  const i=db.resources.findIndex(x=>x.chatId===item.chatId&&x.messageId===item.messageId);
  if(i>=0) db.resources[i]=item; else db.resources.unshift(item);
  db.resources=db.resources.slice(0,MAX_RESOURCES);
  saveDb();
}
async function sendIndexedResource(token, chatId, item) {
  // file_id 属于生成它的 Bot，不能直接跨 Bot 使用。
  // 子机器人没有加入资源仓库时，优先让主机器人代发资源。
  const sendWith = async (sendToken) => {
    if (item.fileId && item.fileType) {
      const field = item.fileType.toLowerCase();
      const body = {chat_id:chatId, [field]:item.fileId};
      if (item.caption) body.caption = String(item.caption).slice(0,1024);
      await tg(sendToken, "send" + item.fileType, body);
      return;
    }
    if (item.textOnly) {
      await tg(sendToken, "sendMessage", {chat_id:chatId, text:item.caption || item.title || "未命名资源"});
      return;
    }
    await tg(sendToken, "copyMessage", {chat_id:chatId,from_chat_id:item.chatId,message_id:Number(item.messageId)});
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
function random10() {
  const arr=[...db.resources];
  for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr.slice(0,10);
}
function resourceKeyboard(items,page=0) {
  const start=page*10;
  const pageItems=items.slice(start,start+10);
  const rows=pageItems.map((x,i)=>[(i+1)+". "+String(x.title||"未命名资源").slice(0,42)]);
  if(start+10<items.length) rows.push(["➡️ 下一页"]);
  if(page>0) rows.push(["⬅️ 上一页"]);
  rows.push(["❌ 退出"]);
  return {reply_markup:{keyboard:rows,resize_keyboard:true,input_field_placeholder:"选择资源"}};
}
function escapeHtml(value) {
  return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function deliverFromHistory(token,chatId,userId,items) {
  if (!(await allowed(TOKEN,userId))) return send(token,chatId,"🔐 请先加入指定群。");
  if (!items.length) return send(token,chatId,"📭 暂无相关资源。");

  try {
    const client = await ensureHistoryClient(userId);
    const entity = await findHistoryEntity(client);
    let ok = 0, fail = 0;

    await send(token,chatId,"⏳ <b>正在准备资源</b>\\n\\n📦 本次获取："+items.length+" 条\\n📤 正在发送，请稍候……",{parse_mode:"HTML"});

    for (const item of items) {
      try {
        const found = await client.getMessages(entity,{ids:[Number(item.messageId)]});
        const message = Array.isArray(found) ? found[0] : found;
        if (!message || !message.media) throw new Error("历史消息或媒体不存在");

        const buffer = await client.downloadMedia(message,{});
        if (!buffer || !buffer.length) throw new Error("媒体下载失败");

        const file = message.file || {};
        const mime = String(file.mimeType || "");
        const name = String(file.name || item.title || "resource");
        const method = mime.startsWith("video") ? "sendVideo" : "sendDocument";
        await tgUploadBuffer(token,method,chatId,buffer,name,item.caption || "");
        ok++;
      } catch (e) {
        fail++;
        console.error("HISTORY SEND:",e.message,"message=",item.messageId);
      }
      await sleep(150);
    }

    if (ok > 0) {
      return send(token,chatId,
        "✅ <b>资源获取完成</b>\\n\\n"+
        "📤 成功发送："+ok+" 条\\n"+
        "⚠️ 失败："+fail+" 条",
        {parse_mode:"HTML"});
    }
    return send(token,chatId,
      "❌ <b>资源发送失败</b>\\n\\n"+
      "📦 尝试获取："+items.length+" 条\\n"+
      "📤 成功发送：0 条\\n"+
      "⚠️ 失败："+fail+" 条\\n\\n"+
      "请检查扫描账号是否仍然可以访问资源仓库。",
      {parse_mode:"HTML"});
  } catch (e) {
    console.error("HISTORY DELIVERY:",e);
    return send(token,chatId,
      "❌ <b>资源获取失败</b>\\n\\n"+
      "原因："+String(e.message || e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),
      {parse_mode:"HTML"});
  }
}

async function deliver(token,chatId,userId,items,sourceToken=TOKEN) {
  if(!(await allowed(TOKEN,userId))) return send(token,chatId,"🔐 请先加入指定群。");
  if(!items.length) return send(token,chatId,"📭 暂无相关资源。");

  const valid = items.filter(x => x && x.chatId && Number(x.messageId) > 0);
  let ok = 0, fail = 0, lastError = "";

  for(const x of valid) {
    try {
      await tg(sourceToken,"copyMessage",{
        chat_id:chatId,
        from_chat_id:x.chatId,
        message_id:Number(x.messageId)
      });
      ok++;
    } catch(e) {
      fail++;
      lastError = e.message || String(e);
      console.error("COPY:", lastError, "chat=", x.chatId, "message=", x.messageId);
    }
    await sleep(80);
  }

  if(fail > 0) {
    const total = valid.length;
    if(ok === 0) {
      const isChatNotFound = /chat not found/i.test(lastError);
      return send(token,chatId,
        "❌ <b>资源暂时无法发送</b>\\n\\n"+
        "📦 找到资源："+total+" 条\\n"+
        "📤 成功发送：0 条\\n"+
        "⚠️ 发送失败："+fail+" 条\\n\\n"+
        (isChatNotFound
          ? "🔧 <b>需要管理员处理</b>\\n\\n请把当前机器人加入「资源仓库」。如果仓库是频道，请将机器人添加为频道管理员。\\n\\n"+
            "历史扫描账号能看到资源，只代表扫描账号能读取历史消息；用户获取资源时，机器人本身也必须能够访问仓库消息。"
          : "🔧 <b>资源仓库读取失败</b>\\n\\n请确认机器人仍在资源仓库中，并有读取消息的权限。\\n\\n"+
            "Telegram：<code>"+String(lastError).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+"</code>")
      , {parse_mode:"HTML"});
    }
    return send(token,chatId,
      "⚠️ <b>资源获取完成</b>\\n\\n"+
      "📤 成功发送："+ok+" 条\\n"+
      "⚠️ 发送失败："+fail+" 条\\n\\n"+
      "部分历史消息无法复制，请稍后再试。"
    , {parse_mode:"HTML"});
  }

  return true;
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
    return sendHtml(TOKEN,uid,"<b>👑 管理员控制台</b>\\n\\n请选择管理分类。",adminMenu());
  }
  const pendingHistory = historyInputs.get(String(uid));
  if (pendingHistory) {
    if (t === "/cancel") { historyInputs.delete(String(uid)); return send(TOKEN,uid,"❌ 已取消历史扫描授权。",adminMenu()); }
    historyInputs.delete(String(uid));
    pendingHistory.resolve(t);
    return;
  }

  if(t==="/start" || t==="🏠 开始") return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\n\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\n🤖 <b>平台功能</b>："+(admin ? "管理后台 · 广播 · 克隆机器人" : "克隆机器人")+"\n\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu());
  if(t==="/admin") {
    if(!admin) return send(TOKEN,uid,"⛔ 无管理员权限。");
    return sendHtml(TOKEN,uid,"<b>👑 管理员控制台</b>\n\n"+configText()+"\n\n👇 <i>请选择需要管理的功能</i>",adminMenu());
  }
  if(t==="/状态") {
    if(!admin) return send(TOKEN,uid,"⛔ 无管理员权限。");
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

  if(t==="📊 数据统计" && admin)
    return sendHtml(TOKEN,uid,
      "<b>📊 平台数据</b>\\n\\n"+
      "👤 用户： <b>"+db.users.length+"</b>\\n"+
      "🤖 子机器人： <b>"+db.children.length+"</b>\\n"+
      "📚 已索引资源： <b>"+db.resources.length+"</b>\\n"+
      "📂 分类： <b>"+db.directories.length+"</b>\\n\\n"+
      "🔐 指定群： "+(group()?"✅ 已绑定":"❌ 未绑定")+"\\n"+
      "📦 资源仓库： "+(repo()?"✅ 已绑定":"❌ 未绑定"),
      {parse_mode:"HTML",...backMenu(true)}
    );

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
    if(!(await allowed(TOKEN,uid))) return send(TOKEN,uid,"🔐 请先加入指定群。");
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
      return send(TOKEN,uid,"🏁 这个文件夹到头了，没有更多资源了。");
    }

    const page=all.slice(offset,offset+10);
    const sent=await sendDirectoryBatch(TOKEN,uid,page);
    const nextOffset=offset+page.length;
    states.set(key,{step:"directory_page",directoryId:s.directoryId,offset:nextOffset});
    const d=db.directories.find(x=>String(x.id)===String(s.directoryId));
    const safe=String(d?.name||"资源文件夹").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    if(!sent) return send(TOKEN,uid,"❌ 本批资源发送失败。请检查资源仓库权限。");
    return sendHtml(TOKEN,uid,
      "📁 <b>"+safe+"</b>\\n\\n"+
      "✅ 本次发送 <b>"+sent+"</b> 个资源。\\n"+
      "📦 进度："+nextOffset+" / "+all.length+"\\n\\n"+
      (nextOffset<all.length?"👇 点击「➡️ 下一步」继续获取。":"🏁 这个文件夹到头了，没有更多资源了。"),
      {reply_markup:{keyboard:nextOffset<all.length?[["➡️ 下一步"],["📂 返回文件夹","🏠 开始"]]:[["📂 返回文件夹","🏠 开始"]],resize_keyboard:true}}
    );
  }

  if(t==="🔎 搜索资源") {
    if(!(await allowed(TOKEN,uid))) return send(TOKEN,uid,"🔐 请先加入指定群。");
    states.set(key,{step:"search"});
    return sendHtml(TOKEN,uid,
      "<b>🔎 搜索资源</b>\\n\\n"+
      "请输入关键词，例如：作者名、标题或关键词。\\n\\n"+
      "💡 支持模糊搜索，最多返回 10 条。\\n"+
      "↩️ 发送 <code>/cancel</code> 可退出搜索。",
      {reply_markup:{keyboard:[["❌ 取消搜索"],["🏠 开始"]],resize_keyboard:true,input_field_placeholder:"请输入搜索关键词"}}
    );
  }
  if(t==="🎲 随机获取") return deliver(TOKEN,uid,uid,random10());
  if(t==="🆕 最新资源") return deliver(TOKEN,uid,uid,db.resources.slice(0,10));
  if(s?.step==="search") {
    if(t==="/cancel" || t==="❌ 取消搜索" || t==="🏠 开始") {
      states.delete(key);
      if(t==="🏠 开始") return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n🤖 <b>平台功能</b>："+(admin ? "管理后台 · 广播 · 克隆机器人" : "克隆机器人")+"\\n\\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu());
      return send(TOKEN,uid,"↩️ 已退出搜索。",admin?adminMenu():userMenu());
    }
    const query=t.trim();
    const results=search(query);
    if(!results.length) return sendHtml(TOKEN,uid,
      "<b>📭 没有找到相关资源</b>\\n\\n关键词：<code>"+escapeHtml(query)+"</code>\\n\\n💡 可以换一个更短的关键词再试。",
      userMenu()
    );
    states.set(key,{step:"search_results",query,results,page:0});
    return send(TOKEN,uid,"🔎 搜索："+query+"\\n\\n📚 找到 "+results.length+" 个资源\\n请选择要获取的资源：",resourceKeyboard(results,0));
  }
  if(s?.step==="search_results") {
    if(t==="❌ 退出" || t==="/cancel" || t==="🏠 开始") {
      states.delete(key);
      return t==="🏠 开始"
        ? sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n🤖 <b>平台功能</b>："+(admin ? "管理后台 · 广播 · 克隆机器人" : "克隆机器人")+"\\n\\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu())
        : send(TOKEN,uid,"↩️ 已退出搜索。",admin?adminMenu():userMenu());
    }
    const results=Array.isArray(s.results)?s.results:[];
    const page=Math.max(0,Number(s.page||0));
    if(t==="➡️ 下一页") {
      if((page+1)*10>=results.length) return send(TOKEN,uid,"📭 已经是最后一页。",resourceKeyboard(results,page));
      const next=page+1;
      states.set(key,{step:"search_results",query:s.query,results,page:next});
      return send(TOKEN,uid,"🔎 搜索："+s.query+"\\n\\n第 "+(next+1)+" 页",resourceKeyboard(results,next));
    }
    if(t==="⬅️ 上一页") {
      const prev=Math.max(0,page-1);
      states.set(key,{step:"search_results",query:s.query,results,page:prev});
      return send(TOKEN,uid,"🔎 搜索："+s.query+"\\n\\n第 "+(prev+1)+" 页",resourceKeyboard(results,prev));
    }
    const pageItems=results.slice(page*10,page*10+10);
    const idx=pageItems.findIndex((x,i)=>(i+1)+". "+String(x.title||"未命名资源").slice(0,42)===t);
    if(idx<0) return send(TOKEN,uid,"⚠️ 请点击搜索结果中的资源。",resourceKeyboard(results,page));
    try {
      await sendIndexedResource(TOKEN,uid,pageItems[idx]);
      return send(TOKEN,uid,"📦 已发送："+pageItems[idx].title,resourceKeyboard(results,page));
    } catch(e) {
      return send(TOKEN,uid,"❌ 资源发送失败："+e.message,resourceKeyboard(results,page));
    }
  }

  if(t==="📂 资源目录"&&admin) {
    return send(TOKEN,uid,"🛠️ <b>资源管理</b>\\n\\n这里放不常用的管理功能。",{parse_mode:"HTML",...adminToolsMenu()});
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
    if(!d) return send(TOKEN,uid,"⚠️ 找不到这个文件夹。",deleteResourceMenu());
    const items=directoryItems(d.id);
    const rows=items.slice(0,40).map((x,i)=>[(i+1)+". "+String(x.title||"未命名资源").slice(0,35)]);
    rows.push(["🗑️ 删除整个文件夹"],["⬅️ 返回文件夹"]);
    states.set(key,{step:"delete_file",directoryId:d.id});
    return send(TOKEN,uid,"📁 <b>"+d.name+"</b>\\n\\n共有 <b>"+items.length+"</b> 个资源。\\n请选择要删除的文件：",{parse_mode:"HTML",reply_markup:{keyboard:rows,resize_keyboard:true,input_field_placeholder:"选择文件"}});
  }
  if(s?.step==="delete_file"&&admin) {
    const d=db.directories.find(x=>String(x.id)===String(s.directoryId));
    if(!d) { states.delete(key); return send(TOKEN,uid,"⚠️ 文件夹不存在。",adminMenu()); }
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
      saveDb(); logAdmin(uid,"删除文件夹",d.name); states.set(key,{step:"delete_folder"});
      return send(TOKEN,uid,"✅ 已删除文件夹「"+d.name+"」。\\n\\n📚 已从资源索引移除："+items.length+" 个文件。\\n🗑️ 仓库消息成功删除："+deleted+" 个。",deleteResourceMenu());
    }
    const items=directoryItems(d.id);
    const idx=items.findIndex((x,i)=>(i+1)+". "+String(x.title||"未命名资源").slice(0,35)===t);
    if(idx<0) return send(TOKEN,uid,"⚠️ 请重新选择要删除的文件。");
    const item=items[idx];
    try { await tg(TOKEN,"deleteMessage",{chat_id:item.chatId,message_id:Number(item.messageId)}); } catch(e) {}
    db.resources=db.resources.filter(x=>!(String(x.chatId)===String(item.chatId)&&Number(x.messageId)===Number(item.messageId)));
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
  if(t==="📦 资源管理"&&admin) return send(TOKEN,uid,"📦 <b>资源管理</b>\\n\\n请选择需要操作的项目。",{parse_mode:"HTML",...adminResourceMenu()});
  if(t==="⚙️ 系统设置"&&admin) return send(TOKEN,uid,"⚙️ <b>平台设置</b>\\n\\n管理指定群、管理员和系统参数。",{parse_mode:"HTML",...adminSettingsMenu()});
  if(t==="📊 数据与运营"&&admin) return send(TOKEN,uid,"📊 <b>数据与运营</b>\\n\\n查看数据、操作日志和发送广播。",{parse_mode:"HTML",...adminOpsMenu()});
  if(t==="🤖 机器人管理"&&admin) return send(TOKEN,uid,"🤖 <b>机器人管理</b>\\n\\n管理克隆机器人相关功能。",{parse_mode:"HTML",...adminBotMenu()});

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
    return send(TOKEN,uid,"📤 <b>上传资源</b>\\n\\n请发送文件夹名称。\\n\\n例如：<code>电影</code>、<code>短剧</code>、<code>教程</code>。\\n\\n新名称会自动创建文件夹。\\n\\n发送 /cancel 可取消。",{parse_mode:"HTML"});
  }
  if(s?.step==="upload_folder"&&admin) {
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消上传。",adminMenu()); }
    const folder=t.trim().slice(0,80);
    if(!folder) return send(TOKEN,uid,"⚠️ 文件夹名称不能为空。");
    const cleanFolder=folder;
    const existing=getDirectoryByName(cleanFolder);
    const uploadKey=key;
    if(uploadTimers.has(uploadKey)) clearTimeout(uploadTimers.get(uploadKey));
    uploadTimers.set(uploadKey,setTimeout(()=>{
      uploadTimers.delete(uploadKey);
      const current=states.get(uploadKey);
      if(current?.step==="upload_file") {
        send(TOKEN,uid,"⏸️ <b>暂时没有收到新文件</b>\\n\\n📁 文件夹："+escapeHtml(current.directoryName)+"\\n📥 已收到：<b>"+(current.pendingUploads?.length||0)+"</b> 个资源\\n⏱️ 已等待 "+UPLOAD_IDLE_SECONDS+" 秒。\\n\\n还要继续上传吗？",{parse_mode:"HTML",reply_markup:{keyboard:[["▶️ 继续上传","✅ 结束上传"],["🏠 开始"]],resize_keyboard:true}}).catch(()=>{});
      }
    },UPLOAD_TIMEOUT_MS));
    states.set(key,{step:"upload_file",directoryId:existing?.id||null,directoryName:cleanFolder,pendingUploads:[]});
    return send(TOKEN,uid,"📁 文件夹：<b>"+escapeHtml(cleanFolder)+"</b>\\n\\n现在请直接连续发送要上传的文件、图片、视频、音频或其他资源。\\n\\n📥 上传过程中不会逐个回复，全部发完后点击「✅ 结束上传」。\\n⏱️ 连续 "+UPLOAD_IDLE_SECONDS+" 分钟没有新文件，会提示你继续或结束。\\n\\n发送 /cancel 可取消。",{parse_mode:"HTML"});
  }
  if(s?.step==="upload_file"&&admin) {
    if(t==="/cancel") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      states.delete(key);
      return send(TOKEN,uid,"❌ 已取消本次上传，未入库的资源不会保存。",adminMenu());
    }
    if(t==="▶️ 继续上传") {
      if(uploadTimers.has(key)) clearTimeout(uploadTimers.get(key));
      uploadTimers.set(key,setTimeout(()=>{
        uploadTimers.delete(key);
        const current=states.get(key);
        if(current?.step==="upload_file") {
          send(TOKEN,uid,"⏸️ <b>暂时没有收到新文件</b>\\n\\n📁 文件夹："+escapeHtml(current.directoryName)+"\\n📥 已收到：<b>"+(current.pendingUploads?.length||0)+"</b> 个资源\\n⏱️ 已等待 "+UPLOAD_IDLE_SECONDS+" 秒。\\n\\n还要继续上传吗？",{parse_mode:"HTML",reply_markup:{keyboard:[["▶️ 继续上传","✅ 结束上传"],["🏠 开始"]],resize_keyboard:true}}).catch(()=>{});
        }
      },UPLOAD_TIMEOUT_MS));
      return send(TOKEN,uid,"▶️ 可以继续上传。");
    }
    if(t==="✅ 结束上传") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      return finalizeUpload(uid,s);
    }
    if(!repo()) {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      states.delete(key);
      return send(TOKEN,uid,"❌ 资源仓库未绑定。",adminMenu());
    }
    const media=msg.document||msg.video||msg.audio||msg.animation||msg.photo?.at(-1)||msg.voice||msg.video_note;
    if(!media && !msg.text) return send(TOKEN,uid,"⚠️ 请发送文件、图片、视频、音频或带文字的资源。");
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
      return send(TOKEN,uid,
        "📥 <b>已收到第 "+pending.length+" 个资源</b>\\n\\n"+
        "📁 文件夹：<b>"+escapeHtml(s.directoryName)+"</b>\\n"+
        "📦 当前已收到：<b>"+pending.length+"</b> 个资源\\n\\n"+
        "请选择下一步：",
        {parse_mode:"HTML",reply_markup:{keyboard:[["▶️ 继续上传","✅ 结束上传"],["🏠 开始"]],resize_keyboard:true,input_field_placeholder:"继续发送文件或选择操作"}}
      );
    } catch(e) {
      return send(TOKEN,uid,"❌ 接收资源失败：\\n"+String(e.message||e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),{parse_mode:"HTML"});
    }
  }

  if(s?.step==="broadcast"&&admin) {
    const timerKey=key+":broadcast";
    if(t==="/cancel") {
      if(uploadTimers.has(timerKey)) { clearTimeout(uploadTimers.get(timerKey)); uploadTimers.delete(timerKey); }
      states.delete(key);
      logAdmin(uid,"取消广播");
      return send(TOKEN,uid,"❌ 已取消广播。",adminMenu());
    }
    let ok=0,fail=0;
    for(const id of db.users){
      try {
        await tg(TOKEN,"copyMessage",{chat_id:id,from_chat_id:uid,message_id:msg.message_id});
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
  if((t.split(" ")[0].split("@")[0])==="/start" || t==="🏠 开始") return sendHtml(token,uid,
    "<b>👋 欢迎使用资源机器人</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n\\n👇 <i>请选择下方功能</i>",
    childMenu());
  // 使用主机器人检查指定群成员资格，子机器人无需单独加入指定群。
  if(!(await allowed(TOKEN,uid))) return send(token,uid,"🔐 请先加入指定群。");
  if(t==="📂 资源目录") {
    if(!db.directories.length) return send(token,uid,"📂 暂无资源目录。",childMenu());
    return sendHtml(token,uid,directoryText(),{reply_markup:directoryInlineKeyboard()});
  }
  if(t==="🔎 搜索资源"){states.set(key,{step:"search"});return send(token,uid,"🔎 <b>搜索资源</b>\n\n请输入关键词，例如：作者名、标题或关键词。\n\n发送 /cancel 可取消。",{parse_mode:"HTML"});}
  if(t==="🎲 随机获取") return deliverFromHistory(token,uid,uid,random10());
  if(t==="🆕 最新资源") return deliverFromHistory(token,uid,uid,db.resources.slice(0,10));
  if(s?.step==="search"){
    if(t==="/cancel"){states.delete(key);return send(token,uid,"↩️ 已退出搜索。",childMenu());}
    states.delete(key);
    const results=search(t);
    if(!results.length) return sendHtml(token,uid,
      "<b>📭 没有找到相关资源</b>\\n\\n关键词：<code>"+String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+"</code>\\n\\n💡 可以换一个更短的关键词再试。",
      childMenu());
    return deliverFromHistory(token,uid,uid,results);
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

  if(!(await allowed(TOKEN,uid))) {
    await answer("🔐 请先加入指定群",true);
    return;
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

  if(data==="dirs") {
    return tg(token,"editMessageText",{
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
    return tg(token,"editMessageText",{
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
      return tg(token,"editMessageText",{
        chat_id:chatId,
        message_id:messageId,
        text:"📁 <b>"+safe+"</b>\\n\\n📭 这个文件夹目前没有可获取的资源。",
        parse_mode:"HTML",
        reply_markup:directoryInlineKeyboard()
      });
    }

    return tg(token,"editMessageText",{
      chat_id:chatId,
      message_id:messageId,
      text:"📁 <b>"+safe+"</b>\\n\\n━━━━━━━━━━━━\\n📦 共 <b>"+all.length+"</b> 个资源\\n📤 每次获取 <b>10 个</b>\\n\\n👇 点击下方按钮开始获取\\n━━━━━━━━━━━━",
      parse_mode:"HTML",
      reply_markup:folderSummaryKeyboard(d.id,all.length,0)
    });
  }

  if(offset>=all.length) return;

  const batch=all.slice(offset,offset+10);
  let sent=0;
  for(const item of batch) {
    try {
      await sendIndexedResource(token,chatId,item);
      sent++;
    } catch(e) {
      console.error("FOLDER BATCH SEND:",e.message,"chat=",chatId,"resource=",item.messageId);
    }
    await sleep(80);
  }

  const next=Math.min(offset+10,all.length);
  return tg(token,"editMessageText",{
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
    console.error("❌ CHILD START FAILED:", child.username ? "@" + child.username : "(unknown)", e.message);
    await sleep(5000);
    return childLoop(child);
  }

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
function startChild(child){ childLoop(child).catch(e=>{ console.error("❌ CHILD FATAL:",child.username ? "@"+child.username : child.botId,e); setTimeout(()=>startChild(child),5000); }); }

async function boot(){
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  saveDb();

  if (!TOKEN) {
    runtime.lastError = "BOT_TOKEN 未配置";
    console.error("❌ BOT_TOKEN 未配置，等待环境变量后自动重试");
  }

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