/**
 * CF-Monitor — Cloudflare Worker 单文件部署
 *
 * 本项目**不包含网页前端**：Worker 只对外暴露一个 Telegram Webhook 入口
 * （POST /tg-webhook），其余路径一律返回 404；所有能力（含历史数据查询与展示）
 * 均通过 Telegram 机器人的命令与内联按钮提供。
 *
 * 代码按职责分区，便于维护：
 *   §1 常量与配置          §2 通用工具（时间 / 恒定时间比较 / 元数据 / IP）
 *   §2.1 用户偏好          §3 安全日志与告警
 *   §4 鉴权与限流          §5 Telegram API 封装
 *   §6 业务逻辑（用量 / 文案 / 设置菜单 / 历史查询与展示）
 *   §7 Worker 入口（定时任务 / Webhook / 回调 / 命令 / 同步）
 */

/* ==================== §1 常量与配置 ==================== */

const USAGE_LIMIT = 100000;
const HISTORY_LIMIT = 90;

/** 「全部账号汇总」的伪账号 ID（真实账号 ID 为十六进制，不会与 "all" 冲突） */
const ALL_ACCOUNTS_ID = "all";

/** 角色等级：数值越大权限越高 */
const ROLE_RANK = { viewer: 1, admin: 2, super_admin: 3 };

/** 安全事件告警去重窗口（秒）——同类型事件在该窗口内只告警一次 */
const SEC_ALERT_WINDOW_SEC = 300;
/** 配置类告警窗口（秒）——避免配置缺失时刷屏 */
const SEC_CONFIG_ALERT_WINDOW_SEC = 3600;

/** 安全事件保留时长（秒） */
const SEC_EVENT_RETENTION_SEC = 7 * 24 * 3600;

/**
 * Telegram 官方出口网段（可选 IP 白名单的**内置默认值**，含 IPv4 与 IPv6）。
 * 来源：https://core.telegram.org/resources/cidr.txt
 * 可用环境变量 TG_IP_RANGES（逗号分隔的 CIDR）覆盖本默认值。
 */
const TG_IP_RANGES_DEFAULT = [
  "91.108.4.0/22",
  "91.108.8.0/22",
  "91.108.12.0/22",
  "91.108.16.0/22",
  "91.108.20.0/22",
  "91.108.56.0/22",
  "91.105.192.0/23",
  "149.154.160.0/20",
  "185.76.151.0/24",
  "2001:67c:4e8::/48",
  "2001:b28:f23c::/48",
  "2001:b28:f23d::/48",
  "2001:b28:f23f::/48",
  "2a0a:f280::/32",
];

/** Telegram 单条消息最大字符数（MarkdownV2 文本上限） */
const TG_MAX_TEXT = 4096;
/** Telegram Webhook 请求体上限（字节），超出直接忽略 */
const TG_MAX_BODY_BYTES = 65536;
/** 安全事件 detail 字段最大长度 */
const SEC_EVENT_DETAIL_MAX = 500;
/** 账号范围偏好的最大条目数 */
const PREF_ACCOUNTS_MAX = 50;
/** 环境变量中可配置的最大 Cloudflare 账号数（ACCOUNT_1..N） */
const MAX_ACCOUNTS = 20;
/** 外部 HTTP 请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 10000;
/** IP 位宽（IPv4 / IPv6） */
const IPV4_BITS = 32;
const IPV6_BITS = 128;

/** 命令 → 最低所需角色 */
const COMMAND_MIN_ROLE = {
  "/start": "viewer",
  "/help": "viewer",
  "/lang": "viewer",
  "/history": "viewer",
  "/whoami": "viewer",
  "/notify": "admin",
  "/sync": "admin",
  "/settings": "admin",
  "/report_hours": "admin",
  "/timezone": "admin",
  "/alert_thresholds": "admin",
  "/alert_interval": "admin",
  "/monitor_accounts": "admin",
};

/** 回调数据前缀 → 最低所需角色 */
const CALLBACK_MIN_ROLE = {
  lang_: "viewer",
  hist_acc_: "viewer",
  hist_sum_: "viewer",
  hist_det_: "viewer",
  nav_hist_list: "viewer",
  set_: "admin",
};

/* --------------------------------------------------------------------------
 * 可配置项（用户偏好）
 * 生效优先级：个人偏好（user_prefs） > 全局默认（app_meta 的 default:*） > 代码默认（下表 def）
 * --------------------------------------------------------------------------
 */
const PREF_SPEC = {
  report_enabled: { type: "bool", def: true }, // 定时日报开关
  report_hours: { type: "hours", def: [13, 22] }, // 推送时间（本地整点，0-23）
  report_tz_offset: { type: "tz", def: 480 }, // 时区偏移（分钟），480 = UTC+8
  alert_enabled: { type: "bool", def: true }, // 自动预警开关
  alert_thresholds: { type: "levels", def: [20, 40, 60, 80, 100] }, // 预警阈值（%）
  alert_on_api_error: { type: "bool", def: true }, // API 拉取失败时是否告警
  alert_min_interval: { type: "minutes", def: 15 }, // 同一账号阈值预警的最小间隔（分钟）
  monitor_accounts: { type: "accounts", def: [] }, // 推送账号范围（空 = 全部）
};

const PREF_KEYS = Object.keys(PREF_SPEC);

/** 全局默认值在 app_meta 中的键前缀 */
const GLOBAL_PREF_PREFIX = "default:";

/** 时区偏移取值范围（分钟）：UTC-12:00 ~ UTC+14:00 */
const TZ_MIN = -720;
const TZ_MAX = 840;

/** 预警最小间隔取值范围（分钟） */
const INTERVAL_MIN = 0;
const INTERVAL_MAX = 1440;

/** 「预警最小间隔」的预设档位（用下标引用，避免回调数据过长） */
const INTERVAL_PRESETS = [
  { label: "15min", value: 15 },
  { label: "30min", value: 30 },
  { label: "60min", value: 60 },
  { label: "180min", value: 180 },
];

function parseIdList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n !== 0);
}

function getAppConfig(env) {
  const accounts = [];
  for (let i = 1; i <= MAX_ACCOUNTS; i++) {
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

  const adminTgIds = parseIdList(env.ADMIN_TG_ID);
  const superAdminTgIds = parseIdList(env.SUPER_ADMIN_TG_ID);
  // 未显式指定超管时，把第一个管理员提升为超管，保证至少存在一个最高权限账号
  if (superAdminTgIds.length === 0 && adminTgIds.length > 0) {
    superAdminTgIds.push(adminTgIds[0]);
  }

  // 支持双密钥：当前密钥 + 旧密钥（轮换期并行接受，实现零中断轮换）
  const webhookSecrets = [env.TG_WEBHOOK_SECRET, env.TG_WEBHOOK_SECRET_PREV]
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  // 可选：用环境变量 TG_IP_RANGES（逗号分隔的 CIDR）覆盖内置网段白名单。
  // 仅保留形如 "1.2.3.0/24" / "2001:db8::/32" 的合法条目；全部无效时回退内置默认值，避免误配导致白名单失效。
  const customIpRanges = String(env.TG_IP_RANGES || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(s));
  const ipRanges = customIpRanges.length > 0 ? customIpRanges : TG_IP_RANGES_DEFAULT;

  return {
    tgBotToken: env.TG_BOT_TOKEN,
    adminTgIds,
    superAdminTgIds,
    viewerTgIds: parseIdList(env.VIEWER_TG_ID),
    cfAccounts: uniqueAccounts,
    webhookSecrets,
    webhookEnforceIp: String(env.TG_WEBHOOK_ENFORCE_IP || "").toLowerCase() === "true",
    ipRanges,
    rateLimit: {
      max: Number(env.RATE_LIMIT_MAX) || 20,
      windowSec: Math.max(5, Number(env.RATE_LIMIT_WINDOW_SEC) || 60),
    },
  };
}

/* ==================== §2 通用工具 ==================== */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** 恒定时间字符串比较，避免通过响应耗时侧信道推断密钥 */
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a ?? ""));
  const bb = new TextEncoder().encode(String(b ?? ""));
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function getClientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

/* ---------- 应用级键值元数据（用于调度去重与状态记录） ---------- */

async function getMeta(env, key) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key = ?").bind(key).first();
    return row ? row.value : null;
  } catch (e) {
    console.warn("[meta] getMeta failed:", e);
    return null; // 表不存在时降级，不影响主流程
  }
}

async function setMeta(env, key, value) {
  try {
    await env.DB.prepare(
      "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
      .bind(key, String(value))
      .run();
  } catch (e) {
    console.warn("[meta] setMeta failed:", e);
  }
}

/* ==================== §2.1 用户偏好（可配置化） ==================== */

/** 把偏好值序列化为存入数据库的字符串 */
function serializePref(key, value) {
  const spec = PREF_SPEC[key];
  if (!spec) return null;
  if (spec.type === "bool") return value ? "1" : "0";
  if (spec.type === "hours" || spec.type === "levels" || spec.type === "accounts") {
    return (value || []).join(",");
  }
  return String(value);
}

/**
 * 解析并校验一个偏好值。非法输入返回 { ok: false, error }。
 * 支持传入字符串（来自 DB / 表单）或已解析的数组/布尔值。
 */
function parsePref(key, raw) {
  const spec = PREF_SPEC[key];
  if (!spec) return { ok: false, error: "unknown_key" };
  if (raw === null || raw === undefined) return { ok: false, error: "empty" };
  if (raw === "") {
    // 账号范围为「空」，语义为「全部账号」，属于合法值
    if (spec.type === "accounts") return { ok: true, value: [] };
    return { ok: false, error: "empty" };
  }

  if (spec.type === "bool") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    const s = String(raw).trim().toLowerCase();
    if (["1", "true", "on", "yes"].includes(s)) return { ok: true, value: true };
    if (["0", "false", "off", "no"].includes(s)) return { ok: true, value: false };
    return { ok: false, error: "invalid_bool" };
  }

  if (spec.type === "tz") {
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n < TZ_MIN || n > TZ_MAX || n % 15 !== 0) {
      return { ok: false, error: "invalid_tz" };
    }
    return { ok: true, value: n };
  }

  if (spec.type === "minutes") {
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX) {
      return { ok: false, error: "invalid_minutes" };
    }
    return { ok: true, value: n };
  }

  if (spec.type === "accounts") {
    const list = Array.isArray(raw) ? raw : String(raw).split(",");
    const tokens = list.map((s) => String(s).trim()).filter(Boolean);
    if (tokens.length > PREF_ACCOUNTS_MAX) return { ok: false, error: "too_many" };
    if (tokens.some((t) => !/^[A-Za-z0-9_-]{1,64}$/.test(t))) return { ok: false, error: "invalid_account" };
    return { ok: true, value: Array.from(new Set(tokens)) };
  }

  if (spec.type === "hours" || spec.type === "levels") {
    const list = Array.isArray(raw) ? raw : String(raw).split(",");
    const tokens = list.map((s) => String(s).trim()).filter((s) => s !== "");
    const maxCount = spec.type === "hours" ? 24 : 10;
    if (tokens.length === 0 || tokens.length > maxCount) {
      return { ok: false, error: "invalid_count" };
    }
    const lo = spec.type === "hours" ? 0 : 1;
    const hi = spec.type === "hours" ? 23 : 100;
    const ints = [];
    for (const tok of tokens) {
      const n = Number(tok);
      // 严格要求整数：拒绝小数 / 非数字 / 空值，避免静默丢弃或四舍五入
      if (!Number.isInteger(n) || n < lo || n > hi) {
        return { ok: false, error: "out_of_range" };
      }
      ints.push(n);
    }
    const uniq = Array.from(new Set(ints)).sort((a, b) => a - b);
    return { ok: true, value: uniq };
  }

  return { ok: false, error: "unknown_type" };
}

