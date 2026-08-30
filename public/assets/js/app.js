// =====================================================
// Mini App front-end logic (v8)
// =====================================================
const API = ""; // same-origin Worker

const tg = window.Telegram ? window.Telegram.WebApp : null;

let state = {
  user: null,
  settings: {},
  platforms: [],
  categories: [],       // categories for the selected platform
  services: [],          // all active services (flat), used for search
  visibleServices: [],   // services for the selected category
  selectedPlatform: null,
  selectedCategory: null,
  selectedService: null,
  paymentMethods: [],
  fundsAmount: 0,
  fundsMethod: null,
};

const el = (id) => document.getElementById(id);
function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function formatBalance(n){ return (Number(n) || 0).toFixed(8); }
function safeAlert(msg){ if(tg && tg.showAlert){ tg.showAlert(msg); } else { alert(msg); } }
function haptic(type){ try{ tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(type); }catch(e){} }
function safeTgOpen(link){ if (!link) return; if (tg && tg.openTelegramLink) tg.openTelegramLink(link); else window.open(link, '_blank'); }

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
    ordersPollTimer = setInterval(renderOrdersHistory, 15000);
  } else if (ordersPollTimer) {
    clearInterval(ordersPollTimer);
    ordersPollTimer = null;
  }
  if (name === 'funds') renderDepositRequests();
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
  else body = { debugUser: { id: 999999, first_name: 'Guest', username: 'guest' } };
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
  el('funds-currency-sym').textContent = sym;
  el('preloader-channel-link').href = settings.channel_link || '#';

  const siteName = settings.site_name || 'SMM API Center';
  document.title = siteName;
  el('brand-name-text').textContent = siteName;
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

// ---------------- New Order: Platform grid ----------------
function renderPlatformGrid(){
  const grid = el('platform-grid');
  grid.innerHTML = state.platforms.map(p => `
    <button type="button" class="platform-item" data-id="${p.id}" title="${escapeHTML(p.name)}">
      <i class="${escapeHTML(p.icon || 'fa-solid fa-star')}"></i>
    </button>`).join('');
  grid.querySelectorAll('.platform-item').forEach(btn => {
    btn.addEventListener('click', () => selectPlatform(Number(btn.dataset.id)));
  });
}

async function selectPlatform(platformId){
  state.selectedPlatform = state.platforms.find(p => p.id === platformId) || null;
  document.querySelectorAll('.platform-item').forEach(b => b.classList.toggle('selected', Number(b.dataset.id) === platformId));

  const { categories } = await api(`/api/categories?platform_id=${platformId}`);
  state.categories = categories;
  state.selectedCategory = null;
  state.selectedService = null;
  el('category-dd-header').disabled = false;
  setDropdownHeader('category', null);
  setDropdownHeader('service', null, 'Select a category first');
  el('service-dd-header').disabled = true;
  renderCategoryDropdownList();
  el('service-detail-card').classList.add('hidden');
  clearOrderFields();
}

// ---------------- Custom dropdowns ----------------
function toggleDropdown(name, forceState){
  const dd = el(name + '-dd');
  const list = el(name + '-dd-list');
  const isOpen = forceState != null ? forceState : list.classList.contains('hidden');
  document.querySelectorAll('.dd-list').forEach(l => { if (l !== list) l.classList.add('hidden'); });
  document.querySelectorAll('.dd').forEach(d => { if (d !== dd) d.classList.remove('open'); });
  list.classList.toggle('hidden', !isOpen);
  dd.classList.toggle('open', isOpen);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dd')) {
    document.querySelectorAll('.dd-list').forEach(l => l.classList.add('hidden'));
    document.querySelectorAll('.dd').forEach(d => d.classList.remove('open'));
  }
});

function setDropdownHeader(name, html, placeholder){
  const content = el(name + '-dd-header').querySelector('.dd-header-content');
  content.innerHTML = html || `<span class="dd-placeholder">${escapeHTML(placeholder || 'Select an option')}</span>`;
}

