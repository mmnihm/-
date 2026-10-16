import fs from "node:fs";
import path from "node:path";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("请设置 BOT_TOKEN 环境变量");
const apiUrl = "https://api.telegram.org/bot" + token + "/";
const dir = path.resolve(process.env.DATA_DIR || "./data");
const file = path.join(dir, "support-data.json");
fs.mkdirSync(dir, {recursive:true});
let db = {adminId: process.env.ADMIN_ID || "", users:{}, replies:{}, agents:{}, blacklist:{}, sessions:{}};
if (fs.existsSync(file)) db = {...db, ...JSON.parse(fs.readFileSync(file,"utf8"))};
function save(){ const tmp=file+".tmp"; fs.writeFileSync(tmp,JSON.stringify(db,null,2)); fs.renameSync(tmp,file); }
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function call(method, body={}) {
  const res=await fetch(apiUrl+method,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const data=await res.json();
  if(!data.ok){const e=new Error(data.description||"Telegram API error");e.retryAfter=data.parameters?.retry_after||0;throw e;}
  return data.result;
}
const send=(id,text,extra={})=>call("sendMessage",{chat_id:id,text,...extra});
const admin=id=>String(id)===String(db.adminId)||Boolean(db.agents[String(id)]);
const userName=u=>[u.first_name,u.last_name].filter(Boolean).join(" ")+" (@"+(u.username||"无用户名")+") ID:"+u.id;
async function copyTo(from,to,msgId){return call("copyMessage",{chat_id:to,from_chat_id:from,message_id:msgId});}
async function broadcast(msg){
  const adminId=String(msg.chat.id), ids=Object.keys(db.users).filter(id=>!db.blacklist[id]);
  await send(adminId,"📣 开始广播，共 "+ids.length+" 位用户。");
  let ok=0,fail=0;
  for(const id of ids){
    try{await copyTo(adminId,id,msg.message_id);ok++;}
    catch(e){fail++; if(e.retryAfter) await wait((e.retryAfter+1)*1000); else await wait(50);}
    if((ok+fail)%25===0) await wait(1000);
  }
  await send(adminId,"✅ 广播结束\n成功："+ok+"\n失败："+fail);
}
async function onMessage(m){
  if(!m.chat||m.chat.type!=="private") return;
  const id=String(m.chat.id), u=m.from;
  if(!u) return;
  db.users[id]={id,username:u.username||"",first_name:u.first_name||"",last_name:u.last_name||"",lastSeen:Date.now()};
  db.sessions[id] ||= {status:"open",createdAt:Date.now()};
  save();
  if(!db.adminId){
    if(m.text?.startsWith("/start")){
      db.adminId=id;save();
      await send(id,"✅ 你已成为管理员。请务必由你本人第一个启动机器人。\n\n/broadcast - 广播，随后发送要广播的消息\n/users - 用户统计\n/agents - 客服名单\n/addagent 用户ID - 添加客服\n/delagent 用户ID - 移除客服\n/blacklist 用户ID - 拉黑\n/unblacklist 用户ID - 解除拉黑\n/end 用户ID - 结束会话\n/open 用户ID - 重开会话");
    }
    return;
  }
  if(id===String(db.adminId)){
    if(m.text==="/start"){await send(id,"客服管理菜单：/broadcast /users /agents /addagent 用户ID /delagent 用户ID /blacklist 用户ID /unblacklist 用户ID /end 用户ID /open 用户ID");return;}
    if(m.text?.startsWith("/broadcast")){
      db.broadcastPending=true;save();
      await send(id,"请发送下一条要广播的消息（文字、图片、视频、文件等均可），发送 /cancel 取消。");return;
    }
    if(db.broadcastPending){
      if(m.text==="/cancel"){db.broadcastPending=false;save();await send(id,"已取消广播。");return;}
      db.broadcastPending=false;save();await broadcast(m);return;
    }
    if(m.text==="/users"){await send(id,"登记用户："+Object.keys(db.users).length+"\n客服："+Object.keys(db.agents).length+"\n开放会话："+Object.values(db.sessions).filter(s=>s.status==="open").length);return;}
    if(m.text==="/agents"){await send(id,Object.keys(db.agents).join("\n")||"暂无额外客服");return;}
    const cmd=m.text?.match(/^\/(addagent|delagent|blacklist|unblacklist|end|open)\s+(\d+)/);
    if(cmd){
      const action=cmd[1], target=cmd[2];
      if(action==="addagent")db.agents[target]={addedAt:Date.now()};
      if(action==="delagent")delete db.agents[target];
      if(action==="blacklist")db.blacklist[target]=true;
      if(action==="unblacklist")delete db.blacklist[target];
      if(action==="end"||action==="open"){db.sessions[target] ||= {};db.sessions[target].status=action==="end"?"closed":"open";}
      save();await send(id,"已执行 /"+action+" "+target);return;
    }
    if(m.reply_to_message){
      const target=db.replies[String(m.reply_to_message.message_id)];
      if(target){try{await copyTo(id,target,m.message_id);await send(id,"✅ 已回复用户 "+target);}catch(e){await send(id,"❌ 回复失败："+e.message);}return;}
    }
  }
  if(db.blacklist[id]){await send(id,"当前无法使用客服服务。");return;}
  if(m.text==="/start"){await send(id,"你好，这里是客服中心，请直接发送问题，客服收到后会回复。");return;}
  if(db.sessions[id]?.status==="closed"){db.sessions[id].status="open";save();}
  const destination=process.env.SUPPORT_GROUP_ID||db.adminId;
  try{
    const copied=await copyTo(id,destination,m.message_id);
    db.replies[String(copied.message_id)]=id;save();
    await send(destination,"📩 客服新消息\n用户："+userName(u)+"\n直接回复上方转来的消息即可回复用户。");
  }catch(e){console.error("客服消息转发失败：",e.message);try{await send(id,"暂时无法联系到客服，请稍后再试。");}catch{}}
}
let offset=0;
async function loop(){
  while(true){
    try{
      const updates=await call("getUpdates",{offset,timeout:25,allowed_updates:["message"]});
      for(const up of updates){offset=up.update_id+1;if(up.message){try{await onMessage(up.message);}catch(e){console.error("消息处理失败：",e.message);}}}
    }catch(e){console.error("轮询异常：",e.message);await wait(e.retryAfter?(e.retryAfter+1)*1000:2500);}
  }
}
process.on("SIGTERM",()=>{try{save();}finally{process.exit(0);}});
process.on("SIGINT",()=>{try{save();}finally{process.exit(0);}});
console.log("客服机器人启动，数据文件："+file);
loop();