/** 读取全局默认值（app_meta 的 default:* 键），一次查询取回全部，缺失时返回 {} */
async function loadGlobalPrefs(env) {
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM app_meta WHERE key LIKE ?")
      .bind(GLOBAL_PREF_PREFIX + "%")
      .all();
    for (const row of results || []) {
      const key = String(row.key).slice(GLOBAL_PREF_PREFIX.length);
      if (!PREF_KEYS.includes(key)) continue;
      const parsed = parsePref(key, row.value);
      if (parsed.ok) out[key] = parsed.value;
    }
  } catch (e) {
    console.warn("[prefs] loadGlobalPrefs failed:", e);
  }
  return out;
}

/** 读取某个用户的个人偏好覆盖（仅返回显式设置过的键） */
async function loadUserPrefs(env, chatId) {
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM user_prefs WHERE chat_id = ?")
      .bind(Number(chatId))
      .all();
    for (const row of results || []) {
      if (!PREF_KEYS.includes(row.key)) continue;
      const parsed = parsePref(row.key, row.value);
      if (parsed.ok) out[row.key] = parsed.value;
    }
  } catch (e) {
    console.warn("[prefs] loadUserPrefs failed:", e); // 表不存在时降级为空
  }
  return out;
}

/** 写入某个用户的个人偏好 */
async function setUserPref(env, chatId, key, value) {
  const ser = serializePref(key, value);
  if (ser === null) return false;
  try {
    await env.DB.prepare(
      "INSERT INTO user_prefs (chat_id, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    )
      .bind(Number(chatId), key, ser)
      .run();
    return true;
  } catch (e) {
    console.warn("[prefs] setUserPref failed:", e);
    return false;
  }
}

/**
 * 计算某用户最终生效的偏好：个人偏好 > 全局默认 > 代码默认。
 * 兼容旧字段 user_settings.cron_enabled（作为 report_enabled 的兜底）。
 */
async function resolvePrefs(env, chatId, globalPrefs = null, legacyCronEnabled = undefined) {
  const globals = globalPrefs || (await loadGlobalPrefs(env));
  const user = await loadUserPrefs(env, chatId);
  const effective = {};
  for (const key of PREF_KEYS) {
    if (user[key] !== undefined) effective[key] = user[key];
    else if (globals[key] !== undefined) effective[key] = globals[key];
    else effective[key] = PREF_SPEC[key].def;
  }
  if (legacyCronEnabled !== undefined && user.report_enabled === undefined && globals.report_enabled === undefined) {
    effective.report_enabled = !!legacyCronEnabled;
  }
  return effective;
}

/** 把分钟偏移格式化为 UTC±H[:MM] 文案 */
function formatTzOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
}

/** 把预警最小间隔格式化为可读文案 */
function formatMinutes(m, lang) {
  const zh = lang !== "en";
  const n = Number(m) || 0;
  if (n <= 0) return zh ? "不限制" : "off";
  return zh ? `${n} 分钟` : `${n} min`;
}

/** 计算「UTC 时间 + 偏移」后的本地时刻（返回一个 Date，用 getUTC* 读取） */
function toLocalDate(utcDate, offsetMin) {
  return new Date(utcDate.getTime() + offsetMin * 60000);
}

/** 返回在给定阈值列表中，本次从 oldPercent 跨越到 newPercent 的阈值 */
function crossedLevels(oldPercent, newPercent, thresholds) {
  return (thresholds || []).filter((t) => oldPercent < t && t <= newPercent);
}

/**
 * 解析 /timezone 的输入，返回分钟偏移；无法解析时返回 null。
 * 支持：`+8`、`-5`、`+5.5`（小数小时）、`+5:30`、`UTC+8`、`GMT-5`，以及直接传分钟数 `480`。
 */
function parseTimezoneInput(raw) {
  let s = String(raw || "").trim().toUpperCase();
  if (!s) return null;
  s = s.replace(/^(UTC|GMT)/, "").trim();
  if (!s) return null;

  const m = /^([+-]?)(\d{1,2})(?::(\d{1,2})|\.(\d+))?$/.exec(s);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const h = Number(m[2]);
    let minutes;
    if (m[4] !== undefined) minutes = Math.round((h + Number("0." + m[4])) * 60); // 小数小时
    else minutes = h * 60 + (m[3] ? Number(m[3]) : 0); // 整点或 H:MM
    const parsed = parsePref("report_tz_offset", minutes * sign);
    return parsed.ok ? parsed.value : null;
  }

  const parsed = parsePref("report_tz_offset", s);
  return parsed.ok ? parsed.value : null;
}

function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

/** 把 IPv6 地址解析为 128 位 BigInt；非法返回 null（支持 :: 缩写与 IPv4 映射写法） */
function ipv6ToBigInt(ip) {
  let s = String(ip).trim();
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    s = s.slice(0, lastColon + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups;
  if (rest === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...rest];
  }
  if (groups.length !== 8) return null;
  let big = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    big = (big << 16n) | BigInt(parseInt(g, 16));
  }
  return big;
}

function ipv4InCidr(ip, cidr) {
  const [net, bitsRaw] = String(cidr).split("/");
  const bits = Number(bitsRaw ?? IPV4_BITS);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null) return false;
  if (!Number.isFinite(bits) || bits <= 0) return true;
  if (bits > IPV4_BITS) return false;
  const mask = bits === IPV4_BITS ? 0xffffffff : (~((1 << (IPV4_BITS - bits)) - 1)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((netInt & mask) >>> 0);
}

function ipv6InCidr(ip, cidr) {
  const [net, bitsRaw] = String(cidr).split("/");
  const bits = Number(bitsRaw ?? IPV6_BITS);
  const ipInt = ipv6ToBigInt(ip);
  const netInt = ipv6ToBigInt(net);
  if (ipInt === null || netInt === null) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > IPV6_BITS) return false;
  if (bits === 0) return true;
  const mask = ((1n << BigInt(IPV6_BITS)) - 1n) ^ ((1n << BigInt(IPV6_BITS - bits)) - 1n);
  return (ipInt & mask) === (netInt & mask);
}

/** 判断 IP 是否落在给定 CIDR 内，自动区分 IPv4 / IPv6 */
function ipInCidr(ip, cidr) {
  const net = String(cidr).split("/")[0];
  return net.includes(":") ? ipv6InCidr(ip, cidr) : ipv4InCidr(ip, cidr);
}

/* ---------- Telegram MarkdownV2 文本工具 ---------- */

