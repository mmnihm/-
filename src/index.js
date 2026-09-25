const json = (x, status=200) => new Response(JSON.stringify(x), {status, headers: {"content-type":"application/json;charset=UTF-8"}});
const ok = x => json({ok:true,...x});
const API = token => "https://api.telegram.org/bot" + token;

async function cryptoKey(env){
  if(!env.TOKEN_ENCRYPTION_KEY) throw new Error("Missing TOKEN_ENCRYPTION_KEY");
  const raw=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function decryptToken(env,value){
  const key=await cryptoKey(env);
  const [a,b]=value.split(".");
  const dec=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:dec(a)},key,dec(b));
  return new TextDecoder().decode(plain);
}
async function encryptToken(env,token){
  const key=await cryptoKey(env), iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(token));
  const b=bytes=>btoa(String.fromCharCode(...new Uint8Array(b)));
  return b(iv)+"."+b(data);
}
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
async function clearSession(env,scope,uid){await env.DB.prepare("DELETE FROM clone_sessions WHERE scope=? AND user_id=?").bind(scope,String(uid)).run();}

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
  const users=await env.DB.prepare("SELECT user_id FROM main_users WHERE status='active'").all();
  let okc=0,fail=0;
  await send(token,adminChat,"📢 正在发送广播\n\n总数："+users.results.length+"\n已处理：0");
  for(const u of users.results){
    try{await send(token,u.user_id,text);okc++;}catch{fail++;}
    await sleep(60);
  }
  return send(token,adminChat,"✅ 广播完成\n\n📊 总数："+users.results.length+"\n✅ 成功："+okc+"\n❌ 失败："+fail);
}

