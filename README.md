# CF-Monitor

一个基于Cloudflare Workers和D1数据库构建的无服务器监控仪表盘，用于统计Cloudflare Workers请求数据。

**[中文说明](#中文说明) | [English Documentation](#english-documentation)**

---

## 中文说明

**⚠️ 部署前须知 (Disclaimer)**
本项目依赖 Cloudflare API 与 Telegram Bot API 才能正常运行。在部署环境及填入任何 API 凭据之前，请务必仔细检阅核心代码的运行逻辑与安全性。建议您借助代码审计工具辅助核查，在确认代码无恶意行为且符合您需求后再确定是否使用。

### 核心特性

* **网页**: 访问 Worker 域名，提供简单的每日请求统计和完整历史记录查看。
* **Telegram BOT**: 支持中/英切换、并带有各自时区定时日报推送（可在Bot关闭；zh：UTC 04:00; 10:00; 16:00。 en：UTC 12:00; 17:00; 23:00），以及历史记录查询功能。
* **自动预警**: 当用量跨越 20%、40%、60%、80%、100% 阈值，或触发 API 异常时，主动向管理员推送预警。

---

### Telegram 机器人申请与配置教程

要完整使用本监控系统，您需要先拥有一个 Telegram 机器人，并获取其交互凭证。

#### 1. 申请机器人并获取 Token
1. 在 Telegram 搜索栏中搜索并打开 `@BotFather`。
2. 发送指令 `/newbot`，按照提示依次输入机器人的**显示名称 (Name)** 和唯一的**用户名 (Username**，必须以 `_bot` 或 `bot` 结尾)。
3. 创建成功后，BotFather 会返回一条包含 `HTTP API Token` 的消息（形如 `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`）。请妥善保存此 Token，它将作为环境变量 `TG_BOT_TOKEN` 使用。

#### 2. 获取管理员 TG ID
1. 在 Telegram 中搜索 `@userinfobot`（或其他可获取 ID 的机器人）。
2. 发送 `/start` 指令，机器人会返回您的账户信息，其中 `Id` 字段（一串纯数字，如 `111111111`）即为您个人的 TG ID。
3. 此数字将作为环境变量 `ADMIN_TG_ID` 使用。

#### 3. 配置机器人快捷菜单
1. 回到 `@BotFather`，发送指令 `/setcommands`。
2. 选择您刚才创建的机器人，将以下内容完整复制并发送，以建立菜单：

~~~text
start - 📊 获取当前最新用量统计
history - 📅 查询单个账号历史记录
lang - 🌐 切换机器人语言 (中/英)
notify - 🔔 开启或关闭定时推送
help - ℹ️ 获取系统帮助菜单
~~~

---

### Cloudflare 部署指南

#### 1. 初始化 D1 数据库
1. 在 Cloudflare 控制面板左侧导航栏，前往 **Workers & Pages** -> **D1 SQL 数据库**。
2. 点击**创建**，将数据库命名为 `cf-monitor-db`。
3. 进入该数据库的 **控制台 (Console)** 标签页，完整粘贴并执行以下建表语句：

~~~sql
CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    date_str TEXT NOT NULL,
    workers_requests INTEGER DEFAULT 0,
    pages_requests INTEGER DEFAULT 0,
    UNIQUE(account_id, date_str)
);

CREATE INDEX IF NOT EXISTS idx_date_str ON daily_stats(date_str);

CREATE TABLE IF NOT EXISTS user_settings (
    chat_id INTEGER PRIMARY KEY,
    lang TEXT DEFAULT 'zh',
    cron_enabled INTEGER DEFAULT 1
);
~~~

#### 2. 部署 Worker 代码 (二选一)

**方式 A: 控制台直接部署 (适合新手，最快捷)**
1. 导航至 **Workers & Pages** 概览页，点击 **创建** -> **创建 Worker**。
2. 为 Worker 命名（例如 `cf-monitor`），然后点击 **部署 (Deploy)**。
3. 部署成功后，点击 **编辑代码 (Edit code)** 进入代码编辑器。
4. 将本项目中的 `index.js` 完整代码粘贴并覆盖原有的默认代码。
5. 点击右上角的 **部署 (Deploy)** 并返回 Worker 的概述页面。

**方式 B: Fork 并关联 GitHub 自动部署 (适合需持续更新的用户)**
1. 将本项目 Fork 至您的个人 GitHub 仓库。
2. 在 Cloudflare 控制面板前往 **Workers & Pages** -> **创建**，选择 **连接到 Git (Continue with GitHub)**。
3. 授权关联您的 GitHub 账号，选择您刚刚 Fork 的 `CF-Monitor` 仓库。
4. 按系统提示完成向导。部署成功后，未来只需在 GitHub 更新代码，Cloudflare 将自动同步并重新部署。

#### 3. 绑定数据库与环境变量
1. 在 Worker 概述页面，进入 **设置 (Settings)** -> **绑定 (Bindings)** 页面，点击添加 **D1 数据库** 绑定：
   * **变量名称**: `DB`
   * **数据库**: 选择 `cf-monitor-db`
