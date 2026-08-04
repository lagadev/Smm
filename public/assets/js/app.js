// =====================================================
// TeleGrow — Mini App front-end logic (v4)
// =====================================================
const API = ""; // same-origin Worker

const tg = window.Telegram ? window.Telegram.WebApp : null;

let state = {
  user: null,
  settings: {},
  categories: [],
  services: [],       // all active services (flat), used for search
  visibleServices: [],
  selectedService: null,
};

const el = (id) => document.getElementById(id);
function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(n){ return (Number(n)||0).toFixed(2); }
// Wallet balance always shows a full 8 decimals, e.g. 8.16583030
function formatBalance(n){ return (Number(n) || 0).toFixed(8); }
function formatOrderId(id){ return String(60000000 + Number(id)); }
function safeAlert(msg){ if(tg && tg.showAlert){ tg.showAlert(msg); } else { alert(msg); } }
function haptic(type){ try{ tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(type); }catch(e){} }
function safeTgOpen(link){ if (!link) return; if (tg && tg.openTelegramLink) tg.openTelegramLink(link); else window.open(link, '_blank'); }
function safeExternalOpen(link){ if (tg && tg.openLink) tg.openLink(link, { try_instant_view: false }); else window.open(link, '_blank'); }

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
  if (name === 'profile') { renderOrdersHistory(); renderTransactionsHistory(); }
}
function switchHistoryTab(tab) {
  document.querySelectorAll('#view-profile .pill').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  el('orders-history').classList.toggle('hidden', tab !== 'orders');
  el('funds-history').classList.toggle('hidden', tab !== 'funds');
}
function showModal(id){ el(id).style.display = 'flex'; }
function closeModal(id){ el(id).style.display = 'none'; }
window.onclick = (e) => { if (e.target.classList && e.target.classList.contains('modal')) closeModal(e.target.id); };

// ---------------- Auth ----------------
async function authenticate() {
  let body;
  if (tg && tg.initData) body = { initData: tg.initData };
  else body = { debugUser: { id: 999999, first_name: 'Guest', username: 'guest' } }; // dev/preview fallback
  const { user } = await api('/api/auth', { method: 'POST', body: JSON.stringify(body) });
  state.user = user;
}

// ---------------- Settings ----------------
async function loadSettings() {
  const { settings } = await api('/api/settings/public');
  state.settings = settings;
  const sym = settings.currency_symbol || '$';
  document.querySelectorAll('#currency-symbol, .currency-symbol').forEach(n => n.textContent = sym);
  el('ad-reward-label').textContent = `+${sym}${money(settings.ad_reward)} / ad`;
  el('ad-reward-copy').textContent = `Watch a short ad to earn ${sym}${money(settings.ad_reward)} instantly. Up to ${settings.daily_ad_limit} ads per day.`;
  el('preloader-channel-link').href = settings.channel_link || '#';

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

// ---------------- Force-join gate (silent check, only shows if actually missing) ----------------
async function runForceJoinGate() {
  const { enabled, channels } = await api('/api/force-join');
  if (!enabled || !channels.length) return true;

  // Silently verify first — if the user already joined everything, never show the gate at all.
  let verifyResult;
  try {
    verifyResult = await api('/api/verify-join', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id }) });
  } catch (e) {
    return true; // don't block the app if verification itself fails
  }
  if (verifyResult.joined) return true;

  el('fj-channel-list').innerHTML = channels.map(c => `
    <div class="fj-channel missing" data-username="${escapeHTML(c.username)}">
      <div class="fj-icon"><i class="${escapeHTML(c.icon || 'fa-brands fa-telegram')}"></i></div>
      <div class="fj-title">${escapeHTML(c.title)}<small>@${escapeHTML(c.username)}</small></div>
      <button class="btn btn-sm btn-outline" onclick="safeTgOpen('${(c.invite_link || ('https://t.me/' + c.username)).replace(/'/g,"\\'")}')">Join</button>
    </div>`).join('');
  el('force-join-gate').classList.remove('hidden');

  return new Promise((resolve) => {
    el('fj-verify-button').onclick = async () => {
      const btn = el('fj-verify-button');
      btn.querySelector('.button-text').classList.add('hidden');
      btn.querySelector('.spinner').classList.remove('hidden');
      el('fj-hint').textContent = '';
      try {
        const res = await api('/api/verify-join', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id }) });
        if (res.joined) {
          haptic('success');
          el('force-join-gate').classList.add('hidden');
          resolve(true);
        } else {
          haptic('error');
          el('fj-hint').textContent = `Please join: ${res.missing.map(m => m.title).join(', ')}`;
          document.querySelectorAll('.fj-channel').forEach(row => {
            const missing = res.missing.some(m => m.username === row.dataset.username);
            row.classList.toggle('missing', missing);
            row.classList.toggle('joined', !missing);
          });
        }
      } catch (e) {
        el('fj-hint').textContent = e.message;
      } finally {
        btn.querySelector('.button-text').classList.remove('hidden');
        btn.querySelector('.spinner').classList.add('hidden');
      }
    };
  });
}

