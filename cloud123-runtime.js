import fs from "node:fs";
import path from "node:path";

const PATCH_MARK = "CLOUD123_RUNTIME_V1";
const SOURCE = path.resolve("src/index.js");

function patchSource() {
  let src = fs.readFileSync(SOURCE, "utf8");
  if (src.includes(PATCH_MARK)) return false;

  const importAnchor = 'import dns from "node:dns";';
  if (!src.includes(importAnchor)) throw new Error("123云盘补丁：找不到 import 锚点");
  src = src.replace(importAnchor, importAnchor + '\nimport { createWebDavClient } from "./cloud123.js";');

  const menuFn = src.indexOf("function adminResourceMenu()");
  if (menuFn < 0) throw new Error("123云盘补丁：找不到资源管理菜单函数");
  const menuEnd = src.indexOf("function ", menuFn + 10);
  const menuBlock = src.slice(menuFn, menuEnd > 0 ? menuEnd : menuFn + 5000);
  if (!menuBlock.includes("☁️ 123云盘")) {
    const menuLines = menuBlock.split("\n");
    const insertAt = menuLines.findIndex(line => line.includes("🔄 迁移旧仓库"));
    const fallbackAt = menuLines.findIndex(line => line.includes("📦 资源仓库"));
    const at = insertAt >= 0 ? insertAt + 1 : (fallbackAt >= 0 ? fallbackAt + 1 : -1);
    if (at < 0) throw new Error("123云盘补丁：资源管理菜单结构不匹配");
    menuLines.splice(at, 0, '    ["☁️ 123云盘","🔄 云盘同步"],');
    const patchedMenuBlock = menuLines.join("\n");
    src = src.slice(0, menuFn) + patchedMenuBlock + src.slice(menuFn + menuBlock.length);
  }

  const insertAnchor = 'const repo = () => db.settings.repository;';
  if (!src.includes(insertAnchor)) throw new Error("123云盘补丁：找不到 repo 函数");
  const feature = String.raw`
/* ${PATCH_MARK} */
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
      keyboard:[
        ["🔗 配置123云盘","🧪 测试连接"],
        ["📁 同步机器人目录","🚀 扫描并上传"],
        ["⬅️ 返回管理"]
      ],
      resize_keyboard:true,
      input_field_placeholder:"123云盘"
    }
  };
}

function cloud123StatusText() {
  const c = cloud123Config();
  const uploaded = db.resources.filter(x=>x.cloud123?.uploaded).length;
  const failed = db.resources.filter(x=>x.cloud123?.error).length;
  return [
    "☁️ <b>123云盘</b>",
    "",
    "🔗 WebDAV：" + (c.url ? "✅ 已配置" : "❌ 未配置"),
    "👤 扫描/上传账号：" + (c.username ? "✅ 已配置" : "❌ 未配置"),
    "📚 已上传：" + uploaded + " 个",
    "⚠️ 失败记录：" + failed + " 个",
    "",
    "📌 当前采用：一次处理一个文件",
    "💾 文件上传完成后立即删除服务器临时文件",
    "",
    "👇 请选择操作"
  ].join("\n");
}

function cloud123RemoteName(name) {
  return String(name || "未命名").replace(/[\\/:*?"<>|]/g,"_").trim().slice(0,80) || "未命名";
}

async function cloud123SyncDirectories(uid) {
  const client = cloud123Client();
  const dirs = Array.isArray(db.directories) ? db.directories : [];
  let ok=0, fail=0;
  for (const d of dirs) {
    try {
      await client.ensureDirectory(cloud123RemoteName(d.name));
      d.cloud123Path=cloud123RemoteName(d.name);
      d.cloud123SyncedAt=Date.now();
      ok++;
    } catch(e) {
      fail++;
      console.error("123 DIR:", d.name, e.message);
    }
  }
  saveDb();
  return {ok,fail,total:dirs.length};
}

async function cloud123ScanAndUpload(uid) {
  if (cloud123Syncing) return send(TOKEN,uid,"⏳ 123云盘同步已经在进行中，请不要重复启动。",adminMenu());
  const r = repo();
  if (!r) return send(TOKEN,uid,"❌ 尚未绑定资源仓库。",adminMenu());
  cloud123Syncing=true;
  const started=Date.now();
  let statusMessage=null;
  let success=0, fail=0, skip=0;
  try {
    const client=cloud123Client();
    const clientHistory=await ensureHistoryClient(uid);
    const entity=await findHistoryEntity(clientHistory);
    const resources=[...db.resources].filter(x=>!x.cloud123?.uploaded);
    statusMessage=await sendHtml(TOKEN,uid,
      "<b>🚀 开始扫描并上传123云盘</b>\n\n"+
      "📚 待处理："+resources.length+" 个\n"+
      "📁 将按机器人现有文件夹建立目录\n"+
      "⚙️ 同时只处理 1 个文件，避免占满服务器磁盘。",
      cloud123Menu()
    );

    for(let i=0;i<resources.length;i++) {
      const item=resources[i];
      if(!item || !Number(item.messageId)) { skip++; continue; }
      if(item.cloud123?.uploaded) { skip++; continue; }
      if(item.textOnly) {
        item.cloud123={uploaded:false,skipped:true,reason:"text-only",at:Date.now()};
        skip++;
        continue;
      }

      const d=db.directories.find(x=>String(x.id)===String(item.directoryId));
      const remoteDir=cloud123RemoteName(d?.name || "未分类");
      const found=await clientHistory.getMessages(entity,{ids:[Number(item.messageId)]});
      const message=Array.isArray(found)?found[0]:found;
      if(!message || !message.media) {
        item.cloud123={uploaded:false,error:"Telegram 历史消息/媒体不存在",at:Date.now()};
        fail++;
        continue;
      }

      const originalName=cloud123RemoteName(message.file?.name || item.title || ("resource-"+item.messageId));
      const tempDir=path.join("/tmp","cloud123-upload");
      fs.mkdirSync(tempDir,{recursive:true});
      const tempPath=path.join(tempDir,String(item.messageId)+"-"+crypto.randomUUID()+"-"+originalName);
      try {
        await clientHistory.downloadMedia(message,{outputFile:tempPath});
        const stat=await fs.promises.stat(tempPath);
        await client.uploadFile(tempPath,remoteDir,originalName);
        item.cloud123={
          uploaded:true,
          path:remoteDir+"/"+originalName,
          size:stat.size,
          uploadedAt:Date.now()
        };
        success++;
      } catch(e) {
        item.cloud123={uploaded:false,error:String(e.message||e).slice(0,500),at:Date.now()};
        fail++;
        console.error("123 UPLOAD:", item.title, e);
      } finally {
        try { await fs.promises.rm(tempPath,{force:true}); } catch {}
      }

      if((i+1)%5===0 || i===resources.length-1) {
        saveDb();
        if(statusMessage?.message_id) {
          try {
            await tg(TOKEN,"editMessageText",{
              chat_id:uid,
              message_id:statusMessage.message_id,
              text:"🚀 <b>123云盘同步中</b>\n\n"+
                "📊 进度："+(i+1)+" / "+resources.length+"\n"+
                "✅ 成功："+success+"\n"+
                "⚠️ 失败："+fail+"\n"+
                "⏭️ 跳过："+skip+"\n\n"+
                "📁 按机器人目录同步\n💾 每次只处理一个文件。",
              parse_mode:"HTML"
            });
          } catch {}
        }
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
    if(statusMessage?.message_id) {
      try { await tg(TOKEN,"editMessageText",{
        chat_id:uid,
        message_id:statusMessage.message_id,
        text:"❌ <b>123云盘同步中断</b>\n\n"+escapeHtml(e.message||String(e))+"\n\n"+
          "已完成的文件会保留上传记录，下次可以继续。",
        parse_mode:"HTML",
        reply_markup:cloud123Menu().reply_markup
      }); } catch {}
    } else {
      await send(TOKEN,uid,"❌ 123云盘同步失败：\n"+String(e.message||e),adminMenu());
    }
  } finally {
    cloud123Syncing=false;
  }
}
`;
  src = src.replace(insertAnchor, insertAnchor + "\n" + feature);

  const stateAnchor = '  if(t==="/start" || t==="🏠 开始") return sendHtml';
  if(!src.includes(stateAnchor)) throw new Error("123云盘补丁：找不到状态处理锚点");
  const stateCode = String.raw`
  if(admin && cloud123State.has(String(uid))) {
    const cs=cloud123State.get(String(uid));
    if(t==="/cancel") {
      cloud123State.delete(String(uid));
      return send(TOKEN,uid,"❌ 已取消123云盘配置。",adminMenu());
    }
    if(cs.step==="url") {
      if(!/^https?:\\/\\//i.test(t.trim())) return send(TOKEN,uid,"⚠️ WebDAV 地址格式不正确，请以 http:// 或 https:// 开头。");
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

`;
  src = src.replace(stateAnchor, stateCode + stateAnchor);

  const handlerAnchor = '  if(t==="📦 资源管理"&&admin)';
  if(!src.includes(handlerAnchor)) throw new Error("123云盘补丁：找不到管理处理锚点");
  const handlers = String.raw`
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
      await client.test();
      return sendHtml(TOKEN,uid,
        "<b>✅ 123云盘连接正常</b>\n\n"+
        "WebDAV 已可以访问。\n\n"+
        "下一步可以先点击「📁 同步机器人目录」。",
        cloud123Menu()
      );
    } catch(e) {
      return send(TOKEN,uid,"❌ 123云盘连接失败：\n\n"+String(e.message||e),cloud123Menu());
    }
  }
  if(t==="📁 同步机器人目录"&&admin) {
    try {
      const result=await cloud123SyncDirectories(uid);
      return send(TOKEN,uid,
        "📁 <b>目录同步完成</b>\n\n"+
        "📚 机器人目录："+result.total+" 个\n"+
        "✅ 已同步："+result.ok+" 个\n"+
        "⚠️ 失败："+result.fail+" 个\n\n"+
        "如果失败，请检查123云盘 WebDAV 是否允许创建目录。",
        {parse_mode:"HTML",...cloud123Menu()}
      );
    } catch(e) {
      return send(TOKEN,uid,"❌ 目录同步失败：\n\n"+String(e.message||e),cloud123Menu());
    }
  }
  if(t==="🚀 扫描并上传"&&admin) {
    return cloud123ScanAndUpload(uid);
  }
  if(t==="🔄 云盘同步"&&admin) {
    return sendHtml(TOKEN,uid,cloud123StatusText(),cloud123Menu());
  }

`;
  src = src.replace(handlerAnchor, handlers + handlerAnchor);

  fs.writeFileSync(SOURCE, src);
  return true;
}

try {
  const changed=patchSource();
  console.log(changed ? "☁️ CLOUD123 PATCH APPLIED" : "☁️ CLOUD123 PATCH ALREADY PRESENT");
} catch (e) {
  console.error("❌ CLOUD123 PATCH FAILED:",e.message);
  process.exitCode=1;
}
