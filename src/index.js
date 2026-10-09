import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";
import { createWebDavClient } from "./cloud123.js";
import { initializeMySQL, persistMySQL, flushMySQL, isMySQLReady } from "../mysql-store.js";

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}
loadEnvFile();

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
const BACKUP_SNAPSHOT_DIR = process.env.DATA_BACKUP_DIR || (path.dirname(DATA_FILE) + "/backups");
const LOCAL_TABLE_DIR = process.env.LOCAL_TABLE_DIR || path.dirname(DATA_FILE);
const LOCAL_RESOURCES_TABLE = path.join(LOCAL_TABLE_DIR, "resources.csv");
const LOCAL_DIRECTORIES_TABLE = path.join(LOCAL_TABLE_DIR, "directories.csv");
const SECRET = process.env.STORAGE_KEY || "telegram-clone-platform-v2";
const MAX_RESOURCES = Number(process.env.MAX_RESOURCES || 20000);
const UPLOAD_IDLE_SECONDS = Math.max(60, Number(process.env.UPLOAD_IDLE_SECONDS || 300));
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
    mysql: { enabled: Boolean(process.env.DB_HOST || process.env.DATABASE_URL), connected: isMySQLReady() },
    dataFileExists: fs.existsSync(DATA_FILE),
    backupFileExists: fs.existsSync(BACKUP_FILE),
    baserow: {
      enabled: baserow.enabled,
      connected: baserow.connected,
      tableId: GOOGLE_SHEETS_ID || null,
      tokenConfigured: Boolean(GOOGLE_SHEETS_CREDENTIAL),
      permissionHint: baserow.lastError && /TABLE_PERMISSION_DENIED|没有表 .*权限/.test(baserow.lastError) ? "请检查 Google Sheets 数据库令牌的表权限" : null,
      lastOkAt: baserow.lastOkAt ? new Date(baserow.lastOkAt).toISOString() : null,
      lastError: baserow.lastError || null
    }
  };
}


function systemHealthText(){
  const now=Date.now();
  const rs=repo();
  const auto=db.settings?.repositoryAutoSync||{};
  const history=db.settings?.historyAuth||{};
  const memory=process.memoryUsage();
  const rss=(memory.rss/1024/1024).toFixed(1);
  const heap=(memory.heapUsed/1024/1024).toFixed(1);
  const uptime=Math.floor((now-runtime.startedAt)/1000);
  const hh=String(Math.floor(uptime/3600)).padStart(2,"0");
  const mm=String(Math.floor((uptime%3600)/60)).padStart(2,"0");
  const ss=String(uptime%60).padStart(2,"0");
  const lines=[
    "<b>🩺 系统健康检查</b>",
    "━━━━━━━━━━━━━━",
    "",
    "🤖 Telegram： "+(runtime.mainConnected?"✅ 正常":"⚠️ 未确认"),
    "💾 本地数据库： "+(fs.existsSync(DATA_FILE)?"✅ 正常":"❌ 缺失"),
    "🗂️ 本地备份： "+(fs.existsSync(BACKUP_FILE)?"✅ 正常":"❌ 缺失"),
    "🗄️ MySQL： "+(isMySQLReady()?"✅ 已连接":"⚪ 未启用/未连接"),
    "📊 Google Sheets： "+(baserow.connected?"✅ 已连接":(baserow.enabled?"⚠️ 已配置但未连接":"⚪ 未启用")),
    "🔐 扫描账号： "+(history.session?"✅ 已授权":"⚪ 未授权"),
    "📦 资源仓库： "+(rs?.chatId?"✅ 已绑定":"⚠️ 未绑定"),
    "⚡ 自动同步： "+(auto.sourceId&&auto.targetId?(auto.enabled?"🟢 运行中":"⏸️ 已绑定未运行"):"⚪ 未绑定"),
    "📚 资源： "+(Array.isArray(db.resources)?db.resources.length:0).toLocaleString(),
    "📁 文件夹： "+(Array.isArray(db.directories)?db.directories.length:0).toLocaleString(),
    "👥 用户： "+(Array.isArray(db.users)?db.users.length:0).toLocaleString(),
    "🧠 内存： RSS "+rss+" MB / Heap "+heap+" MB",
    "⏱️ 运行时间： "+hh+":"+mm+":"+ss
  ];
  if(runtime.lastError) lines.push("⚠️ 最近错误： "+escapeHtml(String(runtime.lastError).slice(0,300)));
  if(baserow.lastError) lines.push("⚠️ Google： "+escapeHtml(String(baserow.lastError).slice(0,300)));
  return lines.join("\\n");
}

function callbackSelfCheck(){
  try{
    const source=fs.readFileSync(new URL(import.meta.url),"utf8");
    const seen=new Map();
    for(const m of source.matchAll(/callback_data\\s*:\\s*["']([^"']+)["']/g)){
      const value=String(m[1]);
      seen.set(value,(seen.get(value)||0)+1);
    }
    const duplicates=[...seen.entries()].filter(([,count])=>count>1).sort((a,b)=>b[1]-a[1]);
    console.log("🧪 CALLBACK SELF-CHECK: unique="+seen.size+" duplicate="+duplicates.length);
    if(duplicates.length) console.warn("⚠️ 重复 callback_data:",duplicates.slice(0,20));
    const required=["admin:health","adm:cloud_account","adm:auto_add","adm:auto_start"];
    for(const value of required){
      const explicit =
        source.includes('data==="'+value+'"') ||
        source.includes('data.startsWith("'+value+'")') ||
        (value==="adm:auto_add" && source.includes('route==="auto_add"')) ||
        (value==="adm:auto_start" && source.includes('route==="auto_start"'));
      if(!explicit){
        console.warn("⚠️ CALLBACK ROUTE CHECK: 未找到显式路由 "+value);
      }
    }
  }catch(e){ console.warn("⚠️ CALLBACK SELF-CHECK 失败:",String(e?.message||e)); }
}
callbackSelfCheck();

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
// Google Sheets 连接检查仅在机器人启动完成后异步执行，不阻塞主进程启动。
Promise.resolve().then(() => checkGoogleSheetsConnection()).catch(e => console.error("GOOGLE SHEETS CHECK:", e.message));

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
// Telegram API 长连接复用：减少每次按钮/消息都重新建立 TLS 连接的耗时。
const telegramHttpsAgent = new https.Agent({keepAlive:true,maxSockets:50,maxFreeSockets:10,keepAliveMsecs:1000});
async function telegramHttpsRequest(token, method, body, timeoutMs) {
  const payload = JSON.stringify(body || {});
  return await new Promise((resolve, reject) => {
    const req = https.request(
      api(token, method),
      {
        method: "POST",
        family: 4,
        timeout: timeoutMs,
        agent: telegramHttpsAgent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "accept": "application/json"
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
    const msg = String(e?.telegramDescription || e?.message || e);
    // "message is not modified" means the current progress is already correct.
    // Do not send a fallback message here: that would create duplicate progress messages.
    if (/message is not modified/i.test(msg)) return null;
    if (/message.*(can't|cannot).*edit|MESSAGE_ID_INVALID|message to edit not found/i.test(msg)) {
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
          console.warn("⚠️ 备用进度消息发送失败，继续任务：", String(sendErr?.telegramDescription || sendErr?.message || sendErr));
        }
      }
      return null;
    }
    throw e;
  }
}

async function tg(token, method, body = {}) {
  // 统一处理所有 Telegram 文本，避免任何直连 tg() 的消息把 \\n 或 /n 原样发给用户。
  if(body && typeof body==="object"){
    body={...body};
    if(typeof body.text==="string") body.text=prettyText(body.text);
    if(typeof body.caption==="string") body.caption=prettyText(body.caption);
  }
  // 按钮确认有严格时效：Telegram 的 callback 查询很快过期，
  // 对它反复网络重试只会让用户一直看到转圈；其他 API 保持原有重试策略。
  const isCallbackAck = method === "answerCallbackQuery";
  const maxAttempts = method === "getUpdates" ? 8 : (isCallbackAck ? 1 : 4);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const timeoutMs = method === "getUpdates" ? 50000 : (isCallbackAck ? 5000 : 20000);
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

// ===== Google Sheets 共享资源中心（替代旧 Baserow） =====
function readEnvFirst(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

const GOOGLE_SHEETS_ID = readEnvFirst("GOOGLE_SHEETS_ID") || "1-7f_dKaSU66sbftuT2RM1ctf5-VY6KLxU1AJhGmI8D8";
const GOOGLE_SHEETS_TAB = readEnvFirst("GOOGLE_SHEETS_TAB") || "Sheet1";
const GOOGLE_SHEETS_WEBHOOK_URL = readEnvFirst("GOOGLE_SHEETS_WEBHOOK_URL");
const GOOGLE_SERVICE_ACCOUNT_JSON = readEnvFirst(
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT"
);
function readGoogleServiceAccountB64Parts() {
  const parts = [];
  for (const [name, value] of Object.entries(process.env)) {
    const m = /^GOOGLE_SERVICE_ACCOUNT_B64_(\d+)$/i.exec(name);
    if (!m) continue;
    const part = String(value ?? "").trim();
    if (part) parts.push({ index: Number(m[1]), value: part });
  }
  parts.sort((a, b) => a.index - b.index);
  return parts.map(x => x.value).join("");
}

const GOOGLE_SERVICE_ACCOUNT_B64 = readEnvFirst(
  "GOOGLE_SERVICE_ACCOUNT_B64",
  "GOOGLE_SERVICE_ACCOUNT_BASE64",
  "GOOGLE_SERVICE_ACCOUNT_KEY_B64",
  "GOOGLE_SA_B64"
) || readGoogleServiceAccountB64Parts();
const GOOGLE_SERVICE_ACCOUNT_B64_PARTS = Object.keys(process.env)
  .filter(k => /^GOOGLE_SERVICE_ACCOUNT_B64_\d+$/i.test(k))
  .sort((a, b) => Number(a.match(/\d+$/)?.[0] || 0) - Number(b.match(/\d+$/)?.[0] || 0));
const GOOGLE_ACCESS_TOKEN = readEnvFirst("GOOGLE_ACCESS_TOKEN");
const GOOGLE_SHEETS_CREDENTIAL = GOOGLE_SHEETS_WEBHOOK_URL || GOOGLE_ACCESS_TOKEN || GOOGLE_SERVICE_ACCOUNT_JSON || GOOGLE_SERVICE_ACCOUNT_B64;

const googleEnvKeys = Object.keys(process.env)
  .filter(k => /^GOOGLE_/i.test(k))
  .map(k => k + "=" + (String(process.env[k] ?? "").trim() ? ("已配置(" + String(process.env[k]).trim().length + " chars)") : "空值"));

console.log("🔐 GOOGLE SHEETS ENV:", {
  webhook: GOOGLE_SHEETS_WEBHOOK_URL ? "已配置" : "❌ 未配置",
  sheetId: GOOGLE_SHEETS_ID ? "已配置" : "❌ 未配置",
  tab: GOOGLE_SHEETS_TAB || "Sheet1",
  serviceAccountJson: GOOGLE_SERVICE_ACCOUNT_JSON ? "已配置" : "❌ 未配置",
  serviceAccountB64: GOOGLE_SERVICE_ACCOUNT_B64
    ? (GOOGLE_SERVICE_ACCOUNT_B64_PARTS.length
      ? "已配置(" + GOOGLE_SERVICE_ACCOUNT_B64.length + " chars, " + GOOGLE_SERVICE_ACCOUNT_B64_PARTS.length + " 段)"
      : "已配置(" + GOOGLE_SERVICE_ACCOUNT_B64.length + " chars)")
    : "❌ 未配置",
  accessToken: GOOGLE_ACCESS_TOKEN ? "已配置" : "未配置",
  detectedGoogleEnvKeys: googleEnvKeys
});

const baserow = {
  enabled: Boolean(GOOGLE_SHEETS_ID && GOOGLE_SHEETS_CREDENTIAL),
  connected: false,
  lastError: "",
  lastOkAt: 0
};

function parseGoogleServiceAccount() {
  // 优先支持直接拆开的服务账号字段，避免 FadeHost 2000 字符限制导致 Base64 私钥被破坏。
  const directEmail = readEnvFirst("GOOGLE_CLIENT_EMAIL");
  const directKey = String(process.env.GOOGLE_PRIVATE_KEY || "").trim();
  if (directEmail && directKey) {
    const x = {
      client_email: directEmail,
      private_key: directKey.replace(/\\n/g, "\n")
    };
    if (!x.private_key.includes("BEGIN PRIVATE KEY")) {
      throw new Error("GOOGLE_PRIVATE_KEY 格式异常");
    }
    return x;
  }

  let raw=GOOGLE_SERVICE_ACCOUNT_JSON;
  if(!raw && GOOGLE_SERVICE_ACCOUNT_B64){
    try {
      // 所有编号分段必须先按数字顺序拼接，再只解码一次。
      const encoded=GOOGLE_SERVICE_ACCOUNT_B64.replace(/\\s+/g,"");
      raw=Buffer.from(encoded,"base64").toString("utf8");
    } catch(e) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 解码失败："+String(e?.message||e));
    }
  }
  if(!raw) return null;
  try {
    const x=JSON.parse(raw);
    if(!x.client_email || !x.private_key) throw new Error("服务账号缺少 client_email/private_key");
    if(!String(x.private_key).includes("BEGIN PRIVATE KEY")) throw new Error("private_key 格式异常");
    // JSON.parse 后再处理转义换行，绝不能在 JSON.parse 前替换。
    x.private_key=String(x.private_key).replace(/\\n/g, "\n");
    return x;
  } catch(e) {
    throw new Error("Google 服务账号 JSON 无效："+String(e?.message||e));
  }
}
let googleAccessTokenCache={token:"",expiresAt:0};

function base64url(value){
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buf.toString("base64").replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
}
async function getGoogleAccessToken(){
  if(GOOGLE_ACCESS_TOKEN) return GOOGLE_ACCESS_TOKEN;
  if(googleAccessTokenCache.token && googleAccessTokenCache.expiresAt>Date.now()+60000) return googleAccessTokenCache.token;
  const sa=parseGoogleServiceAccount();
  if(!sa) throw new Error("未配置 GOOGLE_SERVICE_ACCOUNT_JSON/B64 或 GOOGLE_ACCESS_TOKEN");
  const now=Math.floor(Date.now()/1000);
  const header=base64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=base64url(JSON.stringify({
    iss:sa.client_email,
    scope:"https://www.googleapis.com/auth/spreadsheets",
    aud:"https://oauth2.googleapis.com/token",
    iat:now,
    exp:now+3600
  }));
  const signer=crypto.createSign("RSA-SHA256");
  signer.update(header+"."+claim);
  signer.end();
  const assertion=header+"."+claim+"."+base64url(signer.sign(sa.private_key));
  const r=await fetch("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion}).toString()
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok || !data.access_token) throw new Error("Google 授权失败："+String(data.error_description||data.error||"unknown"));
  googleAccessTokenCache={token:data.access_token,expiresAt:Date.now()+Number(data.expires_in||3600)*1000};
  return data.access_token;
}

async function googleAppsScriptRequest(payload){
  if(!GOOGLE_SHEETS_WEBHOOK_URL) throw new Error("Google Apps Script Webhook 未配置 GOOGLE_SHEETS_WEBHOOK_URL");
  const r=await fetch(GOOGLE_SHEETS_WEBHOOK_URL,{
    method:"POST",
    headers:{"content-type":"application/json","accept":"application/json"},
    body:JSON.stringify(payload||{}),
    redirect:"follow"
  });
  const text=await r.text();
  let data={};
  try{ data=JSON.parse(text||"{}"); }catch{}
  const bodyText = String(text||"");
  if(!r.ok || data?.ok===false || bodyText.trim().startsWith("<")) {
    const brief = bodyText.trim().startsWith("<") ? "返回了网页而不是接口数据" : String(data?.error||bodyText||"请求失败");
    throw new Error("Google Apps Script "+(r.status||0)+": "+brief.slice(0,180));
  }
  return data;
}

const GOOGLE_SHEETS_API="https://sheets.googleapis.com/v4/spreadsheets/";
function sheetNameRange(suffix=""){
  return encodeURIComponent("'"+GOOGLE_SHEETS_TAB.replace(/'/g,"''")+"'"+suffix);
}
async function googleSheetsRequest(method,pathName,body){
  const maxAttempts=4;
  for(let attempt=0;attempt<maxAttempts;attempt++){
    try{
      const token=await getGoogleAccessToken();
      const url=GOOGLE_SHEETS_API+encodeURIComponent(GOOGLE_SHEETS_ID)+pathName;
      const headers={"Authorization":"Bearer "+token,"Accept":"application/json"};
      if(body!==undefined) headers["Content-Type"]="application/json";
      const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const text=await r.text();
      let data={}; try{data=JSON.parse(text||"{}");}catch{}
      if(r.ok) return data;
      const retryAfter=Number(r.headers.get("retry-after")||0);
      const transient=r.status===429||r.status>=500;
      if(!transient||attempt>=maxAttempts-1){
        throw new Error("Google Sheets "+r.status+": "+String(data?.error?.message||text||"请求失败").slice(0,500));
      }
      const wait=Math.min(15000,Math.max(1000,retryAfter*1000||1000*Math.pow(2,attempt)));
      console.warn("⏳ Google Sheets 暂时限流/服务异常，"+wait+"ms 后重试:",method);
      await sleep(wait);
    }catch(e){
      if(attempt>=maxAttempts-1) throw e;
      if(/Google Sheets 4(?!29)\d/.test(String(e?.message||""))) throw e;
      await sleep(Math.min(10000,1000*Math.pow(2,attempt)));
    }
  }
  throw new Error("Google Sheets 请求失败");
}

const DEFAULT_SHEET_FIELDS=["名称","文件夹","类型","网址","标签","上传日期","所有者","聊天ID","消息ID","描述","文件ID","下载"];

async function ensureGoogleSheetHeaders(){
  if(GOOGLE_SHEETS_WEBHOOK_URL && !GOOGLE_SERVICE_ACCOUNT_JSON && !GOOGLE_SERVICE_ACCOUNT_B64){
    const data=await googleAppsScriptRequest({action:"get"});
    const headers=Array.isArray(data?.headers)?data.headers.map(x=>String(x??"").trim()).filter(Boolean):[];
    if(headers.length) return headers;
    // Apps Script 当前接口会按 data 的键自动创建第一行表头；空值不会产生资源记录。
    const dataObject={};
    for(const name of DEFAULT_SHEET_FIELDS) dataObject[name]="";
    await googleAppsScriptRequest({action:"append",data:dataObject});
    const created=await googleAppsScriptRequest({action:"get"});
    return Array.isArray(created?.headers)&&created.headers.length ? created.headers : [...DEFAULT_SHEET_FIELDS];
  }
  const range=sheetNameRange("!1:1");
  const data=await googleSheetsRequest("GET","/values/"+range+"?majorDimension=ROWS");
  const headers=Array.isArray(data.values?.[0])?data.values[0].map(x=>String(x??"").trim()):[];
  if(headers.length) return headers;
  const writeRange="'"+GOOGLE_SHEETS_TAB+"'!A1:"+String.fromCharCode(64+DEFAULT_SHEET_FIELDS.length)+"1";
  await googleSheetsRequest("PUT","/values/"+encodeURIComponent(writeRange)+"?valueInputOption=USER_ENTERED",{
    range:writeRange,majorDimension:"ROWS",values:[DEFAULT_SHEET_FIELDS]
  });
  return [...DEFAULT_SHEET_FIELDS];
}

async function getGoogleSheetHeaders(force=false){
  if(baserowFieldsCache && !force) return baserowFieldsCache;
  const headers=await ensureGoogleSheetHeaders();
  baserowFieldsCache=headers.map((name,i)=>({id:i+1,name,type:"text",read_only:false,index:i}));
  return baserowFieldsCache;
}

async function ensureGoogleSheetField(name){
  const fields=await getGoogleSheetHeaders(true);
  if(fields.some(f=>baserowNormName(f.name)===baserowNormName(name))) return fields;
  const headers=fields.map(f=>f.name);
  headers.push(name);
  const endCol=String.fromCharCode(64+headers.length);
  const writeRange="'"+GOOGLE_SHEETS_TAB+"'!A1:"+endCol+"1";
  await googleSheetsRequest("PUT","/values/"+encodeURIComponent(writeRange)+"?valueInputOption=USER_ENTERED",{
    range:writeRange,majorDimension:"ROWS",values:[headers]
  });
  return getGoogleSheetHeaders(true);
}

async function checkGoogleSheetsConnection(){
  if(!GOOGLE_SHEETS_ID){
    baserow.enabled=false;
    baserow.connected=false;
    baserow.lastError="未配置 GOOGLE_SHEETS_ID";
    console.error("❌ Google Sheets 配置缺失：GOOGLE_SHEETS_ID");
    return false;
  }
  if(!GOOGLE_SHEETS_CREDENTIAL){
    baserow.enabled=false;
    baserow.connected=false;
    baserow.lastError="未配置 GOOGLE_SHEETS_WEBHOOK_URL 或旧版 Google 凭据";
    console.error("❌ Google Sheets 配置缺失：未读取到共享接口。");
    return false;
  }
  try{
    if(GOOGLE_SHEETS_WEBHOOK_URL && !GOOGLE_SERVICE_ACCOUNT_JSON && !GOOGLE_SERVICE_ACCOUNT_B64){
      console.log("🔗 Google Apps Script:", "已配置");
    } else if(!GOOGLE_ACCESS_TOKEN){
      const sa=parseGoogleServiceAccount();
      console.log("🔐 Google 服务账号:", sa?.client_email ? "已读取("+sa.client_email+")" : "❌ 无法读取");
    }
    await ensureGoogleSheetHeaders();
    baserow.enabled=true; baserow.connected=true; baserow.lastError=""; baserow.lastOkAt=Date.now();
    console.log("📊 Google Sheets: 已连接，sheet="+GOOGLE_SHEETS_ID+" tab="+GOOGLE_SHEETS_TAB);
    return true;
  }catch(e){
    baserow.enabled=true; baserow.connected=false; baserow.lastError=String(e?.message||e);
    console.error("❌ Google Sheets 连接失败:",baserow.lastError);
    return false;
  }
}

// 兼容现有业务函数名；实际数据已经完全改由 Google Sheets 提供。
const BASEROW_TOKEN = GOOGLE_SHEETS_CREDENTIAL;
const BASEROW_TABLE_ID = GOOGLE_SHEETS_ID;
async function checkBaserowConnection(){ return checkGoogleSheetsConnection(); }

async function baserowRequest(method,pathName,body){
  if(!GOOGLE_SHEETS_ID) throw new Error("Google Sheets 未配置 GOOGLE_SHEETS_ID");
  if(!GOOGLE_SHEETS_CREDENTIAL) throw new Error("Google Sheets 未配置共享接口");

  if(GOOGLE_SHEETS_WEBHOOK_URL && !GOOGLE_SERVICE_ACCOUNT_JSON && !GOOGLE_SERVICE_ACCOUNT_B64){
    if(pathName.includes("/fields/table/")){
      if(method==="GET"){
        const data=await googleAppsScriptRequest({action:"get"});
        const headers=Array.isArray(data?.headers)?data.headers:[];
        return headers.map((name,i)=>({id:i+1,name:String(name),type:"text",read_only:false,index:i}));
      }
      if(method==="POST"){
        // 现有 Apps Script 会在首次 append 时自动补齐缺失表头。
        const name=String(body?.name||"").trim();
        if(!name) throw new Error("Google Sheets 字段名称为空");
        const data=await googleAppsScriptRequest({action:"append",data:{[name]:""}});
        return {name,type:"text",read_only:false};
      }
    }

    if(pathName.includes("/rows/table/")){
      if(method==="GET"){
        const data=await googleAppsScriptRequest({action:"get"});
        const rows=Array.isArray(data?.rows)?data.rows:[];
        return {
          results: rows.map(row=>{
            const out={};
            Object.keys(row||{}).forEach(k=>{
              if(k!=="_row") out[k]=row[k];
            });
            out.id=Number(row?._row||0);
            return out;
          }),
          next:null
        };
      }

      const rowMatch=pathName.match(/\/rows\/table\/[^/]+\/(\d+)/);
      const rowNumber=rowMatch?Number(rowMatch[1]):0;

      if(method==="POST"){
        const data=await googleAppsScriptRequest({action:"append",data:body||{}});
        return {...(body||{}),id:Number(data?.row||0)||null};
      }

      if(method==="PATCH" && rowNumber>1){
        const data=await googleAppsScriptRequest({action:"update",row:rowNumber,data:body||{}});
        return {...(body||{}),id:Number(data?.row||rowNumber)};
      }

      if(method==="DELETE" && rowNumber>1){
        await googleAppsScriptRequest({action:"delete",row:rowNumber});
        return {};
      }
    }

    throw new Error("Google Sheets 未支持的共享数据操作: "+method+" "+pathName);
  }

  if(pathName.includes("/fields/table/")){
    if(method==="GET") return (await getGoogleSheetHeaders()).map(f=>({...f}));
    if(method==="POST"){
      const name=String(body?.name||"").trim();
      if(!name) throw new Error("Google Sheets 字段名称为空");
      await ensureGoogleSheetField(name);
      return {name,type:"text",read_only:false};
    }
  }

  const valueRange=encodeURIComponent("'"+GOOGLE_SHEETS_TAB.replace(/'/g,"''")+"'");
  if(method==="GET" && pathName.includes("/rows/table/")){
    const data=await googleSheetsRequest("GET","/values/"+valueRange+"?majorDimension=ROWS");
    const values=Array.isArray(data.values)?data.values:[];
    const headers=values[0]||[];
    const results=[];
    for(let i=1;i<values.length;i++){
      const row=values[i]||[];
      if(!row.some(v=>String(v??"").trim())) continue;
      const obj={id:i+1};
      headers.forEach((h,j)=>{if(String(h||"").trim()) obj[h]=row[j]??"";});
      results.push(obj);
    }
    return {results,next:null};
  }

  const rowMatch=pathName.match(/\/rows\/table\/[^/]+\/(\d+)/);
  const rowNumber=rowMatch?Number(rowMatch[1]):0;

  if(method==="POST" && pathName.includes("/rows/table/")){
    const fields=await getGoogleSheetHeaders();
    const row=fields.map(f=>body?.[f.name]===undefined?"":String(body[f.name]));
    const append=await googleSheetsRequest("POST","/values/"+valueRange+"!A:Z:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",{
      majorDimension:"ROWS",values:[row]
    });
    const updatedRange=String(append?.updates?.updatedRange||"");
    const m=updatedRange.match(/!.*?(\d+):/);
    const id=m?Number(m[1]):null;
    return {...body,id};
  }

  if(method==="PATCH" && rowNumber>1){
    const fields=await getGoogleSheetHeaders();
    const currentData=await googleSheetsRequest("GET","/values/"+encodeURIComponent("'"+GOOGLE_SHEETS_TAB+"'!A"+rowNumber+":Z"+rowNumber)+"?majorDimension=ROWS");
    const current=currentData.values?.[0]||[];
    const row=fields.map((f,i)=>body?.[f.name]===undefined?(current[i]??""):String(body[f.name]));
    const endCol=String.fromCharCode(64+fields.length);
    const writeRange="'"+GOOGLE_SHEETS_TAB+"'!A"+rowNumber+":"+endCol+rowNumber;
    await googleSheetsRequest("PUT","/values/"+encodeURIComponent(writeRange)+"?valueInputOption=USER_ENTERED",{
      range:writeRange,majorDimension:"ROWS",values:[row]
    });
    return {...body,id:rowNumber};
  }

  if(method==="DELETE" && rowNumber>1){
    const clearRange="'"+GOOGLE_SHEETS_TAB+"'!A"+rowNumber+":Z"+rowNumber;
    await googleSheetsRequest("POST","/values/"+encodeURIComponent(clearRange)+":clear",{});
    return {};
  }

  throw new Error("Google Sheets 未支持的共享数据操作: "+method+" "+pathName);
}

// Google Sheets 资源同步：扫描/监听到资源后自动写入资源表。
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
    "/api/database/fields/table/" + encodeURIComponent(GOOGLE_SHEETS_ID) + "/"
  );
  baserowFieldsCache = Array.isArray(fields) ? fields : [];
  console.log("📊 Google Sheets 字段:", baserowFieldsCache.map(x => x.name).join(" | "));
  return baserowFieldsCache;
}

async function ensureBaserowRecoveryFields() {
  if(!GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID) return [];
  const required=[
    {name:"文件夹",type:"text"},
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
        "/api/database/fields/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/",
        {name:spec.name,type:spec.type}
      );
      created.push(field);
      console.log("🛠️ Google Sheets 自动创建字段:",spec.name);
      fields=await getBaserowFields(true);
    }catch(e){
      console.warn("⚠️ Google Sheets 无法自动创建字段「"+spec.name+"」：",String(e?.message||e));
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
    console.log("✅ Google Sheets 恢复字段检查完成：",created.map(x=>x?.name).filter(Boolean).join("、"));
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
  // Google Sheets 单选/多选字段必须使用表格中已经存在的选项，不能直接写入任意字符串。
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
  if (!GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID || !item) return;
  try {
    const fields = await getBaserowFields();
    if (!fields.length) throw new Error("Google Sheets 表没有可用字段");

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
    if (!primary) throw new Error("Google Sheets 没有可写的文本字段，请在表格增加“资源名称”字段");

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

    // 优先使用本地保存的 Google Sheets 行 ID；如果本地没有，使用共享缓存按 chatId+messageId 查找。
    if (!item.baserowRowId) {
      const key=String(item.chatId)+":"+String(item.messageId);
      const cached=baserowRowsCache.get(key);
      if(cached?.id) item.baserowRowId=cached.id;
    }
    if (item.baserowRowId) {
      try {
        const updated = await baserowRequest(
          "PATCH",
          "/api/database/rows/table/" + encodeURIComponent(GOOGLE_SHEETS_ID) + "/" + encodeURIComponent(item.baserowRowId) + "/?user_field_names=true",
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
      "/api/database/rows/table/" + encodeURIComponent(GOOGLE_SHEETS_ID) + "/?user_field_names=true",
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
    console.error("❌ Google Sheets 资源同步失败:", baserow.lastError);
    return null;
  }
}

async function runSheetWrite(job) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sleep(2000);
      return await job();
    } catch (e) {
      const message = String(e?.message || e);
      if (!/429|Quota exceeded|限流/.test(message) || attempt === 3) throw e;
      console.warn("⏳ Google Sheets 写入限流，60 秒后重试", attempt + "/3");
      await sleep(60000);
    }
  }
}
function queueBaserowResourceSync(item) {
  if (!GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID || !item) return;
  baserowSyncQueue = baserowSyncQueue
    .then(() => runSheetWrite(() => baserowSyncResource(item)))
    .catch(e => console.error("❌ Google Sheets 同步队列:", e.message));
}

async function waitBaserowSyncQueue() {
  await baserowSyncQueue;
}

/* ===== 共享资源中心：Google Sheets 作为唯一共享数据源 ===== */
let baserowRowsCache = new Map();
let sharedRefreshAt = 0;
let sharedRefreshPromise = null;
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
      "/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/?user_field_names=true&size=200&page="+page
    );
    const part=Array.isArray(data?.results)?data.results:[];
    rows.push(...part);
    if(!data?.next || part.length<200) break;
  }
  return rows;
}


async function baserowSyncDirectory(directory) {
  if(!GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID || !directory) return;
  try {
    console.log("📁 Google Sheets 文件夹同步:", String(directory.name||""), "id="+String(directory.id||""));
    const fields=await getBaserowFields();
    const titleField=baserowPickField(fields,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"]);
    const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
    const messageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
    const chatField=baserowPickField(fields,["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
    const primary=titleField || fields.find(f=>!f.read_only && ["text","long_text"].includes(String(f.type||"")));
    if(!primary || !folderField) throw new Error("Google Sheets 缺少可用于共享文件夹的“资源名称/文件夹”字段");

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
      await baserowRequest("PATCH","/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/"+existing.id+"/?user_field_names=true",payload);
      baserowRowsCache.set("folder:"+directory.id,{...existing,...payload});
    } else {
      const created=await baserowRequest("POST","/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/?user_field_names=true",payload);
      baserowRowsCache.set("folder:"+directory.id,created);
    }
    baserow.connected=true; baserow.lastOkAt=Date.now(); baserow.lastError="";
  } catch(e) {
    baserow.lastError=String(e?.message||e);
    console.error("❌ Google Sheets 文件夹同步失败:",baserow.lastError);
  }
}

function queueBaserowDirectorySync(directory) {
  if(!GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID || !directory) return;
  // 文件夹必须优先于资源批量写入，否则历史扫描/迁移后的大量资源会把目录同步堵住。
  baserowDirectorySyncQueue=baserowDirectorySyncQueue
    .then(() => runSheetWrite(() => baserowSyncDirectory(directory)))
    .catch(e=>console.error("❌ Google Sheets 文件夹队列:",e.message));
}

async function waitBaserowDirectorySyncQueue() {
  await baserowDirectorySyncQueue;
}

async function baserowDeleteRow(rowId) {
  if(!rowId || !GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID) return;
  try {
    await baserowRequest("DELETE","/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/"+encodeURIComponent(rowId)+"/");
    baserowRowsCache.delete(String(rowId));
  } catch(e) {
    console.warn("⚠️ Google Sheets 删除行失败:",String(e?.message||e));
  }
}

function queueBaserowDeleteResource(item) {
  if(!item || !GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID) return;
  const rowId=item.baserowRowId;
  if(!rowId) return;
  baserowSyncQueue=baserowSyncQueue.then(()=>baserowDeleteRow(rowId)).catch(e=>console.error("❌ Google Sheets 删除队列:",e.message));
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
      throw new Error("Google Sheets 恢复需要字段：文件夹。请在表中保留“文件夹”字段。");
    }
    if((!chatField || !messageField) && !urlField) {
      const missing=[!chatField?"聊天ID":"",!messageField?"消息ID":""].filter(Boolean).join("、");
      throw new Error("Google Sheets 恢复需要字段："+missing+"。当前表也没有“网址/链接”字段可用于兼容恢复。");
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
            "/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/"+encodeURIComponent(u.id)+"/?user_field_names=true",
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
      "📦 Google Sheets 资源行：<b>"+rows.length+"</b>\n"+
      "📁 当前文件夹：<b>"+db.directories.length+"</b>\n"+
      "♻️ 找回文件夹关联：<b>"+found+"</b>\n"+
      "🔗 网址兼容恢复：<b>"+urlRecovered+"</b>\n"+
      "💾 已写回 Google Sheets：<b>"+written+"</b>\n"+
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
        await baserowRequest("PATCH","/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/"+encodeURIComponent(u.id)+"/?user_field_names=true",u.payload);
        done++;
      } catch(e) {
        console.warn("⚠️ Google Sheets 文件夹回填失败 row="+u.id+":",String(e?.message||e));
      }
    }));
  }
  if(done) console.log("📁 Google Sheets 文件夹关联回填完成："+done+" 条");
  return done;
}

async function pullBaserowSharedData() {
  // Google Sheets is a one-way backup only. Never import rows into the live JSON database.
  console.log("ℹ️ Google Sheets 仅作为备份，本次跳过远端读取；运行数据以 JSON 为准。");
  return false;
}

async function initializeSharedBaserow() {
  if(!GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID) {
    console.log("ℹ️ Google Sheets 备份未配置；继续以 JSON 为主数据库运行。");
    return;
  }
  try {
    const connected = await checkGoogleSheetsConnection();
    if(!connected) {
      console.warn("⚠️ Google Sheets 备份不可用；不影响 JSON 主数据库和机器人运行：", baserow.lastError || "");
      return;
    }
    await ensureBaserowRecoveryFields();
    normalizeSharedDirectories();

    // 只读取 Google Sheets 的行 ID/消息键用于避免重复插入；不把表格内容导入或覆盖 JSON。
    const fields=await getBaserowFields(true);
    const rows=await listAllBaserowRows();
    baserowRowsCache=new Map();
    const chatField=baserowPickField(fields,["聊天ID","群组ID","频道ID","Chat ID","ChatID"]);
    const messageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
    const urlField=baserowPickField(fields,["网址","链接","链接地址","URL","Url","Link"]);
    for(const row of rows) {
      if(!row?.id) continue;
      baserowRowsCache.set(String(row.id),row);
      const title=String(row?.[baserowPickField(fields,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"])?.name]||"");
      const folderMatch=title.match(/^__FOLDER__:(dir_[^:]+):/);
      if(folderMatch) baserowRowsCache.set("folder:"+folderMatch[1],row);
      let chat=chatField?String(row?.[chatField.name]??"").trim():"";
      let message=messageField?Number(row?.[messageField.name]??0):0;
      if((!chat || !Number.isFinite(message) || message<=0) && urlField) {
        const url=String(row?.[urlField.name]??"");
        let m=url.match(/t\.me\/c\/(\d+)\/(\d+)/i);
        if(m) { chat="-100"+m[1]; message=Number(m[2]); }
        else {
          m=url.match(/t\.me\/([A-Za-z0-9_]{3,})\/(\d+)/i);
          if(m) { chat="@"+m[1]; message=Number(m[2]); }
        }
      }
      if(chat && Number.isFinite(message) && message>0) {
        baserowRowsCache.set(chat+":"+message,row);
        baserowRowsCache.set(String(chat).replace(/^-100/,"")+":"+message,row);
      }
    }
    for(const item of (Array.isArray(db.resources)?db.resources:[])) {
      if(item?.baserowRowId) continue;
      const key=String(item?.chatId||"")+":"+Number(item?.messageId||0);
      const row=baserowRowsCache.get(key) || baserowRowsCache.get(String(item?.chatId||"").replace(/^-100/,"")+":"+Number(item?.messageId||0));
      if(row?.id) item.baserowRowId=row.id;
    }

    // 单向：只把 JSON 中现有目录和资源写入 Google Sheets；不从表格导入/覆盖 JSON。
    for(const directory of (Array.isArray(db.directories)?db.directories:[])) {
      queueBaserowDirectorySync(directory);
    }
    for(const item of (Array.isArray(db.resources)?db.resources:[])) {
      queueBaserowResourceSync(item);
    }
    await waitBaserowDirectorySyncQueue();
    await waitBaserowSyncQueue();
    console.log("✅ Google Sheets 单向备份初始化完成：JSON 目录="+db.directories.length+"，资源="+db.resources.length);
  } catch(e) {
    baserow.connected=false;
    baserow.lastError=String(e?.message||e);
    console.warn("⚠️ Google Sheets 备份初始化失败，不影响 JSON 主库：",baserow.lastError);
  }
}

function requestSharedDataRefresh(){
  if(globalThis.__sharedRefreshTimer) clearTimeout(globalThis.__sharedRefreshTimer);
  globalThis.__sharedRefreshTimer=setTimeout(()=>{
    refreshSharedData(true).catch(e=>console.error("❌ Google Sheets 共享数据刷新失败:",String(e?.message||e)));
  },1500);
}
async function refreshSharedData(force=false) {
  // 兼容旧按钮/调用点，但不再从 Google Sheets 拉取数据覆盖 JSON。
  console.log("ℹ️ 已忽略 Google Sheets 读取/刷新请求：Google Sheets 仅为 JSON 备份。");
  return false;
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
  form.append(method === "sendVideo" ? "video" : method === "sendPhoto" ? "photo" : "document", new Blob([buffer]), fileName || "resource");
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
    .replace(/\/n/g, "\n")
    .replace(/\\r/g, "")
    // Remove invisible formatting characters that can create visually blank Telegram messages.
    // Keep U+200D (ZWJ) and variation selectors so emoji and joined glyphs remain intact.
    .replace(/[\u00AD\u034F\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060\u2063\u2066-\u2069\uFEFF]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function hasVisibleMessageText(text, html = false) {
  let value = normalizeText(text);
  if (html) {
    value = value
      .replace(/<[^>]*>/g, "")
      .replace(/&(?:nbsp|zwnj|zwj|lrm|rlm);/gi, "")
      .replace(/&#(?:0*160|0*8203|0*8204|0*8205|0*8206|0*8207);/gi, "")
      .replace(/&#x(?:0*a0|0*200b|0*200c|0*200d|0*200e|0*200f);/gi, "");
  }
  return /[^\s]/u.test(value);
}

function warnSkippedEmptyMessage(kind, chat_id) {
  console.warn("[EMPTY_MESSAGE_BLOCKED]", kind, "chat_id=", String(chat_id ?? ""));
}

function prettyText(text) {
  return normalizeText(text);
}

const send = (token, chat_id, text, extra = {}) => {
  const cleanText = prettyText(text);
  if (!hasVisibleMessageText(cleanText)) {
    warnSkippedEmptyMessage("text", chat_id);
    return Promise.resolve({ok:false, skipped:true, description:"Empty or invisible message blocked"});
  }
  return tg(token, "sendMessage", {chat_id, text:cleanText, ...extra});
};

const sendHtml = (token, chat_id, text, extra = {}) => {
  const cleanText = normalizeText(text);
  if (!hasVisibleMessageText(cleanText, true)) {
    warnSkippedEmptyMessage("html", chat_id);
    return Promise.resolve({ok:false, skipped:true, description:"Empty or invisible message blocked"});
  }
  return tg(token, "sendMessage", {chat_id, text:cleanText, parse_mode:"HTML", ...extra});
};

function emptyDb() {
  return {offset:0, users:[], children:[], resources:[], directories:[], settings:{requiredGroup:null, repository:null, historyAuth:null, historyScan:{status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""},broadcastPin:false,admins:[],logs:[],stats:{downloads:0,searches:0,uploads:0,uploadedResources:0,userActions:{}},userFavorites:{},userRecent:{},sharedData:{version:1,lastChangedAt:Date.now(),lastChangedBy:"system"},nonMemberMessage:"🔐 <b>请先加入指定会员群</b>\n\n加入后即可继续使用资源功能。",postResourceMessage:"✨ <b>更多资源</b>\n\n欢迎继续浏览资源库。",nonMemberDailyLimit:3,nonMemberDailyUsage:{},contentProtection:true,autoDeleteMinutes:1440,autoDeleteQueue:[],resourceSources:[],repositoryMigration:{status:"idle",taskKey:"",ownerId:"",source:null,target:null,sourceId:null,targetId:null,sourceTitle:"",targetTitle:"",scanned:0,queued:0,migrated:0,skipped:0,failed:0,current:0,total:0,startedAt:null,finishedAt:null,error:"",lastError:"",folderMap:{},completedKeys:[],failedKeys:[],progressMessageId:null,autoSync:false},repositoryAutoSync:{enabled:false,status:"idle",ownerId:"",sourceId:"",targetId:"",sourceTitle:"",targetTitle:"",lastMessageId:0,queue:[],copied:0,failed:0,lastError:"",updatedAt:0,batchSize:40,perMessageDelay:0,batchDelay:0}}};
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
let pendingDbWrite = "";
let localDbWriteTimer = null;
function csvCell(value) {
  const s=String(value ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
}
function writeLocalTables() {
  try {
    fs.mkdirSync(LOCAL_TABLE_DIR,{recursive:true});
    const dirsHeader=["id","name","createdAt"];
    const dirsRows=(db.directories||[]).map(d=>[
      d?.id,d?.name,d?.createdAt
    ].map(csvCell).join(","));
    const resHeader=["chatId","messageId","title","caption","directoryId","folderName","date","fileType","fileId","downloads","baserowRowId"];
    const resRows=(db.resources||[]).map(r=>{
      const dir=(db.directories||[]).find(d=>String(d?.id)===String(r?.directoryId));
      return [
        r?.chatId,r?.messageId,r?.title,r?.caption,r?.directoryId,dir?.name||"",
        r?.date,r?.fileType,r?.fileId,r?.downloads,r?.baserowRowId
      ].map(csvCell).join(",");
    });
    const atomic=(file,content)=>{
      const tmp=file+".tmp";
      fs.writeFileSync(tmp,content);
      fs.renameSync(tmp,file);
    };
    atomic(LOCAL_DIRECTORIES_TABLE,[dirsHeader.join(","),...dirsRows].join("\n")+"\n");
    atomic(LOCAL_RESOURCES_TABLE,[resHeader.join(","),...resRows].join("\n")+"\n");
  } catch(e) {
    console.error("⚠️ 本地表格备份失败:",String(e?.message||e));
  }
}

function saveDb(options = {}) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
    const json = JSON.stringify(db, null, 2);
    if (json === lastSavedJson && !pendingDbWrite) return;
    pendingDbWrite = json;

    // 高频事件只更新内存/MySQL队列；本地 JSON/CSV/备份合并到一个短批次写入。
    // 这样频道连续入库时不会每条消息都重写数千条资源。
    if (options.immediate === true) {
      flushLocalDb();
      return;
    }

    if (!localDbWriteTimer) {
      localDbWriteTimer = setTimeout(() => {
        localDbWriteTimer = null;
        try { flushLocalDb(); } catch (e) { console.error("❌ 延迟保存失败:", e?.message || e); }
      }, 300);
      localDbWriteTimer.unref?.();
    }

    // MySQL 层自身已经做快照合并，这里可以立即接收最新内存状态。
    persistMySQL(db);
  } catch (e) {
    console.error("❌ SAVE:", e.message);
    console.error("❌ 当前数据文件:", DATA_FILE);
    console.error("❌ 备份文件:", BACKUP_FILE);
  }
}

function flushLocalDb() {
  if (!pendingDbWrite) return;
  const json = pendingDbWrite;
  if (localDbWriteTimer) {
    clearTimeout(localDbWriteTimer);
    localDbWriteTimer = null;
  }
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), {recursive:true});
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DATA_FILE);

    if (BACKUP_FILE !== DATA_FILE) {
      fs.mkdirSync(path.dirname(BACKUP_FILE), {recursive:true});
      const backupTmp = BACKUP_FILE + ".tmp";
      fs.writeFileSync(backupTmp, json);
      fs.renameSync(backupTmp, BACKUP_FILE);
    }

    writeLocalTables();

    try {
      const hourKey=new Date().toISOString().slice(0,13).replace(/[:T]/g,"-");
      fs.mkdirSync(BACKUP_SNAPSHOT_DIR,{recursive:true});
      const snapshotFile=path.join(BACKUP_SNAPSHOT_DIR,"database-"+hourKey+".json");
      if(!fs.existsSync(snapshotFile)) fs.writeFileSync(snapshotFile,json);
      const snapshots=fs.readdirSync(BACKUP_SNAPSHOT_DIR)
        .filter(x=>/^database-.*\.json$/.test(x))
        .sort();
      while(snapshots.length>24){
        const old=snapshots.shift();
        try{fs.rmSync(path.join(BACKUP_SNAPSHOT_DIR,old),{force:true});}catch{}
      }
    } catch(e) {
      console.warn("⚠️ 数据快照备份失败:",String(e?.message||e));
    }

    lastSavedJson = json;
    pendingDbWrite = "";
    persistMySQL(db);
  } catch (e) {
    console.error("❌ LOCAL SAVE:", e.message);
    // 保留 pendingDbWrite，下一个周期继续尝试，不丢掉最新内存状态。
  }
}
const db = loadDb();
await initializeMySQL(db);

let gracefulStopping=false;
async function gracefulShutdown(signal){
  if(gracefulStopping) return;
  gracefulStopping=true;
  console.log("🛑 收到 "+signal+"，正在保存本地数据并等待 MySQL 写入完成...");
  try{ saveDb({immediate:true}); }catch(e){ console.error("❌ 退出前保存失败:",String(e?.message||e)); }
  try{ await flushMySQL(); }catch(e){ console.error("❌ 退出前 MySQL flush 失败:",String(e?.message||e)); }
  try{ server.close(); }catch{}
  process.exit(0);
}
process.once("SIGTERM",()=>{ gracefulShutdown("SIGTERM").catch(e=>{console.error("❌ SIGTERM:",e);process.exit(1);}); });
process.once("SIGINT",()=>{ gracefulShutdown("SIGINT").catch(e=>{console.error("❌ SIGINT:",e);process.exit(1);}); });
const mysqlFlushTimer=setInterval(()=>flushMySQL().catch(e=>console.error("❌ MySQL 定时 flush:",String(e?.message||e))),30000);
mysqlFlushTimer.unref?.();
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
const uploadLocks = new Map();
async function withUploadLock(key, fn) {
  const previous = uploadLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  uploadLocks.set(key, current);
  await previous.catch(() => {});
  try { return await fn(); }
  finally { release(); if(uploadLocks.get(key) === current) uploadLocks.delete(key); }
}
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
  const client = new TelegramClientClass(new StringSessionClass(session), apiId, apiHash, {connectionRetries:5, autoReconnect:true, downloadRetries:8, maxConcurrentDownloads:2, downloadPool:{requestDeadlineMs:120000, requestRetries:8, inflightPerDc:2, maxSessions:2, sessions:2}});
  return {client, apiId, apiHash};
}

async function ensureHistoryClient(uid) {
  if (historyClient) return historyClient;
  if (historyConnecting) return historyConnecting;

  historyConnecting = (async () => {
    const timeout = (promise, ms, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + "（超过 " + Math.round(ms / 1000) + " 秒）")), ms))
    ]);

    let auth = db.settings.historyAuth || {};
    let apiId = Number(auth.apiId || TG_API_ID || 0);
    let apiHash = auth.apiHash ? decrypt(auth.apiHash) : TG_API_HASH;

    // 首次授权必须完整走：API ID → API HASH → 手机号 → 验证码 → 2FA（如有）。
    if (!apiId) {
      const apiIdText = await askHistoryInput(uid, "api_id",
        "🔐 <b>Telegram 扫描账号授权</b>\n\n请发送 Telegram API ID。\n\n获取位置：my.telegram.org → API development tools");
      apiId = Number(String(apiIdText).trim());
      if (!Number.isInteger(apiId) || apiId <= 0) throw new Error("API ID 格式不正确");
    }

    if (!apiHash) {
      const apiHashText = await askHistoryInput(uid, "api_hash",
        "现在发送 Telegram API HASH。\n\n⚠️ 不要把 Bot Token 发到这里。");
      apiHash = String(apiHashText || "").trim();
      if (!apiHash) throw new Error("API HASH 不能为空");
    }

    auth = {
      ...auth,
      apiId,
      apiHash: encrypt(apiHash),
      phone: auth.phone || null,
      session: auth.session || null
    };
    db.settings.historyAuth = auth;
    saveDb();

    const buildClient = async (sessionValue = "") => {
      await loadTeleproto();
      return new TelegramClientClass(
        new StringSessionClass(sessionValue || ""),
        apiId,
        apiHash,
        {connectionRetries:5, autoReconnect:true, floodSleepThreshold:60, downloadRetries:8, maxConcurrentDownloads:2, downloadPool:{requestDeadlineMs:120000, requestRetries:8, inflightPerDc:2, maxSessions:2, sessions:2}}
      );
    };

    // 已有 session：只连接已保存账号，失败就明确报错，绝不再次索要验证码。
    if (auth.session) {
      const client = await buildClient(decrypt(auth.session));
      try {
        await timeout((async () => {
          await client.connect();
          await client.getMe();
        })(), 20000, "Telegram 扫描账号连接超时");
        historyClient = client;
        const me = await client.getMe().catch(() => null);
        console.log("✅ MTProto 扫描账号已连接:", me?.username ? "@" + me.username : String(me?.id || ""));
        return historyClient;
      } catch (e) {
        try { await client.disconnect(); } catch {}
        throw new Error("扫描账号已登录，但 20 秒内连接失败：" + String(e?.message || e));
      }
    }

    // 没有 session：立即进入授权，不允许在连接阶段空等。
    const phone = String(auth.phone || await askHistoryInput(uid, "phone",
      "📱 <b>请输入 Telegram 扫描账号手机号</b>\n\n必须带国家区号，例如：<code>+886...</code>\n\n发送 /cancel 可取消。")).trim();
    if (!phone) throw new Error("手机号不能为空");

    auth = {...auth, phone};
    db.settings.historyAuth = auth;
    saveDb();

    const client = await buildClient("");
    try {
      await timeout(client.start({
        phoneNumber: () => Promise.resolve(phone),
        phoneCode: () => askHistoryInput(uid, "phone_code",
          "📩 Telegram 已发送登录验证码。\n\n请输入验证码："),
        password: () => askHistoryInput(uid, "password",
          "🔑 你的 Telegram 账号启用了两步验证。\n\n请输入 2FA 密码："),
        onError: e => console.error("MTProto AUTH:", e?.message || e)
      }), 20000, "Telegram 扫描账号授权超时");

      auth = {
        ...db.settings.historyAuth,
        apiId,
        apiHash: encrypt(apiHash),
        phone,
        session: encrypt(client.session.save())
      };
      db.settings.historyAuth = auth;
      saveDb();
      historyClient = client;
      console.log("✅ MTProto 扫描账号授权成功，session 已保存");
      return historyClient;
    } catch (e) {
      try { await client.disconnect(); } catch {}
      throw new Error("Telegram 扫描账号授权失败：" + String(e?.message || e));
    }
  })().catch(async e => {
    console.error("❌ MTProto SCAN ACCOUNT:", e?.message || e);
    try {
      await sendHtml(TOKEN, uid,
        "<b>❌ Telegram 扫描账号连接失败</b>\n\n" +
        "⚠️ " + escapeHtml(e?.message || "未知连接错误")
      );
    } catch {}
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
    mediaGroupId:message?.groupedId ? String(message.groupedId) : String(message?.mediaGroupId||""),
    fileType:message?.file ? (
      String(message.file.mimeType||"").toLowerCase().startsWith("video") ? "Video" :
      String(message.file.mimeType||"").toLowerCase().startsWith("audio") ? "Audio" : "Document"
    ) : (message?.photo ? "Photo" : null),
    textOnly:!hasMedia,
    directoryId:null
  };
  autoAssignResourceTagFolder(item);
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
  if(!GOOGLE_SHEETS_CREDENTIAL || !GOOGLE_SHEETS_ID) return sendHtml(TOKEN,uid,"❌ <b>Google Sheets 共享未配置</b>\\n\\n请先配置 GOOGLE_SHEETS_CREDENTIAL 和 GOOGLE_SHEETS_ID。",adminMenu());
  const r=targetRepo || repo();
  if(!r) return sendHtml(TOKEN,uid,"❌ <b>没有可恢复的资源仓库</b>\\n\\n请先绑定原来的 Telegram 资源仓库。",adminMenu());
  const current=db.settings.baserowRecovery||{};
  if(String(current.status||"")==="running") {
    const started=Number(current.startedAt||0);
    const last=Number(current.lastMessageId||0);
    const stale=started>0 && (Date.now()-started)>2*60*1000;
    if(!stale) return sendHtml(TOKEN,uid,"🔄 <b>Google Sheets 历史恢复已经在运行</b>\\n\\n📨 已扫描："+Number(current.scanned||0).toLocaleString()+" 条\\n🔗 已匹配："+Number(current.matched||0).toLocaleString()+" 条\\n🆔 当前进度："+last+"\\n\\n请等待任务继续。",adminMenu());
    console.warn("⚠️ Google Sheets 历史恢复检测到旧任务卡住，自动从断点继续：", {scanned:Number(current.scanned||0),matched:Number(current.matched||0),lastMessageId:last});
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
  catch(e) { return sendHtml(TOKEN,uid,"❌ <b>读取 Google Sheets 失败</b>\\n\\n"+escapeHtml(e?.message||e),adminMenu()); }

  const titleField=baserowPickField(fields,["名称","资源名称","资源名","标题","资源标题","文件名","文件名称","资源","Name","Title","Resource","Resource Name","File Name"]);
  const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
  const dateField=baserowPickField(fields,["日期","时间","创建时间","资源日期","Date","Created","Created At"]);

  // 兼容旧 Google Sheets 表：历史数据可能没有“资源名称”字段。
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
  const render=done=>"<b>"+(done?"✅ ":"🔄 ")+"Google Sheets 历史资源恢复</b>\\n━━━━━━━━━━━━━━\\n📦 仓库：<b>"+escapeHtml(state.repositoryTitle)+"</b>\\n🗃️ Google Sheets 资源行：<b>"+resourceRowCount.toLocaleString()+"</b>\\n📨 已扫描：<b>"+Number(state.scanned).toLocaleString()+"</b>\\n🔗 已匹配：<b>"+Number(state.matched).toLocaleString()+"</b>\\n📁 已恢复文件夹：<b>"+Number(state.folderMatched).toLocaleString()+"</b>\\n⚠️ 未匹配：<b>"+Number(state.unmatched).toLocaleString()+"</b>\\n♻️ 同名候选：<b>"+Number(state.duplicateTitle).toLocaleString()+"</b>\\n🆔 当前进度：<code>"+Number(state.lastMessageId||0)+"</code>\\n⏱️ 用时：<b>"+elapsedText()+"</b>\\n━━━━━━━━━━━━━━\\n"+(done?"📌 Google Sheets 原有记录未删除，仅补回 Telegram 定位信息。":"⏳ 正在从 Telegram 历史消息匹配 Google Sheets 记录…");

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
    const errorText="<b>❌ Google Sheets 历史恢复中断</b>\\n\\n"+render(false)+"\\n\\n⚠️ "+escapeHtml(e?.message||e)+"\\n\\n再次点击“恢复历史资源”会从当前断点继续。";
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
    console.log("🔎 HISTORY SCAN START:", { uid:String(uid), repoId:String(r.chatId||""), repoTitle:String(r.title||""), repoUsername:String(r.username||""), checkpoint:previousCheckpoint, baserow:Boolean(GOOGLE_SHEETS_CREDENTIAL && GOOGLE_SHEETS_ID) });
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
let repositoryAutoSyncRecoveryTimer = null;
const repositoryAutoSyncDebounceTimers=new Map();
function repositoryAutoSyncState() {
  const base={enabled:false,status:"idle",ownerId:"",sourceId:"",targetId:"",sourceTitle:"",targetTitle:"",lastMessageId:0,queue:[],copied:0,failed:0,skipped:0,lastError:"",manualPaused:false,syncText:true,syncPhoto:true,syncVideo:true,syncFiles:true,updatedAt:0};
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
function leftCountSafe(arr,n){ return Math.max(0,Math.min(Number(n)||0,Array.isArray(arr)?arr.length:0)); }
function repositoryAutoSyncItemType(item){
  if(item?.textOnly) return "text";
  const t=String(item?.fileType||"").toLowerCase();
  if(t==="photo") return "photo";
  if(t==="video" || t==="animation" || t==="videonote") return "video";
  return "file";
}
function repositoryAutoSyncItemAllowed(item,state){
  const type=repositoryAutoSyncItemType(item);
  if(type==="text") return state.syncText!==false;
  if(type==="photo") return state.syncPhoto!==false;
  if(type==="video") return state.syncVideo!==false;
  return state.syncFiles!==false;
}
function repositoryAutoSyncBatchAllowed(batch,state){
  if(!Array.isArray(batch)||!batch.length)return false;
  // 相册永远整组处理，由“图片/相册”开关统一控制。
  const groupIds=new Set(batch.map(x=>String(x?.mediaGroupId||"")).filter(Boolean));
  if(groupIds.size) return state.syncPhoto!==false;
  // 历史消息按原仓库顺序批量复制；整批内容类型都允许时才一次复制。
  return batch.every(item=>repositoryAutoSyncItemAllowed(item,state));
}
function repositoryAutoSyncContentText(state){
  const on=v=>v!==false?"✅":"❌";
  return "<b>⚙️ 自动同步内容</b>\n━━━━━━━━━━━━━━\n\n"+
    "📝 文字：<b>"+on(state.syncText)+"</b>\n"+
    "🖼️ 图片/相册：<b>"+on(state.syncPhoto)+"</b>\n"+
    "🎬 视频：<b>"+on(state.syncVideo)+"</b>\n"+
    "📦 文件/音频：<b>"+on(state.syncFiles)+"</b>\n\n"+
    "📌 <i>复制严格按旧仓库 message_id 顺序提交；Telegram 原生相册会保持原相册分组。</i>";
}
function repositoryAutoSyncContentMenu(){
  const state=repositoryAutoSyncState();
  const mark=v=>v!==false?"✅":"❌";
  return {inline_keyboard:[
    [{text:mark(state.syncText)+" 文字",callback_data:"adm:auto_content_toggle:text"}],
    [{text:mark(state.syncPhoto)+" 图片/相册",callback_data:"adm:auto_content_toggle:photo"}],
    [{text:mark(state.syncVideo)+" 视频",callback_data:"adm:auto_content_toggle:video"}],
    [{text:mark(state.syncFiles)+" 文件/音频",callback_data:"adm:auto_content_toggle:file"}],
    [{text:"⬅️ 返回自动同步",callback_data:"adm:auto_status"}]
  ]};
}

async function repositoryAutoSyncBatch(batch){
  const state=repositoryAutoSyncState();
  const sourceId=String(state.sourceId||""),targetId=String(state.targetId||"");
  if(!state.enabled||!sourceId||!targetId||!Array.isArray(batch)||!batch.length)return false;

  const jobs=batch
    .map(x=>({
      messageId:Number(x?.messageId||0),
      fromChatId:String(x?.fromChatId||sourceId),
      queuedAt:x?.queuedAt||Date.now(),
      mediaGroupId:String(x?.mediaGroupId||""),
      historical:Boolean(x?.historical)
    }))
    .filter(x=>x.messageId>0 && sameAutoSyncChat(x.fromChatId,sourceId));

  if(!jobs.length)return true;

  // Telegram Bot API 批量转发/复制：原生相册必须整组进入同一次请求。
  // 有 media_group_id 时绝不拆组；普通历史消息才按连续队列批量处理。
  const sourceItems = jobs.map(job => {
    const found = db.resources.find(r =>
      String(r?.chatId||"")===sourceId &&
      Number(r?.messageId||0)===Number(job.messageId)
    );
    return found || {
      chatId:sourceId,
      messageId:Number(job.messageId),
      mediaGroupId:String(batch.find(q=>Number(q?.messageId||0)===Number(job.messageId))?.mediaGroupId||""),
      textOnly:false,
      fileType:"Document"
    };
  });
  if(!repositoryAutoSyncBatchAllowed(sourceItems,state)){
    for(const job of jobs){
      const idx=state.queue.findIndex(x=>Number(x?.messageId||0)===Number(job.messageId));
      if(idx>=0) state.queue.splice(idx,1);
    }
    state.skipped=Number(state.skipped||0)+jobs.length;
    state.lastError="";
    state.status="running";
    state.updatedAt=Date.now();
    saveDb();
    console.log("⏭️ AUTO SYNC 按内容设置跳过:",jobs.length+" 条");
    return true;
  }
  const messageIds=[...new Set(jobs.map(x=>x.messageId))].sort((a,b)=>a-b);
  const groupIds=[...new Set(sourceItems.map(x=>String(x?.mediaGroupId||"")).filter(Boolean))];
  console.log("📦 AUTO SYNC 批量复制:",messageIds.length+" 条"+(groupIds.length?"（相册组 "+groupIds.length+"）":""),sourceId+" -> "+targetId,messageIds.join(","));

  let copiedIds=null,lastError=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      // copyMessages 本身会保留 Telegram 原生相册分组；只要同一相册的全部 message_id
      // 一起提交，就不会在目标仓库拆成单条。
      copiedIds=await main("copyMessages",{
        chat_id:targetId,
        from_chat_id:jobs[0]?.fromChatId||sourceId,
        message_ids:messageIds,
        ...(contentProtectionEnabled()?{protect_content:true}:{})
      });
      if(!Array.isArray(copiedIds))throw new Error("Telegram 未返回批量复制结果");
      break;
    }catch(err){
      lastError=err;
      const desc=String(err?.telegramDescription||err?.message||err||"");
      console.warn("⚠️ AUTO SYNC 批量复制失败:",sourceId+" -> "+targetId,"count="+messageIds.length,"attempt="+attempt,desc);
      if(attempt<3) await sleep(3000*attempt);
    }
  }

  // 批量接口失败时，单条消息必须有兜底，避免“队列有数据但目标仓库没有消息”。
  if(!Array.isArray(copiedIds) && messageIds.length===1){
    try{
      const single=await main("copyMessage",{
        chat_id:targetId,
        from_chat_id:jobs[0]?.fromChatId||sourceId,
        message_id:messageIds[0],
        ...(contentProtectionEnabled()?{protect_content:true}:{})
      });
      if(single?.message_id){
        copiedIds=[single];
        console.log("✅ AUTO SYNC 单条兜底复制成功:",sourceId+"#"+messageIds[0]+" -> "+targetId+"#"+single.message_id);
      }
    }catch(fallbackErr){
      lastError=fallbackErr;
      console.warn("❌ AUTO SYNC 单条兜底也失败:",sourceId+"#"+messageIds[0],String(fallbackErr?.telegramDescription||fallbackErr?.message||fallbackErr));
    }
  }

  if(!Array.isArray(copiedIds)){
    const errorText=String(lastError?.telegramDescription||lastError?.message||lastError||"批量复制失败");
    const containsAlbum=jobs.some(job=>Boolean(job.mediaGroupId)) || sourceItems.some(item=>Boolean(item?.mediaGroupId));
    state.lastError=errorText;
    state.updatedAt=Date.now();

    if(/MEDIA_FILE_INVALID|media file is invalid|there are no messages to forward|message to forward not found|message.*not found/i.test(errorText)){
      // Telegram 对已删除/不可转发的源消息会返回“there are no messages to forward”。
      // 不要让整个自动同步暂停：拆分定位失效消息，正常消息继续同步。
      // 如果当前是相册，只有异常消息被剔除后，其余同组媒体仍按实际数量复制。
      if(messageIds.length>1 && !containsAlbum){
        const mid=Math.ceil(jobs.length/2);
        const left=jobs.slice(0,mid),right=jobs.slice(mid);
        console.warn("↪️ AUTO SYNC 批量失败，拆分为两组继续:",left.length+"+"+right.length);
        const leftOk=await repositoryAutoSyncBatch(left);
        if(!leftOk)return false;
        return await repositoryAutoSyncBatch(right);
      }

      // 不自动丢弃失败消息；保留原队列并暂停，交由管理员确认后处理。
      state.manualPaused=true;
      state.status="paused";
      state.lastError=(containsAlbum?"相册组复制失败，已保留整组队列：":"源消息不可复制，已保留队列：")+sourceId+"#"+messageIds[0]+"；"+errorText;
      state.updatedAt=Date.now();
      saveDb();
      console.warn("⏸️ AUTO SYNC 失败消息已保留，暂停等待处理:",state.lastError);
      return false;
    }

    // Telegram 的 4xx 业务错误通常不是临时网络故障。
    // 如果整组失败，继续拆分定位；单条仍失败则只跳过这一条，不能让队列原地死循环。
    if(messageIds.length>1 && !containsAlbum){
      const mid=Math.ceil(jobs.length/2);
      console.warn("↪️ AUTO SYNC 业务错误，拆分消息组继续:",leftCountSafe(jobs,mid)+"+"+leftCountSafe(jobs,jobs.length-mid));
      const leftOk=await repositoryAutoSyncBatch(jobs.slice(0,mid));
      if(!leftOk)return false;
      return await repositoryAutoSyncBatch(jobs.slice(mid));
    }
    state.manualPaused=true;
    state.status="paused";
    state.lastError=(containsAlbum?"相册组复制失败，已保留整组队列：":"消息复制失败，已保留队列：")+sourceId+"#"+messageIds[0]+"；"+errorText;
    state.updatedAt=Date.now();
    saveDb();
    console.warn("⏸️ AUTO SYNC 失败队列已保留，暂停等待处理:",state.lastError);
    return false;
  }

  // copyMessages 成功时返回目标消息 ID 数组。
  // 正常情况下数量与输入一致；若 Telegram 跳过不可复制消息，
  // 将当前组拆分后重试，以准确定位无效消息，同时尽量保持批量复制。
  if(copiedIds.length!==messageIds.length){
    const containsAlbum=jobs.some(job=>Boolean(job.mediaGroupId)) || sourceItems.some(item=>Boolean(item?.mediaGroupId));
    if(messageIds.length>1 && !containsAlbum){
      const mid=Math.ceil(jobs.length/2);
      console.warn("⚠️ AUTO SYNC 批量结果数量不一致:",copiedIds.length+"/"+messageIds.length,"拆分继续");
      const leftOk=await repositoryAutoSyncBatch(jobs.slice(0,mid));
      if(!leftOk)return false;
      return await repositoryAutoSyncBatch(jobs.slice(mid));
    }
    state.manualPaused=true;
    state.status="paused";
    state.lastError="Telegram 返回的复制数量不一致，已保留消息队列："+sourceId+"#"+messageIds[0];
    state.updatedAt=Date.now();
    saveDb();
    console.warn("⏸️ AUTO SYNC 复制结果不完整，已保留队列并暂停:",state.lastError);
    return false;
  }

  for(let i=0;i<jobs.length;i++){
    const messageId=jobs[i].messageId;
    const copiedId=Number(copiedIds[i]?.message_id||0);
    if(!copiedId) {
      state.manualPaused=true;
      state.status="paused";
      state.lastError="Telegram 未返回目标消息 ID，已保留队列："+sourceId+"#"+messageId;
      state.updatedAt=Date.now();
      saveDb();
      console.warn("⏸️ AUTO SYNC 缺少目标消息 ID，保留队列并暂停:",state.lastError);
      return false;
    }

    const sourceItem=db.resources.find(x=>String(x.chatId)===sourceId&&Number(x.messageId)===messageId)||null;
    const directoryId=sourceItem?repositoryAutoSyncFolderId(sourceItem,targetId):null;
    const targetItem={
      ...(sourceItem||{}),
      chatId:targetId,
      messageId:copiedId,
      directoryId:directoryId||sourceItem?.directoryId||null,
      fileId:null,
      baserowRowId:null,
      title:String(sourceItem?.title||sourceItem?.name||("资源 "+messageId)),
      migratedFrom:{chatId:sourceId,messageId,at:Date.now()}
    };

    if(!db.resources.some(x=>String(x.chatId)===targetId&&Number(x.migratedFrom?.chatId||0)===Number(sourceId)&&Number(x.migratedFrom?.messageId||0)===messageId)){
      db.resources.unshift(targetItem);
      db.resources=db.resources.slice(0,MAX_RESOURCES);
      queueBaserowResourceSync(targetItem);
    }

    const index=state.queue.findIndex(x=>Number(x?.messageId||0)===messageId);
    if(index>=0)state.queue.splice(index,1);

    state.copied=Number(state.copied||0)+1;
    state.lastMessageId=Math.max(Number(state.lastMessageId||0),messageId);
  }

  state.lastError="";
  state.updatedAt=Date.now();
  state.status=state.queue.length?"queued":"running";
  state.checkpointMessageId=Number(state.lastMessageId||0);
  saveDb();

  console.log("✅ AUTO SYNC 批量完成:",messageIds.length+" 条","剩余="+state.queue.length,"断点="+state.lastMessageId);
  return true;
}

async function processRepositoryAutoSyncQueue(){
  if(repositoryAutoSyncRunning)return repositoryAutoSyncQueue;
  repositoryAutoSyncRunning=true;

  repositoryAutoSyncQueue=repositoryAutoSyncQueue.then(async()=>{
    const state=repositoryAutoSyncState();
    if(!state.enabled)return;

    while(state.queue.length){
      // 永远以旧仓库 message_id 为唯一顺序依据。
      // Telegram 的 copyMessages 会保留原生相册分组，所以不需要为了“相册”把消息拆成单条。
      state.queue=state.queue
        .filter(x=>{
          const origin=String(x?.fromChatId||state.sourceId||"");
          if(sameAutoSyncChat(origin,state.sourceId)) return Number(x?.messageId||0)>0;
          console.warn("⏭️ AUTO SYNC 清理非旧仓库队列项:",origin+"#"+String(x?.messageId||0));
          return false;
        })
        .sort((a,b)=>Number(a?.messageId||0)-Number(b?.messageId||0));

      const first=state.queue[0];
      if(!first)break;

      // 统一按旧仓库 message_id 连续批量提交，不再因为数据库里的分组字段缺失
      // 把历史相册错误拆成“一条一条”。Telegram Bot API 的 copyMessages 会自动保留
      // 原生 media_group_id 对应的相册分组；因此只要把连续消息一起提交即可。
      // 单次最多 100 条，仍严格保持旧仓库顺序。
      let batch=state.queue
        .slice(0,40)
        .filter(x=>Number(x?.messageId||0)>0)
        .sort((a,b)=>Number(a?.messageId||0)-Number(b?.messageId||0));

      if(!batch.length) batch=[first];

      state.status="running";
      state.updatedAt=Date.now();
      saveDb();

      const beforeQueueLength=state.queue.length;
      const messageOrder=batch.map(x=>Number(x.messageId)).filter(Number.isFinite).sort((a,b)=>a-b);
      console.log("📦 AUTO SYNC 按旧仓库顺序批量复制:",messageOrder.length+" 条",String(state.sourceId)+" -> "+String(state.targetId),messageOrder.join(","));

      const ok=await repositoryAutoSyncBatch(batch);
      if(!ok)break;

      // 用户点击暂停/解绑可能发生在复制请求等待期间。
      // 此时绝不能用“防卡死”逻辑删除队列第一条，必须原样保留断点。
      if(!state.enabled || state.manualPaused)break;

      if(state.queue.length>=beforeQueueLength && state.queue.length){
        const stuckId=Number(state.queue[0]?.messageId||0);
        // 未确认队列已消费时，不得删除消息；暂停并保留断点，避免漏同步。
        state.manualPaused=true;
        state.status="paused";
        state.lastError="队列未确认消费，已保留消息 "+String(state.sourceId||"")+"#"+stuckId;
        state.updatedAt=Date.now();
        saveDb();
        console.warn("⏸️ AUTO SYNC 队列未确认消费，暂停并保留消息:",String(state.sourceId||"")+"#"+stuckId);
        break;
      }

      // 不人为等待；用户要求有多少发多少。Telegram 自身的 429 retry_after 仍由 tg() 自动处理。
    }

    if(state.enabled && !state.manualPaused){
      state.status=state.queue.length?"queued":"running";
      state.updatedAt=Date.now();
      saveDb();
    }
  }).catch(e=>{
    const state=repositoryAutoSyncState();
    state.lastError=String(e?.telegramDescription||e?.message||e);
    state.status="paused";
    state.updatedAt=Date.now();
    saveDb();
    console.warn("⚠️ 自动同步异常，保留断点并准备自动恢复:",state.lastError);
    if(state.enabled && !state.manualPaused && state.sourceId && state.targetId){
      if(repositoryAutoSyncRecoveryTimer) clearTimeout(repositoryAutoSyncRecoveryTimer);
      repositoryAutoSyncRecoveryTimer=setTimeout(()=>{
        repositoryAutoSyncRecoveryTimer=null;
        const current=repositoryAutoSyncState();
        if(current.enabled && !current.manualPaused && current.sourceId && current.targetId){
          current.status="queued";
          current.updatedAt=Date.now();
          saveDb();
          processRepositoryAutoSyncQueue().catch(err=>console.error("❌ AUTO SYNC AUTO-RECOVERY:",String(err?.message||err)));
        }
      },5000);
    }
  }).finally(()=>{repositoryAutoSyncRunning=false;});

  return repositoryAutoSyncQueue;
}
function sameAutoSyncChat(a,b){
  const left=String(a??"").trim();
  const right=String(b??"").trim();
  if(!left||!right)return false;
  if(left===right)return true;
  const norm=v=>v.replace(/^-100/,"").replace(/^-/,"");
  return norm(left)===norm(right);
}
function queueRepositoryAutoSyncMessage(msg){
  if(!msg?.chat?.id||!msg?.message_id)return;
  const state=repositoryAutoSyncState();
  if(!state.enabled||!state.targetId)return;
  const fromChatId=String(msg.chat.id);
  if(sameAutoSyncChat(fromChatId,state.targetId))return;
  const fromSource=sameAutoSyncChat(fromChatId,state.sourceId);
  // 实时自动同步只接受已绑定的旧仓库，禁止其他群组/频道媒体混入队列。
  if(!fromSource)return;
  const messageId=Number(msg.message_id);if(!messageId)return;
  const exists=state.queue.some(x=>Number(x.messageId)===messageId&&sameAutoSyncChat(x.fromChatId||state.sourceId,fromChatId));
  const already=db.resources.some(x=>String(x.chatId)===String(state.targetId)&&sameAutoSyncChat(x.migratedFrom?.chatId,fromChatId)&&Number(x.migratedFrom?.messageId||0)===messageId);
  if(!exists&&!already){
    state.queue.push({messageId,fromChatId,mediaGroupId:String(msg.media_group_id||""),historical:false,syncType:repositoryAutoSyncItemType(db.resources.find(x=>sameAutoSyncChat(x.chatId,fromChatId)&&Number(x.messageId)===messageId)||msg),queuedAt:Date.now()});
    console.log("⚡ AUTO SYNC 实时消息入队:",fromChatId+"#"+messageId,"->",String(state.targetId),"queue="+state.queue.length);
  }
  // 注意：这里只记录“已进入队列”，不能提前推进 lastMessageId。
  // lastMessageId 必须只在目标仓库实际复制成功（或明确跳过无效消息）后推进，
  // 否则机器人重启/失败恢复时会把尚未同步的消息误认为已经完成。
  // 新文件一进入旧仓库，立即唤醒同步队列；不再等待 2.5 秒防抖。
  // 如果只是临时异常导致 paused，只要不是人工暂停，就自动恢复继续发送。
  if(state.enabled && !state.manualPaused) state.status="queued";
  state.updatedAt=Date.now();
  saveDb();

  if(state.enabled && !state.manualPaused && state.queue.length){
    processRepositoryAutoSyncQueue().catch(e=>console.error("❌ AUTO SYNC QUEUE:",String(e?.message||e)));
  }
}
async function hydrateRepositoryAutoSyncMediaGroups(uid,sourceId){
  const sid=String(sourceId||"");
  if(!sid) return 0;
  let client=historyClient;
  if(!client){
    const auth=db.settings.historyAuth||{};
    const hasCredentials=Boolean(auth.apiId||TG_API_ID)&&Boolean(auth.apiHash||TG_API_HASH)&&Boolean(auth.session||process.env.TG_SESSION);
    if(!hasCredentials) return 0;
    try{ client=await ensureHistoryClient(Number(uid||0)); }catch(e){
      console.warn("⚠️ AUTO SYNC 相册信息补全失败：",String(e?.message||e));
      return 0;
    }
  }
  try{
    const entity=await client.getEntity(sid);
    const items=db.resources
      .filter(x=>String(x?.chatId||"")===sid&&Number(x?.messageId||0)>0)
      .sort((a,b)=>Number(a.messageId)-Number(b.messageId));
    const missing=items.filter(x=>!String(x?.mediaGroupId||""));
    if(!missing.length) return 0;
    let updated=0;
    for(let offset=0;offset<missing.length;offset+=100){
      const ids=missing.slice(offset,offset+100).map(x=>Number(x.messageId)).filter(Number.isFinite);
      if(!ids.length) continue;
      let found=await client.getMessages(entity,{ids});
      if(!Array.isArray(found)) found=[found];
      for(const message of found){
        const id=Number(message?.id||0);
        const groupedId=message?.groupedId!=null ? String(message.groupedId) : String(message?.mediaGroupId||"");
        if(!id||!groupedId) continue;
        const item=db.resources.find(x=>String(x?.chatId||"")===sid&&Number(x?.messageId||0)===id);
        if(item && String(item.mediaGroupId||"")!==groupedId){
          item.mediaGroupId=groupedId;
          updated++;
        }
      }
      if(ids.length) await sleep(30);
    }
    if(updated){
      saveDb();
      console.log("🖼️ AUTO SYNC 相册分组信息已补全：",updated,"条");
    }
    return updated;
  }catch(e){
    console.warn("⚠️ AUTO SYNC 获取旧仓库相册分组失败：",String(e?.message||e));
    return 0;
  }
}

async function startRepositoryAutoSyncNow(uid){
  const state=repositoryAutoSyncState();
  if(!state.sourceId||!state.targetId)throw new Error("请先绑定旧仓库和新仓库");
  const [sc,tc]=await Promise.all([main("getChat",{chat_id:state.sourceId}),main("getChat",{chat_id:state.targetId})]);
  const me=await main("getMe");
  for(const chat of [sc,tc]){
    const member=await main("getChatMember",{chat_id:chat.id,user_id:me.id});
    if(["left","kicked"].includes(String(member?.status||"")))throw new Error("机器人不在仓库「"+String(chat.title||chat.username||chat.id)+"」中");
  }

  // 启动时先把旧仓库已有的资源加入队列，避免出现“显示正在同步但一直不转发”。
  // 后续 channel_post 会继续通过 queueRepositoryAutoSyncMessage() 自动加入新消息。
  const sourceId=String(state.sourceId),targetId=String(state.targetId);
  // 旧版本数据库中的资源可能没有保存 mediaGroupId；启动同步前从 MTProto 补全，
  // 否则同一相册会被错误当成多条单独消息。
  await hydrateRepositoryAutoSyncMediaGroups(uid,sourceId);
  for(const queued of state.queue){
    const saved=db.resources.find(x=>String(x.chatId)===sourceId&&Number(x.messageId)===Number(queued?.messageId));
    if(saved?.mediaGroupId) queued.mediaGroupId=String(saved.mediaGroupId);
  }
  const existing=db.resources
    .filter(x=>String(x.chatId)===sourceId&&Number(x.messageId)>0)
    .sort((a,b)=>Number(a.messageId)-Number(b.messageId));
  const pendingKeys=new Set(state.queue.map(x=>String(x.messageId)));
  let added=0;
  for(const item of existing){
    const messageId=Number(item.messageId);
    const already=db.resources.some(x=>String(x.chatId)===targetId&&Number(x.migratedFrom?.chatId||0)===Number(sourceId)&&Number(x.migratedFrom?.messageId||0)===messageId);
    if(messageId<Number(state.startMessageId||0))continue;
    if(already||pendingKeys.has(String(messageId)))continue;
    state.queue.push({messageId,mediaGroupId:String(item?.mediaGroupId||""),historical:true,syncType:repositoryAutoSyncItemType(item),queuedAt:Date.now()});
    pendingKeys.add(String(messageId));
    added++;
  }
  state.enabled=true;
  state.status=state.queue.length?"queued":"running";
  state.updatedAt=Date.now();
  state.lastError="";
  saveDb();
  console.log("⚡ AUTO SYNC START:",sourceId,"->",targetId,"queued="+state.queue.length,"added="+added);
  processRepositoryAutoSyncQueue().catch(e=>console.error("❌ AUTO SYNC START:",String(e?.message||e)));
  return state;
}
async function enableRepositoryAutoSync(uid,sourceId,targetId,sourceTitle,targetTitle,lastMessageId=0){
  const state=repositoryAutoSyncState();
  state.enabled=false; state.status="bound"; state.manualPaused=false; state.ownerId=String(uid);
  state.sourceId=String(sourceId); state.targetId=String(targetId);
  state.sourceTitle=String(sourceTitle||sourceId); state.targetTitle=String(targetTitle||targetId);
  state.lastMessageId=Number(lastMessageId||0); state.queue=[]; state.lastError=""; state.skipped=0;
  state.updatedAt=Date.now(); saveDb(); return state;
}
async function repositoryAutoSyncOne(job){
  const state=repositoryAutoSyncState();
  const messageId=Number(job?.messageId||0);
  const sourceId=String(state.sourceId||"");
  if(!state.enabled||!sourceId||!state.targetId) throw new Error("自动同步尚未完成绑定");
  if(!messageId) throw new Error("测试消息 ID 无效");
  const already=db.resources.some(x=>String(x.chatId)===String(state.targetId)&&sameAutoSyncChat(x.migratedFrom?.chatId,sourceId)&&Number(x.migratedFrom?.messageId||0)===messageId);
  if(already) return true;
  if(!state.queue.some(x=>Number(x?.messageId||0)===messageId&&sameAutoSyncChat(x?.fromChatId||sourceId,sourceId))){
    state.queue.push({messageId,fromChatId:sourceId,historical:true,queuedAt:Date.now()});
    state.queue.sort((a,b)=>Number(a.messageId)-Number(b.messageId));
    saveDb();
  }
  await processRepositoryAutoSyncQueue();
  return db.resources.some(x=>String(x.chatId)===String(state.targetId)&&sameAutoSyncChat(x.migratedFrom?.chatId,sourceId)&&Number(x.migratedFrom?.messageId||0)===messageId);
}
async function testRepositoryAutoSync(uid){
  const state=repositoryAutoSyncState();
  if(!state.enabled||!state.sourceId||!state.targetId) throw new Error("自动同步尚未完成绑定");
  const candidates=db.resources
    .filter(x=>sameAutoSyncChat(x.chatId,state.sourceId)&&Number(x.messageId)>0)
    .sort((a,b)=>Number(b.messageId)-Number(a.messageId));
  const sourceItem=candidates.find(item=>!db.resources.some(y=>String(y.chatId)===String(state.targetId)&&sameAutoSyncChat(y.migratedFrom?.chatId,state.sourceId)&&Number(y.migratedFrom?.messageId||0)===Number(item.messageId)));
  if(!sourceItem) throw new Error("旧仓库目前没有可测试的新资源");
  const ok=await repositoryAutoSyncOne({messageId:Number(sourceItem.messageId)});
  if(!ok) throw new Error(state.lastError||"测试同步失败");
  return sourceItem;
}
async function stopRepositoryAutoSync(){const state=repositoryAutoSyncState();state.enabled=false;state.status="stopped";state.updatedAt=Date.now();saveDb();return state;}
async function checkRepositoryAutoSyncAccess(){
  const state=repositoryAutoSyncState();
  if(!state.enabled||!state.targetId)return true;
  try{
    const me=await main("getMe");
    const member=await main("getChatMember",{chat_id:state.targetId,user_id:me.id});
    const status=String(member?.status||"");
    if(["left","kicked"].includes(status)){
      state.enabled=false;
      state.status="unbound";
      state.lastError="机器人已被移出新仓库，自动同步已自动解绑";
      state.queue=[];
      state.sourceId="";
      state.targetId="";
      state.sourceTitle="";
      state.targetTitle="";
      state.lastMessageId=0;
      state.updatedAt=Date.now();
      saveDb();
      console.warn("⚠️ 自动同步已自动解绑：机器人已被移出新仓库");
      return false;
    }
    return true;
  }catch(e){
    const msg=String(e?.telegramDescription||e?.message||e||"");
    if(/chat not found|user not found|bot was kicked|kicked|not a member|member list/i.test(msg)){
      state.enabled=false;
      state.status="unbound";
      state.lastError="机器人已无法访问新仓库，自动同步已自动解绑";
      state.queue=[];
      state.sourceId="";
      state.targetId="";
      state.sourceTitle="";
      state.targetTitle="";
      state.lastMessageId=0;
      state.updatedAt=Date.now();
      saveDb();
      console.warn("⚠️ 自动同步已自动解绑：",msg);
      return false;
    }
    return true;
  }
}
async function showRepositoryAutoSyncStatus(uid){
  const state=repositoryAutoSyncState();
  const bound=Boolean(state.sourceId&&state.targetId);
  const running=Boolean(state.enabled);
  const statusText=running?"🟢 正在自动同步":(state.status==="paused"?"⏸️ 已暂停":"⚪ 未运行");
  const body="<b>⚡ 自动同步</b>\n━━━━━━━━━━━━━━\n\n"+statusText+
    "\n📤 旧仓库："+escapeHtml(state.sourceTitle||"-")+
    "\n📥 新仓库："+escapeHtml(state.targetTitle||"-")+
    "\n📌 断点消息："+Number(state.lastMessageId||0)+
    "\n🎯 起始 ID："+(Number(state.startMessageId||0)||"从头")+ 
    "\n📦 已同步："+Number(state.copied||0)+
    "\n⏭️ 已跳过："+Number(state.skipped||0)+
    "\n⏳ 待处理："+state.queue.length+
    (state.lastError?"\n\n❌ "+escapeHtml(state.lastError):"");
  const rows=[];
  if(running) rows.push([{text:"⏸️ 暂停同步",callback_data:"adm:auto_pause"}]);
  else if(bound) rows.push([{text:"▶️ 开始同步",callback_data:"adm:auto_start"}]);
  rows.push([{text:"⚙️ 同步内容",callback_data:"adm:auto_content"},{text:"🎯 从指定 ID 开始",callback_data:"adm:auto_from"}]);
  rows.push([{text:"➕ 添加同步任务",callback_data:"adm:auto_add"}]);
  if(bound) rows.push([{text:"🗑️ 删除任务并解绑仓库",callback_data:"adm:auto_delete"}]);
  rows.push([{text:"🔄 重新绑定",callback_data:"adm:auto_reset"}]);
  rows.push([{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]);
  return sendHtml(TOKEN,uid,body,{reply_markup:{inline_keyboard:rows}});
}
async function resetRepositoryAutoSyncBinding(){
  try{await stopRepositoryAutoSync();}catch(e){console.warn("⚠️ 停止自动同步任务时出现异常：",String(e?.message||e));}
  const state=repositoryAutoSyncState();
  state.enabled=false; state.status="stopped"; state.ownerId="";
  state.sourceId=""; state.targetId=""; state.sourceTitle=""; state.targetTitle="";
  state.lastMessageId=0; state.queue=[]; state.copied=0; state.failed=0; state.skipped=0; state.lastError="";
  state.updatedAt=Date.now(); saveDb(); return state;
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
  const resumableStatuses=new Set(["running","paused","completed_with_errors","completed"]);
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
          console.warn("MIGRATION BATCH RETRY",attempt,"size=",batch.length,e?.telegramDescription||e?.message||e);
          // tg() 已经会读取 Telegram 429 retry_after 并等待；这里额外留出冷却时间。
          if(attempt<3) await sleep(5000*attempt);
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
        const message=String(e?.telegramDescription||e?.message||e||"");
        console.error("⏸️ MIGRATION BATCH FAILED，暂停任务并保留断点:",message);
        state.status="paused";
        state.error=message;
        state.lastError=message;
        state.completedKeys=[...completed].slice(-Math.max(MAX_RESOURCES,25000));
        state.failedKeys=[...failedKeys].slice(-Math.max(MAX_RESOURCES,25000));
        state.queued=Math.max(0,ordered.length-completed.size);
        saveDb();
        throw e;
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
      // 每个10条批次完成后强制保存断点，并主动冷却，避免新频道被短时间大量写入。
      state.failed=failedKeys.size;
      await sleep(3500);
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
  } catch(e) {
    const message=String(e?.telegramDescription||e?.message||e||"");
    state.status="paused";
    state.error=message;
    state.lastError=message;
    state.finishedAt=null;
    state.completedKeys=Array.isArray(state.completedKeys)?state.completedKeys:[];
    state.failedKeys=Array.isArray(state.failedKeys)?state.failedKeys:[];
    state.queued=Math.max(0,Number(state.total||0)-state.completedKeys.length);
    saveDb();
    console.error("⏸️ 仓库迁移已暂停，保留断点:",message);
    if(progressMessage){
      await safeEdit(TOKEN,{chat_id:uid,message_id:progressMessage.message_id,text:renderProgress("paused")+"\n\n⏸️ <b>已自动暂停</b>\n⚠️ "+escapeHtml(message)+"\n\n再次执行相同的迁移任务会从已完成位置继续，不会重复已完成资源。",parse_mode:"HTML",reply_markup:adminMenu().reply_markup}).catch(()=>{});
    }
    return null;
  } finally {
    repositoryMigrationRunning=false;
  }
}
const isSuperAdmin = id => ADMIN_IDS.has(String(id));
const isAdmin = id => isSuperAdmin(id) || db.settings.admins.includes(String(id));
const group = () => db.settings.requiredGroup;
const repo = () => db.settings.repository;

/* CLOUD123_RUNTIME_V1 */
const cloud123State = new Map();
let cloud123Syncing = false;

function cloud123Config() {
  const c = db.settings.cloud123 || {};
  try {
    return {
      url: c.url ? decrypt(c.url) : "",
      username: c.username ? decrypt(c.username) : "",
      password: c.password ? decrypt(c.password) : "",
      configuredAt: c.configuredAt || null
    };
  } catch (e) {
    console.error("123 CLOUD CONFIG:", e.message);
    return {url:"",username:"",password:"",configuredAt:null};
  }
}

function cloud123Client() {
  const c = cloud123Config();
  if (!c.url || !c.username || !c.password) {
    throw new Error("尚未配置123云盘 WebDAV。请先点击「🔗 配置123云盘」。");
  }
  return createWebDavClient(c);
}

function cloud123Menu() {
  const c = cloud123Config();
  const ready = Boolean(c.url && c.username && c.password);
  return {
    reply_markup:{
      inline_keyboard:[
        [{text:"🔗 配置123云盘",callback_data:"adm:cloud_setup"},{text:"🧪 测试连接",callback_data:"adm:cloud_test"}],
        [{text:"📁 同步目录+文件",callback_data:"adm:cloud_sync"},{text:"🚀 扫描并上传",callback_data:"adm:cloud_scan"}],
        [{text:"🔄 刷新进度",callback_data:"adm:cloud123"}],
        [{text:"🔁 重试失败文件",callback_data:"adm:cloud_retry"}],
        [{text:"🔐 授权账号",callback_data:"adm:cloud_account"},{text:"⬅️ 返回管理",callback_data:"admin:resource"}]
      ]
    }
  };
}

function cloud123RunStats() {
  return globalThis.cloud123Run || {running:false, success:0, fail:0, skip:0, total:0};
}
function cloud123StatusText() {
  const c = cloud123Config();
  const uploaded = db.resources.filter(x=>x.cloud123?.uploaded).length;
  const failed = db.resources.filter(x=>x.cloud123?.error && !x.cloud123?.uploaded).length;
  const remaining = db.resources.filter(x=>!x.cloud123?.uploaded && !x.cloud123?.skipped && Number(x.cloud123?.attempts||0) < 3).length;
  const run = cloud123RunStats();
  return [
    "☁️ <b>123云盘</b>",
    "",
    "🔗 WebDAV：" + (c.url ? "✅ 已配置" : "❌ 未配置"),
    "👤 扫描账号：" + ((db.settings.historyAuth||{}).session ? "✅ 已授权" : "❌ 未授权"),
    "⚙️ 后台：" + (run.running || cloud123Syncing ? "正在上传" : "自动检查中"),
    "",
    "📚 累计已上传：" + uploaded + " 个",
    "⏳ 剩余待上传：" + remaining + " 个",
    "⚠️ 累计失败：" + failed + " 个",
    "📤 本次已上传：" + Number(run.success||0) + " 个",
    "❌ 本次失败：" + Number(run.fail||0) + " 个",
    "⏭️ 本次跳过：" + Number(run.skip||0) + " 个",
    "",
    "失败的文件会自动再试，最多 3 次。点刷新可看最新数量。"
  ].join("\n");
}

function cloud123RemoteName(name) {
  return String(name || "未命名").replace(/[\\/:*?"<>|]/g,"_").trim().slice(0,80) || "未命名";
}

async function cloud123SyncDirectories(uid) {
  const client = cloud123Client();
  const dirs = Array.isArray(db.directories) ? db.directories : [];
  const unique = new Map();
  for (const d of dirs) {
    const name = cloud123RemoteName(d?.name);
    if (!unique.has(name)) unique.set(name,d);
  }
  const list = [...unique.entries()];
  let created=0, existing=0, fail=0;
  const duplicate = Math.max(0,dirs.length-list.length);

  let progressMessage = null;
  try {
    progressMessage = await send(TOKEN,uid,
      "⏳ 正在同步机器人目录...\n\n📁 共 "+list.length+" 个唯一目录\n⚙️ 正在检查 123 云盘目录，请稍候。",
      cloud123Menu()
    );
  } catch {}

  for (let i=0; i<list.length; i++) {
    const [remoteName,d] = list[i];
    try {
      const result = await client.ensureDirectory(remoteName);
      d.cloud123Path=remoteName;
      d.cloud123SyncedAt=Date.now();
      if (result?.created === false || result?.exists === true || result?.alreadyExists === true) existing++;
      else created++;
    } catch(e) {
      fail++;
      console.error("123 DIR:", d.name, e.message);
    }

    if (progressMessage?.message_id && ((i+1)%3===0 || i===list.length-1)) {
      try {
        await tg(TOKEN,"editMessageText",{
          chat_id:uid,
          message_id:progressMessage.message_id,
          text:"⏳ <b>正在同步机器人目录</b>\n\n"+
            "📁 进度："+(i+1)+" / "+list.length+"\n"+
            "🆕 新建："+created+"\n"+
            "✅ 已存在："+existing+"\n"+
            "♻️ 重复目录："+duplicate+"\n"+
            "⚠️ 失败："+fail,
          parse_mode:"HTML",
          reply_markup:cloud123Menu().reply_markup
        });
      } catch {}
    }
  }

  saveDb();
  return {created,existing,fail,duplicate,total:dirs.length,unique:list.length,progressMessage};
}

async function cloud123ScanAndUpload(uid, options={}) {
  const silent=options.silent===true;
  if (cloud123Syncing) return silent ? null : send(TOKEN,uid,"⏳ 123云盘同步已经在进行中，请不要重复启动。",adminMenu());
  const r = repo();
  if (!r) return silent ? null : send(TOKEN,uid,"❌ 尚未绑定资源仓库。",adminMenu());
  cloud123Syncing=true;
  globalThis.cloud123Run={running:true,success:0,fail:0,skip:0,total:0};
  const started=Date.now();
  let statusMessage=null;
  let success=0, fail=0, skip=0;
  let activeBatchBytes=0, totalUploadedBytes=0;
  let currentFileName="";
  let tick=null;
  const uploadProgress = new Map();
  let lastProgressEdit = 0;
  let progressEditing = false;
  const refreshUploadProgress = async () => {
    if(!statusMessage?.message_id || progressEditing) return;
    const now=Date.now();
    if(now-lastProgressEdit<1000) return;
    lastProgressEdit=now;
    progressEditing=true;
    try {
      let sentBytes=0,totalBytes=0;
      for(const p of uploadProgress.values()){sentBytes+=Number(p.sent||0);totalBytes+=Number(p.total||0);}
      const mb=n=>(n/1024/1024).toFixed(1);
      await tg(TOKEN,"editMessageText",{
        chat_id:uid,message_id:statusMessage.message_id,
        text:"🚀 <b>123云盘实时上传</b>\\n\\n"+
          "📁 当前文件："+escapeHtml(currentFileName||"准备中")+"\\n"+
          "📊 成功："+success+"  | 失败："+fail+"  | 跳过："+skip+"\\n"+
          "📤 当前传输："+mb(sentBytes)+" / "+mb(totalBytes)+" MB\\n"+
          "⚡ 小文件最多 5 个并发\\n📦 单批总量 ≤ 1GB",
        parse_mode:"HTML"
      });
    } catch {} finally { progressEditing=false; }
  };
  try {
    const client=cloud123Client();
    let phase="正在连接 Telegram 扫描账号";
    let planned=db.resources.filter(x=>!x.cloud123?.uploaded && !x.cloud123?.skipped && Number(x.cloud123?.attempts||0) < 3).length;
    const render=()=>"<b>🚀 123云盘扫描上传</b>\n━━━━━━━━━━━━━━\n"+
      "⏱ 已运行：<b>"+Math.floor((Date.now()-started)/1000)+"</b> 秒\n"+
      "📍 当前：<b>"+phase+"</b>\n"+
      "✅ 本次成功：<b>"+success+"</b>\n"+
      "❌ 本次失败：<b>"+fail+"</b>\n"+
      "⏳ 剩余：<b>"+Math.max(0, planned-success-fail-skip)+"</b>\n"+
      "⏭️ 跳过："+skip+"\n"+
      (currentFileName?"📄 当前文件："+escapeHtml(currentFileName)+"\n":"")+
      "📁 按现有文件夹建立目录\n"+
      "📦 每批最多 1GB";
    if(!silent) statusMessage=await sendHtml(TOKEN,uid, render(), cloud123Menu());
    if(!silent) tick=setInterval(()=>{
      if(!statusMessage?.message_id) return;
      tg(TOKEN,"editMessageText",{chat_id:uid,message_id:statusMessage.message_id,text:render(),parse_mode:"HTML"}).catch(()=>{});
    },5000);
    const savedHistoryAuth = db.settings.historyAuth || {};
    if (!savedHistoryAuth.session) {
      phase="扫描账号未授权，请先点击「🔐 扫描账号」";
      if(statusMessage?.message_id) {
        try { await tg(TOKEN,"editMessageText",{
          chat_id:uid,
          message_id:statusMessage.message_id,
          text:render()+"\\n\\n<b>👉 请先点击「🔐 扫描账号」完成授权</b>",
          parse_mode:"HTML",
          reply_markup:cloud123Menu().reply_markup
        }); } catch {}
      }
      return;
    }

    phase="连接已保存的 Telegram 扫描账号";
    let clientHistory;
    try {
      clientHistory = await Promise.race([
        ensureHistoryClient(uid),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Telegram 扫描账号连接超时（超过 20 秒）")), 20000))
      ]);
    } catch(e) {
      phase="连接失败";
      if(statusMessage?.message_id) {
        try { await tg(TOKEN,"editMessageText",{
          chat_id:uid,
          message_id:statusMessage.message_id,
          text:render()+"\\n\\n❌ <b>连接失败：</b>"+escapeHtml(String(e?.message||e)),
          parse_mode:"HTML"
        }); } catch {}
      }
      return;
    }
    if(statusMessage?.message_id) {
      try { await tg(TOKEN,"editMessageText",{
        chat_id:uid,message_id:statusMessage.message_id,
        text:"<b>✅ Telegram 扫描账号连接成功</b>\\n\\n"+
          "🔎 正在读取资源仓库历史消息...\\n"+
          "📁 正在检查待上传资源，请稍候...",
        parse_mode:"HTML",reply_markup:cloud123Menu().reply_markup
      }); } catch {}
    }
    const entity=await findHistoryEntity(clientHistory);
    if(statusMessage?.message_id) {
      try { await tg(TOKEN,"editMessageText",{
        chat_id:uid,message_id:statusMessage.message_id,
        text:"<b>✅ 扫描账号已连接</b>\\n\\n"+
          "📚 正在统计待上传资源...\\n"+
          "⏳ 很快开始上传，请稍候...",
        parse_mode:"HTML",reply_markup:cloud123Menu().reply_markup
      }); } catch {}
    }
    const repoId=String(repo()?.chatId||"");
    const resources=[...db.resources].filter(x=>(!repoId || String(x.chatId)===repoId) && !x.cloud123?.uploaded && !x.cloud123?.skipped && Number(x.cloud123?.attempts||0) < 3);
    if(statusMessage?.message_id) {
      try {
        await tg(TOKEN,"editMessageText",{
          chat_id:uid,
          message_id:statusMessage.message_id,
          text:"<b>🚀 开始扫描并上传123云盘</b>\n\n"+
            "📚 待处理："+resources.length+" 个\n"+
            "📁 将按机器人现有文件夹建立目录\n"+
            "📦 当前批次最多 1GB，超出自动进入下一批。",
          parse_mode:"HTML",
          reply_markup:cloud123Menu().reply_markup
        });
      } catch {}
    }

    const BATCH_LIMIT = 1024 * 1024 * 1024;
    const SMALL_CONCURRENCY = 3;
    let batchNumber = 1;
    let batchBytes = 0;

    const uploadOne = async (item) => {
      if(!item || !Number(item.messageId)) { skip++; return 0; }
      if(item.cloud123?.uploaded) { skip++; return 0; }
      if(item.textOnly) {
        item.cloud123={uploaded:false,skipped:true,reason:"text-only",at:Date.now()};
        skip++;
        return 0;
      }

      const d=db.directories.find(x=>String(x.id)===String(item.directoryId));
      const remoteDir=cloud123RemoteName(d?.name || "未分类");
      const found=await clientHistory.getMessages(entity,{ids:[Number(item.messageId)]});
      const message=Array.isArray(found)?found[0]:found;
      if(!message || !message.media) {
        item.cloud123={
          uploaded:false,
          error:"Telegram 历史消息/媒体不存在",
          attempts:Number(item.cloud123?.attempts||0)+1,
          at:Date.now()
        };
        fail++;
        saveDb();
        return 0;
      }

      const originalName=cloud123RemoteName(message.file?.name || item.title || ("resource-"+item.messageId));
      const tempDir=path.join("/tmp","cloud123-upload");
      fs.mkdirSync(tempDir,{recursive:true});
      const tempPath=path.join(tempDir,String(item.messageId)+"-"+crypto.randomUUID()+"-"+originalName);
      try {
        let downloadError=null;
        let downloaded=false;
        for(let attempt=1;attempt<=4;attempt++){
          try{
            try { await fs.promises.rm(tempPath,{force:true}); } catch {}
            await clientHistory.downloadMedia(message,{outputFile:tempPath});
            downloaded=true;
            break;
          }catch(e){
            downloadError=e;
            const msg=String(e?.message||e);
            console.warn("⚠️ 123 Telegram 媒体下载失败:",String(item?.messageId||""),"attempt="+attempt+"/4",msg);
            if(attempt<4 && /TIMEOUT|deadline|RequestTimeout|ETIMEDOUT|ECONNRESET|network/i.test(msg)){
              await new Promise(resolve=>setTimeout(resolve,Math.min(10000,2000*attempt)));
              continue;
            }
            break;
          }
        }
        if(!downloaded) throw downloadError || new Error("Telegram 媒体下载失败");
        // CLOUD123_DOWNLOAD_RETRY_V1
        const stat=await fs.promises.stat(tempPath);
        currentFileName=originalName;
        uploadProgress.set(String(item.messageId),{sent:0,total:stat.size,name:originalName});
        await client.uploadFile(tempPath,remoteDir,originalName,(sent,total)=>{
          uploadProgress.set(String(item.messageId),{sent,total,name:originalName});
          if (typeof refreshUploadProgress === "function") refreshUploadProgress();
        });
        uploadProgress.delete(String(item.messageId));
        item.cloud123={
          uploaded:true,
          path:remoteDir+"/"+originalName,
          size:stat.size,
          uploadedAt:Date.now(),
          attempts:Number(item.cloud123?.attempts||0)
        };
        // 每个文件确认上传成功后立即安排 JSON 持久化，降低批次中断导致重复上传的概率。
        saveDb();
        success++;
        globalThis.cloud123Run={running:true,success,fail,skip,total:resources.length};
        totalUploadedBytes += stat.size;
        return stat.size;
      } catch(e) {
        uploadProgress.delete(String(item.messageId));
        item.cloud123={uploaded:false,error:String(e.message||e).slice(0,500),attempts:Number(item.cloud123?.attempts||0)+1,at:Date.now()};
        saveDb();
        fail++;
        globalThis.cloud123Run={running:true,success,fail,skip,total:resources.length};
        console.error("123 UPLOAD:", item.title, e);
        return 0;
      } finally {
        try { await fs.promises.rm(tempPath,{force:true}); } catch {}
        currentFileName="";
        if (typeof refreshUploadProgress === "function") await refreshUploadProgress();
      }
    };

    for(let i=0;i<resources.length;) {
      const batch=[];
      let plannedBytes=0;

      while(i<resources.length && batch.length<SMALL_CONCURRENCY) {
        const item=resources[i];
        const estimatedSize=Number(item?.size || item?.fileSize || item?.bytes || 0);

        const large=estimatedSize>=20*1024*1024;
        if(batch.length===0) {
          batch.push(item);
          plannedBytes=estimatedSize>0 ? estimatedSize : 1;
          i++;
          if(large) break;
          continue;
        }
        if(large || batch.length>=SMALL_CONCURRENCY) break;

        if(plannedBytes+Math.max(estimatedSize,1)<=BATCH_LIMIT) {
          batch.push(item);
          plannedBytes+=estimatedSize;
          i++;
          continue;
        }

        break;
      }

      if(batch.length===0) continue;

      const displayGB=(plannedBytes/1024/1024/1024).toFixed(2);
      if(statusMessage?.message_id) {
        try { await tg(TOKEN,"editMessageText",{
          chat_id:uid,message_id:statusMessage.message_id,
          text:"🚀 <b>123云盘同步中</b>\\n\\n"+
            "📦 第 "+batchNumber+" 批\\n"+
            "📁 本批文件："+batch.length+" 个\\n"+
            "💾 预计传输："+displayGB+" GB\\n"+
            "⚡ 最多 "+SMALL_CONCURRENCY+" 个小文件并发\\n"+
            "📊 已完成："+success+" / "+resources.length,
          parse_mode:"HTML",reply_markup:cloud123Menu().reply_markup
        }); } catch {}
      }

      batchBytes=0;
      const results=await Promise.all(batch.map(async item=>{
        const bytes=await uploadOne(item);
        batchBytes+=bytes;
        return bytes;
      }));
      batchBytes=results.reduce((a,b)=>a+b,0);

      saveDb();
      await refreshUploadProgress();

      if(i<resources.length) {
        if(statusMessage?.message_id) {
          try { await tg(TOKEN,"editMessageText",{
            chat_id:uid,message_id:statusMessage.message_id,
            text:"✅ <b>第 "+batchNumber+" 批完成</b>\\n\\n"+
              "📦 本批实际传输："+(batchBytes/1024/1024/1024).toFixed(2)+" GB\\n"+
              "📊 总进度："+i+" / "+resources.length+"\\n"+
              "⏭️ 下一批将继续，单批上限 1GB。",
            parse_mode:"HTML",reply_markup:cloud123Menu().reply_markup
          }); } catch {}
        }
        batchNumber++;
      }
    }

    saveDb();
    logAdmin(uid,"123云盘扫描上传","成功"+success+" / 失败"+fail+" / 跳过"+skip);
    if(statusMessage?.message_id) {
      try { await tg(TOKEN,"editMessageText",{
        chat_id:uid,
        message_id:statusMessage.message_id,
        text:"✅ <b>123云盘同步完成</b>\n\n"+
          "📚 本次处理："+resources.length+" 个\n"+
          "✅ 成功："+success+"\n"+
          "⚠️ 失败："+fail+"\n"+
          "⏭️ 跳过："+skip+"\n"+
          "⏱️ 用时："+Math.max(1,Math.round((Date.now()-started)/1000))+" 秒\n\n"+
          "📁 目录按照机器人现有文件夹整理。",
        parse_mode:"HTML",
        reply_markup:cloud123Menu().reply_markup
      }); } catch {}
    }
  } catch(e) {
    console.error("123 SYNC:",e);
    const raw=String(e?.message||e);
    const friendly=/resources' before initialization/.test(raw)
      ? "上传进度初始化失败，请重新点「扫描并上传」。已上传的文件会跳过。"
      : /423|Locked/.test(raw)
        ? "123云盘文件被锁定，稍后会自动重试。"
        : /fetch failed|请求超时|ETIMEDOUT/.test(raw)
          ? "连接123云盘超时，稍后会自动重试。"
          : "上传暂时失败，已上传的文件会跳过，可稍后重试。";
    if(statusMessage?.message_id) {
      try { await tg(TOKEN,"editMessageText",{
        chat_id:uid,
        message_id:statusMessage.message_id,
        text:"❌ <b>123云盘同步中断</b>\n\n"+escapeHtml(friendly)+"\n\n已完成的文件会保留上传记录，下次可以继续。",
        parse_mode:"HTML",
        reply_markup:cloud123Menu().reply_markup
      }); } catch {}
    } else if(!silent) {
      await send(TOKEN,uid,"❌ 123云盘同步中断：\n"+friendly,adminMenu());
    }
  } finally {
    if(tick) clearInterval(tick);
    cloud123Syncing=false;
    if(globalThis.cloud123Run) globalThis.cloud123Run.running=false;
  }
}


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

function redemptionStore() {
  if(!db.settings || typeof db.settings!=="object") db.settings={};
  if(!db.settings.redemptionCodes || typeof db.settings.redemptionCodes!=="object" || Array.isArray(db.settings.redemptionCodes)) db.settings.redemptionCodes={};
  if(!db.settings.premiumMemberships || typeof db.settings.premiumMemberships!=="object") db.settings.premiumMemberships={};
  if(!db.settings.extraVideoQuota || typeof db.settings.extraVideoQuota!=="object") db.settings.extraVideoQuota={};
  return db.settings;
}
function premiumMembershipExpiry(uid) {
  const row=redemptionStore().premiumMemberships[String(uid)];
  const expiry=Number(typeof row==="number"?row:row?.expiresAt||0);
  return Number.isFinite(expiry)?expiry:0;
}
function hasActivePremiumMembership(uid) {
  const row=redemptionStore().premiumMemberships[String(uid)];
  return row?.permanent===true || premiumMembershipExpiry(uid)>Date.now();
}
function extraVideoQuotaRemaining(uid) {
  const n=Number(redemptionStore().extraVideoQuota[String(uid)]||0);
  return Number.isFinite(n)?Math.max(0,Math.floor(n)):0;
}
function consumeExtraVideoQuota(uid,count) {
  if(!(Number(count)>0)) return 0;
  const store=redemptionStore().extraVideoQuota;
  const id=String(uid), before=extraVideoQuotaRemaining(uid);
  const used=Math.min(before,Math.floor(Number(count)||0));
  if(used>0) store[id]=before-used;
  return used;
}
async function notifyRedeemAdmins(token,uid,code,row,userInfo,usedAt) {
  const admins=[...new Set([
    ...[...ADMIN_IDS].map(String),
    ...(Array.isArray(db.settings?.admins)?db.settings.admins.map(String):[])
  ])].filter(id=>/^\d+$/.test(id)&&Number(id)>0);
  if(!admins.length) {
    console.warn("兑换码已使用，但未配置可接收通知的管理员");
    return;
  }
  const firstName=[userInfo?.first_name,userInfo?.last_name].filter(Boolean).join(" ").trim();
  const name=firstName||userInfo?.username||"未获取到昵称";
  const username=userInfo?.username?"@"+userInfo.username:"无用户名";
  const type=row.type==="membership_permanent"?"永久会员":
    row.type==="membership_days"?"会员时长（"+Math.floor(Number(row.amount)||0)+" 天）":
    row.type==="video_credits"?"额外视频额度（"+Math.floor(Number(row.amount)||0)+" 次）":String(row.type||"未知奖励");
  const when=new Date(usedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
  const message="<b>🎟️ 兑换码使用通知</b>\n━━━━━━━━━━━━━━\n"+
    "👤 <b>用户：</b>"+escapeHtml(name)+"\n"+
    "🔖 <b>用户名：</b>"+escapeHtml(username)+"\n"+
    "🆔 <b>用户 ID：</b><code>"+escapeHtml(String(uid))+"</code>\n"+
    "🎫 <b>兑换码：</b><code>"+escapeHtml(code)+"</code>\n"+
    "🎁 <b>兑换内容：</b>"+escapeHtml(type)+"\n"+
    "🕒 <b>使用时间：</b>"+escapeHtml(when)+"\n"+
    "✅ <b>结果：</b>兑换成功";
  const results=await Promise.allSettled(admins.map(adminId=>tg(token,"sendMessage",{
    chat_id:Number(adminId),text:message,parse_mode:"HTML",disable_web_page_preview:true
  })));
  const failed=results.filter(r=>r.status==="rejected"||r.value==null).length;
  if(failed) console.warn("兑换码通知发送失败:",failed+"/"+admins.length);
}
function redeemCode(uid,rawCode,userInfo=null,botToken=TOKEN) {
  const store=redemptionStore();
  // 兑换码输入容错：忽略大小写、空格、连字符及常见分隔符，并兼容全角字符。
  // 找到后仍使用数据库中原始键值，确保奖励记录和管理员通知保持一致。
  const normalizeRedeemCode=value=>String(value??"").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const inputCode=normalizeRedeemCode(rawCode);
  if(!inputCode) return {ok:false,message:"请输入兑换码。"};
  const code=Object.keys(store.redemptionCodes).find(savedCode=>normalizeRedeemCode(savedCode)===inputCode);
  if(!code) return {ok:false,message:"兑换码不存在，请检查后重试。"};
  const row=store.redemptionCodes[code];
  if(row.usedAt || row.usedBy) return {ok:false,message:"这个兑换码已经被使用，不能重复兑换。"};
  const amount=Math.floor(Number(row.amount)||0);
  if(row.type!=="membership_permanent" && amount<1) return {ok:false,message:"兑换码奖励数据异常，请联系管理员。"};
  const now=Date.now(); let reward="", expiry="";
  if(row.type==="membership_days") {
    const currentMembership=store.premiumMemberships[String(uid)];
    if(currentMembership?.permanent===true) {
      row.rewardAppliedAt=now; row.permanentMembershipAlready=true;
      reward="账号已是永久会员，永久权益保持不变"; expiry="永久有效";
    } else {
      const oldExpiry=premiumMembershipExpiry(uid), expiresAt=Math.max(now,oldExpiry)+amount*86400000;
      store.premiumMemberships[String(uid)]={expiresAt,updatedAt:now,sourceCode:code};
      row.rewardAppliedAt=now; row.expiresAt=expiresAt; reward="已增加 "+amount+" 天会员";
      expiry=new Date(expiresAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
    }
  } else if(row.type==="membership_permanent") {
    store.premiumMemberships[String(uid)]={permanent:true,updatedAt:now,sourceCode:code};
    row.rewardAppliedAt=now; row.permanent=true; reward="已开通永久会员"; expiry="永久有效";
  } else if(row.type==="video_credits") {
    store.extraVideoQuota[String(uid)]=extraVideoQuotaRemaining(uid)+amount;
    row.rewardAppliedAt=now; reward="额外视频额度 +"+amount+" 次；当前剩余额度 "+extraVideoQuotaRemaining(uid)+" 次";
  } else return {ok:false,message:"兑换码奖励类型无效，请联系管理员。"};
  row.usedBy=String(uid); row.usedAt=now; saveDb();
  // 兑换成功后异步通知所有配置管理员；通知失败不影响用户兑换结果。
  void notifyRedeemAdmins(TOKEN||botToken,uid,code,row,userInfo,now).catch(err=>{
    console.error("兑换码管理员通知失败:",String(err?.message||err));
  });
  let defaultMessage="";
  if(row.type==="membership_days") defaultMessage="🎉 兑换成功！已增加 "+amount+" 天会员。\n会员到期时间："+expiry+"。";
  else if(row.type==="membership_permanent") defaultMessage="🎉 兑换成功！已开通永久会员，永久有效。";
  else defaultMessage="🎉 兑换成功！额外视频额度 +"+amount+" 次。\n当前剩余额外视频额度："+extraVideoQuotaRemaining(uid)+" 次。";
  const template=String(db.settings?.redeemSuccessMessage||"").trim();
  if(!template) return {ok:true,message:defaultMessage};
  return {ok:true,message:template.replace(/\{reward\}/gi,reward).replace(/\{days\}/gi,row.type==="membership_days"?String(amount):"").replace(/\{expiry\}/gi,expiry).replace(/\{quota\}/gi,row.type==="video_credits"?String(extraVideoQuotaRemaining(uid)):"").replace(/\{type\}/gi,row.type==="membership_permanent"?"永久会员":row.type==="membership_days"?"会员":"额外视频额度")};
}
function shanghaiDateKey(value) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(value));
  const get=t=>parts.find(p=>p.type===t)?.value||"";
  return get("year")+"-"+get("month")+"-"+get("day");
}
function shanghaiDateOrdinal(key) {
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(key||"");
  return m?Math.floor(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]))/86400000):0;
}
async function checkMembershipExpiryReminders() {
  if(!TOKEN) return;
  const store=redemptionStore(), todayOrdinal=shanghaiDateOrdinal(shanghaiDateKey(Date.now()));
  let changed=false;
  for(const [uid,entry] of Object.entries(store.premiumMemberships)) {
    let raw=entry;
    if(typeof raw==="number" && Number.isFinite(raw)) {
      raw={expiresAt:raw};
      store.premiumMemberships[uid]=raw;
      changed=true;
    }
    if(!raw || typeof raw!=="object" || raw.permanent===true) continue;
    const expiry=Number(raw.expiresAt||0);
    if(!Number.isFinite(expiry) || expiry<=Date.now()) continue;
    const daysLeft=shanghaiDateOrdinal(shanghaiDateKey(expiry))-todayOrdinal;
    if(daysLeft!==3 && daysLeft!==0) continue;
    const marker=daysLeft===3?"reminder3ForExpiry":"reminder0ForExpiry";
    if(Number(raw[marker]||0)===expiry) continue;
    const expiryText=new Date(expiry).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
    try {
      await sendHtml(TOKEN,uid,"<b>⏰ 会员到期提醒</b>\n━━━━━━━━━━━━━━\n\n"+(daysLeft===3?"你的会员还有 <b>3 天</b> 到期。":"你的会员将于今天到期。")+"\n到期时间："+escapeHtml(expiryText)+"\n\n如需继续使用会员权益，请及时续期。");
      raw[marker]=expiry; changed=true;
    } catch(e) { console.warn("⚠️ 会员到期提醒发送失败，用户="+uid+"："+String(e?.message||e)); }
  }
  if(changed) saveDb();
}
const membershipCache = new Map();
const membershipPending = new Map();
async function allowed(token, userId) {
  // 管理员、兑换获得的有效会员不受非会员额度限制。
  if (isAdmin(userId) || hasActivePremiumMembership(userId)) return true;
  const g = group();
  if (!g) return false;
  const cacheKey=tokenFingerprint(token)+":"+String(g.chatId)+":"+String(userId);
  const cached=membershipCache.get(cacheKey);
  if(cached && cached.expiresAt>Date.now()) return cached.member;
  if(cached) membershipCache.delete(cacheKey);
  // 同一个用户同时点多个按钮时，共用一次会员查询，避免排队重复请求 Telegram。
  if(membershipPending.has(cacheKey)) return membershipPending.get(cacheKey);
  const pending=(async()=>{
    try {
      const m = await tg(token, "getChatMember", {chat_id:g.chatId, user_id:userId});
      const member=["creator","administrator","member"].includes(m.status) || (m.status === "restricted" && m.is_member === true);
      membershipCache.set(cacheKey,{member,expiresAt:Date.now()+20000});
      if(membershipCache.size>5000) {
        const now=Date.now();
        for(const [key,value] of membershipCache) if(value.expiresAt<=now) membershipCache.delete(key);
        while(membershipCache.size>5000) membershipCache.delete(membershipCache.keys().next().value);
      }
      return member;
    } catch(e) {
      // 查询失败不缓存 false，避免临时网络问题把会员误判为非会员 20 秒。
      console.warn("⚠️ 指定群会员检查失败:", String(e?.telegramDescription || e?.message || e));
      return false;
    } finally {
      membershipPending.delete(cacheKey);
    }
  })();
  membershipPending.set(cacheKey,pending);
  return pending;
}
// 统一读取指定群会员缓存。null 表示尚未检查或缓存过期，避免把“未知”当成非会员。
function cachedRequiredGroupMembership(userId) {
  if(isAdmin(userId) || hasActivePremiumMembership(userId)) return true;
  const g=group();
  if(!g?.chatId) return false;
  const key=tokenFingerprint(TOKEN)+":"+String(g.chatId)+":"+String(userId);
  const cached=membershipCache.get(key);
  if(!cached || cached.expiresAt<=Date.now()) {
    if(cached) membershipCache.delete(key);
    return null;
  }
  return cached.member===true;
}
async function requireMemberAccess(token, chatId, userId, menu=null) {
  // 指定群只负责会员身份与非会员额度判断；是否强制入群由额度设置决定。
  // 保留此函数兼容旧入口，但不再把“未入群”直接拦截。
  return true;
}
function quotaDateKey() {
  const d=new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function nonMemberDailyLimit() {
  // 免费用户每日上限最多为 3；保留管理员将额度调低的设置，但旧配置不能把上限放大。
  const n=Number(db.settings.nonMemberDailyLimit);
  return Number.isFinite(n) && n>=0 ? Math.min(3,Math.floor(n)) : 3;
}
function nonMemberDailyUsed(uid) {
  if(!db.settings.nonMemberDailyUsage || typeof db.settings.nonMemberDailyUsage!=="object") db.settings.nonMemberDailyUsage={};
  const row=db.settings.nonMemberDailyUsage[String(uid)];
  if(!row || row.date!==quotaDateKey()) return 0;
  return Math.max(0,Number(row.used)||0);
}
// 同一用户快速连点多个获取入口时，先预留本批额度，防止并发请求都读到相同的剩余额度。
const nonMemberQuotaReservations = new Map();
function activeNonMemberQuotaReservation(uid) {
  const id=String(uid), now=Date.now();
  const row=nonMemberQuotaReservations.get(id);
  if(!row) return 0;
  if(row.expiresAt<=now) { nonMemberQuotaReservations.delete(id); return 0; }
  return Math.max(0,Number(row.count)||0);
}
function reserveNonMemberQuota(uid,count) {
  const n=Math.max(0,Math.floor(Number(count)||0));
  if(!n || isAdmin(uid) || hasActivePremiumMembership(uid) || cachedRequiredGroupMembership(uid)===true) return;
  const id=String(uid), now=Date.now(), old=nonMemberQuotaReservations.get(id);
  const active=old && old.expiresAt>now ? Math.max(0,Number(old.count)||0) : 0;
  nonMemberQuotaReservations.set(id,{count:active+n,expiresAt:now+5*60*1000});
}
function releaseNonMemberQuotaReservation(uid,count) {
  const id=String(uid), row=nonMemberQuotaReservations.get(id);
  if(!row) return;
  if(row.expiresAt<=Date.now()) { nonMemberQuotaReservations.delete(id); return; }
  const left=Math.max(0,Number(row.count)||0)-Math.max(0,Math.floor(Number(count)||0));
  if(left<=0) nonMemberQuotaReservations.delete(id);
  else nonMemberQuotaReservations.set(id,{count:left,expiresAt:row.expiresAt});
}
function nonMemberDailyRemaining(uid) {
  // 指定群成员、管理员和兑换获得的有效会员均不限量；非会员按每日硬上限扣除已用及发送中的预留额度。
  if(isAdmin(uid) || hasActivePremiumMembership(uid) || cachedRequiredGroupMembership(uid)===true) return Infinity;
  return Math.max(0,nonMemberDailyLimit()-nonMemberDailyUsed(uid)-activeNonMemberQuotaReservation(uid));
}
function consumeNonMemberQuota(uid,count,reservationAlreadyReleased=false) {
  if(!reservationAlreadyReleased) releaseNonMemberQuotaReservation(uid,count);
  if(isAdmin(uid) || hasActivePremiumMembership(uid) || cachedRequiredGroupMembership(uid)===true || !(Number(count)>0)) return;
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

function resourceKey(item){return String(item?.chatId??"")+":"+String(item?.messageId??"");}
 // Avoid repeatedly requesting source messages already confirmed missing; keep DB records intact.
const unavailableOriginalMessageKeys = new Set();
function rememberUnavailableOriginal(item) {
  const key=resourceKey(item);
  if(!key || key.endsWith(":0")) return;
  unavailableOriginalMessageKeys.add(key);
  if(unavailableOriginalMessageKeys.size>5000) {
    const first=unavailableOriginalMessageKeys.values().next().value;
    unavailableOriginalMessageKeys.delete(first);
  }
}
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
function backupBotConfig(){
  const row=db.settings.backupBot||{};
  return {token:String(row.token||process.env.BACKUP_BOT_TOKEN||"").trim(), chatId:String(row.chatId||[...ADMIN_IDS][0]||"").trim(), username:String(row.username||"")};
}
async function backupBotApi(method, body){
  const cfg=backupBotConfig();
  if(!cfg.token) throw new Error("未配置备份机器人");
  return tg(cfg.token, method, body);
}
async function backupResourceFile(item){
  const cfg=backupBotConfig();
  if(!cfg.token || !cfg.chatId || item?.backupFileId) return;
  let fileId=item.fileId||"";
  let type=item.fileType||"Document";
  if(!fileId && item.chatId && item.messageId){
    const forwarded=await tg(TOKEN,"forwardMessage",{chat_id:cfg.chatId, from_chat_id:item.chatId, message_id:item.messageId});
    const media=forwarded?.document||forwarded?.video||forwarded?.audio||forwarded?.animation||forwarded?.voice||forwarded?.photo?.at?.(-1);
    fileId=media?.file_id||"";
    type=forwarded?.document?"Document":forwarded?.video?"Video":forwarded?.audio?"Audio":forwarded?.animation?"Animation":forwarded?.photo?"Photo":"Document";
    if(forwarded?.message_id) tg(TOKEN,"deleteMessage",{chat_id:cfg.chatId, message_id:forwarded.message_id}).catch(()=>{});
  }
  if(!fileId) throw new Error("仓库消息里没有可备份的文件");
  const info=await tg(TOKEN,"getFile",{file_id:fileId});
  if(!info?.file_path) throw new Error("主机器人取不到原文件");
  const url="https://api.telegram.org/file/bot"+TOKEN+"/"+info.file_path;
  const sent=await backupBotApi("send"+type, {chat_id:cfg.chatId, [type.toLowerCase()]:url, caption:String(item.caption||item.title||"").slice(0,200)});
  const file=sent?.document||sent?.video||sent?.audio||sent?.animation||sent?.photo?.at?.(-1)||sent?.photo?.[sent.photo.length-1];
  item.backupFileId=file?.file_id||"";
  item.backupMessageId=sent?.message_id||0;
  if(!item.backupFileId) throw new Error("备份机器人没有返回编号");
  saveDb();
}

async function backfillBackupBot(uid){
  if(globalThis.backupBackfillRunning) return;
  globalThis.backupBackfillRunning=true;
  let ok=0, fail=0, skip=0, lastError="";
  try{
    for(const item of db.resources||[]){
      if(item.backupFileId){ skip++; continue; }
      if(!item.fileId && !(item.chatId && item.messageId)){ skip++; continue; }
      try{ await backupResourceFile(item); ok++; }
      catch(e){ fail++; lastError=String(e?.message||e); console.warn("⚠️ 补备份失败:",lastError); }
      if((ok+fail)%10===0) saveDb();
      await sleep(400);
    }
    saveDb();
    await sendHtml(TOKEN,uid,"<b>✅ 现有文件补备份完成</b>\n\n成功：<b>"+ok+"</b>\n失败：<b>"+fail+"</b>\n跳过：<b>"+skip+"</b>"+(lastError?"\n\n最后错误："+escapeHtml(lastError):""),adminMenu());
  } finally { globalThis.backupBackfillRunning=false; }
}

async function restoreFromBackupBot(uid){
  const cfg=backupBotConfig();
  const r=repo();
  if(!cfg.token) throw new Error("未配置备份机器人");
  if(!r) throw new Error("未绑定资源仓库");
  let ok=0, fail=0;
  for(const item of db.resources||[]){
    if(!item.backupFileId) continue;
    try{
      const info=await backupBotApi("getFile",{file_id:item.backupFileId});
      const filePath=info?.file_path;
      if(!filePath) throw new Error("备份文件不存在");
      const url="https://api.telegram.org/file/bot"+cfg.token+"/"+filePath;
      const sent=await tg(TOKEN,"sendDocument",{chat_id:r.chatId, document:url, caption:String(item.caption||item.title||"").slice(0,200)});
      if(sent?.message_id){
        item.chatId=String(r.chatId);
        item.messageId=sent.message_id;
        item.fileId=sent.document?.file_id||item.fileId;
        ok++;
        if(ok%20===0) saveDb();
      }
    }catch(e){ fail++; console.warn("⚠️ 备份复制失败:",String(e?.message||e)); }
  }
  saveDb();
  await sendHtml(TOKEN,uid,"<b>✅ 备份复制完成</b>\n\n成功：<b>"+ok+"</b>\n失败：<b>"+fail+"</b>",adminMenu());
}
function adminStatusText(){
  const auth=db.settings.historyAuth||{};
  const cloud=cloud123Config();
  const sync=repositoryAutoSyncState();
  const supportCount=supportActiveSessions().length;
  const failed=db.resources.filter(x=>x.cloud123?.error && !x.cloud123?.uploaded).length;
  const sheets=Boolean(process.env.GOOGLE_SHEETS_WEBHOOK_URL||process.env.GOOGLE_SHEETS_ID);
  return [
    "<b>⚙️ 平台状态</b>",
    "━━━━━━━━━━━━━━",
    "",
    "📦 仓库："+(repo()?"✅ 正常":"❌ 未绑定"),
    "📁 文件夹："+db.directories.length+" 个",
    "📚 资源："+db.resources.length+" 个",
    "🔐 扫描账号："+(auth.session?"✅ 正常":"❌ 未登录"),
    "☁️ 123云盘："+(cloud.url&&cloud.username?"✅ 正常":"❌ 未配置")+(failed?"，失败 "+failed+" 个":""),
    "⚡ 自动同步："+(sync.enabled?"✅ 运行中":sync.sourceId?"⏸️ 已绑定未运行":"❌ 未绑定"),
    "📊 表格："+(sheets?"✅ 已配置":"❌ 未配置"),
    "🛟 备份机器人："+(backupBotConfig().token?"✅ 已配置":"❌ 未配置"),
    "💬 客服待处理："+supportCount+" 个",
    "",
    "👇 常用功能在下面"
  ].join("\n");
}
function adminRootInline(){return{inline_keyboard:[
 [{text:"📤 上传资源",callback_data:"admin:upload"},{text:"🔐 扫描账号",callback_data:"adm:scan_auth"}],
 [{text:"⚡ 自动同步",callback_data:"adm:auto"},{text:"☁️ 123云盘",callback_data:"adm:cloud123"}],
 [{text:"📦 资源目录",callback_data:"admin:resource"},{text:"💬 客服",callback_data:"support:admin"}],
 [{text:"🛟 备份机器人",callback_data:"admin:backupbot"},{text:"✅ 平台状态",callback_data:"admin:root"}],
 [{text:"更多",callback_data:"admin:more"}],
 [{text:"🏠 返回首页",callback_data:"admin:home"}]
]};}
function adminMoreInline(){return{inline_keyboard:[
 [{text:"📊 数据与运营",callback_data:"admin:ops"},{text:"⚙️ 系统设置",callback_data:"admin:settings"}],
 [{text:"🤖 机器人管理",callback_data:"admin:bot"},{text:"💬 在线客服",callback_data:"support:admin"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function adminResourceInline(){return{inline_keyboard:[
 [{text:"✏️ 修改文件夹",callback_data:"adm:rename"},{text:"🗑️ 删除资源",callback_data:"adm:delete"}],
 [{text:"🔄 移动资源",callback_data:"adm:move"},{text:"📦 批量管理",callback_data:"adm:bulk"}],
 [{text:"📦 资源仓库",callback_data:"adm:repo"},{text:"🔍 仓库扫描",callback_data:"adm:scan"}],
 [{text:"🔐 扫描账号",callback_data:"adm:scan_auth"},{text:"☁️ 123云盘",callback_data:"adm:cloud123"}],
 [{text:"⚡ 自动同步任务",callback_data:"adm:auto"}],
 [{text:"🏷️ 标签生成文件夹",callback_data:"adm:tagfolders"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function adminSettingsInline(){return{inline_keyboard:[
 [{text:"🔐 指定群管理",callback_data:"adm:group"},{text:"👥 管理员管理",callback_data:"adm:admins"}],
 [{text:"🎁 会员/配额设置",callback_data:"adm:quota"},{text:"🎟️ 兑换码管理",callback_data:"adm:redeem"}],
 [{text:"🛡️ 内容保护",callback_data:"adm:protect"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function redeemAdminInline(){return{inline_keyboard:[
 [{text:"➕ 批量生成兑换码",callback_data:"adm:redeem_make"}],
 [{text:"🚫 封禁会员并移出指定群",callback_data:"adm:redeem_ban"}],
 [{text:"✏️ 编辑兑换成功消息",callback_data:"adm:redeem_message"}],
 [{text:"⬅️ 返回系统设置",callback_data:"admin:settings"}]
]};}
function adminOpsInline(){return{inline_keyboard:[
 [{text:"📊 数据统计",callback_data:"adm:stats"},{text:"📢 广播消息",callback_data:"adm:broadcast"}],
 [{text:"💬 在线客服",callback_data:"support:admin"},{text:"📜 操作日志",callback_data:"adm:logs"}],
 [{text:"📌 广播后置顶",callback_data:"adm:pin"},{text:"📝 用户提示",callback_data:"admin:prompts"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function adminBotInline(){return{inline_keyboard:[
 [{text:"🤖 克隆机器人",callback_data:"adm:clone"}],
 [{text:"⬅️ 返回管理",callback_data:"admin:root"}]
]};}
function quotaSettingsText(){return"<b>🎁 会员 / 非会员每日资源额度</b>\\n━━━━━━━━━━━━━━\\n\\n👤 非会员每日最多获取：<b>"+nonMemberDailyLimit()+"</b> 个资源\\n📷 照片、🎬 视频、📄 文件均计入额度\\n💎 会员：资源不限量\\n🔄 每日自动重置\\n\\n👇 修改每日资源额度";}

function userHomeInlineKeyboard() {
  return {reply_markup:{inline_keyboard:[
    [{text:"📂 资源目录",callback_data:"user:dirs"},{text:"🔎 搜索资源",callback_data:"user:search"}],
    [{text:"🎲 随机获取",callback_data:"user:random"},{text:"🆕 最新资源",callback_data:"user:latest"}],
    [{text:"🎟️ 兑换码",callback_data:"user:redeem"},{text:"💬 联系客服",callback_data:"support:start"}]
  ]}};
}
function userMenu() {
  return userHomeInlineKeyboard();
}
function childMenu() {
  return userHomeInlineKeyboard();
}
function userHomeText(uid) {
  const groupMember = cachedRequiredGroupMembership(uid)===true;
  const premium = isAdmin(uid) || hasActivePremiumMembership(uid) || groupMember;
  const remaining = nonMemberDailyRemaining(uid);
  const quota = premium ? "💎 <b>会员状态：</b>不限量获取" : "🎁 <b>今日免费额度：</b>剩余 " + Math.max(0, Number(remaining) || 0) + " 个";
  const knownFolderIds = new Set(db.directories.map(d => String(d.id)));
  const folderCount = new Set(db.resources.filter(r => r && r.directoryId !== undefined && r.directoryId !== null && knownFolderIds.has(String(r.directoryId))).map(r => String(r.directoryId))).size;
  return "<b>🏠 资源平台</b>\n━━━━━━━━━━━━━━\n\n" +
    "📚 <b>资源总量：</b>" + db.resources.length + " 条\n" +
    "📁 <b>可浏览文件夹：</b>" + folderCount + " 个\n" + quota + "\n\n" +
    "📂 目录浏览 · 🔎 关键词搜索\n🎲 随机获取 · 🆕 最新资源\n\n" +
    "👇 <i>选择下方按钮开始使用</i>";
}
function uploadBottomKeyboard() { return {reply_markup:{keyboard:[["▶️ 继续上传","✅ 结束上传"],["❌ 取消上传"]],resize_keyboard:true,is_persistent:true}}; }
function childAdminMenu() {
  return {reply_markup:{inline_keyboard:[
    [{text:"📤 上传资源",callback_data:"admin:upload"}],
    [{text:"🏠 返回首页",callback_data:"admin:home"}]
  ]}};
}

function restoreUploadState(key) {
  const current = states.get(key);
  if (current?.step === "upload_file") return current;
  const saved = db.settings?.uploadSessions?.[key];
  if (!saved || String(saved.step)!=="upload_file") return current || null;
  const restored = {
    step: "upload_file",
    directoryId: String(saved.directoryId || ""),
    directoryName: String(saved.directoryName || ""),
    pendingUploads: (Array.isArray(saved.pendingMessageIds) ? saved.pendingMessageIds : []).map(id => ({messageId: Number(id)})).filter(x => Number.isFinite(x.messageId)),
    controlMessageId: Number(saved.controlMessageId || 0)
  };
  states.set(key, restored);
  return restored;
}
function uploadStateKey(uid, child=false, token="") {
  return child ? "c:"+tokenFingerprint(token)+":"+String(uid) : "m:"+String(uid);
}

async function receiveUploadMedia(token, uid, key, state, msg, child=false) {
  const media=msg?.document||msg?.video||msg?.audio||msg?.animation||msg?.photo?.at(-1)||msg?.voice||msg?.video_note;
  if(!media || !msg?.message_id) return false;
  if(!isAdmin(uid)) return false;
  if(!state || String(state.step)!=="upload_file") return false;
  if(!repo()) {
    states.delete(key);
    await sendHtml(token,uid,"<b>❌ 资源仓库未绑定</b>\n\n请先绑定资源仓库。",child?childAdminMenu():adminMenu()).catch(()=>{});
    return true;
  }

  let directoryId=state.directoryId;
  let directoryName=String(state.directoryName||"").trim();

  if(state.step==="upload_folder") {
    if(!directoryName) directoryName="未命名-"+Math.random().toString(36).slice(2,8);
    let d=getDirectoryByName(directoryName);
    if(!d) d=ensureDirectory(directoryName);
    if(!d) {
      states.delete(key);
      await sendHtml(token,uid,"<b>❌ 文件夹创建失败</b>\n\n请重新点击「📤 上传资源」再试。",child?childAdminMenu():adminMenu()).catch(()=>{});
      return true;
    }
    directoryId=d.id;
    directoryName=d.name;
  }

  if(!directoryId || !directoryName) return false;

  const pending=Array.isArray(state.pendingUploads)?state.pendingUploads:[];
  pending.push({messageId:Number(msg.message_id),msg});
  // 上传过程中不再使用“5分钟自动入库/已收到”第二条提醒。
  // 本批只由下面唯一的动态状态消息显示“已接收 N 个”，用户点击「结束上传」后才入库。
  if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }

  const nextUploadState={
    step:"upload_file",
    directoryId:String(directoryId),
    directoryName,
    pendingUploads:pending,
    controlMessageId:Number(state.controlMessageId||0)
  };
  states.set(key,nextUploadState);
  // 保存上传会话元数据，部署重启后也能继续接收并在结束时转存。
  if(db.settings && typeof db.settings==="object"){
    if(!db.settings.uploadSessions || typeof db.settings.uploadSessions!=="object") db.settings.uploadSessions={};
    db.settings.uploadSessions[String(key)]={
      step:"upload_file",
      directoryId:String(directoryId),
      directoryName,
      pendingMessageIds:pending.map(x=>Number(x.messageId)).filter(Number.isFinite),
      controlMessageId:Number(state.controlMessageId||0),
      updatedAt:Date.now()
    };
    saveDb();
  }
  // 上传过程中始终保留可操作按钮。旧版本只在第一次上传时创建控制消息，
  // 如果控制消息被删除/失效，后续文件只尝试 edit，按钮就会彻底消失。
  // 这里统一采用“先编辑，编辑失败就重新发送”的方式，确保每批都有「继续/结束/取消」。
  const statusText="📤 <b>正在上传</b>\n━━━━━━━━━━━━━━\n\n"+
    "📁 文件夹：<b>"+escapeHtml(directoryName)+"</b>\n"+
    "📥 已接收：<b>"+pending.length+"</b> 个\n\n"+
    "可以继续发送，数量会自动更新。全部发完后点「✅ 结束上传」。";
  const statusMarkup={inline_keyboard:[
    [{text:"✅ 结束上传",callback_data:"upload_finish"},{text:"❌ 取消上传",callback_data:"upload_cancel"}]
  ]};
  const saveUploadControlMessage=async(sent)=>{
    const current=states.get(key);
    if(!current || current.step!=="upload_file" || !sent?.message_id) return;
    current.controlMessageId=Number(sent.message_id);
    states.set(key,current);
    if(db.settings?.uploadSessions?.[key]) {
      db.settings.uploadSessions[key].controlMessageId=Number(sent.message_id);
      db.settings.uploadSessions[key].updatedAt=Date.now();
      saveDb();
    }
  };
  // 动态上传进度：整批只保留一条状态消息，每收到文件就编辑同一条消息。
  if(!globalThis.uploadStatusTimers) globalThis.uploadStatusTimers=new Map();
  if(globalThis.uploadStatusTimers.has(key)) clearTimeout(globalThis.uploadStatusTimers.get(key));
  globalThis.uploadStatusTimers.set(key,setTimeout(()=>{
    globalThis.uploadStatusTimers.delete(key);
    const current=states.get(key);
    if(!current || current.step!=="upload_file") return;
    const count=current.pendingUploads?.length||0;
    const text="📤 <b>正在上传</b>\n━━━━━━━━━━━━━━\n\n"+
      "📁 文件夹：<b>"+escapeHtml(current.directoryName)+"</b>\n"+
      "📥 已接收：<b>"+count+"</b> 个\n\n"+
      "可以继续发送，数量会自动更新。全部发完后点「✅ 结束上传」。";
    void (async()=>{
      try {
        // 同一批上传始终只允许一个进度更新任务运行，避免快速连发造成重复提示。
        if(current.statusUpdating) return;
        current.statusUpdating=true;
        states.set(key,current);
        // 重要规则：上传进度提示始终跟随“最后一条文件”。
        // 因此不能只编辑原消息；每收到新文件，就删除旧进度消息，
        // 再把唯一的新进度消息作为回复挂在最新文件下面。
        const latestMessageId=Number(current.pendingUploads?.at(-1)?.messageId||0);
        const oldControlId=Number(current.controlMessageId||0);
        if(oldControlId>0 && oldControlId!==latestMessageId) {
          try {
            await tg(token,"deleteMessage",{chat_id:uid,message_id:oldControlId});
          } catch(e) {
            console.warn("⚠️ 删除旧上传进度消息失败，继续创建新位置：",String(e?.message||e));
          }
        }
        let sent=null;
        try {
          sent=await sendHtml(token,uid,text,{
            reply_markup:statusMarkup,
            ...(latestMessageId>0 ? {reply_to_message_id:latestMessageId} : {})
          });
        } catch(e) {
          console.warn("⚠️ 创建跟随最后文件的上传进度消息失败：",String(e?.message||e));
        }
        if(sent) await saveUploadControlMessage(sent);
        current.statusUpdating=false;
        states.set(key,current);
      } catch(e) {
        current.statusUpdating=false;
        states.set(key,current);
        console.warn("⚠️ 上传进度更新失败:",String(e?.message||e));
      }
    })();
  },300));
  console.log("📥 UPLOAD MEDIA ACCEPTED:",{
    bot:child?"child":"main",
    uid:String(uid),
    folder:directoryName,
    messageId:Number(msg.message_id),
    pending:pending.length
  });

  // 不逐个回复；所有资源加入当前批次，点击「结束上传」后统一处理并统一回复结果。
  return true;
}

const replyKeyboardClearedChats = new Set();
async function ensureUserInlineMode(token, chatId) {
  const key = tokenFingerprint(token) + ":" + String(chatId);
  if (replyKeyboardClearedChats.has(key)) return;
  // Do not send a standalone invisible message to remove the old reply keyboard.
  // Telegram may reject it as "message text is empty"; when accepted it appears
  // as a blank message before the real menu. Inline keyboards work without it.
  replyKeyboardClearedChats.add(key);
}

function adminMenu(){return{reply_markup:adminRootInline()};}
function adminResourceMenu(){return{reply_markup:adminResourceInline()};}
function adminSettingsMenu(){return{reply_markup:adminSettingsInline()};}
function adminOpsMenu(){return{reply_markup:adminOpsInline()};}
function adminBotMenu(){return{reply_markup:adminBotInline()};}
function sortedDirectories(list=db.directories) {
  return (Array.isArray(list)?list:[]).slice().sort((a,b)=>{
    const at=Number(a?.createdAt||0), bt=Number(b?.createdAt||0);
    if(bt!==at) return bt-at;
    return String(b?.name||"").localeCompare(String(a?.name||""),"zh-Hans");
  });
}
function uploadFolderInlineMenu(page=0) {
  const latestUpload=id=>Math.max(0, ...(db.resources||[]).filter(r=>String(r.directoryId)===String(id)).map(r=>Number(r.indexedAt||r.date||r.createdAt||0)));
  const all=sortedDirectories().sort((a,b)=>latestUpload(b.id)-latestUpload(a.id) || Number(b.createdAt||0)-Number(a.createdAt||0));
  const pageSize=8;
  const totalPages=Math.max(1, Math.ceil(all.length/pageSize));
  const currentPage=Math.min(Math.max(0, Number(page)||0), totalPages-1);
  const current=all.slice(currentPage*pageSize, currentPage*pageSize+pageSize);
  const rows=[];
  let row=[];
  for(const d of current) {
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    const name=String(d.name||"未命名").trim() || "未命名";
    row.push({
      text:"📁 "+name.slice(0,18)+" · "+count,
      callback_data:"upload_dir:"+d.id
    });
    if(row.length===2) { rows.push(row); row=[]; }
  }
  if(row.length) rows.push(row);
  if(!rows.length) rows.push([{text:"📭 暂无文件夹",callback_data:"noop"}]);
  const nav=[];
  if(currentPage>0) nav.push({text:"⬅️ 上一页",callback_data:"upload_folder_page:"+(currentPage-1)});
  if(currentPage<totalPages-1) nav.push({text:"下一页 ➡️",callback_data:"upload_folder_page:"+(currentPage+1)});
  if(nav.length) rows.push(nav);
  rows.push([
    {text:"➕ 新建文件夹",callback_data:"upload_new"},
    {text:"🔄 刷新",callback_data:"upload_folder_refresh"},
    {text:"❌ 取消",callback_data:"upload_cancel"}
  ]);
  rows.push([{text:"第 "+(currentPage+1)+" / "+totalPages+" 页",callback_data:"noop"}]);
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

function platformMenu() {
  return adminSettingsMenu();
}
function getDirectoryByName(name) { const n=String(name||"").replace(/^📁\s*/,"").replace(/[（(]\s*\d+\s*[）)]\s*$/,"").replace(/\s+/g," ").trim().toLowerCase(); return db.directories.find(d=>{ const dn=String(d.name||"").replace(/[（(]\s*\d+\s*[）)]\s*$/,"").replace(/\s+/g," ").trim().toLowerCase(); return dn===n || String(d.name||"").trim().toLowerCase()===n; })||null; }
function extractResourceTags(item) {
  const text=String(item?.caption||"")+" "+String(item?.title||"")+" "+(Array.isArray(item?.tags)?item.tags.map(x=>"#"+String(x).replace(/^#/,"")).join(" "):"");
  const tags=[];
  const re=/[#＃]([\u4e00-\u9fff]{2,20})/g;
  let m;
  while((m=re.exec(text))) {
    const tag=String(m[1]||"").trim();
    if(!tag || tags.includes(tag)) continue;
    tags.push(tag);
  }
  return tags.slice(0,10);
}
function chineseFolderTag(tags) {
  return (Array.isArray(tags)?tags:[]).find(tag=>/^[一-鿿]{2,20}$/.test(String(tag||""))) || "";
}
function syncResourceFolderTag(item) {
  if(!item) return item;
  const current=db.directories.find(d=>String(d.id)===String(item.directoryId));
  const currentName=String(current?.name||"").trim();
  const previousAuto=String(item.autoTagFolder||"").trim();
  let tags=[...new Set((Array.isArray(item.tags)?item.tags:[]).map(x=>String(x||"").replace(/^#/,"").trim()).filter(Boolean))];
  if(previousAuto && previousAuto!==currentName) {
    const content=String(item.caption||"")+" "+String(item.title||"");
    if(!content.includes("#"+previousAuto) && !content.includes("＃"+previousAuto)) tags=tags.filter(x=>x!==previousAuto);
  }
  if(currentName && !tags.some(x=>String(x).trim()===currentName)) tags.unshift(currentName);
  item.tags=[...new Set(tags)].slice(0,10);
  item.autoTagFolder=currentName || "";
  return item;
}
const resourceTagQueue=new Set();
let resourceTagWorkerRunning=false;
function queueResourceFolderTag(item){
  if(!item) return;
  const chatId=String(item.chatId||"").trim(), messageId=String(item.messageId||"").trim();
  if(!chatId||!messageId) return;
  resourceTagQueue.add(chatId+":"+messageId);
  if(!resourceTagWorkerRunning){ resourceTagWorkerRunning=true; setImmediate(processResourceFolderTagQueue); }
}
async function processResourceFolderTagQueue(){
  try{
    let processed=0;
    while(resourceTagQueue.size && processed<50){
      const key=resourceTagQueue.values().next().value;
      resourceTagQueue.delete(key);
      const parts=String(key).split(":");
      const item=db.resources.find(x=>String(x.chatId)===String(parts[0])&&String(x.messageId)===String(parts[1]));
      if(item){
        try{ syncResourceFolderTag(item); queueBaserowResourceSync(item); }
        catch(e){ console.warn("⚠️ 后台文件夹标签处理失败:",String(e?.message||e)); }
      }
      processed++;
      await new Promise(resolve=>setImmediate(resolve));
    }
  }finally{
    if(resourceTagQueue.size) setImmediate(processResourceFolderTagQueue);
    else resourceTagWorkerRunning=false;
  }
}
function autoAssignResourceTagFolder(item) {
  if(!item) return null;
  const tags=extractResourceTags(item);
  if(tags.length) item.tags=tags;
  const tag=chineseFolderTag(tags);
  if(!tag) {
    queueResourceFolderTag(item);
    return item.directoryId ? (db.directories.find(d=>String(d.id)===String(item.directoryId)) || null) : null;
  }
  const current=db.directories.find(d=>String(d.id)===String(item.directoryId));
  if(current && String(current.name||"")===tag) {
    queueResourceFolderTag(item);
    return current;
  }
  const folder=ensureDirectory(tag);
  if(folder) {
    item.directoryId=String(folder.id);
    item.autoTagFolder=tag;
    queueResourceFolderTag(item);
  }
  return folder;
}
function isBaserowFolderMarkerRow(row, fields) {
  if(!row || !Array.isArray(fields)) return false;
  const titleField=baserowPickField(fields,["名称","资源名称","标题","资源","Name","Title","Resource","资源标题"]);
  const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
  const messageField=baserowPickField(fields,["消息ID","资源ID","Message ID","MessageID"]);
  const title=titleField ? String(row?.[titleField.name]??"").trim() : "";
  if(title.startsWith("__FOLDER__:")) return true;
  const messageValue=messageField ? String(row?.[messageField.name]??"").trim() : "";
  const folderName=folderField ? sharedFolderName(row?.[folderField.name]) : "";
  return messageValue==="0" && Boolean(folderName);
}


async function deleteAllFoldersKeepResources() {
  let folders=0, resources=0, errors=0;
  if(GOOGLE_SHEETS_CREDENTIAL && GOOGLE_SHEETS_ID) {
    try {
      const fields=await getBaserowFields(true);
      const rows=await listAllBaserowRows();
      const folderField=baserowPickField(fields,["文件夹","目录","分类","Folder","Directory","Category"]);
      const markerRows=[];
      const resourceRows=[];
      for(const row of rows) {
        if(!row?.id) continue;
        if(isBaserowFolderMarkerRow(row,fields)) markerRows.push(row);
        else if(folderField && sharedFolderName(row?.[folderField.name])) resourceRows.push(row);
      }

      // Google Sheets 文件夹可能有上千条，不能一条一条串行删除，否则 Telegram 看起来会像“没反应”。
      const worker=async(list, handler)=>{
        let index=0;
        const concurrency=Math.min(12,Math.max(1,list.length));
        await Promise.all(Array.from({length:concurrency},async()=>{
          while(true){
            const n=index++;
            if(n>=list.length) return;
            try { await handler(list[n]); }
            catch(e) { errors++; console.warn("⚠️ Google Sheets 批量处理失败:",String(e?.message||e)); }
          }
        }));
      };

      await worker(markerRows,async(row)=>{
        await baserowRequest("DELETE","/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/"+encodeURIComponent(row.id)+"/");
        baserowRowsCache.delete(String(row.id));
        folders++;
      });

      await worker(resourceRows,async(row)=>{
        await baserowRequest("PATCH","/api/database/rows/table/"+encodeURIComponent(GOOGLE_SHEETS_ID)+"/"+encodeURIComponent(row.id)+"/?user_field_names=true",{[folderField.name]:null});
        baserowRowsCache.delete(String(row.id));
        resources++;
      });
    } catch(e) {
      errors++;
      console.error("❌ 删除所有 Google Sheets 文件夹失败:",String(e?.message||e));
    }
  }

  for(const item of (db.resources||[])) {
    if(item.directoryId || item.autoTagFolder) {
      item.directoryId=null;
      item.autoTagFolder=null;
      resources++;
      queueBaserowResourceSync(item);
    }
  }
  db.directories=[];
  touchSharedData("system");
  saveDb();
  return {folders,resources,errors};
}

function autoCreateTagFoldersForExistingResources() {
  let created=0, assigned=0, removed=0;
  const badIds=new Set();
  for(const d of db.directories||[]) {
    const name=String(d.name||"");
    const items=(db.resources||[]).filter(x=>String(x.directoryId)===String(d.id));
    if(items.length===1 && String(items[0].title||"")===name && !extractResourceTags(items[0]).includes(name)) badIds.add(String(d.id));
  }
  if(badIds.size) {
    db.directories=(db.directories||[]).filter(d=>!badIds.has(String(d.id)));
    for(const item of db.resources||[]) if(badIds.has(String(item.directoryId||""))) { item.directoryId=null; item.autoTagFolder=""; removed++; }
  }
  const groups=new Map();
  for(const item of db.resources||[]) {
    const key=String(item.mediaGroupId||("single:"+item.chatId+":"+item.messageId));
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for(const items of groups.values()) {
    const tag=items.map(item=>chineseFolderTag(extractResourceTags(item))).find(Boolean);
    if(!tag) continue;
    const existed=Boolean(getDirectoryByName(tag));
    const folder=ensureDirectory(tag);
    if(!folder) continue;
    if(!existed) created++;
    for(const item of items) {
      const before=String(item.directoryId||"");
      if(before===String(folder.id)) continue;
      item.directoryId=String(folder.id);
      item.autoTagFolder=tag;
      item.tags=extractResourceTags(item);
      assigned++;
      queueBaserowResourceSync(item);
    }
  }
  saveDb();
  touchSharedData("system");
  return {created,assigned,removed};
}
function repairLocalFolders() {
  normalizeSharedDirectories();
  const folders=(db.directories||[]).filter(d=>String(d.name||"").trim());
  let linked=0;
  for(const item of db.resources||[]) {
    if(folders.some(d=>String(d.id)===String(item.directoryId))) continue;
    const blob=(String(item.title||"")+" "+String(item.caption||"")).toLowerCase();
    const hit=folders.find(d=>blob.includes(String(d.name||"").trim().toLowerCase()));
    if(hit) { item.directoryId=hit.id; linked++; }
  }
  if(linked) saveDb();
  console.log("本地文件夹归类完成: 归入="+linked+" 有资源的文件夹="+folders.filter(d=>db.resources.some(r=>String(r.directoryId)===String(d.id))).length);
}
function ensureDirectory(name, description="") {
  const clean=String(name||"").trim().slice(0,80);
  if(!clean)return null;
  const cleanDescription=String(description||"").trim().slice(0,300);
  let d=getDirectoryByName(clean);
  if(d) {
    if(cleanDescription && String(d.description||"").trim()!==cleanDescription) {
      d.description=cleanDescription;
      touchSharedData("system");
      queueBaserowDirectorySync(d);
      saveDb();
    }
    return d;
  }
  d={id:sharedDirectoryId(clean),name:clean,description:cleanDescription,createdAt:Date.now()};
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
  for(const d of sortedDirectories()) {
    if(excludeId && String(d.id)===String(excludeId)) continue;
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    rows.push([{text:"📁 "+String(d.name||"未命名").slice(0,28)+" · "+count,callback_data:"move_to:"+d.id}]);
  }
  if(!rows.length) rows.push([{text:"📭 没有其他文件夹",callback_data:"noop"}]);
  rows.push([{text:"❌ 取消",callback_data:"move_cancel"}]);
  return {inline_keyboard:rows};
}
function childFolderManageMenu(directoryId) {
  const d=db.directories.find(x=>String(x.id)===String(directoryId));
  if(!d) return {inline_keyboard:[[{text:"⬅️ 返回文件夹",callback_data:"admin:upload"}]]};
  const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
  return {inline_keyboard:[
    [{text:"📤 继续上传",callback_data:"folder_manage_upload:"+d.id}],
    [{text:"📂 查看资源",callback_data:"folder_manage_view:"+d.id}],
    [{text:"⬅️ 返回文件夹列表",callback_data:"admin:upload"}]
  ]};
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
  for(const d of sortedDirectories()) {
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
async function finalizeUploadUnlocked(uid, state, token=TOKEN, stateKey=uploadStateKey(uid,false,TOKEN), menu=adminMenu()) {
  const items=Array.isArray(state?.pendingUploads)?state.pendingUploads:[];
  if(!items.length){
    states.delete(stateKey);
    return send(token,uid,"📭 <b>本次没有收到资源</b>\\n\\n当前批次没有可入库的资源。",menu);
  }
  const r=repo();
  if(!r){
    states.delete(stateKey);
    return send(token,uid,"❌ <b>资源仓库未绑定</b>\\n\\n请先绑定资源仓库，再进行上传。",menu);
  }

  let directoryName=String(state.directoryName||"").trim();
  if(!directoryName) directoryName="未命名-"+Math.random().toString(36).slice(2,8);
  const d=ensureDirectory(directoryName);
  if(!d){
    states.delete(stateKey);
    return send(token,uid,"❌ <b>文件夹创建失败</b>\\n\\n请稍后重试。",menu);
  }

  let stored=0,failed=0;
  const sortedItems=[...items].sort((a,b)=>Number(a.messageId)-Number(b.messageId));

  // 批量转存：每批最多100条；批量失败时只对失败批次逐条兜底。
  const TELEGRAM_COPY_BATCH_SIZE=100;
  for(let offset=0;offset<sortedItems.length;offset+=TELEGRAM_COPY_BATCH_SIZE){
    const batch=sortedItems.slice(offset,offset+TELEGRAM_COPY_BATCH_SIZE);
    const ids=batch.map(x=>Number(x.messageId)).filter(Number.isFinite);
    if(!ids.length) continue;
    let copiedIds=null;

    try{
      copiedIds=await tg(token,"copyMessages",{
        chat_id:r.chatId,
        from_chat_id:uid,
        message_ids:ids,
        protect_content:false
      });
      if(!Array.isArray(copiedIds)||copiedIds.length!==batch.length) throw new Error("批量转存结果数量不一致");
    }catch(e){
      console.warn("⚠️ UPLOAD BATCH COPY FAILED:",e?.message||e,"count=",batch.length);
      for(const entry of batch){
        try{
          const copied=await tg(token,"copyMessage",{
            chat_id:r.chatId,
            from_chat_id:uid,
            message_id:Number(entry.messageId),
            protect_content:false
          });
          const copiedId=Number(copied?.message_id);
          if(!Number.isFinite(copiedId)) throw new Error("逐条转存消息ID无效");
          const resourceMsg={
            ...(entry.msg||{}),
            chat:{...(entry.msg?.chat||{}),id:r.chatId,title:r.title||entry.msg?.chat?.title||r.chatId,username:r.username||entry.msg?.chat?.username||"",type:r.type||"supergroup"},
            message_id:copiedId
          };
          const item={...(entry.msg||{}),chatId:String(r.chatId),messageId:copiedId,title:String(entry.msg?.document?.file_name||entry.msg?.video?.file_name||entry.msg?.audio?.file_name||entry.msg?.caption||entry.msg?.text||"未命名资源").slice(0,200),caption:String(entry.msg?.caption||entry.msg?.text||"").slice(0,500),date:entry.msg?.date||Math.floor(Date.now()/1000),indexedAt:Date.now(),directoryId:d.id,repositoryMessageId:copiedId,sourceUserId:String(uid),mediaGroupId:entry.msg?.media_group_id?String(entry.msg.media_group_id):"",downloads:0};
          queueResourceFolderTag(item);
          const existingIndex=db.resources.findIndex(x=>String(x.chatId)===String(r.chatId)&&Number(x.messageId)===copiedId);
          if(existingIndex>=0) db.resources[existingIndex]={...db.resources[existingIndex],...item,directoryId:d.id}; else db.resources.unshift(item);
          db.resources=db.resources.slice(0,MAX_RESOURCES);
          const savedItem=db.resources.find(x=>String(x.chatId)===String(r.chatId)&&Number(x.messageId)===copiedId);
          if(!savedItem||String(savedItem.directoryId)!==String(d.id)) throw new Error("资源文件夹关联写入失败");
          queueBaserowResourceSync(savedItem); stored++;
        }catch(err){ failed++; console.error("❌ UPLOAD RESOURCE FALLBACK:",err?.message||err,"sourceMessage=",entry?.messageId); }
      }
      continue;
    }

    for(let n=0;n<batch.length;n++){
      try{
        const copiedId=Number(copiedIds[n]?.message_id??copiedIds[n]);
        if(!Number.isFinite(copiedId)) throw new Error("批量转存消息ID无效");
        const resourceMsg={
          ...(batch[n].msg||{}),
          chat:{...(batch[n].msg?.chat||{}),id:r.chatId,title:r.title||batch[n].msg?.chat?.title||r.chatId,username:r.username||batch[n].msg?.chat?.username||"",type:r.type||"supergroup"},
          message_id:copiedId
        };
        const item={...(batch[n].msg||{}),chatId:String(r.chatId),messageId:copiedId,title:String(batch[n].msg?.document?.file_name||batch[n].msg?.video?.file_name||batch[n].msg?.audio?.file_name||batch[n].msg?.caption||batch[n].msg?.text||"未命名资源").slice(0,200),caption:String(batch[n].msg?.caption||batch[n].msg?.text||"").slice(0,500),date:batch[n].msg?.date||Math.floor(Date.now()/1000),indexedAt:Date.now(),directoryId:d.id,repositoryMessageId:copiedId,sourceUserId:String(uid),mediaGroupId:batch[n].msg?.media_group_id?String(batch[n].msg.media_group_id):"",downloads:0};
        queueResourceFolderTag(item);
        const existingIndex=db.resources.findIndex(x=>String(x.chatId)===String(r.chatId)&&Number(x.messageId)===copiedId);
        if(existingIndex>=0) db.resources[existingIndex]={...db.resources[existingIndex],...item,directoryId:d.id}; else db.resources.unshift(item);
        db.resources=db.resources.slice(0,MAX_RESOURCES);
        const savedItem=db.resources.find(x=>String(x.chatId)===String(r.chatId)&&Number(x.messageId)===copiedId);
        if(!savedItem||String(savedItem.directoryId)!==String(d.id)) throw new Error("资源文件夹关联写入失败");
        queueBaserowResourceSync(savedItem); stored++;
      }catch(e){
        failed++;
        console.error("❌ UPLOAD RESOURCE INDEX:",e?.message||e,"sourceMessage=",batch[n]?.messageId);
      }
    }
  }

  // Telegram 仓库转存完成后，再等待 Google Sheets 同步队列；临时上传会话最后才清理。
  // 正式资源记录和 Telegram 仓库消息不会被这里删除。
  let sheetSync="未配置";
  if(GOOGLE_SHEETS_CREDENTIAL && GOOGLE_SHEETS_ID) {
    sheetSync="⏳ 后台同步中";
    waitBaserowSyncQueue().catch(e=>console.warn("⚠️ 上传后的表格同步失败：",String(e?.message||e)));
  }
  recordStat(uid,"upload",1);
  if(backupBotConfig().token) { for(const item of db.resources.slice(0,stored)) backupResourceFile(item).catch(e=>console.warn("⚠️ 备份文件失败:",String(e?.message||e))); }
  recordStat(uid,"uploadedResource",stored);
  touchSharedData(uid);
  saveDb();
  logAdmin(uid,"结束上传",d.name+" / 收到"+items.length+" / 入库"+stored+" / 表格"+sheetSync+" / 失败"+failed);
  if(db.settings?.uploadSessions?.[stateKey]) {
    delete db.settings.uploadSessions[stateKey];
    saveDb();
  }
  states.delete(stateKey);

  const doneText="<b>📦 本批上传完成</b>\n━━━━━━━━━━━━━━\n\n"+
    "📁 文件夹：<b>"+escapeHtml(d.name)+"</b>\n"+
    "📥 收到：<b>"+items.length+"</b> 个\n"+
    "✅ 成功入库：<b>"+stored+"</b> 个\n"+
    "❌ 失败：<b>"+failed+"</b> 个\n"+
    "📊 表格："+sheetSync;
  const controlId=Number(state.controlMessageId||0);
  if(controlId>0) {
    const edited=await safeEdit(token,{chat_id:uid,message_id:controlId,text:doneText,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}});
    if(edited) return edited;
  }
  return sendHtml(token,uid,doneText,menu);
}
async function finalizeUpload(uid, state, token=TOKEN, stateKey=uploadStateKey(uid,false,TOKEN), menu=adminMenu()) {
  const lockKey=tokenFingerprint(token)+":"+String(uid);
  if(finalizingUploads.has(lockKey)) return send(token,uid,"⏳ 正在整理本批资源，请不要重复点击结束上传。");
  finalizingUploads.add(lockKey);
  try {
    return await finalizeUploadUnlocked(uid,state,token,stateKey,menu);
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

function directoryInlineKeyboard(page=0) {
  // 先一次遍历统计每个文件夹的资源数，避免“每个文件夹都扫描全部资源”的重复 O(文件夹×资源) 开销。
  const counts=new Map();
  for(const r of db.resources) {
    if(r?.directoryId===undefined || r?.directoryId===null) continue;
    const key=String(r.directoryId);
    counts.set(key,(counts.get(key)||0)+1);
  }
  const all=sortedDirectories(db.directories.filter(d=>(counts.get(String(d.id))||0)>0));
  const pageSize=10;
  const maxPage=Math.max(0,Math.ceil(all.length/pageSize)-1);
  const currentPage=Math.min(Math.max(0,Number(page)||0),maxPage);
  const start=currentPage*pageSize;
  const current=all.slice(start,start+pageSize);
  const rows=[];
  let row=[];
  for(const d of current){
    const count=counts.get(String(d.id))||0;
    row.push({text:"📁 "+String(d.name||"未命名").slice(0,18)+" · "+count,callback_data:"dir:"+d.id+":0"});
    if(row.length===3){ rows.push(row); row=[]; }
  }
  if(row.length) rows.push(row);
  if(!rows.length) rows.push([{text:"📭 暂无分类",callback_data:"noop"}]);
  const nav=[];
  if(start>0) nav.push({text:"⬅️ 上一页",callback_data:"dirsp:"+(currentPage-1)});
  if(start+pageSize<all.length) nav.push({text:"下一页 ➡️",callback_data:"dirsp:"+(currentPage+1)});
  if(nav.length) rows.push(nav);
  rows.push([{text:"⬅️ 返回首页",callback_data:"user:home"}]);
  return {inline_keyboard:rows};
}
function folderSummaryKeyboard(directoryId,count,offset=0) {
  const rows=[];
  if(offset<count) {
    rows.push([{
      text:offset===0?"📦 获取全部资源":"📦 获取剩余资源",
      callback_data:"get:"+directoryId+":"+offset
    }]);
  }
  if(offset>0) rows.push([{text:"⬅️ 返回资源目录",callback_data:"dirs"}]);
  return {inline_keyboard:rows};
}
function folderProgressKeyboard(directoryId,count,nextOffset) {
  const rows=[];
  if(nextOffset<count) rows.push([{text:"🎲 再来一组",callback_data:"get:"+directoryId+":"+nextOffset}]);
  rows.push([{text:"⬅️ 返回目录",callback_data:"dirs"}]);
  return {inline_keyboard:rows};
}
function directoryItems(id) { return db.resources.filter(r=>String(r.directoryId)===String(id)).sort((a,b)=>Number(a.messageId)-Number(b.messageId)); }
function directoryBatchItems(all, offset=0, limit=10, preserveAlbum=true) {
  const list=Array.isArray(all)?all:[];
  let i=Math.max(0,Number(offset)||0);
  const picked=[];
  if(preserveAlbum && i>0 && i<list.length && list[i]?.mediaGroupId && String(list[i-1]?.mediaGroupId||"")===String(list[i]?.mediaGroupId||"")) {
    const groupId=String(list[i].mediaGroupId);
    while(i>0 && String(list[i-1]?.mediaGroupId||"")===groupId) i--;
  }
  while(i<list.length) {
    const item=list[i], groupId=String(item?.mediaGroupId||"");
    let end=i+1;
    if(groupId) while(end<list.length && String(list[end]?.chatId||"")===String(item?.chatId||"") && String(list[end]?.mediaGroupId||"")===groupId) end++;
    const size=end-i;
    if(picked.length && picked.length+size>limit) break;
    picked.push(...list.slice(i,end));
    i=end;
    if(picked.length>=limit) break;
  }
  return {items:picked,nextOffset:i};
}
async function sendDirectoryBatch(token, chatId, items) {
  const valid=(Array.isArray(items)?items:[]).filter(item=>{
    const currentRepo=repo();
    const ok=Boolean(currentRepo&&String(currentRepo.chatId||"")===String(item?.chatId||""));
    if(!ok) console.warn("⏭️ 文件夹批量发送：资源仓库已解绑/已切换，跳过旧资源 chat=",String(item?.chatId||""),"resource=",String(item?.messageId||""));
    return ok;
  });
  if(!valid.length)return {sent:0,sentItems:[]};
  try {
    const result=await sendResourceAlbum(token,chatId,valid);
    return {sent:Number(result?.sent||0),sentItems:Array.isArray(result?.sentItems)?result.sentItems:[]};
  } catch(e) {
    const desc=String(e?.telegramDescription||e?.message||e||"");
    console.error("DIRECTORY SEND:",desc);
    if(/bot was kicked|kicked from the supergroup|bot is not a member|forbidden:.*(?:chat|group|channel)|机器人被踢|禁止访问/i.test(desc)) {
      const currentRepo=repo(),badChat=String(currentRepo?.chatId||"").trim();
      if(currentRepo&&badChat) {
        const removed=(Array.isArray(db.resources)?db.resources:[]).filter(x=>String(x?.chatId||"")===badChat);
        db.resources=db.resources.filter(x=>String(x?.chatId||"")!==badChat);
        db.settings.repository=null;
        db.settings.resourceSources=Array.isArray(db.settings.resourceSources)?db.settings.resourceSources.filter(x=>String(x?.chatId||"")!==badChat):[];
        saveDb();
        console.warn("🧹 文件夹批量发送：仓库访问失效，已自动解绑并清理资源 chat=",badChat,"removed=",removed.length);
      }
    }
    return {sent:0,sentItems:[]};
  }
}
function directoryText(page=0) {
  const counts = new Map();
  for (const r of db.resources) {
    if (r?.directoryId === undefined || r?.directoryId === null) continue;
    const key = String(r.directoryId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const activeDirectories = db.directories.filter(d => (counts.get(String(d.id)) || 0) > 0);
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(activeDirectories.length / pageSize));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  return [
    "📂 <b>资源目录</b>", "━━━━━━━━━━━━━━", "",
    "📚 总资源：<b>" + db.resources.length + "</b> 条",
    "📁 有资源的文件夹：<b>" + activeDirectories.length + "</b> 个",
    "📄 当前页：<b>" + (current + 1) + " / " + pages + "</b>", "",
    activeDirectories.length ? "👇 <i>点击文件夹名称查看资源</i>" : "📭 <i>暂时没有可浏览的文件夹</i>"
  ].join("\n");
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
    indexedAt:Date.now(),
    mediaGroupId:msg.media_group_id ? String(msg.media_group_id) : "",
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
  const savedResource=db.resources.find(x=>x.chatId===item.chatId&&x.messageId===item.messageId) || item;
  queueResourceFolderTag(savedResource);
  queueBaserowResourceSync(savedResource);
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
  if(mins<=0) return;
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
    deletion
      ? "📌 用户获取的资源将在 "+autoDeleteText()+" 后自动删除，与内容保护开关独立。"
      : "💡 自动删除已关闭；可单独设置删除时间，不影响内容保护。" 
  ].join("\\n");
}
function expandOriginalAlbumItems(items) {
  const selected=Array.isArray(items)?items:[];
  const out=[],seen=new Set();
  // 单次目录/随机/最新获取结果较多时可使用分页资源；相册按完整组加入，
  // 不允许一个脏 mediaGroupId 把一次点击扩成几十条。
  const MAX_ITEMS=10;
  for(const item of selected) {
    if(!item || out.length>=MAX_ITEMS) continue;
    const key=resourceKey(item);
    if(seen.has(key)) continue;
    const groupId=String(item.mediaGroupId||"");
    let album=[item];
    if(groupId) {
      const members=db.resources
        .filter(x=>String(x?.chatId||"")===String(item.chatId||"")&&String(x?.mediaGroupId||"")===groupId&&Number(x?.messageId)>0)
        .sort((a,b)=>Number(a.messageId)-Number(b.messageId));
      const selectedIndex=members.findIndex(x=>resourceKey(x)===key);
      if(selectedIndex>=0) {
        let left=selectedIndex,right=selectedIndex;
        while(left>0 && Number(members[left].messageId)===Number(members[left-1].messageId)+1 && right-left+1<10) left--;
        while(right+1<members.length && Number(members[right+1].messageId)===Number(members[right].messageId)+1 && right-left+1<10) right++;
        const contiguous=members.slice(left,right+1);
        if(contiguous.length) album=contiguous;
      }
    }
    // 保持相册完整：剩余名额不够时跳过整组，而不是发送残缺相册。
    const uniqueAlbum=album.filter(member=>!seen.has(resourceKey(member)));
    if(!uniqueAlbum.length) continue;
    if(out.length+uniqueAlbum.length>MAX_ITEMS) {
      if(out.length===0) {
        for(const member of uniqueAlbum.slice(0,MAX_ITEMS)) {
          const memberKey=resourceKey(member);
          if(!seen.has(memberKey)){seen.add(memberKey);out.push(member);}
        }
      }
      continue;
    }
    for(const member of uniqueAlbum) {
      const memberKey=resourceKey(member);
      if(!seen.has(memberKey)){seen.add(memberKey);out.push(member);}
    }
  }
  return out.slice(0,MAX_ITEMS);
}
async function sendResourceAlbum(token, chatId, items, options={}) {
  // 原样复制仓库消息：只把仓库里本来属于同一相册的连续消息一起复制，
  // 不按文件类型重新排序，不把独立照片/视频拼成新相册。
  const inputItems=Array.isArray(items)?items:[];
  const valid=inputItems
    .filter(x=>x&&x.chatId!==undefined&&x.chatId!==null&&String(x.chatId).trim()&&Number(x.messageId)>0)
    .filter(x=>!unavailableOriginalMessageKeys.has(resourceKey(x)))
    .sort((a,b)=>{
      const sameChat=String(a.chatId)===String(b.chatId);
      return sameChat?Number(a.messageId)-Number(b.messageId):0;
    });
  const skippedUnavailable=inputItems.filter(x=>x&&unavailableOriginalMessageKeys.has(resourceKey(x))).length;
  if(!valid.length) return {sent:0,lastMessageId:0,failed:skippedUnavailable,sentItems:[]};
  let sent=0,lastMessageId=0,failed=skippedUnavailable;
  const sentItems=[];
  for(let i=0;i<valid.length;) {
    const item=valid[i];
    const groupId=String(item.mediaGroupId||"");
    const group=[];
    let j=i;
    if(groupId && options.singleEach!==true) {
      while(j<valid.length &&
        String(valid[j].chatId)===String(item.chatId) &&
        String(valid[j].mediaGroupId||"")===groupId &&
        Number(valid[j].messageId)===Number(item.messageId)+(j-i)) {
        group.push(valid[j]); j++;
      }
    }
    try {
      let copied;
      if(group.length>=2) {
        copied=await tg(token,"copyMessages",{
          chat_id:chatId,
          from_chat_id:String(item.chatId),
          message_ids:group.map(x=>Number(x.messageId)),
          ...(contentProtectionEnabled()?{protect_content:true}:{})
        });
        const ids=Array.isArray(copied)?copied.filter(x=>x&&x.message_id):[];
        sent+=ids.length;
        sentItems.push(...group.slice(0,ids.length));
        if(ids.length) lastMessageId=Number(ids[ids.length-1].message_id)||lastMessageId;
        if(ids.length<group.length) failed+=group.length-ids.length;
        for(const id of ids) scheduleAutoDelete(token,chatId,[id.message_id]);
        i=j;
        continue;
      }
      copied=await tg(token,"copyMessage",{
        chat_id:chatId,
        from_chat_id:String(item.chatId),
        message_id:Number(item.messageId),
        ...(contentProtectionEnabled()?{protect_content:true}:{})
      });
      if(copied&&copied.message_id) {
        sent++; sentItems.push(item);
        lastMessageId=Number(copied.message_id)||lastMessageId;
        scheduleAutoDelete(token,chatId,[copied.message_id]);
      } else failed++;
    } catch(e) {
      const errorText=String(e?.telegramDescription||e?.message||e||"");
      const missingOriginal=/message to copy not found|message_id_invalid|message not found/i.test(errorText);
      // 原始仓库消息无法复制时，若仍保存可用 file_id，则尝试重新发送，不删除资源记录。
      const fallbackItems=group.length>=2?group:[item];
      const canFallback=missingOriginal && fallbackItems.every(x=>
        x && x.fileId && x.fileType &&
        ["photo","video","document","audio"].includes(String(x.fileType).toLowerCase())
      );
      if(canFallback) {
        try {
          if(fallbackItems.length>=2) {
            const media=fallbackItems.map(x=>({
              type:String(x.fileType).toLowerCase(),
              media:x.fileId,
              ...(x.caption?{caption:String(x.caption).slice(0,1024)}:{})
            }));
            const sentMessages=await tg(token,"sendMediaGroup",{
              chat_id:chatId,
              media,
              ...(contentProtectionEnabled()?{protect_content:true}:{})
            });
            const ids=Array.isArray(sentMessages)?sentMessages.filter(x=>x&&x.message_id):[];
            sent+=ids.length;
            sentItems.push(...fallbackItems.slice(0,ids.length));
            if(ids.length) lastMessageId=Number(ids[ids.length-1].message_id)||lastMessageId;
            failed+=Math.max(0,fallbackItems.length-ids.length);
            for(const sentMessage of ids) scheduleAutoDelete(token,chatId,[sentMessage.message_id]);
          } else {
            const fallback=await sendIndexedResource(token,chatId,item);
            if(fallback&&fallback.message_id) {
              sent++;
              sentItems.push(item);
              lastMessageId=Number(fallback.message_id)||lastMessageId;
            } else failed++;
          }
          console.warn("⚠️ 原始消息无法复制，已尝试使用保存的 file_id 发送替代内容：",
            "sourceChat=",item.chatId,"message=",item.messageId,"count=",fallbackItems.length);
        } catch(fallbackError) {
          failed+=fallbackItems.length;
          console.error("RESOURCE FALLBACK FAILED:",String(fallbackError?.telegramDescription||fallbackError?.message||fallbackError),
            "sourceChat=",item.chatId,"message=",item.messageId,"mediaGroupId=",groupId||"none");
        }
      } else {
        failed+=Math.max(1,group.length);
        if(missingOriginal) {
          for(const failedItem of (group.length?group:[item])) rememberUnavailableOriginal(failedItem);
        }
        console.error("ORIGINAL MESSAGE COPY FAILED:",errorText,
          "sourceChat=",item.chatId,"message=",item.messageId,"mediaGroupId=",groupId||"none",
          missingOriginal?"| added to process-local skip list to prevent repeated Telegram requests":"");
      }
    }
    i+=group.length>=2?group.length:1;
  }
  return {sent,lastMessageId,failed,sentItems};
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

function withoutVideosForGuest(items, member, uid, expandAlbums=true) {
  const raw=Array.isArray(items)?items:[];
  // random 模式明确允许单条发送；其他模式继续保留原有相册成组逻辑。
  const expanded=expandAlbums?expandOriginalAlbumItems(raw):raw;
  if(member || isAdmin(uid) || hasActivePremiumMembership(uid)) return {items:expanded,blocked:0,allowed:expanded.length};
  // 每日 3 个是全部资源的硬上限；视频额外额度不能绕过该上限。
  const remaining=nonMemberDailyRemaining(uid);
  const limit=remaining===Infinity?expanded.length:Math.max(0,remaining);
  const kept=expanded.slice(0,limit);
  // 预留只覆盖本次准备发送的条目；成功后转为已用额度，发送异常时最多 5 分钟自动释放。
  if(kept.length) reserveNonMemberQuota(uid,kept.length);
  return {items:kept,blocked:Math.max(0,expanded.length-kept.length),allowed:kept.length};
}
async function guestVideoNotice(token, chatId) {
  return sendHtml(token, chatId, "<b>🎁 今日免费资源额度已用完</b>\n\n非会员每天最多成功获取 <b>"+nonMemberDailyLimit()+"</b> 个资源，照片、视频和其他文件都计入额度。\n明天自动恢复；加入指定会员群后可不限量获取。", userMenu());
}
function consumeVideoQuota(uid,items){
  const list=Array.isArray(items)?items:[];
  if(!list.length) return;
  // 发送成功后先释放本批预留，再按原有规则记账；不改变每日额度数值或会员规则。
  releaseNonMemberQuotaReservation(uid,list.length);
  if(isAdmin(uid) || hasActivePremiumMembership(uid) || cachedRequiredGroupMembership(uid)===true) return;
  const bonusVideos=list.filter(item=>item?.__bonusVideoQuota===true).length;
  const baseCount=Math.max(0,list.length-bonusVideos);
  if(baseCount>0) consumeNonMemberQuota(uid,baseCount,true);
  if(bonusVideos>0) consumeExtraVideoQuota(uid,bonusVideos);
  saveDb();
}
function isVideoResource(item){
  const type=String(item?.fileType||"").toLowerCase();
  if(type==="video"||type==="animation"||type==="videonote") return true;
  const name=String(item?.title||item?.caption||"").toLowerCase();
  return /\.(mp4|mkv|mov|avi|webm|m4v|flv|ts)(?:\s|$)/.test(name);
}
function randomVideos(userId,limit=10){
  const arr=[...db.resources].filter(x=>x&&x.chatId!==undefined&&x.chatId!==null&&String(x.chatId).trim()&&Number(x.messageId)>0&&isVideoResource(x));
  if(!arr.length) return [];
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr.slice(0,limit);
}
function random10(userId) {
  // 随机获取每次最多抽取 10 条原始资源记录；不在这里扩展相册。
  // 允许相册中的照片/视频单个发送，避免一次点击扩展成几十条。
  const arr=[...db.resources].filter(x =>
    x &&
    x.chatId !== undefined &&
    x.chatId !== null &&
    String(x.chatId).trim() &&
    Number(x.messageId) > 0
  );
  if(!arr.length) return [];

  if(!db.settings.randomHistory || typeof db.settings.randomHistory!=="object") {
    db.settings.randomHistory={};
  }
  const key=String(userId);
  const validIds=new Set(arr.map(x=>resourceKey(x)));
  let history=Array.isArray(db.settings.randomHistory[key])
    ? db.settings.randomHistory[key].filter(id=>validIds.has(String(id)))
    : [];

  let pool=arr.filter(x=>!history.includes(resourceKey(x)));
  if(!pool.length) {
    history=[];
    pool=[...arr];
  }

  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }

  const batch=pool.slice(0,10);
  history.push(...batch.map(resourceKey));
  db.settings.randomHistory[key]=history.slice(-arr.length);
  saveDb();
  return batch;
}

function isPermanentResourceError(error) {
  const msg=String(error?.message||error||"");
  return /message to copy not found|message not found|message_id_invalid|MESSAGE_ID_INVALID|file.?id.*(?:invalid|wrong|not found)|wrong file(?: identifier)?|message .*?(?:not found|does not exist)|(?:copy|forward).*message.*(?:failed|not found)|message can.?t be copied/i.test(msg);
}

function removeInvalidResource(item, reason="") {
  if(!item) return false;
  const key=resourceKey(item);
  const before=db.resources.length;
  db.resources=db.resources.filter(x=>resourceKey(x)!==key);

  if(db.settings.randomHistory && typeof db.settings.randomHistory==="object") {
    for(const uid of Object.keys(db.settings.randomHistory)) {
      if(Array.isArray(db.settings.randomHistory[uid])) {
        db.settings.randomHistory[uid]=db.settings.randomHistory[uid].filter(x=>String(x)!==key);
      }
    }
  }
  if(db.settings.userFavorites && typeof db.settings.userFavorites==="object") {
    for(const uid of Object.keys(db.settings.userFavorites)) {
      if(Array.isArray(db.settings.userFavorites[uid])) {
        db.settings.userFavorites[uid]=db.settings.userFavorites[uid].filter(x=>String(x)!==key);
      }
    }
  }
  if(db.settings.userRecent && typeof db.settings.userRecent==="object") {
    for(const uid of Object.keys(db.settings.userRecent)) {
      if(Array.isArray(db.settings.userRecent[uid])) {
        db.settings.userRecent[uid]=db.settings.userRecent[uid].filter(x=>String(x)!==key);
      }
    }
  }

  if(before!==db.resources.length) {
    queueBaserowDeleteResource(item);
    console.warn("🧹 已清理无效资源：",key,reason ? "| "+String(reason).slice(0,200) : "");
    saveDb();
    return true;
  }
  return false;
}
function resourceInlineKeyboard(items,page=0) {
  const list=Array.isArray(items)?items:[];
  const totalPages=Math.max(1,Math.ceil(list.length/10));
  const current=Math.min(Math.max(0,Number(page)||0),totalPages-1);
  const start=current*10;
  const pageItems=list.slice(start,start+10);
  const rows=[];
  for(let i=0;i<pageItems.length;i+=2) {
    const row=[];
    for(let j=i;j<i+2 && j<pageItems.length;j++) {
      const item=pageItems[j];
      row.push({
        text:(start+j+1)+". "+String(item?.title||"未命名资源").slice(0,28),
        callback_data:"sr:"+current+":"+(j)
      });
    }
    if(row.length) rows.push(row);
  }
  const nav=[];
  if(current>0) nav.push({text:"⬅️ 上一页",callback_data:"srp:"+(current-1)});
  if(current+1<totalPages) nav.push({text:"下一页 ➡️",callback_data:"srp:"+(current+1)});
  if(nav.length) rows.push(nav);
  rows.push([{text:"🔎 重新搜索",callback_data:"user:search"},{text:"❌ 关闭搜索",callback_data:"src"}]);
  return {reply_markup:{inline_keyboard:rows}};
}
function escapeHtml(value) {
  return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function tgUploadMediaAlbum(token, chatId, entries) {
  const list=(Array.isArray(entries)?entries:[]).slice(0,10);
  if(list.length<2) throw new Error("媒体组至少需要 2 个文件");
  const form=new FormData();
  form.append("chat_id",String(chatId));
  if(contentProtectionEnabled()) form.append("protect_content","true");
  form.append("media",JSON.stringify(list.map((entry,index)=>({
    type:entry.mediaType,
    media:"attach://media"+index,
    ...(entry.caption?{caption:String(entry.caption).slice(0,1024)}:{})
  }))));
  list.forEach((entry,index)=>form.append("media"+index,new Blob([entry.buffer]),entry.name||("media"+index)));
  const response=await fetch(api(token,"sendMediaGroup"),{method:"POST",body:form});
  const payload=await response.json();
  if(!payload.ok) throw new Error(payload.description||"sendMediaGroup failed");
  const sent=Array.isArray(payload.result)?payload.result:[];
  const ids=sent.map(x=>Number(x?.message_id)).filter(Number.isFinite);
  if(ids.length) scheduleAutoDelete(token,chatId,ids);
  return sent;
}
async function deliverFromHistory(token,chatId,userId,items,options={}) {
  const member=await allowed(TOKEN,userId);
  if(!Array.isArray(items)||!items.length) return sendHtml(token,chatId,"<b>📭 暂无相关资源</b>\\n\\n暂时没有找到可用内容。",childMenu());
  const requestedCount=items.length;
  const guest=withoutVideosForGuest(items,member,userId,options.mode!=="latest" && options.mode!=="random");
  items=guest.items;
  if(!items.length) return guestVideoNotice(token,chatId);
  try {
    const album=await sendResourceAlbum(token,chatId,items,{singleEach:options.mode==="random"});
    const ok=Number(album?.sent||0),fail=Math.max(Number(album?.failed||0),items.length-ok);
    if(ok>0) {
      recordStat(userId,"download",ok);
      for(const item of (Array.isArray(album?.sentItems)?album.sentItems:items.slice(0,ok))){recordResourceDownload(item);recordRecent(userId,item);}
      if(!member&&!isAdmin(userId)) consumeVideoQuota(userId,Array.isArray(album?.sentItems)?album.sentItems:items.slice(0,ok));
      else saveDb();
    } else saveDb();
    const mode=options.mode==="random"?"random":"latest";
    const offset=Math.max(0,Number(options.offset)||0);
    const total=Math.max(0,Number(options.total)||db.resources.length);
    const extraMessage=postResourceMessage();
    const quotaDone=!member&&!isAdmin(userId)&&nonMemberDailyRemaining(userId)<=0;
    const inviteText=quotaDone?"\\n\\n🎁 今日免费资源额度已用完。照片、视频和文件都计入额度。":"";
    const summary="<b>📦 本批资源获取完成</b>\\n━━━━━━━━━━━━━━\\n\\n📤 成功发送：<b>"+ok+"</b> 条\\n⚠️ 失败："+fail+" 条\\n📚 本批："+items.length+" 条\\n\\n"+(mode==="random"?"🎲 可以继续随机获取下一批。":"🆕 可以继续浏览下一批最新资源。")+(extraMessage?"\\n\\n"+extraMessage:"")+inviteText;
    await sendHtml(token,chatId,summary,batchNavigation(mode,offset,total,requestedCount));
    return;
  } catch(e) {
    console.error("HISTORY DELIVERY:",e);
    return sendHtml(token,chatId,"<b>❌ 资源获取失败</b>\\n\\n原因："+escapeHtml(e.message||e),childMenu());
  }
}
function batchNavigation(mode,offset,total,advance=10){
  const rows=[];
  const step=Number(advance)>0?Number(advance):10;
  const next=Number(offset||0)+step;
  if(mode==="random"){
    rows.push([{text:"🎲 再来一组",callback_data:"batch:random"}]);
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
  if(!Array.isArray(items) || !items.length) {
    return sendHtml(token,chatId,"<b>📭 暂无相关资源</b>\\n\\n暂时没有找到可用内容。",{
      ...(options.mode ? {reply_markup:batchNavigation(options.mode,options.offset||0,options.total||0)} : {})
    });
  }

  let valid = items.filter(x =>
    x &&
    x.chatId !== undefined &&
    x.chatId !== null &&
    String(x.chatId).trim() &&
    Number(x.messageId) > 0
  );

  const requestedCount=valid.length;
  const guest=withoutVideosForGuest(valid, member, userId,options.mode!=="latest" && options.mode!=="random");
  valid=guest.items;
  if(!valid.length) return guestVideoNotice(token, chatId);

  if(!valid.length) {
    return sendHtml(token,chatId,
      "<b>📭 暂无可发送的资源</b>\\n\\n无效资源记录已被过滤，请重新获取。",
      options.mode ? {reply_markup:batchNavigation(options.mode,options.offset||0,options.total||0)} : {}
    );
  }

  let ok=0;
  let fail=0;
  let lastError="";

  let albumReplyId=0;
  const album=await sendResourceAlbum(sourceToken,chatId,valid,{singleEach:options.mode==="random"});
  ok=Number(album?.sent||0);
  albumReplyId=Number(album?.lastMessageId||0);
  fail=Math.max(Number(album?.failed||0),valid.length-ok);
  for(const item of (Array.isArray(album?.sentItems)?album.sentItems:valid.slice(0,ok))) {
    recordResourceDownload(item);
    recordRecent(userId,item);
  }

  if(ok>0) {
    recordStat(userId,"download",ok);
    if(!member && !isAdmin(userId)) consumeVideoQuota(userId,Array.isArray(album?.sentItems)?album.sentItems:valid.slice(0,ok));
    else saveDb();
  } else {
    saveDb();
  }

  const navigation=options.mode
    ? batchNavigation(options.mode,options.offset||0,options.total||valid.length)
    : {};

  const quotaDone=!member&&!isAdmin(userId)&&nonMemberDailyRemaining(userId)<=0;
  const inviteText=quotaDone?"\\n\\n🎁 今日免费资源额度已用完。照片、视频和文件都计入额度。":"";
  const summary = fail
    ? "⚠️ <b>本批发送结果</b>\\n✅ 成功：<b>"+ok+"</b> 个\\n❌ 失败：<b>"+fail+"</b> 个\\n\\n<i>失败资源已跳过，可继续获取下一批。</i>"+inviteText
    : "✅ <b>本批发送完成</b>\\n成功发送：<b>"+ok+"</b> 个"+inviteText;

  // 无论本批是否有失败，都必须保留“再来一组”按钮。
  // 自定义“获取资源后提示”直接放进最后的汇总消息，按钮始终挂在最下面。
  const extraMessage = postResourceMessage();
  const finalSummary = extraMessage ? summary+"\n\n"+extraMessage : summary;
  await sendHtml(token,chatId,finalSummary,{...(options.mode?batchNavigation(options.mode,options.offset||0,options.total||requestedCount,requestedCount):navigation),...(albumReplyId?{reply_to_message_id:albumReplyId}:{})});
  return;
}
const states=new Map();

// 在线客服：用户与管理员之间通过“回复机器人转发的原消息”完成双向会话。
// 会话/路由写入 db.settings，重启后仍可继续处理已经建立的会话。
const supportSessions = new Map();
const supportRoutes = new Map();
const supportTokens = new Map();
const SUPPORT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function supportRememberToken(token) {
  const fingerprint = tokenFingerprint(token);
  if (fingerprint && token) supportTokens.set(fingerprint, token);
}
supportRememberToken(TOKEN);

function supportSessionStore() {
  if(!db.settings || typeof db.settings!=="object") db.settings={};
  if(!db.settings.supportSessions || typeof db.settings.supportSessions!=="object") db.settings.supportSessions={};
  if(!Array.isArray(db.settings.supportRoutes)) db.settings.supportRoutes=[];
  return db.settings;
}
function supportSessionKey(token, uid) {
  return tokenFingerprint(token)+":"+String(uid);
}
function supportRouteKey(token, adminChatId, messageId) {
  return tokenFingerprint(token)+":"+String(adminChatId)+":"+String(messageId);
}
function supportOpenSession(token, uid) {
  supportRememberToken(token);
  const key=supportSessionKey(token,uid);
  supportSessionStore().supportSessions[key]={userId:Number(uid),tokenFingerprint:tokenFingerprint(token),updatedAt:Date.now(),status:"open"};
  supportSessions.set(key,{userId:Number(uid),tokenFingerprint:tokenFingerprint(token),updatedAt:Date.now(),status:"open"});
  saveDb();
}
function supportCloseSession(token, uid) {
  const key=supportSessionKey(token,uid);
  delete supportSessionStore().supportSessions[key];
  supportSessions.delete(key);
  const rows=supportSessionStore().supportRoutes.filter(x=>!(String(x?.tokenFingerprint)===tokenFingerprint(token)&&String(x?.userId)===String(uid)));
  supportSessionStore().supportRoutes=rows.slice(-2000);
  for(const [k,v] of supportRoutes) {
    if(String(v?.userId)===String(uid)&&String(v?.tokenFingerprint)===tokenFingerprint(token)) supportRoutes.delete(k);
  }
  saveDb();
}
function supportIsOpen(token,uid) {
  supportRememberToken(token);
  const key=supportSessionKey(token,uid);
  const row=supportSessionStore().supportSessions[key];
  return Boolean(row && row.status==="open");
}
function supportRememberRoute(token,adminChatId,adminMessageId,uid) {
  const row={
    tokenFingerprint:tokenFingerprint(token),
    adminChatId:String(adminChatId),
    adminMessageId:Number(adminMessageId),
    userId:Number(uid),
    createdAt:Date.now()
  };
  supportRoutes.set(supportRouteKey(token,adminChatId,adminMessageId),row);
  const rows=supportSessionStore().supportRoutes.filter(x=>supportRouteKey(token,x?.adminChatId,x?.adminMessageId)!==supportRouteKey(token,adminChatId,adminMessageId));
  rows.push(row);
  supportSessionStore().supportRoutes=rows.slice(-2000);
}
function supportFindRoute(token,adminChatId,messageId) {
  const key=supportRouteKey(token,adminChatId,messageId);
  const mem=supportRoutes.get(key);
  if(mem) return mem;
  const row=supportSessionStore().supportRoutes.find(x=>supportRouteKey(token,x?.adminChatId,x?.adminMessageId)===key);
  if(row) supportRoutes.set(key,row);
  return row||null;
}
function supportActiveSessions() {
  const store=supportSessionStore().supportSessions;
  return Object.values(store).filter(x=>x&&x.status==="open").sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
}

let supportExpiryRunning = false;
setInterval(async () => {
  if (supportExpiryRunning) return;
  supportExpiryRunning = true;
  try {
    const now = Date.now();
    const expired = supportActiveSessions().filter(row =>
      now - Number(row.updatedAt || 0) >= SUPPORT_IDLE_TIMEOUT_MS
    );
    for (const row of expired) {
      const token = supportTokens.get(String(row.tokenFingerprint || ""));
      if (!token) continue;
      const uid = Number(row.userId);
      if (!Number.isFinite(uid)) continue;
      supportCloseSession(token, uid);
      try {
        await sendHtml(token, uid,
          "<b>⏰ 客服会话已自动结束</b>\\n\\n连续 30 分钟没有新消息，本次会话已结束。\\n如需帮助，请重新点击「💬 联系客服」。",
          userMenu());
      } catch (e) {
        console.warn("⚠️ 客服超时通知用户失败:", String(e?.message || e));
      }
      const admins = [...ADMIN_IDS].map(Number).filter(Number.isFinite);
      for (const adminId of admins) {
        try {
          await sendHtml(token, adminId,
            "⏰ 用户 <code>" + escapeHtml(String(uid)) + "</code> 的客服会话因连续 30 分钟无消息已自动结束。");
        } catch (e) {
          console.warn("⚠️ 客服超时通知管理员失败:", String(e?.message || e));
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ 客服会话超时检查失败:", String(e?.message || e));
  } finally {
    supportExpiryRunning = false;
  }
}, 60 * 1000).unref?.();
async function supportSendToAdmins(token,msg) {
  supportRememberToken(token);
  const uid=msg.from?.id;
  const admins=[...ADMIN_IDS].map(Number).filter(Number.isFinite);
  if(!admins.length) return false;
  const displayName=[msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(" ")||msg.from?.username||"用户";
  const username=msg.from?.username ? "@"+msg.from.username : "无用户名";
  const header=await tg(token,"sendMessage",{
    chat_id:admins[0],
    text:"<b>💬 客服消息</b>\\n━━━━━━━━━━━━━━\\n👤 <b>"+escapeHtml(displayName)+"</b>  ·  "+escapeHtml(username)+"\\n🆔 <code>"+escapeHtml(String(uid))+"</code>\\n━━━━━━━━━━━━━━\\n↩️ <i>请直接回复下方的用户消息，或点击按钮结束会话</i>",
    parse_mode:"HTML",
    reply_markup:{inline_keyboard:[[{text:"🔚 结束该客服会话",callback_data:"support:admin_end:"+String(uid)}]]}
  });
  for(const adminId of admins) {
    let targetHeader=header;
    if(adminId!==admins[0]) {
      try {
        targetHeader=await tg(token,"sendMessage",{
          chat_id:adminId,
          text:"<b>💬 客服消息</b>\\n━━━━━━━━━━━━━━\\n👤 <b>"+escapeHtml(displayName)+"</b>  ·  "+escapeHtml(username)+"\\n🆔 <code>"+escapeHtml(String(uid))+"</code>\\n━━━━━━━━━━━━━━\\n↩️ <i>请直接回复下方的用户消息，或点击按钮结束会话</i>",
          parse_mode:"HTML",
          reply_markup:{inline_keyboard:[[{text:"🔚 结束该客服会话",callback_data:"support:admin_end:"+String(uid)}]]}
        });
      } catch(e) {
        console.warn("⚠️ 客服管理员通知失败:",String(e?.message||e));
        continue;
      }
    }
    try {
      const copied=await tg(token,"copyMessage",{chat_id:adminId,from_chat_id:msg.chat.id,message_id:msg.message_id});
      supportRememberRoute(token,adminId,copied.message_id,uid);
      if(adminId===admins[0]) {
        // 第一位管理员的提示和用户原消息相邻，其他管理员同样收到完整会话。
      }
    } catch(e) {
      console.warn("⚠️ 客服转发用户消息失败:",String(e?.message||e));
    }
  }
  supportSessionStore().supportSessions[supportSessionKey(token,uid)].updatedAt=Date.now();
  saveDb();
  return true;
}
async function supportHandleAdminReply(token,msg) {
  supportRememberToken(token);
  if(!isAdmin(msg.from?.id) || !msg.reply_to_message?.message_id) return false;
  const route=supportFindRoute(token,msg.chat?.id,msg.reply_to_message.message_id);
  if(!route) return false;
  if(!supportIsOpen(token,route.userId)) {
    await sendHtml(token,msg.chat.id,"⚠️ 这个客服会话已经结束，消息没有转发给用户。");
    return true;
  }
  if((msg.text||"").trim()==="/结束客服") {
    supportCloseSession(token,route.userId);
    await sendHtml(token,route.userId,"<b>💬 客服会话已结束</b>\\n\\n如需帮助，可以再次点击「💬 联系客服」。",userMenu());
    await sendHtml(token,msg.chat.id,"✅ 已结束用户 <code>"+escapeHtml(String(route.userId))+"</code> 的客服会话。");
    return true;
  }
  try {
    await tg(token,"copyMessage",{chat_id:route.userId,from_chat_id:msg.chat.id,message_id:msg.message_id});
    const key=supportSessionKey(token,route.userId);
    if(supportSessionStore().supportSessions[key]) supportSessionStore().supportSessions[key].updatedAt=Date.now();
    saveDb();
    return true;
  } catch(e) {
    await sendHtml(token,msg.chat.id,"❌ 回复用户失败：<code>"+escapeHtml(String(e?.telegramDescription||e?.message||e).slice(0,300))+"</code>");
    return true;
  }
}
async function supportHandleUserMessage(token,msg) {
  supportRememberToken(token);
  const uid=msg.from?.id;
  if(!uid || !supportIsOpen(token,uid)) return false;
  const t=String(msg.text||"").trim();
  if(t==="/cancel" || t==="❌ 结束客服" || t==="结束客服") {
    supportCloseSession(token,uid);
    await sendHtml(token,uid,"<b>💬 客服会话已结束</b>\\n\\n如需帮助，可以再次点击「💬 联系客服」。",userMenu());
    return true;
  }
  const ok=await supportSendToAdmins(token,msg);
  if(!ok) {
    await sendHtml(token,uid,"<b>⚠️ 暂时无法接入客服</b>\\n\\n管理员客服通道尚未配置，请稍后再试。",userMenu());
    supportCloseSession(token,uid);
    return true;
  }
  await sendHtml(token,uid,"<b>📨 消息已转给客服</b>\\n━━━━━━━━━━━━━━\\n\\n✅ 已收到，你的消息已转给客服。\\n💬 客服回复后会自动发送给你。\\n\\n👇 需要结束会话时，点击下方按钮。",{reply_markup:supportUserKeyboard()});
  return true;
}
function supportLink() {
  const link=String(db.settings.supportLink||"").trim();
  return /^https?:\/\//i.test(link) ? link : "";
}
function supportUserKeyboard() {
  const rows=[];
  if(supportLink()) rows.push([{text:"🔗 打开客服链接",url:supportLink()}]);
  rows.push([{text:"❌ 结束客服",callback_data:"support:end"}]);
  rows.push([{text:"⬅️ 返回首页",callback_data:"user:home"}]);
  return {inline_keyboard:rows};
}
function supportAdminText() {
  const rows=supportActiveSessions();
  if(!rows.length) return "<b>💬 在线客服</b>\\n━━━━━━━━━━━━━━\\n\\n📭 当前没有进行中的客服会话。\\n\\n用户可以通过「💬 联系客服」重新发起会话。";
  return "<b>💬 在线客服</b>\\n━━━━━━━━━━━━━━\\n\\n📨 进行中：<b>"+rows.length+"</b> 个\\n\\n"+
    rows.slice(0,20).map((x,i)=>(i+1)+". 👤 <code>"+escapeHtml(String(x.userId))+"</code>\\n   🕒 "+new Date(Number(x.updatedAt||Date.now())).toLocaleString("zh-CN")).join("\\n")+
    (rows.length>20?"\\n\\n仅显示最近 20 个会话。":"");
}
function supportAdminKeyboard() {
  const rows=supportActiveSessions().slice(0,20).map(x=>[
    {text:"🔚 结束 "+String(x.userId),callback_data:"support:admin_end:"+String(x.userId)}
  ]);
  rows.push([{text:"🔗 设置客服链接",callback_data:"support:link"}]);
  rows.push([{text:"🔄 刷新",callback_data:"support:admin"},{text:"⬅️ 返回",callback_data:"admin:ops"}]);
  return {inline_keyboard:rows};
}


async function binding(msg) {
  const admin=isAdmin(msg.from?.id);
  const rawText=(msg.text||"").trim();
  const t=(rawText.split(/\s+/)[0]||"").replace(/@[^\s]+$/,"");
  if(!admin) return false;

  // 上传会话优先于“转发消息绑定仓库”。
  // 上传期间管理员转发/发送的文件属于待上传资源，绝不能被当成绑定仓库消息。
  if(msg.chat?.type==="private") {
    const uploadState=states.get("m:"+String(msg.from?.id||""));
    if(["upload_select","upload_file","folder_create","folder_create_description"].includes(String(uploadState?.step||""))) return false;
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
  // 上传中的文件只进入当前批次，不要为每个文件触发跨机器人 Google Sheets 刷新。
  const preUploadState=msg?.chat?.type==="private" ? states.get("m:"+String(msg.from?.id||"")) : null;
  if(!(preUploadState?.step==="upload_file" || preUploadState?.step==="upload_folder" || preUploadState?.step==="folder_create")) {
  }
  // Telegram 消息处理不能等待 Google Sheets；共享数据在后台同步。
  if(await binding(msg)) return;
  if(msg.chat?.type!=="private") { indexResource(msg); queueRepositoryAutoSyncMessage(msg); return; }

  const uid=msg.from.id;
  if(!db.users.includes(uid)) { db.users.push(uid); saveDb(); }
  recordUserActivity(uid);
  const t=msg.text||"";
  const rawText=String(msg.text||"").trim();
  const admin=isAdmin(uid);
  if(!admin && db.settings?.redeemAccessBans?.[String(uid)]) return sendHtml(TOKEN,uid,"⛔ <b>此账号已被禁止使用机器人。</b>\n如有疑问，请联系管理员。");
  if (!admin) await ensureUserInlineMode(TOKEN, uid);
  const key="m:"+uid;
  let s=states.get(key);
  const persistedRedeemState=db.settings?.redeemAdminStates?.[String(uid)];
  if(admin && persistedRedeemState && /^redeem_(?:reward_amount|batch_count|success_message|ban_user)$/.test(String(persistedRedeemState.step||""))){s=persistedRedeemState;states.set(key,s);}

  if(s?.step==="redeem_code_input" && !admin) {
    if(rawText==="/cancel") { states.delete(key); return sendHtml(TOKEN,uid,"已取消兑换。",userMenu()); }
    const result=redeemCode(uid,rawText,msg.from,TOKEN);
    states.delete(key);
    return sendHtml(TOKEN,uid,(result.ok?"<b>✅ 兑换成功</b>":"<b>❌ 兑换失败</b>")+"\n\n"+escapeHtml(result.message),userMenu());
  }
  if(rawText.toLowerCase().startsWith("/redeem")) {
    const code=rawText.replace(/^\/redeem(?:@\w+)?\s*/i,"").trim();
    if(!code) {
      states.set(key,{step:"redeem_code_input"});
      return sendHtml(TOKEN,uid,"<b>🎟️ 使用兑换码</b>\n\n请发送兑换码。\n发送 /cancel 可取消。",userMenu());
    }
    const result=redeemCode(uid,code,msg.from,TOKEN);
    return sendHtml(TOKEN,uid,(result.ok?"<b>✅ 兑换成功</b>":"<b>❌ 兑换失败</b>")+"\n\n"+escapeHtml(result.message),userMenu());
  }
  if(admin && s?.step==="redeem_ban_user") {
    if(rawText==="/cancel") {
      states.delete(key);
      if(db.settings?.redeemAdminStates) delete db.settings.redeemAdminStates[String(uid)];
      saveDb();
      return sendHtml(TOKEN,uid,"已取消封禁操作，会员数据未修改。",{reply_markup:redeemAdminInline()});
    }
    const targetId=rawText.replace(/^@/,"").trim();
    if(!/^\d{1,20}$/.test(targetId) || !Number.isSafeInteger(Number(targetId)) || Number(targetId)<=0) {
      return sendHtml(TOKEN,uid,"❌ 用户 ID 格式不正确。请发送 Telegram 数字 ID，或发送 /cancel 取消。");
    }
    if(isAdmin(targetId)) return sendHtml(TOKEN,uid,"⛔ 不能封禁管理员账号。请发送其他用户 ID，或发送 /cancel 取消。");
    if(!db.settings.redeemAccessBans || typeof db.settings.redeemAccessBans!=="object" || Array.isArray(db.settings.redeemAccessBans)) db.settings.redeemAccessBans={};
    db.settings.redeemAccessBans[targetId]={userId:targetId,bannedAt:Date.now(),bannedBy:String(uid),source:"redeem_admin"};
    states.delete(key);
    if(db.settings?.redeemAdminStates) delete db.settings.redeemAdminStates[String(uid)];
    for(const cacheKey of membershipCache.keys()) if(cacheKey.endsWith(":"+targetId)) membershipCache.delete(cacheKey);
    saveDb();
    logAdmin(uid,"封禁机器人使用权限并移出指定群","用户ID="+targetId);
    let groupResult="未配置指定会员群，已仅封禁机器人使用权限。";
    const required=group();
    if(required?.chatId) {
      try {
        await tg(TOKEN,"banChatMember",{chat_id:required.chatId,user_id:Number(targetId)});
        try {
          await tg(TOKEN,"unbanChatMember",{chat_id:required.chatId,user_id:Number(targetId),only_if_banned:true});
          groupResult="已从指定会员群移出（允许以后重新加入，但机器人使用权限仍被封禁）。";
        } catch(unbanError) {
          groupResult="已执行群封禁，但解除群封禁失败；该用户可能仍无法重新加入。请检查机器人群管理权限。";
          console.warn("⚠️ 封禁用户后解除群封禁失败:",String(unbanError?.telegramDescription||unbanError?.message||unbanError));
        }
      } catch(groupError) {
        groupResult="机器人使用权限已封禁；移出指定会员群失败，请检查群 ID 和机器人管理员权限。";
        console.warn("⚠️ 移出指定会员群失败:",String(groupError?.telegramDescription||groupError?.message||groupError));
      }
    }
    return sendHtml(TOKEN,uid,"<b>🚫 已封禁用户</b>\n━━━━━━━━━━━━━━\n\n用户 ID：<code>"+escapeHtml(targetId)+"</code>\n机器人使用权限：<b>已封禁</b>\n会员/兑换码历史数据：<b>保留未删除</b>\n指定会员群："+escapeHtml(groupResult)+"\n\n如需解除机器人封禁，需要后续增加单独的解封入口。",{reply_markup:redeemAdminInline()});
  }
  if(admin && s?.step==="redeem_success_message") {
    if(rawText==="/cancel") { states.delete(key); if(db.settings?.redeemAdminStates) delete db.settings.redeemAdminStates[String(uid)]; saveDb(); return sendHtml(TOKEN,uid,"已取消，兑换成功消息保持不变。",adminSettingsMenu()); }
    if(!rawText) return sendHtml(TOKEN,uid,"❌ 消息不能为空。请发送新消息，或发送 /cancel 取消。");
    db.settings.redeemSuccessMessage=rawText.slice(0,3500);
    states.delete(key); if(db.settings?.redeemAdminStates) delete db.settings.redeemAdminStates[String(uid)];
    saveDb(); logAdmin(uid,"编辑兑换成功消息","更新兑换成功提示模板");
    return sendHtml(TOKEN,uid,"✅ <b>兑换成功消息已保存</b>\n\n可用变量：\n<code>{type}</code> 奖励类型\n<code>{reward}</code> 奖励内容\n<code>{days}</code> 会员天数\n<code>{expiry}</code> 到期时间\n<code>{quota}</code> 剩余视频额度\n\n当前消息：\n"+escapeHtml(db.settings.redeemSuccessMessage),adminSettingsMenu());
  }
  if(admin && s?.step==="redeem_reward_amount") {
    if(rawText==="/cancel") { states.delete(key); if(db.settings?.redeemAdminStates) delete db.settings.redeemAdminStates[String(uid)]; saveDb(); return sendHtml(TOKEN,uid,"已取消生成。",adminSettingsMenu()); }
    const amount=Number(rawText), max=s.rewardType==="membership_days"?3650:100000;
    if(!Number.isInteger(amount)||amount<1||amount>max) return sendHtml(TOKEN,uid,"❌ 请输入 1～"+max+" 的整数。");
    const nextRedeemState={step:"redeem_batch_count",rewardType:s.rewardType,rewardAmount:amount};
    states.set(key,nextRedeemState);
    if(!db.settings.redeemAdminStates||typeof db.settings.redeemAdminStates!=="object") db.settings.redeemAdminStates={};
    db.settings.redeemAdminStates[String(uid)]=nextRedeemState; saveDb();
    return sendHtml(TOKEN,uid,"<b>🎟️ 批量生成兑换码</b>\n\n每个兑换码奖励："+(s.rewardType==="membership_days"?"会员 "+amount+" 天":"额外视频 "+amount+" 次")+"。\n请输入本次生成数量（1～100）。\n发送 /cancel 可取消。");
  }
  if(admin && s?.step==="redeem_batch_count") {
    if(rawText==="/cancel") { states.delete(key); if(db.settings?.redeemAdminStates) delete db.settings.redeemAdminStates[String(uid)]; saveDb(); return sendHtml(TOKEN,uid,"已取消生成。",adminSettingsMenu()); }
    const count=Number(rawText);
    if(!Number.isInteger(count)||count<1||count>100) return sendHtml(TOKEN,uid,"❌ 请输入 1～100 的整数。");
    const store=redemptionStore(), codes=[];
    for(let i=0;i<count;i++) {
      let code="";
      do { code="RDM-"+crypto.randomBytes(6).toString("hex").toUpperCase(); } while(store.redemptionCodes[code]);
      store.redemptionCodes[code]={type:s.rewardType,amount:s.rewardAmount,createdAt:Date.now(),createdBy:String(uid),usedBy:"",usedAt:0};
      codes.push(code);
    }
    saveDb(); logAdmin(uid,"批量生成兑换码",(s.rewardType==="membership_days"?"会员天数 ":"额外视频额度 ")+s.rewardAmount+"，生成 "+count+" 个");
    states.delete(key);
    if(db.settings?.redeemAdminStates) delete db.settings.redeemAdminStates[String(uid)];
    saveDb();
    const rewardLabel=s.rewardType==="membership_permanent"?"永久会员":s.rewardType==="membership_days"?"会员 "+s.rewardAmount+" 天":"额外视频 "+s.rewardAmount+" 次";
    const text="<b>✅ 兑换码生成完成</b>\n━━━━━━━━━━━━━━\n奖励："+rewardLabel+"\n生成数量："+count+"\n\n"+codes.map((code,i)=>(i+1)+". <code>"+code+"</code>").join("\n");
    return sendHtml(TOKEN,uid,text,{reply_markup:redeemAdminInline()});
  }
  if(admin && rawText==="🎟️ 兑换码管理") {
    const store=redemptionStore(), all=Object.values(store.redemptionCodes);
    const unused=all.filter(x=>!x.usedAt&&!x.usedBy).length, used=all.length-unused;
    return sendHtml(TOKEN,uid,"<b>🎟️ 兑换码管理</b>\n━━━━━━━━━━━━━━\n\n📦 总计："+all.length+" 个\n🟢 未使用："+unused+" 个\n☑️ 已兑换："+used+" 个\n\n👇 点击下方按钮批量生成兑换码。",{reply_markup:redeemAdminInline()});
  }

  // 顶部/底部菜单必须优先于搜索、分页等旧状态；否则用户在搜索后点击目录会被当作搜索关键词。
  if(String(t||"").replace(/[\uFE0E\uFE0F]/g,"").replace(/\s+/g,"").trim()==="📂资源目录") {
    states.delete(key);
    console.log("📂 用户打开资源目录：用户="+uid+" 文件夹="+db.directories.length+" 资源="+db.resources.length);
    try {
      return await sendHtml(TOKEN,uid,directoryText(),{reply_markup:directoryInlineKeyboard()});
    } catch(e) {
      console.error("❌ 用户资源目录打开失败:",String(e?.telegramDescription||e?.message||e));
      return sendHtml(TOKEN,uid,"<b>❌ 资源目录暂时无法打开</b>\\n\\n请稍后重试，或点击「🏠 开始」返回首页。",userMenu());
    }
  }

  // 搜索输入必须优先于会员检查、共享刷新和其他状态机处理。
  // 避免搜索页面已经打开，但用户发送关键词后被其他流程拦截而“没有反馈”。
  if((s?.step==="search" || s?.step==="search_results") && msg.chat?.type==="private" && !admin) {
    if(t==="/cancel") {
      states.delete(key);
      return sendHtml(TOKEN,uid,"<b>↩️ 已退出搜索</b>\n\n👇 请选择其他功能。",userMenu());
    }
    const query=String(t||"").trim();
    if(!query) return sendHtml(TOKEN,uid,"<b>🔎 搜索资源</b>\n\n请输入要搜索的关键词。");
    recordStat(uid,"search",1);
    const results=search(query);
    saveDb();
    if(!results.length) {
      states.set(key,{step:"search"});
      return sendHtml(TOKEN,uid,
        "<b>📭 没有找到相关资源</b>\n\n关键词：<code>"+escapeHtml(query)+"</code>\n\n💡 可以换一个更短的关键词。",
        {reply_markup:{inline_keyboard:[[{text:"🔎 换个词",callback_data:"user:search"}],[{text:"⬅️ 返回首页",callback_data:"user:home"}]]}});
    }
    states.set(key,{step:"search_results",query,results,page:0});
    return sendHtml(TOKEN,uid,
      "🔎 <b>搜索结果</b>\n━━━━━━━━━━━━━━\n🔍 关键词：<b>"+escapeHtml(query)+"</b>\n📚 共找到 <b>"+results.length+"</b> 个结果\n📄 第 <b>1 / "+Math.max(1,Math.ceil(results.length/10))+"</b> 页\n\n👇 <b>点击下方资源名称获取</b>",
      resourceInlineKeyboard(results,0));
  }
  // 主机器人重启后恢复未完成的上传会话，避免文件消息因内存状态丢失而被静默忽略。
  const savedUpload=db.settings?.uploadSessions?.[key];
  const savedFresh=savedUpload && Date.now()-Number(savedUpload.updatedAt||0) < 5*60*1000;
  if(admin && savedFresh && (!s || !["upload_file","upload_select"].includes(String(s.step)))){
    const saved=savedUpload;
    if(saved.step==="upload_file" || saved.step==="upload_select" || saved.step==="folder_create"){
      s={
        step:String(saved.step),
        directoryId:String(saved.directoryId||""),
        directoryName:String(saved.directoryName||""),
        pendingUploads:(Array.isArray(saved.pendingMessageIds)?saved.pendingMessageIds:[]).map(id=>({messageId:Number(id)})).filter(x=>Number.isFinite(x.messageId)),
        controlMessageId:Number(saved.controlMessageId||0)
      };
      states.set(key,s);
      console.log("♻️ UPLOAD SESSION RESTORED:",{uid:String(uid),step:s.step,pending:s.pendingUploads.length,folder:s.directoryName});
    }
  }

  // 上传文件最高优先级：收到媒体后直接进入批量上传队列，避免被其他状态机拦截。
  if(admin && s?.step==="upload_file") {
    const handled=await withUploadLock(key,()=>receiveUploadMedia(TOKEN,uid,key,states.get(key)||s,msg,false));
    if(handled) return;
  }

  // 管理员回复客服转发消息时，优先走客服回传，不进入普通后台状态机。
  if(admin && await supportHandleAdminReply(TOKEN,msg)) return;
  // 用户处于客服会话时，普通消息直接转交客服。
  if(!admin && await supportHandleUserMessage(TOKEN,msg)) return;

  // 文件夹创建流程最高优先级：名称和说明必须连续走同一个状态机，不能被客服/上传/其他状态截走。
  if(admin && (s?.step==="folder_create" || s?.step==="folder_create_description")) {
    if(t==="/cancel" || t==="❌ 取消") {
      states.delete(key);
      if(db.settings?.uploadSessions?.[key]) { delete db.settings.uploadSessions[key]; saveDb(); }
      return sendHtml(TOKEN,uid,"❌ <b>已取消新建文件夹</b>",{reply_markup:uploadFolderInlineMenu()});
    }
    if(s.step==="folder_create") {
      const folderName=String(t||"").trim().replace(/^📁\s*/,"").slice(0,80);
      if(!folderName) return sendHtml(TOKEN,uid,"⚠️ <b>文件夹名称不能为空</b>\n\n请重新发送名称。");
      const same=db.directories.find(x=>String(x.name||"").trim().toLowerCase()===folderName.toLowerCase());
      if(same) {
        states.set(key,{step:"folder_create_description",folderName:same.name,directoryId:same.id});
        if(db.settings?.uploadSessions?.[key]) { db.settings.uploadSessions[key]={...db.settings.uploadSessions[key],step:"folder_create_description",folderName:same.name,directoryId:same.id,updatedAt:Date.now()}; saveDb(); }
        return sendHtml(TOKEN,uid,"📝 <b>设置文件夹说明</b>\n\n📁 "+escapeHtml(same.name)+"\n\n请输入新的说明（可选，最多300字）。\n不需要说明请发送「无」。\n发送 /cancel 可取消。");
      }
      states.set(key,{step:"folder_create_description",folderName});
      if(db.settings?.uploadSessions?.[key]) { db.settings.uploadSessions[key]={...db.settings.uploadSessions[key],step:"folder_create_description",folderName,updatedAt:Date.now()}; saveDb(); }
      return sendHtml(TOKEN,uid,"📝 <b>设置文件夹说明</b>\n\n📁 "+escapeHtml(folderName)+"\n\n请输入说明（可选，最多300字）。\n不需要说明请发送「无」。\n发送 /cancel 可取消。");
    }
    const folderName=String(s.folderName||"").trim().slice(0,80);
    const description=String(rawText||"").trim()==="无" ? "" : String(rawText||"").trim().slice(0,300);
    if(!folderName) { states.delete(key); return sendHtml(TOKEN,uid,"⚠️ <b>文件夹名称丢失，请重新创建。</b>",{reply_markup:uploadFolderInlineMenu()}); }
    const d=ensureDirectory(folderName,description);
    if(!d) return sendHtml(TOKEN,uid,"❌ <b>文件夹创建失败</b>\n\n请重新创建。");
    d.description=description;
    touchSharedData(uid); queueBaserowDirectorySync(d); saveDb();
    states.set(key,{step:"upload_file",directoryId:d.id,directoryName:d.name,directoryDescription:d.description||"",pendingUploads:[]});
    if(db.settings?.uploadSessions?.[key]) delete db.settings.uploadSessions[key];
    logAdmin(uid,"新建文件夹",d.name+(d.description?"："+d.description:""));
    return sendHtml(TOKEN,uid,"✅ <b>文件夹创建成功</b>\n\n📁 "+escapeHtml(d.name)+(d.description?"\n📝 "+escapeHtml(d.description):"")+"\n\n现在可以直接发送文件。",{reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}],[{text:"❌ 取消上传",callback_data:"upload_cancel"}]]}});
  }

  // 旧的 folder_create 分支已合并到上面的最高优先级状态机。
  if(false && s?.step==="folder_create"&&admin) {
    if(t==="/cancel" || t==="❌ 取消") {
      states.delete(key);
      if(db.settings?.uploadSessions?.[key]) { delete db.settings.uploadSessions[key]; saveDb(); }
      return sendHtml(TOKEN,uid,"❌ <b>已取消新建文件夹</b>",{reply_markup:uploadFolderInlineMenu()});
    }
    const folderName=String(t||"").trim().replace(/^📁\s*/,"").slice(0,80);
    if(!folderName) return sendHtml(TOKEN,uid,"⚠️ <b>文件夹名称不能为空</b>\\n\\n请重新发送名称。");
    const same=db.directories.find(x=>String(x.name||"").trim().toLowerCase()===folderName.toLowerCase());
    if(same) {
      states.set(key,{step:"upload_file",directoryId:same.id,directoryName:same.name,directoryDescription:same.description||"",pendingUploads:[]});
      return sendHtml(TOKEN,uid,"⚠️ <b>这个文件夹已经存在</b>\\n\\n📁 "+escapeHtml(same.name)+(same.description?"\\n📝 "+escapeHtml(same.description):"")+"\\n\\n已切换到这个文件夹，现在可以直接发送文件。",{reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}],[{text:"❌ 取消上传",callback_data:"upload_cancel"}]]}});
    }
    states.set(key,{step:"folder_create_description",folderName});
    return sendHtml(TOKEN,uid,"📝 <b>设置文件夹说明</b>\\n\\n📁 "+escapeHtml(folderName)+"\\n\\n请输入说明（可选，最多300字）。\\n不需要说明请发送「无」。\\n发送 /cancel 可取消。");
  }
  if(s?.step==="folder_create_description"&&admin) {
    if(t==="/cancel" || t==="❌ 取消") {
      states.delete(key);
      return sendHtml(TOKEN,uid,"❌ <b>已取消新建文件夹</b>",{reply_markup:uploadFolderInlineMenu()});
    }
    const folderName=String(s.folderName||"").trim().slice(0,80);
    const description=rawText==="无" ? "" : rawText.slice(0,300);
    if(!folderName) {
      states.delete(key);
      return sendHtml(TOKEN,uid,"⚠️ 文件夹名称丢失，请重新创建。",{reply_markup:uploadFolderInlineMenu()});
    }
    const d=ensureDirectory(folderName,description);
    if(!d) return sendHtml(TOKEN,uid,"❌ <b>文件夹创建失败</b>\\n\\n请重新创建。");
    touchSharedData(uid);
    queueBaserowDirectorySync(d);
    saveDb();
    states.set(key,{step:"upload_file",directoryId:d.id,directoryName:d.name,directoryDescription:d.description||"",pendingUploads:[]});
    if(db.settings?.uploadSessions?.[key]) delete db.settings.uploadSessions[key];
    logAdmin(uid,"新建文件夹",d.name+(d.description?"："+d.description:""));
    return sendHtml(TOKEN,uid,"✅ <b>文件夹创建成功</b>\\n\\n📁 "+escapeHtml(d.name)+(d.description?"\\n📝 "+escapeHtml(d.description):"")+"\\n\\n现在可以直接发送文件。",{reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}],[{text:"❌ 取消上传",callback_data:"upload_cancel"}]]}});
  }


  if(admin && s?.step==="backup_token") {
    const value=String(t||"").trim();
    if(value==="0") { db.settings.backupBot={}; saveDb(); states.delete(key); return sendHtml(TOKEN,uid,"✅ 已清除备份机器人。",adminMenu()); }
    if(!/^\d+:[A-Za-z0-9_-]+$/.test(value)) return sendHtml(TOKEN,uid,"⚠️ Token 格式不对。请从 BotFather 复制，或发送 0 清除。");
    const me=await tg(value,"getMe",{});
    db.settings.backupBot={token:value, username:me.username||"", chatId:String(uid)};
    saveDb(); states.delete(key);
    return sendHtml(TOKEN,uid,"✅ 备份机器人已保存：@"+escapeHtml(me.username||"")+"\n\n请先给它发一次 /start。之后新入库的文件会静默备份。",adminMenu());
  }
  if(admin && s?.step==="support_link") {
    const value=String(t||"").trim();
    if(value==="0") db.settings.supportLink="";
    else if(!/^https?:\/\//i.test(value)) return sendHtml(TOKEN,uid,"⚠️ 请发送以 http:// 或 https:// 开头的链接。发送 0 可清除。");
    else db.settings.supportLink=value;
    saveDb();
    states.delete(key);
    return sendHtml(TOKEN,uid,"✅ 客服链接已保存。用户点「联系客服」就能看到。",adminMenu());
  }
  if(admin && s?.step==="auto_start_id") {
    const startId=Number(String(t||"").trim());
    if(!Number.isInteger(startId) || startId<0) return sendHtml(TOKEN,uid,"⚠️ 请发送数字消息 ID。发送 0 表示从头复制。");
    const state=repositoryAutoSyncState();
    state.startMessageId=startId;
    state.lastMessageId=startId;
    state.queue=state.queue.filter(x=>Number(x.messageId)>=startId);
    state.updatedAt=Date.now();
    saveDb();
    states.delete(key);
    return sendHtml(TOKEN,uid,"<b>✅ 已设置起始 ID</b>\n\n从消息 <code>"+startId+"</code> 开始复制，更早的会跳过。\n\n点「开始同步」后生效。",{reply_markup:{inline_keyboard:[[{text:"▶️ 开始同步",callback_data:"adm:auto_start"}],[{text:"⬅️ 返回自动同步",callback_data:"adm:auto_status"}]]}});
  }
  if(admin && s?.step==="bind_repository") {
    if(t==="/cancel" || t==="取消" || t==="取消绑定" || t==="/start" || t==="🏠 开始" || t==="🏠 返回首页" || t==="⬅️ 返回首页" || t==="⬅️ 返回管理" || t==="⚙️ 管理中心") {
      states.delete(key);
      if(t==="/cancel" || t==="取消" || t==="取消绑定") return sendHtml(TOKEN,uid,"↩️ <b>已取消绑定资源仓库</b>\n\n当前仓库："+(repo()?.title ? "✅ "+escapeHtml(repo().title) : "❌ 未绑定"),adminMenu());
    } else {
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
        "<b>❌ 仓库绑定失败</b>\n\n⚠️ "+escapeHtml(e?.telegramDescription||e?.message||e)+"\n\n请检查 Chat ID/@用户名是否正确，以及机器人是否已经加入仓库。\n\n发送 /cancel 或点下面按钮退出。",
        {reply_markup:{inline_keyboard:[[{text:"❌ 取消绑定",callback_data:"bind_repo_cancel"}]]}});
    }
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
    const sourceChat=msg.forward_origin?.chat || msg.forward_origin?.sender_chat || msg.forward_from_chat || msg.sender_chat;
    const source=sourceChat?.id ? String(sourceChat.id).trim() : String(t||"").trim();
    if(!source) return send(TOKEN,uid,"⚠️ 请发送旧仓库 Chat ID、@用户名，或直接转发旧仓库中的任意消息/文件。");
    try {
      const sc=await main("getChat",{chat_id:source});
      states.set(key,{step:"auto_migration_target",source:String(sc.id),sourceTitle:String(sc.title||sc.username||sc.id)});
      return sendHtml(TOKEN,uid,"<b>✅ 旧仓库已确认</b>\n\n📤 旧仓库："+escapeHtml(String(sc.title||sc.username||sc.id))+"\n🆔 <code>"+escapeHtml(String(sc.id))+"</code>\n\n📥 现在发送新仓库 Chat ID、@用户名，或直接转发新仓库中的任意消息/文件。\n\n⚠️ 新仓库必须与旧仓库不同。发送 /cancel 可取消。");
    } catch(e) {
      return sendHtml(TOKEN,uid,"<b>❌ 旧仓库无法确认</b>\n\n⚠️ "+escapeHtml(String(e?.telegramDescription||e?.message||e))+"\n\n请重新发送旧仓库。");
    }
  }
  if (admin && s?.step === "auto_migration_target") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消自动同步设置。",adminMenu()); }
    const targetChat=msg.forward_origin?.chat || msg.forward_origin?.sender_chat || msg.forward_from_chat || msg.sender_chat;
    const target=targetChat?.id ? String(targetChat.id).trim() : String(t||"").trim();
    const source=String(s?.source||"").trim();
    if(!target) return send(TOKEN,uid,"⚠️ 请发送新仓库 Chat ID、@用户名，或直接转发新仓库中的任意消息/文件。");
    try {
      const sc=await main("getChat",{chat_id:source});
      const tc=await main("getChat",{chat_id:target});
      console.log("⚡ AUTO BIND CHECK:",{sourceInput:source,targetInput:target,sourceId:String(sc.id),targetId:String(tc.id)});
      if(String(sc.id)===String(tc.id)){
        return sendHtml(TOKEN,uid,"<b>❌ 新仓库不能与旧仓库相同</b>\n\n📤 旧仓库："+escapeHtml(String(sc.title||sc.username||sc.id))+"\n🆔 <code>"+escapeHtml(String(sc.id))+"</code>\n\n📥 你发送的新仓库：<code>"+escapeHtml(String(tc.id))+"</code>\n\n请重新发送一个不同的新仓库。");
      }
      const me=await main("getMe");
      for(const chat of [sc,tc]){
        const member=await main("getChatMember",{chat_id:chat.id,user_id:me.id});
        if(["left","kicked"].includes(String(member?.status||""))) throw new Error("机器人不在仓库「"+String(chat.title||chat.username||chat.id)+"」中");
      }
      states.delete(key);
      await resetRepositoryAutoSyncBinding();
      const latestSourceMessageId=Math.max(0,...db.resources.filter(x=>String(x.chatId)===String(sc.id)&&Number(x.messageId)>0).map(x=>Number(x.messageId)));
      await enableRepositoryAutoSync(uid,String(sc.id),String(tc.id),String(sc.title||sc.username||sc.id),String(tc.title||tc.username||tc.id),0);
      return await sendHtml(TOKEN,uid,"<b>✅ 自动同步任务已绑定</b>\n━━━━━━━━━━━━━━\n\n📤 旧仓库："+escapeHtml(String(sc.title||sc.username||sc.id))+"\n📥 新仓库："+escapeHtml(String(tc.title||tc.username||tc.id))+"\n\n⏸️ 当前尚未启动同步。\n👇 点击下面的「▶️ 开始同步」后，旧仓库收到的新消息才会自动复制到新仓库。",{reply_markup:{inline_keyboard:[[{text:"▶️ 开始同步",callback_data:"adm:auto_start"}],[{text:"🗑️ 删除任务并解绑",callback_data:"adm:auto_delete"}],[{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]]}});
    } catch(e) {
      const msg=String(e?.telegramDescription||e?.message||e||"自动同步启动失败");
      const a=repositoryAutoSyncState();
      a.enabled=false; a.status="error"; a.lastError=msg; a.updatedAt=Date.now(); saveDb();
      return sendHtml(TOKEN,uid,"<b>❌ 自动同步启动失败</b>\n\n⚠️ "+escapeHtml(msg)+"\n\n请检查两个仓库是否都能被机器人访问。");
    }
  }

  if (admin && s?.step === "migration_source") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消仓库迁移。",adminMenu()); }
    let source=String(t||"").trim();
    const sourceChat=msg.forward_origin?.chat || msg.forward_origin?.sender_chat || msg.forward_from_chat || msg.sender_chat;
    if(!source && sourceChat?.id) source=String(sourceChat.id).trim();
    if(!source) return send(TOKEN,uid,"⚠️ 请发送旧仓库 Chat ID、@用户名，或直接转发旧仓库中的任意消息/文件。");
    states.set(key,{step:"migration_target",source});
    return sendHtml(TOKEN,uid,"<b>📥 现在发送新仓库</b>\\n\\n请输入新仓库 Chat ID 或 @用户名。\\n\\n例如：<code>-1001234567890</code>\\n\\n机器人必须同时在两个仓库里。发送 /cancel 可取消。");
  }
  if (admin && s?.step === "migration_target") {
    if (t === "/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消仓库迁移。",adminMenu()); }
    let target=String(t||"").trim(), source=String(s?.source||"").trim();
    const targetChat=msg.forward_origin?.chat || msg.forward_origin?.sender_chat || msg.forward_from_chat || msg.sender_chat;
    if(!target && targetChat?.id) target=String(targetChat.id).trim();
    if(!target) return send(TOKEN,uid,"⚠️ 请发送新仓库 Chat ID、@用户名，或直接转发新仓库中的任意消息/文件。");
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

  if(admin && cloud123State.has(String(uid))) {
    const cs=cloud123State.get(String(uid));
    if(t==="/cancel") {
      cloud123State.delete(String(uid));
      return send(TOKEN,uid,"❌ 已取消123云盘配置。",adminMenu());
    }
    if(cs.step==="url") {
      if(!/^https?:\/\//i.test(t.trim())) return send(TOKEN,uid,"⚠️ WebDAV 地址格式不正确，请以 http:// 或 https:// 开头。");
      cloud123State.set(String(uid),{step:"username",url:t.trim()});
      return send(TOKEN,uid,"👤 请输入123云盘 WebDAV 用户名。\n\n发送 /cancel 可取消。");
    }
    if(cs.step==="username") {
      if(!t.trim()) return send(TOKEN,uid,"⚠️ 用户名不能为空，请重新发送。");
      cloud123State.set(String(uid),{step:"password",url:cs.url,username:t.trim()});
      return send(TOKEN,uid,"🔑 请输入123云盘 WebDAV 密码。\n\n发送 /cancel 可取消。");
    }
    if(cs.step==="password") {
      if(!t.trim()) return send(TOKEN,uid,"⚠️ 密码不能为空，请重新发送。");
      db.settings.cloud123={
        url:encrypt(cs.url),
        username:encrypt(cs.username),
        password:encrypt(t.trim()),
        configuredAt:Date.now()
      };
      saveDb();
      cloud123State.delete(String(uid));
      return sendHtml(TOKEN,uid,
        "<b>✅ 123云盘配置已保存</b>\n\n"+
        "🔗 WebDAV：已保存\n"+
        "👤 账号："+escapeHtml(cs.username)+"\n\n"+
        "下一步点击「🧪 测试连接」。",
        cloud123Menu()
      );
    }
  }

  if(t==="/start" || t==="🏠 开始" || t==="开始使用" || t==="🏠 开始使用") {
    const welcomeStore=db.settings||{};
    if(!welcomeStore.welcomeUsers || typeof welcomeStore.welcomeUsers!=="object") welcomeStore.welcomeUsers={};
    const firstVisit=!welcomeStore.welcomeUsers[String(uid)];
    welcomeStore.welcomeUsers[String(uid)]=Date.now();
    if(firstVisit) {
      saveDb();
      await sendHtml(TOKEN,uid,`<b>🎉 欢迎来到资源平台</b>
━━━━━━━━━━━━━━

👋 很高兴见到你！

📚 <b>这里可以：</b>
• 📂 按文件夹浏览资源
• 🔎 按标题或关键词搜索
• 🎲 随机获取，每次最多 10 条
• 🆕 查看最新资源
• 🎟️ 使用兑换码 / 💬 联系客服

👇 <i>点击下方按钮开始使用</i>`,admin?adminMenu():userMenu());
      return;
    }
    return sendHtml(TOKEN,uid,admin?adminStatusText():userHomeText(uid),admin?adminMenu():userMenu());
  }
  if(t==="/admin") {
  if(t.startsWith("/start share_")) {
    const shareToken=t.slice("/start share_".length).trim();
    const item=getResourceByShareToken(shareToken);
    if(!item) return sendHtml(TOKEN,uid,"<b>🔗 分享资源</b>\n\n❌ 这个分享链接已失效或资源不存在。",userMenu());
    const member=await allowed(TOKEN,uid);
    const guest=withoutVideosForGuest([item],member,uid);
    if(!guest.items.length) return guestVideoNotice(TOKEN,uid);
    try {
      await sendIndexedResource(TOKEN,uid,item);
      recordStat(uid,"download",1);
      recordResourceDownload(item);
      recordRecent(uid,item);
      if(!member&&!isAdmin(uid)) consumeVideoQuota(uid,[item]); else saveDb();
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
        [{text:"🧹 解绑并清除该仓库资源",callback_data:"adm:repo_unbind_confirm"}],
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
    if(a.enabled) return showRepositoryAutoSyncStatus(uid);
    states.set(key,{step:"auto_migration_source"});
    return sendHtml(TOKEN,uid,"<b>⚡ 自动同步</b>\n━━━━━━━━━━━━━━\n\n📤 第一步：发送旧仓库 Chat ID 或 @用户名。\n📥 首次会先迁移历史资源，完成后以后出现的新资源会自动复制到新仓库。\n\n⚠️ 机器人必须同时在两个仓库里。\n📌 旧仓库不会删除。\n\n发送 /cancel 可取消。");
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

  if(String(t||"").replace(/[\uFE0E\uFE0F]/g,"").replace(/\s+/g,"").trim()==="📂资源目录") {
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

    const member=await allowed(TOKEN,uid);
    const pageInfo=directoryBatchItems(all,offset,10,true);
    const page=pageInfo.items;
    const guest=withoutVideosForGuest(page,member,uid,member);
    const allowedPage=guest.items;
    if(!allowedPage.length) return guestVideoNotice(TOKEN,uid);
    const sendResult=await sendDirectoryBatch(TOKEN,uid,allowedPage);
    const sent=Number(sendResult?.sent||0);
    const nextOffset=sent?(member?pageInfo.nextOffset:Math.min(offset+sent,all.length)):offset;
    if(sent>0&&!member&&!isAdmin(uid)) consumeVideoQuota(uid,Array.isArray(sendResult?.sentItems)?sendResult.sentItems:[]);
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
    if(!(await requireMemberAccess(TOKEN,uid,uid,userMenu()))) return;

    states.set(key,{step:"search"});
    return sendHtml(TOKEN,uid,
      "<b>🔎 搜索资源</b>\\n\\n"+
      "请输入关键词，例如：作者名、标题或关键词。\\n\\n"+
      "💡 支持模糊搜索，结果较多时可使用分页。\\n"+
      "↩️ 发送 <code>/cancel</code> 可退出搜索。",
      {reply_markup:{keyboard:[["❌ 取消搜索"],["🏠 开始"]],resize_keyboard:true,input_field_placeholder:"请输入搜索关键词"}}
    );
  }
  if(t==="🎲 随机获取") {
    if(!(await requireMemberAccess(TOKEN,uid,uid,userMenu()))) return;
    return deliver(TOKEN,uid,uid,random10(uid),TOKEN,{mode:"random",offset:0,total:db.resources.length});
  }
  if(t==="🆕 最新资源") {
    if(!(await requireMemberAccess(TOKEN,uid,uid,userMenu()))) return;
    return deliver(TOKEN,uid,uid,db.resources.slice(0,10),TOKEN,{mode:"latest",offset:0,total:db.resources.length});
  }
  if(s?.step==="search") {
    if(!(await requireMemberAccess(TOKEN,uid,uid,userMenu()))) { states.delete(key); return; }
    if(t==="/cancel" || t==="❌ 取消搜索" || t==="🏠 开始") {
      states.delete(key);
      if(t==="🏠 开始") {
        return sendHtml(TOKEN,uid,"<b>👋 欢迎使用资源平台</b>\\n\\n📚 <b>资源功能</b>：目录 · 搜索 · 随机 · 最新\\n\\n👇 <i>请选择下方功能开始使用</i>",admin?adminMenu():userMenu());
      }
      return send(TOKEN,uid,"↩️ <b>已退出搜索</b>\\n\\n👇 请选择其他功能。",admin?adminMenu():userMenu());
    }

    const query=String(t||"").trim();
    if(!query) {
      return sendHtml(TOKEN,uid,"<b>🔎 搜索资源</b>\\n\\n⚠️ 请输入要搜索的关键词。\\n\\n例如：<code>教程</code>、<code>视频</code>、<code>作者名</code>");
    }

    try {
      // 用户主动搜索时强制刷新共享索引，确保新文件立即可见。
      if(GOOGLE_SHEETS_CREDENTIAL && GOOGLE_SHEETS_ID) {
        await refreshSharedData(true).catch(e=>console.warn("⚠️ 搜索前共享资源刷新失败，继续使用本地索引：",String(e?.message||e)));
      }
      const q=query.toLowerCase();
      const allResources=Array.isArray(db.resources)?db.resources:[];
      const results=allResources.filter(item=>{
        const folder=db.directories.find(d=>String(d?.id||"")===String(item?.directoryId||""));
        const haystack=[
          item?.title,
          item?.name,
          item?.caption,
          item?.fileName,
          item?.fileType,
          item?.tags,
          folder?.name
        ].map(v=>String(v??"").toLowerCase()).join(" ");
        return haystack.includes(q);
      });

      recordStat(uid,"search",1);
      saveDb();

      if(!results.length) {
        return sendHtml(TOKEN,uid,
          "<b>📭 没有找到相关资源</b>\\n\\n"+
          "关键词：<code>"+escapeHtml(query)+"</code>\\n"+
          "📚 当前资源库：<b>"+allResources.length+"</b> 条\\n\\n"+
          "💡 可以换一个更短的关键词再试。",
          userMenu()
        );
      }

      states.set(key,{step:"search_results",query,results,page:0});
      console.log("🔎 用户搜索完成:",String(uid),"query="+query,"results="+results.length);

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
    } catch(e) {
      console.error("❌ 用户搜索异常:",String(e?.message||e));
      return sendHtml(TOKEN,uid,
        "<b>❌ 搜索暂时失败</b>\\n\\n"+
        "请稍后再试。\\n\\n"+
        "⚠️ "+escapeHtml(String(e?.message||e).slice(0,300)),
        userMenu()
      );
    }
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
  if((t==="☁️ 123云盘" || t==="🔄 云盘同步" || t==="🚀 扫描并上传") && admin) {
    if(t==="🚀 扫描并上传" && typeof cloud123ScanAndUpload==="function") return cloud123ScanAndUpload(uid);
    if(typeof cloud123StatusText==="function" && typeof cloud123Menu==="function") return sendHtml(TOKEN,uid,cloud123StatusText(),cloud123Menu());
    return sendHtml(TOKEN,uid,"<b>☁️ 123云盘</b>\n━━━━━━━━━━━━━━\n\n已收到「"+escapeHtml(t)+"」。\n扫描上传还没加载，所以不会开始。\n请先在服务器执行 <code>node cloud123-runtime.js</code> 后重启。",adminResourceMenu());
  }

  if(t==="☁️ 123云盘"&&admin) {
    return sendHtml(TOKEN,uid,cloud123StatusText(),cloud123Menu());
  }
  if(t==="🔗 配置123云盘"&&admin) {
    cloud123State.set(String(uid),{step:"url"});
    return send(TOKEN,uid,
      "🔗 <b>配置123云盘 WebDAV</b>\n\n"+
      "请发送123云盘提供的 WebDAV 地址。\n\n"+
      "⚠️ 不要发送 Telegram Bot Token。\n"+
      "发送 /cancel 可取消。",
      {parse_mode:"HTML"});
  }
  if(t==="🧪 测试连接"&&admin) {
    try {
      const client=cloud123Client();
      return client.test().then(() => sendHtml(TOKEN,uid,
        "<b>✅ 123云盘连接正常</b>\n\n"+
        "WebDAV 已可以访问。\n\n"+
        "下一步可以点击「📁 同步目录+文件」。",
        cloud123Menu()
      ));
    } catch(e) {
      return send(TOKEN,uid,"❌ 123云盘连接失败：\n\n"+String(e.message||e),cloud123Menu());
    }
  }
  if(t==="📁 同步机器人目录"&&admin) {
    try {
      const result=await cloud123SyncDirectories(uid);
      const syncedFolders=Number(result.created||0)+Number(result.existing||0);
      const repoCount=db.resources.filter(x=>repo() && String(x.chatId)===String(repo().chatId)).length;
      await send(TOKEN,uid,
        "📁 <b>目录同步完成，开始同步仓库群文件</b>\n\n"+
        "📚 机器人目录："+result.total+" 个\n"+
        "✅ 目录已就绪："+syncedFolders+" 个\n"+
        "📦 仓库群文件："+repoCount+" 个\n"+
        "⚠️ 目录失败："+result.fail+" 个\n\n"+
        "🚀 现在上传仓库群里的文件，不只同步文件夹。",
        {parse_mode:"HTML",...cloud123Menu()}
      );
      return cloud123ScanAndUpload(uid);
    } catch(e) {
      return send(TOKEN,uid,"❌ 123云盘同步中断：\n上传暂时失败，请稍后重试。已上传的文件会跳过。",cloud123Menu());
    }
  }
  if(t==="🚀 扫描并上传"&&admin) {
    return cloud123ScanAndUpload(uid);
  }
  if(t==="🔄 云盘同步"&&admin) {
    return sendHtml(TOKEN,uid,cloud123StatusText(),cloud123Menu());
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
    },24*60*60*1000));
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
    },24*60*60*1000));
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
    states.set(key,{step:"upload_select",pendingUploads:[]});
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
    for(const item of db.resources.filter(r=>String(r.directoryId)===String(d.id))) {
      queueResourceFolderTag(item);
    }
    queueBaserowDirectorySync(d);
    touchSharedData(uid);
    saveDb();
    states.delete(key);
    logAdmin(uid,"修改文件夹名称",oldName+" → "+newName);
    return sendHtml(TOKEN,uid,"✅ <b>文件夹名称已修改</b>\\n\\n📁 原名称："+escapeHtml(oldName)+"\\n📁 新名称："+escapeHtml(newName),{reply_markup:uploadFolderInlineMenu()});
  }
  // 旧的主机器人 upload_folder 处理线已删除；文件夹选择只由 inline callback 负责。
  // upload_file 这里只处理文字控制按钮；文件/媒体统一由 receiveUploadMedia() 处理。
  if(s?.step==="upload_file"&&admin) {
    if(t==="/cancel" || t==="❌ 取消上传") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      states.delete(key);
      if(db.settings?.uploadSessions?.[key]) { delete db.settings.uploadSessions[key]; saveDb(); }
      return send(TOKEN,uid,"❌ <b>已取消本次上传</b>\n\n未入库的资源不会保存。",adminMenu());
    }
    if(t==="▶️ 继续上传") {
      if(uploadTimers.has(key)) clearTimeout(uploadTimers.get(key));
      return sendHtml(TOKEN,uid,"📤 <b>继续上传</b>\n\n请直接发送文件，系统会自动累计本批数量。",uploadBottomKeyboard());
    }
    if(t==="✅ 结束上传") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      const finishState=states.get(key)||s;
      const count=Array.isArray(finishState?.pendingUploads)?finishState.pendingUploads.length:0;
      if(!count) return sendHtml(TOKEN,uid,"⚠️ <b>当前批次没有收到文件</b>\n\n请先发送文件，再点击「✅ 结束上传」。",adminMenu());
      states.delete(key);
      if(db.settings?.uploadSessions?.[key]) { delete db.settings.uploadSessions[key]; saveDb(); }
      await sendHtml(TOKEN,uid,
        "⏳ <b>已结束上传</b>\n━━━━━━━━━━━━━━\n\n"+
        "📁 文件夹：<b>"+escapeHtml(finishState.directoryName||"未命名")+"</b>\n"+
        "📥 本批收到：<b>"+count+"</b> 个\n\n"+
        "📥 已收到，正在后台转入仓库群，你可以继续操作。",
        {reply_markup:{remove_keyboard:true}}
      ).catch(()=>{});
      void finalizeUpload(uid,finishState,TOKEN,key,adminMenu()).catch(e=>{
        console.error("❌ UPLOAD FINALIZE TEXT:",String(e?.message||e));
        sendHtml(TOKEN,uid,"❌ <b>上传整理失败</b>\n\n<code>"+escapeHtml(String(e?.message||e))+"</code>",adminMenu()).catch(()=>{});
      });
      return;
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
    },24*60*60*1000));
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
  // 子机器人消息处理不能等待 Google Sheets，避免 /start 和菜单被共享同步卡住。
  if(msg.chat?.type!=="private") return;
  const uid=msg.from.id;
  if(!isAdmin(uid) && db.settings?.redeemAccessBans?.[String(uid)]) return sendHtml(token,uid,"⛔ <b>此账号已被禁止使用机器人。</b>\n如有疑问，请联系管理员。");
  await ensureUserInlineMode(token, uid);
  // 子机器人上传状态与回调统一使用 token-aware key，多个子机器人互不串任务。
  const key=uploadStateKey(uid,true,token);
  const t=msg.text||"",s=states.get(key);
  const rawText=String(t||"").trim();
  if(s?.step==="redeem_code_input") {
    if(rawText==="/cancel") { states.delete(key); return sendHtml(token,uid,"已取消兑换。",childMenu()); }
    const result=redeemCode(uid,rawText,msg.from,token);
    states.delete(key);
    return sendHtml(token,uid,(result.ok?"<b>✅ 兑换成功</b>":"<b>❌ 兑换失败</b>")+"\n\n"+escapeHtml(result.message),childMenu());
  }
  if(rawText.toLowerCase().startsWith("/redeem")) {
    const code=rawText.replace(/^\/redeem(?:@\w+)?\s*/i,"").trim();
    if(!code) { states.set(key,{step:"redeem_code_input"}); return sendHtml(token,uid,"<b>🎟️ 使用兑换码</b>\n\n请发送兑换码。\n发送 /cancel 可取消。",childMenu()); }
    const result=redeemCode(uid,code,msg.from,token);
    return sendHtml(token,uid,(result.ok?"<b>✅ 兑换成功</b>":"<b>❌ 兑换失败</b>")+"\n\n"+escapeHtml(result.message),childMenu());
  }

  // 上传文件最高优先级：收到媒体后直接进入批量上传队列，避免被其他状态机拦截。
  if(isAdmin(uid) && s?.step==="upload_file") {
    const handled=await receiveUploadMedia(token,uid,key,s,msg,true);
    if(handled) return;
  }

  // 子机器人也支持在线客服：管理员回复机器人转发的消息即可回传用户。
  if(isAdmin(uid) && await supportHandleAdminReply(token,msg)) return;
  if(!isAdmin(uid) && await supportHandleUserMessage(token,msg)) return;
  const startCommand=t.split(" ")[0].split("@")[0];

  // 主机器人和所有子机器人共用同一个 db.resources / db.directories。
  if(startCommand==="/start" && t.startsWith("/start share_")) {
    const shareToken=t.slice("/start share_".length).trim();
    const item=getResourceByShareToken(shareToken);
    if(!item) return sendHtml(token,uid,"<b>🔗 分享资源</b>\n\n❌ 这个分享链接已失效或资源不存在。",childMenu());
    const member=await allowed(TOKEN,uid);
    const guest=withoutVideosForGuest([item],member,uid);
    if(!guest.items.length) return guestVideoNotice(token,uid);
    try {
      await sendIndexedResource(token,uid,item);
      recordStat(uid,"download",1);
      recordResourceDownload(item);
      recordRecent(uid,item);
      if(!member&&!isAdmin(uid)) consumeVideoQuota(uid,[item]); else saveDb();
      return sendHtml(token,uid,"<b>🔗 分享资源</b>\n━━━━━━━━━━━━━━\n\n📦 <b>"+escapeHtml(item.title||"未命名资源")+"</b>\n📁 文件夹：<b>"+escapeHtml(db.directories.find(d=>String(d.id)===String(item.directoryId))?.name||"未分类")+"</b>\n\n✅ 资源已发送。",childMenu());
    } catch {
      return sendHtml(token,uid,"<b>❌ 资源获取失败</b>\n\n请稍后重试。",childMenu());
    }
  }

  if(t==="⭐ 我的资源") return sendHtml(token,uid,userFeatureText(),{reply_markup:userFeatureKeyboard()});

  if(isAdmin(uid) && (startCommand==="/start" || t==="⚙️ 管理中心")) {
    return sendHtml(token,uid,
      "<b>⚙️ 管理中心</b>\\n━━━━━━━━━━━━━━\\n\\n📤 <b>上传资源</b>\\n\\n👇 点击上传资源开始操作",
      childAdminMenu());
  }

  if(startCommand==="/start" || t==="🏠 开始") return sendHtml(token,uid,
    "<b>👋 欢迎使用资源机器人</b>\n\n📚 <b>共享资源功能</b>：目录 · 搜索 · 随机 · 最新\n💬 <b>在线客服</b>：联系客服\n\n👇 <i>请选择下方功能</i>",childMenu());

  // 子机器人管理员上传：必须在 allowed() 之前处理，否则管理员若未加入指定群会被拦截。
  if(isAdmin(uid) && s?.step==="upload_folder") {
    if(t==="/cancel") { states.delete(key); return sendHtml(token,uid,"<b>❌ 已取消上传</b>\\n\\n本次上传没有入库。",childAdminMenu()); }
    const media=msg.document||msg.video||msg.audio||msg.animation||msg.photo?.at(-1)||msg.voice||msg.video_note;
    let folder=t.trim().slice(0,80);
    if(folder.startsWith("📁 ")) folder=folder.slice(2).replace(/（\d+）$/,"").trim();
    if(t==="➕ 新建文件夹") folder="";
    if(!folder && media) folder="未命名-"+Math.random().toString(36).slice(2,8);
    if(!folder && t==="➕ 新建文件夹") return sendHtml(token,uid,"<b>📁 新建文件夹</b>\\n\\n请发送新的文件夹名称。\\n\\n发送 /cancel 可取消。");
    if(!folder) return sendHtml(token,uid,"⚠️ 请选择已有文件夹、发送新的文件夹名称，或者直接发送第一个文件。");
    let existing=getDirectoryByName(folder);
    if(!existing) {
      existing=ensureDirectory(folder);
      if(existing) { touchSharedData(uid); saveDb(); console.log("📁 CHILD UPLOAD FOLDER CREATED:", "bot="+tokenFingerprint(token), "uid="+uid, "folder="+existing.name); }
    }
    if(!existing) { states.delete(key); return sendHtml(token,uid,"<b>❌ 文件夹创建失败</b>\\n\\n请重新点击上传资源再试。",childAdminMenu()); }
    const firstPending=media?[{messageId:Number(msg.message_id),msg}]:[];
    states.set(key,{step:"upload_file",directoryId:existing.id,directoryName:existing.name,pendingUploads:firstPending});
    console.log("📤 CHILD UPLOAD SESSION START:", "bot="+tokenFingerprint(token), "uid="+uid, "folder="+existing.name, "pending="+firstPending.length);
    if(media) {
      return;
    }
    return sendHtml(token,uid,"<b>📁 文件夹："+escapeHtml(existing.name)+"</b>\\n\\n现在请发送文件、图片、视频、音频或其他资源。\\n\\n发送 /cancel 可取消。");
  }

  // 子机器人与主机器人统一走同一个媒体上传处理器，避免两套“已收到/批量入库”逻辑互相抢消息。
  if(isAdmin(uid) && s?.step==="upload_file") {
    if(t==="/cancel" || t==="❌ 取消上传") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      states.delete(key);
      return sendHtml(token,uid,"<b>❌ 已取消本次上传</b>\n\n未入库的资源不会保存。",childAdminMenu());
    }
    if(t==="▶️ 继续上传") {
      void sendHtml(token,uid,"📤 <b>继续上传</b>\n\n请直接发送文件，系统会自动累计本批数量。",{reply_markup:uploadBottomKeyboard()});
      return;
    }
    if(t==="✅ 结束上传") {
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      void sendHtml(token,uid,"🔄 <b>正在结束上传</b>\n\n正在统一转存本批资源，请稍候……",{reply_markup:{remove_keyboard:true}}).catch(()=>{});
      void finalizeUpload(uid,s,token,key,childAdminMenu()).catch(e=>console.error("❌ CHILD UPLOAD FINALIZE:",String(e?.message||e)));
      states.delete(key);
      return;
    }
    const handled=await withUploadLock(key,()=>receiveUploadMedia(token,uid,key,states.get(key)||s,msg,true));
    if(handled) return;
  }

  if(String(t||"").replace(/[\uFE0E\uFE0F]/g,"").replace(/\s+/g,"").trim()==="📂资源目录") {
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
    const n=Number(t);if(!Number.isInteger(n)||n<0||n>3)return sendHtml(token,uid,"❌ 请输入 0～3 的整数；非会员每日上限最多为 3 个资源。",adminMenu());
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
const callbackDedupe = new Map();

async function handleDirectoryCallback(token, q, child=false) {
  const uid=q.from?.id;
  const data=String(q.data||"");
  const callbackId=q.id;
  const chatId=q.message?.chat?.id;
  const messageId=q.message?.message_id;

  if(!uid || !callbackId || !chatId || !messageId) return;

  // 回调必须独立于 Google Sheets：先确认点击，再执行按钮逻辑。
  console.log("🔘 CALLBACK:", data, "uid="+uid, "chat="+chatId);
  let callbackAnswered=false;
  const answer=async(text="",showAlert=false)=>{
    if(callbackAnswered) return;
    callbackAnswered=true;
    try {
      const body={callback_query_id:callbackId};
      if(text) { body.text=text; body.show_alert=showAlert; }
      await tg(token,"answerCallbackQuery",body);
    } catch(e) {
      // 查询过期/ID无效属于 Telegram 正常业务拒绝，不影响按钮后续逻辑。
      console.warn("⚠️ callback确认失败（继续处理按钮）:", String(e?.telegramDescription || e?.message || e));
    }
  };
  const activeBan=db.settings?.redeemAccessBans?.[String(uid)];
  if(activeBan && !isAdmin(uid)) { await answer("该账号已被禁止使用机器人",true); return; }

  // 内联按钮防重复点击：Telegram/网络重试可能在极短时间内产生多个 callback，
  // 如果同时执行“下一页/返回/开始同步”等动作，就会出现重复页面或跳转错乱。
  const callbackDedupeKey=tokenFingerprint(token)+":"+String(chatId)+":"+String(messageId)+":"+data;
  const callbackDedupeNow=Date.now();
  const callbackDedupeLast=callbackDedupe.get(callbackDedupeKey)||0;
  if(callbackDedupeLast && callbackDedupeNow-callbackDedupeLast<2500){
    await answer("请勿重复点击",false);
    return;
  }
  callbackDedupe.set(callbackDedupeKey,callbackDedupeNow);
  // 正常情况下 3 秒后释放；同时设硬上限，避免异常流量导致 Map 持续增长。
  const callbackDedupeTimer=setTimeout(()=>{
    // 只有当前这次点击仍是最新记录时才清理，避免旧定时器误删后来点击的防重记录。
    if(callbackDedupe.get(callbackDedupeKey)===callbackDedupeNow) callbackDedupe.delete(callbackDedupeKey);
  },3000);
  callbackDedupeTimer.unref?.();
  if(callbackDedupe.size>5000) {
    const cutoff=callbackDedupeNow-10000;
    for(const [key,at] of callbackDedupe) {
      if(at<cutoff) callbackDedupe.delete(key);
      if(callbackDedupe.size<=4000) break;
    }
    while(callbackDedupe.size>5000) {
      const firstKey=callbackDedupe.keys().next().value;
      if(firstKey===undefined) break;
      callbackDedupe.delete(firstKey);
    }
  }

  if(data==="adm:repo_unbind_confirm") {
    const current=repo();
    if(!current) {
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📦 当前没有绑定资源仓库</b>\\n\\n无需解绑。",parse_mode:"HTML",reply_markup:adminResourceInline()});
    }
    const title=String(current.title||current.chatId||"未命名仓库");
    const cid=String(current.chatId||"").trim();
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"<b>⚠️ 确认解绑资源仓库</b>\\n━━━━━━━━━━━━━━\\n\\n"+
        "📦 仓库：<b>"+escapeHtml(title)+"</b>\\n"+
        "🆔 <code>"+escapeHtml(cid)+"</code>\\n\\n"+
        "解绑后：\\n"+
        "• 停止使用该仓库作为资源来源\\n"+
        "• 清除本地该仓库的资源索引\\n"+
        "• 随机获取 / 最新资源不会再抽到这些资源\\n"+
        "• 后续扫描也不会继续读取该仓库\\n\\n"+
        "⚠️ 仅清除机器人里的资源记录，不会删除 Telegram 群/频道里的原消息。\\n\\n"+
        "<b>确定要解绑吗？</b>",
      parse_mode:"HTML",
      reply_markup:{inline_keyboard:[
        [{text:"⚠️ 确认解绑",callback_data:"adm:repo_unbind"}],
        [{text:"⬅️ 返回仓库管理",callback_data:"adm:repo"}]
      ]}
    });
  }

  if(data==="adm:repo_unbind") {
    const current=repo();
    if(!current) {
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📦 当前没有绑定资源仓库</b>",parse_mode:"HTML",reply_markup:adminResourceInline()});
    }
    const cid=String(current.chatId||"").trim();
    const oldResources=Array.isArray(db.resources) ? db.resources : [];
    const removed=cid ? oldResources.filter(x=>String(x?.chatId||"").trim()===cid) : [];
    db.resources=cid ? oldResources.filter(x=>String(x?.chatId||"").trim()!==cid) : oldResources;

    // 删除随机历史、收藏、最近浏览中的旧仓库记录，避免解绑后再次被引用。
    for(const key of ["randomHistory","userFavorites","userRecent"]) {
      const store=db.settings?.[key];
      if(!store || typeof store!=="object") continue;
      for(const uidKey of Object.keys(store)) {
        if(Array.isArray(store[uidKey])) {
          store[uidKey]=store[uidKey].filter(id=>!removed.some(item=>resourceKey(item)===String(id)));
        }
      }
    }

    // 当前仓库已经失效，停止相关自动同步/迁移状态，防止后台继续引用它。
    const auto=db.settings?.repositoryAutoSync;
    if(auto && (String(auto.sourceId||"")===cid || String(auto.targetId||"")===cid)) {
      db.settings.repositoryAutoSync={enabled:false,status:"idle",ownerId:"",sourceId:"",targetId:"",sourceTitle:"",targetTitle:"",lastMessageId:0,queue:[],copied:0,failed:0,lastError:"",updatedAt:Date.now()};
    }
    const mig=db.settings?.repositoryMigration;
    if(mig && (String(mig.sourceId||"")===cid || String(mig.targetId||"")===cid)) {
      mig.autoSync=false;
      mig.status="idle";
      mig.queue=[];
      mig.source=null;
      mig.target=null;
      mig.sourceId=null;
      mig.targetId=null;
      mig.completedKeys=[];
      mig.failedKeys=[];
    }

    db.settings.repository=null;
    db.settings.resourceSources=Array.isArray(db.settings.resourceSources)
      ? db.settings.resourceSources.filter(x=>String(x?.chatId||"").trim()!==cid)
      : [];
    if(db.settings.randomHistory && typeof db.settings.randomHistory==="object") {
      const validIds=new Set(db.resources.map(resourceKey));
      for(const uidKey of Object.keys(db.settings.randomHistory)) {
        db.settings.randomHistory[uidKey]=(db.settings.randomHistory[uidKey]||[]).filter(id=>validIds.has(String(id)));
      }
    }
    saveDb();

    // Google Sheets 中同步删除该仓库对应的资源行；失败不会阻塞解绑本身。
    for(const item of removed) {
      try { queueBaserowDeleteResource(item); } catch {}
    }

    logAdmin(uid,"解绑资源仓库","chatId="+cid+" removed="+removed.length);
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"<b>✅ 资源仓库已解绑</b>\\n━━━━━━━━━━━━━━\\n\\n"+
        "📦 原仓库："+escapeHtml(current.title||cid)+"\\n"+
        "🆔 <code>"+escapeHtml(cid)+"</code>\\n"+
        "🧹 已清除资源索引：<b>"+removed.length+"</b> 条\\n\\n"+
        "现在机器人不会再从这个仓库读取、扫描或随机获取资源。\\n\\n"+
        "💡 如果要换新仓库，点击「📦 资源仓库」→「🔄 重新绑定」。",
      parse_mode:"HTML",
      reply_markup:adminResourceInline()
    });
  }


  // 用户首页内联按钮：统一处理资源目录、搜索、随机、最新，避免 user:* 回调落空。
  if(data.startsWith("user:")) {
    const action=data.slice("user:".length);
    if(action==="redeem") {
      const key=child ? uploadStateKey(uid,true,token) : "m:"+uid;
      states.set(key,{step:"redeem_code_input"});
      await answer("请发送兑换码");
      return sendHtml(token,uid,"<b>🎟️ 使用兑换码</b>\n━━━━━━━━━━━━━━\n\n请发送你的兑换码。\n也可以直接发送 <code>/redeem 兑换码</code>。\n发送 /cancel 可取消。",child?childMenu():userMenu());
    }
    if(action==="search") {
      const key=child ? uploadStateKey(uid,true,token) : "m:"+uid;
      states.set(key,{step:"search"});
      await answer("请输入搜索关键词");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"<b>🔎 搜索资源</b>\\n\\n请输入标题、作者名或关键词。\\n\\n💡 建议先输入较短的关键词；结果较多时可使用分页。\\n↩️ 发送 <code>/cancel</code> 可退出搜索。",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[
          [{text:"❌ 取消搜索",callback_data:"src"}],
          [{text:"🏠 返回首页",callback_data:"user:home"}]
        ]}
      });
    }
    if(action==="dirs") {
      const key=(child ? "c:" : "m:")+uid;
      states.delete(key);
      await answer("正在打开资源目录");
      try {
        const edited=await safeEdit(token,{chat_id:chatId,message_id:messageId,text:directoryText(),parse_mode:"HTML",reply_markup:directoryInlineKeyboard()});
        if(edited) return edited;
      } catch(e) {
        console.warn("USER DIRECTORY OPEN EDIT FAILED:",String(e?.telegramDescription||e?.message||e));
      }
      return sendHtml(token,chatId,directoryText(),{reply_markup:directoryInlineKeyboard()});
    }
    if(action==="random" || action==="latest") {
      void tg(token,"editMessageReplyMarkup",{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}}).catch(()=>{});
      if(action==="random") {
        await answer("正在随机获取");
        return deliver(token,uid,uid,random10(uid),token,{mode:"random",offset:0,total:db.resources.length});
      }
      await answer("正在获取最新资源");
      return deliver(token,uid,uid,db.resources.slice(0,10),token,{mode:"latest",offset:0,total:db.resources.length});
    }
    if(action==="home") {
      const key=(child ? "c:" : "m:")+uid;
      states.delete(key);
      await answer("已返回首页");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:isAdmin(uid)?adminStatusText():userHomeText(uid),
        parse_mode:"HTML",
        reply_markup:isAdmin(uid)?adminRootInline():userHomeInlineKeyboard().reply_markup
      });
    }
    if(action==="clone") {
      await answer("该功能暂未开放");
      return;
    }
  }

  // 上传结束必须最高优先级处理：先立即给按钮一个可见结果，再后台转存，避免任何共享同步/菜单逻辑拦截。
  if(isAdmin(uid) && data==="upload_finish") {
    const finishKey=uploadStateKey(uid,child,token);
    const finishState=restoreUploadState(finishKey);
    if(!finishState || finishState.step!=="upload_file") {
      await answer("当前没有进行中的上传",true);
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"⚠️ <b>当前没有进行中的上传</b>\n\n请重新点击「📤 上传资源」开始。",parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
    }
    if(uploadTimers.has(finishKey)){clearTimeout(uploadTimers.get(finishKey));uploadTimers.delete(finishKey);}
    if(uploadAckTimers.has(finishKey)){clearTimeout(uploadAckTimers.get(finishKey));uploadAckTimers.delete(finishKey);}
    const count=Array.isArray(finishState.pendingUploads)?finishState.pendingUploads.length:0;
    await answer(count?"已结束，正在整理资源":"当前批次没有文件",false);
    // 先编辑当前按钮消息，确保用户立即看到响应。
    await safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"⏳ <b>已结束上传</b>\n━━━━━━━━━━━━━━\n\n📁 文件夹：<b>"+escapeHtml(finishState.directoryName||"未命名")+"</b>\n📥 本批收到：<b>"+count+"</b> 个\n\n📥 已收到，正在后台转入仓库群，你可以继续操作。",
      parse_mode:"HTML",reply_markup:{inline_keyboard:[]}});
    if(!count){
      states.delete(finishKey);
      return;
    }
    void finalizeUpload(uid,finishState,token,finishKey,child?childAdminMenu():adminMenu()).catch(e=>{
      console.error("❌ UPLOAD FINALIZE BACKGROUND:",String(e?.message||e));
      sendHtml(token,uid,"❌ <b>上传整理失败</b>\n\n<code>"+escapeHtml(String(e?.message||e))+"</code>",child?childAdminMenu():adminMenu()).catch(()=>{});
    });
    return;
  }

  void answer();
  // 自动同步控制按钮优先处理，避免被其他管理员菜单路由抢先截断。
  if(data==="adm:auto_stop"){
    await answer("正在停止自动同步…");
    await stopRepositoryAutoSync();
    const a=repositoryAutoSyncState();
    a.sourceId="";a.targetId="";a.sourceTitle="";a.targetTitle="";a.ownerId="";
    a.queue=[];a.lastMessageId=0;a.status="stopped";a.updatedAt=Date.now();saveDb();
    return safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"<b>⏸️ 自动同步已停止</b>\n━━━━━━━━━━━━━━\n\n旧仓库和新仓库已解除当前自动同步绑定。\n\n现在可以重新设置旧仓库和新仓库。",
      parse_mode:"HTML",
      reply_markup:{inline_keyboard:[
        [{text:"🔄 重新绑定旧仓库 / 新仓库",callback_data:"adm:auto"}],
        [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
      ]}});
  }
  if(data==="adm:auto_resume"){
    await answer("正在恢复自动同步…");
    const a=repositoryAutoSyncState();
    if(!a.sourceId||!a.targetId){
      return safeEdit(token,{chat_id:chatId,message_id:messageId,
        text:"<b>⚠️ 无法继续自动同步</b>\n\n旧仓库或新仓库绑定信息已不存在，请重新绑定。",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[
          [{text:"🔄 重新绑定旧仓库 / 新仓库",callback_data:"adm:auto"}],
          [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
        ]}});
    }
    a.enabled=true;a.status="running";a.updatedAt=Date.now();saveDb();
    processRepositoryAutoSyncQueue().catch(e=>console.error("❌ 自动同步恢复失败:",String(e?.message||e)));
    return showRepositoryAutoSyncStatus(uid);
  }
  if(data==="adm:auto_status"){
    await answer();
    return showRepositoryAutoSyncStatus(uid);
  }

  if(data==="support:start") {
    supportOpenSession(token,uid);
    return safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"<b>💬 在线客服</b>\\n━━━━━━━━━━━━━━\\n\\n👋 你已进入客服会话\\n\\n📨 直接发送问题、文字、图片、视频或文件即可。\\n💬 客服回复后会自动发送给你。\\n\\n📌 需要结束时，点击下方「❌ 结束客服」。",
      parse_mode:"HTML",reply_markup:supportUserKeyboard()});
  }
  if(data==="support:admin_end" || data.startsWith("support:admin_end:")) {
    if(!isAdmin(uid)) {
      await answer("无权操作");
      return;
    }
    const targetUserId = Number(data.startsWith("support:admin_end:") ? data.slice("support:admin_end:".length) : "");
    if(!Number.isFinite(targetUserId) || targetUserId <= 0) {
      await answer("用户信息无效");
      return;
    }
    if(!supportIsOpen(token,targetUserId)) {
      await answer("该会话已经结束");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,
        text:"<b>💬 客服会话已结束</b>\\n\\n该用户的会话已结束或超时。",
        parse_mode:"HTML"});
    }
    supportCloseSession(token,targetUserId);
    try {
      await sendHtml(token,targetUserId,"<b>💬 客服会话已结束</b>\\n\\n客服已结束本次会话。如需帮助，可以再次点击「💬 联系客服」。",userMenu());
    } catch(e) {
      console.warn("⚠️ 管理员结束客服后通知用户失败:",String(e?.message||e));
    }
    await answer("已结束客服会话");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"<b>💬 客服会话已结束</b>\\n━━━━━━━━━━━━━━\\n用户 <code>"+escapeHtml(String(targetUserId))+"</code> 的会话已由管理员结束。\\n\\n当前进行中的会话："+supportActiveSessions().length+" 个。",
      parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"💬 返回在线客服",callback_data:"support:admin"}],[{text:"⬅️ 返回管理",callback_data:"admin:ops"}]]}});
  }
  if(data==="support:end") {
    supportRememberToken(token);
    supportCloseSession(token,uid);
    return safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"<b>💬 客服会话已结束</b>\\n━━━━━━━━━━━━━━\\n\\n📭 本次客服会话已结束。\\n\\n💬 如需帮助，可再次点击「💬 联系客服」。",
      parse_mode:"HTML",reply_markup:userHomeInlineKeyboard().reply_markup});
  }
  if(data==="support:admin" && isAdmin(uid)) {
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:supportAdminText()+"\\n\\n🔗 客服链接："+(supportLink()?escapeHtml(supportLink()):"未设置")+"\\n\\n👇 可直接点击对应用户的「结束」按钮，立即关闭该会话。",parse_mode:"HTML",reply_markup:supportAdminKeyboard()});
  }
  if(data==="support:link" && isAdmin(uid)) {
    states.set("m:"+uid,{step:"support_link"});
    await answer("请发送链接");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🔗 设置客服链接</b>\n\n请发送要放在客服里的网址。\n例如：https://t.me/yourname\n\n发送 0 可清除链接。",parse_mode:"HTML"});
  }
  if(data==="hub"||data.startsWith("hub:")){
    const mode=data.split(":")[1]||"home";
    if(mode==="home")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureText(),parse_mode:"HTML",reply_markup:userFeatureKeyboard()});
    if(mode==="fav"){const items=userFavorites(uid).map(resourceByKey).filter(Boolean);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("⭐ 我的收藏",items),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"getfav:")});}
    if(mode==="recent"){const ids=Array.isArray(db.settings.userRecent?.[String(uid)])?db.settings.userRecent[String(uid)]:[];const items=ids.map(resourceByKey).filter(Boolean);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("🕘 最近浏览",items),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"getrecent:")});}
    if(mode==="hot"){const items=[...db.resources].sort((a,b)=>Number(b.downloads||0)-Number(a.downloads||0)).slice(0,20);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("🔥 热门资源",items,"按获取次数排序"),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"gethot:")});}
    if(mode==="tags"){const map=allResourceTags();const tags=Object.keys(map).sort((a,b)=>map[b].length-map[a].length).slice(0,30);const rows=[];for(let i=0;i<tags.length;i+=2)rows.push(tags.slice(i,i+2).map(t=>({text:"🏷️ "+t.slice(0,18)+" · "+map[t].length,callback_data:"tag:"+t.slice(0,40)})));if(!rows.length)rows.push([{text:"📭 暂无标签",callback_data:"noop"}]);rows.push([{text:"⬅️ 返回",callback_data:"hub"}]);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🏷️ 标签分类</b>\n━━━━━━━━━━━━━━\n\n📚 标签数：<b>"+tags.length+"</b>\n\n👇 请选择标签",parse_mode:"HTML",reply_markup:{inline_keyboard:rows}});}
  }
  if(data.startsWith("tag:")){void answer();const tag=data.slice(4),items=db.resources.filter(x=>resourceTags(x).includes(tag)).slice(0,20);return safeEdit(token,{chat_id:chatId,message_id:messageId,text:userFeatureListText("🏷️ "+escapeHtml(tag),items),parse_mode:"HTML",reply_markup:userFeatureListKeyboard(items,"gettag:","hub:tags")});}
  if(data.startsWith("favtoggle:")){const item=resourceByKey(data.slice(10));if(!item){void answer("资源不存在",true);return;}const on=toggleFavorite(uid,item);void answer(on?"⭐ 已收藏":"☆ 已取消收藏");return;}
  for(const prefix of ["getfav:","getrecent:","gethot:","gettag:"]){
    if(data.startsWith(prefix)){
      const item=resourceByKey(data.slice(prefix.length));if(!item){void answer("资源不存在或已删除",true);return;}
      const member=await allowed(TOKEN,uid);if(!member && !isAdmin(uid) && nonMemberDailyRemaining(uid)<=0){void answer("今日免费资源额度已用完",true);return guestVideoNotice(token,chatId);}
      try{void answer("正在获取资源…");await sendIndexedResource(token,chatId,item);recordStat(uid,"download",1);recordResourceDownload(item);recordRecent(uid,item);if(!member&&!isAdmin(uid))consumeNonMemberQuota(uid,1);else saveDb();return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>✅ 已发送资源</b>\n\n📦 "+escapeHtml(item.title||"未命名资源")+"\n\n👇 可以继续浏览",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:isFavorite(uid,item)?"⭐ 已收藏":"☆ 收藏",callback_data:"favtoggle:"+resourceKey(item)}],
        [{text:"⬅️ 返回我的资源",callback_data:"hub"}]
      ]}});}catch(e){void answer("获取失败："+String(e.message||e),true);return;}
    }
  }
  // 管理后台旧文字入口与内联按钮统一：这些按钮直接复用原有文字菜单处理逻辑，避免出现“按钮能显示但点了没反应”。
  if(data==="adm:rename") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"✏️ 修改文件夹"});
  if(data==="adm:delete") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🗑️ 删除资源"});
  if(data==="adm:move") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🔄 移动资源"});
  if(data==="adm:bulk") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📦 批量管理"});
  if(data==="adm:repo") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📦 资源仓库"});
  if(data==="adm:scan") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🔍 仓库扫描"});
  if(data==="adm:redeem") {
    const store=redemptionStore(), all=Object.values(store.redemptionCodes);
    const unused=all.filter(x=>!x.usedAt&&!x.usedBy).length, used=all.length-unused;
    if(states.get("m:"+uid)?.step==="redeem_ban_user") states.delete("m:"+uid);
    if(db.settings?.redeemAdminStates?.[String(uid)]?.step==="redeem_ban_user") { delete db.settings.redeemAdminStates[String(uid)]; saveDb(); }
    const bannedCount=Object.keys(db.settings?.redeemAccessBans||{}).length;
    await answer("打开兑换码管理");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,
      text:"<b>🎟️ 兑换码管理</b>\n━━━━━━━━━━━━━━\n\n📦 总计："+all.length+" 个\n🟢 未使用："+unused+" 个\n☑️ 已兑换："+used+" 个\n🚫 已封禁机器人使用权限："+bannedCount+" 人\n\n👇 可批量生成兑换码，或封禁指定用户并将其移出会员群。",
      parse_mode:"HTML",reply_markup:redeemAdminInline()});
  }
  if(data==="adm:group") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🔐 指定群管理"});
  if(data==="adm:admins") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"👥 管理员管理"});
  if(data==="adm:stats") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📊 数据统计"});
  if(data==="adm:broadcast") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📢 广播消息"});
  if(data==="adm:logs") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📜 操作日志"});
  if(data==="adm:pin") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📌 广播后置顶"});
  if(data==="adm:clone") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🤖 克隆机器人"});
  if(data==="adm:repo_bind") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📦 资源仓库"});

  if(data==="bind_repo_cancel") { states.delete("m:"+uid); states.delete(uploadStateKey(uid,child,token)); await answer("已取消绑定"); return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>↩️ 已取消绑定资源仓库</b>\n\n当前仓库："+(repo()?.title?"✅ "+escapeHtml(repo().title):"❌ 未绑定"),parse_mode:"HTML",reply_markup:adminResourceInline()}); }
  if(data.startsWith("admin:")||data.startsWith("adm:")){void answer();
    if(!isAdmin(uid) || (child && data!=="admin:upload" && data!=="admin:home")){void answer("无权限",true);return;}
    const route=data.slice(data.indexOf(":")+1);
    const key=uploadStateKey(uid,child,token);
    if(data==="admin:backupbot"){
      const cfg=backupBotConfig();
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🛟 备份机器人</b>\n━━━━━━━━━━━━━━\n\n状态："+(cfg.token?"✅ 已配置":"❌ 未配置")+"\n\n主机器人入库后，会把文件再发给备份机器人保存编号。主机器人被封后，可从备份复制回来。\n\n请先给备份机器人发 /start。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"➕ 设置备份 Token",callback_data:"admin:backupbot_set"}],[{text:"📤 补备份现有文件",callback_data:"admin:backup_fill"}],[{text:"📥 从备份复制回来",callback_data:"admin:backup_copy"}],[{text:"⬅️ 返回管理",callback_data:"admin:root"}]]}});
    }
    if(data==="admin:backup_fill"){
      if(!backupBotConfig().token) return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"❌ 请先设置备份机器人 Token。",reply_markup:adminRootInline()});
      await answer("开始补备份");
      backfillBackupBot(uid).catch(e=>sendHtml(TOKEN,uid,"❌ 补备份失败：\n"+escapeHtml(String(e?.message||e)),adminMenu()));
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📤 正在补备份现有文件</b>\n\n后台进行，不会逐条发消息。完成后只回一次结果。",parse_mode:"HTML",reply_markup:adminRootInline()});
    }
    if(data==="admin:backup_copy"){
      await answer("开始从备份复制");
      restoreFromBackupBot(uid).catch(e=>sendHtml(TOKEN,uid,"❌ 从备份复制失败：\n"+escapeHtml(String(e?.message||e)),adminMenu()));
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🛟 正在从备份机器人复制</b>\n\n文件会重新发给当前机器人并放入原文件夹。数量多时会在后台继续。",parse_mode:"HTML",reply_markup:adminRootInline()});
    }
    if(data==="admin:backupbot_set"){
      states.set("m:"+uid,{step:"backup_token"});
      await answer("请发送 Token");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🛟 设置备份机器人</b>\n\n请发送备份机器人的 Token。\n发送 0 可清除。\n\n设置后请先给备份机器人发一次 /start。",parse_mode:"HTML"});
    }
    if(data==="admin:root")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:adminStatusText(),parse_mode:"HTML",reply_markup:adminRootInline()});
    if(data==="admin:home")return sendHtml(token,uid,"<b>👋 已返回首页</b>\n\n请选择功能。",userMenu());
    if(data==="adm:redeem_ban") {
      const banState={step:"redeem_ban_user"};
      states.set("m:"+uid,banState);
      if(!db.settings.redeemAdminStates||typeof db.settings.redeemAdminStates!=="object") db.settings.redeemAdminStates={};
      db.settings.redeemAdminStates[String(uid)]=banState;
      saveDb();
      await answer("请输入要封禁的用户 ID");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,
        text:"<b>🚫 封禁会员使用权限</b>\n━━━━━━━━━━━━━━\n\n请发送要封禁用户的 Telegram 数字 ID。\n\n执行后会：\n• 禁止该用户使用主机器人及子机器人\n• 尝试将其移出当前配置的指定会员群\n• 保留会员记录、兑换码记录和其他数据\n\n注意：群移出需要机器人具备群管理权限。\n发送 /cancel 可取消。",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[[{text:"⬅️ 取消并返回",callback_data:"adm:redeem"}]]}
      });
    }
    if(data==="adm:redeem_make") {
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🎟️ 批量生成兑换码</b>\n\n请选择每个兑换码的奖励类型。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:"💎 会员天数",callback_data:"adm:redeem_type:membership_days"}],
        [{text:"♾️ 永久会员",callback_data:"adm:redeem_type:membership_permanent"}],
        [{text:"🎬 额外视频额度",callback_data:"adm:redeem_type:video_credits"}],
        [{text:"⬅️ 返回兑换码管理",callback_data:"adm:redeem"}]
      ]}});
    }
    if(data==="adm:redeem_message") {
      const current=String(db.settings?.redeemSuccessMessage||"");
      const redeemState={step:"redeem_success_message"};
      states.set("m:"+uid,redeemState);
      if(!db.settings.redeemAdminStates||typeof db.settings.redeemAdminStates!=="object") db.settings.redeemAdminStates={};
      db.settings.redeemAdminStates[String(uid)]=redeemState; saveDb();
      return sendHtml(TOKEN,uid,"<b>✏️ 编辑兑换成功消息</b>\n\n请直接发送用户兑换成功后看到的消息。可用变量：\n<code>{type}</code> 奖励类型\n<code>{reward}</code> 奖励内容\n<code>{days}</code> 会员天数\n<code>{expiry}</code> 到期时间\n<code>{quota}</code> 剩余视频额度\n\n"+(current?"当前自定义消息：\n"+escapeHtml(current)+"\n\n":"当前使用系统默认消息。\n\n")+"发送 /cancel 可取消。",adminMenu());
    }
    if(data.startsWith("adm:redeem_type:")) {
      const type=data.slice("adm:redeem_type:".length);
      if(!["membership_days","membership_permanent","video_credits"].includes(type)) { void answer("奖励类型无效",true); return; }
      if(type==="membership_permanent") {
        const redeemState={step:"redeem_batch_count",rewardType:type,rewardAmount:1};
        states.set("m:"+uid,redeemState);
        if(!db.settings.redeemAdminStates||typeof db.settings.redeemAdminStates!=="object") db.settings.redeemAdminStates={};
        db.settings.redeemAdminStates[String(uid)]=redeemState; saveDb();
        return sendHtml(TOKEN,uid,"<b>♾️ 生成永久会员兑换码</b>\n\n每个兑换码奖励：永久会员。\n请输入本次生成数量（1～100）。\n发送 /cancel 可取消。",adminMenu());
      }
      const redeemState={step:"redeem_reward_amount",rewardType:type};
      states.set("m:"+uid,redeemState);
      if(!db.settings.redeemAdminStates||typeof db.settings.redeemAdminStates!=="object") db.settings.redeemAdminStates={};
      db.settings.redeemAdminStates[String(uid)]=redeemState; saveDb();
      return sendHtml(TOKEN,uid,"<b>🎟️ 设置兑换奖励</b>\n\n"+(type==="membership_days"?"请输入每个兑换码奖励的会员天数（1～3650）。":"请输入每个兑换码奖励的额外视频次数（1～100000）。")+"\n发送 /cancel 可取消。",adminMenu());
    }
    if(data==="adm:cloud_retry"){
      let reset=0;
      for(const item of db.resources){
        if(item.cloud123?.error && !item.cloud123?.uploaded){
          item.cloud123.attempts=0;
          item.cloud123.error="";
          reset++;
        }
      }
      saveDb();
      await answer("已加入重试");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🔁 已重新加入失败文件</b>\n\n数量：<b>"+reset+"</b> 个\n\n后台会静默重试，点刷新可看剩余。",parse_mode:"HTML",reply_markup:cloud123Menu().reply_markup});
    }
    if(data==="adm:cloud123" || data==="adm:cloud_sync" || data==="adm:cloud_scan" || data==="adm:cloud_setup" || data==="adm:cloud_test"){
      await answer(data==="adm:cloud_scan" ? "开始扫描上传" : "打开123云盘");
      if(data==="adm:cloud_scan" && typeof cloud123ScanAndUpload==="function") return cloud123ScanAndUpload(uid);
      if(data==="adm:cloud_setup") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🔗 配置123云盘"});
      if(data==="adm:cloud_test") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🧪 测试连接"});
      if(data==="adm:cloud_sync") return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"📁 同步机器人目录"});
      if(typeof cloud123StatusText==="function" && typeof cloud123Menu==="function"){
        const status=cloud123StatusText();
        const edited=await safeEdit(token,{chat_id:chatId,message_id:messageId,text:status,parse_mode:"HTML",reply_markup:cloud123Menu().reply_markup});
        if(edited) return edited;
        return sendHtml(token,uid,status,cloud123Menu());
      }
      return sendHtml(token,uid,"<b>☁️ 123云盘</b>\n━━━━━━━━━━━━━━\n\n扫描上传功能还没加载，所以刚才点了没有开始。\n\n先配置 WebDAV 后，再在服务器执行：\n<code>node cloud123-runtime.js</code>\n然后重启机器人。",{reply_markup:{inline_keyboard:[[{text:"🔄 再试一次扫描上传",callback_data:"adm:cloud_scan"}],[{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]]}});
    }
    if(data==="adm:cloud_account"){
      await answer("打开123云盘账号");
      const auth=db.settings.historyAuth||{};
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"<b>🔐 123云盘账号</b>\n━━━━━━━━━━━━━━\n\n📌 与扫描仓库账号共用同一个 Telegram 账号。\n\n授权状态："+(auth.session?"✅ 已授权":"❌ 未授权"),
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[
          [{text:"🔐 开始授权",callback_data:"adm:scan_auth_start"}],
          [{text:"📚 查看扫描账号",callback_data:"adm:scan_auth"}],
          [{text:"⬅️ 返回123云盘",callback_data:"adm:cloud123"}]
        ]}
      });
    }
    if(data==="adm:auto_from"){
      await answer("请发送起始消息 ID");
      states.set("m:"+uid,{step:"auto_start_id"});
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🎯 从指定消息 ID 开始</b>\n━━━━━━━━━━━━━━\n\n请发送旧仓库的消息 ID。\n这条和之后的才会复制，更早的会跳过。\n\n发送 0 表示从头复制。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"⬅️ 返回自动同步",callback_data:"adm:auto_status"}]]}});
    }
    if(data==="adm:scan_auth"){
      await answer("打开扫描账号");
      const auth=db.settings.historyAuth||{};
      const missing=[];
      if(!auth.apiId) missing.push("API ID");
      if(!auth.apiHash) missing.push("API HASH");
      if(!auth.phone) missing.push("手机号");
      if(!auth.session) missing.push("登录会话");
      const next=missing.length ? "还缺："+missing.join("、")+"。点「开始授权」，按提示发送。" : "扫描账号已登录，123云盘可以直接使用。";
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🔐 扫描账号</b>\n━━━━━━━━━━━━━━\n\n"+
        "API ID："+(auth.apiId?"✅ 已保存":"❌ 未保存")+"\n"+
        "API HASH："+(auth.apiHash?"✅ 已保存":"❌ 未保存")+"\n"+
        "手机号："+(auth.phone?"✅ 已保存":"❌ 未保存")+"\n"+
        "登录会话："+(auth.session?"✅ 已保存":"❌ 未保存")+"\n\n"+
        next,
        parse_mode:"HTML",reply_markup:{inline_keyboard:[
          [{text:"🔐 开始授权",callback_data:"adm:scan_auth_start"}],
          [{text:"🔄 刷新状态",callback_data:"adm:scan_auth"}],
          [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
        ]}});
    }
    if(data==="adm:scan_auth_start"){
      await answer("开始授权");
      return mainMessage({chat:{id:chatId,type:"private"},from:{id:uid},text:"🔐 扫描授权"});
    }
    if(data==="admin:more")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>更多管理</b>\n━━━━━━━━━━━━━━\n\n👇 不常用功能在这里",parse_mode:"HTML",reply_markup:adminMoreInline()});
    if(data==="admin:resource")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📦 资源管理</b>\n━━━━━━━━━━━━━━\n\n👇 请选择操作",parse_mode:"HTML",reply_markup:adminResourceInline()});
    if(data==="admin:ops")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📊 数据与运营</b>\n━━━━━━━━━━━━━━\n\n👇 请选择操作",parse_mode:"HTML",reply_markup:adminOpsInline()});
    if(data==="admin:settings")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>⚙️ 系统设置</b>\n━━━━━━━━━━━━━━\n\n👇 请选择设置",parse_mode:"HTML",reply_markup:adminSettingsInline()});
    if(data==="admin:bot")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🤖 机器人管理</b>\n━━━━━━━━━━━━━━\n\n👇 请选择操作",parse_mode:"HTML",reply_markup:adminBotInline()});
    if(data==="admin:maintenance")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🧹 资源维护</b>\n━━━━━━━━━━━━━━\n\n👇 选择检查项目",parse_mode:"HTML",reply_markup:adminMaintenanceMenu()});
    if(data==="admin:health")return safeEdit(token,{chat_id:chatId,message_id:messageId,text:systemHealthText(),parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"🔄 重新检查",callback_data:"admin:health"}],[{text:"⬅️ 返回维护",callback_data:"admin:maintenance"}]]}});
    if(data==="admin:backup") return backupRecoveryPreview(uid);
    if(data==="admin:backup_restore") return backupRecoveryMerge(uid);
      if(data==="admin:upload"){
      // 先清理可能残留的旧上传状态，避免上一次未结束的批次拦截新上传。
      const oldUploadKey=uploadStateKey(uid,child,token);
      if(uploadTimers.has(oldUploadKey)) { clearTimeout(uploadTimers.get(oldUploadKey)); uploadTimers.delete(oldUploadKey); }
      if(uploadAckTimers.has(oldUploadKey)) { clearTimeout(uploadAckTimers.get(oldUploadKey)); uploadAckTimers.delete(oldUploadKey); }
      states.delete(oldUploadKey);
      if(!repo()){
        void answer("尚未绑定资源仓库",true);
        return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📤 上传资源</b>\n━━━━━━━━━━━━━━\n\n⚠️ 还没有绑定资源仓库，文件暂时不能入库。\n可以先选择或新建文件夹。\n\n👇 请选择文件夹",parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
      }
      const key=uploadStateKey(uid,child,token);
      if(uploadTimers.has(key)) { clearTimeout(uploadTimers.get(key)); uploadTimers.delete(key); }
      if(uploadAckTimers.has(key)) { clearTimeout(uploadAckTimers.get(key)); uploadAckTimers.delete(key); }
      states.set(key,{step:"upload_select",pendingUploads:[],controlMessageId:Number(messageId)});
      void answer("已进入上传模式");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"<b>📤 上传资源</b>\n━━━━━━━━━━━━━━\n\n👇 请选择文件夹\n\n📁 选择后直接连续发送文件\n📌 上传过程中不逐条回复，完成后统一处理并回复结果。",
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
    if(route==="recover") { sendHtml(TOKEN,uid,"<b>🔄 Google Sheets 历史恢复已启动</b>\\n\\n📚 读取现有 Google Sheets 资源名称\\n🔎 扫描原 Telegram 仓库\\n📁 自动恢复文件夹归属\\n🔗 自动补回聊天ID/消息ID\\n\\n⏳ 任务将在后台继续运行…",adminMenu()).catch(()=>{}); recoverBaserowHistory(uid).catch(e=>console.error("❌ RECOVERY TASK:",e)); return; }
    if(route==="folder_repair") return repairLostFolderAssignments(uid);
    if(route==="auto") {
      return showRepositoryAutoSyncStatus(uid);
    }
        if(route==="migrate") {
      states.set(key,{step:"migration_source"});
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🔄 旧仓库 → 新仓库</b>\\n━━━━━━━━━━━━━━\\n\\n📤 第一步：发送旧仓库 Chat ID 或 @用户名。\\n\\n例如：<code>-1001234567890</code>\\n\\n⚠️ 机器人必须同时在旧仓库和新仓库里。\\n📌 旧仓库不会删除。\\n📁 文件夹归属会保留。\\n\\n发送 /cancel 可取消。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"❌ 取消","callback_data":"admin:resource"}]]}});
    }
    if(route==="auto_status") return showRepositoryAutoSyncStatus(uid);
    if(route==="auto_content"){
      const a=repositoryAutoSyncState();
      await answer("已打开同步内容设置");
      try {
        return await safeEdit(token,{chat_id:chatId,message_id:messageId,text:repositoryAutoSyncContentText(a),parse_mode:"HTML",reply_markup:repositoryAutoSyncContentMenu()});
      } catch(e) {
        console.error("❌ AUTO CONTENT 页面刷新失败:",String(e?.telegramDescription||e?.message||e));
        return sendHtml(token,chatId,repositoryAutoSyncContentText(a),repositoryAutoSyncContentMenu());
      }
    }
    if(route==="auto_content_toggle" || route.startsWith("auto_content_toggle:")){
      const type=data.split(":")[2]||"";
      const a=repositoryAutoSyncState();
      if(type==="text") a.syncText=a.syncText===false;
      else if(type==="photo") a.syncPhoto=a.syncPhoto===false;
      else if(type==="video") a.syncVideo=a.syncVideo===false;
      else if(type==="file") a.syncFiles=a.syncFiles===false;
      else {
        await answer("未知同步内容选项",true);
        return;
      }
      a.updatedAt=Date.now();
      saveDb();
      const labels={text:"文字",photo:"图片/相册",video:"视频",file:"文件/音频"};
      await answer((a["sync"+(type==="file"?"Files":type==="photo"?"Photo":type==="video"?"Video":"Text")]===false?"已关闭 ":"已开启 ")+(labels[type]||"同步"));
      try {
        return await safeEdit(token,{chat_id:chatId,message_id:messageId,text:repositoryAutoSyncContentText(a),parse_mode:"HTML",reply_markup:repositoryAutoSyncContentMenu()});
      } catch(e) {
        console.error("❌ AUTO CONTENT 刷新失败:",String(e?.telegramDescription||e?.message||e));
        return sendHtml(token,chatId,repositoryAutoSyncContentText(a),repositoryAutoSyncContentMenu());
      }
    }

    if(route==="auto_add") {
      await resetRepositoryAutoSyncBinding();
      states.delete(key);
      states.set(key,{step:"auto_migration_source"});
      void answer("正在添加自动同步任务");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>➕ 添加自动同步任务</b>\\n━━━━━━━━━━━━━━\\n\\n📤 第一步：发送旧仓库 Chat ID、@用户名，或直接转发旧仓库中的任意消息/文件。\\n\\n📥 第二步：确认旧仓库后，再发送新仓库。\\n\\n📌 添加完成后，旧仓库收到新消息会自动复制到新仓库。\\n\\n发送 /cancel 可取消。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"❌ 取消",callback_data:"admin:resource"}]]}});
    }
    if(route==="auto_delete") {
      await resetRepositoryAutoSyncBinding();
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🧹 自动同步任务已删除</b>\\n━━━━━━━━━━━━━━\\n\\n旧仓库与新仓库绑定已解除。\\n📌 待处理队列已清空。\\n📌 以后不会再自动同步。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:"➕ 添加新的同步任务",callback_data:"adm:auto_add"}],
        [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
      ]}});
    }
    if(route==="auto_test") {
      await answer("正在测试自动同步…");
      try {
        const item=await testRepositoryAutoSync(uid);
        return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>✅ 自动同步测试成功</b>\n━━━━━━━━━━━━━━\n\n📤 旧仓库："+escapeHtml(repositoryAutoSyncState().sourceTitle||"-")+"\n📥 新仓库："+escapeHtml(repositoryAutoSyncState().targetTitle||"-")+"\n📦 已测试消息："+Number(item.messageId)+"\n\n这表示机器人已经可以从旧仓库复制消息到新仓库。之后旧仓库收到新消息时，会自动进入同步队列。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
          [{text:"⏸️ 暂停同步",callback_data:"adm:auto_pause"}],
          [{text:"🧹 解绑并重新绑定",callback_data:"adm:auto_reset"}],
          [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
        ]}});
      } catch(e) {
        const msg=String(e?.telegramDescription||e?.message||e||"测试失败");
        const a=repositoryAutoSyncState(); a.lastError=msg; a.updatedAt=Date.now(); saveDb();
        return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>❌ 自动同步测试失败</b>\n━━━━━━━━━━━━━━\n\n⚠️ "+escapeHtml(msg)+"\n\n请确认机器人同时在旧仓库和新仓库中，并且旧仓库可读取、新仓库可发送。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
          [{text:"🧹 解绑并重新绑定",callback_data:"adm:auto_reset"}],
          [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
        ]}});
      }
    }
    if(route==="auto_pause") {
      const a=repositoryAutoSyncState(); a.enabled=false; a.status="paused"; a.updatedAt=Date.now(); saveDb();
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>⏸️ 自动同步已暂停</b>\n\n📌 绑定仍保留，待处理资源不会删除。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:"▶️ 继续同步",callback_data:"adm:auto_resume"}],[{text:"🧹 解绑并重新绑定",callback_data:"adm:auto_reset"}],[{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
      ]}});
    }
    if(route==="auto_reset" || route==="auto_stop") {
      await resetRepositoryAutoSyncBinding();
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🧹 自动同步已解绑</b>\n━━━━━━━━━━━━━━\n\n旧仓库和新仓库绑定已全部清除。\n现在可以重新绑定。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:"🔄 重新绑定旧仓库 / 新仓库",callback_data:"adm:auto"}],[{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
      ]}});
    }
    if(route==="auto_start") {
      // 先立即响应按钮，再后台启动同步，避免建立队列/检查仓库耗时导致按钮看起来没反应。
      await answer("正在启动自动同步…");
      const starting=repositoryAutoSyncState();
      if(!starting.sourceId||!starting.targetId){
        return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>⚠️ 自动同步尚未绑定</b>\n\n请先添加旧仓库和新仓库。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
          [{text:"➕ 添加同步任务",callback_data:"adm:auto_add"}],
          [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
        ]}});
      }
      starting.enabled=true;
      starting.manualPaused=false;
      starting.status="queued";
      starting.lastError="";
      starting.updatedAt=Date.now();
      saveDb();
      await safeEdit(token,{chat_id:chatId,message_id:messageId,
        text:"<b>⚡ 自动同步正在启动</b>\n━━━━━━━━━━━━━━\n\n📤 旧仓库："+escapeHtml(starting.sourceTitle||starting.sourceId)+"\n📥 新仓库："+escapeHtml(starting.targetTitle||starting.targetId)+"\n\n⏳ 正在建立同步队列，请稍候…",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[
          [{text:"⏸️ 暂停同步",callback_data:"adm:auto_pause"}],
          [{text:"🔄 刷新状态",callback_data:"adm:auto_status"}],
          [{text:"🗑️ 删除任务并解绑仓库",callback_data:"adm:auto_delete"}]
        ]}});
      void startRepositoryAutoSyncNow(uid)
        .then(()=>showRepositoryAutoSyncStatus(uid))
        .catch(e=>{
          const a=repositoryAutoSyncState();
          a.enabled=false; a.status="error";
          a.lastError=String(e?.telegramDescription||e?.message||e||"自动同步启动失败");
          a.updatedAt=Date.now(); saveDb();
          return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>❌ 自动同步启动失败</b>\n\n⚠️ "+escapeHtml(a.lastError)+"\n\n请确认旧仓库、新仓库都可访问，并且机器人同时在两个仓库中。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
            [{text:"🔄 重新绑定旧仓库 / 新仓库",callback_data:"adm:auto"}],
            [{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
          ]}});
        });
      return;
    }
    if(route==="auto_resume") {
      const a=repositoryAutoSyncState();
      if(!a.sourceId||!a.targetId) return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>⚠️ 尚未绑定仓库</b>\n\n请先重新绑定旧仓库和新仓库。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
        [{text:"🔄 重新绑定旧仓库 / 新仓库",callback_data:"adm:auto"}],[{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
      ]}});
      try{
        await startRepositoryAutoSyncNow(uid);
        return showRepositoryAutoSyncStatus(uid);
      }catch(e){
        return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>❌ 自动同步启动失败</b>\n\n⚠️ "+escapeHtml(String(e?.message||e))+"\n\n请检查机器人是否同时在旧仓库和新仓库中。",parse_mode:"HTML",reply_markup:{inline_keyboard:[
          [{text:"🔄 重新绑定",callback_data:"adm:auto_reset"}],[{text:"⬅️ 返回资源管理",callback_data:"admin:resource"}]
        ]}});
      }
    }
    if(route==="folders_all_confirm"){
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>⚠️ 删除所有文件夹</b>\n━━━━━━━━━━━━━━\n\n这只会删除文件夹及文件夹标记。\n📦 所有资源/文件都会保留。\n🔗 资源会变成未分类。\n\n确定继续吗？",parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"🗑️ 确定删除所有文件夹",callback_data:"adm:folders_all_do"}],
      [{text:"⬅️ 取消",callback_data:"admin:resource"}]
    ]}});
  }
  if(route==="folders_all_do"){
    console.log("🗑️ DELETE ALL FOLDERS CLICK:", "uid="+uid, "chat="+chatId, "message="+messageId);
    void answer("正在删除所有文件夹，请稍候…");
    const progress=await tg(token,"sendMessage",{chat_id:chatId,text:"<b>🧹 正在删除所有文件夹</b>\n━━━━━━━━━━━━━━\n\n⏳ 正在清理 Google Sheets 文件夹记录…\n📦 所有资源都会保留。",parse_mode:"HTML"});
    try {
      const result=await deleteAllFoldersKeepResources();
      const progressId=progress?.message_id;
      const body={chat_id:chatId,message_id:progressId,text:"<b>✅ 所有文件夹清理完成</b>\n━━━━━━━━━━━━━━\n\n🗑️ 删除文件夹：<b>"+result.folders+"</b>\n📦 保留资源：<b>"+db.resources.length+"</b>\n🔗 解除文件夹归属：<b>"+result.resources+"</b>\n"+(result.errors?"⚠️ 失败记录：<b>"+result.errors+"</b>\n":"")+"\n所有资源/Telegram 文件均未删除。",parse_mode:"HTML",reply_markup:adminResourceInline()};
      if(progressId) await safeEdit(token,body);
      else await sendHtml(token,chatId,body.text,adminResourceMenu());
      await refreshSharedData(true);
    } catch(e) {
      console.error("❌ 删除所有文件夹任务失败:",String(e?.message||e));
      const msg="<b>❌ 删除文件夹失败</b>\n━━━━━━━━━━━━━━\n\n"+escapeHtml(String(e?.message||e));
      const progressId=progress?.message_id;
      if(progressId) await safeEdit(token,{chat_id:chatId,message_id:progressId,text:msg,parse_mode:"HTML",reply_markup:adminResourceInline()});
      else await sendHtml(token,chatId,msg,adminResourceMenu());
    }
    return;
  }
  if(route==="tagfolders"){
    const result=autoCreateTagFoldersForExistingResources();
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>🏷️ 标签自动分类完成</b>\\n━━━━━━━━━━━━━━\\n\\n📁 新建标签文件夹：<b>"+result.created+"</b>\\n📦 自动归类资源：<b>"+result.assigned+"</b>\\n\\n规则：同一个 #中文标签 只建一个文件夹，整组相册都放进去。英文和数字标签会跳过。",parse_mode:"HTML",reply_markup:adminResourceInline()});
  }
  const syn={rename:"✏️ 修改文件夹名称",delete:"🗑️ 删除资源",move:"🔄 移动资源",bulk:"📦 批量管理",share:"🔗 分享资源",repo:"📦 资源仓库",scan:"🔍 仓库扫描",scan_auth:"🔐 扫描授权",cloud123:"☁️ 123云盘",recover:"🧩 恢复历史资源",group:"🔐 指定群管理",admins:"👥 管理员管理",stats:"📊 数据统计",broadcast:"📢 广播消息",logs:"📜 操作日志",pin:"📌 广播后置顶",post:"📣 获取后推广",clone:"🤖 克隆机器人",migrate:"🔄 迁移仓库",auto:"⚡ 自动同步任务",auto_status:"⚡ 自动同步任务",auto_add:"➕ 添加同步任务",auto_pause:"⏸️ 暂停任务",auto_stop:"⏹️ 解绑并停止自动同步",auto_reset:"🧹 解绑并重新绑定",auto_delete:"🧹 删除任务并解绑",auto_test:"🧪 测试同步",auto_resume:"▶️ 继续任务",auto_start:"▶️ 开始同步"};
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
    if(!isAdmin(uid) || child){void answer("无权限",true);return;}
    const op=data.slice("protect:".length);
    if(op==="toggle"){
      db.settings.contentProtection=!contentProtectionEnabled();
      saveDb(); logAdmin(uid,"内容保护",contentProtectionEnabled()?"开启":"关闭");
      void answer(contentProtectionEnabled()?"已开启":"已关闭");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:contentProtectionText(),parse_mode:"HTML",reply_markup:contentProtectionMenu()});
    }
    if(op==="duration"){
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:contentProtectionText(),parse_mode:"HTML",reply_markup:contentProtectionMenu()});
    }
    if(op.startsWith("set:")){
      const n=Math.max(0,Number(op.slice(4))||0);
      db.settings.autoDeleteMinutes=n;
      saveDb(); logAdmin(uid,"自动删除",n?autoDeleteText():"关闭");
      void answer(n?("自动删除："+autoDeleteText()):"已关闭自动删除");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:contentProtectionText(),parse_mode:"HTML",reply_markup:contentProtectionMenu()});
    }
  }

  if(data.startsWith("quota:")){
    if(child||!isAdmin(uid)){void answer("无权限",true);return;}
    const op=data.slice(6);
    if(op==="+1"||op==="-1"){db.settings.nonMemberDailyLimit=Math.min(3,Math.max(0,nonMemberDailyLimit()+(op==="+1"?1:-1)));saveDb();return safeEdit(token,{chat_id:chatId,message_id:messageId,text:quotaSettingsText(),parse_mode:"HTML",reply_markup:{inline_keyboard:[
      [{text:"➕ +1",callback_data:"quota:+1"},{text:"➖ -1",callback_data:"quota:-1"}],
      [{text:"✏️ 自定义",callback_data:"quota:set"}],
      [{text:"⬅️ 返回系统设置",callback_data:"admin:settings"}]
    ]}});}
    if(op==="set"){states.set("m:"+uid,{step:"nonmember_quota_edit"});void answer("请输入新的每日额度");return sendHtml(token,uid,"<b>🎁 修改非会员每日资源额度</b>\n\n请发送每日允许获取的资源数量（0～3 的整数）。照片、视频和文件都计入额度。",adminMenu());}
  }

  if(data==="move_cancel" || data.startsWith("move_to:")) {
    if(!isAdmin(uid) || child) { void answer("无权限",true); return; }
    const key="m:"+uid;
    const st=states.get(key);
    if(!st || (st.step!=="move_target" && st.step!=="bulk_target")) { void answer("操作已过期",true); return; }
    if(data==="move_cancel") { states.delete(key); void answer("已取消"); return send(TOKEN,uid,"❌ 已取消移动。",adminResourceMenu()); }
    const targetId=data.slice("move_to:".length);
    const target=db.directories.find(d=>String(d.id)===String(targetId));
    const item=db.resources.find(r=>Number(r.messageId)===Number(st.itemId)&&String(r.directoryId)===String(st.sourceId));
    if(!target||!item) { void answer("资源或目标文件夹不存在",true); return; }
    item.directoryId=target.id;
    queueResourceFolderTag(item);
    saveDb();
    logAdmin(uid,"移动资源",(item.title||"未命名")+" → "+target.name);
    states.delete(key);
    void answer("移动完成");
    return sendHtml(TOKEN,uid,"<b>✅ 资源移动完成</b>\n━━━━━━━━━━━━━━\n\n📦 "+escapeHtml(item.title||"未命名")+"\n📁 目标文件夹：<b>"+escapeHtml(target.name)+"</b>",adminResourceMenu());
  }

  if(data.startsWith("bulk_toggle:") || data.startsWith("bulk_page:") || data==="bulk_move" || data==="bulk_delete" || data==="bulk_delete_confirm" || data==="bulk_delete_cancel" || data==="bulk_cancel") {
    if(!isAdmin(uid) || child) { void answer("无权限",true); return; }
    const key="m:"+uid;
    const st=states.get(key);
    if(!st || st.step!=="bulk_select") { void answer("操作已过期",true); return; }
    if(data==="bulk_cancel") { states.delete(key); void answer("已取消"); return send(TOKEN,uid,"❌ 已取消批量管理。",adminResourceMenu()); }
    if(data.startsWith("bulk_page:")) {
      const page=Math.max(0,Number(data.slice(10))||0);
      st.page=page; states.set(key,st);
      void answer("已切换");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📦 <b>批量管理</b>\n\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\n\n👇 点击资源进行多选。",parse_mode:"HTML",reply_markup:resourceMoveMenu(st.items,page,st.selected)});
    }
    if(data.startsWith("bulk_toggle:")) {
      const p=Number(data.split(":")[1])||0, idx=Number(data.split(":")[2])||0;
      const item=st.items[p*10+idx];
      if(!item) { void answer("资源不存在",true); return; }
      const id=String(item.messageId), at=st.selected.indexOf(id);
      if(at>=0) st.selected.splice(at,1); else st.selected.push(id);
      st.page=p; states.set(key,st);
      void answer(at>=0?"已取消选择":"已选择");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📦 <b>批量管理</b>\n\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\n\n👇 点击资源进行多选。",parse_mode:"HTML",reply_markup:resourceMoveMenu(st.items,p,st.selected)});
    }
    if(data==="bulk_delete") {
      if(!st.selected.length) { void answer("请先选择资源",true); return; }
      st.step="bulk_delete_confirm"; states.set(key,st);
      void answer("请确认删除");
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
      void answer("已取消");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,
        text:"📦 <b>批量管理</b>\\n\\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\\n\\n👇 点击资源进行多选。",
        parse_mode:"HTML",reply_markup:resourceMoveMenu(st.items,st.page,st.selected)});
    }
    if(data==="bulk_delete_confirm") {
      if(st.step!=="bulk_delete_confirm") { void answer("操作已过期",true); return; }
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
      void answer("删除完成");
      return sendHtml(TOKEN,uid,
        "<b>🗑️ 批量删除完成</b>\\n━━━━━━━━━━━━━━\\n\\n"+
        "📦 选择资源："+targets.length+" 个\\n"+
        "🗑️ 已从资源索引移除："+deleted+" 个\\n\\n"+
        "📁 其余资源保持不变。",
        adminResourceMenu());
    }

    if(data==="bulk_move") {
      if(!st.selected.length) { void answer("请先选择资源",true); return; }
      st.step="bulk_target"; states.set(key,st);
      void answer("请选择目标文件夹");
      return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📦 <b>批量移动</b>\n\n☑️ 已选择：<b>"+st.selected.length+"</b> 个\n\n👇 请选择目标文件夹。",parse_mode:"HTML",reply_markup:moveFolderMenu(st.sourceId)});
    }
  }

  if(data==="batch:random" || data==="batch:video" || data.startsWith("batch:latest:") || data==="batch:home"){
    if(data==="batch:home"){
      void answer("返回首页");
      return sendHtml(token,uid,userHomeText(uid),child ? childMenu() : userMenu());
    }
    // 再来一组/下一批前清除旧控制键盘，新按钮只挂在新一组文件之后。
    void tg(token,"editMessageReplyMarkup",{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}}).catch(()=>{});
    if(!(await requireMemberAccess(token,chatId,uid,child ? childMenu() : userMenu()))) {
      void answer("请先加入指定会员群",true);
      return;
    }
    if(child){
      if(data==="batch:random"){
        void answer("正在随机获取…");
        return deliverFromHistory(token,uid,uid,random10(uid),{mode:"random",offset:0,total:db.resources.length});
      }
      if(data==="batch:video"){
        void answer("正在获取视频…");
        return deliverFromHistory(token,uid,uid,randomVideos(uid),{mode:"random",offset:0,total:db.resources.length});
      }
      const offset=Math.max(0,Number(data.split(":")[2])||0);
      void answer("正在获取最新资源…");
      return deliverFromHistory(token,uid,uid,db.resources.slice(offset,offset+10),{mode:"latest",offset,total:db.resources.length});
    }
    if(data==="batch:random"){
      void answer("正在随机获取…");
      return deliver(token,uid,uid,random10(uid),TOKEN,{mode:"random",offset:0,total:db.resources.length});
    }
    if(data==="batch:video"){
      void answer("正在获取视频…");
      return deliver(token,uid,uid,randomVideos(uid),TOKEN,{mode:"random",offset:0,total:db.resources.length});
    }
    const offset=Math.max(0,Number(data.split(":")[2])||0);
    void answer("正在获取最新资源…");
    return deliver(token,uid,uid,db.resources.slice(offset,offset+10),TOKEN,{mode:"latest",offset,total:db.resources.length});
  }

  // 用户搜索结果使用内联按钮：两列排列，结果多时分页，不再占用底部键盘。
  if(data==="src" || data.startsWith("srp:") || data.startsWith("sr:")) {
    if(data!=="src" && !(await requireMemberAccess(token,chatId,uid,child ? childMenu() : userMenu()))) {
      void answer("请先加入指定会员群",true);
      return;
    }
    const key=(child ? "c:" : "m:")+uid;
    const s=states.get(key);
    if(!s || s.step!=="search_results") {
      void answer("搜索结果已过期，请重新搜索",true);
      return;
    }
    if(data==="src") {
      states.delete(key);
      void answer("已关闭搜索");
      return sendHtml(token,uid,"<b>↩️ 已退出搜索</b>\n\n👇 请选择其他功能。",child ? childMenu() : userMenu());
    }
    if(data.startsWith("srp:")) {
      const rawPage=Number(data.slice(4));
      const results=Array.isArray(s.results)?s.results:[];
      const maxPage=Math.max(0,Math.ceil(results.length/10)-1);
      const next=Math.min(Math.max(0,Number.isFinite(rawPage)?rawPage:0),maxPage);
      states.set(key,{step:"search_results",query:String(s.query||""),results,page:next});
      if(!results.length) {
        void answer("没有找到相关资源",true);
        return safeEdit(token,{
          chat_id:chatId,
          message_id:messageId,
          text:"📭 <b>没有找到相关资源</b>\n\n关键词：<code>"+escapeHtml(s.query||"")+"</code>\n\n💡 请换一个关键词重新搜索。",
          parse_mode:"HTML",
          reply_markup:{inline_keyboard:[[{text:"🔎 重新搜索",callback_data:"user:search"},{text:"⬅️ 返回首页",callback_data:"user:home"}]]}
        });
      }
      void answer("已切换到第 "+(next+1)+" 页");
      // 搜索分页不再依赖编辑原消息。Telegram 某些情况下会拒绝编辑旧消息，
      // 导致用户点击“下一页”后看起来像完全没有内容；这里直接发送新页面，确保翻页必定有结果。
      return sendHtml(token,chatId,
        "🔎 <b>搜索结果</b>\n━━━━━━━━━━━━━━\n🔍 关键词：<b>"+escapeHtml(s.query||"")+"</b>\n📚 找到 <b>"+results.length+"</b> 个资源\n📄 第 <b>"+(next+1)+" / "+(maxPage+1)+"</b> 页\n\n👇 <b>点击下方资源名称获取</b>",
        resourceInlineKeyboard(results,next)
      );
    }
    const parts=data.split(":");
    const page=Math.max(0,Number(parts[1])||0);
    const idx=Math.max(0,Number(parts[2])||0);
    const pageItems=s.results.slice(page*10,page*10+10);
    const selected=pageItems[idx];
    if(!selected) {
      void answer("这个搜索结果不存在或已更新",true);
      return;
    }
    // 搜索结果对象可能在共享刷新后已经被替换，按唯一键重新取当前记录。
    const selectedKey=resourceKey(selected);
    let item=resourceByKey(selectedKey);
    if(!item && GOOGLE_SHEETS_CREDENTIAL && GOOGLE_SHEETS_ID) {
      try {
        await refreshSharedData(true);
        item=resourceByKey(selectedKey);
      } catch(e) {
        console.warn("⚠️ 点击搜索结果时刷新共享资源失败：",String(e?.message||e));
      }
    }
    if(!item) {
      void answer("资源已更新，请重新搜索",true);
      return;
    }
    const member=await allowed(TOKEN,uid);
    const guest=withoutVideosForGuest([item],member,uid);
    if(!guest.items.length) {
      void answer("今日免费资源额度已用完",true);
      return guestVideoNotice(token,chatId);
    }
    void answer("正在获取资源相册/文件组…");
    try {
      const sentResult=await sendResourceAlbum(token,chatId,guest.items);
      const sent=Number(sentResult?.sent||0);
      const sentItems=Array.isArray(sentResult?.sentItems)?sentResult.sentItems:guest.items.slice(0,sent);
      if(sent>0) {
        recordStat(uid,"download",sent);
        for(const sentItem of sentItems){recordResourceDownload(sentItem);recordRecent(uid,sentItem);}
        if(!member&&!isAdmin(uid)) consumeVideoQuota(uid,sentItems); else saveDb();
      } else {
        saveDb();
      }
      void tg(token,"editMessageReplyMarkup",{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}}).catch(()=>{});
      return sendHtml(token,chatId,"🔎 <b>搜索结果</b>\n━━━━━━━━━━━━━━\n🔍 关键词：<b>"+escapeHtml(s.query)+"</b>\n📚 找到 <b>"+s.results.length+"</b> 个资源\n📄 第 <b>"+(page+1)+" / "+Math.max(1,Math.ceil(s.results.length/10))+"</b> 页\n\n✅ 已成组发送：<b>"+sent+" </b> 个资源"+(sent<guest.items.length?"（失败 "+(guest.items.length-sent)+" 个）":"")+"\n👇 可继续选择其他资源"+(!member&&!isAdmin(uid)&&nonMemberDailyRemaining(uid)<=0?"\n\n🎁 今日免费资源额度已用完。照片、视频和文件都计入额度。":""),resourceInlineKeyboard(s.results,page));
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

  // 上传继续只负责恢复当前上传界面，不再创建第二套“已收到 N 个”提醒。
  if(isAdmin(uid) && data==="upload_continue") {
    const key=uploadStateKey(uid,child,token);
    const s=restoreUploadState(key);
    if(!s || s.step!=="upload_file") {
      void answer("当前没有进行中的上传",true);
      return;
    }
    if(uploadTimers.has(key)) {
      clearTimeout(uploadTimers.get(key));
      uploadTimers.delete(key);
    }
    void answer("可以继续上传");
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"📁 <b>"+escapeHtml(s.directoryName)+"</b>\n\n📤 <b>继续发送文件</b>\n收到的文件都会自动归入当前文件夹。\n\n完成后点击「✅ 结束上传」。",
      parse_mode:"HTML",
      reply_markup:{inline_keyboard:[[
        {text:"▶️ 继续上传",callback_data:"upload_continue"},
        {text:"✅ 结束上传",callback_data:"upload_finish"}
      ]]}
    });
  }

  // 上传资源的文件夹选择最多显示 10 个，超过后使用分页。
  if(isAdmin(uid) && data.startsWith("uploadsp:")) {
    const page=Math.max(0,Number(data.slice("uploadsp:".length))||0);
    void answer();
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"<b>📤 上传资源</b>\\n━━━━━━━━━━━━━━\\n\\n👇 请选择文件夹\\n\\n📁 每页最多显示 <b>10</b> 个\\n📌 选择后可连续发送文件",
      parse_mode:"HTML",
      reply_markup:uploadFolderInlineMenu(page)
    });
  }

  // 文件夹管理：继续上传、查看、改名、移动、删除。
  if(!child && isAdmin(uid) && data==="upload_folder_back"){
    void answer("返回文件夹列表");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📤 上传资源</b>\\n━━━━━━━━━━━━━━\\n\\n👇 请选择文件夹",parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
  }
  if(isAdmin(uid) && data.startsWith("folder_manage_upload:")) {
    const directoryId=data.slice("folder_manage_upload:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){void answer("文件夹不存在",true);return;}
    const uploadKey=uploadStateKey(uid,child,token);
    states.set(uploadKey,{step:"upload_file",directoryId:d.id,directoryName:d.name,pendingUploads:[],controlMessageId:Number(messageId)});
    void answer("已进入上传");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📁 <b>"+escapeHtml(d.name)+"</b>\\n\\n📤 <b>继续发送文件</b>\\n收到的文件会自动归入此文件夹。\\n\\n完成后点击「✅ 结束上传」。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}]]}});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_view:")) {
    const directoryId=data.slice("folder_manage_view:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){void answer("文件夹不存在",true);return;}
    const all=directoryItems(d.id);
    void answer();
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"📁 <b>"+escapeHtml(d.name)+"</b>\\n\\n📦 共 <b>"+all.length+"</b> 个资源\\n📤 每次获取 <b>10 个</b>\\n\\n👇 点击下方开始获取",parse_mode:"HTML",reply_markup:folderSummaryKeyboard(d.id,all.length,0)});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_rename:")) {
    const directoryId=data.slice("folder_manage_rename:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){void answer("文件夹不存在",true);return;}
    states.set("m:"+uid,{step:"folder_rename",directoryId:d.id,oldName:d.name});
    void answer("请输入新的文件夹名称");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"✏️ <b>修改文件夹名称</b>\\n\\n当前名称：<b>"+escapeHtml(d.name)+"</b>\\n\\n请直接发送新的名称。\\n发送 /cancel 可取消。",parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"❌ 取消",callback_data:"folder_manage_back:"+d.id}]]}});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_move:")) {
    const directoryId=data.slice("folder_manage_move:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){void answer("文件夹不存在",true);return;}
    void answer();
    states.set("m:"+uid,{step:"folder_move",sourceId:d.id});
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"🔄 <b>移动文件夹内资源</b>\\n\\n📁 来源：<b>"+escapeHtml(d.name)+"</b>\\n📦 资源：<b>"+db.resources.filter(r=>String(r.directoryId)===String(d.id)).length+"</b>\\n\\n👇 请选择目标文件夹",parse_mode:"HTML",reply_markup:folderMoveTargetMenu(d.id)});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_move_to:")) {
    const targetId=data.slice("folder_move_to:".length);
    const sourceId=String(data.match(/^folder_move_to:(.+)$/)?.[1]||"");
    const st=states.get("m:"+uid);
    if(!st || st.step!=="folder_move" || !st.sourceId){void answer("操作已过期，请重新选择",true);return;}
    const target=db.directories.find(x=>String(x.id)===String(targetId));
    const source=db.directories.find(x=>String(x.id)===String(st.sourceId));
    if(!target||!source){void answer("文件夹不存在",true);return;}
    const items=db.resources.filter(r=>String(r.directoryId)===String(source.id));
    for(const item of items){
      item.directoryId=target.id;
      queueResourceFolderTag(item);
    }
    touchSharedData(uid);saveDb();states.delete("m:"+uid);
    void answer("已移动 "+items.length+" 个资源");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"✅ <b>移动完成</b>\\n\\n📁 原文件夹："+escapeHtml(source.name)+"\\n📁 目标文件夹："+escapeHtml(target.name)+"\\n📦 已移动："+items.length+" 个资源",parse_mode:"HTML",reply_markup:folderManageMenu(target.id)});
  }
  if(!child && isAdmin(uid) && data.startsWith("folder_manage_delete:")) {
    const directoryId=data.slice("folder_manage_delete:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d){void answer("文件夹不存在",true);return;}
    const count=db.resources.filter(r=>String(r.directoryId)===String(d.id)).length;
    void answer();
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
    if(!d){void answer("文件夹不存在",true);return;}
    const items=db.resources.filter(r=>String(r.directoryId)===String(d.id));
    if(allDelete){for(const item of items)queueBaserowDeleteResource(item);db.resources=db.resources.filter(r=>String(r.directoryId)!==String(d.id));}
    else {for(const item of items){item.directoryId=null;queueBaserowResourceSync(item);}}
    db.directories=db.directories.filter(x=>String(x.id)!==String(d.id));
    touchSharedData(uid);saveDb();
    void answer("删除完成");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"✅ <b>文件夹已删除</b>\\n\\n📁 "+escapeHtml(d.name)+"\\n📦 "+(allDelete?"同时删除资源："+items.length:"资源已保留："+items.length),parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
  }
  if(isAdmin(uid) && data.startsWith("folder_manage_back:")) {
    const directoryId=data.slice("folder_manage_back:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(d){void answer();return safeEdit(token,{chat_id:chatId,message_id:messageId,text:folderManageText(d.id),parse_mode:"HTML",reply_markup:folderManageMenu(d.id)});}
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📤 上传资源</b>\\n\\n👇 请选择文件夹",parse_mode:"HTML",reply_markup:uploadFolderInlineMenu()});
  }

  // 管理员上传资源使用内联按钮，不要求额外点击底部键盘。
  if(isAdmin(uid) && (data==="upload_folder_refresh" || data.startsWith("upload_folder_page:"))) {
    const page=data.startsWith("upload_folder_page:") ? Number(data.split(":")[1]||0) : 0;
    await answer(data==="upload_folder_refresh" ? "已刷新" : "已翻页");
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"<b>📤 上传资源</b>\n━━━━━━━━━━━━━━\n\n👇 请选择文件夹\n📄 第 <b>"+(page+1)+"</b> 页",parse_mode:"HTML",reply_markup:uploadFolderInlineMenu(page)});
  }
  if(isAdmin(uid) && (data.startsWith("upload_dir:") || data==="upload_new" || data==="upload_cancel")) {
    if(data==="upload_cancel") {
      states.delete(uploadStateKey(uid,child,token));
      void answer("已取消上传");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"❌ <b>已取消上传</b>",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[]}
      });
    }
    if(data==="upload_new") {
      // 使用独立状态，并立即持久化，避免状态机/重启导致“点击后发送名称没反应”。
      const folderKey=uploadStateKey(uid,child,token);
      states.set(folderKey,{step:"folder_create",pendingUploads:[],controlMessageId:Number(messageId)});
      if(!child){
        if(!db.settings.uploadSessions || typeof db.settings.uploadSessions!=="object") db.settings.uploadSessions={};
        db.settings.uploadSessions[folderKey]={step:"folder_create",pendingMessageIds:[],controlMessageId:Number(messageId),updatedAt:Date.now()};
        saveDb();
      }
      void answer("请输入新文件夹名称");
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"📁 <b>新建文件夹</b>\\n\\n请直接发送新的文件夹名称。\\n\\n发送 /cancel 可取消。",
        parse_mode:"HTML",
        reply_markup:{inline_keyboard:[[{text:"❌ 取消",callback_data:"upload_cancel"}]]}
      });
    }
    const directoryId=data.slice("upload_dir:".length);
    const d=db.directories.find(x=>String(x.id)===String(directoryId));
    if(!d) {
      void answer("文件夹不存在，请重新选择",true);
      return safeEdit(token,{
        chat_id:chatId,
        message_id:messageId,
        text:"⚠️ 这个文件夹已经不存在，请重新选择。",
        parse_mode:"HTML",
        reply_markup:uploadFolderInlineMenu()
      });
    }
    const uploadKey=uploadStateKey(uid,child,token);
    if(uploadTimers.has(uploadKey)) { clearTimeout(uploadTimers.get(uploadKey)); uploadTimers.delete(uploadKey); }
    if(uploadAckTimers.has(uploadKey)) { clearTimeout(uploadAckTimers.get(uploadKey)); uploadAckTimers.delete(uploadKey); }
    states.set(uploadKey,{
      step:"upload_file",
      directoryId:d.id,
      directoryName:d.name,
      pendingUploads:[]
    });
    void answer("已进入上传模式");
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:"📤 <b>开始上传</b>\\n━━━━━━━━━━━━━━\\n\\n📁 文件夹：<b>"+escapeHtml(d.name)+"</b>\\n\\n请直接发送文件、图片、视频、音频或其他资源。\\n\\n文件会自动加入当前批次。完成后点击「✅ 结束上传」，统一处理。",
      parse_mode:"HTML",
      reply_markup:{inline_keyboard:[
        [{text:"▶️ 继续上传",callback_data:"upload_continue"},{text:"✅ 结束上传",callback_data:"upload_finish"}],
        [{text:"❌ 取消上传",callback_data:"upload_cancel"}]
      ]}
    });
  }

  const directoryAction=data==="dirs"||data==="user:dirs"||data.startsWith("dirsp:")||data.startsWith("dir:")||data.startsWith("get:");
  if(directoryAction) await answer("正在打开/发送目录资源…");

  if(data==="adm:shared_refresh"){
    await refreshSharedData(true);
    return safeEdit(token,{chat_id:chatId,message_id:messageId,text:"✅ 共享数据同步完成",reply_markup:adminResourceInline()});
  }

  console.log("🔘 DIRECTORY CALLBACK:", {
    bot: child ? "child" : "main",
    user: uid,
    data,
    chatId,
    messageId,
    directories: db.directories.length,
    resources: db.resources.length
  });

  if(data==="noop") {
    await answer("当前没有可用的文件夹或资源",true);
    return;
  }
  if(data==="done") return;

  if(data.startsWith("dirsp:")) {
    const page=Math.max(0,Number(data.slice(6))||0);
    return safeEdit(token,{
      chat_id:chatId,
      message_id:messageId,
      text:directoryText(page),
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
  const safeDescription=String(d.description||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  if(data.startsWith("dir:")) {
    // 先移除旧目录键盘，避免操作按钮留在新发文件上方。
    void tg(token,"editMessageReplyMarkup",{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}}).catch(()=>{});
    if(!all.length) {
      return sendHtml(token,chatId,"📁 <b>"+safe+"</b>\\n\\n📭 这个文件夹目前没有可获取的资源。",{reply_markup:directoryInlineKeyboard()});
    }
    const member=await allowed(TOKEN,uid);
    const selectedBatch=directoryBatchItems(all,0,10,true);
    const guest=withoutVideosForGuest(selectedBatch.items,member,uid,member);
    if(!guest.items.length) return guestVideoNotice(token,chatId);
    const first=guest.items;
    // 先在聊天里显示进度，避免媒体下载/相册整理期间用户误以为按钮没反应。
    let progressMessage;
    try {
      progressMessage=await tg(token,"sendMessage",{
        chat_id:chatId,
        text:"⏳ 正在原样转发仓库消息，请稍候……"
      });
      const album=await sendResourceAlbum(token,chatId,first);
      const sent=Number(album?.sent||0);
      if(sent>0) {
        recordStat(uid,"download",sent);
        for(const item of (Array.isArray(album?.sentItems)?album.sentItems:first.slice(0,sent))) {
          recordResourceDownload(item);
          recordRecent(uid,item);
        }
        if(!member&&!isAdmin(uid)) consumeVideoQuota(uid,Array.isArray(album?.sentItems)?album.sentItems:first.slice(0,sent));
        else saveDb();
      }
      // 发送数量为 0 时不推进进度，避免资源没发出去却被跳过。
      const next=sent>0?(member?selectedBatch.nextOffset:Math.min(sent,all.length)):0;
      const quotaDone=!member&&!isAdmin(uid)&&nonMemberDailyRemaining(uid)<=0;
      const inviteText=quotaDone?"\\n\\n🎁 今日免费资源额度已用完。照片、视频和文件都计入额度。":"";
      const summary=(sent>0
        ? "📁 "+safe+(safeDescription?" · 📝 "+safeDescription:"")+"  ·  "+next+"/"+all.length+"\\n📤 本组已发送："+sent+" 个"
        : "⚠️ <b>本组没有成功发送</b>\\n📁 "+safe+"\\n请点「再来一组」重试；本次不会跳过这批资源。")+inviteText;
      try { if(progressMessage?.message_id) await tg(token,"deleteMessage",{chat_id:chatId,message_id:progressMessage.message_id}); } catch(e) {}
      return sendHtml(token,chatId,summary,{reply_markup:folderProgressKeyboard(d.id,all.length,next)});
    } catch(e) {
      console.error("DIRECTORY ALBUM SEND FAILED:",String(e?.message||e));
      const errText="⚠️ <b>本组发送失败</b>\\n\\n"+escapeHtml(e?.message||e)+"\\n请稍后重试或返回目录重新选择。";
      try { if(progressMessage?.message_id) await tg(token,"deleteMessage",{chat_id:chatId,message_id:progressMessage.message_id}); } catch(e) {}
      return sendHtml(token,chatId,errText,{reply_markup:folderProgressKeyboard(d.id,all.length,0)});
    }
  }

  // “获取下一组”按钮所在的旧控制消息不再保留键盘；新控制消息会放在本组文件之后。
  void tg(token,"editMessageReplyMarkup",{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}}).catch(()=>{});
  if(offset>=all.length) return;

  const member=await allowed(TOKEN,uid);
  const selectedBatch=directoryBatchItems(all,offset,10,member);
  let batch=selectedBatch.items;
  const guest=withoutVideosForGuest(batch, member, uid,member);
  batch=guest.items;
  if(!batch.length) return guestVideoNotice(token, chatId);
  let progressMessage;
  let album;
  try {
    progressMessage=await tg(token,"sendMessage",{chat_id:chatId,text:"⏳ 正在整理本组照片和视频，请稍候……"});
    album=await sendResourceAlbum(token,chatId,batch);
  } catch(e) {
    console.error("DIRECTORY BATCH SEND FAILED:",String(e?.message||e));
    const errText="⚠️ <b>本组发送失败</b>\\n\\n"+escapeHtml(e?.message||e)+"\\n请稍后重试或返回目录重新选择。";
    if(progressMessage?.message_id) return tg(token,"editMessageText",{chat_id:chatId,message_id:progressMessage.message_id,text:errText,parse_mode:"HTML",reply_markup:folderProgressKeyboard(d.id,all.length,offset)});
    return sendHtml(token,chatId,errText,{reply_markup:folderProgressKeyboard(d.id,all.length,offset)});
  }
  const sent=Number(album?.sent||0);
  if(sent) recordStat(uid,"download",sent);

  // 只有至少发送成功一条，才推进到下一批；0 条成功时保留当前 offset 供重试。
  const next=Math.min(sent>0?(member?selectedBatch.nextOffset:offset+sent):offset,all.length);
  if(sent) {
    const sentItems=Array.isArray(album?.sentItems)?album.sentItems:batch.slice(0,sent);
    for(const item of sentItems) { recordResourceDownload(item); recordRecent(uid,item); }
    if(!member && !isAdmin(uid)) consumeVideoQuota(uid,sentItems);
    else saveDb();
  }
  // 批量发送完成后单独发送一个控制消息，避免编辑原文件夹消息失败导致“下面没有按钮”。
  // 下一批仍然从 next 位置开始，不重复发送已经处理过的资源。
  const quotaDone=!member&&!isAdmin(uid)&&nonMemberDailyRemaining(uid)<=0;
  const inviteText=quotaDone?"\\n\\n🎁 今日免费资源额度已用完。照片、视频和文件都计入额度。":"";
  const finalText=(next < all.length
    ? "📁 <b>"+safe+"</b>  ·  "+next+"/"+all.length+"\\n📤 本组已发送：<b>"+sent+"</b> 个"
    : "📁 <b>"+safe+"</b>"+(safeDescription?"\\n📝 "+safeDescription:"")+"\\n\\n📚 共 <b>"+all.length+"</b> 个资源\\n📤 本组已发送：<b>"+sent+"</b> 个\\n📦 已发送：<b>"+next+"</b> / <b>"+all.length+"</b>\\n\\n✅ 已全部获取完成")+inviteText;
  try { if(progressMessage?.message_id) await tg(token,"deleteMessage",{chat_id:chatId,message_id:progressMessage.message_id}); } catch(e) {}
  return sendHtml(token,chatId,finalText,{reply_markup:folderProgressKeyboard(d.id,all.length,next)});
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
          void handleDirectoryCallback(TOKEN,u.callback_query,false).catch(async e=>{
            const message=String(e?.telegramDescription||e?.message||e||"未知错误");
            console.error("MAIN CALLBACK ERROR:",message);
            try { await tg(TOKEN,"answerCallbackQuery",{callback_query_id:u.callback_query.id,text:"操作失败，请查看机器人消息后重试",show_alert:true}); } catch {}
            try { if(u.callback_query.message?.chat?.id) await sendHtml(TOKEN,u.callback_query.message.chat.id,"⚠️ <b>按钮操作失败</b>\n\n"+escapeHtml(message).slice(0,700)+"\n\n请返回目录后重试。"); } catch {}
          });
        }
        if(u.message) {
          console.log("📨 MAIN MESSAGE RECEIVED:", String(u.message.text||u.message.caption||"").slice(0,80));
          // 自动同步实时监听必须在普通消息状态机之前执行。
          // 这样即使 binding/上传/客服等流程提前处理了消息，也不会漏掉源仓库的新消息。
          if(["group","supergroup","channel"].includes(String(u.message.chat?.type||""))) {
            indexResource(u.message);
            queueRepositoryAutoSyncMessage(u.message);
          }
          // 普通消息放到后台处理，不再让一个慢的搜索/上传/Google Sheets 操作堵住后续更新。
          // offset 立即推进，按钮回调本身已经独立后台执行。
          void mainMessage(u.message).catch(e=>console.error("MAIN MESSAGE:",e.message));
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
          void handleDirectoryCallback(token,u.callback_query,true).catch(async e=>{
            const message=String(e?.telegramDescription||e?.message||e||"未知错误");
            console.error("CHILD CALLBACK ERROR:",message);
            try { await tg(token,"answerCallbackQuery",{callback_query_id:u.callback_query.id,text:"操作失败，请重试",show_alert:true}); } catch {}
            try { if(u.callback_query.message?.chat?.id) await sendHtml(token,u.callback_query.message.chat.id,"⚠️ <b>按钮操作失败</b>\n\n"+escapeHtml(message).slice(0,700)+"\n\n请返回目录后重试。"); } catch {}
          });
        }
        if(u.message) void childMessage(child,u.message,token).catch(e=>console.error("CHILD MESSAGE:",e.message));
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
  try { repairLocalFolders(); } catch(e) { console.warn("本地文件夹归类失败:", String(e?.message||e)); }

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
  if (!globalThis.cloud123AutoStarted) {
    globalThis.cloud123AutoStarted = true;
    const reportCloud123Auto = async (adminId, message) => {
      if (!message || globalThis.cloud123AutoLastError === message) return;
      globalThis.cloud123AutoLastError = message;
      console.warn("☁️ 123云盘自动上传跳过:", message);
    };
    const runCloud123Auto = async () => {
      const adminId = [...ADMIN_IDS][0];
      try {
        if (cloud123Syncing) return;
        if (!adminId) return;
        const cfg = cloud123Config();
        if (!cfg.url || !cfg.username || !cfg.password) return reportCloud123Auto(adminId, "123云盘还没配置。请先点「配置123云盘」。");
        if (!repo()) return reportCloud123Auto(adminId, "资源仓库还没绑定。");
        if (!db.settings?.historyAuth?.session) return reportCloud123Auto(adminId, "扫描账号还没登录。请先点「扫描账号」完成授权。");
        globalThis.cloud123AutoLastError = "";
        console.log("☁️ 123云盘自动上传开始");
        await cloud123ScanAndUpload(adminId,{silent:true});
      } catch (e) {
        const message = String(e?.message || e);
        console.error("❌ 123云盘自动上传失败:", message);
        await reportCloud123Auto(adminId, message);
      }
    };
    setTimeout(() => runCloud123Auto().catch(()=>{}), 60000);
    setInterval(() => runCloud123Auto().catch(()=>{}), 10 * 60 * 1000);
    console.log("☁️ 123云盘自动上传已开启，每 10 分钟检查一次");
  }
  if (!backgroundTimersStarted) {
    backgroundTimersStarted = true;
    setInterval(() => { processAutoDeleteQueue().catch(e=>console.warn("⚠️ 自动删除任务异常：",e.message)); }, 30000);
    checkMembershipExpiryReminders().catch(e=>console.warn("⚠️ 会员到期提醒检查失败：",String(e?.message||e)));
    setInterval(() => { checkMembershipExpiryReminders().catch(e=>console.warn("⚠️ 会员到期提醒检查失败：",String(e?.message||e))); }, 60*60*1000);
    setInterval(() => {
      const s = runtimeStatus();
      console.log("🫀 HEARTBEAT:", "connected="+s.mainConnected, "uptime="+s.uptimeSeconds+"s", "lastPoll="+(s.lastPollAt||"-"), "lastUpdate="+(s.lastUpdateAt||"-"), "error="+(s.lastError||"-"));
    }, 30000);
  }

  // Google Sheets 不再定时全表刷新；只在机器人启动时强制刷新，或管理员手动点击“同步共享数据”时刷新。
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
      if(autoSyncState.enabled && autoSyncState.sourceId && autoSyncState.targetId){
        // MTProto 相册补全不能阻塞主机器人轮询；GetMessages 可能触发 30 秒 FloodWait。
        // 先恢复自动同步和 Telegram 轮询，再后台补全分组信息。
        const autoSyncSourceId=String(autoSyncState.sourceId);
        const autoSyncOwnerId=Number(autoSyncState.ownerId||0);
        void hydrateRepositoryAutoSyncMediaGroups(autoSyncOwnerId,autoSyncSourceId).then(()=>{
          const current=repositoryAutoSyncState();
          if(!current.enabled || String(current.sourceId)!==autoSyncSourceId) return;
          for(const queued of current.queue){
            const saved=db.resources.find(x=>String(x.chatId)===autoSyncSourceId&&Number(x.messageId)===Number(queued?.messageId));
            if(saved?.mediaGroupId) queued.mediaGroupId=String(saved.mediaGroupId);
          }
          saveDb();
        }).catch(e=>console.warn("⚠️ AUTO SYNC 后台补全相册信息失败：",String(e?.message||e)));
        for(const queued of autoSyncState.queue){
          const saved=db.resources.find(x=>String(x.chatId)===autoSyncSourceId&&Number(x.messageId)===Number(queued?.messageId));
          if(saved?.mediaGroupId) queued.mediaGroupId=String(saved.mediaGroupId);
          // 旧版本队列没有 historical 字段时，按启动时已有资源处理，避免退化成逐条同步。
          if(!Object.prototype.hasOwnProperty.call(queued,"historical")) queued.historical=true;
        }
        saveDb();
        const accessOk=await checkRepositoryAutoSyncAccess();
        if(accessOk && !autoSyncState.manualPaused){
          autoSyncState.status=autoSyncState.queue.length?"queued":"running";
          autoSyncState.lastError="";
          autoSyncState.updatedAt=Date.now();
          saveDb();
          processRepositoryAutoSyncQueue().catch(e=>console.error("❌ 自动同步恢复失败:",String(e?.message||e)));
        }
      }
      const migrationState=db.settings.repositoryMigration||{};
      if(["running","paused"].includes(String(migrationState.status||"")) && migrationState.sourceId && migrationState.targetId && migrationState.ownerId) {
        console.log("🔄 检测到未完成迁移，启动断点恢复：",migrationState.sourceId+"->"+migrationState.targetId);
        repositoryMigration(Number(migrationState.ownerId),migrationState.sourceId,migrationState.targetId)
          .catch(e=>console.error("❌ 迁移断点恢复失败:",String(e?.message||e)));
      }
      // Telegram 轮询必须优先启动，Google Sheets 同步不得阻塞机器人按钮和消息。
      if (!sharedBaserowInitStarted) {
        sharedBaserowInitStarted = true;
        console.log("🔄 Google Sheets 共享模式：后台初始化，不阻塞 Telegram", "pid=" + PROCESS_ID);
        initializeSharedBaserow()
          .then(async()=>{
            console.log("✅ Google Sheets 共享初始化完成", "pid=" + PROCESS_ID);
            console.log("🔎 Google Sheets 共享配置:", "enabled="+baserow.enabled, "connected="+baserow.connected, "credential="+(GOOGLE_SHEETS_CREDENTIAL ? "已配置" : "❌ 未配置"), "table="+GOOGLE_SHEETS_ID, baserow.lastError ? "error="+baserow.lastError : "");
            // 初始化完成后立即强制刷新一次，确保刚启动的机器人立刻拿到其他机器人已经写入的目录。
            await refreshSharedData(true);
            console.log("✅ Google Sheets 启动后首次强制刷新完成", "pid=" + PROCESS_ID);
          })
          .catch(e=>console.error("❌ Google Sheets 后台初始化异常:",String(e?.message||e)));
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