2. 进入 **设置** -> **变量和机密 (Variables and Secrets)** 页面，添加下文[环境变量配置](#环境变量配置)中所列的所有必需变量，然后部署生效。

#### 4. 绑定 Telegram Webhook (关键)
为了让您的 Worker 能接收到 Telegram 机器人的交互指令，必须将 Webhook 注册到 Telegram 服务器。
请将以下链接中的 `<您的Bot_Token>` 替换为上文获取的 `TG_BOT_TOKEN`，将 `<您的Worker域名>` 替换为您部署的 Worker 公网访问地址（例如 `cf-monitor.your-subdomain.workers.dev`），然后在**浏览器中访问**该拼接后的完整链接：

~~~text
https://api.telegram.org/bot<您的Bot_Token>/setWebhook?url=https://<您的Worker域名>/tg-webhook
~~~

*(注：如果您配置了 `TG_WEBHOOK_SECRET` 环境变量，请在上述 URL 尾部追加 `&secret_token=<您的Secret>`)*。
浏览器若返回 `{"ok":true,"result":true,"description":"Webhook was set"}` 即代表绑定成功。

#### 5. 配置 Cron 定时任务
1. 前往 Worker 的 **触发器 (Triggers)** 设置页面。
2. 添加 **Cron 触发器**，输入规则 `0 * * * *`（表示每小时整点执行），用于触发后台自动同步与告警判定，并根据多时区规则推送定时日报。

---

### 环境变量配置

请在 Worker 的 **设置 -> 变量和机密** 中配置以下环境变量。强烈建议将敏感 Token 设为“密钥 (Secret)”。

#### 基础安全与通知配置
* `TG_BOT_TOKEN`: Telegram 机器人 HTTP API Token。
* `ADMIN_TG_ID`: 接收告警的 Telegram User ID（支持多用户，用英文逗号分隔，如 `1111111,2222222`）。
* `TG_WEBHOOK_SECRET` (可选): 用于校验 Telegram Webhook 请求的 Header 密钥，提升安全性。自定义的英数字符串，需在绑定 Webhook 时同步提供。

#### 多账号挂载 (支持 1-20 个账号)
使用 `ACCOUNT_X_` 前缀顺序绑定目标账号，X 为递增序号。
* `ACCOUNT_1_NAME`: 自定义展示名称（例：`MAIN-ACC`）。
* `ACCOUNT_1_ID`: Cloudflare Account ID。
* `ACCOUNT_1_TOKEN`: Cloudflare API Token。

> **⚠️ API Token 权限配置警告（非常重要）**
> 
> 为了保证脚本能够成功拉取到 Workers 和 Pages 的用量数据，您在 Cloudflare 创建此 API Token 时，编辑策略必须选择 `整个账户` ，**必须且仅需**赋予以下权限：
> 1. `Developer Platform` -> `Account Analytics (账户分析)` -> `Read (读取)`
> 2. `Developer Platform` -> `Workers Scripts (Workers 脚本)` -> `Read (读取)`
> 3. `Analytics & Logs` -> `Pages (Pages 项目)` -> `Read (读取)`

*(可按需添加 `ACCOUNT_2_...` 等环境变量，保存部署后即刻生效)*

---

## English Documentation

**⚠️ Important Notice before Deployment (Disclaimer)**
This project relies fundamentally on the Cloudflare API and Telegram Bot API to function. Before deploying or providing any API credentials, please ensure you have thoroughly reviewed the source code for security and operational logic. It is highly recommended to audit the code, and only proceed with usage after confirming it meets your security standards.

### Features

* **Web Page**: Access the Worker domain to view simple daily request statistics and the complete request history.
* **Telegram Bot**: Supports switching between Chinese and English, features scheduled daily report notifications tailored to respective time zones (can be disabled; Chinese: UTC 04:00, 10:00, 16:00; English: UTC 12:00, 17:00, 23:00), and includes a history lookup function.
* **Automatic Alerts**: Proactively send alerts to administrators when usage thresholds of 20%, 40%, 60%, 80%, or 100% are exceeded, or when API anomalies occur.

---

### Telegram Bot Setup Guide

To fully utilize this monitoring system, you must configure a Telegram Bot and retrieve its credentials.

#### 1. Create a Bot & Obtain Token
1. Search for `@BotFather` in Telegram and start a chat.
2. Send the command `/newbot` and follow the prompts to specify a **Name** and a unique **Username** (must end with `_bot` or `bot`).
3. Upon success, BotFather will provide an `HTTP API Token` (e.g., `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`). Keep this secure; it will be your `TG_BOT_TOKEN`.

#### 2. Obtain Admin TG ID
1. Search for `@userinfobot` (or any similar ID retrieval bot) in Telegram.
2. Send the `/start` command. The bot will reply with your profile info. The `Id` field (a purely numerical string like `111111111`) is your Telegram ID.
3. This number will be your `ADMIN_TG_ID`.

#### 3. Configure Bot Command Menu
1. Return to `@BotFather` and send the command `/setcommands`.
2. Select your newly created bot, copy and paste the following block to establish the menu:

~~~text
start - 📊 Get current stats
history - 📅 Query account history
lang - 🌐 Switch language (EN/ZH)
notify - 🔔 Toggle scheduled reports
help - ℹ️ Show help menu
~~~

---

### Cloudflare Deployment Guide

#### 1. Initialize D1 Database
1. Go to **Workers & Pages** -> **D1 SQL Database** in your Cloudflare dashboard.
2. Click **Create**, and name the database `cf-monitor-db`.
3. Open the **Console** tab for this database, paste and execute the following schema:

~~~sql
CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    date_str TEXT NOT NULL,
    workers_requests INTEGER DEFAULT 0,
    pages_requests INTEGER DEFAULT 0,
    UNIQUE(account_id, date_str)
);

