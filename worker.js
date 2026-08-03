/**
 * TeleGrow — SMM Panel Mini App backend (v3)
 * Cloudflare Worker + D1
 *
 * Mini App routes:
 *   GET  /api/settings/public
 *   POST /api/auth                        { initData }
 *   GET  /api/user?telegram_id=
 *   GET  /api/user/stats?telegram_id=
 *   POST /api/user/regenerate-token       { telegram_id }
 *   GET  /api/categories
 *   GET  /api/services?category_id=
 *   POST /api/order                       { telegram_id, service_id, link, quantity }
 *   GET  /api/orders?telegram_id=
 *   GET  /api/transactions?telegram_id=
 *   POST /api/ad-reward                   { telegram_id }
 *   GET  /api/force-join
 *   POST /api/verify-join                 { telegram_id }
 *
 * Reseller / child API (standard SMM-panel style — see /docs.html):
 *   POST /api/v2   { key, action: 'services' | 'add' | 'status' | 'balance', ... }
 *
 * Admin routes — require header X-Admin-Password:
 *   POST /api/admin/login
 *   GET  /api/admin/stats
 *   GET/POST/PUT/DELETE /api/admin/categories(/:id)
 *   GET/POST/PUT/DELETE /api/admin/services(/:id)
 *   GET/PUT /api/admin/orders(/:id)   POST /api/admin/orders/:id/sync
 *   GET/PUT /api/admin/users(/:id)    GET /api/admin/users/:id/detail
 *   GET/POST/PUT/DELETE /api/admin/force-join(/:id)
 *   GET/PUT /api/admin/settings
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
async function placeProviderOrder(db, service, link, quantity) {
  const autoOrder = (await getSetting(db, "provider_auto_order")) === "1";
  const apiUrl = await getSetting(db, "provider_api_url");
  const apiKey = await getSetting(db, "provider_api_key");
  if (!autoOrder || !apiUrl || !apiKey || !service.provider_id) return null;
  try {
    const body = new URLSearchParams({ key: apiKey, action: "add", service: String(service.provider_id), link, quantity: String(quantity) });
    const res = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const data = await res.json().catch(() => null);
    if (data && data.order) return { providerOrderId: String(data.order) };
    return { error: (data && data.error) || "Provider returned an unexpected response" };
  } catch (e) {
    return { error: `Provider request failed: ${e.message}` };
  }
}
async function fetchProviderStatus(db, providerOrderId) {
  const apiUrl = await getSetting(db, "provider_api_url");
  const apiKey = await getSetting(db, "provider_api_key");
  if (!apiUrl || !apiKey || !providerOrderId) return null;
  try {
    const body = new URLSearchParams({ key: apiKey, action: "status", order: providerOrderId });
    const res = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return await res.json().catch(() => null);
  } catch { return null; }
}
function mapProviderStatus(providerStatus) {
  const s = (providerStatus || "").toLowerCase();
  if (s.includes("complet")) return "Completed";
  if (s.includes("partial")) return "Partial";
  if (s.includes("cancel")) return "Cancelled";
  if (s.includes("process") || s.includes("in progress")) return "Processing";
  return null;
}

async function createOrder(db, user, serviceId, link, quantity, source) {
  const service = await db.prepare(
    "SELECT s.*, c.name AS category_name FROM services s JOIN categories c ON c.id = s.category_id WHERE s.id = ? AND s.status = 'active'"
  ).bind(serviceId).first();
  if (!service) return { error: "Service not found or inactive" };

  const qty = parseInt(quantity, 10);
  if (!Number.isFinite(qty) || qty < service.min_qty || qty > service.max_qty) {
    return { error: `Quantity must be between ${service.min_qty} and ${service.max_qty}` };
  }
  if (!/^https?:\/\//i.test(link || "")) return { error: "Please provide a valid link starting with http(s)://" };

  const charge = Math.round(((service.rate * qty) / 1000) * 100) / 100;
  if (charge <= 0) return { error: "Invalid charge calculated" };
  if (user.balance < charge) return { error: "Insufficient balance" };

  await db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").bind(charge, user.id).run();
  const insert = await db.prepare(
    `INSERT INTO orders (user_id, service_id, service_name, category_name, link, quantity, charge, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`
  ).bind(user.id, service.id, service.name, service.category_name, link, qty, charge, source).run();
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
  return { order, balance: updatedUser.balance };
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

// ================= ROUTER =================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") return new Response(null, { headers: withCORS() });
    if (pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url, pathname); }
      catch (e) { return err(`Server error: ${e.message}`, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url, pathname) {
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
        monetag_zone_id: s.monetag_zone_id,
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
    const { telegram_id, service_id, link, quantity } = body;
    if (!telegram_id || !service_id || !link || !quantity) return err("Missing required fields");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();
    if (!user) return err("User not found", 404);
    if (user.banned) return err("Account suspended", 403);
    const result = await createOrder(db, user, service_id, link, quantity, "app");
    if (result.error) return err(result.error, result.error === "Insufficient balance" ? 402 : 400);
    return json({ ok: true, order: result.order, balance: result.balance });
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
  if (pathname === "/api/v2" && method === "POST") return handleResellerApi(db, request);

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
    return handleAdmin(db, env, method, pathname, request, url);
  }

  return err("Not found", 404);
}

// ---------- Reseller API ----------
async function handleResellerApi(db, request) {
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
      `SELECT s.id AS service, s.name, c.name AS category, s.rate, s.min_qty AS min, s.max_qty AS max
       FROM services s JOIN categories c ON c.id = s.category_id WHERE s.status = 'active' ORDER BY s.id ASC`
    ).all();
    return json(results);
  }
  if (action === "balance") {
    const currency = (await getSetting(db, "currency")) || "BDT";
    return json({ balance: String(user.balance.toFixed(2)), currency });
  }
  if (action === "add") {
    const result = await createOrder(db, user, params.service, params.link, params.quantity, "api");
    if (result.error) return json({ error: result.error });
    return json({ order: result.order.id });
  }
  if (action === "status") {
    if (!params.order) return json({ error: "order id required" });
    const order = await db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(params.order, user.id).first();
    if (!order) return json({ error: "Order not found" });
    let remains = 0, startCount = 0;
    if (order.provider_order_id) {
      const providerData = await fetchProviderStatus(db, order.provider_order_id);
      if (providerData && !providerData.error) { remains = providerData.remains ?? 0; startCount = providerData.start_count ?? 0; }
    }
    return json({ charge: order.charge.toFixed(4), start_count: String(startCount), status: order.status, remains: String(remains), currency: (await getSetting(db, "currency")) || "BDT" });
  }
  return json({ error: "Incorrect action" });
}

async function handleAdmin(db, env, method, pathname, request, url) {
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
    const res = await db.prepare(
      `INSERT INTO services (category_id, name, rate, min_qty, max_qty, description, provider_id, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(b.category_id, b.name, b.rate, b.min_qty || 100, b.max_qty || 10000, b.description || null, b.provider_id || null, b.status || "active", b.sort_order || 0).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  m = pathname.match(/^\/api\/admin\/services\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare(`UPDATE services SET category_id=?, name=?, rate=?, min_qty=?, max_qty=?, description=?, provider_id=?, status=?, sort_order=? WHERE id=?`)
      .bind(b.category_id, b.name, b.rate, b.min_qty, b.max_qty, b.description || null, b.provider_id || null, b.status || "active", b.sort_order ?? 0, m[1]).run();
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
    if (b.status === "Cancelled" && order.status !== "Cancelled") {
      await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(order.charge, order.user_id).run();
      await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'admin_add', ?, ?)")
        .bind(order.user_id, order.charge, `Refund for cancelled order #${order.id}`).run();
    }
    await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(b.status, m[1]).run();
    return json({ ok: true });
  }
  m = pathname.match(/^\/api\/admin\/orders\/(\d+)\/sync$/);
  if (m && method === "POST") {
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(m[1]).first();
    if (!order) return err("Order not found", 404);
    if (!order.provider_order_id) return err("This order has no provider order id to sync");
    const data = await fetchProviderStatus(db, order.provider_order_id);
    if (!data || data.error) return err((data && data.error) || "Provider sync failed");
    const mapped = mapProviderStatus(data.status);
    if (mapped && mapped !== order.status) {
      if (mapped === "Cancelled" && order.status !== "Cancelled") {
        await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(order.charge, order.user_id).run();
        await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'admin_add', ?, ?)")
          .bind(order.user_id, order.charge, `Refund for cancelled order #${order.id}`).run();
      }
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

  // ---- settings ----
  if (pathname === "/api/admin/settings" && method === "GET") return json({ ok: true, settings: await getSettings(db) });
  if (pathname === "/api/admin/settings" && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const stmts = Object.entries(b).map(([k, v]) =>
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v))
    );
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  return err("Not found", 404);
}
