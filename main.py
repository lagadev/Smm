"""
Telegram Mini App SMM Panel - Single-file FastAPI backend.

Everything (models, schemas, auth, routes, admin routes, provider integration)
lives in this one file on purpose, to keep the project to four files total:
main.py, requirements.txt, index/index.html, admin/admin.html.

Run locally:
    uvicorn main:app --reload --port 8000

Deploy on Render:
    Build command : pip install -r requirements.txt
    Start command : uvicorn main:app --host 0.0.0.0 --port $PORT
    Add the environment variables listed below in the Render dashboard.

Environment variables:
    DATABASE_URL      - PostgreSQL connection string
    JWT_SECRET        - secret used to sign user JWTs
    BOT_TOKEN         - Telegram bot token (used to validate Telegram WebApp initData)
    PROVIDER_API_KEY  - your provider api key (get it from your provider's Account page)
    PROVIDER_BASE_URL - e.g. https://smmprovider.onrender.com/api/v2
    ADMIN_KEY         - shared secret required by admin/admin.html to call /api/admin/* routes

────────────────────────────────────────────────────────────────────────
HOW THE SERVICE-ID MAPPING WORKS
────────────────────────────────────────────────────────────────────────
Your provider (https://smmprovider.onrender.com/api/v2) has its own internal
service IDs (1, 2, 3 ...). You don't want to expose those raw provider IDs to
your users, and you may want to resell at your own price. So this backend
keeps a `ServiceMap` table:

    custom_id            -> the ID your users see, e.g. 2001, 2002, 4001
    provider_service_id  -> the provider's real ID, e.g. 1, 2, 3 (hidden from users)
    name / category      -> what users see
    rate                 -> what you charge your users (per 1000)
    min / max            -> order quantity limits
    refill / cancel      -> capability flags
    active                -> whether it's shown to users right now

Admins manage this mapping from admin/admin.html -> "Services" tab, where the
"Your provider services" table is fetched live over HTTP from the provider,
and each row can be mapped to a custom ID with one click.
"""

import os
import hmac
import hashlib
import secrets
import string
import json
from datetime import datetime, timedelta
from urllib.parse import parse_qsl
from typing import Optional, List

import httpx
import jwt
from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import (
    create_engine, Column, Integer, BigInteger, String, Float, Boolean, DateTime, ForeignKey
)
from sqlalchemy.orm import sessionmaker, declarative_base, Session, relationship

# ──────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/smmpanel")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

JWT_SECRET = os.getenv("JWT_SECRET", "change-this-secret")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 30

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
PROVIDER_API_KEY = os.getenv("PROVIDER_API_KEY", os.getenv("SMMGEN_API_KEY", ""))
PROVIDER_BASE_URL = os.getenv("PROVIDER_BASE_URL", os.getenv("SMMGEN_BASE_URL", "https://smmprovider.onrender.com/api/v2"))
ADMIN_KEY = os.getenv("ADMIN_KEY", "change-this-admin-key")

# ──────────────────────────────────────────────────────────────────────────
# Database setup
# ──────────────────────────────────────────────────────────────────────────

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ──────────────────────────────────────────────────────────────────────────
# Models
# ──────────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    telegram_id = Column(BigInteger, unique=True, index=True, nullable=False)
    username = Column(String, nullable=True)
    first_name = Column(String, nullable=True)
    api_key = Column(String, unique=True, index=True, nullable=False)
    balance = Column(Float, default=0.0)
    total_orders = Column(Integer, default=0)
    completed_orders = Column(Integer, default=0)
    pending_orders = Column(Integer, default=0)
    cancelled_orders = Column(Integer, default=0)
    total_deposit = Column(Float, default=0.0)
    total_spent = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow)

    orders = relationship("Order", back_populates="user")
    deposits = relationship("Deposit", back_populates="user")


