import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HistoryScanner } from './scanner.js';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error('Missing BOT_TOKEN');

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// Group/repository bindings are persisted in database.json and managed by admin commands.
function boundGroup() { return db.settings?.requiredGroup || null; }
function boundRepository() { return db.settings?.repository || null; }
function requiredGroupId() { return boundGroup()?.chatId || ''; }
function requiredGroupUrl() { return boundGroup()?.url || ''; }
function repositoryChatId() { return boundRepository()?.chatId || ''; }
const DATA_FILE = process.env.DATA_FILE || './data/database.json';
const MAX_RESOURCES = Number(process.env.MAX_RESOURCES || 5000);
// Built-in encryption secret: STORAGE_KEY is optional now.
// Keep this value unchanged so encrypted child-bot tokens survive restarts/redeploys.
const STORAGE_SECRET = process.env.STORAGE_KEY || 'mmnihm_storage_0F9I5qu41sqOmc97nZk2inHcQ05MADd5SOoZac4HTiE';
const API = t => `https://api.telegram.org/bot${t}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function keyBytes(secret = STORAGE_SECRET) {
  return crypto.createHash('sha256').update(secret).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function decrypt(value) {
  const [iv, tag, data] = value.split('.');
  const raw = Buffer.from(data, 'base64url');
  const ivBuf = Buffer.from(iv, 'base64url');
  const tagBuf = Buffer.from(tag, 'base64url');
  const tryDecrypt = secret => {
    const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(secret), ivBuf);
    d.setAuthTag(tagBuf);
    return Buffer.concat([d.update(raw), d.final()]).toString('utf8');
  };
  try {
    return tryDecrypt(STORAGE_SECRET);
  } catch {
    // Backward compatibility for older deployments that used BOT_TOKEN as the key.
    if (!process.env.STORAGE_KEY && TOKEN !== STORAGE_SECRET) return tryDecrypt(TOKEN);
    throw new Error('Stored secret cannot be decrypted. Keep the built-in STORAGE_SECRET unchanged.');
  }
}

function emptyDb() {
  return {
    users: [], children: [], resources: [], mainOffset: 0,
    scanner: { session: '', connectedAt: 0 },
    settings: { requiredGroup: null, repository: null },
    directories: []
  };
}
function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { ...emptyDb(), ...db };
  } catch { return emptyDb(); }
}
const db = loadDb();
let saveTimer;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 100);
}
function rememberUser(id) {
  if (!db.users.includes(id)) { db.users.push(id); saveDb(); }
}
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

async function ownerHasRequiredGroup(bot) {
  if (!requiredGroupId()) return false;
  return checkMemberCached(bot.token, bot.ownerId, true);
}

async function enforceChildOwner(bot, notify = false) {
  const allowed = await ownerHasRequiredGroup(bot);
  if (allowed) {
    if (bot.enabled === false) {
      bot.enabled = true;
      bot.suspendedReason = '';
      saveDb();
    }
    return true;
  }

  bot.enabled = false;
  bot.running = false;
  bot.suspendedReason = 'owner_not_in_required_group';
  saveDb();

  if (notify) {
    try {
      await send(bot.token, bot.ownerId,
        '🔐 你的专属机器人已暂停使用。\n\n' +
        '原因：你的账号已不在指定群。\n' +
        '重新加入指定群后，机器人会自动恢复使用。'
      );
    } catch {}
  }
  return false;
}
async function buildChatBinding(chat, kind) {
  const binding = {
    chatId: String(chat.id),
    title: chat.title || chat.username || String(chat.id),
    username: chat.username || '',
    type: chat.type || ''
  };
  if (kind === 'requiredGroup') {
    if (chat.username) {
      binding.url = 'https://t.me/' + chat.username;
    } else {
      try { binding.url = await main('exportChatInviteLink', {chat_id: chat.id}); }
      catch { binding.url = ''; }
    }
  }
  return binding;
}
function configText() {
  const group = boundGroup();
  const repo = boundRepository();
  return [
    '⚙️ 当前绑定配置', '',
    '🔐 指定群：' + (group ? group.title + ' (' + group.type + ')' : '未绑定'),
    '📦 资源仓库：' + (repo ? repo.title + ' (' + repo.type + ')' : '未绑定'),
    '🆔 指定群 ID：' + (group?.chatId || '未绑定'),
    '🆔 仓库 ID：' + (repo?.chatId || '未绑定'),
    group?.url ? '🔗 指定群链接：' + group.url : ''
  ].filter(Boolean).join('\n');
}
async function handleBindingCommand(msg) {
  const userId = msg.from?.id;
  const chat = msg.chat;
  const text = msg.text || '';
  if (!userId || !isAdmin(userId)) return false;
  if (!['group', 'supergroup'].includes(chat?.type)) return false;

  const bindGroup = ['/绑定指定群', '绑定指定群', '🔐 绑定指定群'].includes(text);
  const bindRepo = ['/绑定仓库', '绑定仓库', '📦 绑定仓库'].includes(text);
  const unbindGroup = ['/解绑指定群', '解绑指定群', '🔓 解绑指定群'].includes(text);
  const unbindRepo = ['/解绑仓库', '解绑仓库', '🔓 解绑仓库'].includes(text);
  if (!(bindGroup || bindRepo || unbindGroup || unbindRepo)) return false;

  let member;
  try {
    member = await main('getChatMember', {chat_id: chat.id, user_id: userId});
  } catch {
    await send(TOKEN, userId, '⚠️ 无法验证你在当前群的管理员权限。');
    return true;
  }
  if (!['creator', 'administrator'].includes(member.status)) {
    await send(TOKEN, userId, '⚠️ 只有当前群管理员可以执行绑定/解绑操作。');
    return true;
  }

  if (bindGroup) {
    db.settings.requiredGroup = await buildChatBinding(chat, 'requiredGroup');
    saveDb();
    await send(TOKEN, userId, '✅ 指定群绑定成功\n\n' + configText());
    return true;
  }
  if (bindRepo) {
    db.settings.repository = await buildChatBinding(chat, 'repository');
    saveDb();
    await send(TOKEN, userId, '✅ 资源仓库绑定成功\n\n' + configText());
    return true;
  }
  if (unbindGroup) {
    db.settings.requiredGroup = null;
    saveDb();
    await send(TOKEN, userId, '✅ 已解除指定群绑定。');
    return true;
  }
  if (unbindRepo) {
    db.settings.repository = null;
    saveDb();
    await send(TOKEN, userId, '✅ 已解除资源仓库绑定。');
    return true;
  }
  return true;
}

async function tg(token, method, body = {}) {
  const r = await fetch(API(token) + '/' + method, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || method + ' failed');
  return data.result;
}
const main = (method, body) => tg(TOKEN, method, body);
const send = (token, chatId, text, extra = {}) =>
  tg(token, 'sendMessage', {chat_id: chatId, text, ...extra});

const membershipCache = new Map();
const MEMBERSHIP_CACHE_MS = 15000;
async function checkMemberCached(token, userId, force = false) {
  const groupId = requiredGroupId();
  if (!groupId) return true;
  const key = token + ':' + groupId + ':' + userId;
  const now = Date.now();
  const cached = membershipCache.get(key);
  if (!force && cached && now - cached.at < MEMBERSHIP_CACHE_MS) return cached.ok;
  const ok = await isMember(token, userId);
  membershipCache.set(key, { ok, at: now });
  return ok;
}

function keyboard(rows) {
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}
function userMenu(admin = false, child = false) {
  const rows = [
    ['📂 资源目录','🔎 搜索资源'],
    ['🎲 随机获取','🆕 最新资源']
  ];
  if (!child) rows.unshift(['🤖 克隆我的机器人']);
  if (admin && !child) rows.push(
    ['📁 创建目录','📤 发送资源'],
    ['📢 广播消息'],
    ['🔍 历史扫描'],
    ['⚙️ 平台管理']
  );
  return keyboard(rows);
}

async function isMember(token, userId) {
  const groupId = requiredGroupId();
  if (!groupId) return true;
  try {
    const m = await tg(token, 'getChatMember', {chat_id: groupId, user_id: userId});
    return ['creator','administrator','member'].includes(m.status) ||
      (m.status === 'restricted' && m.is_member === true);
  } catch { return false; }
}

function directoryById(id) {
  return db.directories.find(x => String(x.id) === String(id)) || null;
}
function directoryResources(directoryId) {
  return db.resources.filter(x => String(x.directoryId || '') === String(directoryId));
}
function directoryListText(child = false) {
  if (!db.directories.length) return '📂 暂无资源目录。';
  return '📂 资源目录\\n\\n' + db.directories.map((d, i) => {
    const count = directoryResources(d.id).length;
    return `${i + 1}. ${d.name}（${count} 个资源）`;
  }).join('\\n') + '\\n\\n请选择目录名称查看其中资源。';
}
async function sendDirectoryToRepository(directory) {
  const repo = repositoryChatId();
  if (!repo) throw new Error('repository not bound');
  const text = '📁 资源目录\\n\\n' + directory.name + '\\n\\n' +
    '目录编号：' + directory.id + '\\n' +
    '后续资源将归入此目录。';
  const sent = await main('sendMessage', {chat_id: repo, text});
  directory.repositoryMessageId = sent.message_id;
  return sent;
}
async function addRepositoryResource(msg, directoryId = null) {
  const item = resourceFromMessage(msg);
  if (!item) return null;
  item.directoryId = directoryId ? String(directoryId) : null;
  const i = db.resources.findIndex(x => x.messageId === item.messageId && x.chatId === item.chatId);
  if (i >= 0) db.resources[i] = {...db.resources[i], ...item};
  else db.resources.unshift(item);
  if (db.resources.length > MAX_RESOURCES) db.resources.length = MAX_RESOURCES;
  saveDb();
  return item;
}
async function copyIncomingResourceToRepository(msg, directoryId) {
  const repo = repositoryChatId();
  if (!repo) throw new Error('repository not bound');
  const directory = directoryById(directoryId);
  if (!directory) throw new Error('directory not found');
  const sourceChatId = msg.chat.id;
  const sourceMessageId = msg.message_id;
  const caption = msg.caption || '';
  const prefix = '📁 ' + directory.name;
  const finalCaption = (prefix + (caption ? '\\n\\n' + caption : '')).slice(0, 1024);
  const copied = await main('copyMessage', {
    chat_id: repo,
    from_chat_id: sourceChatId,
    message_id: sourceMessageId,
    caption: finalCaption
  });
  const synthetic = {
    ...msg,
    chat: { ...(msg.chat || {}), id: repo },
    message_id: copied.message_id,
    caption: finalCaption
  };
  const item = resourceFromMessage(synthetic);
  if (item) {
    item.directoryId = String(directory.id);
    const i = db.resources.findIndex(x => x.messageId === item.messageId && x.chatId === item.chatId);
    if (i >= 0) db.resources[i] = item;
    else db.resources.unshift(item);
    if (db.resources.length > MAX_RESOURCES) db.resources.length = MAX_RESOURCES;
    saveDb();
  }
  return copied;
}
function resourceFromMessage(msg) {
  if (!msg) return null;
  const media = msg.document || msg.video || msg.audio || msg.animation || msg.photo?.at(-1);
  if (!media && !msg.text) return null;
  const fileName = msg.document?.file_name || msg.audio?.file_name || '';
  const caption = msg.caption || msg.text || '';
  return {
    messageId: msg.message_id,
    chatId: String(msg.chat.id),
    title: (fileName || caption || '未命名资源').slice(0, 200),
    caption: caption.slice(0, 500),
    date: msg.date || Math.floor(Date.now()/1000)
  };
}
function addResource(msg) {
  const item = resourceFromMessage(msg);
  if (!item || !repositoryChatId() || String(item.chatId) !== String(repositoryChatId())) return;
  const marker = item.caption.match(/(?:^|\\n)📁\\s*(.+?)(?:\\n|$)/);
  if (marker) {
    const dir = db.directories.find(d => d.name === marker[1].trim());
    if (dir) item.directoryId = String(dir.id);
  }
  const i = db.resources.findIndex(x => x.messageId === item.messageId && x.chatId === item.chatId);
  if (i >= 0) db.resources[i] = item;
  else db.resources.unshift(item);
  if (db.resources.length > MAX_RESOURCES) db.resources.length = MAX_RESOURCES;
  saveDb();
}
async function copyResource(token, toChatId, item) {
  return tg(token, 'copyMessage', {chat_id: toChatId, from_chat_id: item.chatId, message_id: item.messageId});
}

async function deliverResources(token, chatId, items, userId = null, ownerBot = null) {
  if (!repositoryChatId()) return send(token, chatId, '⚠️ 尚未绑定资源仓库。');
  if (ownerBot) {
    if (!(await enforceChildOwner(ownerBot, false))) {
      return send(token, chatId, '⏸️ 该专属机器人目前已暂停使用。');
    }
  }
  if (userId != null && !(await checkMemberCached(token, userId, true))) {
    return send(token, chatId, '🔐 暂无访问权限，请先加入指定群。');
  }
  if (!items.length) return send(token, chatId, '📭 暂无资源。');
  let ok = 0;
  for (const item of items) {
    try { await copyResource(token, chatId, item); ok++; }
    catch (e) { console.error('copy resource:', e.message); }
    await sleep(120);
  }
  if (!ok) await send(token, chatId, '⚠️ 资源发送失败，请检查机器人是否已加入并有权限访问仓库。');
}
function searchResources(q) {
  const s = q.toLowerCase();
  return db.resources.filter(x => (x.title + ' ' + x.caption).toLowerCase().includes(s)).slice(0, 10);
}
function latestResources(n = 10) {
  return db.resources.slice(0, n);
}
function randomResources(n = 10) {
  return [...db.resources].sort(() => Math.random() - 0.5).slice(0, n);
}

const sessions = new Map();
const broadcastUsers = new Set(db.users);

const historyScanner = new HistoryScanner({
  apiId: process.env.MT_API_ID,
  apiHash: process.env.MT_API_HASH,
  session: db.scanner?.session || '',
  decrypt,
  encrypt,
  save: async (sessionValue) => {
    db.scanner = { ...(db.scanner || {}), session: sessionValue, connectedAt: Date.now() };
    saveDb();
  },
  onStatus: async (event) => {
    if (!event.adminId) return;
    if (event.status === 'auth_waiting') {
      const prompts = {
        phone: '📱 请输入扫描账号的手机号（含国家区号）：',
        code: '🔐 请输入 Telegram 发来的登录验证码：',
        password: '🔑 请输入该账号的两步验证密码：'
      };
      await send(TOKEN, event.adminId, prompts[event.phase] || '请输入验证信息：');
    }
    if (event.status === 'connected') {
      await send(TOKEN, event.adminId, '✅ 历史扫描账号已连接。\n\n现在可以点击「🔍 历史扫描」。');
    }
    if (event.status === 'auth_error') {
      await send(TOKEN, event.adminId, '⚠️ 扫描账号登录遇到问题：' + event.error);
    }
    if (event.status === 'scan_progress' && Number(event.scanned || 0) % 500 === 0) {
      await send(TOKEN, event.adminId, '🔍 正在真实扫描：已读取 ' + event.scanned + ' 条，发现资源 ' + event.resources + ' 条，当前消息 ID：' + event.lastMessageId);
    }
    if (event.status === 'scan_finished' && event.adminId) {
      await send(TOKEN, event.adminId, '📌 扫描任务已停止/结束，实际读取 ' + event.scanned + ' 条。');
    }
  }
});

historyScanner.connectSaved().catch(error => {
  console.error('history scanner restore:', error.message);
});


let lastScanSave = 0;
function statsSafeCounter() {
  const now = Date.now();
  if (now - lastScanSave > 1000) {
    lastScanSave = now;
    return true;
  }
  return false;
}

async function broadcast(adminChatId, text) {
  const ids = [...broadcastUsers];
  await send(TOKEN, adminChatId, `📢 开始广播\n\n总数：${ids.length}`);
  let success = 0, failed = 0;
  for (const id of ids) {
    try { await send(TOKEN, id, text); success++; }
    catch { failed++; }
    await sleep(50);
  }
  await send(TOKEN, adminChatId, `✅ 广播完成\n\n📊 总数：${ids.length}\n✅ 成功：${success}\n❌ 失败：${failed}`);
}

async function handleMain(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;
  if (await handleBindingCommand(msg)) return;
  if (msg.chat.type !== 'private') return;
  rememberUser(userId);
  broadcastUsers.add(userId);
  const admin = ADMIN_IDS.includes(String(userId));
  const text = msg.text || '';

  if (text === '/start') return send(TOKEN, chatId, '👋 欢迎使用机器人平台\n\n请选择功能：', userMenu(admin));

  if (admin && (text === '/绑定扫描账号' || text === '🔗 绑定扫描账号')) {
    if (!process.env.MT_API_ID || !process.env.MT_API_HASH) {
      return send(TOKEN, chatId, '⚠️ 还没有配置 MT_API_ID / MT_API_HASH。\n\n请先在服务器环境变量中填写 Telegram API ID 和 API Hash。');
    }
    if (historyScanner.client) return send(TOKEN, chatId, '✅ 扫描账号已经登录，无需重复绑定。');
    if (historyScanner.auth) return send(TOKEN, chatId, '⏳ 扫描账号登录流程已经在进行中，请按提示继续。');
    send(TOKEN, chatId, '🔐 开始绑定扫描账号。\n\n这个账号必须已经加入你的资源仓库，并且能够正常查看历史消息。\n\n不要把扫描账号的登录验证码、两步验证密码发给其他人。');
    historyScanner.beginLogin(null, userId).catch(async error => {
      console.error('scanner auth:', error.message);
      await send(TOKEN, userId, '❌ 扫描账号登录失败：' + error.message);
    });
    return;
  }

  if (admin && historyScanner.auth && historyScanner.auth.adminId === userId) {
    const phase = historyScanner.auth.phase;
    if (text === '/cancel') {
      historyScanner.cancelAuth('管理员取消登录');
      return send(TOKEN, chatId, '❌ 已取消扫描账号登录。', userMenu(true));
    }
    if (['phone','code','password'].includes(phase) && text) {
      historyScanner.provide(text);
      return send(TOKEN, chatId, phase === 'phone'
        ? '📨 正在请求登录验证码，请稍候……'
        : phase === 'code'
          ? '🔄 正在验证验证码……'
          : '🔄 正在验证两步验证密码……');
    }
  }

  if (admin && (text === '/查看配置' || text === '查看配置' || text === '⚙️ 查看配置')) {
    return send(TOKEN, chatId, configText(), userMenu(true));
  }

  if (admin && (text === '/历史扫描' || text === '🔍 历史扫描')) {
    if (!process.env.MT_API_ID || !process.env.MT_API_HASH) {
      return send(TOKEN, chatId, '⚠️ 请先配置 MT_API_ID / MT_API_HASH。');
    }
    if (!historyScanner.client) {
      return send(TOKEN, chatId, '🔐 还没有绑定扫描账号。\n\n请先发送 /绑定扫描账号。');
    }
    if (!repositoryChatId()) {
      return send(TOKEN, chatId, '⚠️ 尚未绑定资源仓库。历史扫描需要先绑定资源仓库。');
    }
    if (historyScanner.running) {
      return send(TOKEN, chatId, '⏳ 历史扫描已经在运行中。');
    }
    sessions.set(userId, {step:'historyScanLimit'});
    return send(TOKEN, chatId, '🔍 准备真实扫描 Telegram 历史消息。\n\n扫描账号：已连接\n仓库：' + repositoryChatId() + '\n\n请输入扫描消息数量：\n例如：5000\n输入 0 = 扫描到 Telegram 历史尽头（受 MAX_HISTORY_SCAN 限制）。\n\n发送 /cancel 取消。');
  }

  if (admin && sessions.get(userId)?.step === 'historyScanLimit') {
    if (text === '/cancel') {
      sessions.delete(userId);
      return send(TOKEN, chatId, '❌ 已取消。', userMenu(true));
    }
    const requested = Number(text);
    if (!Number.isInteger(requested) || requested < 0) {
      return send(TOKEN, chatId, '⚠️ 请输入 0 或正整数，例如 5000。');
    }
    const maxMessages = requested === 0 ? Number(process.env.MAX_HISTORY_SCAN || 50000) : Math.min(requested, Number(process.env.MAX_HISTORY_SCAN || 50000));
    sessions.delete(userId);
    await send(TOKEN, chatId, '🔍 开始真实历史扫描……\n\n最大扫描：' + maxMessages + ' 条\n不会下载文件，只读取 Telegram 历史消息并建立资源索引。');
    try {
      const stats = await historyScanner.scan({
        chatId: repositoryChatId(),
        maxMessages,
        adminId: userId,
        onResource: async (item) => {
          const i = db.resources.findIndex(x => x.messageId === item.messageId && x.chatId === item.chatId);
          if (i >= 0) db.resources[i] = item;
          else db.resources.unshift(item);
          if (db.resources.length > MAX_RESOURCES) db.resources.length = MAX_RESOURCES;
          if (statsSafeCounter()) saveDb();
        }
      });
      saveDb();
      await send(TOKEN, chatId, '✅ 历史扫描完成\n\n🔍 实际读取：' + stats.scanned + '\n📦 发现资源：' + stats.resources + '\n⏭️ 跳过：' + stats.skipped + '\n❌ 错误：' + stats.errors + '\n\n📚 当前索引：' + db.resources.length);
    } catch (error) {
      await send(TOKEN, chatId, '❌ 历史扫描失败：' + error.message);
    }
    return;
  }

  if (admin && (text === '/停止扫描' || text === '🛑 停止扫描')) {
    if (!historyScanner.running) return send(TOKEN, chatId, 'ℹ️ 当前没有正在运行的历史扫描。');
    historyScanner.stop();
    return send(TOKEN, chatId, '🛑 已请求停止扫描，当前消息处理完成后会停止。');
  }

  if (text === '📁 创建目录' && admin) {
    if (!repositoryChatId()) return send(TOKEN, chatId, '⚠️ 请先绑定资源仓库。');
    sessions.set(userId, {step:'createDirectory'});
    return send(TOKEN, chatId, '📁 创建目录\\n\\n请输入目录名称。\\n\\n发送 /cancel 取消。');
  }

  if (text === '📤 发送资源' && admin) {
    if (!repositoryChatId()) return send(TOKEN, chatId, '⚠️ 请先绑定资源仓库。');
    if (!db.directories.length) return send(TOKEN, chatId, '📂 还没有目录，请先创建目录。');
    sessions.set(userId, {step:'sendResourceDirectory'});
    return send(TOKEN, chatId, '📤 发送资源\\n\\n请选择目录：\\n\\n' +
      db.directories.map((d,i)=>`${i+1}. ${d.name}`).join('\\n') +
      '\\n\\n请发送目录编号或目录名称。\\n发送 /cancel 取消。');
  }

  const adminSession = sessions.get(userId);
  if (adminSession?.step === 'createDirectory' && admin) {
    if (text === '/cancel') { sessions.delete(userId); return send(TOKEN, chatId, '❌ 已取消。', userMenu(true)); }
    const name = text.trim();
    if (!name || name.length > 80) return send(TOKEN, chatId, '⚠️ 目录名称不能为空且不能超过 80 个字符。');
    if (db.directories.some(d => d.name === name)) return send(TOKEN, chatId, '⚠️ 这个目录已经存在，请换一个名称。');
    const directory = {id: crypto.randomUUID(), name, createdAt: Date.now(), repositoryMessageId: null};
    db.directories.push(directory);
    saveDb();
    try {
      await sendDirectoryToRepository(directory);
      saveDb();
      sessions.delete(userId);
      return send(TOKEN, chatId, '✅ 目录创建成功。\\n\\n📁 ' + name + '\\n📦 已同步到资源仓库。', userMenu(true));
    } catch (e) {
      db.directories = db.directories.filter(d => d.id !== directory.id);
      saveDb();
      return send(TOKEN, chatId, '❌ 创建目录失败：' + e.message);
    }
  }

  if (adminSession?.step === 'sendResourceDirectory' && admin) {
    if (text === '/cancel') { sessions.delete(userId); return send(TOKEN, chatId, '❌ 已取消。', userMenu(true)); }
    const value = text.trim();
    const directory = db.directories[Number(value) - 1] || db.directories.find(d => d.name === value);
    if (!directory) return send(TOKEN, chatId, '⚠️ 找不到这个目录，请输入目录编号或名称。');
    sessions.set(userId, {step:'sendResource', directoryId:directory.id});
    return send(TOKEN, chatId, '📤 当前目录：' + directory.name + '\\n\\n现在直接把文件/视频/图片发送给我。\\n我会自动转发到资源仓库并归入这个目录。\\n\\n发送 /done 完成，/cancel 取消。');
  }

  if (adminSession?.step === 'sendResource' && admin) {
    if (text === '/cancel') { sessions.delete(userId); return send(TOKEN, chatId, '❌ 已取消。', userMenu(true)); }
    if (text === '/done') { sessions.delete(userId); return send(TOKEN, chatId, '✅ 资源发送完成。', userMenu(true)); }
    if (msg.media_group_id) {
      return send(TOKEN, chatId, '⚠️ 暂不支持相册批量上传，请逐个发送。');
    }
    const hasMedia = msg.document || msg.video || msg.audio || msg.animation || msg.photo;
    if (!hasMedia) return send(TOKEN, chatId, '📎 请直接发送文件、视频、图片或音频。');
    try {
      await copyIncomingResourceToRepository(msg, adminSession.directoryId);
      return send(TOKEN, chatId, '✅ 已发送到资源仓库并归入「' + directoryById(adminSession.directoryId).name + '」。');
    } catch (e) {
      return send(TOKEN, chatId, '❌ 发送资源失败：' + e.message);
    }
  }

  if (text === '📢 广播消息' && admin) {
    sessions.set(userId, {step:'broadcast'});
    return send(TOKEN, chatId, '📢 请输入广播内容。\n\n发送 /cancel 取消。');
  }
  const session = sessions.get(userId);
  if (session?.step === 'broadcast' && admin) {
    if (text === '/cancel') { sessions.delete(userId); return send(TOKEN, chatId, '❌ 已取消。', userMenu(true)); }
    if (text) { sessions.delete(userId); return broadcast(chatId, text); }
  }

  if (text === '🤖 克隆我的机器人') {
    if (!(await isMember(TOKEN, userId))) {
      const rows = [];
      if (requiredGroupUrl()) rows.push([{text:'🚪 加入指定群', url:requiredGroupUrl()}]);
      rows.push([{text:'🔄 检查权限', callback_data:'check_clone'}]);
      return send(TOKEN, chatId, '🔐 请先加入指定群后再克隆机器人。', {reply_markup:{inline_keyboard:rows}});
    }
    sessions.set(userId, {step:'childToken'});
    return send(TOKEN, chatId, '🤖 创建子机器人\n\n① 在 @BotFather 创建机器人\n② 复制 Bot Token 发给我\n③ 我会自动验证并启动子机器人\n\n⚠️ Token 属于敏感凭证，不要发给其他人。\n\n发送 /cancel 取消。');
  }

  if (session?.step === 'childToken') {
    if (text === '/cancel') { sessions.delete(userId); return send(TOKEN, chatId, '❌ 已取消。', userMenu(admin)); }
    if (!text) return send(TOKEN, chatId, '请直接发送 BotFather 提供的 Token。');
    try {
      const me = await tg(text, 'getMe');
      if (!me.is_bot) throw new Error('not a bot');
      if (db.children.some(x => x.botId === me.id)) {
        sessions.delete(userId);
        return send(TOKEN, chatId, '⚠️ 这个机器人已经绑定过了。', userMenu(admin));
      }
      db.children.push({
        botId:me.id,
        username:me.username || '',
        ownerId:userId,
        token:encrypt(text),
        createdAt:Date.now(),
        offset:0,
        enabled:true,
        running:false,
        suspendedReason:''
      });
      saveDb();
      sessions.delete(userId);
      await startChild(db.children.at(-1));
      return send(TOKEN, chatId, `✅ 子机器人绑定成功\n\n🤖 @${me.username || me.first_name}\n\n子机器人已经启动。\n\n📢 子机器人不包含广播功能。`, userMenu(admin));
    } catch (e) {
      return send(TOKEN, chatId, '❌ Token 无效或无法连接 Telegram。\n\n请重新发送正确的 Bot Token，或发送 /cancel 取消。');
    }
  }

  if (['📂 资源目录','🔎 搜索资源','🎲 随机获取','🆕 最新资源'].includes(text)) {
    if (!(await checkMemberCached(TOKEN, userId))) return send(TOKEN, chatId, '🔐 暂无访问权限，请先加入指定群。');
    if (text === '📂 资源目录') {
      sessions.set(userId, {step:'directorySelect'});
      return send(TOKEN, chatId, directoryListText());
    }
    if (text === '🔎 搜索资源') {
      sessions.set(userId, {step:'search'});
      return send(TOKEN, chatId, '🔎 请输入关键词：');
    }
    if (text === '🎲 随机获取') return deliverResources(TOKEN, chatId, randomResources(10), userId);
    return deliverResources(TOKEN, chatId, latestResources(10), userId);
  }

  if (session?.step === 'directorySelect') {
    const value = text.trim();
    const directory = db.directories[Number(value) - 1] || db.directories.find(d => d.name === value);
    if (!directory) return send(TOKEN, chatId, '⚠️ 找不到这个目录，请输入目录编号或名称。');
    sessions.delete(userId);
    const items = directoryResources(directory.id).slice(0, 20);
    if (!items.length) return send(TOKEN, chatId, '📁 ' + directory.name + '\\n\\n📭 这个目录暂时没有资源。');
    return send(TOKEN, chatId, '📁 ' + directory.name + '\\n\\n' + items.map((x,i)=>`${i+1}. ${x.title}`).join('\\n') + '\\n\\n发送资源编号即可获取对应资源。');
  }

  if (session?.step === 'search') {
    sessions.delete(userId);
    return deliverResources(TOKEN, chatId, searchResources(text), userId);
  }
  if (text === '⚙️ 平台管理' && admin) {
    return send(TOKEN, chatId, `⚙️ 平台管理\n\n👤 广播用户：${broadcastUsers.size}\n🤖 子机器人：${db.children.length}\n📦 资源：${db.resources.length}\n🔍 扫描账号：${historyScanner.client ? '已连接' : '未绑定'}\n🧭 扫描状态：${historyScanner.running ? '运行中' : '空闲'}`);
  }
}

async function handleChild(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId || msg.chat.type !== 'private') return;
  const text = msg.text || '';
  // Check the child-bot owner only when the bot receives a user request.
  // No background polling is needed.
  if (!(await enforceChildOwner(bot, true))) {
    return send(bot.token, chatId, '⏸️ 该专属机器人目前已暂停使用。\n\n机器人所属用户不在指定群内。');
  }
  if (text === '/start') return send(bot.token, chatId, '👋 欢迎使用资源机器人\n\n请选择功能：', userMenu(false, true));
  if (!(await checkMemberCached(bot.token, userId))) {
    return send(bot.token, chatId, '🔐 暂无访问权限，请先加入指定群。');
  }
  if (['📂 资源目录','🔎 搜索资源','🎲 随机获取','🆕 最新资源'].includes(text)) {
    if (text === '📂 资源目录') {
      sessions.set(`c:${bot.botId}:${userId}`, {step:'directorySelect'});
      return send(bot.token, chatId, directoryListText(true));
    }
    if (text === '🔎 搜索资源') {
      sessions.set(`c:${bot.botId}:${userId}`, {step:'search'});
      return send(bot.token, chatId, '🔎 请输入关键词：');
    }
    if (text === '🎲 随机获取') return deliverResources(bot.token, chatId, randomResources(10), userId, bot);
    return deliverResources(bot.token, chatId, latestResources(10), userId, bot);
  }
  const key = `c:${bot.botId}:${userId}`;
  if (sessions.get(key)?.step === 'directorySelect') {
    const value = text.trim();
    const directory = db.directories[Number(value) - 1] || db.directories.find(d => d.name === value);
    if (!directory) return send(bot.token, chatId, '⚠️ 找不到这个目录，请输入目录编号或名称。');
    sessions.delete(key);
    const items = directoryResources(directory.id).slice(0, 20);
    if (!items.length) return send(bot.token, chatId, '📁 ' + directory.name + '\\n\\n📭 这个目录暂时没有资源。');
    return send(bot.token, chatId, '📁 ' + directory.name + '\\n\\n' + items.map((x,i)=>`${i+1}. ${x.title}`).join('\\n') + '\\n\\n发送资源编号即可获取对应资源。');
  }

  if (sessions.get(key)?.step === 'search') {
    sessions.delete(key);
    return deliverResources(bot.token, chatId, searchResources(text), userId, bot);
  }
}

async function startChild(bot) {
  try {
    const token = decrypt(bot.token);
    bot.token = bot.token; // keep encrypted token in persistent storage
    if (requiredGroupId()) {
      const allowed = await enforceChildOwner(bot);
      if (!allowed) {
        bot.running = false;
        return;
      }
    }
    await tg(token, 'deleteWebhook', {drop_pending_updates:false});
    bot.enabled = true;
    bot.running = true;
    childLoop(bot).catch(e => console.error('child loop:', e.message));
  } catch (e) {
    bot.running = false;
    console.error('child start failed:', bot.botId, e.message);
  }
}
async function childLoop(bot) {
  const token = decrypt(bot.token);
  let offset = bot.offset || 0;
  while (true) {
    try {
      const updates = await tg(token, 'getUpdates', {
        offset, timeout:25, allowed_updates:['message','callback_query']
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        bot.offset = offset;
        if (u.callback_query) {
          const ok = await enforceChildOwner(bot, false) &&
            await checkMemberCached(token, u.from.id, true);
          await tg(token, 'answerCallbackQuery', {
            callback_query_id: u.callback_query.id,
            text: ok ? '验证成功' : '🔐 请先加入指定群',
            show_alert: true
          });
        }
        if (u.message) await handleChild(bot, u.message);
      }
      saveDb();
    } catch (e) {
      console.error(`child @${bot.username || bot.botId}:`, e.message);
      await sleep(3000);
    }
  }
}

async function mainLoop() {
  await main('deleteWebhook', {drop_pending_updates:false});
  while (true) {
    try {
      const updates = await main('getUpdates', {
        offset: db.mainOffset || 0,
        timeout:25,
        allowed_updates:['message','callback_query','channel_post','edited_channel_post']
      });
      for (const u of updates) {
        db.mainOffset = u.update_id + 1;
        if (u.channel_post) addResource(u.channel_post);
        if (u.edited_channel_post) addResource(u.edited_channel_post);
        if (u.message && repositoryChatId() && String(u.message.chat?.id) === String(repositoryChatId())) addResource(u.message);
        if (u.callback_query?.data === 'check_clone') {
          const ok = await isMember(TOKEN, u.from.id);
          await main('answerCallbackQuery', {callback_query_id:u.id, text:ok?'验证成功':'请先加入指定群', show_alert:true});
          if (ok) await send(TOKEN, u.from.id, '✅ 群组验证通过\n\n现在可以创建你的专属机器人。', userMenu(ADMIN_IDS.includes(String(u.from.id))));
        }
        if (u.message) await handleMain(u.message);
      }
      saveDb();
    } catch (e) {
      console.error('main loop:', e.message);
      await sleep(3000);
    }
  }
}

async function boot() {
  const me = await main('getMe');
  console.log(`Main bot started: @${me.username}`);
  for (const child of db.children) {
    try { await startChild(child); } catch (e) { console.error('child boot:', e.message); }
  }
  console.log(`Loaded ${db.children.length} child bots and ${db.resources.length} resources`);
  mainLoop().catch(e => { console.error('fatal:', e); process.exit(1); });
}
boot();
