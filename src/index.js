import 'dotenv/config';

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const REQUIRED_GROUP_ID = process.env.REQUIRED_GROUP_ID || '';
if (!TOKEN) throw new Error('Missing BOT_TOKEN');

const API = `https://api.telegram.org/bot${TOKEN}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let offset = 0;
const sessions = new Map();
const broadcastUsers = new Set();

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

async function send(chatId, text, extra={}) {
  return tg('sendMessage', {chat_id:chatId, text, ...extra});
}

function keyboard(rows) {
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

async function isMember(userId) {
  if (!REQUIRED_GROUP_ID) return true;
  try {
    const m = await tg('getChatMember', {chat_id:REQUIRED_GROUP_ID, user_id:userId});
    return ['creator','administrator','member'].includes(m.status);
  } catch { return false; }
}

function mainMenu(admin=false) {
  const rows = [
    ['🤖 克隆我的机器人'],
    ['📂 资源目录','🔎 搜索资源'],
    ['🎲 随机获取','🆕 最新资源']
  ];
  if (admin) rows.push(['📢 广播消息'], ['⚙️ 平台管理']);
  return keyboard(rows);
}

async function broadcast(adminChatId, text) {
  let success = 0, failed = 0, processed = 0;
  const ids = [...broadcastUsers];
  await send(adminChatId, `📢 正在发送广播\\n\\n总数：${ids.length}\\n已处理：0\\n成功：0\\n失败：0`);
  for (const userId of ids) {
    processed++;
    try {
      await tg('sendMessage', {chat_id:userId, text});
      success++;
    } catch { failed++; }
    if (processed % 10 === 0 || processed === ids.length) {
      await sleep(350);
    }
  }
  await send(adminChatId, `✅ 广播完成\\n\\n📊 总数：${ids.length}\\n📨 已处理：${processed}\\n✅ 成功：${success}\\n❌ 失败：${failed}`);
}

async function handle(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;
  const admin = ADMIN_IDS.includes(String(userId));

  // 主机器人记录合法私聊用户，供主机器人广播使用。
  if (msg.chat.type === 'private') broadcastUsers.add(userId);

  if (msg.text === '/start') {
    return send(chatId,
      '👋 欢迎使用机器人平台\\n\\n请选择功能：',
      mainMenu(admin));
  }

  if (msg.text === '📢 广播消息' && admin) {
    sessions.set(userId, {step:'broadcast'});
    return send(chatId, '📢 请输入要广播的文字内容：\\n\\n发送 /cancel 可取消。');
  }

  const session = sessions.get(userId);
  if (session?.step === 'broadcast' && admin && msg.text && msg.text !== '/cancel') {
    sessions.delete(userId);
    return broadcast(chatId, msg.text);
  }
  if (session?.step === 'broadcast' && msg.text === '/cancel') {
    sessions.delete(userId);
    return send(chatId, '❌ 已取消广播。', mainMenu(true));
  }

  if (msg.text === '🤖 克隆我的机器人') {
    if (!(await isMember(userId))) {
      return send(chatId, '🔐 暂无克隆权限\\n\\n请先加入指定群后再使用克隆功能。', {
        reply_markup:{inline_keyboard:[
          ...(process.env.REQUIRED_GROUP_URL ? [[{text:'🚪 加入指定群',url:process.env.REQUIRED_GROUP_URL}]] : []),
          [{text:'🔄 检查权限',callback_data:'check_clone'}]
        ]}
      });
    }
    return send(chatId,
      '🤖 创建你的专属机器人\\n\\n① 打开 BotFather 创建机器人\\n② 获取 Bot Token\\n③ 回到这里继续绑定\\n\\n⚠️ Token 不要发到公开群组或 GitHub。\\n\\n📢 广播功能只保留在主机器人，子机器人不会显示广播按钮。');
  }

  if (['📂 资源目录','🔎 搜索资源','🎲 随机获取','🆕 最新资源'].includes(msg.text)) {
    if (!(await isMember(userId))) return send(chatId,'🔐 暂无访问权限\\n\\n请先加入指定群。');
    return send(chatId,'📦 中央资源库功能正在接入。');
  }

  if (msg.text === '⚙️ 平台管理' && admin) {
    return send(chatId,'⚙️ 平台管理\\n\\n这里管理指定群、子机器人和中央资源库。');
  }
}

async function poll() {
  while (true) {
    try {
      const updates = await tg('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.callback_query?.data === 'check_clone') {
            const ok = await isMember(u.from.id);
            await tg('answerCallbackQuery',{callback_query_id:u.id,text:ok?'验证成功':'请先加入指定群',show_alert:true});
            if (ok) await send(u.from.id,'✅ 群组验证通过\\n\\n现在可以创建你的专属机器人。',mainMenu(false));
          } else if (u.message) await handle(u.message);
        } catch (e) { console.error('update error:',e.message); }
      }
    } catch (e) {
      console.error('poll error:',e.message);
      await sleep(3000);
    }
  }
}

console.log('Telegram Clone Platform started');
poll();