// ---------------- Home ----------------
function updateBalanceUI(){ el('total-balance').textContent = formatBalance(state.user.balance); }

async function loadUserStats(){
  try{
    const { stats } = await api(`/api/user/stats?telegram_id=${state.user.telegram_id}`);
    const sym = state.settings.currency_symbol || '$';
    el('stat-orders').textContent = stats.total_orders;
    el('stat-spent').textContent = sym + money(stats.total_spent);
    el('stat-earned').textContent = sym + money(stats.total_earned);
  }catch(e){}
}

function updateTokenUI(){
  const token = state.user.api_token || '';
  const masked = token ? token.slice(0, 8) + '••••••••••••••••' : '—';
  el('api-token-display').textContent = masked;
}
function copyToken(){
  const token = state.user.api_token;
  if (!token) return;
  navigator.clipboard.writeText(token).then(() => safeAlert('API key copied!')).catch(() => safeAlert('Could not copy key.'));
}
async function regenerateToken(){
  const doIt = async () => {
    try{
      const { api_token } = await api('/api/user/regenerate-token', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id }) });
      state.user.api_token = api_token;
      updateTokenUI();
      haptic('success');
      safeAlert('New API key generated.');
    }catch(e){ safeAlert(e.message); }
  };
  if (tg && tg.showConfirm) tg.showConfirm('Regenerate your API key? The old key will stop working immediately.', (ok) => { if (ok) doIt(); });
  else if (confirm('Regenerate your API key? The old key will stop working immediately.')) doIt();
}

// ---------------- New Order ----------------
function renderCategorySelect(){
  const sel = el('category-select');
  sel.innerHTML = state.categories.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
  if (state.categories.length) loadServicesForCategory(state.categories[0].id);
}

async function loadServicesForCategory(categoryId){
  const { services } = await api(`/api/services?category_id=${categoryId}`);
  state.visibleServices = services;
  renderServiceOptions(services);
}

function renderServiceOptions(services){
  const sel = el('service-select');
  const sym = state.settings.currency_symbol || '$';
  sel.innerHTML = '<option value="">Select a service</option>' +
    services.map(s => `<option value="${s.public_id}">${s.public_id} - ${escapeHTML(s.name)} ~ ${sym}${money(s.rate)}/1000</option>`).join('');
  state.selectedService = null;
  el('service-detail-card').classList.add('hidden');
  clearOrderFields();
}

async function loadAllServicesForSearch(){
  const { services } = await api('/api/services');
  state.services = services;
}

function handleSearch(){
  const q = el('service-search').value.trim().toLowerCase();
  if (!q) { loadServicesForCategory(el('category-select').value); return; }
  const filtered = state.services.filter(s => s.name.toLowerCase().includes(q) || String(s.public_id).includes(q));
  renderServiceOptions(filtered);
}

function onCategoryChange(){
  el('service-search').value = '';
  loadServicesForCategory(el('category-select').value);
}

