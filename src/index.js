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
const send = (token, chat_id, text, extra = {}) => tg(token, "sendMessage", {chat_id, text, ...extra});

function emptyDb() {
  return {offset:0, users:[], children:[], resources:[], directories:[], settings:{requiredGroup:null, repository:null}};
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
    ["🎲 随机获取","🆕 最新资源"]
  ],resize_keyboard:true}};
}
function adminMenu() {
  return {reply_markup:{keyboard:[
    ["📂 资源目录","🔎 搜索资源"],
    ["🎲 随机获取","🆕 最新资源"],
    ["🤖 克隆机器人","📢 广播消息"],
    ["🔐 绑定指定群","📦 绑定资源仓库"],
    ["⚙️ 平台管理"]
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
  if(!isAdmin(msg.from?.id) || !["group","supergroup"].includes(msg.chat?.type)) return false;
  const t=msg.text||"";
  if(!["/绑定指定群","/绑定仓库","/解绑指定群","/解绑仓库"].includes(t)) return false;

  if(t==="/绑定指定群") {
    db.settings.requiredGroup={chatId:String(msg.chat.id),title:msg.chat.title||String(msg.chat.id),username:msg.chat.username||"",type:msg.chat.type,url:msg.chat.username?"https://t.me/"+msg.chat.username:""};
    saveDb();
    await send(TOKEN,msg.from.id,"✅ 指定群绑定成功。\n\n"+configText());
    return true;
  }
  if(t==="/绑定仓库") {
    db.settings.repository={chatId:String(msg.chat.id),title:msg.chat.title||String(msg.chat.id),username:msg.chat.username||"",type:msg.chat.type};
    saveDb();
    await send(TOKEN,msg.from.id,"✅ 资源仓库绑定成功。\n\n"+configText());
    return true;
  }
  if(t==="/解绑指定群") db.settings.requiredGroup=null;
  if(t==="/解绑仓库") db.settings.repository=null;
  saveDb();
  await send(TOKEN,msg.from.id,"✅ 已解除绑定。\n\n"+configText());
  return true;
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
    return send(TOKEN,uid,"📦 绑定资源仓库\n\n1. 把主机器人加入资源仓库群/频道。\n2. 机器人需要能读取消息。\n3. 在仓库里发送：\n\n/绑定仓库\n\n绑定后，新资源会自动建立索引。");

  if(t==="🤖 克隆机器人" && admin) {
    if(!(await allowed(TOKEN,uid))) return send(TOKEN,uid,"🔐 你不在指定群，暂时不能创建子机器人。");
    states.set(key,{step:"token"});
    return send(TOKEN,uid,"🤖 创建子机器人\n\n请把 BotFather 创建的 Bot Token 发给我。\n\n发送 /cancel 可取消。");
  }
  if(s?.step==="token"&&admin) {
    if(t==="/cancel") { states.delete(key); return send(TOKEN,uid,"❌ 已取消。",adminMenu()); }
    try {
      const me=await tg(t,"getMe");
      if(db.children.some(x=>x.botId===me.id)) throw new Error("already");
      const child={botId:me.id,username:me.username||"",ownerId:uid,token:encrypt(t),offset:0};
      db.children.push(child); saveDb(); states.delete(key); startChild(child);
      return send(TOKEN,uid,`✅ 子机器人创建成功\n\n🤖 @${me.username||me.first_name}\n\n已自动启动。`,adminMenu());
    } catch { return send(TOKEN,uid,"❌ Token 无效或该机器人已经绑定，请重新发送。"); }
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
  if(t==="⚙️ 平台管理"&&admin) return send(TOKEN,uid,configText(),adminMenu());
}

async function childMessage(child,msg,token) {
  if(msg.chat?.type!=="private") return;
  const uid=msg.from.id,t=msg.text||"",key="c:"+child.botId+":"+uid,s=states.get(key);
  if((t.split(" ")[0].split("@")[0])==="/start") return send(token,uid,"👋 欢迎使用资源机器人\n\n请选择功能：",userMenu());
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
        db.offset=u.update_id+1;
        if(u.channel_post) indexResource(u.channel_post);
        if(u.edited_channel_post) indexResource(u.edited_channel_post);
        if(u.message) await mainMessage(u.message);
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
