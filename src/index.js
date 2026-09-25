import 'dotenv/config';

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const REQUIRED_GROUP_ID = process.env.REQUIRED_GROUP_ID || '';

if (!TOKEN) throw new Error('Missing BOT_TOKEN');

const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, body = {}) {
  const r = await fetch(API + '/' + method, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || method + ' failed');
  return data.result;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let offset = 0;

function keyboard(rows) {
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

async function isMember(userId) {
  if (!REQUIRED_GROUP_ID) return true;
  try {
    const m = await tg('getChatMember', {chat_id: REQUIRED_GROUP_ID, user_id: userId});
    return ['creator','administrator','member'].includes(m.status);
  } catch {
    return false;
  }
}

function mainMenu(admin=false) {
  const rows = [
    ['🤖 克隆我的机器人'],
    ['📂 资源目录','🔎 搜索资源'],
    ['🎲 随机获取','🆕 最新资源']
  ];
  if (admin) rows.push(['⚙️ 平台管理']);
  return keyboard(rows);
}

const sessions = new Map();

async function send(chatId, text, extra={}) {
  return tg('sendMessage', {chat_id:chatId, text, ...extra});
}

async function handle(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  const admin = ADMIN_IDS.includes(String(userId));

  if (msg.text === '/start') {
    return send(chatId,
      '👋 欢迎使用机器人平台\\n\\n请选择功能：\\n\\n🤖 克隆我的机器人\\n📂 资源目录\\n🔎 搜索资源\\n🎲 随机获取\\n🆕 最新资源',
      mainMenu(admin));
  }

  if (msg.text === '🤖 克隆我的机器人') {
    if (!(await isMember(userId))) {
      return send(chatId, '🔐 暂无克隆权限\\n\\n请先加入指定群后再使用克隆功能。', {
        reply_markup:{inline_keyboard:[
          [{text:'🚪 加入指定群', url: process.env.REQUIRED_GROUP_URL || 'https://t.me/'}],
          [{text:'🔄 检查权限', callback_data:'check_clone'}]
        ]}
      });
    }
    sessions.set(userId, {step:'token'});
    return send(chatId,
      '🤖 创建你的专属机器人\\n\\n第 1 步：请先在 Telegram 的 BotFather 创建一个新机器人。\\n\\n第 2 步：创建完成后，回到这里点击「发送 Token」，系统会引导你安全完成绑定。\\n\\n⚠️ 不要把 Token 发到公开群组或 GitHub。');
  }

  if (msg.text === '📂 资源目录' || msg.text === '🔎 搜索资源' ||
      msg.text === '🎲 随机获取' || msg.text === '🆕 最新资源') {
    if (!(await isMember(userId))) return send(chatId, '🔐 暂无访问权限\\n\\n使用资源功能前，请先加入指定群。');
    return send(chatId, '📦 中央资源库功能已预留。\\n\\n后续接入资源索引后，这里将直接显示主资源库内容。');
  }

  if (msg.text === '⚙️ 平台管理' && admin) {
    return send(chatId, '⚙️ 平台管理\\n\\n这里用于管理指定群、子机器人、中央资源库和平台状态。');
  }
}

async function poll() {
  while (true) {
    try {
      const updates = await tg('getUpdates', {offset, timeout:25, allowed_updates:['message','callback_query']});
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.callback_query?.data === 'check_clone') {
            const ok = await isMember(u.from.id);
            await tg('answerCallbackQuery', {callback_query_id:u.id, text:ok?'验证成功':'请先加入指定群', show_alert:true});
            if (ok) await send(u.from.id, '✅ 群组验证通过\\n\\n现在可以创建你的专属机器人。', mainMenu(false));
          } else if (u.message) {
            await handle(u.message);
          }
        } catch (e) {
          console.error('update error:', e.message);
        }
      }
    } catch (e) {
      console.error('poll error:', e.message);
      await sleep(3000);
    }
  }
}

console.log('Telegram Clone Platform started');
poll();
