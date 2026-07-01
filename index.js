function getAppConfig(env) {
  const accounts = [];
  for (let i = 1; i <= 20; i++) {
    const id = env[`ACCOUNT_${i}_ID`];
    const token = env[`ACCOUNT_${i}_TOKEN`];
    const name = env[`ACCOUNT_${i}_NAME`] || `ACCOUNT-${i}`;
    if (id && token && id !== "xxxxxxxx") {
      accounts.push({ name, accountId: id, apiToken: token });
    }
  }
  
  const uniqueAccounts = [];
  const idSet = new Set();
  for (const acc of accounts) {
    if (!idSet.has(acc.accountId)) {
      idSet.add(acc.accountId);
      uniqueAccounts.push(acc);
    }
  }
  
  const adminTgIds = env.ADMIN_TG_ID
    ? env.ADMIN_TG_ID.split(',').map(id => Number(id.trim())).filter(id => !isNaN(id))
    : [];
    
  return {
    tgBotToken: env.TG_BOT_TOKEN,
    adminTgIds,
    cfAccounts: uniqueAccounts,
    tgWebhookSecret: env.TG_WEBHOOK_SECRET 
  };
}

async function getWorkerStats(accountId, apiToken) {
  const nowUtc = new Date();
  const utcDateStr = nowUtc.toISOString().split("T")[0];
  const datetimeGeq = `${utcDateStr}T00:00:00Z`;
  const datetimeLeq = `${utcDateStr}T23:59:59Z`;

  try {
    const pagesNames = new Set();
    try {
      const pagesRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects?per_page=100`, {
        headers: { "Authorization": `Bearer ${apiToken}` }
      });
      const pagesData = await pagesRes.json();
      if (pagesData.success && pagesData.result) {
        pagesData.result.forEach(p => pagesNames.add(p.name));
      }
    } catch (e) {}

    const query = `
      query {
        viewer {
          accounts(filter: {accountTag: "${accountId}"}) {
            workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: "${datetimeGeq}", datetime_leq: "${datetimeLeq}"}) {
              dimensions { scriptName }
              sum { requests }
            }
          }
        }
      }
    `;
    
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    const result = await response.json();
    
    if (result.errors) return null;
    
    let workersReq = 0;
    let pagesReq = 0;
    const accounts = result?.data?.viewer?.accounts;
    
    if (accounts && accounts.length > 0) {
      const groups = accounts[0].workersInvocationsAdaptive;
      if (groups && groups.length > 0) {
        groups.forEach(group => {
          const reqs = group.sum.requests || 0;
          const scriptName = group.dimensions.scriptName;
          if (pagesNames.has(scriptName)) {
            pagesReq += reqs;
          } else {
            workersReq += reqs;
          }
        });
      }
    }
    return { workers: workersReq, pages: pagesReq, total: workersReq + pagesReq };
  } catch (e) {
    return null;
  }
}

async function sendTgMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

async function sendTgMessageMd(botToken, chatId, text, replyMarkup = null) {
  if (!botToken || !chatId) return;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = { chat_id: chatId, text: text, parse_mode: "MarkdownV2" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function editTgMessage(botToken, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: "MarkdownV2" })
  });
}

async function editTgMessageInline(botToken, chatId, messageId, text, inlineKeyboard) {
  await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
  });
}

async function answerCallbackQuery(botToken, callbackQueryId, text = "") {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

function escapeMd(text) {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function makeProgressBar(percent) {
  const totalSlots = 10;
  const filledSlots = Math.round(percent / 10);
  return "█".repeat(Math.min(filledSlots, totalSlots)) + "▒".repeat(Math.max(0, totalSlots - filledSlots));
}

function renderDashboardHTML(todayStats, config) {
  const limit = 100000;
  
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>CF Monitor</title>
  <style>
    :root[data-theme="dark"] {
      --bg: #000000; --text: #ededed; --text-muted: #a1a1aa; 
      --border: #333333; --hover-bg: #111111;
      --red: #ef4444; --orange: #f97316; --green: #22c55e; --blue: #3b82f6;
    }
    :root[data-theme="light"] {
      --bg: #ffffff; --text: #171717; --text-muted: #737373; 
      --border: #e5e5e5; --hover-bg: #f5f5f5;
      --red: #dc2626; --orange: #ea580c; --green: #16a34a; --blue: #2563eb;
    }

    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg); color: var(--text);
      margin: 0; padding: 40px 20px; font-size: 14px;
      line-height: 1.5; transition: background 0.2s;
    }
    .container { max-width: 1024px; margin: 0 auto; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

    .header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .header h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.5px; }
    .header p { margin: 4px 0 0; font-size: 12px; color: var(--text-muted); font-family: ui-monospace, monospace; }
    
    button {
      background: transparent; color: var(--text); border: 1px solid var(--border);
      padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; border-radius: 4px;
      transition: all 0.2s; font-family: inherit;
    }
    button:hover { background: var(--text); color: var(--bg); border-color: var(--text); }
    
    .data-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .data-table th, .data-table td { 
      padding: 12px; text-align: left; border-bottom: 1px solid var(--border);
    }
    .data-table th { font-size: 12px; font-weight: 500; color: var(--text-muted); text-transform: uppercase; }
    .data-table tbody tr:not(.history-row):hover { background-color: var(--hover-bg); }
    
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; }
    .bg-green { background-color: var(--green); }
    .bg-orange { background-color: var(--orange); }
    .bg-red { background-color: var(--red); }
    
    .progress-bar-bg { width: 100%; max-width: 150px; height: 4px; background: var(--border); display: flex; border-radius: 2px; overflow: hidden; }
    .progress-bar-fill { height: 100%; transition: width 0.3s; }

    .history-row { display: none; }
    .history-row.active { display: table-row; }
    .history-content { padding: 16px !important; background-color: transparent !important; }
    
    .month-group { margin-bottom: 8px; }
    .month-header {
      background-color: var(--hover-bg); padding: 10px 16px; border-radius: 6px; 
      cursor: pointer; display: flex; justify-content: space-between; align-items: center;
      font-size: 13px; font-weight: 600; transition: background 0.2s; border: 1px solid var(--border);
    }
    .month-header:hover { background-color: var(--border); }
    .month-grid {
      display: none; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); 
      gap: 10px; padding: 12px 4px 4px 4px;
    }
    .month-grid.active { display: grid; }
    .day-card {
      background-color: var(--hover-bg); padding: 10px; border-radius: 6px; 
      text-align: center; border: 1px solid var(--border);
    }
    .day-date { font-size: 11px; color: var(--text-muted); margin-bottom: 6px; }
    .day-value { font-size: 13px; font-weight: 600; color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>CF Monitor</h1>
        <p>SYS_RESET: UTC 00:00</p>
      </div>
      <div>
        <button onclick="toggleTheme()" id="themeBtn">THEME</button>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Usage (Today)</th>
          <th style="width: 80px;">Action</th>
        </tr>
      </thead>
      <tbody>
        ${config.cfAccounts.map((account) => {
          const row = todayStats.find(r => r.account_id === account.accountId) || {
            workers_requests: 0, pages_requests: 0
          };
          
          const workersReqs = row.workers_requests || 0;
          const pagesReqs = row.pages_requests || 0;
          const totalReqs = workersReqs + pagesReqs;

          const workersPercent = Number(Math.min((workersReqs / limit) * 100, 100).toFixed(1));
          const pagesPercent = Number(Math.min((pagesReqs / limit) * 100, 100 - workersPercent).toFixed(1));
          const totalPercent = workersPercent + pagesPercent;

          let dotClass = "bg-green";
          if (totalPercent >= 80) dotClass = "bg-red";
          else if (totalPercent >= 60) dotClass = "bg-orange";

          return `
            <tr>
              <td>
                <span class="status-dot ${dotClass}"></span>
                <strong>${account.name}</strong>
              </td>
              <td class="mono">
                <div style="margin-bottom: 8px; font-weight: 500;">
                  ${totalReqs.toLocaleString()} / 100,000
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill" style="width: ${workersPercent}%; background-color: var(--green);"></div>
                  <div class="progress-bar-fill" style="width: ${pagesPercent}%; background-color: var(--blue);"></div>
                </div>
              </td>
              <td>
                <button style="padding: 2px 8px; font-size: 10px;" onclick="toggleHistory('${account.accountId}')">History</button>
              </td>
            </tr>
            <tr class="history-row" id="history-${account.accountId}">
              <td colspan="3" class="history-content" id="history-content-${account.accountId}"></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  </div>

  <script>
    function toggleTheme() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const newTheme = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
    }
    if (localStorage.getItem('theme')) {
      document.documentElement.setAttribute('data-theme', localStorage.getItem('theme'));
    }

    async function toggleHistory(id) {
      const el = document.getElementById('history-' + id);
      const contentTd = document.getElementById('history-content-' + id);
      if (el.classList.contains('active')) {
        el.classList.remove('active');
        return;
      }
      contentTd.innerHTML = '<span class="mono" style="font-size:12px;color:var(--text-muted);">Loading...</span>';
      el.classList.add('active');
      try {
        const res = await fetch('/history?account_id=' + id);
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.length === 0) {
          contentTd.innerHTML = '<span class="mono" style="color:var(--text-muted);font-size:12px;">No history data found.</span>';
          return;
        }
        
        const groupedHistory = {};
        data.forEach(h => {
          const month = h.date_str.substring(0, 7); 
          if (!groupedHistory[month]) groupedHistory[month] = [];
          groupedHistory[month].push(h);
        });
        const monthKeys = Object.keys(groupedHistory).sort().reverse();
        
        let html = '';
        monthKeys.forEach((m) => {
          html += '<div class="month-group">';
          html += '<div class="month-header mono" onclick="this.nextElementSibling.classList.toggle(\\'active\\')">';
          html += '<span>' + m + '</span><span>▼</span></div>';
          html += '<div class="month-grid">';
          groupedHistory[m].forEach(h => {
            const hTotal = (h.workers_requests || 0) + (h.pages_requests || 0);
            html += '<div class="day-card mono">';
            html += '<div class="day-date">' + h.date_str.substring(5) + '</div>';
            html += '<div class="day-value">' + hTotal.toLocaleString() + '</div>';
            html += '</div>';
          });
          html += '</div></div>';
        });
        contentTd.innerHTML = html;
      } catch (err) {
        contentTd.innerHTML = '<span class="mono" style="color:var(--red);font-size:12px;">Failed to load history.</span>';
      }
    }
  </script>