CREATE INDEX IF NOT EXISTS idx_date_str ON daily_stats(date_str);

CREATE TABLE IF NOT EXISTS user_settings (
    chat_id INTEGER PRIMARY KEY,
    lang TEXT DEFAULT 'zh',
    cron_enabled INTEGER DEFAULT 1
);
~~~

#### 2. Deploy Worker Code (Choose One Method)

**Method A: Direct Dashboard Deployment (Quickest & Beginner Friendly)**
1. Navigate to the **Workers & Pages** overview, click **Create** -> **Create Worker**.
2. Name your Worker (e.g., `cf-monitor`) and click **Deploy**.
3. Once deployed, click **Edit code**.
4. Paste the entire `index.js` source code from this project, overriding the default script.
5. Click **Deploy** in the top right corner and return to the Worker overview.

**Method B: Fork & Connect GitHub (Best for continuous updates)**
1. Fork this project to your personal GitHub account.
2. In the Cloudflare Dashboard, navigate to **Workers & Pages** -> **Create** and select **Continue with GitHub**.
3. Authorize your GitHub account and select your forked `CF-Monitor` repository.
4. Follow the setup wizard. Once deployed, any future updates pushed to your GitHub repo will automatically trigger a new deployment in Cloudflare without needing a CLI.

#### 3. Bind Database and Environment Variables
1. From the Worker overview, go to **Settings** -> **Bindings**. Add a new **D1 Database** binding:
   * **Variable name**: `DB`
   * **Database**: Choose `cf-monitor-db`
2. Go to **Settings** -> **Variables and Secrets**. Add all the necessary environment variables listed in the [Environment Variables](#environment-variables) section below, then deploy.

#### 4. Bind Telegram Webhook (Crucial Step)
To enable your Worker to process commands sent to your Telegram Bot, you must register your Worker's route with Telegram via a Webhook.
Replace `<YOUR_BOT_TOKEN>` with your `TG_BOT_TOKEN`, and `<YOUR_WORKER_DOMAIN>` with your assigned Worker URL (e.g., `cf-monitor.your-subdomain.workers.dev`). **Visit the resulting URL in your web browser**:

~~~text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER_DOMAIN>/tg-webhook
~~~

*(Note: If you configured the `TG_WEBHOOK_SECRET` environment variable, append `&secret_token=<YOUR_SECRET>` to the URL)*.
If successful, the browser will display `{"ok":true,"result":true,"description":"Webhook was set"}`.

#### 5. Configure Cron Trigger
1. Navigate to the Worker's **Triggers** settings page.
2. Add a **Cron Trigger** and set the rule to `0 * * * *` (Executes at the top of every hour). This powers background data synchronization, threshold alerting, and scheduled notifications.

---

### Environment Variables

Configure the following under your Worker's **Settings -> Variables and Secrets**. We strongly recommend encrypting sensitive tokens.

#### Security & Notification Setup
* `TG_BOT_TOKEN`: Your Telegram Bot API token.
* `ADMIN_TG_ID`: Telegram User IDs authorized to receive alerts (Separate multiple IDs with commas, e.g., `1111111,2222222`).
* `TG_WEBHOOK_SECRET` (Optional): A custom alphanumeric string used to validate incoming Telegram Webhook headers for enhanced security. Must match the secret provided during Webhook registration.

#### Account Targeting (Supports 1-20 Accounts)
Bind target accounts sequentially using the `ACCOUNT_X_` prefix.
* `ACCOUNT_1_NAME`: Custom display name (e.g., `MAIN-ACC`).
* `ACCOUNT_1_ID`: Target Cloudflare Account ID.
* `ACCOUNT_1_TOKEN`: Target Cloudflare API Token.

> **⚠️ API Token Permissions Warning (CRITICAL)**
> 
> To ensure the script can successfully retrieve usage data for Workers and Pages, you must select "Entire Accounts" for the edit policy when creating this API Token in Cloudflare, and grant **only** the following permissions::
> 1. `Developer Platform` -> `Account Analytics` -> `Read`
> 2. `Developer Platform` -> `Workers Scripts` -> `Read`
> 3. `Analytics & Logs` -> `Pages` -> `Read`

*(Repeat for `ACCOUNT_2_...` to dynamically add more accounts. Changes apply immediately upon deployment.)*