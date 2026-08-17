// =====================================================
// Mini App front-end logic (v7 / Beta)
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
let ordersPollTimer = null;
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  el('view-' + name).classList.remove('hidden');
  document.querySelectorAll('.nav-button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'profile') {
    renderOrdersHistory();
    renderTransactionsHistory();
    if (ordersPollTimer) clearInterval(ordersPollTimer);
    ordersPollTimer = setInterval(renderOrdersHistory, 15000); // near real-time refresh while this tab is open
  } else if (ordersPollTimer) {
    clearInterval(ordersPollTimer);
    ordersPollTimer = null;
  }
}
function switchHistoryTab(tab) {
  document.querySelectorAll('.history-tabs-row .pill').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  el('orders-history-controls').classList.toggle('hidden', tab !== 'orders');
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
  const sym = settings.currency_symbol || '৳';
  document.querySelectorAll('#currency-symbol, .currency-symbol').forEach(n => n.textContent = sym);
  document.querySelectorAll('.currency-unit').forEach(n => n.textContent = settings.currency || 'BDT');
  el('preloader-channel-link').href = settings.channel_link || '#';

  const siteName = settings.site_name || 'SMM API Center';
  document.title = siteName;
  el('brand-name-text').textContent = siteName;

  renderDepositPlans(settings.deposit_plans || []);
  el('payment-instructions-text').textContent = settings.payment_instructions || '';
}

function renderDepositPlans(plans){
  const sym = state.settings.currency_symbol || '৳';
  el('deposit-plans').innerHTML = plans.map((p, i) => `
    <button class="deposit-plan-card" data-index="${i}">
      <div class="dpc-amount">${sym}${p.amount}</div>
      ${p.bonus > 0 ? `<div class="dpc-bonus">+${sym}${p.bonus} bonus</div>` : `<div class="dpc-bonus dpc-bonus-none">No bonus</div>`}
      <div class="dpc-total">Get ${sym}${(p.amount + p.bonus).toFixed(2)}</div>
    </button>`).join('');
  document.querySelectorAll('.deposit-plan-card').forEach(btn => {
    btn.addEventListener('click', () => selectDepositPlan(plans[Number(btn.dataset.index)]));
  });
}

