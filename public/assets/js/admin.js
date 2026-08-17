// =====================================================
// Admin panel logic (v7 / Beta)
// =====================================================
const API_BASE = window.location.origin; // API is same-origin; admin page lives one level deep

const el = (id) => document.getElementById(id);
function escapeHTML(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(n){ return (Number(n)||0).toFixed(2); }
function money8(n){ return (Number(n)||0).toFixed(8); }

let ADMIN_PASSWORD = sessionStorage.getItem('tg_admin_pw') || '';
let cache = { categories: [], services: [], settings: {}, promo: [] };

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
  dashboard: ['Dashboard', 'Overview of your panel'],
  categories: ['Categories', 'Manage service categories'],
  services: ['Services', 'Manage the services users can order'],
  orders: ['Orders', 'Review and update customer orders'],
  users: ['Users', 'Manage user balances and access'],
  forcejoin: ['Force Join', 'Channels users must join before using the app'],
  promo: ['Promo Codes', 'Codes users can redeem for a balance top-up'],
  settings: ['Settings', 'Configure bot, markup, deposits and provider'],
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
  if (tab === 'forcejoin') loadForceJoin();
  if (tab === 'promo') loadPromoCodes();
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
      <td>৳${money8(o.charge)}</td>
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
      <td><code>${s.public_id}</code></td>
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
    </tr>`).join('') || `<tr><td colspan="9" style="text-align:center;color:var(--text-dim);">No services yet</td></tr>`;
}

function recomputeServiceRate(){
  const cost = parseFloat(el('service-cost-rate').value);
  const markup = parseFloat(el('service-markup').value);
  if (Number.isFinite(cost) && Number.isFinite(markup)) {
    el('service-rate').value = (cost * (1 + markup / 100)).toFixed(8);
  }
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
    const map = {
      Pending: 'status-pending', Processing: 'status-processing', Completed: 'status-completed',
      Partial: 'status-partial', Cancelled: 'status-cancelled',
    };
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
  try{ const res = await api(`/api/admin/orders/${id}/sync`, { method: 'POST' }); loadOrders(); }
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

// ---------------- Force Join ----------------
async function loadForceJoin(){
  const { channels } = await api('/api/admin/force-join');
  cache.forcejoin = channels;
  const tbody = document.querySelector('#fj-table tbody');
  tbody.innerHTML = channels.map(c => `
    <tr>
      <td>${c.id}</td>
      <td><i class="${escapeHTML(c.icon || '')}"></i> ${escapeHTML(c.title)}</td>
      <td>@${escapeHTML(c.username)}</td>
      <td>${c.sort_order}</td>
      <td><span class="badge ${c.status === 'active' ? 'active' : 'inactive'}">${c.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editForceJoin(${c.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deleteForceJoin(${c.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">No force-join channels yet</td></tr>`;
}
function openAddForceJoin(){
  el('fj-modal-title').textContent = 'Add Channel';
  el('fj-id').value = '';
  el('fj-title').value = 'Join Channel';
  el('fj-username').value = '';
  el('fj-invite').value = '';
  el('fj-icon').value = 'fa-brands fa-telegram';
  el('fj-sort').value = 0;
  el('fj-status').value = 'active';
  showModal('fjModal');
}
function editForceJoin(id){
  const c = cache.forcejoin.find(x => x.id === id);
  if (!c) return;
  el('fj-modal-title').textContent = 'Edit Channel';
  el('fj-id').value = c.id;
  el('fj-title').value = c.title;
  el('fj-username').value = c.username;
  el('fj-invite').value = c.invite_link || '';
  el('fj-icon').value = c.icon || '';
  el('fj-sort').value = c.sort_order;
  el('fj-status').value = c.status;
  showModal('fjModal');
}
async function saveForceJoin(){
  const id = el('fj-id').value;
  const payload = {
    title: el('fj-title').value.trim(),
    username: el('fj-username').value.trim().replace(/^@/, ''),
    invite_link: el('fj-invite').value.trim() || null,
    icon: el('fj-icon').value.trim() || 'fa-brands fa-telegram',
    sort_order: parseInt(el('fj-sort').value, 10) || 0,
    status: el('fj-status').value,
  };
  if (!payload.title || !payload.username) return alert('Title and username are required');
  try{
    if (id) await api(`/api/admin/force-join/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/force-join', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('fjModal');
    loadForceJoin();
  }catch(e){ alert(e.message); }
}
async function deleteForceJoin(id){
  if (!confirm('Delete this force-join channel?')) return;
  try{ await api(`/api/admin/force-join/${id}`, { method: 'DELETE' }); loadForceJoin(); }
  catch(e){ alert(e.message); }
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

// ---------------- Settings ----------------
async function loadSettings(){
  const { settings } = await api('/api/admin/settings');
  cache.settings = settings;
  Object.keys(settings).forEach(k => { const f = el('set-' + k); if (f) f.value = settings[k]; });
}
async function saveSettings(){
  const keys = ['site_name','currency_symbol','currency','bot_username','bot_token','channel_link','support_link',
                'default_markup_percent',
                'deposit_plan_1_amount','deposit_plan_1_bonus','deposit_plan_2_amount','deposit_plan_2_bonus',
                'deposit_plan_3_amount','deposit_plan_3_bonus','payment_instructions',
                'provider_auto_order','provider_api_url','provider_api_key','force_join_enabled',
                'order_log_enabled','order_log_channel','order_log_image_url','order_log_button_text',
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

// ---------------- Promo Codes ----------------
async function loadPromoCodes(){
  const { codes } = await api('/api/admin/promo');
  cache.promo = codes;
  const tbody = document.querySelector('#promo-table tbody');
  tbody.innerHTML = codes.map(c => `
    <tr>
      <td><code>${escapeHTML(c.code)}</code></td>
      <td>৳${money8(c.reward)}</td>
      <td>${c.claimed_count} / ${c.max_claims}</td>
      <td><span class="badge ${c.status === 'active' ? 'active' : 'inactive'}">${c.status}</span></td>
      <td>${new Date(c.created_at).toLocaleDateString()}</td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="editPromo(${c.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-ghost" onclick="deletePromo(${c.id})" style="color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);">No promo codes yet</td></tr>`;
}
function openAddPromo(){
  el('promo-modal-title').textContent = 'Add Promo Code';
  el('promo-id').value = '';
  el('promo-code').value = '';
  el('promo-reward').value = '';
  el('promo-max-claims').value = 100;
  el('promo-status').value = 'active';
  showModal('promoModal');
}
function editPromo(id){
  const c = cache.promo.find(x => x.id === id);
  if (!c) return;
  el('promo-modal-title').textContent = 'Edit Promo Code';
  el('promo-id').value = c.id;
  el('promo-code').value = c.code;
  el('promo-reward').value = c.reward;
  el('promo-max-claims').value = c.max_claims;
  el('promo-status').value = c.status;
  showModal('promoModal');
}
async function savePromo(){
  const id = el('promo-id').value;
  const payload = {
    code: el('promo-code').value.trim().toUpperCase(),
    reward: parseFloat(el('promo-reward').value),
    max_claims: parseInt(el('promo-max-claims').value, 10) || 100,
    status: el('promo-status').value,
  };
  if (!payload.code || !payload.reward) return alert('Code and reward are required');
  try{
    if (id) await api(`/api/admin/promo/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/admin/promo', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('promoModal');
    loadPromoCodes();
  }catch(e){ alert(e.message); }
}
async function deletePromo(id){
  if (!confirm('Delete this promo code?')) return;
  try{ await api(`/api/admin/promo/${id}`, { method: 'DELETE' }); loadPromoCodes(); }
  catch(e){ alert(e.message); }
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
  el('service-cost-rate').addEventListener('input', recomputeServiceRate);
  el('service-markup').addEventListener('input', recomputeServiceRate);
  el('reapply-markup-btn').addEventListener('click', () => showModal('reapplyMarkupModal'));
  el('confirm-reapply-markup-btn').addEventListener('click', confirmReapplyMarkup);
  el('add-fj-btn').addEventListener('click', openAddForceJoin);
  el('save-fj-btn').addEventListener('click', saveForceJoin);
  el('add-promo-btn').addEventListener('click', openAddPromo);
  el('save-promo-btn').addEventListener('click', savePromo);
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
  el('save-settings-btn').addEventListener('click', saveSettings);

  if (ADMIN_PASSWORD) {
    api('/api/admin/stats').then(enterShell).catch(() => { sessionStorage.removeItem('tg_admin_pw'); ADMIN_PASSWORD = ''; });
  }
});

function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
