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