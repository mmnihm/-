import fs from "node:fs";

const sourceFile = new URL("./src/index.js", import.meta.url);
const snippetFile = new URL("./repository-migration.snippet", import.meta.url);
let s = fs.readFileSync(sourceFile, "utf8");
const snippet = fs.readFileSync(snippetFile, "utf8").trim();

if (!s.includes("BACKGROUND_REPOSITORY_SYNC_V2")) {
  const marker = 'const repo = () => db.settings.repository;';
  if (!s.includes(marker)) throw new Error("找不到 repo() 插入点");
  s = s.replace(marker, marker + "\n\n" + snippet);

  s = s.replace(
    '["📦 资源仓库","🔍 仓库扫描"],',
    '["🔗 绑定新仓库","🔄 迁移旧仓库"],'
  );

  const oldForward = /  if\(msg\.chat\?\.type==="private" && msg\.forward_origin\?\.chat\) \{[\s\S]*?    saveDb\(\);\n/;
  const newForward = '  if(msg.chat?.type==="private" && msg.forward_origin?.chat) { const fc=msg.forward_origin.chat; const previous=db.settings.repository ? {...db.settings.repository} : null; const next={chatId:String(fc.id),title:fc.title||fc.username||String(fc.id),username:fc.username||"",type:fc.type||"channel"}; if(previous && repositoryKey(previous)!==repositoryKey(next)) rememberRepository(previous); db.settings.repository=next; rememberRepository(next); saveDb();\n';
  if (!oldForward.test(s)) throw new Error("找不到仓库转发绑定代码");
  s = s.replace(oldForward, newForward);

  const oldInfo = /  if\(t==="📦 绑定资源仓库" && admin\)[\s\S]*?  if\(t==="🤖 克隆机器人"\) \{\n/;
  const newInfo = '  if(t==="📦 绑定资源仓库" && admin) return send(TOKEN,uid,"📦 资源仓库管理 | 支持群 / 超级群 / 频道。 | 点击「🔗 绑定新仓库」后转发新仓库消息，再点击「🔄 迁移旧仓库」。");\n  if(t==="🔗 绑定新仓库" && admin) return send(TOKEN,uid,"🔗 <b>绑定新仓库</b> | 支持群、超级群、频道。 | 把主机器人加入新仓库，再转发任意一条消息给机器人。机器人会保留上一个仓库作为旧仓库。",{parse_mode:"HTML",...backMenu(true)});\n  if(t==="🔄 迁移旧仓库" && admin) return migrateRepositoryResources(uid);\n\n  if(t==="🤖 克隆机器人") {\n';
  if (!oldInfo.test(s)) throw new Error("找不到资源仓库入口");
  s = s.replace(oldInfo, newInfo);

  s = s.replace(
    '  if(msg.chat?.type!=="private") { indexResource(msg); return; }',
    '  if(msg.chat?.type!=="private") { indexResource(msg); syncRepositoryMessage(msg).catch(e=>console.error("BACKGROUND GROUP SYNC:",e.message)); return; }'
  );

  s = s.replace(
    '          indexResource(u.channel_post);\n        }',
    '          indexResource(u.channel_post); syncRepositoryMessage(u.channel_post).catch(e=>console.error("BACKGROUND CHANNEL SYNC:",e.message));\n        }'
  );

  s = s.replace(
    '          indexResource(u.edited_channel_post);\n        }',
    '          indexResource(u.edited_channel_post); syncRepositoryMessage(u.edited_channel_post).catch(e=>console.error("BACKGROUND EDITED CHANNEL SYNC:",e.message));\n        }'
  );

  s = s.replace(
    'function directoryItems(id) { return db.resources.filter(r=>String(r.directoryId)===String(id)).sort((a,b)=>Number(a.messageId)-Number(b.messageId)); }',
    'function directoryItems(id) { return db.resources.filter(r=>!r.unavailable && String(r.directoryId)===String(id)).sort((a,b)=>Number(a.messageId)-Number(b.messageId)); }'
  );

  s = s.replace(
    '  return db.resources.filter(x=>(String(x.title||"")+" "+String(x.caption||"")+" "+String(x.directoryId||"")).toLowerCase().includes(q));',
    '  return db.resources.filter(x=>!x.unavailable && (String(x.title||"")+" "+String(x.caption||"")+" "+String(x.directoryId||"")).toLowerCase().includes(q));'
  );

  s = s.replace('  const arr=[...db.resources];', '  const arr=db.resources.filter(x=>!x.unavailable);');
  s = s.replaceAll('db.resources.slice(0,10)', 'db.resources.filter(x=>!x.unavailable).slice(0,10)');

  s = s.replace(
    'boot().catch(e=>console.error("❌ FATAL BOOT:",e));',
    'setInterval(()=>{ syncOldRepositoryRecent().catch(e=>console.error("BACKGROUND REPOSITORY LOOP:",e.message)); },5*60*1000); console.log("🔄 BACKGROUND REPOSITORY SYNC ENABLED"); boot().catch(e=>console.error("❌ FATAL BOOT:",e));'
  );

  fs.writeFileSync(sourceFile, s);
  console.log("✅ Repository migration patch applied");
} else {
  console.log("ℹ️ Repository migration patch already present");
}
