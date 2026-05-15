import os
import time
import uuid
import sqlite3
import hmac
import hashlib
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder=None)

DB_PATH    = os.environ.get("DB_PATH", "data.db")
ADMIN_PASS = os.environ.get("ADMIN_PASSWORD", "admin123")
BOT_TOKEN  = os.environ.get("BOT_TOKEN", "")

# ───────────────────────── DB helpers ─────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id               INTEGER PRIMARY KEY,
            first_name       TEXT    DEFAULT '',
            last_name        TEXT    DEFAULT '',
            username         TEXT    DEFAULT '',
            photo_url        TEXT    DEFAULT '',
            balance          REAL    DEFAULT 0,
            earning_wallet   REAL    DEFAULT 0,
            referrals        INTEGER DEFAULT 0,
            referred_by      INTEGER,
            total_earned     REAL    DEFAULT 0,
            lifetime_ad_count INTEGER DEFAULT 0,
            daily_ad_count   INTEGER DEFAULT 0,
            last_ad_date     TEXT    DEFAULT '1970-01-01',
            break_until      INTEGER DEFAULT 0,
            welcomed         INTEGER DEFAULT 0,
            created_at       INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS completed_tasks (
            user_id INTEGER,
            task_id TEXT,
            PRIMARY KEY (user_id, task_id)
        );
        CREATE TABLE IF NOT EXISTS daily_earnings (
            user_id INTEGER,
            date    TEXT,
            amount  REAL DEFAULT 0,
            PRIMARY KEY (user_id, date)
        );
        CREATE TABLE IF NOT EXISTS withdrawals (
            id         TEXT    PRIMARY KEY,
            user_id    INTEGER,
            user_name  TEXT,
            method     TEXT,
            account    TEXT,
            amount     REAL,
            status     TEXT DEFAULT 'pending',
            created_at INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id         TEXT PRIMARY KEY,
            name       TEXT,
            url        TEXT,
            reward     REAL,
            icon       TEXT,
            created_at INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS links (
            id         TEXT PRIMARY KEY,
            name       TEXT,
            url        TEXT,
            icon       TEXT,
            created_at INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS withdraw_methods (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT,
            min_amount REAL
        );
        CREATE TABLE IF NOT EXISTS broadcasts (
            id         TEXT PRIMARY KEY,
            message    TEXT,
            status     TEXT DEFAULT 'pending',
            created_at INTEGER DEFAULT 0
        );
    """)
    defaults = {
        "botUsername": "",
        "botToken": BOT_TOKEN,
        "adZoneId": "",
        "welcomeMessage": "Добро пожаловать! 🎉",
        "adValue": "0.5",
        "referralBonus": "10",
        "dailyAdLimit": "20",
        "adsPerBreak": "5",
        "breakDuration": "10",
        "minimumWithdrawReferrals": "0",
    }
    for k, v in defaults.items():
        conn.execute("INSERT OR IGNORE INTO config (key,value) VALUES (?,?)", (k, v))
    conn.commit()
    conn.close()


def cfg():
    conn = get_db()
    rows = conn.execute("SELECT key,value FROM config").fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}


# ───────────────────────── Auth helpers ───────────────────────

def admin_ok():
    pw = request.headers.get("X-Admin-Password", "")
    if not pw and request.is_json:
        pw = (request.json or {}).get("password", "")
    return pw == ADMIN_PASS


def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not admin_ok():
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper


def validate_tg(init_data: str, token: str) -> bool:
    if not token or not init_data:
        return True          # skip validation if token not configured
    try:
        from urllib.parse import unquote
        parts = {}
        for seg in init_data.split("&"):
            if "=" in seg:
                k, v = seg.split("=", 1)
                parts[k] = unquote(v)
        got_hash = parts.pop("hash", None)
        if not got_hash:
            return False
        check_str = "\n".join(f"{k}={v}" for k, v in sorted(parts.items()))
        secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
        calc   = hmac.new(secret, check_str.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(calc, got_hash)
    except Exception:
        return False


# ───────────────────────── Static files ───────────────────────

@app.route("/")
def serve_index():
    return send_from_directory("public", "index.html")


@app.route("/admin")
@app.route("/admin/")
def serve_admin():
    return send_from_directory("admin", "admin.html")


# ════════════════════════ USER API ════════════════════════════

@app.route("/api/config")
def api_config():
    c = cfg()
    conn = get_db()
    tasks   = {r["id"]: {"name": r["name"], "url": r["url"],
               "reward": r["reward"], "icon": r["icon"]}
               for r in conn.execute("SELECT * FROM tasks ORDER BY created_at DESC")}
    links   = {r["id"]: {"name": r["name"], "url": r["url"], "icon": r["icon"]}
               for r in conn.execute("SELECT * FROM links ORDER BY created_at DESC")}
    methods = [{"name": r["name"], "min": r["min_amount"]}
               for r in conn.execute("SELECT name,min_amount FROM withdraw_methods")]
    conn.close()
    return jsonify({
        "botUsername": c.get("botUsername", ""),
        "adZoneId":    c.get("adZoneId", ""),
        "welcomeMessage": c.get("welcomeMessage", ""),
        "adValue":     float(c.get("adValue", 0)),
        "referralBonus": float(c.get("referralBonus", 0)),
        "dailyAdLimit": int(c.get("dailyAdLimit", 20)),
        "adsPerBreak":  int(c.get("adsPerBreak", 5)),
        "breakDuration": int(c.get("breakDuration", 10)),
        "minimumWithdrawReferrals": int(c.get("minimumWithdrawReferrals", 0)),
        "tasks":   tasks,
        "links":   links,
        "withdrawMethods": methods,
    })


@app.route("/api/user/init", methods=["POST"])
def api_user_init():
    data   = request.json or {}
    tg_user = data.get("user", {})
    uid    = tg_user.get("id")
    if not uid:
        return jsonify({"error": "Invalid user"}), 400

    ref_id  = data.get("referralId")
    today   = time.strftime("%Y-%m-%d")
    c       = cfg()
    conn    = get_db()

    row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        valid_ref = ref_id and str(ref_id) != str(uid)
        conn.execute("""INSERT INTO users
            (id,first_name,last_name,username,photo_url,
             balance,earning_wallet,referrals,referred_by,
             total_earned,lifetime_ad_count,daily_ad_count,
             last_ad_date,break_until,welcomed,created_at)
            VALUES(?,?,?,?,?,0,0,0,?,0,0,0,'1970-01-01',0,0,?)""",
            (uid, tg_user.get("first_name",""), tg_user.get("last_name",""),
             tg_user.get("username",""), tg_user.get("photo_url",""),
             ref_id if valid_ref else None, int(time.time())))
        if valid_ref:
            bonus = float(c.get("referralBonus", 0))
            if bonus > 0:
                conn.execute("UPDATE users SET balance=balance+?,referrals=referrals+1 WHERE id=?",
                             (bonus, ref_id))
            else:
                conn.execute("UPDATE users SET referrals=referrals+1 WHERE id=?", (ref_id,))
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    else:
        if row["last_ad_date"] != today:
            conn.execute("UPDATE users SET daily_ad_count=0,last_ad_date=? WHERE id=?", (today, uid))
            conn.commit()
            row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

    done = {r["task_id"]: True
            for r in conn.execute("SELECT task_id FROM completed_tasks WHERE user_id=?", (uid,))}
    conn.close()
    result = dict(row)
    result["completedTasks"] = done
    return jsonify(result)


@app.route("/api/user/watch-ad", methods=["POST"])
def api_watch_ad():
    data = request.json or {}
    uid  = data.get("userId")
    if not uid:
        return jsonify({"error": "Invalid"}), 400

    c    = cfg()
    dlim = int(c.get("dailyAdLimit", 20))
    av   = float(c.get("adValue", 0))
    apb  = int(c.get("adsPerBreak", 5))
    bd   = int(c.get("breakDuration", 10))

    conn  = get_db()
    today = time.strftime("%Y-%m-%d")
    row   = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        conn.close(); return jsonify({"error": "Not found"}), 404

    if row["daily_ad_count"] >= dlim:
        conn.close(); return jsonify({"error": "Daily limit reached"}), 400

    now_ms = int(time.time() * 1000)
    if row["break_until"] and now_ms < row["break_until"]:
        conn.close()
        return jsonify({"error": "On break", "breakUntil": row["break_until"]}), 400

    new_daily    = row["daily_ad_count"] + 1
    new_lifetime = row["lifetime_ad_count"] + 1
    new_earned   = row["total_earned"] + av
    new_wallet   = row["earning_wallet"] + av
    new_break    = (now_ms + bd * 60000) if (apb > 0 and new_daily % apb == 0) else 0

    conn.execute("""UPDATE users SET daily_ad_count=?,lifetime_ad_count=?,total_earned=?,
        earning_wallet=?,break_until=?,last_ad_date=? WHERE id=?""",
        (new_daily, new_lifetime, new_earned, new_wallet, new_break, today, uid))
    conn.execute("""INSERT INTO daily_earnings(user_id,date,amount) VALUES(?,?,?)
        ON CONFLICT(user_id,date) DO UPDATE SET amount=amount+?""",
        (uid, today, av, av))
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    conn.close()
    return jsonify(dict(row))


@app.route("/api/user/move-balance", methods=["POST"])
def api_move_balance():
    uid  = (request.json or {}).get("userId")
    conn = get_db()
    row  = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row or row["earning_wallet"] < 100:
        conn.close()
        return jsonify({"error": "Недостаточно средств (мин. 100 ₽)"}), 400
    conn.execute("UPDATE users SET balance=balance+?,earning_wallet=0 WHERE id=?",
                 (row["earning_wallet"], uid))
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    conn.close()
    return jsonify(dict(row))


@app.route("/api/user/withdraw", methods=["POST"])
def api_withdraw():
    data   = request.json or {}
    uid    = data.get("userId")
    method = data.get("method")
    acct   = data.get("account")
    amount = float(data.get("amount", 0))

    c      = cfg()
    min_r  = int(c.get("minimumWithdrawReferrals", 0))

    conn = get_db()
    row  = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        conn.close(); return jsonify({"error": "Пользователь не найден"}), 404
    if min_r > 0 and row["referrals"] < min_r:
        conn.close()
        return jsonify({"error": f"Нужно минимум {min_r} рефералов"}), 400
    if amount > row["balance"]:
        conn.close(); return jsonify({"error": "Недостаточно средств"}), 400

    req_id = str(uuid.uuid4())
    name   = f"{row['first_name']} {row['last_name']}".strip()
    now_ms = int(time.time() * 1000)

    conn.execute("UPDATE users SET balance=balance-? WHERE id=?", (amount, uid))
    conn.execute("""INSERT INTO withdrawals(id,user_id,user_name,method,account,amount,status,created_at)
        VALUES(?,?,?,?,?,?,'pending',?)""",
        (req_id, uid, name, method, acct, amount, now_ms))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "id": req_id,
                    "withdrawal": {"id": req_id, "user_id": uid, "user_name": name,
                                   "method": method, "account": acct,
                                   "amount": amount, "status": "pending", "created_at": now_ms}})


@app.route("/api/user/history")
def api_user_history():
    uid  = request.args.get("userId")
    conn = get_db()
    rows = conn.execute("SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC", (uid,)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/user/earnings")
def api_user_earnings():
    uid   = request.args.get("userId")
    today = time.time()
    dates = [time.strftime("%Y-%m-%d", time.localtime(today - i * 86400)) for i in range(6, -1, -1)]
    conn  = get_db()
    result = []
    for d in dates:
        r = conn.execute("SELECT amount FROM daily_earnings WHERE user_id=? AND date=?", (uid, d)).fetchone()
        result.append(r["amount"] if r else 0)
    conn.close()
    return jsonify({"dates": dates, "earnings": result})


@app.route("/api/leaderboard")
def api_leaderboard():
    conn = get_db()
    ref_rows = conn.execute(
        "SELECT id,first_name,photo_url,referrals FROM users ORDER BY referrals DESC LIMIT 10").fetchall()
    earn_rows = conn.execute(
        "SELECT id,first_name,photo_url,total_earned FROM users ORDER BY total_earned DESC LIMIT 10").fetchall()
    conn.close()
    return jsonify({
        "referral": [dict(r) for r in ref_rows],
        "earning":  [dict(r) for r in earn_rows],
    })


@app.route("/api/task/claim", methods=["POST"])
def api_claim_task():
    data    = request.json or {}
    uid     = data.get("userId")
    task_id = data.get("taskId")
    conn    = get_db()
    if conn.execute("SELECT 1 FROM completed_tasks WHERE user_id=? AND task_id=?", (uid, task_id)).fetchone():
        conn.close(); return jsonify({"error": "Уже получено"}), 400
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        conn.close(); return jsonify({"error": "Задание не найдено"}), 404
    conn.execute("INSERT INTO completed_tasks(user_id,task_id) VALUES(?,?)", (uid, task_id))
    conn.execute("UPDATE users SET balance=balance+? WHERE id=?", (task["reward"], uid))
    conn.commit()
    conn.close()
    return jsonify({"success": True, "reward": task["reward"]})


@app.route("/api/user/welcomed", methods=["POST"])
def api_welcomed():
    uid = (request.json or {}).get("userId")
    conn = get_db()
    conn.execute("UPDATE users SET welcomed=1 WHERE id=?", (uid,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


# ════════════════════════ ADMIN API ═══════════════════════════

@app.route("/api/admin/dashboard")
@require_admin
def adm_dashboard():
    conn = get_db()
    total_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    pending     = conn.execute("SELECT COUNT(*) FROM withdrawals WHERE status='pending'").fetchone()[0]
    paid        = conn.execute("SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='completed'").fetchone()[0]
    total_bal   = conn.execute("SELECT COALESCE(SUM(balance),0) FROM users").fetchone()[0]
    conn.close()
    return jsonify({"totalUsers": total_users, "pendingWithdrawals": pending,
                    "totalPaid": paid, "totalBalance": total_bal})


@app.route("/api/admin/users")
@require_admin
def adm_users():
    conn = get_db()
    rows = conn.execute("SELECT * FROM users ORDER BY first_name").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/users/<int:uid>/balance", methods=["POST"])
@require_admin
def adm_edit_balance(uid):
    amount = float((request.json or {}).get("amount", 0))
    conn = get_db()
    conn.execute("UPDATE users SET balance=balance+? WHERE id=?", (amount, uid))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/admin/withdrawals/pending")
@require_admin
def adm_pending():
    conn = get_db()
    rows = conn.execute("SELECT * FROM withdrawals WHERE status='pending' ORDER BY created_at DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/admin/withdrawals/<req_id>/action", methods=["POST"])
@require_admin
def adm_action(req_id):
    action = (request.json or {}).get("action")
    conn   = get_db()
    req    = conn.execute("SELECT * FROM withdrawals WHERE id=?", (req_id,)).fetchone()
    if not req:
        conn.close(); return jsonify({"error": "Not found"}), 404
    status = "completed" if action == "approve" else "rejected"
    conn.execute("UPDATE withdrawals SET status=? WHERE id=?", (status, req_id))
    if action == "reject":
        conn.execute("UPDATE users SET balance=balance+? WHERE id=?", (req["amount"], req["user_id"]))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/admin/withdrawals/history")
@require_admin
def adm_history():
    conn = get_db()
    comp = conn.execute("SELECT * FROM withdrawals WHERE status='completed' ORDER BY created_at DESC LIMIT 200").fetchall()
    rej  = conn.execute("SELECT * FROM withdrawals WHERE status='rejected'  ORDER BY created_at DESC LIMIT 200").fetchall()
    conn.close()
    return jsonify({"completed": [dict(r) for r in comp], "rejected": [dict(r) for r in rej]})


@app.route("/api/admin/tasks")
@require_admin
def adm_tasks():
    conn = get_db()
    tasks = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()
    links = conn.execute("SELECT * FROM links ORDER BY created_at DESC").fetchall()
    conn.close()
    return jsonify({"tasks": [dict(t) for t in tasks], "links": [dict(l) for l in links]})


@app.route("/api/admin/tasks", methods=["POST"])
@require_admin
def adm_add_task():
    d   = request.json or {}
    tid = str(uuid.uuid4())
    conn = get_db()
    conn.execute("INSERT INTO tasks(id,name,url,reward,icon,created_at) VALUES(?,?,?,?,?,?)",
                 (tid, d["name"], d["url"], float(d["reward"]), d["icon"], int(time.time())))
    conn.commit(); conn.close()
    return jsonify({"success": True, "id": tid})


@app.route("/api/admin/tasks/<tid>", methods=["DELETE"])
@require_admin
def adm_del_task(tid):
    conn = get_db()
    conn.execute("DELETE FROM tasks WHERE id=?", (tid,))
    conn.commit(); conn.close()
    return jsonify({"success": True})


@app.route("/api/admin/links", methods=["POST"])
@require_admin
def adm_add_link():
    d   = request.json or {}
    lid = str(uuid.uuid4())
    conn = get_db()
    conn.execute("INSERT INTO links(id,name,url,icon,created_at) VALUES(?,?,?,?,?)",
                 (lid, d["name"], d["url"], d["icon"], int(time.time())))
    conn.commit(); conn.close()
    return jsonify({"success": True, "id": lid})


@app.route("/api/admin/links/<lid>", methods=["DELETE"])
@require_admin
def adm_del_link(lid):
    conn = get_db()
    conn.execute("DELETE FROM links WHERE id=?", (lid,))
    conn.commit(); conn.close()
    return jsonify({"success": True})


@app.route("/api/admin/settings")
@require_admin
def adm_get_settings():
    c    = cfg()
    conn = get_db()
    methods = [{"name": r["name"], "min": r["min_amount"]}
               for r in conn.execute("SELECT name,min_amount FROM withdraw_methods")]
    conn.close()
    c["withdrawMethods"] = methods
    return jsonify(c)


@app.route("/api/admin/settings", methods=["POST"])
@require_admin
def adm_save_settings():
    d    = request.json or {}
    conn = get_db()
    keys = ["botUsername","botToken","adZoneId","welcomeMessage","adValue",
            "referralBonus","dailyAdLimit","adsPerBreak","breakDuration","minimumWithdrawReferrals"]
    for k in keys:
        if k in d:
            conn.execute("INSERT OR REPLACE INTO config(key,value) VALUES(?,?)", (k, str(d[k])))
    conn.execute("DELETE FROM withdraw_methods")
    for m in d.get("withdrawMethods", []):
        conn.execute("INSERT INTO withdraw_methods(name,min_amount) VALUES(?,?)",
                     (m["name"], float(m["min"])))
    conn.commit(); conn.close()
    return jsonify({"success": True})


@app.route("/api/admin/broadcast", methods=["POST"])
@require_admin
def adm_broadcast():
    msg = (request.json or {}).get("message", "")
    if not msg:
        return jsonify({"error": "Message required"}), 400
    bid  = str(uuid.uuid4())
    conn = get_db()
    conn.execute("INSERT INTO broadcasts(id,message,status,created_at) VALUES(?,?,'pending',?)",
                 (bid, msg, int(time.time())))
    conn.commit(); conn.close()
    return jsonify({"success": True})


# ──────────────────────────────────────────────────────────────

init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
