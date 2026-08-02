// =====================================================
// TeleGrow — Mini App front-end logic
// =====================================================
const API = ""; // same-origin Worker

const tg = window.Telegram ? window.Telegram.WebApp : null;

let state = {
  user: null,
  settings: {},
  categories: [],
  services: [],
  activeCategoryId: null,
  selectedService: null,
};

const el = (id) => document.getElementById(id);
function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(n){ return (Number(n)||0).toFixed(2); }
function safeAlert(msg){ if(tg && tg.showAlert){ tg.showAlert(msg); } else { alert(msg); } }
function haptic(type){ try{ tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(type); }catch(e){} }

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- Preloader ----------------
function runPreloader() {
  return new Promise((resolve) => {
    let pct = 0;
    const timer = setInterval(() => {
      pct += Math.floor(Math.random() * 6) + 3;
      if (pct >= 100) { pct = 100; clearInterval(timer); resolve(); }
      el('preloader-percentage').textContent = pct + '%';
    }, 55);
  });
}
function hidePreloader() {
  el('preloader').style.opacity = '0';
  el('preloader-footer').style.opacity = '0';
  setTimeout(() => {
    el('preloader').style.display = 'none';
    el('preloader-footer').style.display = 'none';
    document.querySelector('.container').style.display = 'block';
  }, 400);
}

// ---------------- View switching ----------------
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  el('view-' + name).classList.remove('hidden');
  document.querySelectorAll('.nav-button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') { renderOrdersHistory(); renderFundsHistory(); }
}
function switchHistoryTab(tab) {
  document.querySelectorAll('#view-history .pill').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  el('orders-history').classList.toggle('hidden', tab !== 'orders');
  el('funds-history').classList.toggle('hidden', tab !== 'funds');
}
function showModal(id){ el(id).style.display = 'flex'; }
function closeModal(id){ el(id).style.display = 'none'; }
window.onclick = (e) => { if (e.target.classList && e.target.classList.contains('modal')) closeModal(e.target.id); };

// ---------------- Auth ----------------
async function authenticate() {
  let body;
  if (tg && tg.initData) {
    body = { initData: tg.initData };
  } else {
    // Local/dev preview fallback (outside Telegram)
    body = { debugUser: { id: 999999, first_name: 'Guest', username: 'guest' } };
  }
  const { user } = await api('/api/auth', { method: 'POST', body: JSON.stringify(body) });
  state.user = user;
}

// ---------------- Settings ----------------
async function loadSettings() {
  const { settings } = await api('/api/settings/public');
  state.settings = settings;
  const sym = settings.currency_symbol || '৳';
  document.querySelectorAll('#currency-symbol, .currency-symbol').forEach(n => n.textContent = sym);
  el('ad-reward-label').textContent = `+${sym}${money(settings.ad_reward)} / ad`;
  el('ad-reward-copy').textContent = `Watch a short ad to earn ${sym}${money(settings.ad_reward)} instantly. Up to ${settings.daily_ad_limit} ads per day.`;
  el('preloader-channel-link').href = settings.channel_link || '#';
  loadMonetagSDK(settings.monetag_zone_id);
}

function loadMonetagSDK(zoneId){
  if (!zoneId) return;
  const script = document.createElement('script');
  script.src = `//libtl.com/sdk.js`;
  script.setAttribute('data-zone', zoneId);
  script.setAttribute('data-sdk', `show_${zoneId}`);
  script.async = true;
  document.body.appendChild(script);
}

// ---------------- Home ----------------
function renderSparkline(){
  const bars = 14;
  const wrap = el('sparkline');
  wrap.innerHTML = '';
  for (let i=0;i<bars;i++){
    const h = 20 + Math.round(Math.random()*80);
    const bar = document.createElement('i');
    bar.style.height = h + '%';
    wrap.appendChild(bar);
  }
}