function escapeMd(text) {
  // 必须同时转义反斜杠本身，否则会与后续转义序列叠加出非法 MarkdownV2
  return String(text ?? "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function code(s) {
  return "`" + String(s ?? "").replace(/[\\`]/g, "\\$&") + "`";
}

/** 按 Telegram 文本上限截断，且避免切断末尾的转义序列（悬空反斜杠会导致解析失败） */
function truncateMd(text, max = TG_MAX_TEXT) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  let trailingBackslashes = 0;
  for (let i = cut.length - 1; i >= 0 && cut[i] === "\\"; i--) trailingBackslashes++;
  if (trailingBackslashes % 2 === 1) cut = cut.slice(0, -1);
  return cut;
}

/** 去掉 MarkdownV2 转义与行内标记，用于解析失败时降级为纯文本发送 */
function toPlainText(text) {
  return String(text ?? "")
    .replace(/\\(.)/g, "$1")
    .replace(/[*_`~]/g, "");
}

/* ==================== §3 安全日志与告警 ==================== */

async function logSecurityEvent(env, evt) {
  try {
    await env.DB.prepare(
      "INSERT INTO security_events (ts, event_type, severity, actor, ip, detail) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        new Date().toISOString(),
        evt.type,
        evt.severity || "info",
        evt.actor != null ? String(evt.actor) : null,
        evt.ip != null ? String(evt.ip) : null,
        evt.detail != null ? String(evt.detail).slice(0, SEC_EVENT_DETAIL_MAX) : null
      )
      .run();
  } catch (e) {
    // 日志失败不得影响主流程
    console.warn("[security] logSecurityEvent failed:", e);
  }
}

async function countRecentEvents(env, type, windowSec) {
  try {
    const since = new Date(Date.now() - windowSec * 1000).toISOString();
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM security_events WHERE event_type = ? AND ts >= ?"
    )
      .bind(type, since)
      .first();
    return Number(row?.c || 0);
  } catch (e) {
    console.warn("[security] countRecentEvents failed:", e);
    return 0;
  }
}

async function notifyAdmins(config, text) {
  for (const adminId of config.adminTgIds) {
    await sendTgMessage(config.tgBotToken, adminId, text);
  }
}

/**
 * 记录安全事件并在去重窗口内只告警一次。
 * 落库与计数放进同一个 batch（D1 隐式事务）执行，避免并发下重复告警；
 * 计数包含当前事件，故 >1 表示窗口内已告警过。
 */
async function reportSecurityEvent(env, config, evt, opts = {}) {
  const alert = opts.alert !== false;
  const windowSec = opts.windowSec ?? SEC_ALERT_WINDOW_SEC;
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  let recent = 0;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO security_events (ts, event_type, severity, actor, ip, detail) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(
        new Date().toISOString(),
        evt.type,
        evt.severity || "info",
        evt.actor != null ? String(evt.actor) : null,
        evt.ip != null ? String(evt.ip) : null,
        evt.detail != null ? String(evt.detail).slice(0, SEC_EVENT_DETAIL_MAX) : null
      ),
      env.DB.prepare("SELECT COUNT(*) AS c FROM security_events WHERE event_type = ? AND ts >= ?").bind(
        evt.type,
        since
      ),
    ]);
    const countRes = results && results[1];
    const rows = Array.isArray(countRes?.results) ? countRes.results : Array.isArray(countRes) ? countRes : [];
    recent = Number(rows[0]?.c || 0);
  } catch (e) {
    console.warn("[security] reportSecurityEvent failed:", e);
    return;
  }
  if (!alert || recent > 1) return;
  await notifyAdmins(
    config,
    `[SEC_${String(evt.severity || "info").toUpperCase()}]\nTYPE: ${evt.type}\nIP: ${evt.ip || "-"}\nACTOR: ${
      evt.actor || "-"
    }\nDETAIL: ${evt.detail || "-"}`
  );
}

/** 配置类问题：每窗口最多记录并告警一次，避免刷屏 */
async function reportConfigIssue(env, config, type, detail) {
  const recent = await countRecentEvents(env, type, SEC_CONFIG_ALERT_WINDOW_SEC);
  if (recent > 0) return;
  await logSecurityEvent(env, { type, severity: "warn", detail });
  await notifyAdmins(config, `[SEC_WARN]\nTYPE: ${type}\nDETAIL: ${detail}`);
}

/* ==================== §4 鉴权：角色解析 / 权限矩阵 / 限流 ==================== */

function roleAtLeast(role, minRole) {
  if (!role) return false;
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
}

/**
 * 解析 Telegram 用户角色。
 * 优先级：超管(env) > 管理员(env) > 动态角色(DB) > 只读(env) > 拒绝(null)
 */
async function resolveRole(env, config, chatId) {
  const id = Number(chatId);
  if (!Number.isInteger(id) || id === 0) return null;
  if (config.superAdminTgIds.includes(id)) return "super_admin";
  if (config.adminTgIds.includes(id)) return "admin";
  try {
    const row = await env.DB.prepare("SELECT role FROM tg_roles WHERE chat_id = ?").bind(id).first();
    if (row && ROLE_RANK[row.role]) return row.role;
  } catch (e) {
    console.warn("[auth] resolveRole DB lookup failed:", e); // 表不存在时降级为 env 判定
  }
  if (config.viewerTgIds.includes(id)) return "viewer";
  return null;
}

/** 固定窗口限流：返回 { allowed, count } */
async function checkRateLimit(env, key, limit, windowSec) {
  const win = Math.floor(nowSec() / windowSec) * windowSec;
  try {
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END, " +
        "window_start = excluded.window_start"
    )
      .bind(key, win)
      .run();
    const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(key).first();
    const count = Number(row?.count || 1);
    return { allowed: count <= limit, count };
  } catch (e) {
    // 限流表异常时不阻断正常用户
    console.warn("[rate] checkRateLimit failed:", e);
    return { allowed: true, count: 0 };
  }
}

/* ==================== §5 Telegram API 封装 ==================== */

async function tgApiCall(botToken, method, payload) {
  if (!botToken) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return await res.json().catch(() => null);
  } catch (e) {
    console.warn("[tgApi] call failed:", method, e);
    return null;
  }
}

/** 发送纯文本消息，返回是否发送成功 */
async function sendTgMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return false;
  const res = await tgApiCall(botToken, "sendMessage", { chat_id: chatId, text: truncateMd(text) });
  return !!(res && res.ok !== false);
}

/** 发送 MarkdownV2 消息；解析失败时自动降级为纯文本，返回是否发送成功 */
async function sendTgMessageMd(botToken, chatId, text, replyMarkup = null) {
  if (!botToken || !chatId) return false;
  const md = truncateMd(text);
  const body = { chat_id: chatId, text: md, parse_mode: "MarkdownV2" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await tgApiCall(botToken, "sendMessage", body);
  if (!res) return false;
  if (res.ok !== false) return true;
  const fallback = { chat_id: chatId, text: toPlainText(md) };
  if (replyMarkup) fallback.reply_markup = replyMarkup;
  const res2 = await tgApiCall(botToken, "sendMessage", fallback);
  return !!(res2 && res2.ok !== false);
}

async function editTgMessage(botToken, chatId, messageId, text) {
  await tgApiCall(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: truncateMd(text),
    parse_mode: "MarkdownV2",
  });
}

async function editTgMessageInline(botToken, chatId, messageId, text, inlineKeyboard) {
  await tgApiCall(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: truncateMd(text),
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

async function answerCallbackQuery(botToken, callbackQueryId, text = "") {
  await tgApiCall(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

/* ==================== §5.1 文案（中英双语集中管理） ==================== */

/** 固定文案字典：key -> { zh, en }；动态内容用 {name} 占位 */
const TXT = {
  denied: { zh: "权限不足 / Permission denied", en: "权限不足 / Permission denied" },
  rateLimited: {
    zh: "请求过于频繁，请稍后再试 / Too many requests, please slow down.",
    en: "请求过于频繁，请稍后再试 / Too many requests, please slow down.",
  },
  callbackUpdated: { zh: "已更新", en: "Updated" },
  langSwitched: { zh: "语言已切换", en: "Language switched" },
  langSwitchedMsg: {
    zh: "✅ 语言已切换为 *简体中文*\n您可以发送 /help 查看所有可用命令。",
    en: "✅ Language switched to *English*\nYou can send /help to see all available commands\\.",
  },
  pickLanguage: { zh: "请选择机器人语言 / Please choose language:", en: "请选择机器人语言 / Please choose language:" },
  syncing: { zh: "正在同步…", en: "Syncing…" },
  syncDone: { zh: "✅ 同步完成", en: "✅ Sync completed" },
  startNoData: { zh: "\\[系统信息\\] 暂无可用数据", en: "\\[SYS\\_INFO\\] NO DATA AVAILABLE" },
  startReportDate: { zh: "*汇报日期*", en: "*Report Date*" },
  reportHeader: {
    zh: "*定时报告* \\(本地 {time}\\)\n*日期*: {date}\n\\-\\-\\-\n",
    en: "*Scheduled Report* \\(local {time}\\)\n*Date*: {date}\n\\-\\-\\-\n",
  },
  accountUsage: { zh: "*{name}*\n{usage}\n{bar} \\[{status}\\]\n\n", en: "*{name}*\n{usage}\n{bar} \\[{status}\\]\n\n" },
  accountNotFound: { zh: "未找到账号：{q}", en: "Account not found: {q}" },
  multipleMatches: { zh: "匹配到多个账号，请选择：", en: "Multiple matches, please choose:" },
  invalidPeriod: { zh: "时间段格式无效。", en: "Invalid period." },
  reportOn: { zh: "✅ 定时日报已*开启*", en: "✅ Scheduled report *Enabled*" },
  reportOff: { zh: "✅ 定时日报已*关闭*", en: "✅ Scheduled report *Disabled*" },
  pushTimeSet: { zh: "✅ 推送时间已设为 {v}", en: "✅ Push time set to {v}" },
  tzSet: { zh: "✅ 时区已设为 {v}", en: "✅ Timezone set to {v}" },
  thresholdsSet: { zh: "✅ 预警阈值已设为 {v}%", en: "✅ Alert thresholds set to {v}%" },
  intervalSet: { zh: "✅ 预警最小间隔已设为 *{v}*", en: "✅ Alert min interval set to *{v}*" },
  scopeAll: { zh: "✅ 推送账号范围已设为 *全部账号*", en: "✅ Push scope set to *All accounts*" },
  scopeSet: { zh: "✅ 推送账号范围已设为：*{v}*", en: "✅ Push scope set to: *{v}*" },
  noAccountResolved: { zh: "未解析出任何账号，请检查名称。", en: "No account resolved, please check names." },
  ambiguousAccounts: {
    zh: "以下名称匹配到多个账号，请改用完整名称或账号 ID：{v}",
    en: "These names matched multiple accounts; use the full name or account ID: {v}",
  },
  usageReportHours: {
    zh: "用法：`/report\\_hours 9,18` \\(0\\-23 的整点，逗号分隔\\)",
    en: "Usage: `/report\\_hours 9,18` \\(hours 0\\-23, comma separated\\)",
  },
  usageTimezone: {
    zh: "用法：`/timezone \\+8`（支持 `+8`、`-5`、`+5\\.5`、`UTC\\+8`）",
    en: "Usage: `/timezone \\+8` \\(e\\.g\\. `+8`, `-5`, `+5.5`, `UTC+8`\\)",
  },
  usageThresholds: {
    zh: "用法：`/alert\\_thresholds 50,80,100` \\(1\\-100 的百分比，逗号分隔\\)",
    en: "Usage: `/alert\\_thresholds 50,80,100` \\(percentages 1\\-100, comma separated\\)",
  },
  usageInterval: {
    zh: "用法：`/alert\\_interval 60` \\(0\\-1440 分钟，0 表示不限制\\)",
    en: "Usage: `/alert\\_interval 60` \\(0\\-1440 minutes, 0 = unlimited\\)",
  },
  usageMonitorAccounts: {
    zh: "用法：`/monitor\\_accounts all` 或 `/monitor\\_accounts MAIN,BLOG`",
    en: "Usage: `/monitor\\_accounts all` or `/monitor\\_accounts MAIN,BLOG`",
  },
  whoami: { zh: "*身份*: `{role}`\n*ID*: `{id}`", en: "*Role*: `{role}`\n*ID*: `{id}`" },
  help: {
    zh: "*系统可用命令*\n\n/start \\- 获取当前统计\n/history \\- 查询历史记录（账号与时间范围可选）\n/lang \\- 切换中英语言\n/whoami \\- 查看当前身份\n\n*管理员命令*\n/settings \\- 打开设置菜单\n/notify \\- 开关定时日报\n/report\\_hours 9,18 \\- 设置推送时间\n/timezone \\+8 \\- 设置时区\n/alert\\_thresholds 50,80,100 \\- 设置预警阈值\n/alert\\_interval 60 \\- 设置预警最小间隔（分钟）\n/monitor\\_accounts all \\- 设置推送账号范围\n/sync \\- 立即同步数据\n\n/help \\- 显示此帮助信息",
    en: "*Available Commands*\n\n/start \\- Get current stats\n/history \\- Query history \\(account & period optional\\)\n/lang \\- Switch language\n/whoami \\- Show my role\n\n*Admin commands*\n/settings \\- Open settings menu\n/notify \\- Toggle scheduled report\n/report\\_hours 9,18 \\- Set push times\n/timezone \\+8 \\- Set timezone\n/alert\\_thresholds 50,80,100 \\- Set alert thresholds\n/alert\\_interval 60 \\- Set alert min interval (min)\n/monitor\\_accounts all \\- Set push scope\n/sync \\- Sync now\n\n/help \\- Show this help",
  },
};

/** 按语言取文案并填充 {name} 占位；缺失 key 时原样返回 */
function tr(lang, key, vars) {
  const entry = TXT[key];
  if (!entry) return key;
  let s = lang === "en" ? entry.en : entry.zh;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
  }
  return s;
}

/* ==================== §6 业务逻辑 ==================== */

async function getWorkerStats(accountId, apiToken) {
  const utcDateStr = new Date().toISOString().split("T")[0];
  const datetimeGeq = `${utcDateStr}T00:00:00Z`;
  const datetimeLeq = `${utcDateStr}T23:59:59Z`;

  try {
    // Pages 项目名与 Worker 脚本名可能重名：同时取两份名单，重名时按 Worker 归类，避免误判
    const pagesNames = new Set();
    const workerScriptNames = new Set();
    try {
      const pagesRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects?per_page=100`,
        { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
      );
      const pagesData = await pagesRes.json();
      if (pagesData.success && pagesData.result) {
        pagesData.result.forEach((p) => pagesNames.add(p.name));
      }
    } catch (e) {
      console.warn("[cf] pages projects fetch failed:", accountId, e); // 不阻断主流程
    }
    try {
      const scriptsRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
        { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
      );
      const scriptsData = await scriptsRes.json();
      if (scriptsData.success && scriptsData.result) {
        scriptsData.result.forEach((s) => workerScriptNames.add(s.id));
      }
    } catch (e) {
      console.warn("[cf] workers scripts fetch failed:", accountId, e); // 不阻断主流程
    }

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
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const result = await response.json();

    if (result.errors) return null;

    let workersReq = 0;
    let pagesReq = 0;
    const accounts = result?.data?.viewer?.accounts;

    if (accounts && accounts.length > 0) {
      const groups = accounts[0].workersInvocationsAdaptive;
      if (groups && groups.length > 0) {
        groups.forEach((group) => {
          const reqs = group.sum.requests || 0;
          const scriptName = group.dimensions.scriptName;
          // 仅当命中 Pages 项目且不是同名 Worker 脚本时，才归入 Pages
          if (pagesNames.has(scriptName) && !workerScriptNames.has(scriptName)) pagesReq += reqs;
          else workersReq += reqs;
        });
      }
    }
    return { workers: workersReq, pages: pagesReq, total: workersReq + pagesReq };
  } catch (e) {
    console.warn("[cf] getWorkerStats failed:", accountId, e);
    return null;
  }
}

function makeProgressBar(percent, slots = 10) {
  const n = Math.max(1, Number(slots) || 10);
  const filledSlots = Math.round(((Number(percent) || 0) / 100) * n);
  return "█".repeat(Math.min(filledSlots, n)) + "▒".repeat(Math.max(0, n - filledSlots));
}

function usageLevel(percent) {
  if (percent >= 80) return "crit";
  if (percent >= 60) return "warn";
  return "ok";
}

/** 计算用量百分比（封顶 100）；capacity 为可用总量，「全部账号汇总」时按账号数累加 */
function usagePercent(requests, capacity = USAGE_LIMIT) {
  const cap = Number(capacity) > 0 ? Number(capacity) : USAGE_LIMIT;
  return Math.min((Number(requests) / cap) * 100, 100);
}

function statusEmoji(percent) {
  const level = usageLevel(percent);
  return level === "crit" ? "🔴" : level === "warn" ? "🟡" : "🟢";
}

function statusLabel(percent, lang) {
  const level = usageLevel(percent);
  if (lang === "en") return level === "crit" ? "🔴CRIT" : level === "warn" ? "🟡WARN" : "🟢NORM";
  return level === "crit" ? "🔴临界" : level === "warn" ? "🟡警告" : "🟢正常";
}

/** 把整点列表格式化为 "09:00, 18:00" */
function formatHours(hours) {
  return (hours || []).map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
}

/** 把阈值列表格式化为 "80/95"；先用 Array.isArray 收窄类型，非数组回退为空串 */
function formatLevels(levels) {
  return (Array.isArray(levels) ? levels : []).join("/");
}

/* ---------- 设置菜单 ---------- */

/** 构建 Telegram「设置」菜单的文本与内联键盘 */
function renderSettingsMenu(prefs, lang, accounts) {
  const zh = lang !== "en";
  const on = zh ? "开启" : "ON";
  const off = zh ? "关闭" : "OFF";
  const tzLabel = formatTzOffset(prefs.report_tz_offset);
  const accs = accounts || [];
  const selected = prefs.monitor_accounts || [];
  const scopeLabel =
    selected.length === 0
      ? zh
        ? `全部（${accs.length}）`
        : `All (${accs.length})`
      : selected
          .map((id) => {
            const a = accs.find((x) => x.accountId === id);
            return a ? a.name : id;
          })
          .join(zh ? "、" : ", ");

  const text = (
    zh
      ? [
          "*设置*",
          "",
          `定时日报：*${prefs.report_enabled ? on : off}*`,
          `推送时间：${code(formatHours(prefs.report_hours))} （${escapeMd(tzLabel)}）`,
          `自动预警：*${prefs.alert_enabled ? on : off}*`,
          `预警阈值：${code(prefs.alert_thresholds.join("/") + "%")}`,
          `预警最小间隔：*${escapeMd(formatMinutes(prefs.alert_min_interval, lang))}*`,
          `推送账号范围：${escapeMd(scopeLabel)}`,
          `API 异常告警：*${prefs.alert_on_api_error ? on : off}*`,
          "",
          "开关类可点下方按钮切换；时间 / 时区 / 阈值请用命令自行设置：",
          "/report\\_hours 9,18",
          "/timezone \\+8",
          "/alert\\_thresholds 50,80,100",
          "/alert\\_interval 60",
          "/monitor\\_accounts all",
        ]
      : [
          "*Settings*",
          "",
          `Scheduled report: *${prefs.report_enabled ? on : off}*`,
          `Push time: ${code(formatHours(prefs.report_hours))} \\(${escapeMd(tzLabel)}\\)`,
          `Alerts: *${prefs.alert_enabled ? on : off}*`,
          `Alert thresholds: ${code(prefs.alert_thresholds.join("/") + "%")}`,
          `Alert min interval: *${escapeMd(formatMinutes(prefs.alert_min_interval, lang))}*`,
          `Push scope: ${escapeMd(scopeLabel)}`,
          `API-error alert: *${prefs.alert_on_api_error ? on : off}*`,
          "",
          "Toggle switches below; set time / timezone / thresholds via commands:",
          "/report\\_hours 9,18",
          "/timezone \\+8",
          "/alert\\_thresholds 50,80,100",
          "/alert\\_interval 60",
          "/monitor\\_accounts all",
        ]
  ).join("\n");

  const inline_keyboard = [
    [
      { text: `${zh ? "日报" : "Report"}: ${prefs.report_enabled ? on : off}`, callback_data: "set_rep" },
      { text: `${zh ? "预警" : "Alert"}: ${prefs.alert_enabled ? on : off}`, callback_data: "set_alr" },
    ],
    [{ text: `${zh ? "API 异常告警" : "API-error alert"}: ${prefs.alert_on_api_error ? on : off}`, callback_data: "set_api" }],
    INTERVAL_PRESETS.map((p, i) => ({ text: p.label, callback_data: `set_int:${i}` })),
  ];

  if (accs.length > 0) {
    inline_keyboard.push(
      accs.map((a, i) => ({
        text: `${selected.includes(a.accountId) ? "✅" : "⬜"} ${a.name}`,
        callback_data: `set_acc:${i}`,
      }))
    );
    inline_keyboard.push([{ text: zh ? "全部账号" : "All accounts", callback_data: "set_acc:all" }]);
  }

  return { text, replyMarkup: { inline_keyboard } };
}

/* ---------- 历史数据查询与展示 ----------
 * 支持分页、按时间段（近 N 天 / 指定月份 / 指定日期）查询、按关键字（账号名/ID）查询。
 */

function parseRangeSpec(token) {
  const s = String(token || "").trim();
  if (/^m\d{4}-\d{2}$/.test(s)) return { kind: "month", month: s.slice(1) };
  if (/^d\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "day", day: s.slice(1) };
  const n = parseInt(s, 10);
  if (Number.isInteger(n) && n >= 1 && n <= HISTORY_LIMIT) return { kind: "days", days: n };
  return null;
}

function rangeSpecToToken(spec) {
  if (!spec) return "";
  if (spec.kind === "month") return "m" + spec.month;
  if (spec.kind === "day") return "d" + spec.day;
  return String(spec.days);
}

function parsePeriodInput(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "day", day: s };
  if (/^\d{4}-\d{2}$/.test(s)) return { kind: "month", month: s };
  const n = parseInt(s, 10);
  if (Number.isInteger(n) && n >= 1 && n <= HISTORY_LIMIT) return { kind: "days", days: n };
  return null;
}

function rangeLabel(spec, lang) {
  const zh = lang !== "en";
  if (!spec) return "-";
  if (spec.kind === "days") return zh ? `近 ${spec.days} 天` : `Last ${spec.days} days`;
  if (spec.kind === "month") return spec.month;
  if (spec.kind === "day") return spec.day;
  return "-";
}

/** /history 命令的用法说明 */
function historyUsage(lang) {
  const zh = lang !== "en";
  if (zh) {
    return [
      "用法：" + code("/history [账号] [时间范围]"),
      "",
      "· 账号（可选）：账号名称或关键字，如 " + code("主账号") + "；留空则列出全部账号供选择",
      "· 时间范围（可选）：留空默认近 30 天；可填 " +
        code("10") +
        " / " +
        code("30") +
        " / " +
        code("90") +
        "（近 N 天）、" +
        code("2026-09") +
        "（指定月份）、" +
        code("2026-09-28") +
        "（指定日期）",
      "",
      "示例：" + code("/history 主账号 2026-09"),
    ].join("\n");
  }
  return [
    "Usage: " + code("/history [account] [period]"),
    "",
    "· account (optional): account name or keyword, e.g. " + code("Main") + "; omit to list all accounts",
    "· period (optional): defaults to the last 30 days; accepts " +
      code("10") +
      " / " +
      code("30") +
      " / " +
      code("90") +
      " (last N days), " +
      code("2026-09") +
      " (month), " +
      code("2026-09-28") +
      " (date)",
    "",
    "Example: " + code("/history Main 2026-09"),
  ].join("\n");
}

/** 关键字查询账号：先精确匹配（ID / 名称），再模糊匹配 */
function findAccounts(config, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const exact = config.cfAccounts.filter(
    (a) => a.accountId.toLowerCase() === q || a.name.toLowerCase() === q
  );
  if (exact.length > 0) return exact;
  return config.cfAccounts.filter(
    (a) => a.name.toLowerCase().includes(q) || a.accountId.toLowerCase().includes(q)
  );
}

/** 把账号 ID（含 "all" 伪账号）解析为展示用对象 */
function historyAccount(config, accountId, lang) {
  if (accountId === ALL_ACCOUNTS_ID) {
    return { accountId: ALL_ACCOUNTS_ID, name: lang === "en" ? "All accounts" : "全部账号" };
  }
  return config.cfAccounts.find((a) => a.accountId === accountId) || null;
}

/** 查询历史数据：支持单账号 / 全部账号汇总，按天 / 月 / 指定日期 */
async function queryHistory(env, accountId, spec) {
  const isAll = accountId === ALL_ACCOUNTS_ID;
  const limit = spec.kind === "days" ? spec.days : HISTORY_LIMIT;
  const AGG = "SELECT date_str, SUM(workers_requests) AS workers_requests, SUM(pages_requests) AS pages_requests FROM daily_stats";
  const SINGLE = "SELECT date_str, workers_requests, pages_requests FROM daily_stats";
  let rows = [];
  try {
    if (isAll) {
      if (spec.kind === "month") {
        rows = (
          await env.DB.prepare(`${AGG} WHERE date_str LIKE ? GROUP BY date_str ORDER BY date_str DESC LIMIT ?`)
            .bind(spec.month + "%", limit)
            .all()
        ).results;
      } else if (spec.kind === "day") {
        rows = (await env.DB.prepare(`${AGG} WHERE date_str = ? GROUP BY date_str`).bind(spec.day).all()).results;
      } else {
        rows = (
          await env.DB.prepare(`${AGG} GROUP BY date_str ORDER BY date_str DESC LIMIT ?`).bind(limit).all()
        ).results;
      }
    } else {
      if (spec.kind === "month") {
        rows = (
          await env.DB.prepare(
            `${SINGLE} WHERE account_id = ? AND date_str LIKE ? ORDER BY date_str DESC LIMIT ?`
          )
            .bind(accountId, spec.month + "%", limit)
            .all()
        ).results;
      } else if (spec.kind === "day") {
        rows = (
          await env.DB.prepare(`${SINGLE} WHERE account_id = ? AND date_str = ?`).bind(accountId, spec.day).all()
        ).results;
      } else {
        rows = (
          await env.DB.prepare(`${SINGLE} WHERE account_id = ? ORDER BY date_str DESC LIMIT ?`)
            .bind(accountId, limit)
            .all()
        ).results;
      }
    }
  } catch (e) {
    console.warn("[history] queryHistory failed:", e);
    rows = [];
  }
  return rows || [];
}

/** 汇总一批历史记录 */
function summarizeHistory(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let workers = 0;
  let pages = 0;
  let peak = null;
  let trough = null;
  for (const r of list) {
    const w = Number(r.workers_requests) || 0;
    const p = Number(r.pages_requests) || 0;
    const total = w + p;
    workers += w;
    pages += p;
    if (!peak || total > peak.total) peak = { date: r.date_str, total };
    if (!trough || total < trough.total) trough = { date: r.date_str, total };
  }
  const total = workers + pages;
  const days = list.length;
  return { days, workers, pages, total, avg: days ? total / days : 0, peak, trough };
}

/** 账号选择列表视图 */
function buildAccountPicker(config, lang) {
  const zh = lang !== "en";
  const text =
    config.cfAccounts.length > 0
      ? zh
        ? "*历史数据查询*\n请选择要查询的账号："
        : "*History*\nSelect an account:"
      : zh
      ? "*历史数据查询*\n未配置任何 Cloudflare 账号。"
      : "*History*\nNo Cloudflare account configured.";
  const kb = config.cfAccounts.map((a) => [{ text: a.name, callback_data: `hist_acc_${a.accountId}` }]);
  kb.push([
    {
      text: zh ? "全部账号汇总" : "All accounts",
      callback_data: `hist_acc_${ALL_ACCOUNTS_ID}`,
    },
  ]);
  return { text, replyMarkup: { inline_keyboard: kb } };
}

/** 时间范围选择视图 */
function buildRangePicker(config, accountId, lang) {
  const zh = lang !== "en";
  const acc = historyAccount(config, accountId, lang);
  const name = acc ? acc.name : accountId;
  const text = zh
    ? `*${escapeMd(name)}* — 请选择时间范围\n也可直接发送命令查询，例如 ${code("/history 主账号 2026-09")}（账号与时间范围均可省略）`
    : `*${escapeMd(name)}* — Select a range\nOr query directly, e.g. ${code("/history Main 2026-09")} (account and period are optional)`;
  const kb = [
    [
      { text: zh ? "近 10 天" : "Last 10d", callback_data: `hist_sum_${accountId}_10` },
      { text: zh ? "近 30 天" : "Last 30d", callback_data: `hist_sum_${accountId}_30` },
    ],
    [{ text: zh ? "近 90 天" : "Last 90d", callback_data: `hist_sum_${accountId}_90` }],
    [{ text: zh ? "返回账号列表" : "Back to accounts", callback_data: "nav_hist_list" }],
  ];
  return { text, replyMarkup: { inline_keyboard: kb } };
}

/** 汇总卡片视图 */
function buildHistorySummary(config, accountId, spec, rows, lang) {
  const zh = lang !== "en";
  const acc = historyAccount(config, accountId, lang);
  const name = acc ? acc.name : accountId;
  const label = rangeLabel(spec, lang);
  const token = rangeSpecToToken(spec);

  const backKb = [
    [
      { text: zh ? "返回区间" : "Range", callback_data: `hist_acc_${accountId}` },
      { text: zh ? "账号列表" : "Accounts", callback_data: "nav_hist_list" },
    ],
  ];

  const s = summarizeHistory(rows);
  if (!acc || s.days === 0) {
    const text = zh
      ? `*${escapeMd(name)}* · ${escapeMd(label)}\n\n_暂无历史数据_`
      : `*${escapeMd(name)}* · ${escapeMd(label)}\n\n_No history data_`;
    return { text, replyMarkup: { inline_keyboard: backKb } };
  }

  // 可用总量：单账号为 100,000；「全部账号汇总」需按账号数累加
  const capacity =
    accountId === ALL_ACCOUNTS_ID ? Math.max(1, config.cfAccounts.length) * USAGE_LIMIT : USAGE_LIMIT;

  const avgPct = usagePercent(s.avg, capacity);
  const peakPct = usagePercent(s.peak.total, capacity);
  const troughPct = usagePercent(s.trough.total, capacity);
  const first = rows[rows.length - 1].date_str;
  const last = rows[0].date_str;
  const span = first === last ? first : `${first} ~ ${last}`;

  const text = (
    zh
      ? [
          `*${escapeMd(name)}* · ${escapeMd(label)}`,
          "",
          `数据区间：${code(span)}（${s.days} 天）`,
          `合计请求：${code(s.total.toLocaleString())}`,
          `可用总量：${code(capacity.toLocaleString())}（每日）`,
          `日均请求：${code(Math.round(s.avg).toLocaleString())} · ${code(avgPct.toFixed(1) + "%")}`,
          `峰值：${code(s.peak.date)} ${code(s.peak.total.toLocaleString())} ${code(peakPct.toFixed(1) + "%")}`,
          `谷值：${code(s.trough.date)} ${code(s.trough.total.toLocaleString())} ${code(troughPct.toFixed(1) + "%")}`,
          `构成：Workers ${code(s.workers.toLocaleString())} · Pages ${code(s.pages.toLocaleString())}`,
          `峰值等级：${statusLabel(peakPct, lang)}`,
        ]
      : [
          `*${escapeMd(name)}* · ${escapeMd(label)}`,
          "",
          `Range: ${code(span)} \\(${s.days} days\\)`,
          `Total: ${code(s.total.toLocaleString())}`,
          `Capacity: ${code(capacity.toLocaleString())} per day`,
          `Daily avg: ${code(Math.round(s.avg).toLocaleString())} · ${code(avgPct.toFixed(1) + "%")}`,
          `Peak: ${code(s.peak.date)} ${code(s.peak.total.toLocaleString())} ${code(peakPct.toFixed(1) + "%")}`,
          `Trough: ${code(s.trough.date)} ${code(s.trough.total.toLocaleString())} ${code(troughPct.toFixed(1) + "%")}`,
          `Split: Workers ${code(s.workers.toLocaleString())} · Pages ${code(s.pages.toLocaleString())}`,
          `Peak level: ${statusLabel(peakPct, lang)}`,
        ]
  ).join("\n");

  const kb = [
    [{ text: zh ? "展开每日明细" : "Daily details", callback_data: `hist_det_${accountId}_${token}_0` }],
    ...backKb,
  ];
  return { text, replyMarkup: { inline_keyboard: kb } };
}

/** 每日明细分页视图（每页 10 条） */
function buildHistoryDetail(config, accountId, spec, rows, page, lang) {
  const zh = lang !== "en";
  const acc = historyAccount(config, accountId, lang);
  const name = acc ? acc.name : accountId;
  const label = rangeLabel(spec, lang);
  const token = rangeSpecToToken(spec);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const slice = rows.slice(p * pageSize, (p + 1) * pageSize);
  const cb = (target) => `hist_det_${accountId}_${token}_${target}`;

  const lines = [
    `*${escapeMd(name)}* · ${escapeMd(label)}`,
    zh ? `每日明细（第 ${p + 1}/${totalPages} 页）` : `Daily details \\(page ${p + 1}/${totalPages}\\)`,
    "",
  ];
  if (slice.length === 0) {
    lines.push(zh ? "_暂无数据_" : "_No data_");
  } else {
    for (const r of slice) {
      const w = Number(r.workers_requests) || 0;
      const pg = Number(r.pages_requests) || 0;
      const total = w + pg;
      const pp = usagePercent(total);
      const rowText = `${r.date_str} ${String(total.toLocaleString()).padStart(7)} ${makeProgressBar(pp, 8)} ${pp
        .toFixed(0)
        .padStart(3)}%`;
      lines.push(`${statusEmoji(pp)} ${code(rowText)}`);
    }
  }

  // 翻页（首页 / 上一页 / 下一页 / 末页）+ 跳页（页码按钮，页数 ≤ 10 时展示）
  const kb = [
    [
      { text: zh ? "首页" : "First", callback_data: cb(0) },
      { text: zh ? "上页" : "Prev", callback_data: cb(Math.max(p - 1, 0)) },
      { text: `${p + 1}/${totalPages}`, callback_data: cb(p) },
      { text: zh ? "下页" : "Next", callback_data: cb(Math.min(p + 1, totalPages - 1)) },
      { text: zh ? "末页" : "Last", callback_data: cb(totalPages - 1) },
    ],
  ];
  if (totalPages > 1 && totalPages <= 10) {
    const nums = [];
    for (let i = 0; i < totalPages; i++) {
      nums.push({ text: i === p ? `[${i + 1}]` : String(i + 1), callback_data: cb(i) });
    }
    for (let i = 0; i < nums.length; i += 5) kb.push(nums.slice(i, i + 5));
  }
  kb.push([
    { text: zh ? "返回汇总" : "Summary", callback_data: `hist_sum_${accountId}_${token}` },
    { text: zh ? "账号列表" : "Accounts", callback_data: "nav_hist_list" },
  ]);
  return { text: lines.join("\n"), replyMarkup: { inline_keyboard: kb } };
}

/* ==================== §6.1 文本命令表 ==================== */

/**
 * 文本命令处理器表：命令 → 处理函数。
 * 每个处理器接收 ctx（见 handleTextMessage），未命中的命令静默忽略。
 */
const TEXT_COMMANDS = {
  "/start": async (ctx) => {
    const { env, config, lang, sendMd, sync } = ctx;
    await sync(false);
    const latestDateRow = await env.DB.prepare("SELECT MAX(date_str) as max_date FROM daily_stats").first();
    if (!latestDateRow || !latestDateRow.max_date) {
      await sendMd(tr(lang, "startNoData"));
      return;
    }
    const latestDate = latestDateRow.max_date;
    const { results: todayStats } = await env.DB.prepare("SELECT * FROM daily_stats WHERE date_str = ?")
      .bind(latestDate)
      .all();
    let replyText = `${tr(lang, "startReportDate")}: ${code(latestDate)}\n\n`;
    for (const acc of config.cfAccounts) {
      const row =
        (todayStats || []).find((r) => r.account_id === acc.accountId) || { workers_requests: 0, pages_requests: 0 };
      const totalReqs = (row.workers_requests || 0) + (row.pages_requests || 0);
      const percentNum = usagePercent(totalReqs);
      replyText += tr(lang, "accountUsage", {
        name: escapeMd(acc.name),
        usage: code(`${totalReqs.toLocaleString()} / ${USAGE_LIMIT.toLocaleString()}`),
        bar: code(`${makeProgressBar(percentNum)} ${percentNum.toFixed(1)}%`),
        status: statusLabel(percentNum, lang),
      });
    }
    await sendMd(replyText.trim());
  },

  "/lang": async (ctx) => {
    const inline_keyboard = [
      [
        { text: "简体中文", callback_data: "lang_zh" },
        { text: "English", callback_data: "lang_en" },
      ],
    ];
    await ctx.sendMd(tr(ctx.lang, "pickLanguage"), { inline_keyboard });
  },

  "/history": async (ctx) => {
    const { env, config, lang, argText, sendMd } = ctx;
    // 无参数 → 账号选择列表
    if (!argText) {
      const view = buildAccountPicker(config, lang);
      await sendMd(view.text, view.replyMarkup);
      return;
    }
    // 关键字（账号名/ID）+ 可选时间段
    const tokens = argText.split(/\s+/);
    const matches = findAccounts(config, tokens[0]);
    if (matches.length === 0) {
      await sendMd(`${tr(lang, "accountNotFound", { q: escapeMd(tokens[0]) })}\n\n${historyUsage(lang)}`);
      return;
    }
    if (matches.length > 1 && tokens[0].length < 6) {
      // 关键字过短导致多匹配 → 让用户从列表中选择
      const kb = matches.map((a) => [{ text: a.name, callback_data: `hist_acc_${a.accountId}` }]);
      await sendMd(tr(lang, "multipleMatches"), { inline_keyboard: kb });
      return;
    }
    const acc = matches[0];
    const spec = tokens[1] ? parsePeriodInput(tokens[1]) : { kind: "days", days: 30 };
    if (!spec) {
      await sendMd(`${tr(lang, "invalidPeriod")}\n\n${historyUsage(lang)}`);
      return;
    }
    const rows = await queryHistory(env, acc.accountId, spec);
    const view = buildHistorySummary(config, acc.accountId, spec, rows, lang);
    await sendMd(view.text, view.replyMarkup);
  },

  "/notify": async (ctx) => {
    const { env, chatId, lang, sendMd, ensurePrefs } = ctx;
    const newState = !(await ensurePrefs()).report_enabled;
    await setUserPref(env, chatId, "report_enabled", newState);
    await sendMd(tr(lang, newState ? "reportOn" : "reportOff"));
  },

  "/settings": async (ctx) => {
    const { config, lang, sendMd, ensurePrefs } = ctx;
    const view = renderSettingsMenu(await ensurePrefs(), lang, config.cfAccounts);
    await sendMd(view.text, view.replyMarkup);
  },

  "/report_hours": async (ctx) => {
    const { env, chatId, lang, argText, sendMd } = ctx;
    const parsed = parsePref("report_hours", argText);
    if (!parsed.ok) {
      await sendMd(tr(lang, "usageReportHours"));
      return;
    }
    await setUserPref(env, chatId, "report_hours", parsed.value);
    await sendMd(tr(lang, "pushTimeSet", { v: code(formatHours(parsed.value)) }));
  },

  "/timezone": async (ctx) => {
    const { env, chatId, lang, argText, sendMd } = ctx;
    const tz = parseTimezoneInput(argText);
    if (tz === null) {
      await sendMd(tr(lang, "usageTimezone"));
      return;
    }
    await setUserPref(env, chatId, "report_tz_offset", tz);
    await sendMd(tr(lang, "tzSet", { v: code(formatTzOffset(tz)) }));
  },

  "/alert_thresholds": async (ctx) => {
    const { env, chatId, lang, argText, sendMd } = ctx;
    const parsed = parsePref("alert_thresholds", argText);
    if (!parsed.ok) {
      await sendMd(tr(lang, "usageThresholds"));
      return;
    }
    await setUserPref(env, chatId, "alert_thresholds", parsed.value);
    await sendMd(tr(lang, "thresholdsSet", { v: code(formatLevels(parsed.value)) }));
  },

  "/alert_interval": async (ctx) => {
    const { env, chatId, lang, argText, sendMd } = ctx;
    const parsed = parsePref("alert_min_interval", argText);
    if (!parsed.ok) {
      await sendMd(tr(lang, "usageInterval"));
      return;
    }
    await setUserPref(env, chatId, "alert_min_interval", parsed.value);
    await sendMd(tr(lang, "intervalSet", { v: escapeMd(formatMinutes(parsed.value, lang)) }));
  },

  "/monitor_accounts": async (ctx) => {
    const { env, config, chatId, lang, argText, sendMd } = ctx;
    if (!argText) {
      await sendMd(tr(lang, "usageMonitorAccounts"));
      return;
    }
    if (/^(all|全部|\*)$/i.test(argText)) {
      await setUserPref(env, chatId, "monitor_accounts", []);
      await sendMd(tr(lang, "scopeAll"));
      return;
    }
    const tokens = argText.split(/[,，\s]+/).filter(Boolean);
    const ids = [];
    const unknown = [];
    const ambiguous = [];
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      // 先精确匹配（ID / 名称），命中即采用；否则模糊匹配，多匹配则要求消歧，避免短关键字误选大量账号
      const exact = config.cfAccounts.filter(
        (a) => a.accountId.toLowerCase() === lower || a.name.toLowerCase() === lower
      );
      const matches = exact.length > 0 ? exact : findAccounts(config, tok);
      if (matches.length === 0) unknown.push(tok);
      else if (matches.length > 1) ambiguous.push(`${tok}(${matches.map((a) => a.name).join("/")})`);
      else if (!ids.includes(matches[0].accountId)) ids.push(matches[0].accountId);
    }
    if (unknown.length > 0) {
      await sendMd(tr(lang, "accountNotFound", { q: escapeMd(unknown.join(", ")) }));
      return;
    }
    if (ambiguous.length > 0) {
      await sendMd(tr(lang, "ambiguousAccounts", { v: escapeMd(ambiguous.join("; ")) }));
      return;
    }
    if (ids.length === 0) {
      await sendMd(tr(lang, "noAccountResolved"));
      return;
    }
    await setUserPref(env, chatId, "monitor_accounts", ids);
    const names = ids
      .map((id) => {
        const a = config.cfAccounts.find((x) => x.accountId === id);
        return a ? a.name : id;
      })
      .join(lang === "zh" ? "、" : ", ");
    await sendMd(tr(lang, "scopeSet", { v: escapeMd(names) }));
  },

  "/sync": async (ctx) => {
    const { lang, sendMd, sync } = ctx;
    await sendMd(tr(lang, "syncing"));
    await sync(false);
    await sendMd(tr(lang, "syncDone"));
  },

  "/whoami": async (ctx) => {
    const { chatId, role, lang, sendMd } = ctx;
    await sendMd(tr(lang, "whoami", { role, id: chatId }));
  },

  "/help": async (ctx) => {
    await ctx.sendMd(tr(ctx.lang, "help"));
  },
};