function onServiceChange(){
  const publicId = el('service-select').value;
  const pool = state.visibleServices.length ? state.visibleServices : state.services;
  state.selectedService = pool.find(s => String(s.public_id) === String(publicId)) || null;
  const s = state.selectedService;
  const card = el('service-detail-card');

  if (s){
    el('qty-hint').textContent = `Min: ${s.min_qty.toLocaleString()} - Max: ${s.max_qty.toLocaleString()}`;
    el('order-qty').placeholder = `Between ${s.min_qty} and ${s.max_qty}`;
    el('order-avgtime').value = s.avg_time || '—';

    const refillText = s.refill_days > 0 ? `${s.refill_days} Days` : 'No Refill';
    el('sdc-id').textContent = '#' + s.public_id;
    el('sdc-title').textContent = `${s.public_id} - ${s.name} ~ Max ${s.max_qty.toLocaleString()} ~ ${s.speed_info || ''} ~ ${s.start_type || ''} ~ ${refillText} ~ ${state.settings.currency_symbol}${money(s.rate)} per 1000`;
    el('sdc-link-type').textContent = s.link_type || '—';
    el('sdc-start').textContent = s.start_type || '—';
    el('sdc-speed').textContent = s.speed_info || '—';
    el('sdc-refill').textContent = refillText;
    el('sdc-desc').textContent = s.description || '—';
    el('sdc-desc-row').classList.toggle('hidden', !s.description);
    card.classList.remove('hidden');
  } else {
    el('qty-hint').textContent = 'Min: — · Max: —';
    el('order-avgtime').value = '—';
    card.classList.add('hidden');
  }
  recomputeCharge();
}

function recomputeCharge(){
  const s = state.selectedService;
  const qty = parseInt(el('order-qty').value, 10);
  const link = el('order-link').value.trim();
  const sym = state.settings.currency_symbol || '$';
  if (!s){ el('order-charge-field').value = ''; el('confirm-order-button').disabled = true; return; }

  let charge = 0, valid = false;
  if (Number.isFinite(qty) && qty >= s.min_qty && qty <= s.max_qty && /^https?:\/\//i.test(link)) {
    charge = Math.round((s.rate * qty / 1000) * 1e8) / 1e8;
    valid = true;
  }
  el('order-charge-field').value = valid ? `${sym}${charge.toFixed(8)}` : '';
  el('confirm-order-button').disabled = !valid;
}

function clearOrderFields(){
  el('order-link').value = '';
  el('order-qty').value = '';
  el('qty-hint').textContent = 'Min: — · Max: —';
  el('order-avgtime').value = '—';
  el('order-charge-field').value = '';
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
      body: JSON.stringify({ telegram_id: state.user.telegram_id, service: s.public_id, link, quantity: qty }),
    });
    state.user.balance = balance;
    updateBalanceUI();
    loadUserStats();
    haptic('success');
    safeAlert(`Order #${formatOrderId(order.id)} placed! ${state.settings.currency_symbol}${money(order.charge)} deducted from your wallet.`);
    clearOrderFields();
    el('service-detail-card').classList.add('hidden');
    el('service-select').value = '';
    state.selectedService = null;
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
      loadUserStats();
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

// ---------------- History (Profile tab) ----------------
function statusClass(s){ return (s || 'pending').toLowerCase(); }
function emptyState(icon, text){ return `<div class="empty-state"><i class="fa-solid ${icon}"></i><p>${escapeHTML(text)}</p></div>`; }

async function renderOrdersHistory(){
  try{
    const { orders } = await api(`/api/orders?telegram_id=${state.user.telegram_id}`);
    const wrap = el('orders-history');
    if (!orders.length){ wrap.innerHTML = emptyState('fa-bag-shopping', 'No orders yet'); return; }
    wrap.innerHTML = orders.map(o => {
      let refillHtml = '';
      if (o.refill_available) {
        if (o.refill_status === 'Pending') refillHtml = `<span class="status-badge processing" style="margin-top:6px;">Refill Pending</span>`;
        else if (o.refill_status === 'Completed') refillHtml = `<span class="status-badge completed" style="margin-top:6px;">Refill Completed</span>`;
        else if (o.status === 'Completed') refillHtml = `<button class="btn btn-sm btn-outline" style="margin-top:8px;" onclick="requestRefill(${o.id})">Refill</button>`;
      }
      return `
      <div class="history-item">
        <div class="history-details">
          <span class="name">#${o.service_public_id || '—'} ${escapeHTML(o.service_name)}</span>
          <span class="meta">Order #${formatOrderId(o.id)} · ${new Date(o.created_at).toLocaleDateString()} · Qty ${o.quantity.toLocaleString()}</span>
          <span class="meta" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;">${escapeHTML(o.link)}</span>
        </div>
        <div class="history-amount">
          <div class="amt">${state.settings.currency_symbol}${money(o.charge)}</div>
          <span class="status-badge ${statusClass(o.status)}">${escapeHTML(o.status)}</span>
          ${refillHtml}
        </div>
      </div>`;
    }).join('');
  }catch(e){}
}

