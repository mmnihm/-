import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error('Missing BOT_TOKEN');

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const REQUIRED_GROUP_ID = process.env.REQUIRED_GROUP_ID || '';
const REQUIRED_GROUP_URL = process.env.REQUIRED_GROUP_URL || '';
const REPOSITORY_CHAT_ID = process.env.REPOSITORY_CHAT_ID || '';
const DATA_FILE = process.env.DATA_FILE || './data/database.json';
const MAX_RESOURCES = Number(process.env.MAX_RESOURCES || 5000);
const API = t => `https://api.telegram.org/bot${t}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function keyBytes() {
  return crypto.createHash('sha256').update(process.env.STORAGE_KEY || TOKEN).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function decrypt(value) {
  const [iv, tag, data] = value.split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

function emptyDb() {
  return { users: [], children: [], resources: [], mainOffset: 0 };
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

function keyboard(rows) {
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}
function userMenu(admin = false, child = false) {
  const rows = [
    ['📂 资源目录','🔎 搜索资源'],
    ['🎲 随机获取','🆕 最新资源']
  ];
  if (!child) rows.unshift(['🤖 克隆我的机器人']);
  if (admin && !child) rows.push(['📢 广播消息'], ['⚙️ 平台管理']);
  return keyboard(rows);
}

async function isMember(token, userId) {
  if (!REQUIRED_GROUP_ID) return true;
  try {
    const m = await tg(token, 'getChatMember', {chat_id: REQUIRED_GROUP_ID, user_id: userId});
    return ['creator','administrator','member'].includes(m.status) ||
      (m.status === 'restricted' && m.is_member === true);
  } catch { return false; }
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
  if (!item || !REPOSITORY_CHAT_ID || String(item.chatId) !== String(REPOSITORY_CHAT_ID)) return;
  const i = db.resources.findIndex(x => x.messageId === item.messageId && x.chatId === item.chatId);
  if (i >= 0) db.resources[i] = item;
  else db.resources.unshift(item);
  if (db.resources.length > MAX_RESOURCES) db.resources.length = MAX_RESOURCES;
  saveDb();
}
async function copyResource(token, toChatId, item) {
  return tg(TOKEN, 'copyMessage', {chat_id: toChatId, from_chat_id: item.chatId, message_id: item.messageId});
}

async function deliverResources(token, chatId, items) {
  if (!REPOSITORY_CHAT_ID) return send(token, chatId, '⚠️ 尚未配置 REPOSITORY_CHAT_ID。');
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
  if (!userId || msg.chat.type !== 'private') return;
  rememberUser(userId);
  broadcastUsers.add(userId);
  const admin = ADMIN_IDS.includes(String(userId));
  const text = msg.text || '';

  if (text === '/start') return send(TOKEN, chatId, '👋 欢迎使用机器人平台\n\n请选择功能：', userMenu(admin));

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
      if (REQUIRED_GROUP_URL) rows.push([{text:'🚪 加入指定群', url:REQUIRED_GROUP_URL}]);
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
      db.children.push({botId:me.id, username:me.username || '', ownerId:userId, token:encrypt(text), createdAt:Date.now(), offset:0});
      saveDb();
      sessions.delete(userId);
      await startChild(db.children.at(-1));
      return send(TOKEN, chatId, `✅ 子机器人绑定成功\n\n🤖 @${me.username || me.first_name}\n\n子机器人已经启动。\n\n📢 子机器人不包含广播功能。`, userMenu(admin));
    } catch (e) {
      return send(TOKEN, chatId, '❌ Token 无效或无法连接 Telegram。\n\n请重新发送正确的 Bot Token，或发送 /cancel 取消。');
    }
  }

  if (['📂 资源目录','🔎 搜索资源','🎲 随机获取','🆕 最新资源'].includes(text)) {
    if (!(await isMember(TOKEN, userId))) return send(TOKEN, chatId, '🔐 暂无访问权限，请先加入指定群。');
    if (text === '📂 资源目录') {
      const list = latestResources(10);
      return send(TOKEN, chatId, list.length ? '📂 最新资源\n\n' + list.map((x,i)=>`${i+1}. ${x.title}`).join('\n') : '📭 暂无资源。');
    }
    if (text === '🔎 搜索资源') {
      sessions.set(userId, {step:'search'});
      return send(TOKEN, chatId, '🔎 请输入关键词：');
    }
    if (text === '🎲 随机获取') return deliverResources(TOKEN, chatId, randomResources(10));
    return deliverResources(TOKEN, chatId, latestResources(10));
  }

  if (session?.step === 'search') {
    sessions.delete(userId);
    return deliverResources(TOKEN, chatId, searchResources(text));
  }
  if (text === '⚙️ 平台管理' && admin) {
    return send(TOKEN, chatId, `⚙️ 平台管理\n\n👤 广播用户：${broadcastUsers.size}\n🤖 子机器人：${db.children.length}\n📦 资源：${db.resources.length}`);
  }
}

async function handleChild(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId || msg.chat.type !== 'private') return;
  const text = msg.text || '';
  if (text === '/start') return send(bot.token, chatId, '👋 欢迎使用资源机器人\n\n请选择功能：', userMenu(false, true));
  if (!(await isMember(bot.token, userId))) {
    return send(bot.token, chatId, '🔐 暂无访问权限，请先加入指定群。');
  }
  if (['📂 资源目录','🔎 搜索资源','🎲 随机获取','🆕 最新资源'].includes(text)) {
    if (text === '📂 资源目录') {
      const list = latestResources(10);
      return send(bot.token, chatId, list.length ? '📂 最新资源\n\n' + list.map((x,i)=>`${i+1}. ${x.title}`).join('\n') : '📭 暂无资源。');
    }
    if (text === '🔎 搜索资源') {
      sessions.set(`c:${bot.botId}:${userId}`, {step:'search'});
      return send(bot.token, chatId, '🔎 请输入关键词：');
    }
    if (text === '🎲 随机获取') return deliverResources(bot.token, chatId, randomResources(10));
    return deliverResources(bot.token, chatId, latestResources(10));
  }
  const key = `c:${bot.botId}:${userId}`;
  if (sessions.get(key)?.step === 'search') {
    sessions.delete(key);
    return deliverResources(bot.token, chatId, searchResources(text));
  }
}

async function startChild(bot) {
  try {
    const token = decrypt(bot.token);
    await tg(token, 'deleteWebhook', {drop_pending_updates:false});
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
