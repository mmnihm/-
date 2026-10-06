import fs from "node:fs";
import path from "node:path";

const PATCH_MARK = "CLOUD123_RUNTIME_V1";
const SOURCE = path.resolve("src/index.js");

function patchSource() {
  const PROGRESS_PATCH_MARK = "CLOUD123_PROGRESS_V1";
  let src = fs.readFileSync(SOURCE, "utf8");
  if (src.includes(PATCH_MARK) && !src.includes(PROGRESS_PATCH_MARK)) {
    const progressHelper = String.raw`
    const uploadProgress = new Map();
    let lastProgressEdit = 0;
    let progressEditing = false;
    const refreshUploadProgress = async () => {
      if (!statusMessage?.message_id || progressEditing) return;
      const now = Date.now();
      if (now - lastProgressEdit < 1000) return;
      lastProgressEdit = now;
      progressEditing = true;
      try {
        let sentBytes=0,totalBytes=0;
        for (const p of uploadProgress.values()) { sentBytes += p.sent; totalBytes += p.total; }
        const mb=n => (n/1024/1024).toFixed(1);
        await tg(TOKEN,"editMessageText",{
          chat_id:uid,message_id:statusMessage.message_id,
          text:"🚀 <b>123云盘实时上传</b>\\n\\n"+
            "📁 当前文件："+escapeHtml(currentFileName || "准备中")+"\\n"+
            "📊 成功："+success+"  | 失败："+fail+"  | 跳过："+skip+"\\n"+
            "📤 当前传输："+mb(sentBytes)+" / "+mb(totalBytes)+" MB\\n"+
            "⚡ 小文件最多 5 个并发\\n📦 单批总量 ≤ 1GB",
          parse_mode:"HTML",reply_markup:cloud123Menu().reply_markup
        });
      } catch {} finally { progressEditing=false; }
    };
`;
    // 兼容不同版本的云盘上传源码：优先寻找 uploadOne，找不到时就在扫描函数内部注入进度 helper。
    const uploadOneMatch = src.match(/^\s*const\s+uploadOne\s*=\s*async\s*\(\s*item\s*\)\s*=>\s*\{/m);
    const scanMatch = src.match(/^\s*async\s+function\s+cloud123ScanAndUpload\s*\(\s*uid\s*\)\s*\{/m);
    const helperAnchor = uploadOneMatch || scanMatch;
    if (!helperAnchor) throw new Error("123云盘进度补丁：找不到云盘上传函数");
    // 进度 helper 必须位于 uploadOne 外层；放在函数声明后会导致 uploadOne 内部/并发场景出现“refreshUploadProgress 未定义”。\n    src = src.replace(helperAnchor[0], progressHelper + "\\n" + helperAnchor[0]);

    // 上传回调可能已经由旧版本补丁加入；只在当前源码仍是无回调的原始上传调用时替换。
    const uploadPattern = /(await\s+client\.uploadFile\(\s*tempPath\s*,\s*remoteDir\s*,\s*originalName\s*\);)/;
    if (uploadPattern.test(src)) {
      const uploadReplacement = `uploadProgress.set(String(item.messageId),{sent:0,total:stat.size,name:originalName});
        await client.uploadFile(tempPath,remoteDir,originalName,(sent,total)=>{
          uploadProgress.set(String(item.messageId),{sent,total,name:originalName});
          if (typeof refreshUploadProgress === "function") refreshUploadProgress();
        });
        uploadProgress.delete(String(item.messageId));
        if (typeof refreshUploadProgress === "function") await refreshUploadProgress();`;
      src = src.replace(uploadPattern, uploadReplacement);
    }
    src = src.replace('"⚡ 小文件最多 5 个并发；单批总传输不超过 1GB。",', '"⚡ 小文件最多 5 个并发；大文件单个上传。",');
    src = src.replace('"⚙️ 同时只处理 1 个文件，避免占满服务器磁盘。",', '"⚡ ≤200MB：5 个并发；>200MB：单个上传。",');
    src = src.replace("/* " + PATCH_MARK + " */", "/* " + PATCH_MARK + " */\\nconst " + PROGRESS_PATCH_MARK + "=true;");
    fs.writeFileSync(SOURCE, src);
    console.log("📊 CLOUD123 实时上传进度补丁已贴");
    return true;
  }
  // 修复旧版本：如果 helper 被错误插进 uploadOne 内部，则整体移动到 uploadOne 外层。\n  if (src.includes(PATCH_MARK) && src.includes("const refreshUploadProgress = async")) {\n    const helperPos = src.indexOf("    const refreshUploadProgress = async");\n    const uploadPos = src.indexOf("    const uploadOne = async (item) => {");\n    if (helperPos > uploadPos && uploadPos >= 0) {\n      const helperEnd = src.indexOf("    };", helperPos);\n      if (helperEnd >= 0) {\n        const helperBlock = src.slice(helperPos - ("    const uploadProgress = new Map();").length, helperEnd + 7);\n        src = src.slice(0, helperPos - ("    const uploadProgress = new Map();").length) + src.slice(helperEnd + 7);\n        const newUploadPos = src.indexOf("    const uploadOne = async (item) => {");\n        src = src.slice(0,newUploadPos) + helperBlock + "\\n" + src.slice(newUploadPos);\n        fs.writeFileSync(SOURCE, src);\n        console.log("🛠️ CLOUD123 已将实时进度 helper 移到 uploadOne 外层");\n        return true;\n      }\n    }\n  }\n\n  // 最终兜底：无论历史补丁把 helper 放在哪个作用域，uploadOne 都必须拥有自己的进度 Map。
  // 这样不会因为运行时补丁作用域异常而中断123云盘上传。
  if (src.includes(PATCH_MARK) && src.includes("const uploadOne = async (item) => {") && !src.includes("CLOUD123_UPLOAD_PROGRESS_SCOPE_FIX")) {
    const uploadOneAnchor = "    const uploadOne = async (item) => {";
    const localProgress = [
      "      /* CLOUD123_UPLOAD_PROGRESS_SCOPE_FIX */",
      "      const uploadProgress = globalThis.__CLOUD123_UPLOAD_PROGRESS || (globalThis.__CLOUD123_UPLOAD_PROGRESS = new Map());"
    ].join("\\n");
    if (src.includes(uploadOneAnchor)) {
      src = src.replace(uploadOneAnchor, uploadOneAnchor + "\\n" + localProgress);
      fs.writeFileSync(SOURCE, src);
      console.log("🛠️ CLOUD123 已修复 uploadOne 进度变量作用域");
      return true;
    }
  }

  // 修复历史版本中“上传代码保留，但进度辅助函数丢失”的情况。
  // 即使 CLOUD123_PROGRESS_V1 标记存在，也要以实际源码是否存在 helper 为准。
  if (src.includes(PATCH_MARK) && src.includes("refreshUploadProgress()") && !src.includes("const refreshUploadProgress = async")) {
    const progressHelper = [
      "    const uploadProgress = new Map();",
      "    let lastProgressEdit = 0;",
      "    let progressEditing = false;",
      "    const refreshUploadProgress = async () => {",
      "      if (!statusMessage?.message_id || progressEditing) return;",
      "      const now = Date.now();",
      "      if (now - lastProgressEdit < 1000) return;",
      "      lastProgressEdit = now;",
      "      progressEditing = true;",
      "      try {",
      "        let sentBytes=0,totalBytes=0;",
      "        for (const p of uploadProgress.values()) { sentBytes += Number(p.sent||0); totalBytes += Number(p.total||0); }",
      "        const mb=n => (n/1024/1024).toFixed(1);",
      "        await tg(TOKEN,\"editMessageText\",{",
      "          chat_id:uid,message_id:statusMessage.message_id,",
      "          text:\"🚀 <b>123云盘实时上传</b>\\n\\n\"+",
      "            \"📁 当前文件：\"+escapeHtml(currentFileName || \"准备中\")+\\n\"+",
      "            \"📊 成功：\"+success+\"  | 失败：\"+fail+\"  | 跳过：\"+skip+\\n\"+",
      "            \"📤 当前传输：\"+mb(sentBytes)+\" / \"+mb(totalBytes)+\" MB\\n\"+",
      "            \"⚡ 小文件最多 5 个并发\\n📦 单批总量 ≤ 1GB\",",
      "          parse_mode:\"HTML\",reply_markup:cloud123Menu().reply_markup",
      "        });",
      "      } catch {} finally { progressEditing=false; }",
      "    };",
    ].join("\\n");
    const uploadAnchor = "    const uploadOne = async (item) => {";
    if (!src.includes(uploadAnchor)) throw new Error("123云盘进度修复：找不到 uploadOne 插入点");
    src = src.replace(uploadAnchor, progressHelper + "\\n" + uploadAnchor);
    console.log("🛠️ CLOUD123 已恢复实时上传进度 helper");
    fs.writeFileSync(SOURCE, src);
    return true;
  }

  if (src.includes("正在连接 Telegram 扫描账号，请稍候")) {
    console.log("CLOUD123 检测到旧的静态提示，准备重新打补丁");
  }
  if (src.includes(PATCH_MARK)) {
    const repairedSrc = src.replace(
      /^\s*if\(!\/\^https\?:.*$/m,
      '    if(!/^https?:\/\//i.test(t.trim())) return send(TOKEN,uid,"⚠️ WebDAV 地址格式不正确，请以 http:// 或 https:// 开头。");'
    );
    if (repairedSrc !== src) {
      fs.writeFileSync(SOURCE, repairedSrc);
      console.log("🛠️ CLOUD123 已修复 WebDAV 地址正则");
      return true;
    }
    return false;
  }

  const importAnchor = 'import dns from "node:dns";';
  if (!src.includes(importAnchor)) throw new Error("123云盘补丁：找不到 import 锚点");
  src = src.replace(importAnchor, importAnchor + '\nimport { createWebDavClient } from "./cloud123.js";');

  if (!src.includes("☁️ 123云盘")) {
    const menuFn = src.indexOf("function adminResourceInline()");
    if (menuFn < 0) throw new Error("123云盘补丁：找不到资源管理菜单函数");
    const menuEnd = src.indexOf("function ", menuFn + 10);
    const menuBlock = src.slice(menuFn, menuEnd > 0 ? menuEnd : menuFn + 5000);
    const menuLines = menuBlock.split("\n");
    const insertAt = menuLines.findIndex(line => line.includes("adm:auto"));
    const fallbackAt = menuLines.findIndex(line => line.includes("adm:scan"));
    const at = insertAt >= 0 ? insertAt : (fallbackAt >= 0 ? fallbackAt + 1 : -1);
    if (at < 0) throw new Error("123云盘补丁：资源管理菜单结构不匹配");
    menuLines.splice(at, 0, ' [{text:"☁️ 123云盘",callback_data:"adm:cloud123"},{text:"🔄 云盘同步",callback_data:"adm:cloud123"}],');
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
      inline_keyboard:[
        [{text:"🔗 配置123云盘",callback_data:"adm:cloud_setup"},{text:"🧪 测试连接",callback_data:"adm:cloud_test"}],
        [{text:"📁 同步机器人目录",callback_data:"adm:cloud_sync"},{text:"🚀 扫描并上传",callback_data:"adm:cloud_scan"}],
        [{text:"🔐 授权账号",callback_data:"adm:cloud_account"},{text:"⬅️ 返回管理",callback_data:"admin:resource"}]
      ]
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
    "👤 Telegram 扫描仓库账号：" + ((db.settings.historyAuth||{}).session ? "✅ 已授权" : "❌ 未授权"),
    "📚 已上传：" + uploaded + " 个",
    "⚠️ 失败记录：" + failed + " 个",
    "",
    "📌 当前：小文件最多 5 个并发，单批总传输 ≤1GB",
    "💾 每个文件完成后立即删除服务器临时文件",
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

async function cloud123ScanAndUpload(uid) {
  if (cloud123Syncing) return send(TOKEN,uid,"⏳ 123云盘同步已经在进行中，请不要重复启动。",adminMenu());
  const r = repo();
  if (!r) return send(TOKEN,uid,"❌ 尚未绑定资源仓库。",adminMenu());
  cloud123Syncing=true;
  const started=Date.now();
  let statusMessage=null;
  let success=0, fail=0, skip=0;
  let activeBatchBytes=0, totalUploadedBytes=0;
  let currentFileName="";
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
    const render=()=>"<b>🚀 123云盘扫描上传</b>\n━━━━━━━━━━━━━━\n"+
      "⏱ 已运行：<b>"+Math.floor((Date.now()-started)/1000)+"</b> 秒\n"+
      "📍 当前：<b>"+phase+"</b>\n"+
      "✅ 成功："+success+"  ⚠️ 失败："+fail+"  ⏭️ 跳过："+skip+"\n"+
      (currentFileName?"📄 当前文件："+escapeHtml(currentFileName)+"\n":"")+
      "📁 按现有文件夹建立目录\n"+
      "📦 每批最多 1GB";
    statusMessage=await sendHtml(TOKEN,uid, render(), cloud123Menu());
    tick=setInterval(()=>{
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
    const resources=[...db.resources].filter(x=>!x.cloud123?.uploaded);
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
    const SMALL_CONCURRENCY = 5;
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
        item.cloud123={uploaded:false,error:"Telegram 历史消息/媒体不存在",at:Date.now()};
        fail++;
        return 0;
      }

      const originalName=cloud123RemoteName(message.file?.name || item.title || ("resource-"+item.messageId));
      const tempDir=path.join("/tmp","cloud123-upload");
      fs.mkdirSync(tempDir,{recursive:true});
      const tempPath=path.join(tempDir,String(item.messageId)+"-"+crypto.randomUUID()+"-"+originalName);
      try {
        await clientHistory.downloadMedia(message,{outputFile:tempPath});
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
          uploadedAt:Date.now()
        };
        success++;
        totalUploadedBytes += stat.size;
        return stat.size;
      } catch(e) {
        uploadProgress.delete(String(item.messageId));
        item.cloud123={uploaded:false,error:String(e.message||e).slice(0,500),at:Date.now()};
        fail++;
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

        if(batch.length===0) {
          batch.push(item);
          plannedBytes=estimatedSize>0 ? estimatedSize : BATCH_LIMIT;
          i++;
          continue;
        }

        if(estimatedSize>0 && plannedBytes+estimatedSize<=BATCH_LIMIT) {
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
    if(tick) clearInterval(tick);
    cloud123Syncing=false;
  }
}
`;
  src = src.replace(insertAnchor, insertAnchor + "\n" + feature);

  const stateAnchors = [
    '  if(t==="/start" || t==="🏠 开始" || t==="开始使用" || t==="🏠 开始使用") {',
    '  if(t==="/start" || t==="🏠 开始" || t==="开始使用") {',
    '  if(t==="/start" || t==="🏠 开始") {'
  ];
  const stateAnchor = stateAnchors.find(a => src.includes(a));
  if(!stateAnchor) throw new Error("123云盘补丁：找不到状态处理锚点（当前首页入口已变化）");
  const stateCode = String.raw`
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
      return client.test().then(() => sendHtml(TOKEN,uid,
        "<b>✅ 123云盘连接正常</b>\n\n"+
        "WebDAV 已可以访问。\n\n"+
        "下一步可以先点击「📁 同步机器人目录」。",
        cloud123Menu()
      ));
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
  console.error("⚠️ CLOUD123 PATCH 跳过，机器人继续启动：",e.message);
  // 123云盘进度补丁失败不应阻止主机器人启动
  process.exitCode=0;
}