async function sessionMain(env,uid,step,payload=""){return env.DB.prepare("INSERT INTO clone_sessions(scope,user_id,step,payload) VALUES('main',?,?,?) ON CONFLICT(scope,user_id) DO UPDATE SET step=excluded.step,payload=excluded.payload").bind(uid,step,payload).run()}
async function mainHandle(env, msg){
  const token=env.BOT_TOKEN, uid=msg.from?.id, chat=msg.chat?.id;
  if(!uid) return;
  const admin=await isAdmin(env,uid);
  if(msg.chat.type==="private") await env.DB.prepare("INSERT INTO main_users(user_id,last_seen,status) VALUES(?,datetime('now'),'active') ON CONFLICT(user_id) DO UPDATE SET last_seen=datetime('now'),status='active'").bind(uid).run();
  if(msg.text==="/start") return send(token,chat,"👋 欢迎使用机器人平台\n\n请选择功能：",menu(admin));
  if(msg.text==="📢 广播消息" && admin){await env.DB.prepare("INSERT INTO clone_sessions(scope,user_id,step,payload) VALUES('main',?, 'broadcast', '') ON CONFLICT(scope,user_id) DO UPDATE SET step=excluded.step,payload=excluded.payload").bind(uid).run();return send(token,chat,"📢 请输入广播文字。\n\n发送 /cancel 取消。");}
  const s=await env.DB.prepare("SELECT step,payload FROM clone_sessions WHERE scope='main' AND user_id=?").bind(uid).first();
  if(admin&&s?.step==="repo"&&msg.text){try{const x=await tg(token,"getChat",{chat_id:msg.text.trim()});await env.DB.prepare("INSERT INTO repositories(chat_id,title,type,status) VALUES(?,?,?,'active') ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,type=excluded.type,status='active'").bind(String(x.id),x.title||x.username||String(x.id),x.type).run();await clearSession(env,"main",uid);return send(token,chat,"✅ 仓库绑定成功。",menu(true))}catch{return send(token,chat,"❌ 主机器人无法访问这个 Chat ID，请检查是否已加入仓库并有权限。")}}
  if(admin&&s?.step==="await_file"){
    if(msg.text==="/cancel"){await clearSession(env,"main",uid);return send(token,chat,"❌ 已取消。",menu(true));}
    const parts=(s.payload||"").split("|"),rid=Number(parts[0]),fid=Number(parts[1]);
    const repo=await env.DB.prepare("SELECT id,chat_id FROM repositories WHERE id=? AND status='active'").bind(rid).first();
    if(!repo)return send(token,chat,"❌ 仓库不存在。");
    let file=null,type=null;
    if(msg.document){file=msg.document;type="document";}
    else if(msg.video){file=msg.video;type="video";}
    else if(msg.photo?.length){file=msg.photo[msg.photo.length-1];type="photo";}
    else if(msg.audio){file=msg.audio;type="audio";}
    else if(msg.voice){file=msg.voice;type="voice";}
    if(!file)return send(token,chat,"❌ 请发送文件、视频、图片或音频。");
    try{
      const copied=await tg(token,"copyMessage",{chat_id:repo.chat_id,from_chat_id:chat,message_id:msg.message_id});
      await env.DB.prepare("INSERT OR IGNORE INTO resources(repository_id,folder_id,filename,file_id,file_unique_id,message_id,chat_id,file_type,file_size,created_at,status) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'),'active')")
        .bind(repo.id,fid,file.file_name||("telegram-"+msg.message_id),file.file_id,file.file_unique_id,String(copied.message_id),String(repo.chat_id),type,file.file_size||null).run();
      await clearSession(env,"main",uid);
      return send(token,chat,"✅ 资源上传并建立索引成功。",menu(true));
    }catch(e){return send(token,chat,"❌ 上传失败，请确认机器人在仓库中有发送/复制所需权限。");}
  }
  if(admin&&s?.step==="folder"&&msg.text){if(msg.text==="/cancel"){await clearSession(env,"main",uid);return send(token,chat,"❌ 已取消。",menu(true))}await env.DB.prepare("INSERT OR IGNORE INTO folders(name) VALUES(?)").bind(msg.text.trim()).run();await clearSession(env,"main",uid);return send(token,chat,"✅ 文件夹创建成功。",menu(true))}
  if(admin&&["list"].includes((msg.text||"").toLowerCase())&&s?.step==="admin"){const x=await env.DB.prepare("SELECT user_id FROM admins ORDER BY user_id").all();return send(token,chat,"👤 管理员列表\\n\\n"+(x.results||[]).map(v=>v.user_id).join("\\n"))}
  if(admin&&s?.step==="admin"&&msg.text){const v=msg.text.trim();if(/^[+-]\d+$/.test(v)){if(v[0]==="+")await env.DB.prepare("INSERT OR IGNORE INTO admins(user_id) VALUES(?)").bind(v.slice(1)).run();else await env.DB.prepare("DELETE FROM admins WHERE user_id=?").bind(v.slice(1)).run();return send(token,chat,"✅ 管理员设置已更新。",menu(true))}}
  if(s?.step==="broadcast" && admin && msg.text && msg.text!=="/cancel"){await env.DB.prepare("UPDATE clone_sessions SET step='broadcast_preview',payload=? WHERE scope='main' AND user_id=?").bind(msg.text,uid).run();return send(token,chat,"📢 广播预览\\n\\n"+msg.text+"\\n\\n确认发送？",inline([[{text:"✅ 确认发送",callback_data:"broadcast_yes"},{text:"❌ 取消",callback_data:"broadcast_no"}]]));}
  if(s?.step==="broadcast" && msg.text==="/cancel"){await env.DB.prepare("DELETE FROM clone_sessions WHERE scope='main' AND user_id=?").bind(uid).run();return send(token,chat,"❌ 已取消。",menu(true));}
  if(msg.text==="🤖 克隆我的机器人"){
    if(!(await member(env,token,uid))) return send(token,chat,"🔐 暂无克隆权限\n\n请先加入指定群后再使用克隆功能。",inline([...(env.REQUIRED_GROUP_URL?[[{text:"🚪 加入指定群",url:env.REQUIRED_GROUP_URL}]]:[]),[{text:"🔄 检查权限",callback_data:"check_clone"}]]));
    await env.DB.prepare("INSERT INTO clone_sessions(scope,user_id,step,payload) VALUES('main',?, 'token', '') ON CONFLICT(scope,user_id) DO UPDATE SET step=excluded.step,payload=excluded.payload").bind(uid).run();
    return send(token,chat,"🤖 创建你的专属机器人\n\n1️⃣ 在 BotFather 创建机器人\n2️⃣ 复制 Bot Token\n3️⃣ 把 Token 直接发送给我完成绑定\n\n⚠️ 不要把 Token 发到群里，也不要提交到 GitHub。\n\n📢 子机器人不会有广播功能。");
  }
  if(["📂 资源目录","🔎 搜索资源","🎲 随机获取","🆕 最新资源"].includes(msg.text)){
    if(!(await member(env,token,uid))) return send(token,chat,"🔐 暂无访问权限\n\n请先加入指定群。");
    if(msg.text==="📂 资源目录"){const f=await resources(env,"folders");return send(token,chat,"📂 资源目录\n\n请选择分类：",inline((f.results||[]).map(x=>[{text:"📁 "+x.name,callback_data:"folder:"+x.id}])));}
    if(msg.text==="🔎 搜索资源"){await env.DB.prepare("INSERT INTO clone_sessions(scope,user_id,step,payload) VALUES('main',?, 'search', '') ON CONFLICT(scope,user_id) DO UPDATE SET step=excluded.step,payload=excluded.payload").bind(uid).run();return send(token,chat,"🔎 请输入资源名称或关键词：");}
    const list=await resources(env,msg.text==="🎲 随机获取"?"random":"latest");
    if(msg.text==="🎲 随机获取"){
      for(const r of list.results||[]) await sendResource(env,token,chat,r.id);
      return;
    }
    return send(token,chat,"🆕 最新资源",inline(await resourceButtons(env,list)));
  }
  if(msg.text==="⚙️ 平台管理" && admin) return send(token,chat,"⚙️ 平台管理",kb([["📦 绑定仓库","📁 新建文件夹"],["📤 上传资源","👤 管理员设置"],["🔄 扫描仓库"],["🏠 返回首页"]]));
  if(msg.text==="📦 绑定仓库"&&admin){await sessionMain(env,uid,"repo","");return send(token,chat,"📦 请发送仓库 Chat ID。\\n\\n先把主机器人加入私有群/频道并授予必要权限。\\n/cancel 取消。")}
  if(msg.text==="📁 新建文件夹"&&admin){await sessionMain(env,uid,"folder","");return send(token,chat,"📁 请输入新文件夹名称。\\n/cancel 取消。")}
  if(msg.text==="👤 管理员设置"&&admin){await sessionMain(env,uid,"admin","");return send(token,chat,"👤 管理员设置\\n\\n发送 +数字 添加管理员\\n发送 -数字 删除管理员\\n发送 list 查看管理员\\n/cancel 取消。");}
  if(msg.text==="📤 上传资源"&&admin){
    const repo=await env.DB.prepare("SELECT id,chat_id,title FROM repositories WHERE status='active' ORDER BY id LIMIT 10").all();
    if(!repo.results?.length) return send(token,chat,"❌ 还没有绑定仓库。请先绑定仓库。");
    await sessionMain(env,uid,"upload_repo","");
    return send(token,chat,"📦 请选择仓库：",inline((repo.results||[]).map(x=>[{text:"📦 "+x.title,callback_data:"upload_repo:"+x.id}])));
  }
  if(msg.text==="🔄 扫描仓库"&&admin)return send(token,chat,"🔄 仓库扫描说明\\n\\n当前 Telegram Bot API 无法保证读取私有仓库的完整历史消息，因此这里不会伪造“全量扫描成功”。\\n\\n现有资源可继续通过上传流程建立索引；完整历史恢复需要 MTProto/user-account 扫描层。");
  if(s?.step==="search" && msg.text){
    await env.DB.prepare("DELETE FROM clone_sessions WHERE scope='main' AND user_id=?").bind(uid).run();
    const list=await resources(env,"search",msg.text);
    return send(token,chat,"🔎 搜索结果："+(list.results?.length||0),inline(await resourceButtons(env,list)));
  }
  if(s?.step==="token" && msg.text){
    await env.DB.prepare("DELETE FROM clone_sessions WHERE scope='main' AND user_id=?").bind(uid).run();
    if(!(await member(env,token,uid))) return send(token,chat,"🔐 群组权限已失效，请重新加入指定群。");
    let bot;
    try{bot=await tg(msg.chat.type==="private"?token:env.BOT_TOKEN,"getMe");}catch{}
    // Token 由后端直接校验；此处避免在回复/日志中输出 Token。
    try{
      const child=await tg(msg.text.trim(),"getMe");
      if(!child?.id || !child?.username) throw new Error("invalid");
      const encrypted=await encryptToken(env,msg.text.trim());
      await env.DB.prepare("INSERT INTO bot_instances(owner_id,bot_id,username,token_ciphertext,status,created_at,updated_at) VALUES(?,?,?,?, 'active',datetime('now'),datetime('now')) ON CONFLICT(bot_id) DO UPDATE SET owner_id=excluded.owner_id,username=excluded.username,token_ciphertext=excluded.token_ciphertext,status='active',updated_at=datetime('now')").bind(uid,child.id,child.username,encrypted).run();
      await registerChildWebhook(env,{id:child.id,token:msg.text.trim()});
      return send(token,chat,"✅ 子机器人绑定成功\n\n🤖 @"+child.username+"\n\n子机器人不会显示广播功能。");
    }catch{return send(token,chat,"❌ Token 无效，请从 BotFather 复制完整 Token 后重试。");}
  }
}

