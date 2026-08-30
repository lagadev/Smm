/**
 * SMM Panel — Mini App backend (v8)
 * Cloudflare Worker + D1 + Cron Triggers
 *
 * Structure: Platform -> Category -> Service
 *
 * Mini App routes:
 *   GET  /api/settings/public
 *   POST /api/auth                        { initData }
 *   GET  /api/user?telegram_id=
 *   GET  /api/user/stats?telegram_id=
 *   POST /api/user/regenerate-token       { telegram_id }
 *   POST /api/user/mark-onboarded         { telegram_id }
 *   GET  /api/platforms
 *   GET  /api/categories?platform_id=
 *   GET  /api/services?category_id=
 *   POST /api/order                       { telegram_id, service, link, quantity }
 *   POST /api/order/refill                { telegram_id, order_id }
 *   GET  /api/orders?telegram_id=
 *   GET  /api/transactions?telegram_id=
 *   GET  /api/deposit/methods
 *   POST /api/deposit/request             { telegram_id, method_id, amount }
 *   GET  /api/deposit/requests?telegram_id=
 *
 * Reseller / child API (see in-app Docs):
 *   POST /api/v2   { key, action: services|add|status|refill|refill_status|cancel|balance, ... }
 *
 * Admin routes — require header X-Admin-Password:
 *   POST /api/admin/login
 *   GET  /api/admin/stats
 *   GET/POST/PUT/DELETE /api/admin/platforms(/:id)
 *   GET/POST/PUT/DELETE /api/admin/categories(/:id)
 *   GET/POST/PUT/DELETE /api/admin/services(/:id)   (supports cost_rate + markup_percent)
 *   POST /api/admin/services/reapply-markup         { markup_percent? }
 *   GET/PUT /api/admin/orders(/:id)   POST /api/admin/orders/:id/sync
 *   GET/PUT /api/admin/users(/:id)    GET /api/admin/users/:id/detail
 *   GET/POST/PUT/DELETE /api/admin/payment-methods(/:id)
 *   GET /api/admin/deposits            PUT /api/admin/deposits/:id   { status, admin_note? }
 *   GET/PUT /api/admin/settings
 *
 * Cron (wrangler.jsonc triggers.crons): "* * * * *" — syncs Processing orders
 * and pending refills from the provider every minute.
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
function genRefCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) s += chars[b % chars.length];
  return `DEP-${s}`;
}
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

// ---------- Provider integration ----------
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
    `SELECT s.*, c.name AS category_name, p.name AS platform_name
     FROM services s
     JOIN categories c ON c.id = s.category_id
     JOIN platforms p ON p.id = c.platform_id
     WHERE s.public_id = ? AND s.status = 'active'`
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

  await db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").bind(charge, user.id).run();
  const refillAvailable = service.refill_days > 0 ? 1 : 0;
  const insert = await db.prepare(
    `INSERT INTO orders (user_id, service_id, service_public_id, service_name, category_name, platform_name, link, quantity, charge, status, source, refill_available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`
  ).bind(user.id, service.id, service.public_id, service.name, service.category_name, service.platform_name, link, qty, charge, source, refillAvailable).run();
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
    ctx.waitUntil(syncProcessingOrders(env.DB));
  },
};

// ---------- Cron job: fastest-possible order sync ----------
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
        const startCount = entry.start_count != null ? parseInt(entry.start_count, 10) : null;
        const remains = entry.remains != null ? parseInt(entry.remains, 10) : null;
        await db.prepare("UPDATE orders SET start_count = COALESCE(?, start_count), remains = COALESCE(?, remains) WHERE id = ?")
          .bind(startCount, remains, o.id).run();
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
        if (entry.status && entry.status !== o.refill_status) {
          await db.prepare("UPDATE orders SET refill_status = ? WHERE id = ?").bind(entry.status, o.id).run();
        }
      }
    }
  }
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
        support_link: s.support_link, channel_link: s.channel_link,
        deposit_quick_amounts: (s.deposit_quick_amounts || "").split(",").map((n) => Number(n.trim())).filter((n) => n > 0),
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
    const earned = await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type IN ('admin_add','deposit')").bind(user.id).first();
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

  if (pathname === "/api/platforms" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM platforms WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, platforms: results });
  }

  if (pathname === "/api/categories" && method === "GET") {
    const platformId = url.searchParams.get("platform_id");
    const stmt = platformId
      ? db.prepare("SELECT * FROM categories WHERE status = 'active' AND platform_id = ? ORDER BY sort_order ASC, id ASC").bind(platformId)
      : db.prepare("SELECT * FROM categories WHERE status = 'active' ORDER BY sort_order ASC, id ASC");
    const { results } = await stmt.all();
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

  // ---------- Deposits (Add Funds) ----------
  if (pathname === "/api/deposit/methods" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM payment_methods WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, methods: results });
  }

  if (pathname === "/api/deposit/request" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body.telegram_id || !body.method_id || !body.amount) return err("telegram_id, method_id and amount required");
    const amount = parseFloat(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return err("Enter a valid amount");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(body.telegram_id).first();
    if (!user) return err("User not found", 404);
    if (user.banned) return err("Account suspended", 403);
    const method = await db.prepare("SELECT * FROM payment_methods WHERE id = ? AND status = 'active'").bind(body.method_id).first();
    if (!method) return err("Payment method not found", 404);

    let refCode, tries = 0;
    do { refCode = genRefCode(); tries++; } while (tries < 5 && await db.prepare("SELECT id FROM deposit_requests WHERE reference_code = ?").bind(refCode).first());

    const insert = await db.prepare(
      "INSERT INTO deposit_requests (user_id, method_id, method_name, amount, reference_code, status) VALUES (?, ?, ?, ?, ?, 'Pending')"
    ).bind(user.id, method.id, method.name, amount, refCode).run();

    const request_row = await db.prepare("SELECT * FROM deposit_requests WHERE id = ?").bind(insert.meta.last_row_id).first();
    return json({ ok: true, request: request_row, method });
  }

  if (pathname === "/api/deposit/requests" && method === "GET") {
    const tid = url.searchParams.get("telegram_id");
    if (!tid) return err("telegram_id required");
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(tid).first();
    if (!user) return json({ ok: true, requests: [] });
    const { results } = await db.prepare("SELECT * FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(user.id).all();
    return json({ ok: true, requests: results });
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
      `SELECT s.public_id AS service, s.name, c.name AS category, p.name AS platform, s.rate, s.min_qty AS min, s.max_qty AS max, s.refill_days
       FROM services s JOIN categories c ON c.id = s.category_id JOIN platforms p ON p.id = c.platform_id
       WHERE s.status = 'active' ORDER BY s.public_id ASC`
    ).all();
    return json(results.map((r) => ({
      service: r.service, name: r.name, type: "Default", category: r.category, platform: r.platform,
      rate: String(r.rate), min: String(r.min), max: String(r.max),
      refill: r.refill_days > 0, cancel: true,
    })));
  }

  if (action === "balance") {
    const currency = (await getSetting(db, "currency")) || "BDT";
    return json({ balance: user.balance.toFixed(2), currency });
  }

  if (action === "add") {
    const result = await createOrder(db, user, params.service, params.link, params.quantity, "api");
    if (result.error) return json({ error: result.error });
    return json({ order: result.order.id });
  }

  if (action === "status") {
    const currency = (await getSetting(db, "currency")) || "BDT";
    const buildEntry = async (order) => {
      let remains = order.remains ?? 0, startCount = order.start_count ?? 0, status = order.status;
      if (order.provider_order_id && remains === 0 && startCount === 0) {
        const data = await providerCall(db, "status", { order: order.provider_order_id });
        if (data && !data.error) { remains = data.remains ?? 0; startCount = data.start_count ?? 0; }
      }
      return { charge: order.charge.toFixed(2), start_count: String(startCount), status, remains: String(remains), currency };
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

async function handleAdmin(db, env, method, pathname, request, url) {
  // ---- stats ----
  if (pathname === "/api/admin/stats" && method === "GET") {
    const users = await db.prepare("SELECT COUNT(*) AS c FROM users").first();
    const orders = await db.prepare("SELECT COUNT(*) AS c FROM orders").first();
    const pending = await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status IN ('Pending','Processing')").first();
    const revenue = await db.prepare("SELECT COALESCE(SUM(charge),0) AS s FROM orders WHERE status != 'Cancelled'").first();
    const balances = await db.prepare("SELECT COALESCE(SUM(balance),0) AS s FROM users").first();
    const pendingDeposits = await db.prepare("SELECT COUNT(*) AS c FROM deposit_requests WHERE status = 'Pending'").first();
    return json({ ok: true, stats: { total_users: users.c, total_orders: orders.c, pending_orders: pending.c, total_revenue: revenue.s, total_user_balance: balances.s, pending_deposits: pendingDeposits.c } });
  }

  // ---- platforms ----
  if (pathname === "/api/admin/platforms" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM platforms ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, platforms: results });
  }
  if (pathname === "/api/admin/platforms" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name) return err("name required");
    const res = await db.prepare("INSERT INTO platforms (name, icon, sort_order, status) VALUES (?, ?, ?, ?)")
      .bind(b.name, b.icon || "fa-solid fa-star", b.sort_order || 0, b.status || "active").run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  let m = pathname.match(/^\/api\/admin\/platforms\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare("UPDATE platforms SET name = ?, icon = ?, sort_order = ?, status = ? WHERE id = ?")
      .bind(b.name, b.icon, b.sort_order ?? 0, b.status || "active", m[1]).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    const cats = await db.prepare("SELECT id FROM categories WHERE platform_id = ?").bind(m[1]).all();
    for (const c of cats.results) await db.prepare("DELETE FROM services WHERE category_id = ?").bind(c.id).run();
    await db.prepare("DELETE FROM categories WHERE platform_id = ?").bind(m[1]).run();
    await db.prepare("DELETE FROM platforms WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- categories ----
  if (pathname === "/api/admin/categories" && method === "GET") {
    const { results } = await db.prepare(
      "SELECT c.*, p.name AS platform_name FROM categories c JOIN platforms p ON p.id = c.platform_id ORDER BY c.sort_order ASC, c.id ASC"
    ).all();
    return json({ ok: true, categories: results });
  }
  if (pathname === "/api/admin/categories" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name || !b.platform_id) return err("name and platform_id required");
    const res = await db.prepare("INSERT INTO categories (platform_id, name, icon, tag, sort_order, status) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(b.platform_id, b.name, b.icon || null, b.tag || null, b.sort_order || 0, b.status || "active").run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  m = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare("UPDATE categories SET platform_id = ?, name = ?, icon = ?, tag = ?, sort_order = ?, status = ? WHERE id = ?")
      .bind(b.platform_id, b.name, b.icon || null, b.tag || null, b.sort_order ?? 0, b.status || "active", m[1]).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    await db.prepare("DELETE FROM services WHERE category_id = ?").bind(m[1]).run();
    await db.prepare("DELETE FROM categories WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- services ----
  if (pathname === "/api/admin/services" && method === "GET") {
    const { results } = await db.prepare(
      `SELECT s.*, c.name AS category_name, p.name AS platform_name
       FROM services s JOIN categories c ON c.id = s.category_id JOIN platforms p ON p.id = c.platform_id
       ORDER BY s.sort_order ASC, s.id ASC`
    ).all();
    return json({ ok: true, services: results });
  }
  if (pathname === "/api/admin/services" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name || !b.category_id) return err("name and category_id required");
    const costRate = b.cost_rate != null && b.cost_rate !== "" ? parseFloat(b.cost_rate) : null;
    const markup = b.markup_percent != null && b.markup_percent !== "" ? parseFloat(b.markup_percent) : null;
    const rate = costRate != null && markup != null ? Math.round(costRate * (1 + markup / 100) * 1e8) / 1e8 : parseFloat(b.rate);
    if (!Number.isFinite(rate) || rate <= 0) return err("A valid rate (or cost_rate + markup_percent) is required");
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
      `INSERT INTO services (public_id, category_id, name, cost_rate, markup_percent, rate, min_qty, max_qty, description, avg_time, link_type, start_type, speed_info, refill_days, provider_id, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      publicId, b.category_id, b.name, costRate, markup, rate, b.min_qty || 100, b.max_qty || 10000, b.description || null,
      b.avg_time || null, b.link_type || null, b.start_type || null, b.speed_info || null, b.refill_days || 0,
      b.provider_id || null, b.status || "active", b.sort_order || 0
    ).run();
    return json({ ok: true, id: res.meta.last_row_id, public_id: publicId, rate });
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
    const costRate = b.cost_rate != null && b.cost_rate !== "" ? parseFloat(b.cost_rate) : null;
    const markup = b.markup_percent != null && b.markup_percent !== "" ? parseFloat(b.markup_percent) : null;
    const rate = costRate != null && markup != null ? Math.round(costRate * (1 + markup / 100) * 1e8) / 1e8 : parseFloat(b.rate);
    if (!Number.isFinite(rate) || rate <= 0) return err("A valid rate (or cost_rate + markup_percent) is required");
    await db.prepare(
      `UPDATE services SET category_id=?, name=?, cost_rate=?, markup_percent=?, rate=?, min_qty=?, max_qty=?, description=?, avg_time=?, link_type=?, start_type=?, speed_info=?, refill_days=?, provider_id=?, status=?, sort_order=? WHERE id=?`
    ).bind(
      b.category_id, b.name, costRate, markup, rate, b.min_qty, b.max_qty, b.description || null,
      b.avg_time || null, b.link_type || null, b.start_type || null, b.speed_info || null, b.refill_days || 0,
      b.provider_id || null, b.status || "active", b.sort_order ?? 0, m[1]
    ).run();
    return json({ ok: true, rate });
  }
  if (m && method === "DELETE") { await db.prepare("DELETE FROM services WHERE id = ?").bind(m[1]).run(); return json({ ok: true }); }

  if (pathname === "/api/admin/services/reapply-markup" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const globalMarkup = b.markup_percent != null ? parseFloat(b.markup_percent) : null;
    const { results: services } = await db.prepare("SELECT id, cost_rate, markup_percent FROM services WHERE cost_rate IS NOT NULL").all();
    let updated = 0;
    const stmts = [];
    for (const s of services) {
      const markup = globalMarkup != null ? globalMarkup : s.markup_percent;
      if (markup == null) continue;
      const rate = Math.round(s.cost_rate * (1 + markup / 100) * 1e8) / 1e8;
      stmts.push(db.prepare("UPDATE services SET rate = ?, markup_percent = ? WHERE id = ?").bind(rate, markup, s.id));
      updated++;
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true, updated });
  }

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
    const startCount = data.start_count != null ? parseInt(data.start_count, 10) : null;
    const remains = data.remains != null ? parseInt(data.remains, 10) : null;
    await db.prepare("UPDATE orders SET start_count = COALESCE(?, start_count), remains = COALESCE(?, remains) WHERE id = ?")
      .bind(startCount, remains, m[1]).run();
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
    const earned = await db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type IN ('admin_add','deposit')").bind(m[1]).first();
    const { results: recentOrders } = await db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 15").bind(m[1]).all();
    const { results: recentTxns } = await db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 15").bind(m[1]).all();
    return json({ ok: true, user, stats: { total_orders: orderStats.c, total_spent: orderStats.s, total_earned: earned.s }, recentOrders, recentTxns });
  }

  // ---- payment methods ----
  if (pathname === "/api/admin/payment-methods" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM payment_methods ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, methods: results });
  }
  if (pathname === "/api/admin/payment-methods" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name) return err("name required");
    const res = await db.prepare("INSERT INTO payment_methods (name, icon, account_info, instructions, sort_order, status) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(b.name, b.icon || "fa-solid fa-wallet", b.account_info || null, b.instructions || null, b.sort_order || 0, b.status || "active").run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  m = pathname.match(/^\/api\/admin\/payment-methods\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare("UPDATE payment_methods SET name=?, icon=?, account_info=?, instructions=?, sort_order=?, status=? WHERE id=?")
      .bind(b.name, b.icon || "fa-solid fa-wallet", b.account_info || null, b.instructions || null, b.sort_order ?? 0, b.status || "active", m[1]).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") { await db.prepare("DELETE FROM payment_methods WHERE id = ?").bind(m[1]).run(); return json({ ok: true }); }

  // ---- deposits ----
  if (pathname === "/api/admin/deposits" && method === "GET") {
    const status = url.searchParams.get("status");
    const stmt = status
      ? db.prepare("SELECT d.*, u.telegram_id, u.username, u.first_name FROM deposit_requests d JOIN users u ON u.id = d.user_id WHERE d.status = ? ORDER BY d.created_at DESC LIMIT 300").bind(status)
      : db.prepare("SELECT d.*, u.telegram_id, u.username, u.first_name FROM deposit_requests d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC LIMIT 300");
    const { results } = await stmt.all();
    return json({ ok: true, deposits: results });
  }
  m = pathname.match(/^\/api\/admin\/deposits\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const allowed = ["Pending", "Approved", "Rejected"];
    if (!allowed.includes(b.status)) return err("Invalid status");
    const dep = await db.prepare("SELECT * FROM deposit_requests WHERE id = ?").bind(m[1]).first();
    if (!dep) return err("Deposit request not found", 404);
    if (dep.status !== "Pending") return err(`This request was already ${dep.status.toLowerCase()}`);
    if (b.status === "Approved") {
      await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(dep.amount, dep.user_id).run();
      await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'deposit', ?, ?)")
        .bind(dep.user_id, dep.amount, `Deposit ${dep.reference_code} via ${dep.method_name}`).run();
    }
    await db.prepare("UPDATE deposit_requests SET status = ?, admin_note = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(b.status, b.admin_note || null, m[1]).run();
    return json({ ok: true });
  }

  // ---- settings ----
  if (pathname === "/api/admin/settings" && method === "GET") return json({ ok: true, settings: await getSettings(db) });
  if (pathname === "/api/admin/settings" && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const stmts = Object.entries(b).map(([k, v]) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v)));
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  return err("Not found", 404);
}