function renderCategoryDropdownList(){
  const list = el('category-dd-list');
  if (!state.categories.length) { list.innerHTML = `<div class="dd-empty">No categories for this platform yet</div>`; }
  else {
    list.innerHTML = state.categories.map(c => `
      <div class="dd-item" data-id="${c.id}">
        <div class="dd-icon"><i class="${escapeHTML(c.icon || state.selectedPlatform.icon)}"></i></div>
        <div class="dd-item-text">${escapeHTML(c.name)}</div>
        ${c.tag ? `<span class="dd-tag">${escapeHTML(c.tag)}</span>` : ''}
      </div>`).join('');
  }
  list.querySelectorAll('.dd-item').forEach(item => {
    item.addEventListener('click', () => selectCategory(Number(item.dataset.id)));
  });
  el('category-dd-header').onclick = () => toggleDropdown('category');
}

async function selectCategory(categoryId){
  state.selectedCategory = state.categories.find(c => c.id === categoryId) || null;
  toggleDropdown('category', false);
  document.querySelectorAll('#category-dd-list .dd-item').forEach(i => i.classList.toggle('selected', Number(i.dataset.id) === categoryId));

  const c = state.selectedCategory;
  setDropdownHeader('category', `
    <div class="dd-icon"><i class="${escapeHTML(c.icon || state.selectedPlatform.icon)}"></i></div>
    <span class="dd-text">${escapeHTML(c.name)}</span>`);

  const { services } = await api(`/api/services?category_id=${categoryId}`);
  state.visibleServices = services;
  state.selectedService = null;
  el('service-dd-header').disabled = false;
  setDropdownHeader('service', null);
  renderServiceDropdownList(services);
  el('service-detail-card').classList.add('hidden');
  clearOrderFields();
}

function renderServiceDropdownList(services){
  const list = el('service-dd-list');
  const sym = state.settings.currency_symbol || '$';
  if (!services.length) { list.innerHTML = `<div class="dd-empty">No services in this category yet</div>`; }
  else {
    list.innerHTML = services.map(s => `
      <div class="dd-item" data-id="${s.public_id}">
        <span class="dd-badge">${s.public_id}</span>
        <div class="dd-item-text">${escapeHTML(s.name)} ~ ${sym}${formatBalance(s.rate)}/1000</div>
      </div>`).join('');
  }
  list.querySelectorAll('.dd-item').forEach(item => {
    item.addEventListener('click', () => selectService(item.dataset.id));
  });
  el('service-dd-header').onclick = () => toggleDropdown('service');
}

function selectService(publicId){
  const pool = state.visibleServices.length ? state.visibleServices : state.services;
  state.selectedService = pool.find(s => String(s.public_id) === String(publicId)) || null;
  toggleDropdown('service', false);
  document.querySelectorAll('#service-dd-list .dd-item').forEach(i => i.classList.toggle('selected', String(i.dataset.id) === String(publicId)));

  const s = state.selectedService;
  const card = el('service-detail-card');
  const sym = state.settings.currency_symbol || '$';

  if (s){
    setDropdownHeader('service', `<span class="dd-badge">${s.public_id}</span><span class="dd-text">${escapeHTML(s.name)}</span>`);
    el('qty-hint').textContent = `Min: ${s.min_qty.toLocaleString()} - Max: ${s.max_qty.toLocaleString()}`;
    el('order-qty').placeholder = `Between ${s.min_qty} and ${s.max_qty}`;
    el('order-avgtime').value = s.avg_time || '—';

    const refillText = s.refill_days > 0 ? `${s.refill_days} Days` : 'No Refill';
    el('sdc-id').textContent = '#' + s.public_id;
    el('sdc-title').textContent = `${s.public_id} - ${s.name} ~ Max ${s.max_qty.toLocaleString()} ~ ${s.speed_info || ''} ~ ${s.start_type || ''} ~ ${refillText} ~ ${sym}${formatBalance(s.rate)} per 1000`;
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

// ---------------- Direct search (bypasses platform/category pickers) ----------------
async function loadAllServicesForSearch(){
  const { services } = await api('/api/services');
  state.services = services;
}
function handleSearch(){
  const q = el('service-search').value.trim().toLowerCase();
  if (!q) return;
  const filtered = state.services.filter(s => s.name.toLowerCase().includes(q) || String(s.public_id).includes(q));
  el('service-dd-header').disabled = false;
  state.visibleServices = filtered;
  renderServiceDropdownList(filtered);
  toggleDropdown('service', true);
}

// ---------------- Charge / submit ----------------
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
  }catch(e){
    haptic('error');
    safeAlert(e.message);
  }finally{
    btn.disabled = false;
    btn.querySelector('.button-text').classList.remove('hidden');
    btn.querySelector('.spinner').classList.add('hidden');
  }
}

