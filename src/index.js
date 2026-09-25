import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const DATA_FILE = process.env.DATA_FILE || "/data/database.json";
const SECRET = process.env.STORAGE_KEY || "telegram-clone-platform-v2";
const MAX_RESOURCES = Number(process.env.MAX_RESOURCES || 5000);
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH || "";

console.log("🚀 Telegram Clone Platform v2 starting...");
console.log("📦 Node:", process.version);
console.log("🔐 BOT_TOKEN:", TOKEN ? "已配置" : "❌ 未配置");
console.log("👑 ADMIN_IDS:", ADMIN_IDS.size ? "已配置" : "❌ 未配置");

process.on("uncaughtException", e => console.error("UNCAUGHT:", e));
process.on("unhandledRejection", e => console.error("UNHANDLED:", e));

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, {"content-type":"text/plain; charset=utf-8"});
    res.end("Telegram Clone Platform OK\n");
  } else {
    res.writeHead(404);
    res.end("Not Found\n");
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`🌐 HTTP server: 0.0.0.0:${PORT}`));

if (!TOKEN) {
  console.error("❌ BOT_TOKEN 未配置，请在 Deplexo 环境变量中设置 BOT_TOKEN");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function tg(token, method, body = {}) {
  const r = await fetch(api(token, method), {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || method + " failed");
  return j.result;
}
const main = (method, body = {}) => tg(TOKEN, method, body);
function prettyText(text) {
  let s = String(text ?? "")
    .replace(/\\\\n/g, "\\n")
    .replace(/\\r/g, "")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();

  if (!s) return s;

  const lines = s.split("\\n");
  if (
    lines.length >= 2 &&
    !lines[0].startsWith("━━━━━━━━") &&
    !lines[0].startsWith("╭") &&
    !lines[0].startsWith("<")
  ) {
    return lines[0] + "\\n━━━━━━━━━━━━━━\\n" + lines.slice(1).join("\\n");
  }
  return s;
}

const send = (token, chat_id, text, extra = {}) =>
  tg(token, "sendMessage", {chat_id, text:prettyText(text), ...extra});

const sendHtml = (token, chat_id, text, extra = {}) =>
  tg(token, "sendMessage", {
    chat_id,
    text:String(text ?? "").replace(/\\\\n/g, "\\n"),
    parse_mode:"HTML",
    ...extra
  });

function emptyDb() {
  return {offset:0, users:[], children:[], resources:[], directories:[], settings:{requiredGroup:null, repository:null, historyAuth:null, historyScan:{status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""}}};
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
if (!db.settings) db.settings = {requiredGroup:null, repository:null, historyAuth:null, historyScan:{status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""}};
if (!("historyAuth" in db.settings)) db.settings.historyAuth = null;
if (!db.settings.historyScan) db.settings.historyScan = {status:"idle",scanned:0,indexed:0,startedAt:null,finishedAt:null,error:""};

let historyClient = null;
let historyConnecting = null;
let TelegramClientClass = null;
let StringSessionClass = null;
const historyInputs = new Map();

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
    return sendHtml(TOKEN,uid,`<b>✅ 历史扫描完成</b>\\n\\n📦 <b>资源仓库</b>：${r.title}\\n🔎 <b>扫描消息</b>：${scanned} 条\\n📚 <b>新增/更新</b>：${indexed} 条\\n📊 <b>当前资源</b>：${db.resources.length} 条\\n\\n<i>历史消息已建立索引，现在可以直接搜索资源。</i>`,adminMenu());
  } catch(e) {
    db.settings.historyScan.status="error";
    db.settings.historyScan.error=e.message;
    db.settings.historyScan.finishedAt=Date.now();
    saveDb();
    console.error("❌ HISTORY SCAN:",e);
    return sendHtml(TOKEN,uid,"<b>❌ 历史扫描失败</b>\\n\\n"+e.message+"\\n\\n<i>如果扫描账号已经加入仓库，请重点检查 Telegram 登录状态、频道权限和历史消息读取权限。</i>",adminMenu());
  }
}

const isAdmin = id => ADMIN_IDS.has(String(id));
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
    ["📂 资源目录","🔎 搜索资源"],
    ["🎲 随机获取","🆕 最新资源"],
    ["🤖 克隆机器人"]
  ],resize_keyboard:true}};
}
function adminMenu() {
  return {reply_markup:{keyboard:[
    ["📊 数据统计","🔍 仓库扫描"],
    ["📦 资源仓库","🔐 指定群"],
    ["🤖 克隆机器人","📢 广播消息"],
    ["⚙️ 平台设置"]
  ],resize_keyboard:true}};
}

function configText() {
  const g = group(), r = repo();
  return [
    "⚙️ 当前平台配置",
    "",
    "🔐 指定群：" + (g ? g.title + " (" + g.chatId + ")" : "❌ 未绑定"),
    "📦 资源仓库：" + (r ? r.title + " (" + r.chatId + ")" : "❌ 未绑定"),
    "",
    "🤖 子机器人：" + db.children.length,
    "👤 用户：" + db.users.length,
    "📚 资源：" + db.resources.length
  ].join("\n");
}

