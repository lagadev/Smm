-- TeleGrow SMM Panel — D1 Schema
-- Apply with: wrangler d1 execute telegrow-db --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   TEXT UNIQUE NOT NULL,
  username      TEXT,
  first_name    TEXT,
  photo_url     TEXT,
  balance       REAL NOT NULL DEFAULT 0,
  referred_by   TEXT,
  referral_paid INTEGER NOT NULL DEFAULT 0,
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  icon        TEXT DEFAULT 'fa-solid fa-layer-group',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER NOT NULL,
  name          TEXT NOT NULL,
  rate          REAL NOT NULL,          -- price per 1000, in site currency
  min_qty       INTEGER NOT NULL DEFAULT 100,
  max_qty       INTEGER NOT NULL DEFAULT 10000,
  description   TEXT,
  provider_id   TEXT,                   -- upstream SMM provider service id (optional)
  status        TEXT NOT NULL DEFAULT 'active',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  service_id    INTEGER NOT NULL,
  service_name  TEXT NOT NULL,
  category_name TEXT,
  link          TEXT NOT NULL,
  quantity      INTEGER NOT NULL,
  charge        REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending', -- Pending, Processing, Completed, Partial, Cancelled
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (service_id) REFERENCES services(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  type        TEXT NOT NULL,   -- ad_reward, order, admin_add, admin_deduct, referral
  amount      REAL NOT NULL,   -- positive = credit, negative = debit
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ad_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  watched_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_services_cat ON services(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_adlogs_user_date ON ad_logs(user_id, watched_at);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', 'TeleGrow'),
  ('currency', 'BDT'),
  ('currency_symbol', '৳'),
  ('ad_reward', '0.50'),
  ('daily_ad_limit', '15'),
  ('cooldown_minutes', '30'),
  ('monetag_zone_id', ''),
  ('bot_username', ''),
  ('bot_token', ''),
  ('channel_link', 'https://t.me/'),
  ('support_link', 'https://t.me/'),
  ('referral_reward', '5'),
  ('min_deposit_via_ads', '0'),
  ('admin_password', 'changeme123');

-- Sample categories + services (edit or delete from the admin panel)
INSERT OR IGNORE INTO categories (id, name, icon, sort_order) VALUES
  (1, 'Telegram', 'fa-brands fa-telegram', 1),
  (2, 'YouTube', 'fa-brands fa-youtube', 2),
  (3, 'Facebook', 'fa-brands fa-facebook', 3),
  (4, 'Instagram', 'fa-brands fa-instagram', 4),
  (5, 'TikTok', 'fa-brands fa-tiktok', 5);

INSERT OR IGNORE INTO services (id, category_id, name, rate, min_qty, max_qty, description, sort_order) VALUES
  (1, 1, 'Telegram Channel Members', 45, 100, 50000, 'Real, non-drop members', 1),
  (2, 1, 'Telegram Post Views', 8, 100, 100000, 'Fast delivery', 2),
  (3, 2, 'YouTube Subscribers', 250, 50, 20000, 'High retention', 1),
  (4, 2, 'YouTube Views', 30, 500, 500000, 'Worldwide views', 2),
  (5, 3, 'Facebook Page Likes', 60, 100, 20000, NULL, 1),
  (6, 4, 'Instagram Followers', 70, 100, 50000, 'No password required', 1),
  (7, 4, 'Instagram Likes', 15, 50, 20000, NULL, 2),
  (8, 5, 'TikTok Followers', 55, 100, 30000, NULL, 1);