async function requestRefill(orderId){
  try{
    await api('/api/order/refill', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id, order_id: orderId }) });
    haptic('success');
    safeAlert('Refill requested!');
    renderOrdersHistory();
  }catch(e){
    haptic('error');
    safeAlert(e.message);
  }
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

    await preloaderDone;
    hidePreloader();

    const joined = await runForceJoinGate();
    if (!joined) return;

    await bootApp();
  }catch(e){
    console.error(e);
    await preloaderDone;
    hidePreloader();
    safeAlert('Failed to load TeleGrow: ' + e.message);
  }
}

async function bootApp(){
  const { categories } = await api('/api/categories');
  state.categories = categories;
  await loadAllServicesForSearch();
  renderCategorySelect();

  updateBalanceUI();
  updateTokenUI();
  loadUserStats();

  const user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || { first_name: state.user.first_name, photo_url: state.user.photo_url };
  const initial = escapeHTML((user.first_name || 'U').charAt(0));
  if (user.photo_url) {
    el('profile-pic').innerHTML = `<img src="${user.photo_url}" alt="">`;
    el('profile-pic-lg').innerHTML = `<img src="${user.photo_url}" alt="">`;
  } else {
    el('profile-pic').innerHTML = `<span>${initial}</span>`;
    el('profile-pic-lg').innerHTML = `<span>${initial}</span>`;
  }
  el('profile-name').textContent = state.user.first_name || 'User';
  el('profile-id').textContent = 'ID: ' + state.user.telegram_id;

  el('category-select').addEventListener('change', onCategoryChange);
  el('service-select').addEventListener('change', onServiceChange);
  el('service-search').addEventListener('input', handleSearch);
  el('order-link').addEventListener('input', recomputeCharge);
  el('order-qty').addEventListener('input', recomputeCharge);
  el('confirm-order-button').addEventListener('click', confirmOrder);
  el('watch-ad-button').addEventListener('click', watchAd);
  el('copy-token-btn').addEventListener('click', copyToken);
  el('regen-token-btn').addEventListener('click', regenerateToken);
  el('contact-admin-fund-button').addEventListener('click', () => safeTgOpen(state.settings.support_link));
  el('api-docs-button').addEventListener('click', () => safeExternalOpen(window.location.origin + '/docs.html'));

  safeTgAction();

  // One-time welcome — flag is stored server-side (users.onboarded), so it truly shows only once ever.
  if (!state.user.onboarded) {
    el('welcome-title').textContent = `Welcome to ${state.settings.site_name || 'TeleGrow'}!`;
    el('welcome-message').textContent =
      `Order real, high-quality engagement for Telegram, YouTube, Facebook, Instagram &amp; TikTok.\n\n` +
      (state.settings.ads_earning_enabled
        ? `💰 No balance? Watch ads to earn ${state.settings.currency_symbol}${money(state.settings.ad_reward)} per ad, up to ${state.settings.daily_ad_limit}/day.\n`
        : `💰 To add funds, use the "Contact Admin" button on the Funds tab.\n`) +
      `⚡ Orders are placed automatically with our provider where available.\n` +
      `🔑 Find your personal API key and full docs under the Profile tab.`;
    showModal('welcomeModal');
    api('/api/user/mark-onboarded', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id }) }).catch(() => {});
  }
}

function safeTgAction(){
  if (!tg) return;
  try{ tg.ready(); tg.expand(); }catch(e){}
}

window.addEventListener('load', init);