function indexResource(msg) {
  const r = repo();
  if (!r || String(msg.chat?.id) !== String(r.chatId)) return;
  const media = msg.document || msg.video || msg.audio || msg.animation || msg.photo?.at(-1);
  if (!media && !msg.text) return;
  const item = {
    chatId:String(msg.chat.id),
    messageId:msg.message_id,
    title:(msg.document?.file_name || msg.audio?.file_name || msg.caption || msg.text || "未命名资源").slice(0,200),
    caption:(msg.caption || msg.text || "").slice(0,500),
    date:msg.date || Math.floor(Date.now()/1000),
    directoryId:null
  };
  const i=db.resources.findIndex(x=>x.chatId===item.chatId&&x.messageId===item.messageId);
  if(i>=0) db.resources[i]=item; else db.resources.unshift(item);
  db.resources=db.resources.slice(0,MAX_RESOURCES);
  saveDb();
}
function search(q) {
  q=q.toLowerCase();
  return db.resources.filter(x=>(x.title+" "+x.caption).toLowerCase().includes(q)).slice(0,10);
}
function random10() { return [...db.resources].sort(()=>Math.random()-.5).slice(0,10); }

async function deliver(token,chatId,userId,items) {
  if(!(await allowed(token,userId))) return send(token,chatId,"🔐 请先加入指定群。");
  if(!items.length) return send(token,chatId,"📭 暂无相关资源。");
  for(const x of items) {
    try { await tg(token,"copyMessage",{chat_id:chatId,from_chat_id:x.chatId,message_id:x.messageId}); }
    catch(e) { console.error("COPY:",e.message); }
    await sleep(80);
  }
}

const states=new Map();

