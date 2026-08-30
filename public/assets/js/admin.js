// =====================================================
// Admin panel logic (v8)
// =====================================================
const API_BASE = window.location.origin;

const el = (id) => document.getElementById(id);
function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(n){ return (Number(n)||0).toFixed(2); }
function money8(n){ return (Number(n)||0).toFixed(8); }

let ADMIN_PASSWORD = sessionStorage.getItem('tg_admin_pw') || '';
let cache = { platforms: [], categories: [], services: [], settings: {}, methods: [] };

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
  await loadDashboard();
}

// ---------------- Tabs ----------------
const TAB_TITLES = {
  dashboard: ['Dashboard', 'Overview of your panel'],
  platforms: ['Platforms', 'The icon grid users see at the top of New Order'],
  categories: ['Categories', 'Manage service categories per platform'],
  services: ['Services', 'Manage the services users can order'],
  orders: ['Orders', 'Review and update customer orders'],
  users: ['Users', 'Manage user balances and access'],
  methods: ['Payment Methods', 'Where users send money to top up their wallet'],
  deposits: ['Deposits', 'Approve or reject incoming deposit requests'],
  settings: ['Settings', 'Configure bot, markup, funds and provider'],
};

function switchTab(tab){
  document.querySelectorAll('.side-link[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + tab));
  el('page-title').textContent = TAB_TITLES[tab][0];
  el('page-sub').textContent = TAB_TITLES[tab][1];
  el('sidebar').classList.remove('open');
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'platforms') loadPlatforms();
  if (tab === 'categories') loadCategories();
  if (tab === 'services') loadServices();
  if (tab === 'orders') loadOrders();
  if (tab === 'users') loadUsers();
  if (tab === 'methods') loadMethods();
  if (tab === 'deposits') loadDeposits();
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
  el('stat-pending-deposits').textContent = stats.pending_deposits;

  const { orders } = await api('/api/admin/orders');
  const tbody = document.querySelector('#recent-orders-table tbody');
  tbody.innerHTML = orders.slice(0, 8).map(o => `
    <tr>
      <td>#${o.id}</td>
      <td>${escapeHTML(o.first_name)} (${escapeHTML(o.telegram_id)})</td>
      <td>${escapeHTML(o.service_name)}</td>
      <td>৳${money8(o.charge)}</td>
      <td><span class="badge ${o.status === 'Completed' ? 'active' : 'inactive'}">${escapeHTML(o.status)}</span></td>
      <td>${new Date(o.created_at).toLocaleDateString()}</td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">No orders yet</td></tr>`;
}

// ---------------- Platforms ----------------
async function loadPlatforms(){
  const { platforms } = await api('/api/admin/platforms');
  cache.platforms = platforms;
  const tbody = document.querySelector('#platforms-table tbody');
  tbody.innerHTML = platforms.map(p => `
    <tr>
      <td>${p.id}</td>
      <td><i class="${escapeHTML(p.icon || '')}"></i></td>
      <td>${escapeHTML(p.name)}</td>
      <td>${p.sort_order}</td>
      <td><span class="badge ${p.status === 'active' ? 'active' : 'inactive'}">${p.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editPlatform(${p.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deletePlatform(${p.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">No platforms yet</td></tr>`;
}
function openAddPlatform(){
  el('platform-modal-title').textContent = 'Add Platform';
  el('platform-id').value = '';
  el('platform-name').value = '';
  el('platform-icon').value = 'fa-solid fa-star';
  el('platform-sort').value = 0;
  el('platform-status').value = 'active';
  showModal('platformModal');
}
function editPlatform(id){
  const p = cache.platforms.find(x => x.id === id);
  if (!p) return;
  el('platform-modal-title').textContent = 'Edit Platform';
  el('platform-id').value = p.id;
  el('platform-name').value = p.name;
  el('platform-icon').value = p.icon || '';
  el('platform-sort').value = p.sort_order;
  el('platform-status').value = p.status;
  showModal('platformModal');
}
async function savePlatform(){
  const id = el('platform-id').value;
  const payload = {
    name: el('platform-name').value.trim(),
    icon: el('platform-icon').value.trim() || 'fa-solid fa-star',
    sort_order: parseInt(el('platform-sort').value, 10) || 0,
    status: el('platform-status').value,
  };
  if (!payload.name) return alert('Name is required');
  try{
    if (id) await api(`/api/admin/platforms/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/platforms', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('platformModal');
    loadPlatforms();
  }catch(e){ alert(e.message); }
}
async function deletePlatform(id){
  if (!confirm('Delete this platform and all its categories/services?')) return;
  try{ await api(`/api/admin/platforms/${id}`, { method: 'DELETE' }); loadPlatforms(); }
  catch(e){ alert(e.message); }
}

// ---------------- Categories ----------------
async function loadCategories(){
  if (!cache.platforms.length) { const r = await api('/api/admin/platforms'); cache.platforms = r.platforms; }
  el('category-platform').innerHTML = cache.platforms.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');

  const { categories } = await api('/api/admin/categories');
  cache.categories = categories;
  const tbody = document.querySelector('#categories-table tbody');
  tbody.innerHTML = categories.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${escapeHTML(c.platform_name)}</td>
      <td>${escapeHTML(c.name)}</td>
      <td>${c.tag ? `<span class="badge active">${escapeHTML(c.tag)}</span>` : '—'}</td>
      <td>${c.sort_order}</td>
      <td><span class="badge ${c.status === 'active' ? 'active' : 'inactive'}">${c.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editCategory(${c.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deleteCategory(${c.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text-dim);">No categories yet</td></tr>`;
}
function openAddCategory(){
  el('category-modal-title').textContent = 'Add Category';
  el('category-id').value = '';
  el('category-name').value = '';
  el('category-icon').value = '';
  el('category-tag').value = '';
  el('category-sort').value = 0;
  el('category-status').value = 'active';
  showModal('categoryModal');
}
function editCategory(id){
  const c = cache.categories.find(x => x.id === id);
  if (!c) return;
  el('category-modal-title').textContent = 'Edit Category';
  el('category-id').value = c.id;
  el('category-platform').value = c.platform_id;
  el('category-name').value = c.name;
  el('category-icon').value = c.icon || '';
  el('category-tag').value = c.tag || '';
  el('category-sort').value = c.sort_order;
  el('category-status').value = c.status;
  showModal('categoryModal');
}
async function saveCategory(){
  const id = el('category-id').value;
  const payload = {
    platform_id: parseInt(el('category-platform').value, 10),
    name: el('category-name').value.trim(),
    icon: el('category-icon').value.trim() || null,
    tag: el('category-tag').value.trim() || null,
    sort_order: parseInt(el('category-sort').value, 10) || 0,
    status: el('category-status').value,
  };
  if (!payload.name || !payload.platform_id) return alert('Platform and name are required');
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
  el('service-category').innerHTML = cache.categories.map(c => `<option value="${c.id}">${escapeHTML(c.platform_name)} — ${escapeHTML(c.name)}</option>`).join('');

  const { services } = await api('/api/admin/services');
  cache.services = services;
  const tbody = document.querySelector('#services-table tbody');
  tbody.innerHTML = services.map(s => `
    <tr>
      <td><code>${s.public_id}</code></td>
      <td>${escapeHTML(s.platform_name)}</td>
      <td>${escapeHTML(s.category_name)}</td>
      <td>${escapeHTML(s.name)}</td>
      <td>${s.cost_rate != null ? '$' + money8(s.cost_rate) : '—'}</td>
      <td>${s.markup_percent != null ? s.markup_percent + '%' : '—'}</td>
      <td>৳${money8(s.rate)}</td>
      <td>${s.refill_days > 0 ? s.refill_days + 'd' : '—'}</td>
      <td><span class="badge ${s.status === 'active' ? 'active' : 'inactive'}">${s.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editService(${s.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deleteService(${s.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--text-dim);">No services yet</td></tr>`;
}
function recomputeServiceRate(){
  const cost = parseFloat(el('service-cost-rate').value);
  const markup = parseFloat(el('service-markup').value);
  if (Number.isFinite(cost) && Number.isFinite(markup)) el('service-rate').value = (cost * (1 + markup / 100)).toFixed(8);
}
function openAddService(){
  el('service-modal-title').textContent = 'Add Service';
  el('service-id').value = '';
  el('service-public-id').value = '';
  el('service-name').value = '';
  el('service-cost-rate').value = '';
  el('service-markup').value = cache.settings.default_markup_percent || 50;
  el('service-rate').value = '';
  el('service-min').value = 100;
  el('service-max').value = 10000;
  el('service-avgtime').value = '';
  el('service-starttype').value = 'Instant';
  el('service-speed').value = '';
  el('service-refilldays').value = 0;
  el('service-linktype').value = '';
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
  el('service-public-id').value = s.public_id;
  el('service-category').value = s.category_id;
  el('service-name').value = s.name;
  el('service-cost-rate').value = s.cost_rate ?? '';
  el('service-markup').value = s.markup_percent ?? '';
  el('service-rate').value = s.rate;
  el('service-min').value = s.min_qty;
  el('service-max').value = s.max_qty;
  el('service-avgtime').value = s.avg_time || '';
  el('service-starttype').value = s.start_type || '';
  el('service-speed').value = s.speed_info || '';
  el('service-refilldays').value = s.refill_days || 0;
  el('service-linktype').value = s.link_type || '';
  el('service-desc').value = s.description || '';
  el('service-provider').value = s.provider_id || '';
  el('service-status').value = s.status;
  showModal('serviceModal');
}
async function saveService(){
  const id = el('service-id').value;
  const payload = {
    public_id: el('service-public-id').value.trim() || null,
    category_id: parseInt(el('service-category').value, 10),
    name: el('service-name').value.trim(),
    cost_rate: el('service-cost-rate').value.trim() || null,
    markup_percent: el('service-markup').value.trim() || null,
    rate: parseFloat(el('service-rate').value),
    min_qty: parseInt(el('service-min').value, 10) || 100,
    max_qty: parseInt(el('service-max').value, 10) || 10000,
    avg_time: el('service-avgtime').value.trim() || null,
    start_type: el('service-starttype').value.trim() || null,
    speed_info: el('service-speed').value.trim() || null,
    refill_days: parseInt(el('service-refilldays').value, 10) || 0,
    link_type: el('service-linktype').value.trim() || null,
    description: el('service-desc').value || null,
    provider_id: el('service-provider').value.trim() || null,
    status: el('service-status').value,
  };
  if (!payload.name || !payload.category_id) return alert('Category and name are required');
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
async function confirmReapplyMarkup(){
  const val = el('reapply-markup-value').value.trim();
  const payload = val ? { markup_percent: parseFloat(val) } : {};
  try{
    const res = await api('/api/admin/services/reapply-markup', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('reapplyMarkupModal');
    el('reapply-markup-value').value = '';
    alert(`Updated ${res.updated} service(s).`);
    loadServices();
  }catch(e){ alert(e.message); }
}

// ---------------- Orders ----------------
let orderStatusFilter = '';
async function loadOrders(){
  const { orders } = await api('/api/admin/orders' + (orderStatusFilter ? `?status=${orderStatusFilter}` : ''));
  cache.orders = orders;
  renderOrdersTable();
}
function renderOrdersTable(){
  const q = (el('order-search').value || '').trim().toLowerCase();
  let orders = cache.orders || [];
  if (q) orders = orders.filter(o =>
    String(o.id).includes(q) || o.service_name.toLowerCase().includes(q) ||
    o.link.toLowerCase().includes(q) || String(o.service_public_id || '').includes(q)
  );
  const statusPill = (status) => {
    const map = { Pending: 'status-pending', Processing: 'status-processing', Completed: 'status-completed', Partial: 'status-partial', Cancelled: 'status-cancelled' };
    return `<span class="order-status-pill ${map[status] || ''}">${escapeHTML(status)}</span>`;
  };
  const tbody = document.querySelector('#orders-table tbody');
  tbody.innerHTML = orders.map(o => `
    <tr>
      <td>#${o.id}</td>
      <td>${new Date(o.created_at).toLocaleString()}</td>
      <td><a href="${escapeHTML(o.link)}" target="_blank" style="color:var(--primary);">${escapeHTML(o.link.length > 34 ? o.link.slice(0, 34) + '…' : o.link)}</a></td>
      <td>৳${money8(o.charge)}</td>
      <td>${o.start_count ?? '-'}</td>
      <td>${o.quantity.toLocaleString()}</td>
      <td>
        <div style="font-weight:600;">${o.service_public_id ? `<code>${o.service_public_id}</code> - ` : ''}${escapeHTML(o.service_name)}</div>
        <div style="color:var(--text-faint);font-size:11px;">${escapeHTML(o.first_name)} · ${escapeHTML(o.telegram_id)}</div>
      </td>
      <td>${o.remains ?? '-'}</td>
      <td>${statusPill(o.status)}${o.refill_status ? `<br><span class="badge inactive" style="margin-top:4px;">Refill: ${escapeHTML(o.refill_status)}</span>` : ''}</td>
      <td>
        <div class="qa-dropdown">
          <button class="btn btn-sm btn-ghost qa-toggle" onclick="toggleQuickActions(this)">Actions <i class="fa-solid fa-caret-down"></i></button>
          <div class="qa-menu hidden">
            ${o.provider_order_id ? `<button onclick="syncOrder(${o.id})"><i class="fa-solid fa-rotate"></i> Sync Status</button>` : ''}
            ${o.status !== 'Cancelled' && o.status !== 'Completed' ? `<button onclick="cancelOrder(${o.id})" style="color:var(--danger);"><i class="fa-solid fa-ban"></i> Cancel &amp; Refund</button>` : ''}
            <a href="${escapeHTML(o.link)}" target="_blank"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open Link</a>
          </div>
        </div>
      </td>
    </tr>`).join('') || `<tr><td colspan="10" style="text-align:center;color:var(--text-dim);">No orders found</td></tr>`;
}
function toggleQuickActions(btn){
  const menu = btn.nextElementSibling;
  document.querySelectorAll('.qa-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
  menu.classList.toggle('hidden');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.qa-dropdown')) document.querySelectorAll('.qa-menu').forEach(m => m.classList.add('hidden'));
});
async function syncOrder(id){
  try{ await api(`/api/admin/orders/${id}/sync`, { method: 'POST' }); loadOrders(); }
  catch(e){ alert(e.message); }
}
async function cancelOrder(id){
  if (!confirm('Cancel this order and refund the user?')) return;
  try{ await api(`/api/admin/orders/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'Cancelled' }) }); loadOrders(); }
  catch(e){ alert(e.message); }
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
      <td>৳${money8(u.balance)}</td>
      <td><span class="badge ${u.banned ? 'inactive' : 'active'}">${u.banned ? 'Banned' : 'Active'}</span></td>
      <td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="openUserDetail(${u.id})" title="View details"><i class="fa-solid fa-eye"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="openBalanceModal(${u.id})" title="Adjust balance"><i class="fa-solid fa-coins"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="toggleBan(${u.id}, ${u.banned ? 0 : 1})" style="color:${u.banned ? 'var(--primary)' : 'var(--danger)'};" title="${u.banned ? 'Unban' : 'Ban'}">
          <i class="fa-solid ${u.banned ? 'fa-lock-open' : 'fa-ban'}"></i>
        </button>
      </td>
    </tr>`).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--text-dim);">No users found</td></tr>`;
}
async function openUserDetail(userId){
  const body = el('user-detail-body');
  body.innerHTML = '<p class="card-sub">Loading…</p>';
  showModal('userDetailModal');
  try{
    const { user, stats, recentOrders, recentTxns } = await api(`/api/admin/users/${userId}/detail`);
    body.innerHTML = `
      <div class="stat-cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px;">
        <div class="stat-card"><div class="label">Orders</div><div class="value">${stats.total_orders}</div></div>
        <div class="stat-card"><div class="label">Spent</div><div class="value">$${money(stats.total_spent)}</div></div>
        <div class="stat-card"><div class="label">Earned</div><div class="value">$${money(stats.total_earned)}</div></div>
      </div>
      <div class="form-grid" style="margin-bottom:16px;">
        <div><label>Name</label><div>${escapeHTML(user.first_name)}</div></div>
        <div><label>Username</label><div>${user.username ? '@' + escapeHTML(user.username) : '—'}</div></div>
        <div><label>Telegram ID</label><div>${escapeHTML(user.telegram_id)}</div></div>
        <div><label>Balance</label><div>৳${money8(user.balance)}</div></div>
        <div><label>Status</label><div>${user.banned ? 'Banned' : 'Active'}</div></div>
        <div><label>Joined</label><div>${new Date(user.created_at).toLocaleString()}</div></div>
        <div class="full"><label>API Token</label><div style="font-family:monospace;font-size:12px;word-break:break-all;">${escapeHTML(user.api_token || '—')}</div></div>
      </div>
      <h3 class="card-title">Recent Orders</h3>
      <div class="table-wrap"><table class="admin-table"><thead><tr><th>ID</th><th>Service</th><th>Charge</th><th>Status</th><th>Date</th></tr></thead><tbody>
        ${recentOrders.map(o => `<tr><td>#${o.id}</td><td>${escapeHTML(o.service_name)}</td><td>৳${money8(o.charge)}</td><td>${escapeHTML(o.status)}</td><td>${new Date(o.created_at).toLocaleDateString()}</td></tr>`).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);">None</td></tr>`}
      </tbody></table></div>
      <h3 class="card-title" style="margin-top:16px;">Recent Transactions</h3>
      <div class="table-wrap"><table class="admin-table"><thead><tr><th>Type</th><th>Amount</th><th>Note</th><th>Date</th></tr></thead><tbody>
        ${recentTxns.map(t => `<tr><td>${escapeHTML(t.type)}</td><td>${t.amount >= 0 ? '+' : ''}$${money(t.amount)}</td><td>${escapeHTML(t.note || '')}</td><td>${new Date(t.created_at).toLocaleDateString()}</td></tr>`).join('') || `<tr><td colspan="4" style="text-align:center;color:var(--text-dim);">None</td></tr>`}
      </tbody></table></div>`;
  }catch(e){
    body.innerHTML = `<p class="card-sub" style="color:var(--danger);">${escapeHTML(e.message)}</p>`;
  }
}
function openBalanceModal(userId){
  const u = cache.users.find(x => x.id === userId);
  if (!u) return;
  el('balance-user-id').value = userId;
  el('balance-user-label').textContent = `${u.first_name} (@${u.username || 'no-username'}) — current balance ৳${money8(u.balance)}`;
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

// ---------------- Payment Methods ----------------
async function loadMethods(){
  const { methods } = await api('/api/admin/payment-methods');
  cache.methods = methods;
  const tbody = document.querySelector('#methods-table tbody');
  tbody.innerHTML = methods.map(m => `
    <tr>
      <td>${m.id}</td>
      <td><i class="${escapeHTML(m.icon || '')}"></i></td>
      <td>${escapeHTML(m.name)}</td>
      <td>${m.sort_order}</td>
      <td><span class="badge ${m.status === 'active' ? 'active' : 'inactive'}">${m.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editMethod(${m.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deleteMethod(${m.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">No payment methods yet</td></tr>`;
}
function openAddMethod(){
  el('method-modal-title').textContent = 'Add Payment Method';
  el('method-id').value = '';
  el('method-name').value = '';
  el('method-icon').value = 'fa-solid fa-wallet';
  el('method-account').value = '';
  el('method-instructions').value = '';
  el('method-sort').value = 0;
  el('method-status').value = 'active';
  showModal('methodModal');
}
function editMethod(id){
  const m = cache.methods.find(x => x.id === id);
  if (!m) return;
  el('method-modal-title').textContent = 'Edit Payment Method';
  el('method-id').value = m.id;
  el('method-name').value = m.name;
  el('method-icon').value = m.icon || '';
  el('method-account').value = m.account_info || '';
  el('method-instructions').value = m.instructions || '';
  el('method-sort').value = m.sort_order;
  el('method-status').value = m.status;
  showModal('methodModal');
}
async function saveMethod(){
  const id = el('method-id').value;
  const payload = {
    name: el('method-name').value.trim(),
    icon: el('method-icon').value.trim() || 'fa-solid fa-wallet',
    account_info: el('method-account').value.trim() || null,
    instructions: el('method-instructions').value.trim() || null,
    sort_order: parseInt(el('method-sort').value, 10) || 0,
    status: el('method-status').value,
  };
  if (!payload.name) return alert('Name is required');
  try{
    if (id) await api(`/api/admin/payment-methods/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/payment-methods', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('methodModal');
    loadMethods();
  }catch(e){ alert(e.message); }
}
async function deleteMethod(id){
  if (!confirm('Delete this payment method?')) return;
  try{ await api(`/api/admin/payment-methods/${id}`, { method: 'DELETE' }); loadMethods(); }
  catch(e){ alert(e.message); }
}

// ---------------- Deposits ----------------
let depositStatusFilter = '';
async function loadDeposits(){
  const { deposits } = await api('/api/admin/deposits' + (depositStatusFilter ? `?status=${depositStatusFilter}` : ''));
  cache.deposits = deposits;
  renderDepositsTable();
}
function renderDepositsTable(){
  const q = (el('deposit-search').value || '').trim().toLowerCase();
  let deposits = cache.deposits || [];
  if (q) deposits = deposits.filter(d => d.reference_code.toLowerCase().includes(q) || (d.username || '').toLowerCase().includes(q) || d.telegram_id.includes(q));
  const statusPill = (status) => {
    const map = { Pending: 'status-pending', Approved: 'status-approved', Rejected: 'status-rejected' };
    return `<span class="order-status-pill ${map[status] || ''}">${escapeHTML(status)}</span>`;
  };
  const tbody = document.querySelector('#deposits-table tbody');
  tbody.innerHTML = deposits.map(d => `
    <tr>
      <td><code>${escapeHTML(d.reference_code)}</code></td>
      <td>${escapeHTML(d.first_name)} · ${escapeHTML(d.telegram_id)}</td>
      <td>${escapeHTML(d.method_name)}</td>
      <td>৳${money(d.amount)}</td>
      <td>${statusPill(d.status)}</td>
      <td>${new Date(d.created_at).toLocaleString()}</td>
      <td class="actions">
        ${d.status === 'Pending' ? `<button class="btn btn-sm btn-ghost" onclick="openDepositModal(${d.id})"><i class="fa-solid fa-magnifying-glass"></i> Review</button>` : `<span class="text-dim" style="font-size:12px;">${escapeHTML(d.admin_note || '')}</span>`}
      </td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text-dim);">No deposit requests found</td></tr>`;
}
function openDepositModal(id){
  const d = cache.deposits.find(x => x.id === id);
  if (!d) return;
  el('deposit-id').value = id;
  el('deposit-summary').textContent = `${d.first_name} (${d.telegram_id}) wants to deposit ৳${money(d.amount)} via ${d.method_name}. Reference: ${d.reference_code}`;
  el('deposit-note').value = '';
  showModal('depositModal');
}
async function reviewDeposit(status){
  const id = el('deposit-id').value;
  try{
    await api(`/api/admin/deposits/${id}`, { method: 'PUT', body: JSON.stringify({ status, admin_note: el('deposit-note').value.trim() }) });
    closeModal('depositModal');
    loadDeposits();
    loadDashboard();
  }catch(e){ alert(e.message); }
}

// ---------------- Settings ----------------
async function loadSettings(){
  const { settings } = await api('/api/admin/settings');
  cache.settings = settings;
  Object.keys(settings).forEach(k => { const f = el('set-' + k); if (f) f.value = settings[k]; });
}
async function saveSettings(){
  const keys = ['site_name','currency_symbol','currency','bot_token','channel_link','support_link',
                'default_markup_percent','deposit_quick_amounts',
                'provider_auto_order','provider_api_url','provider_api_key',
                'admin_password'];
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

// ---------------- Wire up ----------------
document.addEventListener('DOMContentLoaded', () => {
  el('login-button').addEventListener('click', tryLogin);
  el('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  el('logout-button').addEventListener('click', logout);
  el('menu-toggle').addEventListener('click', () => el('sidebar').classList.toggle('open'));

  document.querySelectorAll('.side-link[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.querySelectorAll('[data-tab-link]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tabLink)));

  el('add-platform-btn').addEventListener('click', openAddPlatform);
  el('save-platform-btn').addEventListener('click', savePlatform);

  el('add-category-btn').addEventListener('click', openAddCategory);
  el('save-category-btn').addEventListener('click', saveCategory);

  el('add-service-btn').addEventListener('click', openAddService);
  el('save-service-btn').addEventListener('click', saveService);
  el('service-cost-rate').addEventListener('input', recomputeServiceRate);
  el('service-markup').addEventListener('input', recomputeServiceRate);
  el('reapply-markup-btn').addEventListener('click', () => showModal('reapplyMarkupModal'));
  el('confirm-reapply-markup-btn').addEventListener('click', confirmReapplyMarkup);

  el('order-search').addEventListener('input', renderOrdersTable);
  document.querySelectorAll('#order-status-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#order-status-pills .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      orderStatusFilter = btn.dataset.status;
      loadOrders();
    });
  });

  el('user-search').addEventListener('input', debounce(loadUsers, 350));
  el('save-balance-btn').addEventListener('click', saveBalanceAdjust);

  el('add-method-btn').addEventListener('click', openAddMethod);
  el('save-method-btn').addEventListener('click', saveMethod);

  el('deposit-search').addEventListener('input', renderDepositsTable);
  document.querySelectorAll('#deposit-status-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#deposit-status-pills .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      depositStatusFilter = btn.dataset.status;
      loadDeposits();
    });
  });
  el('approve-deposit-btn').addEventListener('click', () => reviewDeposit('Approved'));
  el('reject-deposit-btn').addEventListener('click', () => reviewDeposit('Rejected'));

  el('save-settings-btn').addEventListener('click', saveSettings);

  if (ADMIN_PASSWORD) {
    api('/api/admin/stats').then(enterShell).catch(() => { sessionStorage.removeItem('tg_admin_pw'); ADMIN_PASSWORD = ''; });
  }
});

function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