function updateBalanceUI(){
  const bal = money(state.user.balance);
  el('total-balance').textContent = bal;
  document.querySelectorAll('.total-balance-mirror').forEach(n => n.textContent = bal);
}

async function refreshStats(){
  try{
    const { orders } = await api(`/api/orders?telegram_id=${state.user.telegram_id}`);
    el('stat-orders').textContent = orders.length;
    state.orders = orders;
  }catch(e){}
}

// ---------------- New Order ----------------
function renderCategoryPills(){
  const wrap = el('category-pills');
  wrap.innerHTML = '';
  state.categories.forEach((c, idx) => {
    const btn = document.createElement('button');
    btn.className = 'pill' + (idx === 0 ? ' active' : '');
    btn.innerHTML = `<i class="${escapeHTML(c.icon || 'fa-solid fa-layer-group')}"></i> ${escapeHTML(c.name)}`;
    btn.onclick = () => selectCategory(c.id, btn);
    wrap.appendChild(btn);
  });
  if (state.categories.length) selectCategory(state.categories[0].id);
}

async function selectCategory(id, btnEl){
  state.activeCategoryId = id;
  document.querySelectorAll('#category-pills .pill').forEach(p => p.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  else {
    const idx = state.categories.findIndex(c => c.id === id);
    const btns = document.querySelectorAll('#category-pills .pill');
    if (btns[idx]) btns[idx].classList.add('active');
  }
  const { services } = await api(`/api/services?category_id=${id}`);
  state.services = services;
  const sel = el('service-select');
  sel.innerHTML = '<option value="">Select a service</option>' +
    services.map(s => `<option value="${s.id}">${escapeHTML(s.name)} — ${state.settings.currency_symbol}${money(s.rate)}/1000</option>`).join('');
  state.selectedService = null;
  el('service-meta').textContent = '';
  clearOrderSummary();
}

function onServiceChange(){
  const id = el('service-select').value;
  state.selectedService = state.services.find(s => String(s.id) === String(id)) || null;
  if (state.selectedService){
    const s = state.selectedService;
    el('service-meta').textContent = `Min ${s.min_qty.toLocaleString()} · Max ${s.max_qty.toLocaleString()}`;
    el('order-qty').placeholder = `Between ${s.min_qty} and ${s.max_qty}`;
  } else {
    el('service-meta').textContent = '';
  }
  recomputeOrderSummary();
}

function recomputeOrderSummary(){
  const s = state.selectedService;
  const qty = parseInt(el('order-qty').value, 10);
  const link = el('order-link').value.trim();
  const sym = state.settings.currency_symbol || '৳';

  if (!s){ clearOrderSummary(); return; }

  const cat = state.categories.find(c => c.id === s.category_id);
  el('sum-category').textContent = cat ? cat.name : '—';
  el('sum-service').textContent = s.name;
  el('sum-rate').textContent = `${sym}${money(s.rate)} / 1000`;
  el('sum-qty').textContent = Number.isFinite(qty) ? qty.toLocaleString() : '—';

  let charge = 0, valid = false;
  if (Number.isFinite(qty) && qty >= s.min_qty && qty <= s.max_qty && /^https?:\/\//i.test(link)) {
    charge = Math.round((s.rate * qty / 1000) * 100) / 100;
    valid = true;
  }
  el('sum-charge').textContent = `${sym}${money(charge)}`;
  el('confirm-order-button').disabled = !valid;
}

function clearOrderSummary(){
  el('sum-category').textContent = '—';
  el('sum-service').textContent = '—';
  el('sum-rate').textContent = '—';
  el('sum-qty').textContent = '—';
  el('sum-charge').textContent = `${state.settings.currency_symbol || '৳'}0.00`;
  el('confirm-order-button').disabled = true;
}

async function confirmOrder(){
  const btn = el('confirm-order-button');
  const s = state.selectedService;
  if (!s) return;
  const link = el('order-link').value.trim();
  const qty = parseInt(el('order-qty').value, 10);

  btn.disabled = true;
  btn.querySelector('.button-text').classList.add('hidden');
  btn.querySelector('.spinner').classList.remove('hidden');

  try{
    const { order, balance } = await api('/api/order', {
      method: 'POST',
      body: JSON.stringify({ telegram_id: state.user.telegram_id, service_id: s.id, link, quantity: qty }),
    });
    state.user.balance = balance;
    updateBalanceUI();
    haptic('success');
    safeAlert(`Order #${order.id} placed! ${state.settings.currency_symbol}${money(order.charge)} deducted from your wallet.`);
    el('order-link').value = '';
    el('order-qty').value = '';
    clearOrderSummary();
    refreshStats();
    switchView('home');
  }catch(e){
    haptic('error');
    safeAlert(e.message);
  }finally{
    btn.disabled = false;
    btn.querySelector('.button-text').classList.remove('hidden');
    btn.querySelector('.spinner').classList.add('hidden');
  }
}

// ---------------- Add funds (watch ad) ----------------
async function watchAd(){
  const zoneId = state.settings.monetag_zone_id;
  const adFn = zoneId ? window[`show_${zoneId}`] : null;

  el('ad-loader-overlay').style.display = 'flex';

  const finish = async () => {
    try{
      const res = await api('/api/ad-reward', {
        method: 'POST',
        body: JSON.stringify({ telegram_id: state.user.telegram_id }),
      });
      state.user.balance = res.balance;
      updateBalanceUI();
      el('ads-watched-label').textContent = `${res.watched_today} / ${res.daily_limit} today`;
      el('stat-ads-today').textContent = `${res.watched_today}/${res.daily_limit}`;
      haptic('success');
      safeAlert(`+${state.settings.currency_symbol}${money(res.reward)} added to your wallet!`);
    }catch(e){
      safeAlert(e.message);
    }finally{
      el('ad-loader-overlay').style.display = 'none';
    }
  };

  if (typeof adFn === 'function'){
    adFn().then(finish).catch(() => {
      el('ad-loader-overlay').style.display = 'none';
      safeAlert('Ad could not be loaded. Please try again.');
    });
  } else {
    // No ad zone configured yet — fall back gracefully in dev/preview
    setTimeout(finish, 1200);
  }
}

// ---------------- History ----------------
function statusClass(s){ return (s || 'pending').toLowerCase(); }

async function renderOrdersHistory(){
  try{
    const { orders } = await api(`/api/orders?telegram_id=${state.user.telegram_id}`);
    const wrap = el('orders-history');
    if (!orders.length){ wrap.innerHTML = emptyState('fa-bag-shopping', 'No orders yet'); return; }
    wrap.innerHTML = orders.map(o => `
      <div class="history-item">
        <div class="history-details">
          <span class="name">${escapeHTML(o.service_name)}</span>
          <span class="meta">${new Date(o.created_at).toLocaleString()} · Qty ${o.quantity.toLocaleString()}</span>
        </div>
        <div class="history-amount">
          <div class="amt">${state.settings.currency_symbol}${money(o.charge)}</div>
          <span class="status-badge ${statusClass(o.status)}">${escapeHTML(o.status)}</span>
        </div>
      </div>`).join('');
  }catch(e){}
}

async function renderFundsHistory(){
  try{
    const { user } = await api(`/api/user?telegram_id=${state.user.telegram_id}`);
    // transactions aren't exposed via a dedicated public endpoint yet beyond orders;
    // ad rewards/orders are reconstructed client-side from orders + balance for now.
    const wrap = el('funds-history');
    if (!state.orders) { wrap.innerHTML = emptyState('fa-coins', 'No transactions yet'); return; }
    wrap.innerHTML = emptyState('fa-coins', 'Full transaction log coming soon — check Orders for charges.');
  }catch(e){}
}

function emptyState(icon, text){
  return `<div class="empty-state"><i class="fa-solid ${icon}"></i><p>${escapeHTML(text)}</p></div>`;
}

// ---------------- Bonus / Invite ----------------
function renderBonusList(){
  const wrap = el('bonus-tasks-list');
  const link = state.settings.channel_link || '#';
  wrap.innerHTML = `
    <div class="list-row">
      <div class="details">
        <span class="title"><i class="fa-brands fa-telegram" style="color:var(--primary);margin-right:8px;"></i>Join our update channel</span>
      </div>
      <button class="btn btn-sm btn-outline" onclick="safeTgOpen('${link}')">Open</button>
    </div>`;
}
function safeTgOpen(link){ if (tg && tg.openTelegramLink) tg.openTelegramLink(link); else window.open(link, '_blank'); }

function getReferralLink(){
  const uname = state.settings.bot_username;
  const tid = state.user.telegram_id;
  return uname ? `https://t.me/${uname}?startapp=${tid}` : window.location.href;
}
function copyReferralLink(){
  navigator.clipboard.writeText(getReferralLink())
    .then(() => safeAlert('Referral link copied!'))
    .catch(() => safeAlert('Could not copy link.'));
}
function shareReferralLink(){
  const link = getReferralLink();
  const text = `Grow your Telegram, YouTube, Facebook, Instagram &amp; TikTok with TeleGrow! Join with my link:\n${link}`;
  if (tg && tg.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  } else {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`, '_blank');
  }
}

// ---------------- Init ----------------
async function init(){
  const preloaderDone = runPreloader();

  try{
    await authenticate();
    await loadSettings();

    if (state.user.banned) {
      showModal('multiAccountModal');
      return;
    }

    const { categories } = await api('/api/categories');
    state.categories = categories;
    renderCategoryPills();

    updateBalanceUI();
    renderSparkline();
    refreshStats();
    renderBonusList();

    const user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || { first_name: state.user.first_name, photo_url: state.user.photo_url };
    if (user.photo_url) el('profile-pic').innerHTML = `<img src="${user.photo_url}" alt="">`;
    else el('profile-pic').innerHTML = `<span>${escapeHTML((user.first_name || 'U').charAt(0))}</span>`;

    el('service-select').addEventListener('change', onServiceChange);
    el('order-link').addEventListener('input', recomputeOrderSummary);
    el('order-qty').addEventListener('input', recomputeOrderSummary);
    el('confirm-order-button').addEventListener('click', confirmOrder);
    el('watch-ad-button').addEventListener('click', watchAd);
    el('admin-contact-button').addEventListener('click', () => safeTgOpen(state.settings.support_link));
    el('copy-link-button').addEventListener('click', copyReferralLink);
    el('share-link-button').addEventListener('click', shareReferralLink);

    safeTgAction();

    if (!sessionStorage.getItem('tg_welcomed')) {
      el('welcome-title').textContent = `Welcome to ${state.settings.site_name || 'TeleGrow'}!`;
      el('welcome-message').textContent =
        `Order real, high-quality engagement for Telegram, YouTube, Facebook, Instagram &amp; TikTok.\n\n` +
        `💰 No balance? Watch ads to earn ${state.settings.currency_symbol}${money(state.settings.ad_reward)} per ad, up to ${state.settings.daily_ad_limit}/day.\n` +
        `⚡ Orders are processed after admin review.\n` +
        `🎁 Invite friends to earn ${state.settings.currency_symbol}${money(state.settings.referral_reward)} per referral.`;
      showModal('welcomeModal');
      sessionStorage.setItem('tg_welcomed', 'true');
    }
  }catch(e){
    console.error(e);
    safeAlert('Failed to load TeleGrow: ' + e.message);
  }finally{
    await preloaderDone;
    hidePreloader();
  }
}

function safeTgAction(){
  if (!tg) return;
  try{ tg.ready(); tg.expand(); }catch(e){}
}

window.addEventListener('load', init);