// ---------------- Add Funds — unique amount -> method -> reference flow ----------------
function fundsGoStep(n){
  [1,2,3].forEach(i => {
    el('funds-step-' + i).classList.toggle('hidden', i !== n);
    el('fs-dot-' + i).classList.toggle('active', i === n);
    el('fs-dot-' + i).classList.toggle('done', i < n);
  });
}

function renderFundsChips(){
  const amounts = state.settings.deposit_quick_amounts && state.settings.deposit_quick_amounts.length
    ? state.settings.deposit_quick_amounts : [500, 1000, 2000, 5000, 10000];
  const sym = state.settings.currency_symbol || '৳';
  el('funds-amount-chips').innerHTML = amounts.map(a => `<button type="button" class="amount-chip" data-amt="${a}">${sym}${a}</button>`).join('');
  el('funds-amount-chips').querySelectorAll('.amount-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      el('funds-amount-input').value = chip.dataset.amt;
      onFundsAmountInput();
    });
  });
}
function onFundsAmountInput(){
  const val = parseFloat(el('funds-amount-input').value);
  state.fundsAmount = Number.isFinite(val) && val > 0 ? val : 0;
  el('funds-step1-next').disabled = state.fundsAmount <= 0;
  document.querySelectorAll('.amount-chip').forEach(c => c.classList.toggle('active', Number(c.dataset.amt) === state.fundsAmount));
}

async function loadPaymentMethods(){
  const { methods } = await api('/api/deposit/methods');
  state.paymentMethods = methods;
}
function renderFundsMethods(){
  const grid = el('funds-method-grid');
  if (!state.paymentMethods.length) {
    grid.innerHTML = `<div class="dd-empty" style="grid-column:1/-1;">No payment methods configured yet — ask the admin to add one.</div>`;
    return;
  }
  grid.innerHTML = state.paymentMethods.map(m => `
    <div class="method-card" data-id="${m.id}">
      <div class="m-icon"><i class="${escapeHTML(m.icon || 'fa-solid fa-wallet')}"></i></div>
      <div class="m-name">${escapeHTML(m.name)}</div>
    </div>`).join('');
  grid.querySelectorAll('.method-card').forEach(c => {
    c.addEventListener('click', () => {
      state.fundsMethod = state.paymentMethods.find(m => m.id === Number(c.dataset.id));
      grid.querySelectorAll('.method-card').forEach(x => x.classList.toggle('selected', x === c));
      el('funds-step2-next').disabled = false;
    });
  });
}

async function submitDepositRequest(){
  if (!state.fundsMethod || state.fundsAmount <= 0) return;
  const btn = el('funds-step2-next');
  btn.disabled = true;
  btn.querySelector('.button-text').classList.add('hidden');
  btn.querySelector('.spinner').classList.remove('hidden');
  try{
    const { request } = await api('/api/deposit/request', {
      method: 'POST',
      body: JSON.stringify({ telegram_id: state.user.telegram_id, method_id: state.fundsMethod.id, amount: state.fundsAmount }),
    });
    const sym = state.settings.currency_symbol || '৳';
    el('funds-ref-code').textContent = request.reference_code;
    el('funds-summary-amount').textContent = sym + Number(state.fundsAmount).toLocaleString();
    el('funds-summary-method').textContent = state.fundsMethod.name;
    el('funds-instructions').textContent =
      (state.fundsMethod.account_info ? `Send to: ${state.fundsMethod.account_info}\n\n` : '') +
      (state.fundsMethod.instructions || 'Include your reference code in the payment note, then wait for admin approval.');
    fundsGoStep(3);
    haptic('success');
    renderDepositRequests();
  }catch(e){
    haptic('error');
    safeAlert(e.message);
  }finally{
    btn.disabled = false;
    btn.querySelector('.button-text').classList.remove('hidden');
    btn.querySelector('.spinner').classList.add('hidden');
  }
}

function fundsReset(){
  state.fundsAmount = 0;
  state.fundsMethod = null;
  el('funds-amount-input').value = '';
  document.querySelectorAll('.amount-chip').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.method-card').forEach(c => c.classList.remove('selected'));
  el('funds-step1-next').disabled = true;
  el('funds-step2-next').disabled = true;
  fundsGoStep(1);
}