async function childHandle(env, bot, msg){
  const uid=msg.from?.id, chat=msg.chat?.id;
  if(!uid) return;
  await env.DB.prepare("INSERT INTO bot_users(bot_instance_id,user_id,last_seen,status) VALUES((SELECT id FROM bot_instances WHERE bot_id=?),?,datetime('now'),'active') ON CONFLICT(bot_instance_id,user_id) DO UPDATE SET last_seen=datetime('now'),status='active'").bind(bot.bot_id,uid).run();
  const s=await env.DB.prepare("SELECT step FROM clone_sessions WHERE scope=? AND user_id=?").bind("child:"+bot.bot_id,uid).first();
  if(msg.text==="/start") return send(bot.token,chat,"👋 欢迎使用资源库\\n\\n请选择功能：",childMenu());
  if(s?.step==="search" && msg.text){
    await env.DB.prepare("DELETE FROM clone_sessions WHERE scope=? AND user_id=?").bind("child:"+bot.bot_id,uid).run();
    if(!(await member(env,bot.token,uid))) return send(bot.token,chat,"🔐 暂无访问权限\\n\\n请先加入指定群。");
    const l=await resources(env,"search",msg.text); return send(bot.token,chat,"🔎 搜索结果："+(l.results?.length||0),inline(await resourceButtons(env,l)));
  }
  if(!(await member(env,bot.token,uid))) return send(bot.token,chat,"🔐 暂无访问权限\\n\\n请先加入指定群。");
  if(msg.text==="📂 资源目录"){const f=await resources(env,"folders");return send(bot.token,chat,"📂 资源目录\\n\\n请选择分类：",inline((f.results||[]).map(x=>[{text:"📁 "+x.name,callback_data:"folder:"+x.id}])));}
  if(msg.text==="🔎 搜索资源"){await env.DB.prepare("INSERT INTO clone_sessions(scope,user_id,step,payload) VALUES(?,?,?,'') ON CONFLICT(scope,user_id) DO UPDATE SET step=excluded.step,payload=excluded.payload").bind("child:"+bot.bot_id,uid,"search").run();return send(bot.token,chat,"🔎 请输入资源名称或关键词：");}
  if(msg.text==="🎲 随机获取"){const l=await resources(env,"random");for(const r of l.results||[]) await sendResource(env,bot.token,chat,r.id);return;}
  if(msg.text==="🆕 最新资源"){const l=await resources(env,"latest");return send(bot.token,chat,"🆕 最新资源",inline(await resourceButtons(env,l)));}
}

