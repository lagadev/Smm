# TeleGrow — SMM Panel Telegram Mini App

A Telegram Mini App SMM panel: users order social media services (Telegram, YouTube,
Facebook, Instagram, TikTok…), pay from an in-app wallet, and can top up that wallet
by watching rewarded ads. Everything (categories, services, orders, users, settings)
is managed from `/admin`. Runs entirely on Cloudflare Workers + D1 — no separate server.

## Folder structure

```
/
├── index.html            # User Mini App (Home, New Order, Add Funds, History)
├── assets/
│   ├── css/
│   │   ├── style.css     # shared design tokens + user app styles
│   │   └── admin.css     # admin panel layout styles
│   ├── js/
│   │   ├── app.js        # user app logic
│   │   └── admin.js      # admin panel logic
│   └── img/
├── admin/
│   └── index.html        # Admin panel (password-protected)
├── worker.js              # Cloudflare Worker — all /api/* routes
├── schema.sql             # D1 schema + starter categories/services
├── wrangler.jsonc          # Worker + D1 + static assets config
├── package.json
└── README.md
```

## 1. Prerequisites

- A Cloudflare account (free tier is fine)
- Node.js installed locally
- `npm install -g wrangler` (or use `npx wrangler`)
- A Telegram bot created via [@BotFather](https://t.me/BotFather) — you'll need its token

## 2. Create the D1 database

```bash
wrangler login
wrangler d1 create telegrow-db
```

Copy the `database_id` from the output into `wrangler.jsonc` (`d1_databases[0].database_id`).

## 3. Apply the schema

```bash
wrangler d1 execute telegrow-db --file=./schema.sql --remote
```

This creates all tables and inserts sensible starter settings, sample categories
and sample services (edit or delete any of these from the admin panel).

## 4. Configure secrets

The bot token and admin password can be set from the admin panel's **Settings**
tab after first deploy (stored in D1), or set as Worker secrets/vars up front:

```bash
wrangler secret put BOT_TOKEN
wrangler secret put ADMIN_PASSWORD
```

> The default admin password from `schema.sql` is `changeme123` — **change this
> immediately** in Settings → Security after your first login.

## 5. Deploy

```bash
npm install
wrangler deploy
```

Wrangler prints your `*.workers.dev` URL. Set that URL as your bot's Mini App /
Web App URL via BotFather (`/mybots` → your bot → **Bot Settings** → **Menu Button**
or **Web App**).

## 6. Local development

```bash
wrangler d1 execute telegrow-db --file=./schema.sql --local
wrangler dev
```

Opening the app outside Telegram (e.g. directly in a browser) automatically falls
back to a guest debug user so you can preview the UI without a bot token configured.

## Admin panel

Visit `https://<your-worker>.workers.dev/admin` and log in with the admin password.
From there you can:

- Add / edit / delete **categories** and **services** (rate per 1000, min/max quantity)
- Review and update **order** status (Pending → Processing → Completed, or Cancel to
  auto-refund the user's wallet)
- Search **users**, manually add/deduct wallet balance, or ban/unban an account
- Configure **settings**: bot username/token, Monetag ad zone ID, ad reward amount,
  daily ad limit, referral reward, support & channel links, and the admin password

## Notes

- Ad rewards are dispensed through the Monetag SDK (`libtl.com/sdk.js`), matching the
  zone ID you set in Settings. Leave it blank while testing — the app then simulates
  a completed ad after ~1.2s so you can test the reward flow without a live zone.
- Telegram WebApp `initData` is verified server-side (HMAC-SHA256 against your bot
  token) before any wallet or order action is trusted.
- Currency defaults to BDT (৳) but can be changed from Settings.
