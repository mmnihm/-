import mysql from "mysql2/promise";
import crypto from "node:crypto";

let pool = null;
let ready = false;
let writeQueue = Promise.resolve();

function envBool(v, fallback=false) {
  const s=String(v ?? "").trim().toLowerCase();
  if(!s) return fallback;
  return ["1","true","yes","on"].includes(s);
}

function mysqlConfig() {
  const url=String(process.env.DATABASE_URL || "").trim();
  if(url) {
    try {
      const u=new URL(url);
      return {
        host:u.hostname,
        port:Number(u.port||3306),
        user:decodeURIComponent(u.username||""),
        password:decodeURIComponent(u.password||""),
        database:decodeURIComponent(u.pathname.replace(/^\//,"")),
        waitForConnections:true,
        connectionLimit:Number(process.env.DB_POOL_SIZE||5),
        queueLimit:0,
        charset:"utf8mb4"
      };
    } catch(e) {
      console.warn("⚠️ DATABASE_URL 无法解析，将使用 DB_HOST/DB_*");
    }
  }
  const host=String(process.env.DB_HOST||"").trim();
  if(!host) return null;
  return {
    host,
    port:Number(process.env.DB_PORT||3306),
    user:String(process.env.DB_USER||"root"),
    password:String(process.env.DB_PASSWORD||""),
    database:String(process.env.DB_NAME||""),
    waitForConnections:true,
    connectionLimit:Number(process.env.DB_POOL_SIZE||5),
    queueLimit:0,
    charset:"utf8mb4"
  };
}

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS bot_state (
    state_key VARCHAR(64) NOT NULL PRIMARY KEY,
    data LONGTEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS folders (
    id VARCHAR(191) NOT NULL PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    parent_id VARCHAR(191) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    data LONGTEXT NULL,
    created_at BIGINT NULL,
    updated_at BIGINT NULL,
    KEY idx_folders_name (name(191)),
    KEY idx_folders_parent (parent_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS resources (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    resource_key VARCHAR(255) NOT NULL UNIQUE,
    folder_id VARCHAR(191) NULL,
    chat_id VARCHAR(255) NOT NULL,
    message_id BIGINT NOT NULL,
    title VARCHAR(1000) NULL,
    caption TEXT NULL,
    file_type VARCHAR(64) NULL,
    file_id TEXT NULL,
    telegram_url TEXT NULL,
    downloads BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    data LONGTEXT NULL,
    created_at BIGINT NULL,
    updated_at BIGINT NULL,
    UNIQUE KEY uq_resource_message (chat_id(191), message_id),
    KEY idx_resources_folder (folder_id),
    KEY idx_resources_title (title(191)),
    KEY idx_resources_updated (updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS repositories (
    chat_id VARCHAR(255) NOT NULL PRIMARY KEY,
    title VARCHAR(1000) NULL,
    username VARCHAR(255) NULL,
    repo_type VARCHAR(64) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    data LONGTEXT NULL,
    created_at BIGINT NULL,
    updated_at BIGINT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sync_tasks (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_key VARCHAR(600) NOT NULL UNIQUE,
    source_chat_id VARCHAR(255) NULL,
    target_chat_id VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'idle',
    last_message_id BIGINT NOT NULL DEFAULT 0,
    queued BIGINT NOT NULL DEFAULT 0,
    copied BIGINT NOT NULL DEFAULT 0,
    skipped BIGINT NOT NULL DEFAULT 0,
    failed BIGINT NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    data LONGTEXT NULL,
    created_at BIGINT NULL,
    updated_at BIGINT NULL,
    KEY idx_sync_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

function stateKey() {
  const token=String(process.env.BOT_TOKEN||"").trim();
  return "main:" + (token ? crypto.createHash("sha1").update(token).digest("hex").slice(0,16) : "default");
}
function parseJson(value, fallback=null) {
  try { const x=JSON.parse(String(value||"")); return x && typeof x==="object" ? x : fallback; } catch { return fallback; }
}
function resourceKey(item) {
  return String(item?.chatId ?? "") + ":" + String(item?.messageId ?? "");
}

function telegramUrl(item) {
  const cid=String(item?.chatId||"").trim();
  const mid=Number(item?.messageId||0);
  if(!cid || !mid) return "";
  if(/^-100\d+$/.test(cid)) return "https://t.me/c/"+cid.slice(4)+"/"+mid;
  if(item?.chatUsername) return "https://t.me/"+String(item.chatUsername).replace(/^@/,"")+"/"+mid;
  return "";
}

async function persistNormalized(db) {
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("INSERT INTO bot_state (state_key,data) VALUES (?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)",[stateKey(),JSON.stringify(db)]);
    for(const d of Array.isArray(db.directories)?db.directories:[]) {
      if(!d?.id || !d?.name) continue;
      await conn.execute("INSERT INTO folders (id,name,parent_id,sort_order,status,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),parent_id=VALUES(parent_id),sort_order=VALUES(sort_order),status=VALUES(status),data=VALUES(data),updated_at=VALUES(updated_at)",[String(d.id),String(d.name).slice(0,500),d.parentId?String(d.parentId):null,Number(d.sortOrder||0),d.status||"active",JSON.stringify(d),Number(d.createdAt||Date.now()),Number(d.updatedAt||Date.now())]);
    }
    for(const r of Array.isArray(db.resources)?db.resources:[]) {
      const key=resourceKey(r);
      if(!key || key===":" || !r?.chatId || !r?.messageId) continue;
      await conn.execute("INSERT INTO resources (resource_key,folder_id,chat_id,message_id,title,caption,file_type,file_id,telegram_url,downloads,status,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE folder_id=VALUES(folder_id),title=VALUES(title),caption=VALUES(caption),file_type=VALUES(file_type),file_id=VALUES(file_id),telegram_url=VALUES(telegram_url),downloads=VALUES(downloads),status=VALUES(status),data=VALUES(data),updated_at=VALUES(updated_at)",[key,r.directoryId?String(r.directoryId):null,String(r.chatId),Number(r.messageId),String(r.title||"").slice(0,1000),String(r.caption||""),String(r.fileType||""),String(r.fileId||""),telegramUrl(r),Number(r.downloads||0),r.status||"active",JSON.stringify(r),Number(r.date||r.createdAt||Date.now()),Date.now()]);
    }
    const repos=[];
    if(db.settings?.repository) repos.push(db.settings.repository);
    if(Array.isArray(db.settings?.repositories)) repos.push(...db.settings.repositories);
    for(const r of repos) {
      if(!r?.chatId) continue;
      await conn.execute("INSERT INTO repositories (chat_id,title,username,repo_type,status,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),username=VALUES(username),repo_type=VALUES(repo_type),status=VALUES(status),data=VALUES(data),updated_at=VALUES(updated_at)",[String(r.chatId),String(r.title||"").slice(0,1000),String(r.username||""),String(r.type||r.repoType||""),r.status||"active",JSON.stringify(r),Number(r.createdAt||Date.now()),Date.now()]);
    }
    const task=db.settings?.repositoryAutoSync;
    if(task?.sourceId || task?.targetId) {
      const taskKey=String(task.sourceId||"")+":"+String(task.targetId||"");
      await conn.execute("INSERT INTO sync_tasks (task_key,source_chat_id,target_chat_id,status,last_message_id,queued,copied,skipped,failed,last_error,data,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?) ON DUPLICATE KEY UPDATE source_chat_id=VALUES(source_chat_id),target_chat_id=VALUES(target_chat_id),status=VALUES(status),last_message_id=VALUES(last_message_id),queued=VALUES(queued),copied=VALUES(copied),skipped=VALUES(skipped),failed=VALUES(failed),last_error=VALUES(last_error),data=VALUES(data),updated_at=VALUES(updated_at)",[taskKey,String(task.sourceId||""),String(task.targetId||""),String(task.status||"idle"),Number(task.lastMessageId||0),Number(task.queue?.length||0),Number(task.copied||0),Number(task.skipped||0),Number(task.failed||0),String(task.lastError||""),JSON.stringify(task),Date.now(),Date.now()]);
    }
    await conn.commit();
  } catch(e) { try { await conn.rollback(); } catch {} throw e; } finally { conn.release(); }
}

export async function initializeMySQL(db) {
  const config=mysqlConfig();
  if(!config) { console.log("ℹ️ MySQL 未配置：继续使用本地 JSON。"); return false; }
  if(!config.database) { console.error("❌ MySQL 已配置但缺少 DB_NAME"); return false; }
  try {
    pool=mysql.createPool(config);
    await pool.query("SELECT 1");
    await createSchema();
    const key=stateKey();
    // 启动恢复必须是“合并”而不是“远端覆盖本地”。
    // 如果本地刚刚新增了资源，而 MySQL 里还是旧快照，绝不能因为 MySQL
    // 启动成功就把本地资源替换掉；否则会出现“刚上传几十个文件，重启后消失”。
    let remoteState=null;
    const [rows]=await pool.execute("SELECT data FROM bot_state WHERE state_key=? LIMIT 1",[key]);
    if(rows.length && rows[0]?.data) {
      remoteState=parseJson(rows[0].data);
    } else {
      const [legacy]=await pool.execute("SELECT data FROM bot_state WHERE state_key='main' LIMIT 1");
      remoteState=legacy.length ? parseJson(legacy[0]?.data) : null;
    }

    // 仅在本地数据库明显为空时使用远端完整状态作为启动基线。
    // 本地已有数据时，保留本地 users/settings 等状态，再把远端缺失数据合并进来。
    const localHasResources=Array.isArray(db.resources) && db.resources.length>0;
    const localHasDirectories=Array.isArray(db.directories) && db.directories.length>0;
    if(remoteState && !localHasResources && !localHasDirectories) {
      Object.keys(db).forEach(k=>delete db[k]);
      Object.assign(db,remoteState);
    } else if(remoteState) {
      const merged={...remoteState,...db};
      const dirs=new Map();
      for(const x of Array.isArray(remoteState.directories)?remoteState.directories:[]) {
        if(x?.id) dirs.set(String(x.id),x);
      }
      for(const x of Array.isArray(db.directories)?db.directories:[]) {
        if(x?.id) dirs.set(String(x.id),x);
      }
      const resources=new Map();
      for(const x of Array.isArray(remoteState.resources)?remoteState.resources:[]) {
        if(x?.chatId && x?.messageId) resources.set(resourceKey(x),x);
      }
      for(const x of Array.isArray(db.resources)?db.resources:[]) {
        if(x?.chatId && x?.messageId) resources.set(resourceKey(x),x);
      }
      merged.directories=[...dirs.values()];
      merged.resources=[...resources.values()];
      Object.keys(db).forEach(k=>delete db[k]);
      Object.assign(db,merged);
    }

    const [fr]=await pool.query("SELECT data FROM folders WHERE status <> 'deleted'");
    const [rr]=await pool.query("SELECT data FROM resources WHERE status <> 'deleted'");
    const fm=new Map((Array.isArray(db.directories)?db.directories:[]).map(x=>[String(x?.id||""),x]));
    for(const row of fr) {
      const x=parseJson(row.data);
      if(x?.id && !fm.has(String(x.id))) fm.set(String(x.id),x);
    }
    db.directories=[...fm.values()];
    const rm=new Map((Array.isArray(db.resources)?db.resources:[]).map(x=>[resourceKey(x),x]));
    for(const row of rr) {
      const x=parseJson(row.data);
      if(x?.chatId && x?.messageId && !rm.has(resourceKey(x))) rm.set(resourceKey(x),x);
    }
    db.resources=[...rm.values()];

    // 只有在数据库连接和读取全部成功后才回写 MySQL；初始化失败不会触碰本地数据。
    await persistNormalized(db);
    ready=true;
    console.log("✅ MySQL：已连接；文件夹/资源采用增量保存，机器人状态已隔离");
    return true;
  } catch(e) {
    ready=false;
    console.error("❌ MySQL 初始化失败：",String(e?.message||e));
    try { if(pool) await pool.end(); } catch {}
    pool=null;
    return false;
  }
}

export function isMySQLReady() {
  return ready && Boolean(pool);
}

export function persistMySQL(db) {
  if(!ready || !pool) return;
  const snapshot=JSON.parse(JSON.stringify(db));
  writeQueue=writeQueue.then(()=>persistNormalized(snapshot)).catch(e=>{
    console.error("❌ MySQL 保存失败：",String(e?.message||e));
  });
}

export async function flushMySQL() {
  await writeQueue;
}

export async function closeMySQL() {
  try { await writeQueue; } catch {}
  if(pool) await pool.end();
  pool=null;
  ready=false;
}
