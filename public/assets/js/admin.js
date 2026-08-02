// =====================================================
// TeleGrow — Admin panel logic
// =====================================================
const API_BASE = window.location.origin; // API is same-origin; admin page lives one level deep

const el = (id) => document.getElementById(id);
function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(n){ return (Number(n)||0).toFixed(2); }

let ADMIN_PASSWORD = sessionStorage.getItem('tg_admin_pw') || '';
let cache = { categories: [], services: [], settings: {} };

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", "X-Admin-Password": ADMIN_PASSWORD, ...(opts.headers || {}) };
  const res = await fetch(API_BASE + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- Login ----------------
async function tryLogin(){
  const pw = el('login-password').value.trim();
  if (!pw) return;
  const btn = el('login-button');
  btn.querySelector('.button-text').classList.add('hidden');
  btn.querySelector('.spinner').classList.remove('hidden');
  el('login-error').style.display = 'none';
  try{
    await api('/api/admin/login', { method: 'POST', headers: { 'X-Admin-Password': '' }, body: JSON.stringify({ password: pw }) });
    ADMIN_PASSWORD = pw;
    sessionStorage.setItem('tg_admin_pw', pw);
    enterShell();
  }catch(e){
    el('login-error').style.display = 'block';
  }finally{
    btn.querySelector('.button-text').classList.remove('hidden');
    btn.querySelector('.spinner').classList.add('hidden');
  }
}

function logout(){
  sessionStorage.removeItem('tg_admin_pw');
  ADMIN_PASSWORD = '';
  el('admin-shell').classList.add('hidden');
  el('admin-login').classList.remove('hidden');
}

async function enterShell(){
  el('admin-login').classList.add('hidden');
  el('admin-shell').classList.remove('hidden');
  await refreshAll();
}

// ---------------- Tabs ----------------
const TAB_TITLES = {
  dashboard: ['Dashboard', 'Overview of your TeleGrow panel'],
  categories: ['Categories', 'Manage service categories'],
  services: ['Services', 'Manage the services users can order'],
  orders: ['Orders', 'Review and update customer orders'],
  users: ['Users', 'Manage user balances and access'],
  settings: ['Settings', 'Configure bot, ads and rewards'],
};

function switchTab(tab){
  document.querySelectorAll('.side-link[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + tab));
  el('page-title').textContent = TAB_TITLES[tab][0];
  el('page-sub').textContent = TAB_TITLES[tab][1];
  el('sidebar').classList.remove('open');
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'categories') loadCategories();
  if (tab === 'services') loadServices();
  if (tab === 'orders') loadOrders();
  if (tab === 'users') loadUsers();
  if (tab === 'settings') loadSettings();
}

function showModal(id){ el(id).style.display = 'flex'; }
function closeModal(id){ el(id).style.display = 'none'; }
window.onclick = (e) => { if (e.target.classList && e.target.classList.contains('modal')) closeModal(e.target.id); };

// ---------------- Dashboard ----------------
async function loadDashboard(){
  const { stats } = await api('/api/admin/stats');
  el('stat-users').textContent = stats.total_users;
  el('stat-orders').textContent = stats.total_orders;
  el('stat-pending').textContent = stats.pending_orders;
  el('stat-revenue').textContent = '৳' + money(stats.total_revenue);
  el('stat-liability').textContent = '৳' + money(stats.total_user_balance);

  const { orders } = await api('/api/admin/orders');
  const tbody = document.querySelector('#recent-orders-table tbody');
  tbody.innerHTML = orders.slice(0, 8).map(o => `
    <tr>
      <td>#${o.id}</td>
      <td>${escapeHTML(o.first_name)} (${escapeHTML(o.telegram_id)})</td>
      <td>${escapeHTML(o.service_name)}</td>
      <td>৳${money(o.charge)}</td>
      <td><span class="badge ${o.status === 'Completed' ? 'active' : 'inactive'}">${escapeHTML(o.status)}</span></td>
      <td>${new Date(o.created_at).toLocaleDateString()}</td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">No orders yet</td></tr>`;
}

// ---------------- Categories ----------------
async function loadCategories(){
  const { categories } = await api('/api/admin/categories');
  cache.categories = categories;
  const tbody = document.querySelector('#categories-table tbody');
  tbody.innerHTML = categories.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${escapeHTML(c.name)}</td>
      <td><i class="${escapeHTML(c.icon || '')}"></i> <code style="font-size:11px;color:var(--text-dim);">${escapeHTML(c.icon || '')}</code></td>
      <td>${c.sort_order}</td>
      <td><span class="badge ${c.status === 'active' ? 'active' : 'inactive'}">${c.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editCategory(${c.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deleteCategory(${c.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">No categories yet</td></tr>`;
}

function openAddCategory(){
  el('category-modal-title').textContent = 'Add Category';
  el('category-id').value = '';
  el('category-name').value = '';
  el('category-icon').value = 'fa-solid fa-layer-group';
  el('category-sort').value = 0;
  el('category-status').value = 'active';
  showModal('categoryModal');
}
function editCategory(id){
  const c = cache.categories.find(x => x.id === id);
  if (!c) return;
  el('category-modal-title').textContent = 'Edit Category';
  el('category-id').value = c.id;
  el('category-name').value = c.name;
  el('category-icon').value = c.icon || '';
  el('category-sort').value = c.sort_order;
  el('category-status').value = c.status;
  showModal('categoryModal');
}
async function saveCategory(){
  const id = el('category-id').value;
  const payload = {
    name: el('category-name').value.trim(),
    icon: el('category-icon').value.trim(),
    sort_order: parseInt(el('category-sort').value, 10) || 0,
    status: el('category-status').value,
  };
  if (!payload.name) return alert('Name is required');
  try{
    if (id) await api(`/api/admin/categories/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/categories', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('categoryModal');
    loadCategories();
  }catch(e){ alert(e.message); }
}
async function deleteCategory(id){
  if (!confirm('Delete this category and all its services?')) return;
  try{ await api(`/api/admin/categories/${id}`, { method: 'DELETE' }); loadCategories(); }
  catch(e){ alert(e.message); }
}

// ---------------- Services ----------------
async function loadServices(){
  if (!cache.categories.length) { const r = await api('/api/admin/categories'); cache.categories = r.categories; }
  const catSelect = el('service-category');
  catSelect.innerHTML = cache.categories.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');

  const { services } = await api('/api/admin/services');
  cache.services = services;
  const tbody = document.querySelector('#services-table tbody');
  tbody.innerHTML = services.map(s => `
    <tr>
      <td>${s.id}</td>
      <td>${escapeHTML(s.category_name)}</td>
      <td>${escapeHTML(s.name)}</td>
      <td>৳${money(s.rate)}</td>
      <td>${s.min_qty.toLocaleString()}</td>
      <td>${s.max_qty.toLocaleString()}</td>
      <td><span class="badge ${s.status === 'active' ? 'active' : 'inactive'}">${s.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editService(${s.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deleteService(${s.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--text-dim);">No services yet</td></tr>`;
}

function openAddService(){
  el('service-modal-title').textContent = 'Add Service';
  el('service-id').value = '';
  el('service-name').value = '';
  el('service-rate').value = '';
  el('service-min').value = 100;
  el('service-max').value = 10000;
  el('service-desc').value = '';
  el('service-provider').value = '';
  el('service-status').value = 'active';
  showModal('serviceModal');
}
function editService(id){
  const s = cache.services.find(x => x.id === id);
  if (!s) return;
  el('service-modal-title').textContent = 'Edit Service';
  el('service-id').value = s.id;
  el('service-category').value = s.category_id;
  el('service-name').value = s.name;
  el('service-rate').value = s.rate;
  el('service-min').value = s.min_qty;
  el('service-max').value = s.max_qty;
  el('service-desc').value = s.description || '';
  el('service-provider').value = s.provider_id || '';
  el('service-status').value = s.status;
  showModal('serviceModal');
}
async function saveService(){
  const id = el('service-id').value;
  const payload = {
    category_id: parseInt(el('service-category').value, 10),
    name: el('service-name').value.trim(),
    rate: parseFloat(el('service-rate').value),
    min_qty: parseInt(el('service-min').value, 10) || 100,
    max_qty: parseInt(el('service-max').value, 10) || 10000,
    description: el('service-desc').value.trim() || null,
    provider_id: el('service-provider').value.trim() || null,
    status: el('service-status').value,
  };
  if (!payload.name || !payload.category_id || !payload.rate) return alert('Category, name and rate are required');
  try{
    if (id) await api(`/api/admin/services/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/services', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('serviceModal');
    loadServices();
  }catch(e){ alert(e.message); }
}
async function deleteService(id){
  if (!confirm('Delete this service?')) return;
  try{ await api(`/api/admin/services/${id}`, { method: 'DELETE' }); loadServices(); }
  catch(e){ alert(e.message); }
}

// ---------------- Orders ----------------
async function loadOrders(){
  const status = el('order-status-filter').value;
  const { orders } = await api('/api/admin/orders' + (status ? `?status=${status}` : ''));
  const tbody = document.querySelector('#orders-table tbody');
  tbody.innerHTML = orders.map(o => `
    <tr>
      <td>#${o.id}</td>
      <td>${escapeHTML(o.first_name)}<br><span style="color:var(--text-faint);font-size:11.5px;">${escapeHTML(o.telegram_id)}</span></td>
      <td>${escapeHTML(o.service_name)}</td>
      <td><a href="${escapeHTML(o.link)}" target="_blank" style="color:var(--primary);">Open link</a></td>
      <td>${o.quantity.toLocaleString()}</td>
      <td>৳${money(o.charge)}</td>
      <td><span class="badge ${o.source === 'api' ? 'active' : 'inactive'}">${o.source === 'api' ? 'API' : 'App'}</span></td>
      <td>${o.provider_order_id ? escapeHTML(o.provider_order_id) : (o.provider_error ? `<span title="${escapeHTML(o.provider_error)}" style="color:var(--danger);">failed</span>` : '—')}</td>
      <td>
        <select class="field" style="padding:6px 10px;font-size:12.5px;" onchange="updateOrderStatus(${o.id}, this.value)">
          ${['Pending','Processing','Completed','Partial','Cancelled'].map(s => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td>${new Date(o.created_at).toLocaleDateString()}</td>
    </tr>`).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--text-dim);">No orders found</td></tr>`;
}
async function updateOrderStatus(id, status){
  try{ await api(`/api/admin/orders/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }); }
  catch(e){ alert(e.message); loadOrders(); }
}

// ---------------- Users ----------------
async function loadUsers(){
  const q = el('user-search').value.trim();
  const { users } = await api('/api/admin/users' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  cache.users = users;
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.id}</td>
      <td>${escapeHTML(u.first_name)}</td>
      <td>${u.username ? '@' + escapeHTML(u.username) : '—'}</td>
      <td>${escapeHTML(u.telegram_id)}</td>
      <td>৳${money(u.balance)}</td>
      <td><span class="badge ${u.banned ? 'inactive' : 'active'}">${u.banned ? 'Banned' : 'Active'}</span></td>
      <td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="openBalanceModal(${u.id})"><i class="fa-solid fa-coins"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="toggleBan(${u.id}, ${u.banned ? 0 : 1})" style="color:${u.banned ? 'var(--primary)' : 'var(--danger)'};">
          <i class="fa-solid ${u.banned ? 'fa-lock-open' : 'fa-ban'}"></i>
        </button>
      </td>
    </tr>`).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--text-dim);">No users found</td></tr>`;
}
function openBalanceModal(userId){
  const u = cache.users.find(x => x.id === userId);
  if (!u) return;
  el('balance-user-id').value = userId;
  el('balance-user-label').textContent = `${u.first_name} (@${u.username || 'no-username'}) — current balance ৳${money(u.balance)}`;
  el('balance-amount').value = '';
  el('balance-note').value = '';
  showModal('balanceModal');
}
async function saveBalanceAdjust(){
  const id = el('balance-user-id').value;
  const amount = parseFloat(el('balance-amount').value);
  if (!amount) return alert('Enter a non-zero amount');
  try{
    await api(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ balance_adjust: amount, note: el('balance-note').value.trim() }) });
    closeModal('balanceModal');
    loadUsers();
  }catch(e){ alert(e.message); }
}
async function toggleBan(id, banned){
  try{ await api(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ banned }) }); loadUsers(); }
  catch(e){ alert(e.message); }
}

// ---------------- Settings ----------------
async function loadSettings(){
  const { settings } = await api('/api/admin/settings');
  cache.settings = settings;
  Object.keys(settings).forEach(k => { const f = el('set-' + k); if (f) f.value = settings[k]; });
}
async function saveSettings(){
  const keys = ['site_name','currency_symbol','bot_username','bot_token','channel_link','support_link',
                'ads_earning_enabled','monetag_zone_id','ad_reward','daily_ad_limit','cooldown_minutes',
                'provider_auto_order','provider_api_url','provider_api_key','admin_password'];
  const payload = {};
  keys.forEach(k => { const f = el('set-' + k); if (f) payload[k] = f.value; });
  try{
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    if (payload.admin_password && payload.admin_password !== ADMIN_PASSWORD) {
      ADMIN_PASSWORD = payload.admin_password;
      sessionStorage.setItem('tg_admin_pw', ADMIN_PASSWORD);
    }
    alert('Settings saved.');
  }catch(e){ alert(e.message); }
}

async function refreshAll(){ await loadDashboard(); }

// ---------------- Wire up ----------------
document.addEventListener('DOMContentLoaded', () => {
  el('login-button').addEventListener('click', tryLogin);
  el('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  el('logout-button').addEventListener('click', logout);
  el('menu-toggle').addEventListener('click', () => el('sidebar').classList.toggle('open'));

  document.querySelectorAll('.side-link[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.querySelectorAll('[data-tab-link]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tabLink)));

  el('add-category-btn').addEventListener('click', openAddCategory);
  el('save-category-btn').addEventListener('click', saveCategory);
  el('add-service-btn').addEventListener('click', openAddService);
  el('save-service-btn').addEventListener('click', saveService);
  el('order-status-filter').addEventListener('change', loadOrders);
  el('user-search').addEventListener('input', debounce(loadUsers, 350));
  el('save-balance-btn').addEventListener('click', saveBalanceAdjust);
  el('save-settings-btn').addEventListener('click', saveSettings);

  if (ADMIN_PASSWORD) {
    api('/api/admin/stats').then(enterShell).catch(() => { sessionStorage.removeItem('tg_admin_pw'); ADMIN_PASSWORD = ''; });
  }
});

function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
