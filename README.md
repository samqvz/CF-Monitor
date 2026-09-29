# CF-Monitor

一个基于 Cloudflare Workers 和 D1 数据库构建的无服务器监控仪表盘，单文件部署，简单易用。作用是实时统计 Cloudflare Workers 每日的请求数据。

> 本项目**没有网页界面**，所有功能都在 Telegram 里完成。

**[中文说明](#中文说明) | [English Documentation](README_EN.md)**

---

**⚠️ 部署前须知**

本项目需要用到 Cloudflare API 和 Telegram API Token。在部署环境及填入任何 API 凭据之前，请务必仔细检阅核心代码的运行逻辑与安全性。建议您借助代码审计工具辅助核查，在确认代码无恶意行为且符合您需求后再确定是否使用。

---

## 这个工具能做什么

- **历史数据**：可以按账号查看历史用量。
- **自动预警**：用量一旦超过你设定的百分比（比如 80%），机器人会主动发消息提醒你；可设置**最小间隔**，避免用量抖动导致重复打扰。
- **定时日报**：在指定的时间（比如每天 13:00 和 22:00）自动推送一份用量报告。
- **安全防护**：只有真正来自 Telegram 的请求才能调用机器人；所有异常都会被记录下来。

---

## 开始前，请先准备好

1. 一个 **Cloudflare 账号**（免费注册即可）：<https://dash.cloudflare.com/sign-up>
2. 一个 **Telegram 账号**（手机或电脑都能装）：<https://telegram.org/>
3. 一台能上网的电脑和一个浏览器

---

## 第一步：申请一个 Telegram 机器人，拿到 Token

1. 打开 Telegram，在最上面的搜索框里搜索 **`@BotFather`**，点进去。
2. 在聊天框里发送 `/newbot`，然后按它的提示操作：
   - 先输入机器人的**显示名称**（随便取，比如 `我的用量监控`）。
   - 再输入机器人的**用户名**，必须以 `_bot` 结尾（比如 `my_cf_monitor_bot`）。
3. 创建成功后，BotFather 会回一条消息，里面有一串 `HTTP API Token`，长这样：
   ```text
   123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
   ```
4. **把这串 Token 复制下来，保存到记事本**。后面要填到环境变量 `TG_BOT_TOKEN` 里。

> ⚠️ Token 就是机器人的「钥匙」，不要发给任何人、不要发到公开的地方。

---

## 第二步：拿到你自己的 Telegram 数字 ID

1. 在 Telegram 里搜索 **`@userinfobot`**，点进去，发送 `/start`。
2. 它会回复你的账号信息，其中有一行 `Id`，是一串纯数字（比如 `111111111`）。
3. **把这串数字记下来**，后面要填到环境变量 `ADMIN_TG_ID` 里。这表示「这个 ID 的人可以管理机器人」。

> 如果你还想让别人也能查看（但不能管理），把他们的 ID 用英文逗号隔开，填到 `VIEWER_TG_ID` 即可。

---

## 第三步：生成 Webhook 安全密钥（必做）

**这一步在做什么？** 我们要生成一串别人猜不到的随机字符，用来验证「消息确实来自 Telegram」，防止有人冒充 Telegram 来调用你的机器人。

> ✅ 密钥要求：**1–256 个字符**，**只能包含** 大写字母、小写字母、数字、下划线 `_`、短横线 `-`。

### 方法一：在线网站一键生成

1. 用浏览器打开这个网址：<https://it-tools.tech/token-generator>
2. 在页面里这样设置（照着勾就行）：
   - ✅ 勾选 **Uppercase**（大写字母）
   - ✅ 勾选 **Lowercase**（小写字母）
   - ✅ 勾选 **Numbers**（数字）
   - ⬜ **取消勾选 Symbols**（符号）—— ⚠️ 一定要取消，因为 Telegram 不允许符号
   - **Length（长度）** 填 `32`
3. 页面上会立刻出现一串随机字符（形如 `aB3dE7gH9kLmN2pQrS5tU8vWxYzA1bC4`）。
4. 点击它旁边的 **复制图标**，把这串字符复制下来，**粘贴到记事本保存**。这就是你的 **Webhook 安全密钥**。

### 方法二：命令行

如果你习惯用命令行，也可以这样生成：

```bash
# macOS / Linux
openssl rand -hex 32

# 装了 Node.js 的话
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 📌 生成好之后，这串字符就是环境变量 `TG_WEBHOOK_SECRET` 的值，先放在记事本里，第六步会用到。

---

## 第四步：创建数据库（D1）

1. 登录 Cloudflare 后台 <https://dash.cloudflare.com/>
2. 在左侧菜单找到 **Workers & Pages**（有些版本叫 **计算 / Compute**），点进去。
3. 在左侧或顶部找到 **D1 SQL 数据库 / D1**，点击 **创建 / Create**。
4. 数据库名字填 **`cf-monitor-db`**，然后创建。
5. 进入这个数据库，找到 **控制台 / Console** 标签页。
6. 打开项目里的 [`schema.sql`](schema.sql) 文件，**把里面的全部内容复制粘贴**到控制台里，点击执行。

> ✅ 提示：`schema.sql` 是「可重复执行」的，就算你不小心点了两次也不会出错。>   
> 🧩 如果你以前装过旧版本，只要重新执行一次最新的 `schema.sql`，就会自动补上新增的表，老数据不会丢。

---

## 第五步：部署 Worker 代码（两选一）

### 方式 A：在网页上直接粘贴（推荐）

1. 回到 **Workers & Pages** 概览页，点击 **创建 / Create** → **创建 Worker / Create Worker**。
2. 给 Worker 起个名字（比如 `cf-monitor`），点击 **部署 / Deploy**。
3. 部署成功后，点击 **编辑代码 / Edit code**，进入代码编辑器。
4. 打开项目里的 [`index.js`](index.js)，**把全部代码复制**，粘贴进编辑器，覆盖掉原来默认的示例代码。
5. 点击右上角的 **部署 / Deploy**，然后返回 Worker 的概览页。

### 方式 B：Fork 到自己的 GitHub，自动部署（自用项目很少更新，没必要 Fork）

1. 把这个项目 Fork 到你自己的 GitHub 仓库。
2. 在 Cloudflare 后台进入 **Workers & Pages** → **创建**，选择 **连接到 Git / Continue with GitHub**。
3. 授权你的 GitHub 账号，选择刚刚 Fork 的 `CF-Monitor` 仓库，按提示完成向导。
4. 以后只要在 GitHub 上更新代码，Cloudflare 就会自动重新部署。

---

## 第六步：绑定数据库和填写配置

### 6.1 绑定数据库

1. 进入你的 Worker，打开 **设置 / Settings** → **绑定 / Bindings**。
2. 点击添加 **D1 数据库** 绑定：
   - **变量名称 / Variable name** 填 `DB`
   - **数据库 / Database** 选择刚才创建的 `cf-monitor-db`

### 6.2 填写环境变量

1. 进入 **设置 / Settings** → **变量和机密 / Variables and Secrets**。
2. 按下面的表格，一条一条添加。带 ✅ 的是必填，其余是可选。
3. 敏感的值（Token、密钥）建议选择类型为 **密钥 / Secret**（加密保存）。
4. 全部填完后，点击部署生效。

**必填项：**

| 变量名                 | 填什么                                      |
| ------------------- | ---------------------------------------- |
| `TG_BOT_TOKEN`      | 第一步拿到的机器人 Token。                         |
| `ADMIN_TG_ID`       | 第二步拿到你的 Telegram chat_id（多个用英文逗号隔开）。                 |
| `TG_WEBHOOK_SECRET` | 第三步生成的 Webhook 安全密钥。**不填的话机器人将完全收不到消息。** |

**可选项（不填也能跑）：**

| 变量名                      | 作用                                         | 默认      |
| ------------------------ | ------------------------------------------ | ------- |
| `SUPER_ADMIN_TG_ID`      | 超级管理员 ID。不填时自动取 `ADMIN_TG_ID` 的第一个。        | 取第一个管理员 |
| `VIEWER_TG_ID`           | 只读用户 ID（多个用逗号隔开），只能查询、不能管理。                | 无       |
| `TG_WEBHOOK_SECRET_PREV` | 上一把旧密钥，用于**换密钥时不中断**服务（见[换密钥](#换密钥不中断服务)）。 | 无       |
| `TG_WEBHOOK_ENFORCE_IP`  | 填 `true` 时只放行 Telegram 官方网段的请求。            | 关闭      |
| `TG_IP_RANGES`           | 自定义 IP 白名单网段（逗号分隔的 CIDR），仅当 `TG_WEBHOOK_ENFORCE_IP=true` 时生效。 | Telegram 官方网段 |
| `RATE_LIMIT_MAX`         | 机器人命令限流：窗口内最多几条。                           | `20`    |
| `RATE_LIMIT_WINDOW_SEC`  | 限流窗口长度（秒）。                                 | `60`    |

> 🛡️ **关于 IP 白名单**：`TG_WEBHOOK_ENFORCE_IP=true` 时，Worker 只放行来源 IP 落在白名单网段内的请求，其余一律返回 `403`（并记一条 `webhook_ip_rejected` 安全事件）。不填 `TG_IP_RANGES` 时使用内置的 [Telegram 官方出口网段](https://core.telegram.org/resources/cidr.txt)（9 段 IPv4 + 5 段 IPv6）。若你的请求经过了自建反向代理，或需要额外放行某个固定出口 IP，可用英文逗号分隔填写，例如 `1.2.3.0/24,2001:db8::/32`；格式非法或全部无效时会自动回退到内置网段。

### 6.3 添加要监控的 Cloudflare 账号（支持 1–20 个）

用 `ACCOUNT_序号_` 前缀，按顺序添加。例如监控第一个账号：

| 变量名               | 填什么                           |
| ----------------- | ----------------------------- |
| `ACCOUNT_1_NAME`  | 给这个账号起的展示名（比如 `主账号`）。      |
| `ACCOUNT_1_ID`    | 这个 Cloudflare 账号的 Account ID。 |
| `ACCOUNT_1_TOKEN` | 这个账号的 API Token。              |

想再加一个，就用 `ACCOUNT_2_NAME`、`ACCOUNT_2_ID`、`ACCOUNT_2_TOKEN`，依此类推。

> **⚠️ 创建 API Token 时的权限设置（很重要，否则读不到数据）**
>
> 在 Cloudflare 创建 API Token 时，编辑范围选 **整个账户 / All accounts**，并且**只需要**勾选下面三项权限：
>
> 1. `Developer Platform` → `Account Analytics` → `Read`
> 2. `Developer Platform` → `Workers Scripts` → `Read`
> 3. `Analytics & Logs` → `Pages` → `Read`

---

## 第七步：把机器人接到你的 Worker（关键一步）

这一步是告诉 Telegram：「以后有消息，就转发到这个 Worker 上。」

1. 先记下你的 Worker 网址（形如 `https://cf-monitor.xxxx.workers.dev`）。
2. 把下面这段网址里的三个占位符替换掉，然后在**浏览器地址栏**里访问它：
   ```text
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<WORKER_DOMAIN>/tg-webhook&secret_token=<WEBHOOK_SECRET>
   ```
   - 把 `<BOT_TOKEN>` 换成第一步的 `TG_BOT_TOKEN`
   - 把 `<WORKER_DOMAIN>` 换成你的 Worker 域名（不带 `https://`）
   - 把 `<WEBHOOK_SECRET>` 换成第三步生成的 `TG_WEBHOOK_SECRET`
   举个例子，替换完长这样：
   ```text
   https://api.telegram.org/bot123456789:ABCdef.../setWebhook?url=https://cf-monitor.xxxx.workers.dev/tg-webhook&secret_token=aB3dE7gH9kLmN2pQrS5tU8vWxYzA1bC4
   ```
3. 浏览器如果返回下面这行，就代表绑定成功了：
   ```json
   {"ok":true,"result":true,"description":"Webhook was set"}
   ```

> ⚠️ **千万记得带上 `secret_token` 这一段**。没配置 `TG_WEBHOOK_SECRET` 时，会**拒绝所有消息**，机器人会完全不理你。

---

## 第八步：设置定时任务

本工具用一个 **Cloudflare Cron 触发器**来实现「每 15 分钟自动检查一次」。设置方法：

1. 进入你的 Worker，打开 **触发器 / Triggers** 设置页。
2. 找到 **Cron 触发器 / Cron Triggers**，点击添加。
3. 在输入框里填入下面这条规则，然后保存：
   ```text
   */15 * * * *
   ```
   > 这条规则的意思是「每 15 分钟执行一次」，可以根据自身需求设置。
4. 保存后，系统就会自动每 15 分钟帮你拉取一次用量、检查是否需要预警、到点推送日报。

> 💡 每 15 分钟检查一次，意味着你的用量提醒会更及时；而**定时日报只会在你设定的时间点推送一次**，不会因为检查频繁而重复打扰你。

---

## 第九步：配置机器人

### 9.1 跟机器人说句话

在 Telegram 里找到你的机器人，发送 `/start`。如果它能回复用量数据，说明一切正常。

### 9.2：配置机器人快捷菜单

1. 打开 Telegram，搜索 **`@BotFather`**，进入对话（就是第一步创建机器人的那个对话）。
2. 发送命令 **`/setcommands`**。
3. BotFather 会让你选择要设置的机器人，**点选刚创建的那个**。
4. 它会回复一句提示，然后让你把命令列表发过去。把下面**整段**复制、粘贴发送给它（每行一条，格式是 `命令 - 说明`）：

   ```text
   start - 查看当前用量
   history - 查询历史记录
   lang - 切换中英文
   whoami - 查看我的身份
   settings - 打开设置菜单
   notify - 开关定时日报
   report_hours - 设置日报推送时间
   timezone - 设置时区
   alert_thresholds - 设置预警阈值
   alert_interval - 设置预警最小间隔
   monitor_accounts - 设置推送账号范围
   sync - 立即同步数据
   help - 显示帮助
   ```
5. BotFather 回复 `Success!` 就代表设置好了。回到你的机器人，点聊天框左下角的菜单按钮（或输入 `/`），就能看到命令列表。

> 💡 命令后面的中文说明可以按自己喜好改，不影响使用；但 `命令` 本身（每行「 - 」前面那部分）请保持与上面一致。

---

## 功能设置

**自动预警**和**定时日报**都可以自由设置。所有设置都在 **Telegram 机器人**里完成（本项目没有网页设置界面）。

在 Telegram 里给机器人发送 `/settings`，会弹出一个设置菜单：**开关类**（定时日报、自动预警、API 异常告警）以及**预警最小间隔、推送账号范围**可以直接点按钮切换；**推送时间、时区、预警阈值**改为由你自己输入，请用下面这些命令设置：

| 命令                  | 作用                           | 例子                            |
| ------------------- | ---------------------------- | ----------------------------- |
| `/settings`         | 打开设置菜单（图形按钮）                 | `/settings`                   |
| `/notify`           | 一键开关定时日报                     | `/notify`                     |
| `/report_hours`     | 设置日报推送时间（0–23 的整点，逗号分隔）      | `/report_hours 9,18`          |
| `/timezone`         | 设置时区                         | `/timezone +8`                |
| `/alert_thresholds` | 设置预警阈值（1–100 的百分比，逗号分隔）      | `/alert_thresholds 50,80,100` |
| `/alert_interval`   | 设置预警最小间隔（分钟，0 表示不限制）         | `/alert_interval 60`          |
| `/monitor_accounts` | 设置推送账号范围（`all` 或账号名，多个用逗号分隔） | `/monitor_accounts 主账号,博客`    |

> 🔁 优先级：**个人设置（Telegram） > 全局默认（数据库） > 系统内置默认值**。>   
> 全局默认值需要直接在 D1 控制台执行 SQL 维护（面向进阶用户），一般无需改动；日常用 Telegram 设置即可。

### 全部可配置参数与默认值一览

| 参数       | 含义                | 可选值                   | 系统默认值               | 设置方式                              |
| -------- | ----------------- | --------------------- | ------------------- | --------------------------------- |
| 定时日报开关   | 是否推送定时日报          | 开 / 关                 | **开**               | `/settings` 按钮或 `/notify`         |
| 推送时间     | 每天在哪些整点推送（本地时间）   | 0–23 的整点，可多个          | **13:00、22:00**      | `/report_hours`                   |
| 时区       | 推送时间按哪个时区计算       | UTC-12:00 ~ UTC+14:00 | **UTC+8**           | `/timezone`                       |
| 自动预警开关   | 是否推送用量预警          | 开 / 关                 | **开**               | `/settings` 按钮                    |
| 预警阈值     | 用量达到哪些百分比时预警      | 1–100 的百分比，可多个        | **20、40、60、80、100** | `/alert_thresholds`               |
| 预警最小间隔   | 同一账号两次阈值预警之间的最短间隔 | 0–1440 分钟（0 = 不限制）    | **15 分钟**           | `/alert_interval` 或 `/settings`   |
| 推送账号范围   | 预警和日报只针对哪些账号      | `all`（全部）或账号名列表       | **全部账号**            | `/monitor_accounts` 或 `/settings` |
| API 异常告警 | 拉取数据失败时是否提醒       | 开 / 关                 | **开**               | `/settings` 按钮                    |

> ℹ️ 「检查频率」由第八步的 Cron 触发器决定；`/alert_interval` 控制的是**同一账号重复预警之间的最小间隔**，用来避免用量上下抖动时反复打扰。>   
> ℹ️ 所有设置都会保存在数据库里，重启或重新部署后依然生效。

---

## 常用命令一览

| 命令              | 谁能用 | 作用                                           |
| --------------- | --- | -------------------------------------------- |
| `/start`        | 所有人 | 查看当前最新用量                                     |
| `/history`      | 所有人 | 查询历史记录（可带账号名与月份/日期，如 `/history 主账号 2026-09`） |
| `/lang`         | 所有人 | 切换中文 / 英文                                    |
| `/whoami`       | 所有人 | 查看自己的身份与 ID                                  |
| `/help`         | 所有人 | 显示帮助                                         |
| `/settings`     | 管理员 | 打开设置菜单                                       |
| `/notify`       | 管理员 | 开关定时日报                                       |
| `/report_hours` | 管理员 | 设置日报推送时间                                     |
| `/timezone`     | 管理员 | 设置时区                                         |
| `/alert_thresholds` | 管理员 | 设置预警阈值                                   |
| `/alert_interval` | 管理员 | 设置预警最小间隔                                   |
| `/monitor_accounts` | 管理员 | 设置推送账号范围                                 |
| `/sync`         | 管理员 | 立即手动同步一次数据                                   |

> 「管理员」指 `ADMIN_TG_ID` / `SUPER_ADMIN_TG_ID` 里的账号。非授权账号发消息不会得到任何回复（这是故意的，避免暴露机器人存在）。

### 历史数据怎么查

在 Telegram 里发送 `/history`，机器人会先让你**选账号**，再**选时间范围**（近 10 / 30 / 90 天），然后给出：

1. **汇总卡片**：合计请求、可用总量、日均、峰值、谷值、Workers/Pages 构成、峰值等级；
2. 点「展开每日明细」后，进入**分页明细**，**每页 10 天**，可用「首页 / 上页 / 下页 / 末页」翻页，也可以直接点下方页码**跳页**。

> 📝 账号名一律显示你在环境变量里设置的 `ACCOUNT_N_NAME`（例如「主账号」），**不会显示 Cloudflare 的账号信息**。
>
> 🧮 「全部账号汇总」的可用总量 = **账号数 × 100,000**（例如 3 个账号即 300,000），因此比例是按全部账号的总额度计算的。

也可以直接用命令查询。格式为 `/history [账号] [时间段]`，**两个参数都可以省略**（省略账号则列出全部账号供选择；省略时间段则默认查近 30 天）：

| 例子                        | 含义                   |
| ------------------------- | -------------------- |
| `/history 主账号`            | 查看「主账号」近 30 天        |
| `/history 主账号 10`         | 查看「主账号」近 10 天        |
| `/history 主账号 2026-09`    | 查看「主账号」2026 年 9 月    |
| `/history 主账号 2026-09-28` | 查看「主账号」2026-09-28 当天 |

---

## 换密钥（不中断服务）

如果哪天你觉得密钥可能泄露了，想换一把新的，可以做到**服务不中断**：

1. 按第三步的方法，再生成一把**新密钥**。
2. 在 Cloudflare 环境变量里：
   - 把**旧密钥**移到 `TG_WEBHOOK_SECRET_PREV`
   - 把**新密钥**填进 `TG_WEBHOOK_SECRET`
   - 保存并部署（此时新旧密钥都会被接受，服务不受影响）
3. 重新执行第七步的网址，这次用**新密钥**注册 Webhook。
4. 观察一段时间，确认日志里不再出现 `webhook_auth_failed` 之后，把 `TG_WEBHOOK_SECRET_PREV` 删掉，再部署一次。

---

## 安全事件记录

所有异常（比如密钥不对、权限不足）都会记录到数据库的 `security_events` 表里。你可以在 D1 控制台执行下面这句查看最近的记录：

```sql
SELECT ts, event_type, severity, actor, ip, detail
FROM security_events
ORDER BY ts DESC LIMIT 50;
```

| 事件类型                     | 严重级别        | 含义                               |
| ------------------------ | ----------- | -------------------------------- |
| `webhook_auth_failed`    | crit        | Webhook 密钥缺失或不匹配（疑似伪造请求）         |
| `webhook_ip_rejected`    | crit        | 来源 IP 不在 Telegram 网段（需开启 IP 白名单） |
| `command_auth_denied`    | crit / warn | 命令鉴权失败                           |
| `callback_auth_denied`   | warn        | 按钮越权                             |
| `tg_rate_limited`        | warn        | 命令触发限流                           |
| `webhook_secret_missing` | warn        | Webhook 密钥未配置                    |

> 同一类事件在 5 分钟内只会给你推送一次提醒，避免「告警轰炸」；日志保留 7 天后自动清理。

---

## 常见问题（FAQ）

**Q1：机器人完全不回复我，怎么办？**  
先检查两件事：① 环境变量里有没有填 `TG_WEBHOOK_SECRET`；② 第七步注册 Webhook 时有没有带上 `secret_token`。这两个是机器人「收不到消息」最常见的原因。

**Q2：访问 Worker 网址显示 Not Found，是不是部署失败了？**  
不是。本项目没有网页界面，Worker 只处理 Telegram 的 Webhook。只要机器人能回复 `/start`，就说明部署成功。

**Q3：收不到定时日报？**  
检查 ① 日报开关是否打开；② 推送时间是否包含「当前时间」；③ 时区是否设置正确；④ 推送账号范围是否把该账号排除在外了。注意时间是按你设置的时区计算的。

**Q4：预警太频繁 / 太安静？**  
用 `/alert_thresholds` 调整阈值，用 `/alert_interval` 调整最小间隔（设大一点可减少打扰，设 0 则每次跨越阈值都提醒），用 `/monitor_accounts` 只关注重点账号。

**Q5：用量数据一直是 0？**  
多半是 Cloudflare 的 API Token 权限没给对。请回到 6.3 节，确认三项权限都勾选了，并且编辑范围选了「整个账户」。

**Q6：为什么发消息没反应？**  
如果你不在 `ADMIN_TG_ID` / `VIEWER_TG_ID` 名单里，机器人会**故意不回复**。请把你的 ID 加到对应变量里。

**Q7：历史数据能保存多久？**  
每个账号最多保留最近 90 天的每日记录，历史查询的时间范围上限也是 90 天。

---

## 许可

本项目基于 GNU GPL v3 许可，详见 [LICENSE](LICENSE)。