async function route(env,request){
  const url=new URL(request.url),path=url.pathname;
  if(request.method==="GET"){
    if(path==="/setup"){await tg(env.BOT_TOKEN,"setWebhook",{url:(env.PUBLIC_BASE_URL||url.origin)+"/webhook/main",secret_token:env.WEBHOOK_SECRET||undefined});return json({ok:true,message:"main webhook registered"})}
    return new Response("Telegram Clone Platform OK");
  }
  if(env.WEBHOOK_SECRET&&request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.WEBHOOK_SECRET)return json({error:"unauthorized"},401);
  let body;try{body=await request.json()}catch{return json({error:"bad json"},400)}
  if(path==="/webhook/main"){await mainUpdate(env,body);return ok({})}
  if(path.startsWith("/webhook/child/")){
    const id=path.split("/").pop(),row=await env.DB.prepare("SELECT bot_id,username,token_ciphertext,status FROM bot_instances WHERE bot_id=? AND status='active'").bind(id).first();
    if(!row)return json({error:"not found"},404);
    let token;try{token=await decryptToken(env,row.token_ciphertext)}catch{return json({error:"token unavailable"},500)}
    await childUpdate(env,{...row,token},body);return ok({});
  }
  return json({error:"not found"},404);
}
async function mainUpdate(env,u){
  if(u.callback_query){const q=u.callback_query,d=q.data||'',uid=q.from.id,chat=q.message?.chat?.id;await tg(env.BOT_TOKEN,'answerCallbackQuery',{callback_query_id:q.id});
    if(d==='check_clone'){const okm=await member(env,env.BOT_TOKEN,uid);if(okm)await send(env.BOT_TOKEN,uid,'✅ 群组验证通过\n\n现在可以创建你的专属机器人。',menu(false));return;}
    if(d==='home')return send(env.BOT_TOKEN,chat,'🏠 返回首页',menu(await isAdmin(env,uid)));
    if(d==='broadcast_no'){await env.DB.prepare("DELETE FROM clone_sessions WHERE scope='main' AND user_id=?").bind(uid).run();return send(env.BOT_TOKEN,chat,'❌ 广播已取消。',menu(true));}
    if(d==='broadcast_yes'&&await isAdmin(env,uid)){const s=await env.DB.prepare("SELECT payload FROM clone_sessions WHERE scope='main' AND user_id=? AND step='broadcast_preview'").bind(uid).first();if(!s)return send(env.BOT_TOKEN,chat,'❌ 广播已失效。');await env.DB.prepare("DELETE FROM clone_sessions WHERE scope='main' AND user_id=?").bind(uid).run();return broadcast(env,env.BOT_TOKEN,chat,s.payload);}
    if(d.startsWith('res:')){if(!(await member(env,env.BOT_TOKEN,uid)))return;return sendResource(env,env.BOT_TOKEN,uid,Number(d.slice(4)));}
    if(d.startsWith('upload_repo:')&&await isAdmin(env,uid)){const rid=Number(d.slice(11));const folders=await env.DB.prepare("SELECT id,name FROM folders ORDER BY name").all();await sessionMain(env,uid,"upload_file",String(rid));return send(env.BOT_TOKEN,chat,"📁 请选择文件夹：",inline((folders.results||[]).map(x=>[{text:"📁 "+x.name,callback_data:"upload_folder:"+x.id}])));}
    if(d.startsWith('upload_folder:')&&await isAdmin(env,uid)){const fid=Number(d.slice(13));const s=await env.DB.prepare("SELECT payload FROM clone_sessions WHERE scope='main' AND user_id=? AND step='upload_file'").bind(uid).first();if(!s)return send(env.BOT_TOKEN,chat,"❌ 上传流程已失效。");await sessionMain(env,uid,"await_file",s.payload+"|"+fid);return send(env.BOT_TOKEN,chat,"📤 请直接发送文件。发送 /cancel 取消。");}
    if(d.startsWith('folder:')){if(!(await member(env,env.BOT_TOKEN,uid)))return;const id=Number(d.split(':')[1]);const rs=await env.DB.prepare("SELECT id,filename,file_id,file_type,file_size,folder_id,created_at FROM resources WHERE status='active' AND folder_id=? ORDER BY created_at DESC LIMIT 8").bind(id).all();return send(env.BOT_TOKEN,chat,'📁 分类资源',inline([...await resourceButtons(env,rs),[{text:'🏠 返回首页',callback_data:'home'}]]));}
    return;
  }
  if(u.message) await mainHandle(env,u.message);
}
async function childUpdate(env,bot,u){
  if(u.callback_query){
    const q=u.callback_query,d=q.data||'',uid=q.from.id,chat=q.message?.chat?.id;
    await tg(bot.token,"answerCallbackQuery",{callback_query_id:q.id});
    if(d==="home")return send(bot.token,chat,"🏠 返回首页",childMenu());
    if(d.startsWith("res:")){if(!(await member(env,bot.token,uid)))return;return sendResource(env,bot.token,chat,Number(d.slice(4)));}
    if(d.startsWith("folder:")){const id=Number(d.split(":")[1]);const rs=await env.DB.prepare("SELECT id,filename,file_id,file_type,file_size,folder_id,created_at FROM resources WHERE status='active' AND folder_id=? ORDER BY created_at DESC LIMIT 8").bind(id).all();return send(bot.token,chat,"📁 分类资源",inline([...await resourceButtons(env,rs),[{text:"🏠 返回首页",callback_data:"home"}]]));}
    return;
  }
  if(u.message) await childHandle(env,bot,u.message);
}
async function registerChildWebhook(env,bot){
  const base=env.PUBLIC_BASE_URL;
  if(!base) return;
  await tg(bot.token,"setWebhook",{url:base+"/webhook/child/"+bot.id,secret_token:env.WEBHOOK_SECRET||undefined});
}
export default {async fetch(request,env){try{return await route(env,request)}catch(e){console.error("request error",e.message);return json({error:"internal"},500)}}};
