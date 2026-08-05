/**
 * TeleGrow — SMM Panel Mini App backend (v5)
 * Cloudflare Worker + D1 + Cron Triggers
 *
 * Mini App routes:
 *   GET  /api/settings/public
 *   POST /api/auth                        { initData }
 *   GET  /api/user?telegram_id=
 *   GET  /api/user/stats?telegram_id=
 *   POST /api/user/regenerate-token       { telegram_id }
 *   POST /api/user/mark-onboarded         { telegram_id }
 *   GET  /api/categories
 *   GET  /api/services?category_id=
 *   POST /api/order                       { telegram_id, service, link, quantity }
 *   POST /api/order/refill                { telegram_id, order_id }
 *   GET  /api/orders?telegram_id=
 *   GET  /api/transactions?telegram_id=
 *   POST /api/ad-reward                   { telegram_id }
 *   POST /api/promo/redeem                { telegram_id, code }
 *   GET  /api/force-join
 *   POST /api/verify-join                 { telegram_id }
 *
 * Reseller / child API (see /docs.html):
 *   POST /api/v2   { key, action: services|add|status|refill|refill_status|cancel|balance, ... }
 *
 * Telegram bot webhook (set via Admin → Settings → Bot Control):
 *   POST /api/telegram/webhook?secret=...
 *
 * Admin routes — require header X-Admin-Password:
 *   POST /api/admin/login
 *   GET  /api/admin/stats
 *   GET/POST/PUT/DELETE /api/admin/categories(/:id)
 *   GET/POST/PUT/DELETE /api/admin/services(/:id)   (public_id is admin-editable)
 *   GET/PUT /api/admin/orders(/:id)   POST /api/admin/orders/:id/sync
 *   GET/PUT /api/admin/users(/:id)    GET /api/admin/users/:id/detail
 *   GET/POST/PUT/DELETE /api/admin/force-join(/:id)
 *   GET/POST/PUT/DELETE /api/admin/promo(/:id)
 *   GET/PUT /api/admin/settings
 *   POST /api/admin/telegram/set-webhook
 *   POST /api/admin/broadcast
 *
 * Order log: on every successful order (Mini App or reseller API), if
 * order_log_enabled=1, a formatted HTML log is posted to order_log_channel.
 *
 * Cron (wrangler.jsonc triggers.crons):
 *   "*\/5 * * * *"  -> sync Processing orders + pending refills from the provider
 *   "0 * * * *"     -> daily broadcast, once per configured hour
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: withCORS(JSON_HEADERS) });
}
function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}
function withCORS(headers = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
  };
}
function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function parseIdList(raw) {
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
}

async function genPublicId(db) {
  for (let i = 0; i < 20; i++) {
    const candidate = 100000 + Math.floor(Math.random() * 900000);
    const exists = await db.prepare("SELECT id FROM services WHERE public_id = ?").bind(candidate).first();
    if (!exists) return candidate;
  }
  return 100000 + Math.floor(Math.random() * 900000);
}

// ---------- Telegram WebApp initData validation ----------
async function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [];
  for (const [k, v] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) pairs.push(`${k}=${v}`);
  const dataCheckString = pairs.join("\n");

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secretBytes = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
  const signKey = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", signKey, enc.encode(dataCheckString));
  const computedHash = [...new Uint8Array(sigBytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (computedHash !== hash) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  try { return { user: JSON.parse(userRaw) }; } catch { return null; }
}

// ---------- Settings helpers ----------
async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const s = {};
  for (const row of results) s[row.key] = row.value;
  return s;
}
async function getSetting(db, key, fallback = null) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : fallback;
}
async function setSetting(db, key, value) {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, String(value)).run();
}
async function requireAdmin(request, env) {
  const supplied = request.headers.get("X-Admin-Password") || "";
  const expected = (await getSetting(env.DB, "admin_password")) || env.ADMIN_PASSWORD || "changeme123";
  return supplied && supplied === expected;
}

// ---------- User helpers ----------
async function getOrCreateUser(db, tgUser) {
  const telegram_id = String(tgUser.id);
  let user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();
  if (!user) {
    const token = genToken();
    await db.prepare(`INSERT INTO users (telegram_id, username, first_name, photo_url, api_token) VALUES (?, ?, ?, ?, ?)`)
      .bind(telegram_id, tgUser.username || null, tgUser.first_name || "User", tgUser.photo_url || null, token).run();
    user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();
  } else {
    if (!user.api_token) await db.prepare("UPDATE users SET api_token = ? WHERE id = ?").bind(genToken(), user.id).run();
    await db.prepare("UPDATE users SET username = ?, first_name = ?, photo_url = ? WHERE id = ?")
      .bind(tgUser.username || user.username, tgUser.first_name || user.first_name, tgUser.photo_url || user.photo_url, user.id).run();
    user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  }
  return user;
}

// ---------- Provider (smmgen.com) integration ----------
async function providerCall(db, action, params) {
  const apiUrl = await getSetting(db, "provider_api_url");
  const apiKey = await getSetting(db, "provider_api_key");
  if (!apiUrl || !apiKey) return { error: "Provider not configured" };
  try {
    const body = new URLSearchParams({ key: apiKey, action, ...params });
    const res = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const data = await res.json().catch(() => null);
    return data || { error: "Provider returned an unexpected response" };
  } catch (e) {
    return { error: `Provider request failed: ${e.message}` };
  }
}
async function placeProviderOrder(db, service, link, quantity) {
  const autoOrder = (await getSetting(db, "provider_auto_order")) === "1";
  if (!autoOrder || !service.provider_id) return null;
  const data = await providerCall(db, "add", { service: String(service.provider_id), link, quantity: String(quantity) });
  if (data && data.order) return { providerOrderId: String(data.order) };
  return { error: (data && data.error) || "Provider returned an unexpected response" };
}
function mapProviderStatus(providerStatus) {
  const s = (providerStatus || "").toLowerCase();
  if (s.includes("complet")) return "Completed";
  if (s.includes("partial")) return "Partial";
  if (s.includes("cancel")) return "Cancelled";
  if (s.includes("process") || s.includes("in progress")) return "Processing";
  return null;
}
async function refundOrder(db, order, note) {
  await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(order.charge, order.user_id).run();
  await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'admin_add', ?, ?)").bind(order.user_id, order.charge, note).run();
}

async function createOrder(db, user, servicePublicId, link, quantity, source) {
  const service = await db.prepare(
    "SELECT s.*, c.name AS category_name FROM services s JOIN categories c ON c.id = s.category_id WHERE s.public_id = ? AND s.status = 'active'"
  ).bind(servicePublicId).first();
  if (!service) return { error: "Service not found or inactive" };

  const qty = parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty < service.min_qty || qty > service.max_qty) {
    return { error: `Quantity must be between ${service.min_qty} and ${service.max_qty}` };
  }
  if (!/^https?:\/\//i.test(link || "")) return { error: "Please provide a valid link starting with http(s)://" };

  const charge = Math.round(((service.rate * qty) / 1000) * 1e8) / 1e8;
  if (charge <= 0) return { error: "Invalid charge calculated" };
  if (user.balance < charge) return { error: "Insufficient balance" };

  const beforeBalance = user.balance;
  await db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").bind(charge, user.id).run();
  const refillAvailable = service.refill_days > 0 ? 1 : 0;
  const insert = await db.prepare(
    `INSERT INTO orders (user_id, service_id, service_public_id, service_name, category_name, link, quantity, charge, status, source, refill_available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`
  ).bind(user.id, service.id, service.public_id, service.name, service.category_name, link, qty, charge, source, refillAvailable).run();
  const orderId = insert.meta.last_row_id;
  await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'order', ?, ?)")
    .bind(user.id, -charge, `Order #${orderId}: ${service.name}`).run();

  const providerResult = await placeProviderOrder(db, service, link, qty);
  if (providerResult && providerResult.providerOrderId) {
    await db.prepare("UPDATE orders SET status = 'Processing', provider_order_id = ? WHERE id = ?").bind(providerResult.providerOrderId, orderId).run();
  } else if (providerResult && providerResult.error) {
    await db.prepare("UPDATE orders SET provider_error = ? WHERE id = ?").bind(providerResult.error, orderId).run();
  }

  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  const updatedUser = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return { order, balance: updatedUser.balance, service, beforeBalance, afterBalance: updatedUser.balance, telegramId: user.telegram_id, username: updatedUser.username };
}

// ---------- Force-join verification ----------
async function checkChannelMembership(botToken, username, telegramId) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=@${encodeURIComponent(username)}&user_id=${telegramId}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return false;
    const status = data.result && data.result.status;
    return ["member", "administrator", "creator"].includes(status);
  } catch { return false; }
}

// ---------- Telegram bot helpers ----------
function inlineButton(buttonText, buttonUrl, asUrlButton) {
  if (!buttonText || !buttonUrl) return null;
  return asUrlButton ? { text: buttonText, url: buttonUrl } : { text: buttonText, web_app: { url: buttonUrl } };
}
async function tgSendMessage(botToken, chatId, text, buttonText, buttonUrl, asUrlButton) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  const btn = inlineButton(buttonText, buttonUrl, asUrlButton);
  if (btn) body.reply_markup = { inline_keyboard: [[btn]] };
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}
async function tgSendPhoto(botToken, chatId, photoUrl, caption, buttonText, buttonUrl, asUrlButton) {
  const body = { chat_id: chatId, photo: photoUrl, parse_mode: "HTML" };
  if (caption) body.caption = caption;
  const btn = inlineButton(buttonText, buttonUrl, asUrlButton);
  if (btn) body.reply_markup = { inline_keyboard: [[btn]] };
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}
async function sendToUser(botToken, chatId, text, imageUrl, buttonText, buttonUrl) {
  if (imageUrl) return tgSendPhoto(botToken, chatId, imageUrl, text, buttonText, buttonUrl, false);
  return tgSendMessage(botToken, chatId, text, buttonText, buttonUrl, false);
}

async function broadcastToAllUsers(db, botToken, appUrl, { text, imageUrl, buttonText, buttonUrl }) {
  const { results: users } = await db.prepare("SELECT telegram_id FROM users WHERE banned = 0").all();
  let sent = 0, failed = 0;
  const finalButtonUrl = buttonUrl || appUrl;
  for (const u of users) {
    try {
      const res = await sendToUser(botToken, u.telegram_id, text, imageUrl || null, buttonText || null, finalButtonUrl);
      if (res && res.ok) sent++; else failed++;
    } catch { failed++; }
  }
  await setSetting(db, "broadcast_last_result", JSON.stringify({ sent, failed, total: users.length, at: new Date().toISOString() }));
}

// ---------- Per-order channel log ----------
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function sendOrderLog(db, env, result) {
  const enabled = (await getSetting(db, "order_log_enabled")) === "1";
  if (!enabled) return;
  const channel = await getSetting(db, "order_log_channel");
  const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
  if (!channel || !botToken) return;

  const { order, service, beforeBalance, afterBalance, telegramId, username } = result;
  const providerName = service.provider_id ? ((await getSetting(db, "provider_display_name")) || "SMMGen") : "Manual";
  const now = new Date();

  const caption =
`<blockquote><b>🚀 TELEGROW • ORDER LOG</b></blockquote>

<b>👤 Customer</b>
├ <b>Username:</b> @${esc(username || "N/A")}
├ <b>User ID:</b> <code>${esc(telegramId)}</code>
└ <b>Balance:</b> <code>${afterBalance.toFixed(8)}</code> Coins

<b>📦 Order Details</b>
├ <b>Order ID:</b> <code>#${order.id}</code>
├ <b>Service:</b> ${esc(service.name)}
├ <b>Service ID:</b> <code>${service.public_id}</code>
├ <b>Quantity:</b> ${order.quantity}
├ <b>Charge:</b> <code>${order.charge.toFixed(8)}</code> Coins
├ <b>Provider:</b> ${esc(providerName)}
└ <b>Status:</b> ✅ <b>${esc(order.status)}</b>

<b>🎯 Target</b>
└ <code>${esc(order.link)}</code>

<b>📊 Progress</b>
├ <b>Start Count:</b> -
├ <b>Current:</b> -
├ <b>Remains:</b> -
└ <b>Refill:</b> ${service.refill_days > 0 ? service.refill_days + " Days" : "No Refill"}

<b>💳 Payment</b>
├ <b>Method:</b> Coins Wallet
├ <b>Before:</b> <code>${beforeBalance.toFixed(8)}</code>
└ <b>After:</b> <code>${afterBalance.toFixed(8)}</code>

<b>🕒 Timeline</b>
├ <b>Date:</b> ${now.toISOString().slice(0, 10)}
├ <b>Time:</b> ${now.toISOString().slice(11, 19)} UTC
└ <b>Completed:</b> -

━━━━━━━━━━━━━━━━━━━━━━
🤖 <b>Powered by TeleGrow</b>
⚡ Fast • Secure • Reliable
━━━━━━━━━━━━━━━━━━━━━━`;

  const imageUrl = await getSetting(db, "order_log_image_url");
  const buttonText = (await getSetting(db, "order_log_button_text")) || "🎯 Grab Your Chance";
  const botUsername = await getSetting(db, "bot_username");
  const appUrl = botUsername ? `https://t.me/${botUsername}?startapp=log` : (env.APP_URL || "");
  try {
    if (imageUrl && caption.length <= 1024) {
      await tgSendPhoto(botToken, channel, imageUrl, caption, buttonText, appUrl, true);
    } else if (imageUrl) {
      // Telegram photo captions are capped at 1024 chars — send the image first, then the full log as text.
      await tgSendPhoto(botToken, channel, imageUrl, null, null, null, true);
      await tgSendMessage(botToken, channel, caption, buttonText, appUrl, true);
    } else {
      await tgSendMessage(botToken, channel, caption, buttonText, appUrl, true);
    }
  } catch { /* best-effort — never block the order on a logging failure */ }
}

