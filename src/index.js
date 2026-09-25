const json = (x, status=200) => new Response(JSON.stringify(x), {status, headers: {"content-type":"application/json;charset=UTF-8"}});
const ok = x => json({ok:true,...x});
const API = token => "https://api.telegram.org/bot" + token;

async function tg(token, method, body={}) {
  const r = await fetch(API(token)+"/"+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || method+" failed");
  return d.result;
}
const send = (token, chat_id, text, extra={}) => tg(token,"sendMessage",{chat_id,text,...extra});
const kb = rows => ({reply_markup:{keyboard:rows,resize_keyboard:true}});
const inline = rows => ({reply_markup:{inline_keyboard:rows}});
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function setting(env,key, fallback="") {
  const r=await env.DB.prepare("SELECT value FROM platform_settings WHERE key=?").bind(key).first();
  return r?.value ?? fallback;
}
async function isAdmin(env,id) {
  const r=await env.DB.prepare("SELECT 1 FROM admins WHERE user_id=?").bind(String(id)).first();
  if(r) return true;
  const ids=(env.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
  return ids.includes(String(id));
}
async function member(env, token, id) {
  const gid=await setting(env,"required_group_id",env.REQUIRED_GROUP_ID||"");
  if(!gid) return true;
  try {
    const m=await tg(token,"getChatMember",{chat_id:gid,user_id:id});
    return ["creator","administrator","member"].includes(m.status);
  } catch { return false; }
}
function menu(admin=false){
  const rows=[["🤖 克隆我的机器人"],["📂 资源目录","🔎 搜索资源"],["🎲 随机获取","🆕 最新资源"]];
  if(admin) rows.push(["📢 广播消息"],["⚙️ 平台管理"]);
  return kb(rows);
}
function childMenu(){ return kb([["📂 资源目录","🔎 搜索资源"],["🎲 随机获取","🆕 最新资源"]]); }

async function resources(env, mode, value="", limit=8, offset=0){
  if(mode==="search"){
    return env.DB.prepare("SELECT id,filename,file_id,file_type,file_size,folder_id,created_at FROM resources WHERE status='active' AND filename LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?").bind("%"+value+"%",limit,offset).all();
  }
  if(mode==="latest") return env.DB.prepare("SELECT id,filename,file_id,file_type,file_size,folder_id,created_at FROM resources WHERE status='active' ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(limit,offset).all();
  if(mode==="random") return env.DB.prepare("SELECT id,filename,file_id,file_type,file_size,folder_id,created_at FROM resources WHERE status='active' ORDER BY RANDOM() LIMIT 10").all();
  return env.DB.prepare("SELECT id,name FROM folders ORDER BY name").all();
}
async function resourceButtons(env, list){
  const rows=[];
  for(const r of list.results||[]) rows.push([{text:"📦 "+r.filename,callback_data:"res:"+r.id}]);
  return rows;
}
async function sendResource(env, token, chatId, id){
  const r=await env.DB.prepare("SELECT * FROM resources WHERE id=? AND status='active'").bind(id).first();
  if(!r) return send(token,chatId,"❌ 资源不存在或已下架。");
  if(r.file_id){
    const type=r.file_type||"document";
    const method={photo:"sendPhoto",video:"sendVideo",audio:"sendAudio",document:"sendDocument"}[type]||"sendDocument";
    const body={chat_id:chatId};
    body[type]=r.file_id;
    return tg(token,method,body);
  }
  return send(token,chatId,"⚠️ 该资源暂无可发送的 Telegram file_id。");
}

async function broadcast(env, token, adminChat, text){
  const users=await env.DB.prepare("SELECT user_id FROM bot_users WHERE bot_instance_id IS NULL AND status='active'").all();
  let okc=0,fail=0;
  await send(token,adminChat,"📢 正在发送广播\n\n总数："+users.results.length+"\n已处理：0");
  for(const u of users.results){
    try{await send(token,u.user_id,text);okc++;}catch{fail++;}
    await sleep(60);
  }
  return send(token,adminChat,"✅ 广播完成\n\n📊 总数："+users.results.length+"\n✅ 成功："+okc+"\n❌ 失败："+fail);
}

async function mainHandle(env, msg){
  const token=env.BOT_TOKEN, uid=msg.from?.id, chat=msg.chat?.id;
  if(!uid) return;
  const admin=await isAdmin(env,uid);
  if(msg.chat.type==="private") await env.DB.prepare("INSERT INTO bot_users(bot_instance_id,user_id,last_seen,status) VALUES(NULL,?,datetime('now'),'active') ON CONFLICT(bot_instance_id,user_id) DO UPDATE SET last_seen=datetime('now'),status='active'").bind(uid).run();
  if(msg.text==="/start") return send(token,chat,"👋 欢迎使用机器人平台\n\n请选择功能：",menu(admin));
  if(msg.text==="📢 广播消息" && admin){await env.DB.prepare("INSERT OR REPLACE INTO clone_sessions(user_id,step,payload) VALUES(?, 'broadcast', '')").bind(uid).run();return send(token,chat,"📢 请输入广播文字。\n\n发送 /cancel 取消。");}
  const s=await env.DB.prepare("SELECT step FROM clone_sessions WHERE user_id=?").bind(uid).first();
  if(s?.step==="broadcast" && admin && msg.text && msg.text!=="/cancel"){await env.DB.prepare("DELETE FROM clone_sessions WHERE user_id=?").bind(uid).run();return broadcast(env,token,chat,msg.text);}
  if(s?.step==="broadcast" && msg.text==="/cancel"){await env.DB.prepare("DELETE FROM clone_sessions WHERE user_id=?").bind(uid).run();return send(token,chat,"❌ 已取消。",menu(true));}
  if(msg.text==="🤖 克隆我的机器人"){
    if(!(await member(env,token,uid))) return send(token,chat,"🔐 暂无克隆权限\n\n请先加入指定群后再使用克隆功能。",inline([...(env.REQUIRED_GROUP_URL?[[{text:"🚪 加入指定群",url:env.REQUIRED_GROUP_URL}]]:[]),[{text:"🔄 检查权限",callback_data:"check_clone"}]]));
    await env.DB.prepare("INSERT OR REPLACE INTO clone_sessions(user_id,step,payload) VALUES(?, 'token', '')").bind(uid).run();
    return send(token,chat,"🤖 创建你的专属机器人\n\n1️⃣ 在 BotFather 创建机器人\n2️⃣ 复制 Bot Token\n3️⃣ 把 Token 直接发送给我完成绑定\n\n⚠️ 不要把 Token 发到群里，也不要提交到 GitHub。\n\n📢 子机器人不会有广播功能。");
  }
  if(["📂 资源目录","🔎 搜索资源","🎲 随机获取","🆕 最新资源"].includes(msg.text)){
    if(!(await member(env,token,uid))) return send(token,chat,"🔐 暂无访问权限\n\n请先加入指定群。");
    if(msg.text==="📂 资源目录"){const f=await resources(env,"folders");return send(token,chat,"📂 资源目录\n\n请选择分类：",inline((f.results||[]).map(x=>[{text:"📁 "+x.name,callback_data:"folder:"+x.id}])));}
    if(msg.text==="🔎 搜索资源"){await env.DB.prepare("INSERT OR REPLACE INTO clone_sessions(user_id,step,payload) VALUES(?, 'search', '')").bind(uid).run();return send(token,chat,"🔎 请输入资源名称或关键词：");}
    const list=await resources(env,msg.text==="🎲 随机获取"?"random":"latest");
    if(msg.text==="🎲 随机获取"){
      for(const r of list.results||[]) await sendResource(env,token,chat,r.id);
      return;
    }
    return send(token,chat,"🆕 最新资源",inline(await resourceButtons(env,list)));
  }
  if(msg.text==="⚙️ 平台管理" && admin) return send(token,chat,"⚙️ 平台管理\n\n当前版本已接入：指定群、子机器人、中央资源索引。\n\n资源仓库扫描/上传需要绑定资源来源后使用。");
  if(s?.step==="search" && msg.text){
    await env.DB.prepare("DELETE FROM clone_sessions WHERE user_id=?").bind(uid).run();
    const list=await resources(env,"search",msg.text);
    return send(token,chat,"🔎 搜索结果："+(list.results?.length||0),inline(await resourceButtons(env,list)));
  }
  if(s?.step==="token" && msg.text){
    await env.DB.prepare("DELETE FROM clone_sessions WHERE user_id=?").bind(uid).run();
    if(!(await member(env,token,uid))) return send(token,chat,"🔐 群组权限已失效，请重新加入指定群。");
    let bot;
    try{bot=await tg(msg.chat.type==="private"?token:env.BOT_TOKEN,"getMe");}catch{}
    // Token 由后端直接校验；此处避免在回复/日志中输出 Token。
    try{
      const child=await tg(msg.text.trim(),"getMe");
      if(!child?.id || !child?.username) throw new Error("invalid");
      await env.DB.prepare("INSERT INTO bot_instances(owner_id,bot_id,username,token_ciphertext,status,created_at,updated_at) VALUES(?,?,?,?, 'active',datetime('now'),datetime('now')) ON CONFLICT(bot_id) DO UPDATE SET owner_id=excluded.owner_id,username=excluded.username,token_ciphertext=excluded.token_ciphertext,status='active',updated_at=datetime('now'))").bind(uid,child.id,child.username,msg.text.trim()).run();
      return send(token,chat,"✅ 子机器人绑定成功\n\n🤖 @"+child.username+"\n\n子机器人不会显示广播功能。");
    }catch{return send(token,chat,"❌ Token 无效，请从 BotFather 复制完整 Token 后重试。");}
  }
}

async function childHandle(env, bot, msg){
  const uid=msg.from?.id, chat=msg.chat?.id;
  if(!uid) return;
  await env.DB.prepare("INSERT INTO bot_users(bot_instance_id,user_id,last_seen,status) VALUES(?,?,datetime('now'),'active') ON CONFLICT(bot_instance_id,user_id) DO UPDATE SET last_seen=datetime('now'),status='active'").bind(bot.id,uid).run();
  if(msg.text==="/start") return send(bot.token,chat,"👋 欢迎使用资源库\n\n请选择功能：",childMenu());
  if(!(await member(env,bot.token,uid))) return send(bot.token,chat,"🔐 暂无访问权限\n\n请先加入指定群。");
  if(msg.text==="📂 资源目录"){const f=await resources(env,"folders");return send(bot.token,chat,"📂 资源目录\n\n请选择分类：",inline((f.results||[]).map(x=>[{text:"📁 "+x.name,callback_data:"folder:"+x.id}])));}
  if(msg.text==="🔎 搜索资源"){await env.DB.prepare("INSERT OR REPLACE INTO clone_sessions(user_id,step,payload) VALUES(?, 'search:'+bot.id, '')").bind(uid).run();return send(bot.token,chat,"🔎 请输入资源名称或关键词：");}
  if(msg.text==="🎲 随机获取"){const l=await resources(env,"random");for(const r of l.results||[]) await sendResource(env,bot.token,chat,r.id);return;}
  if(msg.text==="🆕 最新资源"){const l=await resources(env,"latest");return send(bot.token,chat,"🆕 最新资源",inline(await resourceButtons(env,l)));}
}

async function route(env, request){
  if(request.method!=="POST") return new Response("Telegram Clone Platform OK");
  const path=new URL(request.url).pathname;
  let body;try{body=await request.json()}catch{return json({error:"bad json"},400);}
  if(path==="/webhook/main") {await mainUpdate(env,body);return ok({});}
  if(path.startsWith("/webhook/child/")){
    const id=path.split("/").pop();
    const bot=await env.DB.prepare("SELECT bot_id,username,token_ciphertext AS token,status FROM bot_instances WHERE bot_id=? AND status='active'").bind(id).first();
    if(!bot) return json({error:"not found"},404);
    await childUpdate(env,bot,body);return ok({});
  }
  return json({error:"not found"},404);
}
async function mainUpdate(env,u){
  if(u.callback_query?.data==="check_clone"){const okm=await member(env,env.BOT_TOKEN,u.from.id);await tg(env.BOT_TOKEN,"answerCallbackQuery",{callback_query_id:u.id,text:okm?"验证成功":"请先加入指定群",show_alert:true});if(okm) await send(env.BOT_TOKEN,u.from.id,"✅ 群组验证通过\n\n现在可以创建你的专属机器人。",menu(false));return;}
  if(u.callback_query?.data?.startsWith("res:")){if(!(await member(env,env.BOT_TOKEN,u.from.id)))return;return sendResource(env,env.BOT_TOKEN,u.from.id,Number(u.callback_query.data.slice(4)));}
  if(u.message) await mainHandle(env,u.message);
}
async function childUpdate(env,bot,u){
  if(u.callback_query?.data?.startsWith("res:")){if(!(await member(env,bot.token,u.from.id)))return;await sendResource(env,bot.token,u.from.id,Number(u.callback_query.data.slice(4)));return;}
  if(u.message) await childHandle(env,bot,u.message);
}
async function registerChildWebhook(env,bot){
  const base=env.PUBLIC_BASE_URL;
  if(!base) return;
  await tg(bot.token,"setWebhook",{url:base+"/webhook/child/"+bot.id,secret_token:env.WEBHOOK_SECRET||undefined});
}
export default {async fetch(request,env){try{return await route(env,request)}catch(e){console.error("request error",e.message);return json({error:"internal"},500)}}};
