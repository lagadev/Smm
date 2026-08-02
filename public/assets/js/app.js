// =====================================================
// TeleGrow — Mini App front-end logic (v2)
// =====================================================
const API = ""; // same-origin Worker

const tg = window.Telegram ? window.Telegram.WebApp : null;

let state = {
  user: null,
  settings: {},
  categories: [],
  services: [],
  selectedService: null,
};

const el = (id) => document.getElementById(id);
function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(n){ return (Number(n)||0).toFixed(2); }
function safeAlert(msg){ if(tg && tg.showAlert){ tg.showAlert(msg); } else { alert(msg); } }
function haptic(type){ try{ tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(type); }catch(e){} }
function safeTgOpen(link){ if (tg && tg.openTelegramLink) tg.openTelegramLink(link); else window.open(link, '_blank'); }

async function api(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
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
  }, 350);
}

// ---------------- View switching ----------------
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  el('view-' + name).classList.remove('hidden');
  document.querySelectorAll('.nav-button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') { renderOrdersHistory(); renderTransactionsHistory(); }
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
    body = { debugUser: { id: 999999, first_name: 'Guest', username: 'guest' } }; // dev/preview fallback
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
  el('api-base-url').textContent = window.location.origin + '/api/v2';

  el('ads-earning-card').classList.toggle('hidden', !settings.ads_earning_enabled);
  el('ads-disabled-card').classList.toggle('hidden', !!settings.ads_earning_enabled);

  if (settings.ads_earning_enabled) loadMonetagSDK(settings.monetag_zone_id);
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
function updateBalanceUI(){ el('total-balance').textContent = money(state.user.balance); }

function updateTokenUI(){
  const token = state.user.api_token || '';
  const masked = token ? token.slice(0, 8) + '••••••••••••••••' : '—';
  el('api-token-display').textContent = masked;
  el('api-token-display').dataset.full = token;
}
function copyToken(){
  const token = state.user.api_token;
  if (!token) return;
  navigator.clipboard.writeText(token).then(() => safeAlert('API key copied!')).catch(() => safeAlert('Could not copy key.'));
}
async function regenerateToken(){
  if (tg && tg.showConfirm) {
    tg.showConfirm('Regenerate your API key? The old key will stop working immediately.', async (ok) => { if (ok) await doRegenerate(); });
  } else if (confirm('Regenerate your API key? The old key will stop working immediately.')) {
    await doRegenerate();
  }
}
async function doRegenerate(){
  try{
    const { api_token } = await api('/api/user/regenerate-token', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id }) });
    state.user.api_token = api_token;
    updateTokenUI();
    haptic('success');
    safeAlert('New API key generated.');
  }catch(e){ safeAlert(e.message); }
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
  document.querySelectorAll('#category-pills .pill').forEach(p => p.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
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
      const res = await api('/api/ad-reward', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id }) });
      state.user.balance = res.balance;
      updateBalanceUI();
      el('ads-watched-label').textContent = `${res.watched_today} / ${res.daily_limit} today`;
      haptic('success');
      safeAlert(`+${state.settings.currency_symbol}${money(res.reward)} added to your wallet!`);
    }catch(e){
      safeAlert(e.message);
    }finally{
      el('ad-loader-overlay').style.display = 'none';
    }
  };

  if (typeof adFn === 'function'){
    adFn().then(finish).catch(() => { el('ad-loader-overlay').style.display = 'none'; safeAlert('Ad could not be loaded. Please try again.'); });
  } else {
    setTimeout(finish, 1200); // dev/preview fallback when no ad zone configured
  }
}

// ---------------- History ----------------
function statusClass(s){ return (s || 'pending').toLowerCase(); }
function emptyState(icon, text){ return `<div class="empty-state"><i class="fa-solid ${icon}"></i><p>${escapeHTML(text)}</p></div>`; }

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

async function renderTransactionsHistory(){
  try{
    const { transactions } = await api(`/api/transactions?telegram_id=${state.user.telegram_id}`);
    const wrap = el('funds-history');
    if (!transactions.length){ wrap.innerHTML = emptyState('fa-coins', 'No transactions yet'); return; }
    const labels = { ad_reward: 'Ad Reward', order: 'Order Charge', admin_add: 'Admin Credit', admin_deduct: 'Admin Debit' };
    wrap.innerHTML = transactions.map(t => `
      <div class="history-item">
        <div class="history-details">
          <span class="name">${escapeHTML(labels[t.type] || t.type)}</span>
          <span class="meta">${new Date(t.created_at).toLocaleString()}${t.note ? ' · ' + escapeHTML(t.note) : ''}</span>
        </div>
        <div class="history-amount">
          <div class="amt" style="color:${t.amount >= 0 ? 'var(--success)' : 'var(--danger)'};">${t.amount >= 0 ? '+' : ''}${state.settings.currency_symbol}${money(t.amount)}</div>
        </div>
      </div>`).join('');
  }catch(e){}
}

// ---------------- Init ----------------
async function init(){
  const preloaderDone = runPreloader();
  try{
    await authenticate();
    await loadSettings();

    if (state.user.banned) { showModal('multiAccountModal'); return; }

    const { categories } = await api('/api/categories');
    state.categories = categories;
    renderCategoryPills();

    updateBalanceUI();
    updateTokenUI();

    const user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || { first_name: state.user.first_name, photo_url: state.user.photo_url };
    if (user.photo_url) el('profile-pic').innerHTML = `<img src="${user.photo_url}" alt="">`;
    else el('profile-pic').innerHTML = `<span>${escapeHTML((user.first_name || 'U').charAt(0))}</span>`;

    el('service-select').addEventListener('change', onServiceChange);
    el('order-link').addEventListener('input', recomputeOrderSummary);
    el('order-qty').addEventListener('input', recomputeOrderSummary);
    el('confirm-order-button').addEventListener('click', confirmOrder);
    el('watch-ad-button').addEventListener('click', watchAd);
    el('copy-token-btn').addEventListener('click', copyToken);
    el('regen-token-btn').addEventListener('click', regenerateToken);
    el('contact-admin-fund-button').addEventListener('click', () => safeTgOpen(state.settings.support_link));

    safeTgAction();

    if (!sessionStorage.getItem('tg_welcomed')) {
      el('welcome-title').textContent = `Welcome to ${state.settings.site_name || 'TeleGrow'}!`;
      el('welcome-message').textContent =
        `Order real, high-quality engagement for Telegram, YouTube, Facebook, Instagram &amp; TikTok.\n\n` +
        (state.settings.ads_earning_enabled
          ? `💰 No balance? Watch ads to earn ${state.settings.currency_symbol}${money(state.settings.ad_reward)} per ad, up to ${state.settings.daily_ad_limit}/day.\n`
          : `💰 To add funds, use the "Contact Admin" button on the Funds tab.\n`) +
        `⚡ Orders are processed automatically where available, or reviewed by admin.\n` +
        `🔑 Use your personal API key on the Home tab to place orders programmatically.`;
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