class ServiceMap(Base):
    """Maps a custom (user-facing) service ID to a real provider service ID."""
    __tablename__ = "service_map"

    id = Column(Integer, primary_key=True, index=True)
    custom_id = Column(String, unique=True, index=True, nullable=False)   # e.g. "2001"
    provider_service_id = Column(String, nullable=False)                  # e.g. "1"
    name = Column(String, nullable=False)
    category = Column(String, nullable=True)
    rate = Column(Float, nullable=False)         # price charged to users, per 1000
    min_qty = Column(Integer, default=50)
    max_qty = Column(Integer, default=10000)
    refill = Column(Boolean, default=False)
    cancel = Column(Boolean, default=False)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    custom_service_id = Column(String, nullable=False)     # e.g. "2001" (what the user picked)
    provider_service_id = Column(String, nullable=False)   # e.g. "1" (sent to provider, hidden from user)
    service_name = Column(String, nullable=True)
    category = Column(String, nullable=True)
    link = Column(String, nullable=False)
    quantity = Column(Integer, nullable=False)
    charge = Column(Float, nullable=False)
    provider_order_id = Column(String, nullable=True, index=True)  # real order id from provider, e.g. 64886784
    status = Column(String, default="pending")  # pending | in_progress | completed | cancelled | partial
    start_count = Column(String, nullable=True)
    remains = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="orders")


class Deposit(Base):
    __tablename__ = "deposits"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    amount = Column(Float, nullable=False)
    bonus = Column(Float, default=0.0)
    status = Column(String, default="pending")  # pending | approved | rejected
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="deposits")


Base.metadata.create_all(bind=engine)

# ──────────────────────────────────────────────────────────────────────────
# Schemas
# ──────────────────────────────────────────────────────────────────────────

class TelegramAuthIn(BaseModel):
    init_data: str


class OrderIn(BaseModel):
    service_id: str   # this is the CUSTOM id the user selected, e.g. "2001"
    link: str
    quantity: int


class DepositIn(BaseModel):
    amount: float
    bonus: float = 0.0


class DepositStatusIn(BaseModel):
    status: str  # approved | rejected


class ServiceMapIn(BaseModel):
    custom_id: str
    provider_service_id: str
    name: str
    category: Optional[str] = None
    rate: float
    min_qty: int = 50
    max_qty: int = 10000
    refill: bool = False
    cancel: bool = False
    active: bool = True


class ServiceMapToggleIn(BaseModel):
    active: bool


# ──────────────────────────────────────────────────────────────────────────
# Auth helpers
# ──────────────────────────────────────────────────────────────────────────

def verify_telegram_init_data(init_data: str, bot_token: str) -> dict:
    """Validates Telegram WebApp initData per Telegram's documented HMAC scheme."""
    if not bot_token:
        raise HTTPException(status_code=500, detail="Server missing BOT_TOKEN")

    parsed = dict(parse_qsl(init_data, strict_parsing=True))
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        raise HTTPException(status_code=401, detail="Missing hash in initData")

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        raise HTTPException(status_code=401, detail="Invalid Telegram initData")

    user_json = parsed.get("user")
    if not user_json:
        raise HTTPException(status_code=401, detail="No user in initData")

    return json.loads(user_json)