</body>
</html>`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.syncData(env, true));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const config = getAppConfig(env);

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /", { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/history") {
      const accountId = url.searchParams.get("account_id");
      if (!accountId) return new Response("Bad Request", { status: 400 });
      const { results } = await env.DB.prepare("SELECT date_str, workers_requests, pages_requests FROM daily_stats WHERE account_id = ? ORDER BY date_str DESC LIMIT 90").bind(accountId).all();
      return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === `/tg-webhook`) {
      if (request.method !== "POST") return new Response("OK");
      
      if (config.tgWebhookSecret) {
        const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (secretToken !== config.tgWebhookSecret) {
          await sendTgMessage(config.tgBotToken, config.adminTgIds[0], `[SEC_WARN] ACCESS DENIED\nREASON: INVALID_WEBHOOK_TOKEN`);
          return new Response("Unauthorized", { status: 401 });
        }
      }

      try {
        const update = await request.json();
        
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message.chat.id;
          const messageId = cb.message.message_id;
          const data = cb.data;
          
          if (!config.adminTgIds.includes(chatId)) return new Response("OK");
          
          const userSetting = await env.DB.prepare("SELECT lang, cron_enabled FROM user_settings WHERE chat_id = ?").bind(chatId).first();
          const lang = userSetting?.lang || 'zh';
          
          if (data.startsWith("lang_")) {
            const newLang = data.split("_")[1];
            await env.DB.prepare("INSERT INTO user_settings (chat_id, lang) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET lang = excluded.lang").bind(chatId, newLang).run();
            await answerCallbackQuery(config.tgBotToken, cb.id, newLang === 'zh' ? "语言已切换" : "Language switched");
            await editTgMessage(config.tgBotToken, chatId, messageId, newLang === 'zh' ? "✅ 语言已切换为 *简体中文*\n您可以发送 /help 查看所有可用命令。" : "✅ Language switched to *English*\nYou can send /help to see all available commands\\.");
          } else if (data.startsWith("hist_acc_")) {
            const accId = data.replace("hist_acc_", "");
            const acc = config.cfAccounts.find(a => a.accountId === accId);
            if (acc) {
              const inline_keyboard = [
                [
                  { text: lang === 'zh' ? "7 天" : "7 Days", callback_data: `hist_r_${accId}_7_0` },
                  { text: lang === 'zh' ? "14 天" : "14 Days", callback_data: `hist_r_${accId}_14_0` }
                ],
                [
                  { text: lang === 'zh' ? "30 天 (分页)" : "30 Days (Paged)", callback_data: `hist_r_${accId}_30_0` }
                ]
              ];
              await editTgMessageInline(config.tgBotToken, chatId, messageId, lang === 'zh' ? `选择账号 *${escapeMd(acc.name)}* 的时间区间:` : `Select range for *${escapeMd(acc.name)}*:`, inline_keyboard);
            }
            await answerCallbackQuery(config.tgBotToken, cb.id);
          } else if (data.startsWith("hist_r_")) {
            const parts = data.split("_");
            const accId = parts[2];
            const range = parseInt(parts[3]);
            const page = parseInt(parts[4]);
            
            const acc = config.cfAccounts.find(a => a.accountId === accId);
            if (acc) {
              const { results } = await env.DB.prepare("SELECT date_str, workers_requests, pages_requests FROM daily_stats WHERE account_id = ? ORDER BY date_str DESC LIMIT ?").bind(accId, range).all();
              
              if (!results || results.length === 0) {
                await editTgMessage(config.tgBotToken, chatId, messageId, lang === 'zh' ? "没有找到历史数据。" : "No history data found\\.");
              } else {
                let displayedRows = results;
                let hasPrevious = false;
                let hasNext = false;
                
                if (range === 30) {
                  const pageSize = 10;
                  const totalPages = Math.ceil(results.length / pageSize);
                  displayedRows = results.slice(page * pageSize, (page + 1) * pageSize);
                  hasPrevious = page > 0;
                  hasNext = page < totalPages - 1;
                }
                
                let txt = lang === 'zh' 
                  ? `*统计历史报告*\n账号: \`${escapeMd(acc.name)}\`\n\\-\\-\\-\n` 
                  : `*History Report*\nAccount: \`${escapeMd(acc.name)}\`\n\\-\\-\\-\n`;
                  
                displayedRows.forEach(r => {
                  const total = r.workers_requests + (r.pages_requests || 0);
                  txt += `\`${r.date_str}\`: \`${total.toLocaleString()}\`\n`;
                });
                
                const navButtons = [];
                if (hasPrevious) {
                  navButtons.push({ text: lang === 'zh' ? "◀ 上一页" : "◀ Prev", callback_data: `hist_r_${accId}_${range}_${page - 1}` });
                }
                if (hasNext) {
                  navButtons.push({ text: lang === 'zh' ? "下一页 ▶" : "Next ▶", callback_data: `hist_r_${accId}_${range}_${page + 1}` });
                }
                
                const inline_keyboard = [];
                if (navButtons.length > 0) inline_keyboard.push(navButtons);
                inline_keyboard.push([{ text: lang === 'zh' ? "↩ 返回账号列表" : "↩ Back to Accounts", callback_data: "nav_hist_list" }]);
                
                await editTgMessageInline(config.tgBotToken, chatId, messageId, txt, inline_keyboard);
              }
            }
            await answerCallbackQuery(config.tgBotToken, cb.id);
          } else if (data === "nav_hist_list") {
            const inline_keyboard = config.cfAccounts.map(acc => [{ text: acc.name, callback_data: `hist_acc_${acc.accountId}` }]);
            await editTgMessageInline(config.tgBotToken, chatId, messageId, lang === 'zh' ? "请选择要查询历史的账号:" : "Please select an account for history:", inline_keyboard);
            await answerCallbackQuery(config.tgBotToken, cb.id);
          }
          return new Response("OK");
        }

        const message = update.message;
        if (message && message.text) {
          const chatId = message.chat.id;
          if (!config.adminTgIds.includes(chatId)) {
            await sendTgMessage(config.tgBotToken, chatId, `[SEC_WARN] ACCESS DENIED\nID: ${chatId}`);
            return new Response("OK");
          }
          
          const text = message.text.trim();
          const command = text.split('@')[0];
          
          const userSetting = await env.DB.prepare("SELECT lang, cron_enabled FROM user_settings WHERE chat_id = ?").bind(chatId).first();
          const lang = userSetting?.lang || 'zh';
          const cronEnabled = userSetting?.cron_enabled ?? 1;

          if (command === "/start") {
            await this.syncData(env, false);
            const latestDateRow = await env.DB.prepare("SELECT MAX(date_str) as max_date FROM daily_stats").first();
            
            if (!latestDateRow || !latestDateRow.max_date) {
              await sendTgMessageMd(config.tgBotToken, chatId, lang === 'zh' ? "\\[系统信息\\] 暂无可用数据" : "\\[SYS\\_INFO\\] NO DATA AVAILABLE");
            } else {
              const latestDate = latestDateRow.max_date;
              const { results: todayStats } = await env.DB.prepare("SELECT * FROM daily_stats WHERE date_str = ?").bind(latestDate).all();
              
              let replyText = lang === 'zh' ? `*汇报日期*: \`${latestDate}\`\n\n` : `*Report Date*: \`${latestDate}\`\n\n`;
              for (const acc of config.cfAccounts) {
                const row = todayStats.find(r => r.account_id === acc.accountId) || { workers_requests: 0, pages_requests: 0 };
                const totalReqs = row.workers_requests + row.pages_requests;
                const percentNum = Math.min((totalReqs / 100000) * 100, 100);
                let status = percentNum >= 80 ? "🔴临界" : (percentNum >= 60 ? "🟡警告" : "🟢正常");
                if (lang === 'en') status = percentNum >= 80 ? "🔴CRIT" : (percentNum >= 60 ? "🟡WARN" : "🟢NORM");
                
                const bar = makeProgressBar(percentNum);
                replyText += `*${escapeMd(acc.name)}*\n\`${totalReqs.toLocaleString()} / 100,000\`\n\`${bar} ${percentNum.toFixed(1)}%\` \\[${status}\\]\n\n`;
              }
              await sendTgMessageMd(config.tgBotToken, chatId, replyText.trim());
            }
          } else if (command === "/lang") {
            const inline_keyboard = [
              [
                { text: "简体中文", callback_data: "lang_zh" },
                { text: "English", callback_data: "lang_en" }
              ]
            ];
            await sendTgMessageMd(config.tgBotToken, chatId, "请选择机器人语言 / Please choose language:", { inline_keyboard });
          } else if (command === "/history") {
            const inline_keyboard = config.cfAccounts.map(acc => [{ text: acc.name, callback_data: `hist_acc_${acc.accountId}` }]);
            await sendTgMessageMd(config.tgBotToken, chatId, lang === 'zh' ? "请选择要查询历史的账号:" : "Please select an account for history:", { inline_keyboard });
          } else if (command === "/notify") {
            const newState = cronEnabled ? 0 : 1;
            await env.DB.prepare("INSERT INTO user_settings (chat_id, cron_enabled) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET cron_enabled = excluded.cron_enabled").bind(chatId, newState).run();
            const reply = lang === 'zh' 
              ? (newState ? "✅ 定时推送已*开启*" : "🔕 定时推送已*关闭*") 
              : (newState ? "✅ Scheduled reports *Enabled*" : "🔕 Scheduled reports *Disabled*");
            await sendTgMessageMd(config.tgBotToken, chatId, reply);
          } else if (command === "/help") {
            const helpText = lang === 'zh' 
              ? `*系统可用命令*\n\n/start \\- 获取当前统计\n/history \\- 查询历史记录\n/lang \\- 切换中英语言\n/notify \\- 开关定时推送\n/help \\- 显示此帮助信息`
              : `*Available Commands*\n\n/start \\- Get current stats\n/history \\- Query history\n/lang \\- Switch language\n/notify \\- Toggle schedule\n/help \\- Show this help`;
            await sendTgMessageMd(config.tgBotToken, chatId, helpText);
          }
        }
      } catch (e) {}
      return new Response("OK");
    }

    const latestDateRow = await env.DB.prepare("SELECT MAX(date_str) as max_date FROM daily_stats").first();
    const latestDate = latestDateRow?.max_date || new Date().toISOString().split("T")[0];
    const { results: todayStats } = await env.DB.prepare("SELECT * FROM daily_stats WHERE date_str = ? ORDER BY account_id ASC").bind(latestDate).all();
    const html = renderDashboardHTML(todayStats, config);
    
    return new Response(html, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff"
      }
    });
  },

  async syncData(env, isCron = false) {
    const config = getAppConfig(env);
    const nowUtc = new Date();
    const utcDateStr = nowUtc.toISOString().split("T")[0];
    const limit = 100000;
    
    const fetchResults = [];
    for (const account of config.cfAccounts) {
      const requests = await getWorkerStats(account.accountId, account.apiToken);
      fetchResults.push({ account, requests });
    }
    
    const { results: existingStats } = await env.DB.prepare("SELECT account_id, workers_requests, pages_requests FROM daily_stats WHERE date_str = ?").bind(utcDateStr).all();
    
    const insertStatements = [];
    const alertMessages = [];
    
    for (const { account, requests } of fetchResults) {
      if (!requests) {
        alertMessages.push(`[SYS_ERR]\nID: ${account.name}\nERR: API_FETCH_FAILED\nCHECK TOKEN OR NETWORK STATUS.`);
        continue; 
      }

      const totalReqs = requests.total;
      const row = existingStats.find(r => r.account_id === account.accountId);
      const oldTotal = row ? (row.workers_requests + (row.pages_requests || 0)) : 0;
      const oldLevel = Math.floor(((oldTotal / limit) * 100) / 20);
      const newLevel = Math.floor(((totalReqs / limit) * 100) / 20);
      
      if (newLevel > oldLevel && newLevel > 0) {
        const threshold = newLevel * 20; 
        alertMessages.push(`[SYS_ALERT]\nID: ${account.name}\nUSE: ${totalReqs.toLocaleString()} / 100,000\nLVL: > ${threshold}%\nSTATUS: LIMIT_APPROACHING`);
      }

      insertStatements.push(
        env.DB.prepare(`
          INSERT INTO daily_stats (account_name, account_id, date_str, workers_requests, pages_requests)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account_id, date_str) DO UPDATE SET 
          workers_requests = excluded.workers_requests,
          pages_requests = excluded.pages_requests,
          account_name = excluded.account_name
        `).bind(account.name, account.accountId, utcDateStr, requests.workers, requests.pages)
      );
    }

    if (alertMessages.length > 0) {
      const combinedAlerts = alertMessages.join('\n---\n');
      for (const adminId of config.adminTgIds) {
        await sendTgMessage(config.tgBotToken, adminId, combinedAlerts);
      }
    }

    if (insertStatements.length > 0) {
      await env.DB.batch(insertStatements);
    }

    if (isCron) {
      const currentHour = nowUtc.getUTCHours();
      const { results: todayStats } = await env.DB.prepare("SELECT * FROM daily_stats WHERE date_str = ?").bind(utcDateStr).all();
      
      for (const adminId of config.adminTgIds) {
        const userSetting = await env.DB.prepare("SELECT lang, cron_enabled FROM user_settings WHERE chat_id = ?").bind(adminId).first();
        const lang = userSetting?.lang || 'zh';
        const cronEnabled = userSetting?.cron_enabled ?? 1;
        
        if (!cronEnabled) continue; 
        
        const shouldPush = (lang === 'zh' && [4, 10, 16].includes(currentHour)) || 
                           (lang === 'en' && [12, 17, 23].includes(currentHour));
                           
        if (shouldPush) {
          let replyText = lang === 'zh' 
            ? `*定时报告* \\(UTC ${currentHour}:00\\)\n日期: \`${utcDateStr}\`\n\\-\\-\\-\n` 
            : `*Scheduled Report* \\(UTC ${currentHour}:00\\)\nDate: \`${utcDateStr}\`\n\\-\\-\\-\n`;
            
          for (const acc of config.cfAccounts) {
            const row = todayStats.find(r => r.account_id === acc.accountId) || { workers_requests: 0, pages_requests: 0 };
            const totalReqs = row.workers_requests + row.pages_requests;
            const percentNum = Math.min((totalReqs / 100000) * 100, 100);
            let status = percentNum >= 80 ? "🔴临界" : (percentNum >= 60 ? "🟡警告" : "🟢正常");
            if (lang === 'en') status = percentNum >= 80 ? "🔴CRIT" : (percentNum >= 60 ? "🟡WARN" : "🟢NORM");
            
            const bar = makeProgressBar(percentNum);
            replyText += `*${escapeMd(acc.name)}*\n\`${totalReqs.toLocaleString()} / 100,000\`\n\`${bar} ${percentNum.toFixed(1)}%\` \\[${status}\\]\n\n`;
          }
          await sendTgMessageMd(config.tgBotToken, adminId, replyText.trim());
        }
      }
    }
  }
};