// ================= ROUTER =================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") return new Response(null, { headers: withCORS() });
    if (pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url, pathname, ctx); }
      catch (e) { return err(`Server error: ${e.message}`, 500); }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const db = env.DB;
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(syncProcessingOrders(db));
    } else if (event.cron === "0 * * * *") {
      ctx.waitUntil(maybeSendDailyBroadcast(db, env));
    }
  },
};

// ---------- Cron jobs ----------
async function syncProcessingOrders(db) {
  const { results: orders } = await db.prepare(
    "SELECT * FROM orders WHERE status IN ('Pending','Processing') AND provider_order_id IS NOT NULL LIMIT 100"
  ).all();
  if (orders.length) {
    const ids = orders.map((o) => o.provider_order_id).join(",");
    const data = await providerCall(db, "status", { orders: ids });
    if (data && !data.error) {
      for (const o of orders) {
        const entry = data[o.provider_order_id];
        if (!entry || entry.error) continue;
        const mapped = mapProviderStatus(entry.status);
        if (mapped && mapped !== o.status) {
          if (mapped === "Cancelled" && o.status !== "Cancelled") await refundOrder(db, o, `Refund for cancelled order #${o.id}`);
          await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(mapped, o.id).run();
        }
      }
    }
  }

  const { results: refills } = await db.prepare("SELECT * FROM orders WHERE refill_status = 'Pending' AND refill_id IS NOT NULL LIMIT 100").all();
  if (refills.length) {
    const ids = refills.map((o) => o.refill_id).join(",");
    const data = await providerCall(db, "refill_status", { refills: ids });
    if (data && !data.error) {
      for (const o of refills) {
        const entry = data[o.refill_id];
        if (!entry || entry.error) continue;
        const status = entry.status;
        if (status && status !== o.refill_status) {
          await db.prepare("UPDATE orders SET refill_status = ? WHERE id = ?").bind(status, o.id).run();
        }
      }
    }
  }
}