async function binding(msg) {
  const admin=isAdmin(msg.from?.id);
  const t=(msg.text||"").trim().split(/\\s+/)[0];
  if(!admin) return false;

  if(["/绑定指定群","/绑定仓库","/解绑指定群","/解绑仓库"].includes(t) &&
     !["group","supergroup"].includes(msg.chat?.type)) {
    return send(TOKEN,msg.from.id,"⚠️ 这个命令请在目标群里发送。");
  }

  if(["/绑定指定群","/绑定仓库","/解绑指定群","/解绑仓库"].includes(t) &&
     ["group","supergroup"].includes(msg.chat?.type)) {
    if(t==="/绑定指定群") {
      db.settings.requiredGroup={chatId:String(msg.chat.id),title:msg.chat.title||String(msg.chat.id),username:msg.chat.username||"",type:msg.chat.type,url:msg.chat.username?"https://t.me/"+msg.chat.username:""};
      saveDb();
      await send(TOKEN,msg.from.id,"✅ 指定群绑定成功。\\n\\n"+configText());
      return true;
    }
    if(t==="/绑定仓库") {
      db.settings.repository={chatId:String(msg.chat.id),title:msg.chat.title||String(msg.chat.id),username:msg.chat.username||"",type:msg.chat.type};
      saveDb();
      await send(TOKEN,msg.from.id,"✅ 资源仓库绑定成功。\\n\\n"+configText());
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
  const pendingHistory = historyInputs.get(String(uid));
  if (pendingHistory) {
    if (t === "/cancel") { historyInputs.delete(String(uid)); return send(TOKEN,uid,"❌ 已取消历史扫描授权。",adminMenu()); }
    historyInputs.delete(String(uid));
    pendingHistory.resolve(t);
    return;
  }

  if(t==="/start") return send(TOKEN,uid,"👋 主机器人已启动。\n\n请选择功能：",admin?adminMenu():userMenu());
  if(t==="/admin") {
    if(!admin) return send(TOKEN,uid,"⛔ 无管理员权限。");
    return send(TOKEN,uid,"👑 管理员控制台\n\n"+configText()+"\n\n绑定操作请把主机器人加入目标群/仓库后，在对应群里发送：\n/绑定指定群\n/绑定仓库",adminMenu());
  }
  if(t==="/状态") {
    if(!admin) return send(TOKEN,uid,"⛔ 无管理员权限。");
    return send(TOKEN,uid,configText(),adminMenu());
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
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消。",adminMenu()); }
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
    return send(TOKEN,uid,
      "📊 平台数据\\n\\n"+
      "👤 用户： "+db.users.length+"\\n"+
      "🤖 子机器人： "+db.children.length+"\\n"+
      "📚 已索引资源： "+db.resources.length+"\\n"+
      "📂 目录： "+db.directories.length+"\\n\\n"+
      "🔐 指定群： "+(group()?"✅ 已绑定":"❌ 未绑定")+"\\n"+
      "📦 资源仓库： "+(repo()?"✅ 已绑定":"❌ 未绑定"),
      adminMenu());

  if(t==="📦 资源仓库" && admin)
    return send(TOKEN,uid,
      "📦 资源仓库设置\\n\\n"+
      "推荐：把主机器人加入资源频道并设为管理员，\\n"+
      "然后从频道转发任意一条消息给主机器人。\\n\\n"+
      "当前： "+(repo()?"✅ "+repo().title:"❌ 未绑定"));

  if(t==="🔐 指定群" && admin)
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
    return send(TOKEN,uid,db.directories.length?"📂 资源目录\n\n"+db.directories.map((d,i)=>`${i+1}. ${d.name}`).join("\n"):"📂 暂无资源目录。");
  }
  if(t==="🔎 搜索资源") { states.set(key,{step:"search"}); return send(TOKEN,uid,"🔎 请输入关键词："); }
  if(t==="🎲 随机获取") return deliver(TOKEN,uid,uid,random10());
  if(t==="🆕 最新资源") return deliver(TOKEN,uid,uid,db.resources.slice(0,10));
  if(s?.step==="search") { states.delete(key); return deliver(TOKEN,uid,uid,search(t)); }

  if(t==="📢 广播消息"&&admin) { states.set(key,{step:"broadcast"}); return send(TOKEN,uid,"📢 请发送要广播的内容："); }
  if(s?.step==="broadcast"&&admin) {
    states.delete(key); let ok=0,fail=0;
    for(const id of db.users){ try{await send(TOKEN,id,t);ok++;}catch{fail++;} await sleep(50); }
    return send(TOKEN,uid,`✅ 广播完成\n\n成功：${ok}\n失败：${fail}`,adminMenu());
  }
  if((t==="⚙️ 平台设置" || t==="⚙️ 平台管理")&&admin) {
    return send(TOKEN,uid,
      "⚙️ 平台设置\\n\\n"+
      "这里集中管理平台核心配置。\\n\\n"+
      "📦 资源仓库：设置历史资源来源\\n"+
      "🔐 指定群：设置访问资格群\\n"+
      "🔍 仓库扫描：读取已有历史消息\\n"+
      "📊 数据统计：查看当前运行数据\\n\\n"+
      configText(),
      adminMenu()
    );
  }
}

async function childMessage(child,msg,token) {
  if(msg.chat?.type!=="private") return;
  const uid=msg.from.id,t=msg.text||"",key="c:"+child.botId+":"+uid,s=states.get(key);
  if((t.split(" ")[0].split("@")[0])==="/start") return send(token,uid,"👋 欢迎使用资源机器人\n\n请选择功能：",{reply_markup:{keyboard:[
    ["📂 资源目录","🔎 搜索资源"],
    ["🎲 随机获取","🆕 最新资源"]
  ],resize_keyboard:true}});
  // 使用主机器人检查指定群成员资格，子机器人无需单独加入指定群。\n  if(!(await allowed(TOKEN,uid))) return send(token,uid,"🔐 请先加入指定群。");
  if(t==="📂 资源目录") return send(token,uid,db.directories.length?"📂 资源目录\n\n"+db.directories.map((d,i)=>`${i+1}. ${d.name}`).join("\n"):"📂 暂无资源目录。");
  if(t==="🔎 搜索资源"){states.set(key,{step:"search"});return send(token,uid,"🔎 请输入关键词：");}
  if(t==="🎲 随机获取") return deliver(token,uid,uid,random10());
  if(t==="🆕 最新资源") return deliver(token,uid,uid,db.resources.slice(0,10));
  if(s?.step==="search"){states.delete(key);return deliver(token,uid,uid,search(t));}
}

async function pollMain() {
  await main("deleteWebhook",{drop_pending_updates:false});
  console.log("✅ MAIN POLLING READY");
  while(true){
    try{
      const updates=await main("getUpdates",{offset:db.offset,timeout:25,allowed_updates:["message","channel_post","edited_channel_post"]});
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
        if(u.message) mainMessage(u.message).catch(e=>console.error("MAIN MESSAGE:",e.message));
        db.offset=u.update_id+1;
      }
      saveDb();
    }catch(e){console.error("MAIN POLLING:",e.message);await sleep(3000);}
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
  } catch (e) {
    console.error("❌ CHILD START FAILED:", child.username ? "@" + child.username : "(unknown)", e.message);
    return;
  }

  while(true){
    try{
      const updates=await tg(token,"getUpdates",{offset:Number(child.offset||0),timeout:25,allowed_updates:["message"]});
      if (updates.length) console.log("📩 CHILD UPDATE:", "@" + (child.username || child.botId), "count=" + updates.length);
      for(const u of updates){
        child.offset=u.update_id+1;
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
  const me=await main("getMe");
  console.log("✅ 主机器人已连接:","@"+(me.username||me.first_name));
  console.log("📊 users="+db.users.length+" children="+db.children.length+" resources="+db.resources.length);
  console.log("⚙️ "+configText().replaceAll("\n"," | "));
  for(const child of db.children) startChild(child);
  await pollMain();
}
boot().catch(e=>{console.error("❌ FATAL BOOT:",e);process.exit(1);});
process.on("SIGTERM",()=>{console.log("SIGTERM received");server.close(()=>process.exit(0));});