function selectDepositPlan(plan){
  const sym = state.settings.currency_symbol || '৳';
  document.querySelectorAll('.deposit-plan-card').forEach(b => b.classList.remove('selected'));
  const idx = (state.settings.deposit_plans || []).indexOf(plan);
  if (idx >= 0) document.querySelectorAll('.deposit-plan-card')[idx]?.classList.add('selected');
  el('payment-instructions-card').classList.remove('hidden');
  el('payment-instructions-text').textContent =
    `Plan selected: ${sym}${plan.amount}${plan.bonus > 0 ? ' + ' + sym + plan.bonus + ' bonus' : ''} = ${sym}${(plan.amount + plan.bonus).toFixed(2)} total. ` +
    (state.settings.payment_instructions || '') + ' Then tap "Contact Admin to Add Funds" below with your payment proof.';
  el('payment-instructions-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
function updateBalanceUI(){
  const formatted = formatBalance(state.user.balance);
  el('total-balance').textContent = formatted;
  document.querySelectorAll('.total-balance-mirror').forEach(n => n.textContent = formatted);
}

async function loadUserStats(){
  try{
    const { stats } = await api(`/api/user/stats?telegram_id=${state.user.telegram_id}`);
    const sym = state.settings.currency_symbol || '$';
    el('stat-orders').textContent = stats.total_orders;
    el('stat-spent').textContent = sym + formatBalance(stats.total_spent);
    el('stat-earned').textContent = sym + formatBalance(stats.total_earned);
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
    services.map(s => `<option value="${s.public_id}">${s.public_id} - ${escapeHTML(s.name)} ~ ${sym}${formatBalance(s.rate)}/1000</option>`).join('');
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
    el('sdc-title').textContent = `${s.public_id} - ${s.name} ~ Max ${s.max_qty.toLocaleString()} ~ ${s.speed_info || ''} ~ ${s.start_type || ''} ~ ${refillText} ~ ${state.settings.currency_symbol}${formatBalance(s.rate)} per 1000`;
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
    safeAlert(`Order #${order.id} placed! ${state.settings.currency_symbol}${formatBalance(order.charge)} deducted from your wallet.`);
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

// ---------------- Promo code ----------------
async function applyPromoCode(){
  const input = el('promo-code-input');
  const code = input.value.trim();
  if (!code) return;
  const btn = el('apply-promo-button');
  btn.disabled = true;
  btn.querySelector('.button-text').classList.add('hidden');
  btn.querySelector('.spinner').classList.remove('hidden');
  try{
    const res = await api('/api/promo/redeem', { method: 'POST', body: JSON.stringify({ telegram_id: state.user.telegram_id, code }) });
    state.user.balance = res.balance;
    updateBalanceUI();
    loadUserStats();
    haptic('success');
    safeAlert(`+${state.settings.currency_symbol}${formatBalance(res.reward)} added! Promo code applied successfully.`);
    input.value = '';
  }catch(e){
    haptic('error');
    safeAlert(e.message);
  }finally{
    btn.disabled = false;
    btn.querySelector('.button-text').classList.remove('hidden');
    btn.querySelector('.spinner').classList.add('hidden');
  }
}

// ---------------- In-app API docs ----------------
let docsLoaded = false;
async function openDocsInApp(){
  switchView('docs');
  if (docsLoaded) return;
  try{
    const res = await fetch('docs.html?v=6');
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelector('.docs-header')?.remove(); // we render our own Back button instead
    el('docs-content').outerHTML = `<div id="docs-content">${doc.body.innerHTML}</div>`;
    docsLoaded = true;
    // Re-run the inline script that fills in the live API URL (module scripts in fetched HTML don't auto-execute).
    const base = window.location.origin + '/api/v2';
    const apiUrlEl = document.getElementById('api-url');
    const phpUrlEl = document.getElementById('php-url');
    if (apiUrlEl) apiUrlEl.textContent = base;
    if (phpUrlEl) phpUrlEl.textContent = base;
  }catch(e){
    el('docs-content').innerHTML = `<p class="card-sub">Could not load documentation: ${escapeHTML(e.message)}</p>`;
  }
}

// ---------------- History (Profile tab) ----------------
function statusClass(s){ return (s || 'pending').toLowerCase(); }
function emptyState(icon, text){ return `<div class="empty-state"><i class="fa-solid ${icon}"></i><p>${escapeHTML(text)}</p></div>`; }

let allOrders = [];
let orderStatusFilter = 'all';

async function renderOrdersHistory(){
  try{
    const { orders } = await api(`/api/orders?telegram_id=${state.user.telegram_id}`);
    allOrders = orders;
    renderFilteredOrders();
  }catch(e){}
}

function renderFilteredOrders(){
  const q = (el('order-search-input').value || '').trim().toLowerCase();
  let list = allOrders;
  if (orderStatusFilter !== 'all') list = list.filter(o => o.status === orderStatusFilter);
  if (q) list = list.filter(o => String(o.id).includes(q) || o.service_name.toLowerCase().includes(q) || String(o.service_public_id || '').includes(q));

  const wrap = el('orders-history');
  if (!list.length){ wrap.innerHTML = emptyState('fa-bag-shopping', allOrders.length ? 'No orders match your search' : 'No orders yet'); return; }

  wrap.innerHTML = list.map(o => {
    let refillHtml = '';
    if (o.refill_available) {
      if (o.refill_status === 'Pending') refillHtml = `<span class="status-badge processing">Refill Pending</span>`;
      else if (o.refill_status === 'Completed') refillHtml = `<span class="status-badge completed">Refill Completed</span>`;
      else if (o.status === 'Completed') refillHtml = `<button class="btn btn-sm btn-outline" onclick="requestRefill(${o.id})">Refill</button>`;
    }
    return `
    <div class="order-card">
      <div class="order-card-top">
        <span class="order-card-service">#${o.service_public_id || '—'} ${escapeHTML(o.service_name)}</span>
        <span class="status-badge ${statusClass(o.status)}">${escapeHTML(o.status)}</span>
      </div>
      <div class="order-card-grid">
        <div class="ocg-field"><span class="ocg-label">Order ID</span><span class="ocg-value">#${o.id}</span></div>
        <div class="ocg-field"><span class="ocg-label">Date</span><span class="ocg-value">${new Date(o.created_at).toLocaleDateString()}</span></div>
        <div class="ocg-field"><span class="ocg-label">Quantity</span><span class="ocg-value">${o.quantity.toLocaleString()}</span></div>
        <div class="ocg-field"><span class="ocg-label">Charge</span><span class="ocg-value">${state.settings.currency_symbol}${formatBalance(o.charge)}</span></div>
        <div class="ocg-field"><span class="ocg-label">Start Count</span><span class="ocg-value">${o.start_count ?? '-'}</span></div>
        <div class="ocg-field"><span class="ocg-label">Remains</span><span class="ocg-value">${o.remains ?? '-'}</span></div>
      </div>
      <div class="ocg-field ocg-link"><span class="ocg-label">Link</span><span class="ocg-value ocg-link-value">${escapeHTML(o.link)}</span></div>
      ${refillHtml ? `<div class="order-card-actions">${refillHtml}</div>` : ''}
    </div>`;
  }).join('');
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
    const labels = { order: 'Order Charge', admin_add: 'Admin Credit', admin_deduct: 'Admin Debit', promo: 'Promo Code', deposit: 'Deposit' };
    wrap.innerHTML = transactions.map(t => `
      <div class="history-item">
        <div class="history-details">
          <span class="name">${escapeHTML(labels[t.type] || t.type)}</span>
          <span class="meta">${new Date(t.created_at).toLocaleString()}${t.note ? ' · ' + escapeHTML(t.note) : ''}</span>
        </div>
        <div class="history-amount">
          <div class="amt" style="color:${t.amount >= 0 ? 'var(--success)' : 'var(--danger)'};">${t.amount >= 0 ? '+' : ''}${state.settings.currency_symbol}${formatBalance(t.amount)}</div>
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
    safeAlert('Failed to load the app: ' + e.message);
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
  el('copy-token-btn').addEventListener('click', copyToken);
  el('regen-token-btn').addEventListener('click', regenerateToken);
  el('contact-admin-fund-button').addEventListener('click', () => safeTgOpen(state.settings.support_link));
  el('api-docs-button').addEventListener('click', openDocsInApp);
  el('apply-promo-button').addEventListener('click', applyPromoCode);
  el('order-search-input').addEventListener('input', renderFilteredOrders);
  document.querySelectorAll('#order-status-filter .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#order-status-filter .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      orderStatusFilter = btn.dataset.status;
      renderFilteredOrders();
    });
  });

  safeTgAction();

  // One-time welcome — flag is stored server-side (users.onboarded), so it truly shows only once ever.
  if (!state.user.onboarded) {
    el('welcome-title').textContent = `Welcome to ${state.settings.site_name || 'SMM API Center'}!`;
    el('welcome-message').textContent =
      `Order real, high-quality engagement for Telegram, YouTube, Facebook, Instagram &amp; TikTok.\n\n` +
      `💰 Add funds anytime from the Funds tab — pick a deposit plan and contact admin to confirm.\n` +
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