/* ==================== §7 Worker 入口 ==================== */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.runScheduled(env));
  },

  /**
   * 定时任务主体。由 Cloudflare Cron Trigger 触发，
   * 负责拉取用量、按用户偏好推送预警与定时日报、清理过期数据。
   * 返回同步与清理的统计摘要，便于在日志中确认执行结果。
   */
  async runScheduled(env) {
    const sync = await this.syncData(env, true);
    let cleaned = { rateLimits: 0, securityEvents: 0 };
    try {
      const cutoffSec = nowSec() - SEC_EVENT_RETENTION_SEC;
      const r1 = await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoffSec).run();
      const r2 = await env.DB.prepare("DELETE FROM security_events WHERE ts < ?")
        .bind(new Date(cutoffSec * 1000).toISOString())
        .run();
      cleaned = { rateLimits: r1?.meta?.changes ?? 0, securityEvents: r2?.meta?.changes ?? 0 };
    } catch (e) {
      console.warn("[cron] cleanup failed:", e); // 清理失败不影响主流程
    }
    return { ...sync, cleaned };
  },

  /**
   * 唯一的对外入口：Telegram Webhook。
   * 本 Worker 不含任何网页前端，除 `/tg-webhook` 外一律 404。
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const config = getAppConfig(env);
    const ip = getClientIp(request);

    if (url.pathname === "/tg-webhook") {
      return this.handleTelegramWebhook(request, env, config, ip);
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain;charset=UTF-8", "X-Content-Type-Options": "nosniff" },
    });
  },

  /* ---------- Webhook 校验与鉴权 ---------- */
  async handleTelegramWebhook(request, env, config, ip) {
    if (request.method !== "POST") return new Response("OK");

    // 1) 密钥校验（fail-closed）
    if (config.webhookSecrets.length === 0) {
      await reportConfigIssue(
        env,
        config,
        "webhook_secret_missing",
        "TG_WEBHOOK_SECRET 未配置，已按 fail-closed 拒绝所有 Webhook 请求"
      );
      return new Response("Unauthorized", { status: 401 });
    }

    const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    const secretOk = config.webhookSecrets.some((s) => timingSafeEqual(s, provided));
    if (!secretOk) {
      await reportSecurityEvent(env, config, {
        type: "webhook_auth_failed",
        severity: "crit",
        ip,
        detail: provided ? "secret_mismatch" : "secret_absent",
      });
      return new Response("Unauthorized", { status: 401 });
    }

    // 2) 可选来源 IP 白名单
    if (config.webhookEnforceIp) {
      const inRange = config.ipRanges.some((cidr) => ipInCidr(ip, cidr));
      if (!inRange) {
        await reportSecurityEvent(env, config, {
          type: "webhook_ip_rejected",
          severity: "crit",
          ip,
          detail: "source_ip_not_in_telegram_ranges",
        });
        return new Response("Forbidden", { status: 403 });
      }
    }

    // 3) 解析更新
    let update;
    try {
      const raw = await request.text();
      if (raw.length > TG_MAX_BODY_BYTES) return new Response("OK");
      update = JSON.parse(raw);
    } catch (e) {
      console.warn("[webhook] payload parse error:", e);
      return new Response("OK");
    }

    try {
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query, env, config, ip);
      } else if (update.message && update.message.text) {
        await this.handleTextMessage(update.message, env, config, ip);
      }
    } catch (e) {
      console.warn("[webhook] handler error:", e);
      await logSecurityEvent(env, { type: "webhook_handler_error", severity: "warn", ip, detail: String(e).slice(0, 200) });
    }

    return new Response("OK");
  },

  /** 回调按钮处理（含角色校验与限流） */
  async handleCallbackQuery(cb, env, config, ip) {
    if (!cb || !cb.message || !cb.message.chat) return;
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;
    const data = String(cb.data || "");

    // 限流：防止按钮被脚本化高频点击
    const rl = await checkRateLimit(env, `tgc:${chatId}`, config.rateLimit.max, config.rateLimit.windowSec);
    if (!rl.allowed) {
      await reportSecurityEvent(
        env,
        config,
        {
          type: "callback_rate_limited",
          severity: "warn",
          actor: chatId,
          ip,
          detail: `count=${rl.count} data=${data.slice(0, 40)}`,
        },
        { windowSec: 600 }
      );
      await answerCallbackQuery(
        config.tgBotToken,
        cb.id,
        "操作过于频繁，请稍后再试 / Too many requests, please slow down."
      );
      return;
    }

    const role = await resolveRole(env, config, chatId);
    const required = CALLBACK_MIN_ROLE[data] || Object.keys(CALLBACK_MIN_ROLE).find((k) => data.startsWith(k));
    const minRole = CALLBACK_MIN_ROLE[required] || "viewer";

    if (!roleAtLeast(role, minRole)) {
      await reportSecurityEvent(env, config, {
        type: "callback_auth_denied",
        severity: "warn",
        actor: chatId,
        ip,
        detail: `role=${role || "none"} data=${data.slice(0, 40)}`,
      });
      await answerCallbackQuery(config.tgBotToken, cb.id, role ? "权限不足 / Permission denied" : "");
      return;
    }

    const userSetting = await env.DB.prepare("SELECT lang, cron_enabled FROM user_settings WHERE chat_id = ?")
      .bind(chatId)
      .first();
    const lang = userSetting?.lang || "zh";

    if (data.startsWith("lang_")) {
      const newLang = data.split("_")[1];
      if (newLang !== "zh" && newLang !== "en") {
        await answerCallbackQuery(config.tgBotToken, cb.id);
        return;
      }
      await env.DB.prepare(
        "INSERT INTO user_settings (chat_id, lang) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET lang = excluded.lang"
      )
        .bind(chatId, newLang)
        .run();
      await answerCallbackQuery(config.tgBotToken, cb.id, tr(newLang, "langSwitched"));
      await editTgMessage(config.tgBotToken, chatId, messageId, tr(newLang, "langSwitchedMsg"));
      return;
    }

    if (data === "nav_hist_list") {
      const view = buildAccountPicker(config, lang);
      await editTgMessageInline(
        config.tgBotToken,
        chatId,
        messageId,
        view.text,
        view.replyMarkup.inline_keyboard
      );
      await answerCallbackQuery(config.tgBotToken, cb.id);
      return;
    }

    if (data.startsWith("hist_acc_")) {
      const accId = data.slice("hist_acc_".length);
      const view = buildRangePicker(config, accId, lang);
      await editTgMessageInline(
        config.tgBotToken,
        chatId,
        messageId,
        view.text,
        view.replyMarkup.inline_keyboard
      );
      await answerCallbackQuery(config.tgBotToken, cb.id);
      return;
    }

    if (data.startsWith("hist_sum_") || data.startsWith("hist_det_")) {
      const isDetail = data.startsWith("hist_det_");
      const rest = data.slice((isDetail ? "hist_det_" : "hist_sum_").length);
      let accountId;
      let token;
      let page = 0;
      if (isDetail) {
        const parts = rest.split("_");
        page = parseInt(parts.pop(), 10) || 0;
        token = parts.pop();
        accountId = parts.join("_");
      } else {
        const i = rest.lastIndexOf("_");
        accountId = rest.slice(0, i);
        token = rest.slice(i + 1);
      }
      const spec = parseRangeSpec(token);
      const acc = historyAccount(config, accountId, lang);
      if (!spec || !acc) {
        await answerCallbackQuery(config.tgBotToken, cb.id);
        return;
      }
      const rows = await queryHistory(env, accountId, spec);
      const view = isDetail
        ? buildHistoryDetail(config, accountId, spec, rows, page, lang)
        : buildHistorySummary(config, accountId, spec, rows, lang);
      await editTgMessageInline(
        config.tgBotToken,
        chatId,
        messageId,
        view.text,
        view.replyMarkup.inline_keyboard
      );
      await answerCallbackQuery(config.tgBotToken, cb.id);
      return;
    }

    if (data.startsWith("set_")) {
      // 复用上文已查询的 userSetting，避免重复查询
      const globals = await loadGlobalPrefs(env);
      const prefs = await resolvePrefs(env, chatId, globals, userSetting?.cron_enabled);

      if (data === "set_rep") {
        await setUserPref(env, chatId, "report_enabled", !prefs.report_enabled);
      } else if (data === "set_alr") {
        await setUserPref(env, chatId, "alert_enabled", !prefs.alert_enabled);
      } else if (data === "set_api") {
        await setUserPref(env, chatId, "alert_on_api_error", !prefs.alert_on_api_error);
      } else if (data.startsWith("set_int:")) {
        const p = INTERVAL_PRESETS[Number(data.split(":")[1])];
        if (p) await setUserPref(env, chatId, "alert_min_interval", p.value);
      } else if (data.startsWith("set_acc:")) {
        const arg = data.slice("set_acc:".length);
        if (arg === "all") {
          await setUserPref(env, chatId, "monitor_accounts", []);
        } else {
          const acc = config.cfAccounts[Number(arg)];
          if (acc) {
            const cur = new Set(prefs.monitor_accounts || []);
            if (cur.has(acc.accountId)) cur.delete(acc.accountId);
            else cur.add(acc.accountId);
            let next = Array.from(cur);
            if (next.length >= config.cfAccounts.length) next = [];
            await setUserPref(env, chatId, "monitor_accounts", next);
          }
        }
      }

      // 重新读取并刷新菜单
      const fresh = await resolvePrefs(env, chatId, globals, userSetting?.cron_enabled);
      const view = renderSettingsMenu(fresh, userSetting?.lang || "zh", config.cfAccounts);
      await editTgMessageInline(config.tgBotToken, chatId, messageId, view.text, view.replyMarkup.inline_keyboard);
      await answerCallbackQuery(config.tgBotToken, cb.id, tr(userSetting?.lang || "zh", "callbackUpdated"));
      return;
    }

    await answerCallbackQuery(config.tgBotToken, cb.id);
  },

  /** 文本命令处理（含角色分级、限流、失败处理） */
  async handleTextMessage(message, env, config, ip) {
    const chatId = message.chat.id;
    const text = String(message.text || "").trim();
    const parts = text.split(/\s+/);
    const command = parts[0].split("@")[0];
    const argText = parts.slice(1).join(" ").trim();

    // 限流：所有来源统一计数，防止刷接口
    const rl = await checkRateLimit(env, `tg:${chatId}`, config.rateLimit.max, config.rateLimit.windowSec);
    if (!rl.allowed) {
      await reportSecurityEvent(
        env,
        config,
        { type: "tg_rate_limited", severity: "warn", actor: chatId, ip, detail: `count=${rl.count} cmd=${command}` },
        { windowSec: 600 }
      );
      await sendTgMessage(config.tgBotToken, chatId, "请求过于频繁，请稍后再试 / Too many requests, please slow down.");
      return;
    }

    const role = await resolveRole(env, config, chatId);
    const minRole = COMMAND_MIN_ROLE[command] || "viewer";

    if (!roleAtLeast(role, minRole)) {
      await reportSecurityEvent(env, config, {
        type: "command_auth_denied",
        severity: role ? "warn" : "crit",
        actor: chatId,
        ip,
        detail: `role=${role || "none"} cmd=${command}`,
      });
      // 未授权用户不回执任何内容，避免暴露机器人存在性与权限结构
      if (role) {
        await sendTgMessage(config.tgBotToken, chatId, "权限不足 / Permission denied");
      }
      return;
    }

    const userSetting = await env.DB.prepare("SELECT lang, cron_enabled FROM user_settings WHERE chat_id = ?")
      .bind(chatId)
      .first();
    const lang = userSetting?.lang || "zh";

    // 惰性加载偏好：仅当命令真正需要时才查询全局 / 个人偏好
    let globalsCache;
    let prefsCache;
    const ctx = {
      chatId,
      command,
      argText,
      lang,
      role,
      env,
      config,
      ip,
      ensurePrefs: async () => {
        if (!globalsCache) globalsCache = await loadGlobalPrefs(env);
        if (!prefsCache) prefsCache = await resolvePrefs(env, chatId, globalsCache, userSetting?.cron_enabled);
        return prefsCache;
      },
      sync: (isCron = false) => this.syncData(env, isCron),
      sendMd: (t, m = null) => sendTgMessageMd(config.tgBotToken, chatId, t, m),
    };

    const handler = TEXT_COMMANDS[command];
    if (handler) await handler(ctx);
  },

  /* ---------- 数据同步（预警与日报按每个管理员的偏好驱动） ---------- */
  async syncData(env, isCron = false) {
    const config = getAppConfig(env);
    const nowUtc = new Date();
    const utcDateStr = nowUtc.toISOString().split("T")[0];

    const globals = await loadGlobalPrefs(env);

    let failed = 0;
    let pushed = 0;
    let alerts = 0;

    // 各账号请求并行拉取，缩短同步耗时
    const fetchResults = await Promise.all(
      config.cfAccounts.map(async (account) => ({
        account,
        requests: await getWorkerStats(account.accountId, account.apiToken),
      }))
    );

    const { results: existingStats } = await env.DB.prepare(
      "SELECT account_id, workers_requests, pages_requests FROM daily_stats WHERE date_str = ?"
    )
      .bind(utcDateStr)
      .all();

    const insertStatements = [];
    // 每个账号本次同步的用量变化，供按「各用户自己的阈值」判断是否跨越
    const transitions = [];

    for (const { account, requests } of fetchResults) {
      if (!requests) {
        failed++;
        transitions.push({ account, apiFailed: true });
        continue;
      }

      const totalReqs = requests.total;
      const row = (existingStats || []).find((r) => r.account_id === account.accountId);
      const oldTotal = row ? (row.workers_requests || 0) + (row.pages_requests || 0) : 0;
      transitions.push({
        account,
        apiFailed: false,
        newTotal: totalReqs,
        oldPercent: (oldTotal / USAGE_LIMIT) * 100,
        newPercent: (totalReqs / USAGE_LIMIT) * 100,
      });

      insertStatements.push(
        env.DB.prepare(
          `INSERT INTO daily_stats (account_name, account_id, date_str, workers_requests, pages_requests)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id, date_str) DO UPDATE SET
           workers_requests = excluded.workers_requests,
           pages_requests = excluded.pages_requests,
           account_name = excluded.account_name`
        ).bind(account.name, account.accountId, utcDateStr, requests.workers, requests.pages)
      );
    }

    if (insertStatements.length > 0) {
      await env.DB.batch(insertStatements);
    }

    // 预先解析每个管理员的语言与生效偏好（个人偏好 > 全局默认 > 代码默认），并行查询
    const adminPrefs = new Map();
    await Promise.all(
      config.adminTgIds.map(async (adminId) => {
        const setting = await env.DB.prepare("SELECT lang, cron_enabled FROM user_settings WHERE chat_id = ?")
          .bind(adminId)
          .first();
        const prefs = await resolvePrefs(env, adminId, globals, setting?.cron_enabled);
        adminPrefs.set(adminId, { prefs, lang: setting?.lang || "zh" });
      })
    );

    // 预警：按每个管理员自己的开关、阈值、账号范围与最小间隔推送
    for (const [adminId, { prefs }] of adminPrefs) {
      if (!prefs.alert_enabled) continue;
      const scope =
        prefs.monitor_accounts && prefs.monitor_accounts.length > 0 ? new Set(prefs.monitor_accounts) : null;
      const minGapSec = Math.max(0, Number(prefs.alert_min_interval) || 0) * 60;
      const msgs = [];
      for (const t of transitions) {
        if (scope && !scope.has(t.account.accountId)) continue;
        if (t.apiFailed) {
          if (prefs.alert_on_api_error) {
            // API 异常同样受最小间隔约束，避免接口持续失败时每轮都刷屏
            const errKey = `apierr_cd:${adminId}:${t.account.accountId}`;
            if (minGapSec > 0) {
              const last = Number(await getMeta(env, errKey)) || 0;
              if (nowSec() - last < minGapSec) continue;
            }
            msgs.push(`[SYS_ERR]\nID: ${t.account.name}\nERR: API_FETCH_FAILED\nCHECK TOKEN OR NETWORK STATUS.`);
            await setMeta(env, errKey, String(nowSec()));
          }
          continue;
        }
        const crossed = crossedLevels(t.oldPercent, t.newPercent, prefs.alert_thresholds);
        if (crossed.length === 0) continue;
        // 最小间隔：同一账号的阈值预警在间隔内只推送一次
        const cooldownKey = `alert_cd:${adminId}:${t.account.accountId}`;
        if (minGapSec > 0) {
          const last = Number(await getMeta(env, cooldownKey)) || 0;
          if (nowSec() - last < minGapSec) continue;
        }
        const threshold = crossed[crossed.length - 1];
        msgs.push(
          `[SYS_ALERT]\nID: ${t.account.name}\nUSE: ${t.newTotal.toLocaleString()} / ${USAGE_LIMIT.toLocaleString()}\nLVL: > ${threshold}%\nSTATUS: LIMIT_APPROACHING`
        );
        await setMeta(env, cooldownKey, String(nowSec()));
      }
      if (msgs.length > 0) {
        await sendTgMessage(config.tgBotToken, adminId, msgs.join("\n---\n"));
        alerts += msgs.length;
      }
    }

    // 定时日报：按每个管理员的本地时区与所选整点推送
    if (isCron) {
      const { results: todayStats } = await env.DB.prepare("SELECT * FROM daily_stats WHERE date_str = ?")
        .bind(utcDateStr)
        .all();

      for (const [adminId, { prefs, lang }] of adminPrefs) {
        if (!prefs.report_enabled) continue;

        const local = toLocalDate(nowUtc, prefs.report_tz_offset);
        const localHour = local.getUTCHours();
        if (!prefs.report_hours.includes(localHour)) continue;

        // 按「本地日期+小时」幂等：同一小时只推送一次，重复触发不会重发
        const hourKey = `report_hour:${adminId}`;
        const currentHourKey = `${local.toISOString().split("T")[0]}T${String(localHour).padStart(2, "0")}`;
        if ((await getMeta(env, hourKey)) === currentHourKey) continue;

        const scope =
          prefs.monitor_accounts && prefs.monitor_accounts.length > 0
            ? config.cfAccounts.filter((a) => prefs.monitor_accounts.includes(a.accountId))
            : config.cfAccounts;

        const timeLabel = `${String(localHour).padStart(2, "0")}:00 ${formatTzOffset(prefs.report_tz_offset)}`;
        let replyText = tr(lang, "reportHeader", { time: escapeMd(timeLabel), date: code(utcDateStr) });

        for (const acc of scope) {
          const row = (todayStats || []).find((r) => r.account_id === acc.accountId) || { workers_requests: 0, pages_requests: 0 };
          const totalReqs = (row.workers_requests || 0) + (row.pages_requests || 0);
          const percentNum = usagePercent(totalReqs);
          replyText += tr(lang, "accountUsage", {
            name: escapeMd(acc.name),
            usage: code(`${totalReqs.toLocaleString()} / ${USAGE_LIMIT.toLocaleString()}`),
            bar: code(`${makeProgressBar(percentNum)} ${percentNum.toFixed(1)}%`),
            status: statusLabel(percentNum, lang),
          });
        }
        // 仅在发送成功后才写入幂等标记，避免发送失败导致本小时漏推且不再重试
        const sent = await sendTgMessageMd(config.tgBotToken, adminId, replyText.trim());
        if (sent) {
          await setMeta(env, hourKey, currentHourKey);
          pushed++;
        }
      }
    }

    // 记录本次同步时间
    await setMeta(env, "sync:last", String(nowSec()));

    return { synced: insertStatements.length, failed, alerts, pushed };
  },
};
