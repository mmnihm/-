import fs from "node:fs";

const file = new URL("./src/index.js", import.meta.url);
let s = fs.readFileSync(file, "utf8");

if (!s.includes("BACKGROUND_REPOSITORY_SYNC_V2")) {
  const marker = 'const repo = () => db.settings.repository;';

  const repoCode = marker + `

// BACKGROUND_REPOSITORY_SYNC_V2
function repositoryKey(r) {
  return r ? String(r.chatId || r.id || "") : "";
}

function rememberRepository(r) {
  if (!r || !r.chatId) return;
  if (!db.settings.repositoryHistory) db.settings.repositoryHistory = [];
  const key = repositoryKey(r);
  const old = db.settings.repositoryHistory.find(x => repositoryKey(x) === key);
  if (old) Object.assign(old, {...r, lastSeenAt: Date.now()});
  else db.settings.repositoryHistory.unshift({...r, lastSeenAt: Date.now()});
  db.settings.repositoryHistory = db.settings.repositoryHistory.slice(0, 20);
  saveDb();
}

function migrationSource() {
  const current = repo();
  const list = Array.isArray(db.settings.repositoryHistory) ? db.settings.repositoryHistory : [];
  return list.find(x => repositoryKey(x) && repositoryKey(x) !== repositoryKey(current)) || null;
}

const repositorySyncing = new Set();

async function syncRepositoryMessage(message) {
  const current = repo();
  const source = migrationSource();
  if (!current || !source || repositoryKey(current) === repositoryKey(source)) return false;

  const sourceId = String(message?.chat?.id ?? message?.chatId ?? "");
  const messageId = Number(message?.message_id ?? message?.id ?? 0);
  if (!sourceId || sourceId !== String(source.chatId) || !messageId) return false;

  const key = sourceId + ":" + messageId;
  if (repositorySyncing.has(key)) return false;

  if (db.resources.some(x =>
    !x.unavailable &&
    String(x.chatId) === String(current.chatId) &&
    Number(x.migratedFrom?.messageId) === messageId &&
    String(x.migratedFrom?.chatId) === sourceId
  )) return true;

  repositorySyncing.add(key);
  try {
    const copied = await tg(TOKEN, "copyMessage", {
      chat_id: current.chatId,
      from_chat_id: source.chatId,
      message_id: messageId
    });
    const newId = Number(copied?.message_id ?? copied);
    if (!Number.isFinite(newId)) throw new Error("复制结果无效");

    const oldItem = db.resources.find(x =>
      String(x.chatId) === sourceId && Number(x.messageId) === messageId
    );

    const resource = {
      ...(oldItem || {}),
      chatId: String(current.chatId),
      messageId: newId,
      repositoryId: repositoryKey(current),
      migratedFrom: {chatId: sourceId, messageId},
      migratedAt: Date.now(),
      unavailable: false,
      fileId: null,
      directoryId: oldItem?.directoryId ?? null
    };

    const existing = db.resources.findIndex(x =>
      String(x.chatId) === String(current.chatId) &&
      Number(x.messageId) === newId
    );

    if (existing >= 0) db.resources[existing] = {...db.resources[existing], ...resource};
    else db.resources.unshift(resource);

    if (oldItem) oldItem.unavailable = true;
    db.resources = db.resources.slice(0, MAX_RESOURCES);
    saveDb();

    console.log("🔄 BACKGROUND REPOSITORY SYNC:", sourceId, messageId, "->", String(current.chatId), newId);
    return true;
  } catch (e) {
    console.error("❌ BACKGROUND REPOSITORY SYNC:", e.message, "source=", sourceId, "message=", messageId);
    return false;
  } finally {
    repositorySyncing.delete(key);
  }
}

async function migrateRepositoryResources(uid) {
  const target = repo();
  const source = migrationSource();

  if (!target) return send(TOKEN, uid, "❌ 当前还没有绑定新资源仓库。");
  if (!source) return send(TOKEN, uid, "⚠️ 没有找到旧资源仓库。请先绑定新仓库，让机器人自动保留上一个仓库。");
  if (repositoryKey(target) === repositoryKey(source)) return send(TOKEN, uid, "⚠️ 新旧仓库不能是同一个群/频道。");

  const resources = db.resources
    .filter(x => !x.unavailable && String(x.chatId) === String(source.chatId) && Number(x.messageId) > 0)
    .sort((a,b) => Number(a.messageId) - Number(b.messageId));

  if (!resources.length) {
    return send(TOKEN, uid, "📭 旧仓库暂时没有可迁移的已索引资源。\\n\\n如果旧仓库还有历史资源，请先执行「🔍 仓库扫描」。");
  }

  if (!db.settings.repositoryMigration) {
    db.settings.repositoryMigration = {status:"idle",source:null,target:null,total:0,migrated:0,failed:0,startedAt:null,finishedAt:null,error:""};
  }

  const startedAt = Date.now();
  db.settings.repositoryMigration = {
    status:"running",
    source:{...source},
    target:{...target},
    total:resources.length,
    migrated:0,
    failed:0,
    startedAt,
    finishedAt:null,
    error:""
  };
  saveDb();

  let migrated = 0;
  let failed = 0;

  for (const item of resources) {
    try {
      const copied = await tg(TOKEN, "copyMessage", {
        chat_id: target.chatId,
        from_chat_id: source.chatId,
        message_id: Number(item.messageId)
      });
      const newId = Number(copied?.message_id ?? copied);
      if (!Number.isFinite(newId)) throw new Error("新消息ID无效");

      const clone = {
        ...item,
        chatId: String(target.chatId),
        messageId: newId,
        repositoryId: repositoryKey(target),
        migratedFrom: {chatId:String(source.chatId), messageId:Number(item.messageId)},
        migratedAt: Date.now(),
        unavailable: false,
        fileId: null,
        directoryId: item.directoryId ?? null
      };

      db.resources.unshift(clone);
      item.unavailable = true;
      migrated++;

      if (migrated % 20 === 0) {
        db.settings.repositoryMigration.migrated = migrated;
        db.settings.repositoryMigration.failed = failed;
        saveDb();
      }
    } catch (e) {
      failed++;
      console.error("❌ REPOSITORY MIGRATION:", e.message, "message=", item.messageId);
    }
    await sleep(80);
  }

  db.resources = db.resources.slice(0, MAX_RESOURCES);
  db.settings.repositoryMigration = {
    status: failed ? "completed_with_errors" : "completed",
    source:{...source},
    target:{...target},
    total:resources.length,
    migrated,
    failed,
    startedAt,
    finishedAt:Date.now(),
    error:""
  };
  saveDb();

  return sendHtml(TOKEN, uid,
    "<b>✅ 旧仓库迁移完成</b>\\n\\n"+
    "📦 旧仓库："+escapeHtml(source.title || source.chatId)+"\\n"+
    "📦 新仓库："+escapeHtml(target.title || target.chatId)+"\\n"+
    "📚 待迁移："+resources.length+" 条\\n"+
    "✅ 已迁移："+migrated+" 条\\n"+
    "⚠️ 失败："+failed+" 条\\n\\n"+
    "🔄 旧仓库仍保留。以后旧仓库新增资源会在后台自动同步到新仓库。",
    {parse_mode:"HTML",...adminMenu()}
  );
}

async function syncOldRepositoryRecent() {
  const current = repo();
  const source = migrationSource();
  if (!current || !source || repositoryKey(current) === repositoryKey(source)) return;
  if (!historyClient) return;

  try {
    const dialogs = await historyClient.getDialogs({limit:1000});
    let entity = null;
    for (const d of dialogs) {
      if (String(d.id) === String(source.chatId)) {
        entity = d.entity;
        break;
      }
    }
    if (!entity) return;

    const recent = [];
    for await (const message of historyClient.iterMessages(entity, {limit:100})) {
      const id = Number(message?.id || 0);
      if (!id) continue;
      const hasText = Boolean(String(message?.message || message?.text || "").trim());
      const hasMedia = Boolean(message?.media || message?.file);
      if (!hasText && !hasMedia) continue;
      recent.push({id, chat:{id:source.chatId}});
    }

    let synced = 0;
    for (const message of recent.reverse()) {
      if (await syncRepositoryMessage(message)) synced++;
      await sleep(120);
    }
    if (synced) console.log("🛟 BACKGROUND REPOSITORY CHECK: synced=" + synced);
  } catch (e) {
    console.error("❌ BACKGROUND REPOSITORY CHECK:", e.message);
  }
}
`;

  if (!s.includes(marker)) throw new Error("找不到 repo() 插入点");
  s = s.replace(marker, repoCode);

  const oldMenu = '[\"📦 资源仓库\",\"🔍 仓库扫描\"],';
  const newMenu = '["📦 资源仓库","🔗 绑定新仓库"],["🔍 仓库扫描"],["🔄 迁移旧仓库"],';
  if (!s.includes(oldMenu)) throw new Error("找不到资源管理菜单");
  s = s.replace(oldMenu, newMenu);

  const oldForward = '  if(msg.chat?.type==="private" && msg.forward_origin?.chat) {\\n    const fc=msg.forward_origin.chat;\\n    db.settings.repository={\\n      chatId:String(fc.id),\\n      title:fc.title||fc.username||String(fc.id),\\n      username:fc.username||"",\\n      type:fc.type||"channel"\\n    };\\n    saveDb();\\n';
  const newForward = '  if(msg.chat?.type==="private" && msg.forward_origin?.chat) { const fc=msg.forward_origin.chat; const previous=db.settings.repository ? {...db.settings.repository} : null; const next={chatId:String(fc.id),title:fc.title||fc.username||String(fc.id),username:fc.username||"",type:fc.type||"channel"}; if(previous && repositoryKey(previous)!==repositoryKey(next)) rememberRepository(previous); db.settings.repository=next; rememberRepository(next); saveDb();';\\n    const previous = db.settings.repository ? {...db.settings.repository} : null;\\n    const next = {\\n      chatId:String(fc.id),\\n      title:fc.title||fc.username||String(fc.id),\\n      username:fc.username||"",\\n      type:fc.type||"channel"\\n    };\\n    if(previous && repositoryKey(previous) !== repositoryKey(next)) rememberRepository(previous);\\n    db.settings.repository = next;\\n    rememberRepository(next);\\n    saveDb();\\n';
  if (!s.includes(oldForward)) throw new Error("找不到仓库转发绑定代码");
  s = s.replace(oldForward, newForward);

  const oldPrivateInfo = '  if(t==="📦 绑定资源仓库" && admin)\\n    return send(TOKEN,uid,"📦 绑定资源仓库\\n\\n最简单的绑定方法：\\n\\n1. 先把主机器人加入资源仓库群/频道。\\n2. 从资源仓库里转发任意一条消息给主机器人。\\n3. 主机器人会自动识别并绑定这个群/频道。\\n\\n也可以直接在资源群里发送：/绑定仓库");\\n\\n  if(t==="🤖 克隆机器人") {\\n';
  const newPrivateInfo = '  if(t==="📦 绑定资源仓库" && admin) return send(TOKEN,uid,"📦 资源仓库管理 | 支持群 / 超级群 / 频道。 | ① 点击「🔗 绑定新仓库」并转发新仓库消息给机器人。 | ② 点击「🔄 迁移旧仓库」复制旧仓库资源。 | ③ 迁移后旧仓库继续保留，新资源会后台同步到新仓库。"); if(t==="🔗 绑定新仓库" && admin) return send(TOKEN,uid,"🔗 <b>绑定新仓库</b> | 支持群、超级群、频道。 | 请先把主机器人加入新仓库，再转发任意一条消息给机器人。 | 机器人会保存当前仓库，并把上一个仓库记为旧仓库。", {parse_mode:"HTML",...backMenu(true)}); if(t==="🔄 迁移旧仓库" && admin) return migrateRepositoryResources(uid); if(t==="🤖 克隆机器人") {';\\n\\n  if(t==="🔗 绑定新仓库" && admin)\\n    return send(TOKEN,uid,\\n      "🔗 <b>绑定新仓库</b>\\n\\n"+\\n      "支持群、超级群、频道。\\n\\n"+\\n      "请先把主机器人加入新仓库。\\n"+\\n      "然后从新仓库转发任意一条消息给机器人。\\n\\n"+\\n      "机器人会自动保存当前仓库，并把上一个仓库记为「旧仓库」。\\n"+\\n      "之后即可点击「🔄 迁移旧仓库」。",\\n      {parse_mode:"HTML",...backMenu(true)});\\n\\n  if(t==="🔄 迁移旧仓库" && admin)\\n    return migrateRepositoryResources(uid);\\n\\n  if(t==="🤖 克隆机器人") {\\n';
  if (!s.includes(oldPrivateInfo)) throw new Error("找不到资源仓库说明入口");
  s = s.replace(oldPrivateInfo, newPrivateInfo);

  const oldMainMessage = '  if(msg.chat?.type!=="private") { indexResource(msg); return; }';
  const newMainMessage = '  if(msg.chat?.type!=="private") { indexResource(msg); syncRepositoryMessage(msg).catch(e=>console.error("BACKGROUND GROUP SYNC:",e.message)); return; }';\\n    syncRepositoryMessage(msg).catch(e=>console.error("BACKGROUND GROUP SYNC:",e.message));\\n    return;\\n  }';
  if (!s.includes(oldMainMessage)) throw new Error("找不到群消息入口");
  s = s.replace(oldMainMessage, newMainMessage);

  const oldChannel = '          indexResource(u.channel_post);\\n        }\\n        if(u.edited_channel_post) {\\n          console.log("✏️ EDITED CHANNEL POST:", String(u.edited_channel_post.chat?.id));\\n          indexResource(u.edited_channel_post);\\n';
  const newChannel = '          indexResource(u.channel_post); syncRepositoryMessage(u.channel_post).catch(e=>console.error("BACKGROUND CHANNEL SYNC:",e.message)); } if(u.edited_channel_post) { console.log("✏️ EDITED CHANNEL POST:", String(u.edited_channel_post.chat?.id)); indexResource(u.edited_channel_post); syncRepositoryMessage(u.edited_channel_post).catch(e=>console.error("BACKGROUND EDITED CHANNEL SYNC:",e.message));';\\n          syncRepositoryMessage(u.channel_post).catch(e=>console.error("BACKGROUND CHANNEL SYNC:",e.message));\\n        }\\n        if(u.edited_channel_post) {\\n          console.log("✏️ EDITED CHANNEL POST:", String(u.edited_channel_post.chat?.id));\\n          indexResource(u.edited_channel_post);\\n          syncRepositoryMessage(u.edited_channel_post).catch(e=>console.error("BACKGROUND EDITED CHANNEL SYNC:",e.message));\\n';
  if (!s.includes(oldChannel)) throw new Error("找不到频道消息入口");
  s = s.replace(oldChannel, newChannel);

  const oldDirectoryItems = 'function directoryItems(id) { return db.resources.filter(r=>String(r.directoryId)===String(id)).sort((a,b)=>Number(a.messageId)-Number(b.messageId)); }';
  const newDirectoryItems = 'function directoryItems(id) { return db.resources.filter(r=>!r.unavailable && String(r.directoryId)===String(id)).sort((a,b)=>Number(a.messageId)-Number(b.messageId)); }';
  if (!s.includes(oldDirectoryItems)) throw new Error("找不到目录资源函数");
  s = s.replace(oldDirectoryItems, newDirectoryItems);

  const oldSearch = '  return db.resources.filter(x=>(String(x.title||"")+" "+String(x.caption||"")+" "+String(x.directoryId||"")).toLowerCase().includes(q));';
  const newSearch = '  return db.resources.filter(x=>!x.unavailable && (String(x.title||"")+" "+String(x.caption||"")+" "+String(x.directoryId||"")).toLowerCase().includes(q));';
  if (!s.includes(oldSearch)) throw new Error("找不到搜索函数");
  s = s.replace(oldSearch, newSearch);

  const oldRandom = '  const arr=[...db.resources];';
  const newRandom = '  const arr=db.resources.filter(x=>!x.unavailable);';
  if (!s.includes(oldRandom)) throw new Error("找不到随机函数");
  s = s.replace(oldRandom, newRandom);

  const oldText = '    "📚 总资源："+db.resources.length+" 条","📁 文件夹："+db.directories.length+" 个"].join("\\n");';
  const newText = '    "📚 总资源："+db.resources.filter(x=>!x.unavailable).length+" 条","📁 文件夹："+db.directories.length+" 个"].join("\\n");';
  if (!s.includes(oldText)) throw new Error("找不到目录统计文本");
  s = s.replace(oldText, newText);

  s = s.replaceAll('db.resources.slice(0,10)', 'db.resources.filter(x=>!x.unavailable).slice(0,10)');

  const oldBoot = 'boot().catch(e=>console.error("❌ FATAL BOOT:",e));';
  const newBoot = 'setInterval(()=>{ syncOldRepositoryRecent().catch(e=>console.error("BACKGROUND REPOSITORY LOOP:",e.message)); }, 5*60*1000); console.log("🔄 BACKGROUND REPOSITORY SYNC ENABLED"); '+oldBoot; }, 5*60*1000);\\nconsole.log("🔄 BACKGROUND REPOSITORY SYNC ENABLED");\\n'+oldBoot;
  if (!s.includes(oldBoot)) throw new Error("找不到 boot 入口");
  s = s.replace(oldBoot, newBoot);

  fs.writeFileSync(file, s);
  console.log("✅ Runtime repository migration patch applied");
}
