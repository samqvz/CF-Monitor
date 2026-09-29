# CF-Monitor

A serverless monitoring dashboard built on Cloudflare Workers and a D1 database — single-file deployment, simple to use. It tracks your Cloudflare Workers' daily request data in real time.

> This project has **no web interface** — everything happens inside Telegram.

**[中文说明](README.md) | [English Documentation](#english-documentation)**

---

**⚠️ Before you deploy**

This project requires a Cloudflare API and a Telegram API Token. Before setting up the environment and entering any API credentials, please carefully review the core code's execution logic and security. We recommend using a code-audit tool to help verify it, and only proceed once you've confirmed the code has no malicious behaviour and fits your needs.

---

## What this tool does

* **History data**: view historical usage by account.
* **Automatic alerts**: when usage crosses a percentage you set (e.g. 80%), the bot messages you proactively; a **minimum interval** prevents repeated nudges when usage fluctuates.
* **Scheduled reports**: a usage report is pushed automatically at the times you choose (e.g. 13:00 and 22:00 every day).
* **Security built in**: only genuine Telegram requests can call the bot; every anomaly is logged.

---

## Before you start, prepare these

1. A **Cloudflare account** (free sign-up): <https://dash.cloudflare.com/sign-up>
2. A **Telegram account** (phone or desktop): <https://telegram.org/>
3. A computer with internet access and a browser

---

## Step 1: Create a Telegram bot and get its Token

1. Open Telegram, search for **`@BotFather`** in the search box at the top and open it.
2. Send `/newbot` in the chat and follow its prompts:
   * First enter the bot's **display name** (anything, e.g. `My Usage Monitor`).
   * Then enter the bot's **username**, which must end with `_bot` (e.g. `my_cf_monitor_bot`).
3. On success, BotFather replies with a message containing an `HTTP API Token` that looks like this:

   ```text
   123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
   ```

4. **Copy this Token and save it in a text file.** It goes into the `TG_BOT_TOKEN` environment variable later.

> ⚠️ The Token is the bot's "key". Never share it or post it publicly.

---

## Step 2: Get your own Telegram numeric ID

1. In Telegram, search for **`@userinfobot`**, open it and send `/start`.
2. It replies with your account info, including an `Id` line that is a plain number (e.g. `111111111`).
3. **Write this number down.** It goes into the `ADMIN_TG_ID` environment variable, meaning "this ID may manage the bot".

> If you want others to view (but not manage), put their IDs in `VIEWER_TG_ID`, separated by commas.

---

## Step 3: Generate the Webhook secret (required)

**What is this for?** We generate a random string nobody can guess, used to verify that "the message really came from Telegram" — so nobody can impersonate Telegram and call your bot.

> ✅ Requirements: **1–256 characters**, containing **only** uppercase letters, lowercase letters, digits, underscore `_` and hyphen `-`.

### Option 1: One-click online generator

1. Open this URL in your browser: <https://it-tools.tech/token-generator>
2. Configure it like this (just tick the boxes):
   * ✅ Tick **Uppercase**
   * ✅ Tick **Lowercase**
   * ✅ Tick **Numbers**
   * ⬜ **Untick Symbols** — ⚠️ you must untick it, because Telegram does not allow symbols
   * Set **Length** to `32`
3. A random string appears immediately (like `aB3dE7gH9kLmN2pQrS5tU8vWxYzA1bC4`).
4. Click the **copy icon** next to it and **paste it into a text file**. This is your **Webhook secret**.

### Option 2: Command line

If you're comfortable with the command line, you can also generate it this way:

```bash
# macOS / Linux
openssl rand -hex 32

# If you have Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 📌 This string is the value of the `TG_WEBHOOK_SECRET` environment variable. Keep it in your text file — you'll need it in Step 6.

---

## Step 4: Create the database (D1)

1. Log in to the Cloudflare dashboard <https://dash.cloudflare.com/>
2. In the left sidebar, find **Workers & Pages** (some versions call it **Compute**) and open it.
3. Find **D1 SQL Database / D1** on the left or top and click **Create**.
4. Name the database **`cf-monitor-db`** and create it.
5. Open that database and find the **Console** tab.
6. Open the project's [`schema.sql`](schema.sql), **copy everything**, paste it into the console and click to run.

> ✅ Note: `schema.sql` is "repeatable" — running it twice by accident is fine.>   
> 🧩 Upgrading from an older version? Just re-run the latest `schema.sql`; it adds any new tables without touching existing data.

---

## Step 5: Deploy the Worker code (choose one)

### Method A: Paste it on the web (recommended)

1. Go back to the **Workers & Pages** overview, click **Create** → **Create Worker**.
2. Name the Worker (e.g. `cf-monitor`) and click **Deploy**.
3. Once deployed, click **Edit code** to enter the code editor.
4. Open the project's [`index.js`](index.js), **copy all of it**, paste it into the editor, replacing the default sample code.
5. Click **Deploy** in the top-right, then return to the Worker overview.

### Method B: Fork to your own GitHub for auto-deploy (a personal project rarely changes, so there's no need to fork)

1. Fork this project to your own GitHub account.
2. In the Cloudflare dashboard go to **Workers & Pages** → **Create**, choose **Continue with GitHub**.
3. Authorize your GitHub account, select the `CF-Monitor` repo you just forked, and finish the wizard.
4. From then on, any push to GitHub redeploys automatically.

---

## Step 6: Bind the database and fill in the configuration

### 6.1 Bind the database

1. Open your Worker, go to **Settings** → **Bindings**.
2. Add a **D1 Database** binding:
   * **Variable name**: `DB`
   * **Database**: select the `cf-monitor-db` you just created

### 6.2 Fill in environment variables

1. Go to **Settings** → **Variables and Secrets**.
2. Add each row below one by one. Items marked ✅ are required; the rest are optional.
3. Store sensitive values (Tokens, secrets) as type **Secret** (encrypted).
4. After filling everything in, deploy to apply.

**Required:**

| Variable | What to enter |
| --- | --- |
| `TG_BOT_TOKEN` | The bot Token from Step 1. |
| `ADMIN_TG_ID` | Your Telegram chat_id from Step 2 (comma-separated for several). |
| `TG_WEBHOOK_SECRET` | The Webhook secret from Step 3. **Without it the bot receives nothing at all.** |

**Optional (works without them):**

| Variable | Purpose | Default |
| --- | --- | --- |
| `SUPER_ADMIN_TG_ID` | Super admin ID. Defaults to the first `ADMIN_TG_ID`. | First admin |
| `VIEWER_TG_ID` | Read-only user IDs (comma separated); can view but not manage. | none |
| `TG_WEBHOOK_SECRET_PREV` | Previous secret, for **zero-downtime rotation** (see [Rotating secrets](#rotating-secrets-zero-downtime)). | none |
| `TG_WEBHOOK_ENFORCE_IP` | Set `true` to only allow requests from Telegram's official ranges. | off |
| `TG_IP_RANGES` | Custom IP allowlist (comma-separated CIDRs); only takes effect when `TG_WEBHOOK_ENFORCE_IP=true`. | Telegram's official ranges |
| `RATE_LIMIT_MAX` | Command rate limit: max commands per window. | `20` |
| `RATE_LIMIT_WINDOW_SEC` | Rate-limit window length (seconds). | `60` |

> 🛡️ **About the IP allowlist**: when `TG_WEBHOOK_ENFORCE_IP=true`, the Worker only allows requests whose source IP falls inside the allowlist and returns `403` for everything else (also logging a `webhook_ip_rejected` security event). If `TG_IP_RANGES` is not set, the built-in [Telegram official egress ranges](https://core.telegram.org/resources/cidr.txt) are used (9 IPv4 + 5 IPv6 blocks). If your requests pass through a self-hosted reverse proxy, or you need to additionally allow a fixed egress IP, provide a comma-separated list such as `1.2.3.0/24,2001:db8::/32`; malformed or entirely invalid values automatically fall back to the built-in ranges.

### 6.3 Add the Cloudflare accounts to monitor (1–20)

Use the `ACCOUNT_<n>_` prefix in order. For example, to monitor the first account:

| Variable | What to enter |
| --- | --- |
| `ACCOUNT_1_NAME` | A display name for this account (e.g. `Main`). |
| `ACCOUNT_1_ID` | That account's Cloudflare Account ID. |
| `ACCOUNT_1_TOKEN` | That account's API Token. |

For another account, use `ACCOUNT_2_NAME`, `ACCOUNT_2_ID`, `ACCOUNT_2_TOKEN`, and so on.

> **⚠️ API Token permissions (critical, or you'll read no data)**
>
> When creating the API Token in Cloudflare, set the edit scope to **All accounts** and grant **only** these three permissions:
>
> 1. `Developer Platform` → `Account Analytics` → `Read`
> 2. `Developer Platform` → `Workers Scripts` → `Read`
> 3. `Analytics & Logs` → `Pages` → `Read`

---

## Step 7: Connect the bot to your Worker (crucial)

This tells Telegram: "from now on, forward messages to this Worker."

1. Note your Worker URL (like `https://cf-monitor.xxxx.workers.dev`).
2. Replace the three placeholders in the URL below, then **visit it in your browser's address bar**:

   ```text
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<WORKER_DOMAIN>/tg-webhook&secret_token=<WEBHOOK_SECRET>
   ```

   * Replace `<BOT_TOKEN>` with the `TG_BOT_TOKEN` from Step 1
   * Replace `<WORKER_DOMAIN>` with your Worker domain (without `https://`)
   * Replace `<WEBHOOK_SECRET>` with the `TG_WEBHOOK_SECRET` from Step 3

   For example, after replacement:

   ```text
   https://api.telegram.org/bot123456789:ABCdef.../setWebhook?url=https://cf-monitor.xxxx.workers.dev/tg-webhook&secret_token=aB3dE7gH9kLmN2pQrS5tU8vWxYzA1bC4
   ```

3. If the browser returns the line below, the binding succeeded:

   ```json
   {"ok":true,"result":true,"description":"Webhook was set"}
   ```

> ⚠️ **Always remember to include the `secret_token` part.** Without `TG_WEBHOOK_SECRET`, the Worker **rejects all messages** and the bot will ignore you completely.

---

## Step 8: Set up the scheduled job

The tool uses a **Cloudflare Cron Trigger** to "check automatically every 15 minutes". How to set it up:

1. Open your Worker, go to the **Triggers** settings page.
2. Find **Cron Triggers** and click to add one.
3. Enter this rule in the input box and save:

   ```text
   */15 * * * *
   ```

   > This means "run every 15 minutes" — you can adjust it to suit your needs.

4. After saving, the system fetches usage every 15 minutes, checks whether alerts are needed, and pushes reports on time.

> 💡 Checking every 15 minutes makes your usage alerts more timely, while the **scheduled report is still sent only once at each time you chose** — a frequent check won't spam you.

---

## Step 9: Configure the bot

### 9.1 Say something to the bot

Find your bot in Telegram and send `/start`. If it replies with usage data, everything works.

### 9.2: Set up the bot command menu

1. Open Telegram, search for **`@BotFather`** and open the chat (the same one where you created your bot in Step 1).
2. Send the command **`/setcommands`**.
3. BotFather asks which bot to configure — **tap the one you just created**.
4. It replies with a prompt, then expects the command list. Copy the **whole block** below and paste it to BotFather (one per line, format `command - description`):

   ```text
   start - Show current usage
   history - Query history
   lang - Switch language
   whoami - Show my role
   settings - Open settings menu
   notify - Toggle scheduled report
   report_hours - Set push hours
   timezone - Set timezone
   alert_thresholds - Set alert thresholds
   alert_interval - Set alert min interval
   monitor_accounts - Set push scope
   sync - Sync data now
   help - Show help
   ```
5. A `Success!` reply means it's done. Go back to your bot and tap the menu button at the bottom-left of the chat box (or type `/`) to see the list.

> 💡 You can freely reword the descriptions; just keep the `command` part (before each " - ") identical to the list above.

---

## Feature settings

**Automatic alerts** and **scheduled reports** are both configurable. All settings live in the **Telegram bot** (there is no web settings page).

Send `/settings` to the bot for a menu: the **switches** (scheduled report, alerts, API-error alert) plus **alert min interval** and **push scope** are toggled by buttons; **push hours, timezone and alert thresholds** are set by typing, using the commands below:

| Command | Purpose | Example |
| --- | --- | --- |
| `/settings` | Open the settings menu (button-based) | `/settings` |
| `/notify` | Toggle scheduled reports | `/notify` |
| `/report_hours` | Set push hours (0–23, comma separated) | `/report_hours 9,18` |
| `/timezone` | Set the timezone | `/timezone +8` |
| `/alert_thresholds` | Set alert thresholds (1–100 %, comma separated) | `/alert_thresholds 50,80,100` |
| `/alert_interval` | Set the alert minimum interval (minutes, 0 = unlimited) | `/alert_interval 60` |
| `/monitor_accounts` | Set the push scope (`all` or account names, comma separated) | `/monitor_accounts Main,Blog` |

> 🔁 Priority: **personal settings (Telegram) > global defaults (database) > built-in defaults**.>   
> Global defaults are maintained directly via SQL in the D1 console (for advanced users); day to day, just use the Telegram settings.

### All configurable parameters and defaults

| Parameter | Meaning | Allowed values | Built-in default | How to set |
| --- | --- | --- | --- | --- |
| Scheduled report | Whether to push scheduled reports | on / off | **on** | `/settings` button or `/notify` |
| Push hours | Which hours to push (local time) | 0–23, multiple | **13:00, 22:00** | `/report_hours` |
| Timezone | Timezone used for push hours | UTC-12:00 ~ UTC+14:00 | **UTC+8** | `/timezone` |
| Alerts | Whether to push usage alerts | on / off | **on** | `/settings` button |
| Alert thresholds | Percentages that trigger an alert | 1–100 %, multiple | **20, 40, 60, 80, 100** | `/alert_thresholds` |
| Alert min interval | Shortest gap between two threshold alerts for the same account | 0–1440 min (0 = unlimited) | **15 min** | `/alert_interval` or `/settings` |
| Push scope | Which accounts alerts and reports cover | `all` or a list of account names | **all accounts** | `/monitor_accounts` or `/settings` |
| API-error alert | Notify when data fetching fails | on / off | **on** | `/settings` button |

> ℹ️ The "check frequency" is set by the Cron Trigger in Step 8; `/alert_interval` controls the **minimum gap between repeat alerts for the same account**, so usage that bounces up and down doesn't nag you.>   
> ℹ️ All settings are stored in the database, so they survive restarts and redeploys.

---

## Command reference

| Command | Who | Purpose |
| --- | --- | --- |
| `/start` | everyone | Show current usage |
| `/history` | everyone | Query history (with optional account and month/date, e.g. `/history Main 2026-09`) |
| `/lang` | everyone | Switch Chinese / English |
| `/whoami` | everyone | Show your role and ID |
| `/help` | everyone | Show help |
| `/settings` | admin | Open the settings menu |
| `/notify` | admin | Toggle scheduled reports |
| `/report_hours` | admin | Set push hours |
| `/timezone` | admin | Set the timezone |
| `/alert_thresholds` | admin | Set alert thresholds |
| `/alert_interval` | admin | Set the alert minimum interval |
| `/monitor_accounts` | admin | Set the push scope |
| `/sync` | admin | Sync data now |

> "admin" means IDs in `ADMIN_TG_ID` / `SUPER_ADMIN_TG_ID`. Unauthorized users get no reply at all (intentional, so the bot's existence is never revealed).

### How to browse history

Send `/history` in Telegram. The bot asks you to **pick an account**, then a **time range** (last 10 / 30 / 90 days), and then shows:

1. A **summary card**: total requests, capacity, daily average, peak, trough, Workers/Pages split, and the peak level;
2. Tapping "Daily details" opens a **paginated breakdown**, **10 days per page**, with "First / Prev / Next / Last" to page through, or tap a **page number** to jump.

> 📝 Account names always use the `ACCOUNT_N_NAME` you set (e.g. "Main"); the Cloudflare **account information is never shown**.
>
> 🧮 For "All accounts", capacity = **number of accounts × 100,000** (e.g. 300,000 for 3 accounts), so the percentages are computed against the combined quota.

You can also query directly with a command. The format is `/history [account] [period]` — **both parameters are optional** (omit the account to list all accounts for selection; omit the period to default to the last 30 days):

| Example | Meaning |
| --- | --- |
| `/history Main` | Show "Main" for the last 30 days |
| `/history Main 10` | Show "Main" for the last 10 days |
| `/history Main 2026-09` | Show "Main" for September 2026 |
| `/history Main 2026-09-28` | Show "Main" for 2026-09-28 |

---

## Rotating secrets (zero downtime)

If you ever suspect the secret may have leaked and want to switch to a new one, you can do it with **no service interruption**:

1. Generate a **new secret** as in Step 3.
2. In the Cloudflare environment variables:
   * move the **old secret** into `TG_WEBHOOK_SECRET_PREV`
   * put the **new secret** into `TG_WEBHOOK_SECRET`
   * save and deploy (both secrets are accepted; service is uninterrupted)
3. Re-run the Step 7 URL, this time with the **new secret**.
4. After a while, once no `webhook_auth_failed` appears in the logs, delete `TG_WEBHOOK_SECRET_PREV` and deploy again.

---

## Security events

All anomalies (wrong secret, insufficient permission, …) are written to the `security_events` table. Query recent records in the D1 console:

```sql
SELECT ts, event_type, severity, actor, ip, detail
FROM security_events
ORDER BY ts DESC LIMIT 50;
```

| Event type | Severity | Meaning |
| --- | --- | --- |
| `webhook_auth_failed` | crit | Webhook secret missing or mismatched (possible forgery) |
| `webhook_ip_rejected` | crit | Source IP outside Telegram ranges (requires the IP allowlist) |
| `command_auth_denied` | crit / warn | Command authorization failed |
| `callback_auth_denied` | warn | Inline callback authorization failed |
| `tg_rate_limited` | warn | Command rate limit hit |
| `webhook_secret_missing` | warn | Webhook secret not configured |

> Alerts are throttled to one per event type per 5-minute window to avoid alert storms; records are retained for 7 days and cleaned up automatically.

---

## FAQ

**Q1: The bot never replies. What now?**  
Check two things: ① is `TG_WEBHOOK_SECRET` set in the environment variables; ② did you include `secret_token` when registering the webhook in Step 7? These are the most common causes of "the bot receives nothing".

**Q2: Visiting the Worker URL shows Not Found — did the deploy fail?**  
No. This project has no web interface; the Worker only handles Telegram webhooks. As long as the bot replies to `/start`, the deployment succeeded.

**Q3: No scheduled report?**  
Check ① the report switch is on; ② the push hours include the current time; ③ the timezone is correct; ④ the push scope isn't excluding that account. Times are computed in the timezone you set.

**Q4: Alerts too frequent / too quiet?**  
Use `/alert_thresholds` to change thresholds, `/alert_interval` to change the minimum interval (larger = less noise; `0` = alert on every crossing), and `/monitor_accounts` to watch only the accounts you care about.

**Q5: Usage is always 0?**  
Most likely the Cloudflare API Token permissions are wrong. Re-check section 6.3: all three permissions granted, edit scope set to "All accounts".

**Q6: Why does my message get no reply?**  
If you're not in `ADMIN_TG_ID` / `VIEWER_TG_ID`, the bot **intentionally stays silent**. Add your ID to the right variable.

**Q7: How long is history kept?**  
Each account keeps its most recent 90 days of daily records, and the history query range is capped at 90 days.

---

## License

GNU GPL v3 — see [LICENSE](LICENSE).