async function maybeSendDailyBroadcast(db, env) {
  const enabled = (await getSetting(db, "daily_broadcast_enabled")) === "1";
  if (!enabled) return;
  const hour = parseInt((await getSetting(db, "daily_broadcast_hour")) || "12", 10);
  const currentHour = new Date().getUTCHours();
  if (currentHour !== hour) return;
  const lastSent = await getSetting(db, "daily_broadcast_last_sent");
  if (lastSent === todayStr()) return;

  const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
  if (!botToken) return;
  const text = (await getSetting(db, "daily_broadcast_text")) || "Don't forget to watch today's ads!";
  const imageUrl = await getSetting(db, "daily_broadcast_image");
  const buttonText = (await getSetting(db, "daily_broadcast_button_text")) || "Open App";
  const appUrl = env.APP_URL || "";

  await broadcastToAllUsers(db, botToken, appUrl, { text, imageUrl, buttonText, buttonUrl: appUrl });
  await setSetting(db, "daily_broadcast_last_sent", todayStr());
}

async function handleApi(request, env, url, pathname, ctx) {
  const db = env.DB;
  const method = request.method;

  // ---------- PUBLIC ----------
  if (pathname === "/api/settings/public" && method === "GET") {
    const s = await getSettings(db);
    return json({
      ok: true,
      settings: {
        site_name: s.site_name, currency: s.currency, currency_symbol: s.currency_symbol,
        ads_earning_enabled: s.ads_earning_enabled === "1",
        ad_reward: s.ad_reward, daily_ad_limit: s.daily_ad_limit, cooldown_minutes: s.cooldown_minutes,
        adsgram_enabled: s.adsgram_enabled === "1", adsgram_block_id: s.adsgram_block_id,
        monetag_enabled: s.monetag_enabled === "1", monetag_zone_id: s.monetag_zone_id,
        bot_username: s.bot_username, channel_link: s.channel_link, support_link: s.support_link,
        force_join_enabled: s.force_join_enabled === "1",
      },
    });
  }

  if (pathname === "/api/auth" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
    let tgUser = null;
    if (botToken && body.initData) {
      const result = await validateInitData(body.initData, botToken);
      if (!result) return err("Invalid Telegram authentication data", 401);
      tgUser = result.user;
    } else if (body.debugUser) {
      tgUser = body.debugUser;
    } else {
      return err("Missing initData — make sure Bot Token is set in Admin → Settings", 400);
    }
    const user = await getOrCreateUser(db, tgUser);
    if (user.banned) return err("Your account has been suspended. Contact support.", 403);
    return json({ ok: true, user });
  }

  if (pathname === "/api/user" && method === "GET") {
    const tid = url.searchParams.get("telegram_id");
    if (!tid) return err("telegram_id required");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(tid).first();
    if (!user) return err("User not found", 404);
    return json({ ok: true, user });
  }

  if (pathname === "/api/user/stats" && method === "GET") {
    const tid = url.searchParams.get("telegram_id");
    if (!tid) return err("telegram_id required");
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(tid).first();
    if (!user) return json({ ok: true, stats: { total_orders: 0, total_spent: 0, total_earned: 0 } });
    const orders = await db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(charge),0) AS s FROM orders WHERE user_id = ? AND status != 'Cancelled'").bind(user.id).first();
    const earned = await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type IN ('ad_reward','admin_add')").bind(user.id).first();
    return json({ ok: true, stats: { total_orders: orders.c, total_spent: orders.s, total_earned: earned.s } });
  }

  if (pathname === "/api/user/regenerate-token" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.telegram_id) return err("telegram_id required");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(body.telegram_id).first();
    if (!user) return err("User not found", 404);
    const token = genToken();
    await db.prepare("UPDATE users SET api_token = ? WHERE id = ?").bind(token, user.id).run();
    return json({ ok: true, api_token: token });
  }

  if (pathname === "/api/user/mark-onboarded" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.telegram_id) return err("telegram_id required");
    await db.prepare("UPDATE users SET onboarded = 1 WHERE telegram_id = ?").bind(body.telegram_id).run();
    return json({ ok: true });
  }

  if (pathname === "/api/categories" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM categories WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, categories: results });
  }

  if (pathname === "/api/services" && method === "GET") {
    const categoryId = url.searchParams.get("category_id");
    const stmt = categoryId
      ? db.prepare("SELECT * FROM services WHERE status = 'active' AND category_id = ? ORDER BY sort_order ASC, id ASC").bind(categoryId)
      : db.prepare("SELECT * FROM services WHERE status = 'active' ORDER BY sort_order ASC, id ASC");
    const { results } = await stmt.all();
    return json({ ok: true, services: results });
  }

  if (pathname === "/api/order" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { telegram_id, link, quantity } = body;
    const servicePublicId = body.service || body.service_id;
    if (!telegram_id || !servicePublicId || !link || !quantity) return err("Missing required fields");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();
    if (!user) return err("User not found", 404);
    if (user.banned) return err("Account suspended", 403);
    const result = await createOrder(db, user, servicePublicId, link, quantity, "app");
    if (result.error) return err(result.error, result.error === "Insufficient balance" ? 402 : 400);
    ctx.waitUntil(sendOrderLog(db, env, result));
    return json({ ok: true, order: result.order, balance: result.balance });
  }

  if (pathname === "/api/order/refill" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.telegram_id || !body.order_id) return err("telegram_id and order_id required");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(body.telegram_id).first();
    if (!user) return err("User not found", 404);
    const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(body.order_id, user.id).first();
    if (!order) return err("Order not found", 404);
    if (!order.refill_available) return err("Refill is not available for this order");
    if (order.status !== "Completed") return err("Refill can only be requested after the order is Completed");
    if (order.refill_status === "Pending") return err("A refill request is already pending for this order");
    if (!order.provider_order_id) return err("This order has no provider reference to refill");

    const data = await providerCall(db, "refill", { order: order.provider_order_id });
    if (!data || data.error) return err((data && data.error) || "Refill request failed");
    const refillId = String(data.refill);
    await db.prepare("UPDATE orders SET refill_id = ?, refill_status = 'Pending' WHERE id = ?").bind(refillId, order.id).run();
    return json({ ok: true, refill_id: refillId });
  }

  if (pathname === "/api/orders" && method === "GET") {
    const tid = url.searchParams.get("telegram_id");
    if (!tid) return err("telegram_id required");
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(tid).first();
    if (!user) return json({ ok: true, orders: [] });
    const { results } = await db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(user.id).all();
    return json({ ok: true, orders: results });
  }

  if (pathname === "/api/transactions" && method === "GET") {
    const tid = url.searchParams.get("telegram_id");
    if (!tid) return err("telegram_id required");
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(tid).first();
    if (!user) return json({ ok: true, transactions: [] });
    const { results } = await db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(user.id).all();
    return json({ ok: true, transactions: results });
  }

  if (pathname === "/api/ad-reward" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { telegram_id } = body;
    if (!telegram_id) return err("telegram_id required");
    const adsEnabled = (await getSetting(db, "ads_earning_enabled")) === "1";
    if (!adsEnabled) return err("Ad earning is currently paused by the admin. Please contact support to add funds.", 403);
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();
    if (!user) return err("User not found", 404);
    if (user.banned) return err("Account suspended", 403);
    const dailyLimit = parseInt((await getSetting(db, "daily_ad_limit")) || "15", 10);
    const reward = parseFloat((await getSetting(db, "ad_reward")) || "0.5");
    const { count } = await db.prepare(`SELECT COUNT(*) AS count FROM ad_logs WHERE user_id = ? AND date(watched_at) = date('now')`).bind(user.id).first();
    if (count >= dailyLimit) return err(`Daily ad limit (${dailyLimit}) reached. Come back tomorrow.`, 429);
    await db.prepare("INSERT INTO ad_logs (user_id) VALUES (?)").bind(user.id).run();
    await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(reward, user.id).run();
    await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'ad_reward', ?, 'Ad watched')").bind(user.id, reward).run();
    const updated = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    return json({ ok: true, balance: updated.balance, watched_today: count + 1, daily_limit: dailyLimit, reward });
  }

  // ---------- Promo codes ----------
  if (pathname === "/api/promo/redeem" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.telegram_id || !body.code) return err("telegram_id and code required");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(body.telegram_id).first();
    if (!user) return err("User not found", 404);
    if (user.banned) return err("Account suspended", 403);

    const promo = await db.prepare("SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE AND status = 'active'").bind(body.code.trim()).first();
    if (!promo) return err("Invalid or expired promo code", 404);
    if (promo.claimed_count >= promo.max_claims) return err("This promo code has reached its claim limit", 410);

    const already = await db.prepare("SELECT id FROM promo_claims WHERE promo_id = ? AND user_id = ?").bind(promo.id, user.id).first();
    if (already) return err("You've already claimed this promo code", 409);

    await db.prepare("INSERT INTO promo_claims (promo_id, user_id) VALUES (?, ?)").bind(promo.id, user.id).run();
    await db.prepare("UPDATE promo_codes SET claimed_count = claimed_count + 1 WHERE id = ?").bind(promo.id).run();
    await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(promo.reward, user.id).run();
    await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'promo', ?, ?)")
      .bind(user.id, promo.reward, `Promo code ${promo.code}`).run();

    const updated = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    return json({ ok: true, reward: promo.reward, balance: updated.balance });
  }

  // ---------- Force join ----------
  if (pathname === "/api/force-join" && method === "GET") {
    const enabled = (await getSetting(db, "force_join_enabled")) === "1";
    if (!enabled) return json({ ok: true, enabled: false, channels: [] });
    const { results } = await db.prepare("SELECT id, title, username, invite_link, icon FROM force_join_channels WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, enabled: true, channels: results });
  }

  if (pathname === "/api/verify-join" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.telegram_id) return err("telegram_id required");
    const enabled = (await getSetting(db, "force_join_enabled")) === "1";
    if (!enabled) return json({ ok: true, joined: true, missing: [] });

    const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
    const { results: channels } = await db.prepare("SELECT * FROM force_join_channels WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all();
    if (!channels.length) return json({ ok: true, joined: true, missing: [] });
    if (!botToken) return json({ ok: true, joined: true, missing: [] }); // can't verify without a bot token — don't block users

    const missing = [];
    for (const ch of channels) {
      const isMember = await checkChannelMembership(botToken, ch.username, body.telegram_id);
      if (!isMember) missing.push({ id: ch.id, title: ch.title, username: ch.username });
    }
    return json({ ok: true, joined: missing.length === 0, missing });
  }

  // ---------- Reseller / child API ----------
  if (pathname === "/api/v2" && method === "POST") return handleResellerApi(db, env, request, ctx);

  // ---------- Telegram webhook ----------
  if (pathname === "/api/telegram/webhook" && method === "POST") {
    const secret = await getSetting(db, "bot_webhook_secret");
    if (secret && url.searchParams.get("secret") !== secret) return err("Unauthorized", 401);
    return handleTelegramWebhook(db, env, request);
  }

  // ---------- Admin ----------
  if (pathname === "/api/admin/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const expected = (await getSetting(db, "admin_password")) || env.ADMIN_PASSWORD || "changeme123";
    if (body.password === expected) return json({ ok: true });
    return err("Incorrect password", 401);
  }
  if (pathname.startsWith("/api/admin/")) {
    const isAdmin = await requireAdmin(request, env);
    if (!isAdmin) return err("Unauthorized", 401);
    return handleAdmin(db, env, method, pathname, request, url, ctx);
  }

  return err("Not found", 404);
}

