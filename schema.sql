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

CREATE TABLE IF NOT EXISTS tg_roles (
    chat_id INTEGER PRIMARY KEY,
    role TEXT NOT NULL,
    granted_by INTEGER,
    granted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    actor TEXT,
    ip TEXT,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_sec_events_ts ON security_events(ts);

CREATE INDEX IF NOT EXISTS idx_sec_events_type_ts ON security_events(event_type, ts);

CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_prefs (
    chat_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, key)
);