def create_access_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS)}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def get_current_user(authorization: Optional[str] = Header(None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_admin(x_admin_key: Optional[str] = Header(None)):
    if not x_admin_key or not hmac.compare_digest(x_admin_key, ADMIN_KEY):
        raise HTTPException(status_code=401, detail="Invalid admin key")


def generate_api_key() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(40))


# ──────────────────────────────────────────────────────────────────────────
# Provider integration (https://smmprovider.onrender.com/api/v2 style API)
# All calls are real outbound HTTP requests (via httpx), so order status /
# order details always reflect what the provider currently reports.
# ──────────────────────────────────────────────────────────────────────────

async def provider_request(payload: dict) -> dict:
    body = {"key": PROVIDER_API_KEY, **payload}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(PROVIDER_BASE_URL, data=body)
        resp.raise_for_status()
        return resp.json()


async def provider_get_services() -> list:
    """
    Returns the provider's raw service catalogue, each item shaped like:
    { "service": 1, "name": "Followers", "type": "Default", "category": "First Category",
      "rate": "0.90", "min": "50", "max": "10000", "refill": true, "cancel": true }
    """
    data = await provider_request({"action": "services"})
    return data if isinstance(data, list) else []


async def provider_add_order(provider_service_id: str, link: str, quantity: int) -> dict:
    """POST action=add -> { "order": 64886784 }"""
    return await provider_request(
        {"action": "add", "service": provider_service_id, "link": link, "quantity": quantity}
    )


async def provider_order_status(provider_order_id: str) -> dict:
    """POST action=status -> { "charge": "...", "start_count": "...", "status": "...", "remains": "...", "currency": "..." }"""
    return await provider_request({"action": "status", "order": provider_order_id})


def normalize_status(provider_status: str) -> str:
    s = (provider_status or "").lower()
    if "complet" in s:
        return "completed"
    if "cancel" in s or "refund" in s:
        return "cancelled"
    if "partial" in s:
        return "partial"
    if "progress" in s or "process" in s:
        return "in_progress"
    return "pending"


# ──────────────────────────────────────────────────────────────────────────
# App
# ──────────────────────────────────────────────────────────────────────────

app = FastAPI(title="SMM Panel API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth ────────────────────────────────────────────────────────────────

@app.post("/api/auth/telegram")
def auth_telegram(payload: TelegramAuthIn, db: Session = Depends(get_db)):
    tg_user = verify_telegram_init_data(payload.init_data, BOT_TOKEN)
    telegram_id = tg_user["id"]

    user = db.query(User).filter(User.telegram_id == telegram_id).first()
    if not user:
        user = User(
            telegram_id=telegram_id,
            username=tg_user.get("username"),
            first_name=tg_user.get("first_name"),
            api_key=generate_api_key(),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        user.username = tg_user.get("username")
        user.first_name = tg_user.get("first_name")
        db.commit()

    token = create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer"}


# ── Profile / Home data ─────────────────────────────────────────────────

def serialize_user(user: User) -> dict:
    return {
        "telegram_id": user.telegram_id,
        "username": user.username,
        "first_name": user.first_name,
        "api_key": user.api_key,
        "balance": user.balance,
        "total_orders": user.total_orders,
        "completed_orders": user.completed_orders,
        "pending_orders": user.pending_orders,
        "cancelled_orders": user.cancelled_orders,
        "total_deposit": user.total_deposit,
        "total_spent": user.total_spent,
        "created_at": user.created_at.isoformat(),
    }


@app.get("/api/profile")
def get_profile(user: User = Depends(get_current_user)):
    return serialize_user(user)


@app.post("/api/profile/regenerate-key")
def regenerate_key(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.api_key = generate_api_key()
    db.commit()
    return {"api_key": user.api_key}


# ── User-facing services (only mapped + active rows, custom IDs only) ───

@app.get("/api/services")
def list_services(db: Session = Depends(get_db)):
    rows = db.query(ServiceMap).filter(ServiceMap.active == True).order_by(ServiceMap.custom_id).all()  # noqa: E712
    return [
        {
            "custom_id": r.custom_id,
            "name": r.name,
            "category": r.category,
            "rate": r.rate,
            "min": r.min_qty,
            "max": r.max_qty,
            "refill": r.refill,
            "cancel": r.cancel,
        }
        for r in rows
    ]


# ── Orders ───────────────────────────────────────────────────────────────

def serialize_order(o: Order) -> dict:
    return {
        "id": o.id,
        "order_id": o.provider_order_id or o.id,   # the big provider order id, e.g. 64886784
        "custom_service_id": o.custom_service_id,
        "service_name": o.service_name,
        "category": o.category,
        "link": o.link,
        "quantity": o.quantity,
        "charge": o.charge,
        "status": o.status,
        "start_count": o.start_count,
        "remains": o.remains,
        "created_at": o.created_at.isoformat(),
    }


@app.get("/api/orders")
def list_orders(
    limit: int = 10, offset: int = 0,
    user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    orders = (
        db.query(Order).filter(Order.user_id == user.id)
        .order_by(Order.created_at.desc()).offset(offset).limit(limit).all()
    )
    return [serialize_order(o) for o in orders]


@app.post("/api/orders")
async def create_order(payload: OrderIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    mapping = db.query(ServiceMap).filter(
        ServiceMap.custom_id == payload.service_id, ServiceMap.active == True  # noqa: E712
    ).first()
    if not mapping:
        raise HTTPException(status_code=400, detail="Service not available")
    if payload.quantity < mapping.min_qty or payload.quantity > mapping.max_qty:
        raise HTTPException(
            status_code=400, detail=f"Quantity must be between {mapping.min_qty} and {mapping.max_qty}"
        )

    charge = round((mapping.rate / 1000) * payload.quantity, 4)
    if user.balance < charge:
        raise HTTPException(status_code=400, detail="Insufficient balance")

    try:
        provider_resp = await provider_add_order(mapping.provider_service_id, payload.link, payload.quantity)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Provider error: {e}")

    if "order" not in provider_resp:
        raise HTTPException(status_code=502, detail=f"Provider rejected order: {provider_resp}")

    order = Order(
        user_id=user.id,
        custom_service_id=mapping.custom_id,
        provider_service_id=mapping.provider_service_id,
        service_name=mapping.name,
        category=mapping.category,
        link=payload.link,
        quantity=payload.quantity,
        charge=charge,
        provider_order_id=str(provider_resp["order"]),
        status="pending",
    )
    user.balance -= charge
    user.total_orders += 1
    user.pending_orders += 1
    user.total_spent += charge

    db.add(order)
    db.commit()
    db.refresh(order)
    return serialize_order(order)


@app.get("/api/orders/{order_id}/details")
async def order_details(order_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """
    Makes a live HTTP request to the provider's `action=status` endpoint and
    returns full order + order-status details (charge, start count, remains,
    live status), updating the locally stored status/counters if it changed.
    """
    order = db.query(Order).filter(Order.id == order_id, Order.user_id == user.id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    provider_data = {}
    if order.provider_order_id:
        try:
            provider_data = await provider_order_status(order.provider_order_id)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Provider error: {e}")

        new_status = normalize_status(provider_data.get("status", order.status))
        if new_status != order.status:
            if order.status == "pending" and new_status != "pending":
                user.pending_orders = max(0, user.pending_orders - 1)
            if new_status == "completed":
                user.completed_orders += 1
            elif new_status == "cancelled":
                user.cancelled_orders += 1
                user.balance += order.charge
                user.total_spent = max(0, user.total_spent - order.charge)
            order.status = new_status

        order.start_count = provider_data.get("start_count", order.start_count)
        order.remains = provider_data.get("remains", order.remains)
        db.commit()
        db.refresh(order)

    result = serialize_order(order)
    result["provider_response"] = {
        "charge": provider_data.get("charge"),
        "start_count": provider_data.get("start_count"),
        "status": provider_data.get("status"),
        "remains": provider_data.get("remains"),
        "currency": provider_data.get("currency"),
    }
    return result


# ── Deposits ─────────────────────────────────────────────────────────────

@app.get("/api/deposits")
def list_deposits(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deposits = db.query(Deposit).filter(Deposit.user_id == user.id).order_by(Deposit.created_at.desc()).all()
    return [
        {"id": d.id, "amount": d.amount, "bonus": d.bonus, "status": d.status, "created_at": d.created_at.isoformat()}
        for d in deposits
    ]


@app.post("/api/deposits")
def create_deposit(payload: DepositIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deposit = Deposit(user_id=user.id, amount=payload.amount, bonus=payload.bonus, status="pending")
    db.add(deposit)
    db.commit()
    db.refresh(deposit)
    return {
        "id": deposit.id, "amount": deposit.amount, "bonus": deposit.bonus,
        "status": deposit.status, "created_at": deposit.created_at.isoformat(),
    }


# ── Admin: users / orders / deposits ────────────────────────────────────

@app.get("/api/admin/users", dependencies=[Depends(require_admin)])
def admin_list_users(db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return [dict(serialize_user(u), id=u.id) for u in users]


@app.get("/api/admin/orders", dependencies=[Depends(require_admin)])
def admin_list_orders(db: Session = Depends(get_db)):
    orders = db.query(Order).order_by(Order.created_at.desc()).limit(200).all()
    return [dict(serialize_order(o), user_id=o.user_id) for o in orders]


@app.get("/api/admin/deposits", dependencies=[Depends(require_admin)])
def admin_list_deposits(db: Session = Depends(get_db)):
    deposits = db.query(Deposit).order_by(Deposit.created_at.desc()).limit(200).all()
    return [
        {"id": d.id, "user_id": d.user_id, "amount": d.amount, "bonus": d.bonus,
         "status": d.status, "created_at": d.created_at.isoformat()}
        for d in deposits
    ]


@app.post("/api/admin/deposits/{deposit_id}/status", dependencies=[Depends(require_admin)])
def admin_update_deposit(deposit_id: int, payload: DepositStatusIn, db: Session = Depends(get_db)):
    deposit = db.query(Deposit).filter(Deposit.id == deposit_id).first()
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if payload.status not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="Status must be approved or rejected")

    if deposit.status != "approved" and payload.status == "approved":
        user = db.query(User).filter(User.id == deposit.user_id).first()
        user.balance += deposit.amount + deposit.bonus
        user.total_deposit += deposit.amount

    deposit.status = payload.status
    db.commit()
    return {"id": deposit.id, "status": deposit.status}


# ── Admin: provider services + custom ID mapping ────────────────────────

@app.get("/api/admin/provider-services", dependencies=[Depends(require_admin)])
async def admin_provider_services():
    """Live HTTP call to the provider to list its raw services & real IDs."""
    try:
        return await provider_get_services()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Provider error: {e}")


@app.get("/api/admin/service-map", dependencies=[Depends(require_admin)])
def admin_list_service_map(db: Session = Depends(get_db)):
    rows = db.query(ServiceMap).order_by(ServiceMap.custom_id).all()
    return [
        {
            "custom_id": r.custom_id, "provider_service_id": r.provider_service_id,
            "name": r.name, "category": r.category, "rate": r.rate,
            "min": r.min_qty, "max": r.max_qty, "refill": r.refill, "cancel": r.cancel,
            "active": r.active,
        }
        for r in rows
    ]


@app.post("/api/admin/service-map", dependencies=[Depends(require_admin)])
def admin_upsert_service_map(payload: ServiceMapIn, db: Session = Depends(get_db)):
    row = db.query(ServiceMap).filter(ServiceMap.custom_id == payload.custom_id).first()
    if not row:
        row = ServiceMap(custom_id=payload.custom_id)
        db.add(row)
    row.provider_service_id = payload.provider_service_id
    row.name = payload.name
    row.category = payload.category
    row.rate = payload.rate
    row.min_qty = payload.min_qty
    row.max_qty = payload.max_qty
    row.refill = payload.refill
    row.cancel = payload.cancel
    row.active = payload.active
    db.commit()
    return {"custom_id": row.custom_id}


@app.post("/api/admin/service-map/{custom_id}/toggle", dependencies=[Depends(require_admin)])
def admin_toggle_service_map(custom_id: str, payload: ServiceMapToggleIn, db: Session = Depends(get_db)):
    row = db.query(ServiceMap).filter(ServiceMap.custom_id == custom_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Mapping not found")
    row.active = payload.active
    db.commit()
    return {"custom_id": row.custom_id, "active": row.active}


@app.delete("/api/admin/service-map/{custom_id}", dependencies=[Depends(require_admin)])
def admin_delete_service_map(custom_id: str, db: Session = Depends(get_db)):
    row = db.query(ServiceMap).filter(ServiceMap.custom_id == custom_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Mapping not found")
    db.delete(row)
    db.commit()
    return {"deleted": custom_id}


# ── Static frontend ──────────────────────────────────────────────────────

@app.get("/")
def serve_index():
    return FileResponse("index/index.html")


@app.get("/admin")
def serve_admin():
    return FileResponse("admin/admin.html")


app.mount("/index", StaticFiles(directory="index"), name="index")
app.mount("/admin-assets", StaticFiles(directory="admin"), name="admin-assets")


@app.get("/health")
def health():
    return {"status": "ok"}