// ---------- Telegram webhook handler ----------
async function handleTelegramWebhook(db, env, request) {
  const update = await request.json().catch(() => ({}));
  const message = update.message;
  if (!message) return json({ ok: true });

  const chatId = message.chat.id;
  const text = message.text || "";
  const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
  if (!botToken) return json({ ok: true });

  if (text.startsWith("/start")) {
    const startText = (await getSetting(db, "start_text")) || "Welcome!";
    const startImage = await getSetting(db, "start_image_url");
    const buttonText = (await getSetting(db, "start_button_text")) || "Open App";
    const appUrl = env.APP_URL || `https://${new URL(request.url).host}`;
    await sendToUser(botToken, chatId, startText, startImage, buttonText, appUrl);
  }
  return json({ ok: true });
}

// ---------- Reseller API ----------
async function handleResellerApi(db, env, request, ctx) {
  const contentType = request.headers.get("content-type") || "";
  let params = {};
  try {
    if (contentType.includes("application/json")) params = await request.json();
    else params = Object.fromEntries((await request.formData()).entries());
  } catch { return json({ error: "Invalid request body" }); }

  const { key, action } = params;
  if (!key) return json({ error: "Invalid API key" });
  const user = await db.prepare("SELECT * FROM users WHERE api_token = ?").bind(key).first();
  if (!user) return json({ error: "Invalid API key" });
  if (user.banned) return json({ error: "Account suspended" });

  if (action === "services") {
    const { results } = await db.prepare(
      `SELECT s.public_id AS service, s.name, c.name AS category, s.rate, s.min_qty AS min, s.max_qty AS max, s.refill_days
       FROM services s JOIN categories c ON c.id = s.category_id WHERE s.status = 'active' ORDER BY s.public_id ASC`
    ).all();
    return json(results.map((r) => ({
      service: r.service, name: r.name, type: "Default", category: r.category,
      rate: String(r.rate), min: String(r.min), max: String(r.max),
      refill: r.refill_days > 0, cancel: true,
    })));
  }

  if (action === "balance") {
    const currency = (await getSetting(db, "currency")) || "USDT";
    return json({ balance: user.balance.toFixed(8), currency });
  }

  if (action === "add") {
    const result = await createOrder(db, user, params.service, params.link, params.quantity, "api");
    if (result.error) return json({ error: result.error });
    ctx.waitUntil(sendOrderLog(db, env, result));
    return json({ order: result.order.id });
  }

  if (action === "status") {
    const currency = (await getSetting(db, "currency")) || "USDT";
    const buildEntry = async (order) => {
      let remains = 0, startCount = 0, status = order.status;
      if (order.provider_order_id) {
        const data = await providerCall(db, "status", { order: order.provider_order_id });
        if (data && !data.error) { remains = data.remains ?? 0; startCount = data.start_count ?? 0; }
      }
      return { charge: order.charge.toFixed(4), start_count: String(startCount), status, remains: String(remains), currency };
    };
    if (params.orders) {
      const ids = parseIdList(params.orders);
      const out = {};
      for (const id of ids) {
        const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(id, user.id).first();
        out[id] = order ? await buildEntry(order) : { error: "Incorrect order ID" };
      }
      return json(out);
    }
    if (!params.order) return json({ error: "order id required" });
    const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(params.order, user.id).first();
    if (!order) return json({ error: "Order not found" });
    return json(await buildEntry(order));
  }

  if (action === "refill") {
    const doRefill = async (orderId) => {
      const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(orderId, user.id).first();
      if (!order) return { error: "Incorrect order ID" };
      if (!order.refill_available) return { error: "Refill not available for this order" };
      if (order.status !== "Completed") return { error: "Order is not completed yet" };
      if (order.refill_status === "Pending") return { error: "Refill already pending" };
      if (!order.provider_order_id) return { error: "No provider reference to refill" };
      const data = await providerCall(db, "refill", { order: order.provider_order_id });
      if (!data || data.error) return { error: (data && data.error) || "Refill request failed" };
      const refillId = String(data.refill);
      await db.prepare("UPDATE orders SET refill_id = ?, refill_status = 'Pending' WHERE id = ?").bind(refillId, order.id).run();
      return refillId;
    };
    if (params.orders) {
      const ids = parseIdList(params.orders);
      const out = {};
      for (const id of ids) {
        const result = await doRefill(id);
        out[id] = { order: Number(id), refill: typeof result === "string" ? Number(result) || result : result };
      }
      return json(out);
    }
    if (!params.order) return json({ error: "order id required" });
    const result = await doRefill(params.order);
    if (typeof result !== "string") return json(result);
    return json({ refill: result });
  }

  if (action === "refill_status") {
    const buildStatus = async (refillId) => {
      const order = await db.prepare("SELECT * FROM orders WHERE refill_id = ? AND user_id = ?").bind(refillId, user.id).first();
      if (!order) return { error: "Refill not found" };
      return { status: order.refill_status || "Pending" };
    };
    if (params.refills) {
      const ids = parseIdList(params.refills);
      const out = {};
      for (const id of ids) {
        const r = await buildStatus(id);
        out[id] = { refill: Number(id) || id, status: r.status || r.error };
      }
      return json(out);
    }
    if (!params.refill) return json({ error: "refill id required" });
    return json(await buildStatus(params.refill));
  }

  if (action === "cancel") {
    const doCancel = async (orderId) => {
      const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(orderId, user.id).first();
      if (!order) return { error: "Incorrect order ID" };
      if (order.status === "Cancelled" || order.status === "Completed") return { error: `Order already ${order.status}` };
      if (order.provider_order_id) await providerCall(db, "cancel", { orders: order.provider_order_id });
      await refundOrder(db, order, `Refund for cancelled order #${order.id}`);
      await db.prepare("UPDATE orders SET status = 'Cancelled' WHERE id = ?").bind(order.id).run();
      return 1;
    };
    const ids = parseIdList(params.orders || params.order);
    if (!ids.length) return json({ error: "order id(s) required" });
    const out = {};
    for (const id of ids) out[id] = { order: Number(id), cancel: await doCancel(id) };
    return json(out);
  }

  return json({ error: "Incorrect action" });
}