function copyRefCode(){
  const code = el('funds-ref-code').textContent;
  navigator.clipboard.writeText(code).then(() => safeAlert('Reference code copied!')).catch(() => {});
}

async function renderDepositRequests(){
  try{
    const { requests } = await api(`/api/deposit/requests?telegram_id=${state.user.telegram_id}`);
    const wrap = el('deposit-requests-list');
    if (!requests.length){ wrap.innerHTML = emptyState('fa-sack-dollar', 'No deposit requests yet'); return; }
    const sym = state.settings.currency_symbol || '৳';
    wrap.innerHTML = requests.map(r => `
      <div class="history-item">
        <div class="history-details">
          <span class="name">${escapeHTML(r.reference_code)}</span>
          <span class="meta">${escapeHTML(r.method_name)} · ${new Date(r.created_at).toLocaleString()}</span>
        </div>
        <div class="history-amount">
          <div class="amt">${sym}${Number(r.amount).toLocaleString()}</div>
          <span class="status-badge ${r.status.toLowerCase()}">${escapeHTML(r.status)}</span>
        </div>
      </div>`).join('');
  }catch(e){}
}

// ---------------- In-app API docs (generated inline — no extra file) ----------------
function renderDocsHtml(){
  const base = window.location.origin + '/api/v2';
  return `
  <div class="toc">
    <a href="#api">API</a><a href="#services">Service List</a><a href="#add">Add Order</a>
    <a href="#status">Order Status</a><a href="#refill">Refill</a><a href="#refillstatus">Refill Status</a>
    <a href="#cancel">Cancel</a><a href="#balance">Balance</a>
  </div>

  <h2 class="section-title" id="api"><i class="fa-solid fa-plug"></i> API</h2>
  <table class="doc-table">
    <tr><th>HTTP Method</th><td>POST</td></tr>
    <tr><th>API URL</th><td>${escapeHTML(base)}</td></tr>
    <tr><th>API Key</th><td>Get your key on the <strong>Profile</strong> tab</td></tr>
    <tr><th>Return format</th><td>JSON</td></tr>
  </table>

  <h2 class="section-title" id="services"><i class="fa-solid fa-list"></i> Service List</h2>
  <table class="doc-table"><tr><th>Parameter</th><th>Description</th></tr><tr><td>key</td><td>Your API key</td></tr><tr><td>action</td><td>services</td></tr></table>
  <div class="code-block">[
  { <span class="k">"service"</span>: 100001, <span class="k">"name"</span>: <span class="s">"TikTok Likes USA"</span>, <span class="k">"category"</span>: <span class="s">"TikTok - Likes [ USA ]"</span>, <span class="k">"platform"</span>: <span class="s">"TikTok"</span>, <span class="k">"rate"</span>: <span class="s">"18.11"</span>, <span class="k">"min"</span>: <span class="s">"100"</span>, <span class="k">"max"</span>: <span class="s">"100000"</span>, <span class="k">"refill"</span>: false, <span class="k">"cancel"</span>: true }
]</div>

  <h2 class="section-title" id="add"><i class="fa-solid fa-bolt"></i> Add Order</h2>
  <table class="doc-table"><tr><th>Parameter</th><th>Description</th></tr><tr><td>key</td><td>Your API key</td></tr><tr><td>action</td><td>add</td></tr><tr><td>service</td><td>Service ID</td></tr><tr><td>link</td><td>Link to page</td></tr><tr><td>quantity</td><td>Needed quantity</td></tr></table>
  <div class="code-block">{ <span class="k">"order"</span>: 23501 }</div>

  <h2 class="section-title" id="status"><i class="fa-solid fa-magnifying-glass"></i> Order Status</h2>
  <table class="doc-table"><tr><th>Parameter</th><th>Description</th></tr><tr><td>key</td><td>Your API key</td></tr><tr><td>action</td><td>status</td></tr><tr><td>order / orders</td><td>Single ID, or comma-separated up to 100</td></tr></table>
  <div class="code-block">{ <span class="k">"charge"</span>: <span class="s">"0.27819"</span>, <span class="k">"start_count"</span>: <span class="s">"3572"</span>, <span class="k">"status"</span>: <span class="s">"Partial"</span>, <span class="k">"remains"</span>: <span class="s">"157"</span>, <span class="k">"currency"</span>: <span class="s">"BDT"</span> }</div>

  <h2 class="section-title" id="refill"><i class="fa-solid fa-rotate"></i> Create Refill</h2>
  <table class="doc-table"><tr><th>Parameter</th><th>Description</th></tr><tr><td>key</td><td>Your API key</td></tr><tr><td>action</td><td>refill</td></tr><tr><td>order / orders</td><td>Single ID, or comma-separated up to 100</td></tr></table>
  <div class="code-block">{ <span class="k">"refill"</span>: <span class="s">"1"</span> }</div>

  <h2 class="section-title" id="refillstatus"><i class="fa-solid fa-clipboard-check"></i> Refill Status</h2>
  <table class="doc-table"><tr><th>Parameter</th><th>Description</th></tr><tr><td>key</td><td>Your API key</td></tr><tr><td>action</td><td>refill_status</td></tr><tr><td>refill / refills</td><td>Single ID, or comma-separated up to 100</td></tr></table>
  <div class="code-block">{ <span class="k">"status"</span>: <span class="s">"Completed"</span> }</div>

  <h2 class="section-title" id="cancel"><i class="fa-solid fa-ban"></i> Create Cancel</h2>
  <table class="doc-table"><tr><th>Parameter</th><th>Description</th></tr><tr><td>key</td><td>Your API key</td></tr><tr><td>action</td><td>cancel</td></tr><tr><td>orders</td><td>Order IDs, comma-separated (up to 100)</td></tr></table>
  <div class="code-block">{ <span class="k">"2"</span>: { <span class="k">"order"</span>: 2, <span class="k">"cancel"</span>: 1 } }</div>

  <h2 class="section-title" id="balance"><i class="fa-solid fa-wallet"></i> User Balance</h2>
  <table class="doc-table"><tr><th>Parameter</th><th>Description</th></tr><tr><td>key</td><td>Your API key</td></tr><tr><td>action</td><td>balance</td></tr></table>
  <div class="code-block">{ <span class="k">"balance"</span>: <span class="s">"100.84"</span>, <span class="k">"currency"</span>: <span class="s">"BDT"</span> }</div>

  <p class="doc-note">All errors are returned as <code>{"error": "message"}</code> with HTTP 200, matching common SMM-panel API conventions.</p>`;
}
function openDocsInApp(){
  switchView('docs');
  el('docs-content').innerHTML = renderDocsHtml();
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
    const labels = { order: 'Order Charge', admin_add: 'Admin Credit', admin_deduct: 'Admin Debit', deposit: 'Deposit' };
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
    await bootApp();
  }catch(e){
    console.error(e);
    await preloaderDone;
    hidePreloader();
    safeAlert('Failed to load the app: ' + e.message);
  }
}

