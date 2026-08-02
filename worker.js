/**
 * TeleGrow — SMM Panel Mini App backend
 * Cloudflare Worker + D1
 *
 * Routes:
 *   GET    /api/settings/public
 *   POST   /api/auth                       { initData }            -> validates Telegram WebApp initData, upserts user
 *   GET    /api/categories
 *   GET    /api/services?category_id=
 *   POST   /api/order                      { telegram_id, service_id, link, quantity }
 *   GET    /api/orders?telegram_id=
 *   POST   /api/ad-reward                  { telegram_id }
 *   GET    /api/user?telegram_id=
 *
 *   POST   /api/admin/login                { password }
 *   GET    /api/admin/stats
 *   GET    /api/admin/categories
 *   POST   /api/admin/categories           { name, icon, sort_order }
 *   PUT    /api/admin/categories/:id
 *   DELETE /api/admin/categories/:id
 *   GET    /api/admin/services
 *   POST   /api/admin/services
 *   PUT    /api/admin/services/:id
 *   DELETE /api/admin/services/:id
 *   GET    /api/admin/orders
 *   PUT    /api/admin/orders/:id           { status }
 *   GET    /api/admin/users
 *   PUT    /api/admin/users/:id            { balance_adjust, note } | { banned }
 *   GET    /api/admin/settings
 *   PUT    /api/admin/settings             { key: value, ... }
 *
 * All admin routes require header:  X-Admin-Password: <password>
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

// ---------- Telegram WebApp initData validation ----------
async function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [];
  for (const [k, v] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    pairs.push(`${k}=${v}`);
  }
  const dataCheckString = pairs.join("\n");

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretBytes = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
  const signKey = await crypto.subtle.importKey(
    "raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", signKey, enc.encode(dataCheckString));
  const computedHash = [...new Uint8Array(sigBytes)].map(b => b.toString(16).padStart(2, "0")).join("");

  if (computedHash !== hash) return null;

  const userRaw = params.get("user");
  const startParam = params.get("start_param") || null;
  if (!userRaw) return null;
  try {
    const user = JSON.parse(userRaw);
    return { user, startParam };
  } catch {
    return null;
  }
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

// ---------- Admin auth ----------
async function requireAdmin(request, env) {
  const supplied = request.headers.get("X-Admin-Password") || "";
  const expected = (await getSetting(env.DB, "admin_password")) || env.ADMIN_PASSWORD || "changeme123";
  return supplied && supplied === expected;
}

// ---------- User helpers ----------
async function getOrCreateUser(db, tgUser, referredBy) {
  const telegram_id = String(tgUser.id);
  let user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();
  if (!user) {
    await db.prepare(
      `INSERT INTO users (telegram_id, username, first_name, photo_url, referred_by) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      telegram_id,
      tgUser.username || null,
      tgUser.first_name || "User",
      tgUser.photo_url || null,
      referredBy && String(referredBy) !== telegram_id ? String(referredBy) : null
    ).run();
    user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();

    // Pay referral bonus once, to the referrer
    if (user.referred_by) {
      const referrer = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(user.referred_by).first();
      if (referrer) {
        const reward = parseFloat((await getSetting(db, "referral_reward")) || "0") || 0;
        if (reward > 0) {
          await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(reward, referrer.id).run();
          await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'referral', ?, ?)")
            .bind(referrer.id, reward, `Referral bonus for inviting ${user.first_name}`).run();
        }
      }
    }
  } else {
    await db.prepare("UPDATE users SET username = ?, first_name = ?, photo_url = ? WHERE id = ?")
      .bind(tgUser.username || user.username, tgUser.first_name || user.first_name, tgUser.photo_url || user.photo_url, user.id)
      .run();
    user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  }
  return user;
}

// ================= ROUTER =================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: withCORS() });
    }

    if (pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url, pathname);
      } catch (e) {
        return err(`Server error: ${e.message}`, 500);
      }
    }

    // Fall through to static assets (index.html, admin/index.html, /assets/*)
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
        site_name: s.site_name,
        currency: s.currency,
        currency_symbol: s.currency_symbol,
        ad_reward: s.ad_reward,
        daily_ad_limit: s.daily_ad_limit,
        cooldown_minutes: s.cooldown_minutes,
        monetag_zone_id: s.monetag_zone_id,
        bot_username: s.bot_username,
        channel_link: s.channel_link,
        support_link: s.support_link,
        referral_reward: s.referral_reward,
      },
    });
  }

  if (pathname === "/api/auth" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const botToken = (await getSetting(db, "bot_token")) || env.BOT_TOKEN;
    let tgUser = null, startParam = null;

    if (botToken && body.initData) {
      const result = await validateInitData(body.initData, botToken);
      if (!result) return err("Invalid Telegram authentication data", 401);
      tgUser = result.user;
      startParam = result.startParam;
    } else if (body.debugUser) {
      // Dev fallback when running outside Telegram / no bot token configured yet
      tgUser = body.debugUser;
      startParam = body.startParam || null;
    } else {
      return err("Missing initData", 400);
    }

    const user = await getOrCreateUser(db, tgUser, startParam);
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

  if (pathname === "/api/categories" && method === "GET") {
    const { results } = await db.prepare(
      "SELECT * FROM categories WHERE status = 'active' ORDER BY sort_order ASC, id ASC"
    ).all();
    return json({ ok: true, categories: results });
  }

  if (pathname === "/api/services" && method === "GET") {
    const categoryId = url.searchParams.get("category_id");
    let stmt;
    if (categoryId) {
      stmt = db.prepare(
        "SELECT * FROM services WHERE status = 'active' AND category_id = ? ORDER BY sort_order ASC, id ASC"
      ).bind(categoryId);
    } else {
      stmt = db.prepare("SELECT * FROM services WHERE status = 'active' ORDER BY sort_order ASC, id ASC");
    }
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

    const service = await db.prepare(
      "SELECT s.*, c.name AS category_name FROM services s JOIN categories c ON c.id = s.category_id WHERE s.id = ? AND s.status = 'active'"
    ).bind(service_id).first();
    if (!service) return err("Service not found or inactive", 404);

    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < service.min_qty || qty > service.max_qty) {
      return err(`Quantity must be between ${service.min_qty} and ${service.max_qty}`);
    }
    if (!/^https?:\/\//i.test(link)) return err("Please enter a valid link starting with http(s)://");

    const charge = Math.round(((service.rate * qty) / 1000) * 100) / 100;
    if (charge <= 0) return err("Invalid charge calculated");
    if (user.balance < charge) return err("Insufficient balance. Please add funds first.", 402);

    await db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").bind(charge, user.id).run();
    const insert = await db.prepare(
      `INSERT INTO orders (user_id, service_id, service_name, category_name, link, quantity, charge, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`
    ).bind(user.id, service.id, service.name, service.category_name, link, qty, charge).run();
    await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'order', ?, ?)")
      .bind(user.id, -charge, `Order #${insert.meta.last_row_id}: ${service.name}`).run();

    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(insert.meta.last_row_id).first();
    const updatedUser = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    return json({ ok: true, order, balance: updatedUser.balance });
  }

  if (pathname === "/api/orders" && method === "GET") {
    const tid = url.searchParams.get("telegram_id");
    if (!tid) return err("telegram_id required");
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(tid).first();
    if (!user) return json({ ok: true, orders: [] });
    const { results } = await db.prepare(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
    ).bind(user.id).all();
    return json({ ok: true, orders: results });
  }

  if (pathname === "/api/ad-reward" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const { telegram_id } = body;
    if (!telegram_id) return err("telegram_id required");
    const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegram_id).first();
    if (!user) return err("User not found", 404);
    if (user.banned) return err("Account suspended", 403);

    const dailyLimit = parseInt((await getSetting(db, "daily_ad_limit")) || "15", 10);
    const reward = parseFloat((await getSetting(db, "ad_reward")) || "0.5");

    const { count } = await db.prepare(
      `SELECT COUNT(*) AS count FROM ad_logs WHERE user_id = ? AND date(watched_at) = date('now')`
    ).bind(user.id).first();

    if (count >= dailyLimit) {
      return err(`Daily ad limit (${dailyLimit}) reached. Come back tomorrow.`, 429);
    }

    await db.prepare("INSERT INTO ad_logs (user_id) VALUES (?)").bind(user.id).run();
    await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(reward, user.id).run();
    await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'ad_reward', ?, 'Ad watched')")
      .bind(user.id, reward).run();

    const updated = await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    return json({
      ok: true,
      balance: updated.balance,
      watched_today: count + 1,
      daily_limit: dailyLimit,
      reward,
    });
  }

  // ---------- ADMIN ----------
  if (pathname === "/api/admin/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const expected = (await getSetting(db, "admin_password")) || env.ADMIN_PASSWORD || "changeme123";
    if (body.password === expected) return json({ ok: true });
    return err("Incorrect password", 401);
  }

  if (pathname.startsWith("/api/admin/")) {
    const isAdmin = await requireAdmin(request, env);
    if (!isAdmin) return err("Unauthorized", 401);
    return handleAdmin(db, method, pathname, request, url);
  }

  return err("Not found", 404);
}

async function handleAdmin(db, method, pathname, request, url) {
  // ---- stats ----
  if (pathname === "/api/admin/stats" && method === "GET") {
    const users = await db.prepare("SELECT COUNT(*) AS c FROM users").first();
    const orders = await db.prepare("SELECT COUNT(*) AS c FROM orders").first();
    const pending = await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'Pending'").first();
    const revenue = await db.prepare("SELECT COALESCE(SUM(charge),0) AS s FROM orders WHERE status != 'Cancelled'").first();
    const balances = await db.prepare("SELECT COALESCE(SUM(balance),0) AS s FROM users").first();
    return json({
      ok: true,
      stats: {
        total_users: users.c,
        total_orders: orders.c,
        pending_orders: pending.c,
        total_revenue: revenue.s,
        total_user_balance: balances.s,
      },
    });
  }

  // ---- categories ----
  if (pathname === "/api/admin/categories" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM categories ORDER BY sort_order ASC, id ASC").all();
    return json({ ok: true, categories: results });
  }
  if (pathname === "/api/admin/categories" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name) return err("name required");
    const res = await db.prepare(
      "INSERT INTO categories (name, icon, sort_order, status) VALUES (?, ?, ?, ?)"
    ).bind(b.name, b.icon || "fa-solid fa-layer-group", b.sort_order || 0, b.status || "active").run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  let m = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare(
      "UPDATE categories SET name = ?, icon = ?, sort_order = ?, status = ? WHERE id = ?"
    ).bind(b.name, b.icon, b.sort_order ?? 0, b.status || "active", m[1]).run();
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
      `SELECT s.*, c.name AS category_name FROM services s
       JOIN categories c ON c.id = s.category_id
       ORDER BY s.sort_order ASC, s.id ASC`
    ).all();
    return json({ ok: true, services: results });
  }
  if (pathname === "/api/admin/services" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name || !b.category_id || !b.rate) return err("name, category_id, rate required");
    const res = await db.prepare(
      `INSERT INTO services (category_id, name, rate, min_qty, max_qty, description, provider_id, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      b.category_id, b.name, b.rate, b.min_qty || 100, b.max_qty || 10000,
      b.description || null, b.provider_id || null, b.status || "active", b.sort_order || 0
    ).run();
    return json({ ok: true, id: res.meta.last_row_id });
  }
  m = pathname.match(/^\/api\/admin\/services\/(\d+)$/);
  if (m && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    await db.prepare(
      `UPDATE services SET category_id=?, name=?, rate=?, min_qty=?, max_qty=?, description=?, provider_id=?, status=?, sort_order=?
       WHERE id=?`
    ).bind(
      b.category_id, b.name, b.rate, b.min_qty, b.max_qty,
      b.description || null, b.provider_id || null, b.status || "active", b.sort_order ?? 0, m[1]
    ).run();
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    await db.prepare("DELETE FROM services WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- orders ----
  if (pathname === "/api/admin/orders" && method === "GET") {
    const status = url.searchParams.get("status");
    let stmt;
    if (status) {
      stmt = db.prepare(
        `SELECT o.*, u.telegram_id, u.username, u.first_name FROM orders o
         JOIN users u ON u.id = o.user_id WHERE o.status = ? ORDER BY o.created_at DESC LIMIT 300`
      ).bind(status);
    } else {
      stmt = db.prepare(
        `SELECT o.*, u.telegram_id, u.username, u.first_name FROM orders o
         JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 300`
      );
    }
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

    // Refund balance if cancelling an order that wasn't already cancelled
    if (b.status === "Cancelled" && order.status !== "Cancelled") {
      await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(order.charge, order.user_id).run();
      await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, 'admin_add', ?, ?)")
        .bind(order.user_id, order.charge, `Refund for cancelled order #${order.id}`).run();
    }

    await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(b.status, m[1]).run();
    return json({ ok: true });
  }

  // ---- users ----
  if (pathname === "/api/admin/users" && method === "GET") {
    const q = url.searchParams.get("q");
    let stmt;
    if (q) {
      stmt = db.prepare(
        "SELECT * FROM users WHERE telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ? ORDER BY created_at DESC LIMIT 300"
      ).bind(`%${q}%`, `%${q}%`, `%${q}%`);
    } else {
      stmt = db.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT 300");
    }
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
      await db.prepare("INSERT INTO transactions (user_id, type, amount, note) VALUES (?, ?, ?, ?)").bind(
        m[1],
        b.balance_adjust > 0 ? "admin_add" : "admin_deduct",
        b.balance_adjust,
        b.note || "Manual adjustment by admin"
      ).run();
    }
    if (typeof b.banned === "number" || typeof b.banned === "boolean") {
      await db.prepare("UPDATE users SET banned = ? WHERE id = ?").bind(b.banned ? 1 : 0, m[1]).run();
    }
    const updated = await db.prepare("SELECT * FROM users WHERE id = ?").bind(m[1]).first();
    return json({ ok: true, user: updated });
  }

  // ---- settings ----
  if (pathname === "/api/admin/settings" && method === "GET") {
    const settings = await getSettings(db);
    return json({ ok: true, settings });
  }
  if (pathname === "/api/admin/settings" && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const stmts = Object.entries(b).map(([k, v]) =>
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(k, String(v))
    );
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }

  return err("Not found", 404);
}