async function handleAdmin(db, env, method, pathname, request, url, ctx) {
  // ---- stats ----
  if (pathname === "/api/admin/stats" && method === "GET") {
    const users = await db.prepare("SELECT COUNT(*) AS c FROM users").first();
    const orders = await db.prepare("SELECT COUNT(*) AS c FROM orders").first();
    const pending = await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status IN ('Pending','Processing')").first();
    const revenue = await db.prepare("SELECT COALESCE(SUM(charge),0) AS s FROM orders WHERE status != 'Cancelled'").first();
    const balances = await db.prepare("SELECT COALESCE(SUM(balance),0) AS s FROM users").first();
    return json({ ok: true, stats: { total_users: users.c, total_orders: orders.c, pending_orders: pending.c, total_revenue: revenue.s, total_user_balance: balances.s } });
  }

  // ---- categories ----
  if (pathname === "/api/admin/categories" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM categories ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, categories: results });
  }
  if (pathname === "/api/admin/categories" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name) return err("name required");
    const res = await db.prepare("INSERT INTO categories (name, icon, sort_order, status) VALUES (?, ?, ?, ?)")
      .bind(b.name, b.icon || "fa-solid fa-layer-group", b.sort_order || 0, b.status || "active").run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  let m = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare("UPDATE categories SET name = ?, icon = ?, sort_order = ?, status = ? WHERE id = ?")
      .bind(b.name, b.icon, b.sort_order ?? 0, b.status || "active", m[1]).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    await db.prepare("DELETE FROM services WHERE category_id = ?").bind(m[1]).run();
    await db.prepare("DELETE FROM categories WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- services ----
  if (pathname === "/api/admin/services" && method === "GET") {
    const { results } = await db.prepare(`SELECT s.*, c.name AS category_name FROM services s JOIN categories c ON c.id = s.category_id ORDER BY s.sort_order ASC, s.id ASC`).all();
    return json({ ok: true, services: results });
  }
  if (pathname === "/api/admin/services" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name || !b.category_id || !b.rate) return err("name, category_id, rate required");
    let publicId;
    if (b.public_id) {
      publicId = parseInt(b.public_id, 10);
      if (!Number.isFinite(publicId)) return err("Public ID must be a number");
      const exists = await db.prepare("SELECT id FROM services WHERE public_id = ?").bind(publicId).first();
      if (exists) return err(`Public ID ${publicId} is already used by another service`);
    } else {
      publicId = await genPublicId(db);
    }
    const res = await db.prepare(
      `INSERT INTO services (public_id, category_id, name, rate, min_qty, max_qty, description, avg_time, link_type, start_type, speed_info, refill_days, provider_id, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      publicId, b.category_id, b.name, b.rate, b.min_qty || 100, b.max_qty || 10000, b.description || null,
      b.avg_time || null, b.link_type || null, b.start_type || null, b.speed_info || null, b.refill_days || 0,
      b.provider_id || null, b.status || "active", b.sort_order || 0
    ).run();
    return json({ ok: true, id: res.meta.last_row_id, public_id: publicId });
  }
  m = pathname.match(/^\/api\/admin\/services\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    if (b.public_id) {
      const publicId = parseInt(b.public_id, 10);
      if (!Number.isFinite(publicId)) return err("Public ID must be a number");
      const exists = await db.prepare("SELECT id FROM services WHERE public_id = ? AND id != ?").bind(publicId, m[1]).first();
      if (exists) return err(`Public ID ${publicId} is already used by another service`);
      await db.prepare("UPDATE services SET public_id = ? WHERE id = ?").bind(publicId, m[1]).run();
    }
    await db.prepare(
      `UPDATE services SET category_id=?, name=?, rate=?, min_qty=?, max_qty=?, description=?, avg_time=?, link_type=?, start_type=?, speed_info=?, refill_days=?, provider_id=?, status=?, sort_order=? WHERE id=?`
    ).bind(
      b.category_id, b.name, b.rate, b.min_qty, b.max_qty, b.description || null,
      b.avg_time || null, b.link_type || null, b.start_type || null, b.speed_info || null, b.refill_days || 0,
      b.provider_id || null, b.status || "active", b.sort_order ?? 0, m[1]
    ).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") { await db.prepare("DELETE FROM services WHERE id = ?").bind(m[1]).run(); return json({ ok: true }); }

  // ---- orders ----
  if (pathname === "/api/admin/orders" && method === "GET") {
    const status = url.searchParams.get("status");
    const stmt = status
      ? db.prepare(`SELECT o.*, u.telegram_id, u.username, u.first_name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = ? ORDER BY o.created_at DESC LIMIT 300`).bind(status)
      : db.prepare(`SELECT o.*, u.telegram_id, u.username, u.first_name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 300`);
    const { results } = await stmt.all();
    return json({ ok: true, orders: results });
  }
  m = pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const allowed = ["Pending", "Processing", "Completed", "Partial", "Cancelled"];
    if (!allowed.includes(b.status)) return err("Invalid status");
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(m[1]).first();
    if (!order) return err("Order not found", 404);
    if (b.status === "Cancelled" && order.status !== "Cancelled") await refundOrder(db, order, `Refund for cancelled order #${order.id}`);
    await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(b.status, m[1]).run();
    return json({ ok: true });
  }
  m = pathname.match(/^\/api\/admin\/orders\/(\d+)\/sync$/);
  if (m && method === "POST") {
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(m[1]).first();
    if (!order) return err("Order not found", 404);
    if (!order.provider_order_id) return err("This order has no provider order id to sync");
    const data = await providerCall(db, "status", { order: order.provider_order_id });
    if (!data || data.error) return err((data && data.error) || "Provider sync failed");
    const mapped = mapProviderStatus(data.status);
    if (mapped && mapped !== order.status) {
      if (mapped === "Cancelled" && order.status !== "Cancelled") await refundOrder(db, order, `Refund for cancelled order #${order.id}`);
      await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(mapped, m[1]).run();
    }
    return json({ ok: true, provider: data, status: mapped || order.status });
  }

  // ---- users ----
  if (pathname === "/api/admin/users" && method === "GET") {
    const q = url.searchParams.get("q");
    const stmt = q
      ? db.prepare("SELECT * FROM users WHERE telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ? ORDER BY created_at DESC LIMIT 300").bind(`%${q}%`, `%${q}%`, `%${q}%`)
      : db.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT 300");
    const { results } = await stmt.all();
    return json({ ok: true, users: results });
  }
  m = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(m[1]).first();
    if (!user) return err("User not found", 404);
    if (typeof b.balance_adjust === "number" && b.balance_adjust !== 0) {
      await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(b.balance_adjust, m[1]).run();
      await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)")
        .bind(m[1], b.balance_adjust > 0 ? "admin_add" : "admin_deduct", b.balance_adjust, b.note || "Manual adjustment by admin").run();
    }
    if (typeof b.banned === "number" || typeof b.banned === "boolean") {
      await db.prepare("UPDATE users SET banned = ? WHERE id = ?").bind(b.banned ? 1 : 0, m[1]).run();
    }
    const updated = await db.prepare("SELECT * FROM users WHERE id = ?").bind(m[1]).first();
    return json({ ok: true, user: updated });
  }
  m = pathname.match(/^\/api\/admin\/users\/(\d+)\/detail$/);
  if (m && method === "GET") {
    const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(m[1]).first();
    if (!user) return err("User not found", 404);
    const orderStats = await db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(charge),0) AS s FROM orders WHERE user_id = ? AND status != 'Cancelled'").bind(m[1]).first();
    const earned = await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type IN ('ad_reward','admin_add')").bind(m[1]).first();
    const { results: recentOrders } = await db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 15").bind(m[1]).all();
    const { results: recentTxns } = await db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 15").bind(m[1]).all();
    return json({ ok: true, user, stats: { total_orders: orderStats.c, total_spent: orderStats.s, total_earned: earned.s }, recentOrders, recentTxns });
  }

  // ---- force-join channels ----
  if (pathname === "/api/admin/force-join" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM force_join_channels ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, channels: results });
  }
  if (pathname === "/api/admin/force-join" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.title || !b.username) return err("title and username required");
    const res = await db.prepare("INSERT INTO force_join_channels (title, username, invite_link, icon, sort_order, status) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(b.title, b.username.replace(/^@/, ""), b.invite_link || null, b.icon || "fa-brands fa-telegram", b.sort_order || 0, b.status || "active").run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  m = pathname.match(/^\/api\/admin\/force-join\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare("UPDATE force_join_channels SET title=?, username=?, invite_link=?, icon=?, sort_order=?, status=? WHERE id=?")
      .bind(b.title, (b.username || "").replace(/^@/, ""), b.invite_link || null, b.icon || "fa-brands fa-telegram", b.sort_order ?? 0, b.status || "active", m[1]).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") { await db.prepare("DELETE FROM force_join_channels WHERE id = ?").bind(m[1]).run(); return json({ ok: true }); }

  // ---- promo codes ----
  if (pathname === "/api/admin/promo" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM promo_codes ORDER BY created_at DESC").all();
    return json({ ok: true, codes: results });
  }
  if (pathname === "/api/admin/promo" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.code || !b.reward) return err("code and reward required");
    try {
      const res = await db.prepare("INSERT INTO promo_codes (code, reward, max_claims, status) VALUES (?, ?, ?, ?)")
        .bind(b.code.trim().toUpperCase(), b.reward, b.max_claims || 100, b.status || "active").run();
      return json({ ok: true, id: res.meta.last_row_id });
    } catch (e) { return err("That code already exists"); }
  }
  m = pathname.match(/^\/api\/admin\/promo\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare("UPDATE promo_codes SET code=?, reward=?, max_claims=?, status=? WHERE id=?")
      .bind(b.code.trim().toUpperCase(), b.reward, b.max_claims || 100, b.status || "active", m[1]).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") { await db.prepare("DELETE FROM promo_codes WHERE id = ?").bind(m[1]).run(); return json({ ok: true }); }

  // ---- settings ----
  if (pathname === "/api/admin/settings" && method === "GET") return json({ ok: true, settings: await getSettings(db) });
  if (pathname === "/api/admin/settings" && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const stmts = Object.entries(b).map(([k, v]) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v)));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  // ---- Telegram bot: set webhook ----
  if (pathname === "/api/admin/telegram/set-webhook" && method === "POST") {
    const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
    if (!botToken) return err("Set your Bot Token first");
    let secret = await getSetting(db, "bot_webhook_secret");
    if (!secret) { secret = randomSecret(); await setSetting(db, "bot_webhook_secret", secret); }
    const host = new URL(request.url).host;
    const webhookUrl = `https://${host}/api/telegram/webhook?secret=${secret}`;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) return err((data && data.description) || "Failed to set webhook");
    return json({ ok: true, webhook_url: webhookUrl, telegram_response: data });
  }

  // ---- Broadcast ----
  if (pathname === "/api/admin/broadcast" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.text) return err("Message text is required");
    const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
    if (!botToken) return err("Set your Bot Token first");
    const appUrl = env.APP_URL || `https://${new URL(request.url).host}`;
    ctx.waitUntil(broadcastToAllUsers(db, botToken, appUrl, {
      text: b.text, imageUrl: b.image_url || null, buttonText: b.button_text || null, buttonUrl: b.button_url || null,
    }));
    return json({ ok: true, message: "Broadcast started — check back for results shortly." });
  }
  if (pathname === "/api/admin/broadcast/last-result" && method === "GET") {
    const raw = await getSetting(db, "broadcast_last_result");
    return json({ ok: true, result: raw ? JSON.parse(raw) : null });
  }

  return err("Not found", 404);
}