async function bootApp(){
  const { platforms } = await api('/api/platforms');
  state.platforms = platforms;
  renderPlatformGrid();
  await loadAllServicesForSearch();
  await loadPaymentMethods();
  renderFundsChips();
  renderFundsMethods();

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

  el('service-search').addEventListener('input', handleSearch);
  el('order-link').addEventListener('input', recomputeCharge);
  el('order-qty').addEventListener('input', recomputeCharge);
  el('confirm-order-button').addEventListener('click', confirmOrder);
  el('copy-token-btn').addEventListener('click', copyToken);
  el('regen-token-btn').addEventListener('click', regenerateToken);
  el('api-docs-button').addEventListener('click', openDocsInApp);
  el('order-search-input').addEventListener('input', renderFilteredOrders);
  document.querySelectorAll('#order-status-filter .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#order-status-filter .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      orderStatusFilter = btn.dataset.status;
      renderFilteredOrders();
    });
  });

  el('funds-amount-input').addEventListener('input', onFundsAmountInput);
  el('funds-step1-next').addEventListener('click', () => fundsGoStep(2));
  el('funds-step2-next').addEventListener('click', submitDepositRequest);
  el('funds-copy-ref').addEventListener('click', copyRefCode);

  safeTgAction();

  if (!state.user.onboarded) {
    el('welcome-title').textContent = `Welcome to ${state.settings.site_name || 'SMM API Center'}!`;
    el('welcome-message').textContent =
      `Order real, high-quality engagement across TikTok, Instagram, YouTube, Facebook, Telegram &amp; more.\n\n` +
      `💰 Add funds anytime from the Funds tab — pick a method, get your reference code, and our admin will confirm it.\n` +
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
