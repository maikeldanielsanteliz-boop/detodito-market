/* DE TODITO MARKET MyF, C.A — app.js */

let productosCache = [];
let editandoId = null;
let tasaActual = null;
let isAdmin = false;
let passwordConfigurada = true;
let pendingPage = null;
let posCarrito = [];
let posProductosCache = [];
let editVentaItems = [];
let editVentaIdsOriginales = [];
let ventasCache = [];
let _confirmarCallback = null;
let metodosPagoCache = [];
let metodosPagoAdminCache = [];
let metodoPagoSeleccionado = null;
let posPagos = []; // pagos mixtos de la venta actual
let pagoEnPartes = false;
let html5QrCodeInstance = null;
let _scannerCallback = null;

document.addEventListener('DOMContentLoaded', async () => {
  inicializarTema();
  actualizarUnidadesPorTipo();
  iniciarReloj();
  await checkAuthStatus();
  cargarTasa();
  cargarProductosVenta();
  cargarMetodosPagoPOS();
  cargarCategorias();
  setupNav();
  setupGlobalSearch();
  setupPosBarcodeListener();

  const hoy = new Date().toISOString().split('T')[0];
  document.getElementById('v-fecha-fin').value = hoy;
  const ini = new Date(); ini.setDate(1);
  document.getElementById('r-fecha-ini').value = ini.toISOString().split('T')[0];
  document.getElementById('r-fecha-fin').value = hoy;
});

function iniciarReloj() {
  const tick = () => {
    const n = new Date();
    document.getElementById('reloj').textContent = n.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    document.getElementById('fecha-sidebar').textContent = n.toLocaleDateString('es-ES', {weekday:'short',day:'numeric',month:'short'});
  };
  tick(); setInterval(tick, 1000);
}

// ── TEMA ─────────────────────────────────────────
function inicializarTema() {
  const guardado = localStorage.getItem('detodito_tema') || 'dark';
  document.documentElement.setAttribute('data-theme', guardado);
  actualizarIconoTema(guardado);
}
function alternarTema() {
  const actual = document.documentElement.getAttribute('data-theme') || 'dark';
  const nuevo = actual === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', nuevo);
  try { localStorage.setItem('detodito_tema', nuevo); } catch(e) {}
  actualizarIconoTema(nuevo);
}
function actualizarIconoTema(tema) {
  const icon = document.getElementById('theme-icon');
  if (icon) icon.className = tema === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

// ── CONTRASEÑA FUERTE ──────────────────────────────
function actualizarReglasPassword(password, prefix) {
  const reglas = {
    largo: password.length >= 8,
    mayuscula: /[A-Z]/.test(password),
    minuscula: /[a-z]/.test(password),
    numero: /[0-9]/.test(password),
  };
  for (const k in reglas) {
    const el = document.getElementById(`${prefix}-regla-${k}`);
    if (el) el.classList.toggle('cumplida', reglas[k]);
  }
  return Object.values(reglas).every(Boolean);
}

// ── AUTENTICACIÓN ──────────────────────────────────
async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth-status');
    const d = await res.json();
    isAdmin = !!d.is_admin;
    passwordConfigurada = !!d.password_configurada;
  } catch(e) { isAdmin = false; }
  actualizarUIAuth();
}
function actualizarUIAuth() {
  document.querySelectorAll('.nav-lock').forEach(el => { el.style.display = isAdmin ? 'none' : 'inline-block'; });
  document.getElementById('topbar-search-box').style.display = isAdmin ? 'flex' : 'none';
  document.getElementById('notif-badge').style.display = isAdmin ? 'flex' : 'none';

  const box = document.getElementById('admin-session-box');
  if (isAdmin) {
    box.innerHTML = `<div class="admin-active"><i class="fas fa-user-shield"></i> Administrador</div>
       <button class="btn-admin-logout" onclick="cerrarSesionAdmin()"><i class="fas fa-sign-out-alt"></i> Cerrar sesión</button>
       <button class="link-cambiar-pw" onclick="abrirCambiarPassword()">Cambiar contraseña</button>`;
  } else if (passwordConfigurada) {
    box.innerHTML = `<button class="btn-admin-login" onclick="abrirLogin()"><i class="fas fa-user-shield"></i> Acceso Administrador</button>`;
  } else {
    box.innerHTML = `<button class="btn-admin-login" onclick="abrirConfigurarPasswordInicial()"><i class="fas fa-shield-halved"></i> Configurar Administrador</button>`;
  }
  if (isAdmin) cargarDashboard();
}
function abrirLogin() {
  if (!passwordConfigurada) { abrirConfigurarPasswordInicial(); return; }
  document.getElementById('login-password-input').value = '';
  document.getElementById('login-error').style.display = 'none';
  abrirModal('modal-login');
  setTimeout(() => document.getElementById('login-password-input').focus(), 150);
}
async function intentarLogin() {
  const pwd = document.getElementById('login-password-input').value;
  const res = await fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pwd})});
  const d = await res.json();
  if (!res.ok) {
    document.getElementById('login-error').textContent = d.error || 'Error';
    document.getElementById('login-error').style.display = 'block';
    return;
  }
  isAdmin = true;
  actualizarUIAuth();
  cerrarModal('modal-login');
  notificar('Bienvenido, Administrador ✓', 'success');
  if (pendingPage) { activarPagina(pendingPage); pendingPage = null; }
}
function abrirConfigurarPasswordInicial() {
  document.getElementById('setup-password-input').value = '';
  document.getElementById('setup-password-confirm').value = '';
  document.getElementById('setup-error').style.display = 'none';
  actualizarReglasPassword('', 'setup');
  abrirModal('modal-configurar-password');
}
async function guardarPasswordInicial() {
  const pwd = document.getElementById('setup-password-input').value;
  const confirmar = document.getElementById('setup-password-confirm').value;
  const errEl = document.getElementById('setup-error');
  errEl.style.display = 'none';
  if (pwd !== confirmar) { errEl.textContent = 'Las contraseñas no coinciden'; errEl.style.display = 'block'; return; }
  const res = await fetch('/api/configurar-password-inicial', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pwd})});
  const d = await res.json();
  if (!res.ok) { errEl.textContent = d.error || 'Error'; errEl.style.display = 'block'; return; }
  isAdmin = true; passwordConfigurada = true;
  actualizarUIAuth();
  cerrarModal('modal-configurar-password');
  notificar('Contraseña configurada ✓ Bienvenido, Administrador', 'success');
  if (pendingPage) { activarPagina(pendingPage); pendingPage = null; }
}
async function cerrarSesionAdmin() {
  await fetch('/api/logout', {method:'POST'});
  isAdmin = false;
  actualizarUIAuth();
  activarPagina('facturacion');
  notificar('Sesión cerrada', 'warning');
}
function abrirCambiarPassword() {
  document.getElementById('cp-actual').value = '';
  document.getElementById('cp-nueva').value = '';
  document.getElementById('cp-error').style.display = 'none';
  actualizarReglasPassword('', 'cp');
  abrirModal('modal-cambiar-password');
}
async function guardarNuevaPassword() {
  const actual = document.getElementById('cp-actual').value;
  const nueva  = document.getElementById('cp-nueva').value;
  const res = await fetch('/api/cambiar-password', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({actual, nueva})});
  const d = await res.json();
  if (!res.ok) {
    document.getElementById('cp-error').textContent = d.error || 'Error';
    document.getElementById('cp-error').style.display = 'block'; return;
  }
  cerrarModal('modal-cambiar-password');
  notificar('Contraseña actualizada ✓', 'success');
}
async function fetchAdmin(url, opts={}) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    isAdmin = false; actualizarUIAuth();
    notificar('Tu sesión expiró, inicia sesión de nuevo', 'warning');
    pendingPage = null;
    abrirLogin();
    throw new Error('No autorizado');
  }
  return res;
}

// ── TASA ───────────────────────────────────────────
async function cargarTasa() {
  try {
    const res = await fetch('/api/tasa-dolar');
    const d = await res.json();
    if (d.tasa) { mostrarTasa(d.tasa); }
    else {
      document.getElementById('tasa-display').textContent = 'Sin conexión';
      
    }
  } catch(e) {
    document.getElementById('tasa-display').textContent = 'Sin conexión';
    
  }
}
function mostrarTasa(tasa) {
  tasaActual = tasa;
  document.getElementById('tasa-display').innerHTML = `1 USD = <strong>${fmtBs(tasa)} Bs</strong>`;
}
function convertirUSD() {
  if (!tasaActual) return;
  const v = parseFloat(document.getElementById('conv-usd').value) || 0;
  document.getElementById('conv-bs').value = v > 0 ? (v*tasaActual).toFixed(2) : '';
}
function convertirBS() {
  if (!tasaActual) return;
  const v = parseFloat(document.getElementById('conv-bs').value) || 0;
  document.getElementById('conv-usd').value = v > 0 ? (v/tasaActual).toFixed(2) : '';
}
function abrirTasaManual() {
  if (tasaActual) document.getElementById('tasa-manual-input').value = tasaActual.toFixed(2);
  abrirModal('modal-tasa');
}
async function guardarTasaManual() {
  const tasa = parseFloat(document.getElementById('tasa-manual-input').value);
  if (!tasa || tasa <= 0) { notificar('Tasa inválida', 'warning'); return; }
  await fetch('/api/tasa-dolar', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tasa})});
  mostrarTasa(tasa, 'Manual');
  cerrarModal('modal-tasa');
  notificar(`Tasa: 1 USD = ${fmtBs(tasa)} Bs`, 'success');
  if (isAdmin) cargarDashboard();
}

// ── NAV ────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const page = item.dataset.page;
      if (item.classList.contains('nav-admin') && !isAdmin) {
        pendingPage = page;
        abrirLogin();
        return;
      }
      activarPagina(page);
    });
  });
}
function activarPagina(page) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  const titles = {facturacion:'Facturación', dashboard:'Dashboard', inventario:'Inventario', ventas:'Historial de Ventas', 'metodos-pago':'Métodos de Pago', proveedores:'Proveedores', reportes:'Exportar Reportes'};
  document.getElementById('topbar-title').textContent = titles[page] || page;
  if (page === 'inventario') cargarInventario();
  if (page === 'ventas') cargarVentas();
  if (page === 'dashboard') cargarDashboard();
  if (page === 'metodos-pago') cargarMetodosPagoAdmin();
  if (page === 'proveedores') cargarProveedores();
  if (page === 'facturacion') { cargarProductosVenta(); cargarMetodosPagoPOS(); enfocarBarcode(); }
}

function irAFacturarProducto(id) {
  activarPagina('facturacion');
  setTimeout(() => {
    const sel = document.getElementById('pos-select-prod');
    if (sel) {
      sel.value = id;
      const opt = sel.options[sel.selectedIndex];
      if (opt && opt.value) {
        document.getElementById('pos-cantidad').value = 1;
        posAgregarSeleccionado();
      }
    }
  }, 200);
}


function actualizarTodo() {
  const page = document.querySelector('.nav-item.active')?.dataset.page || 'facturacion';
  if (page === 'inventario') cargarInventario();
  else if (page === 'dashboard') cargarDashboard();
  else if (page === 'ventas') cargarVentas();
  else if (page === 'facturacion') { cargarProductosVenta(); cargarMetodosPagoPOS(); }
  else if (page === 'metodos-pago') cargarMetodosPagoAdmin();
  else if (page === 'proveedores') cargarProveedores();
  notificar('Actualizado ✓', 'success');
}
function syncStockDesdeKgG() {
  const kg = parseFloat(document.getElementById('prod-stock-kg')?.value) || 0;
  const g = parseFloat(document.getElementById('prod-stock-g')?.value) || 0;
  const total = kg + (g / 1000);
  const stock = document.getElementById('prod-stock');
  if (stock) stock.value = total.toFixed(3);
  const hint = document.getElementById('hint-stock-peso');
  if (hint) hint.textContent = 'Total: ' + total.toFixed(3) + ' kg';
}
function actualizarCamposStock() {
  const tipo = document.getElementById('prod-tipo-medida')?.value || 'unidad';
  const simple = document.getElementById('grupo-stock-simple');
  const peso = document.getElementById('grupo-stock-peso');
  if (tipo === 'peso') {
    if (simple) simple.style.display = 'none';
    if (peso) peso.style.display = 'block';
  } else {
    if (simple) simple.style.display = 'block';
    if (peso) peso.style.display = 'none';
  }
}

function irAFacturacion() { activarPagina('facturacion'); }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
function setupGlobalSearch() {
  document.getElementById('global-search').addEventListener('input', e => {
    const q = e.target.value.trim();
    if (!q || !isAdmin) return;
    activarPagina('inventario');
    setTimeout(() => { document.getElementById('inv-search').value = q; filtrarInventario(); }, 80);
  });
}

// ── DASHBOARD ──────────────────────────────────────
async function cargarDashboard() {
  if (!isAdmin) return;
  try {
    const res = await fetchAdmin('/api/dashboard');
    const d = await res.json();
    renderDashboard(d);
    const badge = document.getElementById('badge-count');
    if (d.stock_bajo > 0) { badge.textContent = d.stock_bajo; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch(e) {}
}
function renderDashboard(d) {
  const margen = d.ventas_mes.total > 0 ? ((d.ventas_mes.ganancia/d.ventas_mes.total)*100).toFixed(1) : 0;
  const kpis = [
    {icon:'📦',label:'Productos',value:d.total_productos,bs:null,sub:'en inventario',accent:'#6c63ff',ibg:'rgba(108,99,255,0.15)'},
    {icon:'💰',label:'Valor Inventario',value:`$${fmt(d.valor_inventario)}`,bs:d.valor_inventario,sub:'costo total',accent:'#00d4aa',ibg:'rgba(0,212,170,0.15)'},
    {icon:'🛒',label:'Ventas Hoy',value:d.ventas_hoy.cantidad,bs:null,sub:`$${fmt(d.ventas_hoy.total)} ingresos`,accent:'#e94560',ibg:'rgba(233,69,96,0.15)'},
    {icon:'📈',label:'Ingresos Mes',value:`$${fmt(d.ventas_mes.total)}`,bs:d.ventas_mes.total,sub:`${d.ventas_mes.cantidad} ventas`,accent:'#f39c12',ibg:'rgba(243,156,18,0.15)'},
    {icon:'💵',label:'Ganancia Mes',value:`$${fmt(d.ventas_mes.ganancia)}`,bs:d.ventas_mes.ganancia,sub:`Margen: ${margen}%`,accent:'#2ecc71',ibg:'rgba(46,204,113,0.15)'},
    {icon:'⚠️',label:'Stock Bajo',value:d.stock_bajo,bs:null,sub:'por reabastecer',accent:'#e74c3c',ibg:'rgba(231,76,60,0.1)'},
  ];
  const kpiHtml = kpis.map(k => `
    <div class="kpi-card" style="--card-accent:${k.accent}">
      <div class="kpi-icon" style="background:${k.ibg}">${k.icon}</div>
      <div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div>
      ${k.bs!==null&&tasaActual?`<div class="kpi-value-bs">Bs ${fmtBs(k.bs*tasaActual)}</div>`:''}
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');
  const maxV = Math.max(...d.ventas_7dias.map(v=>v.total), 1);
  const chartHtml = d.ventas_7dias.length > 0
    ? d.ventas_7dias.map(v => {
        const h = Math.max(5, (v.total/maxV)*120);
        const dia = new Date(v.dia+'T12:00:00').toLocaleDateString('es-ES',{weekday:'short',day:'numeric'});
        return `<div class="bar-col"><div class="bar" style="height:${h}px" title="${dia}: $${fmt(v.total)}"></div><div class="bar-label">${dia}</div></div>`;
      }).join('')
    : '<div style="color:var(--tm);padding:20px;font-size:12px">Sin ventas esta semana</div>';
  const topHtml = d.top_productos.length === 0
    ? '<div class="empty-state"><i class="fas fa-chart-bar"></i><p>Sin ventas aún</p></div>'
    : d.top_productos.map((p,i) => `
        <div class="top-item">
          <div class="top-rank rank-${i<3?i+1:'other'}">${i+1}</div>
          <img class="top-img" src="${p.imagen_url||''}" onerror="this.src='https://via.placeholder.com/34/1a1d30/6c63ff?text=📦'" alt="">
          <div class="top-info"><div class="top-name">${p.nombre}</div><div class="top-amount">${p.tv} uds · $${fmt(p.ing)}</div></div>
          <div class="top-value">${tasaActual?'Bs '+fmtBs(p.ing*tasaActual):'$'+fmt(p.ing)}</div>
        </div>`).join('');
  const maxS = Math.max(...d.categorias_stock.map(c=>c.ts), 1);
  const catHtml = d.categorias_stock.map(c => `
    <div class="cat-item"><div class="cat-label">${c.categoria}</div>
      <div class="cat-bar-wrap"><div class="cat-bar-fill" style="width:${(c.ts/maxS*100).toFixed(0)}%"></div></div>
      <div class="cat-count">${c.ts}</div></div>`).join('');
  const metodosHtml = (d.metodos_pago_mes && d.metodos_pago_mes.length)
    ? d.metodos_pago_mes.map(m => `<div class="metodo-mini-row"><span class="metodo-mini-nombre">${m.nombre}</span><span class="metodo-mini-valor">$${fmt(m.t)}</span></div>`).join('')
    : '<div class="empty-state" style="padding:20px"><i class="fas fa-credit-card"></i><p>Sin ventas este mes</p></div>';

  document.getElementById('page-dashboard').innerHTML = `
    <div class="page-header"><div><h2>Dashboard</h2><p class="page-subtitle">DE TODITO MARKET MyF, C.A</p></div>
      <button class="btn-secondary" onclick="cargarDashboard()"><i class="fas fa-sync-alt"></i> Actualizar</button></div>
    <div class="dash-grid">${kpiHtml}</div>
    <div class="dash-grid-2">
      <div class="card"><div class="card-title"><i class="fas fa-chart-bar"></i> Ventas últimos 7 días</div><div class="mini-chart">${chartHtml}</div></div>
      <div class="card"><div class="card-title"><i class="fas fa-trophy"></i> Top Productos</div>${topHtml}</div>
    </div>
    <div class="dash-grid-2" style="margin-top:14px">
      <div class="card"><div class="card-title"><i class="fas fa-layer-group"></i> Stock por Categoría</div>${catHtml||'<div class="empty-state"><i class="fas fa-box"></i><p>Sin productos</p></div>'}</div>
      <div class="card"><div class="card-title"><i class="fas fa-credit-card"></i> Métodos de Pago — Este Mes</div>${metodosHtml}</div>
    </div>`;
}

// ── INVENTARIO ─────────────────────────────────────
async function cargarInventario() {
  if (!isAdmin) return;
  const search = document.getElementById('inv-search')?.value || '';
  const cat = document.getElementById('inv-categoria')?.value || '';
  const p = new URLSearchParams();
  if (search) p.append('busqueda', search);
  if (cat) p.append('categoria', cat);
  try {
    const res = await fetchAdmin(`/api/productos?${p}`);
    productosCache = await res.json();
    renderProductos(productosCache);
    document.getElementById('filtro-info').textContent = `${productosCache.length} producto${productosCache.length!==1?'s':''}`;
  } catch(e) {}
}
function renderProductos(productos) {
  const grid = document.getElementById('productos-grid');
  if (!productos.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-box-open"></i><p>No hay productos</p><br>
      <button class="btn-primary" onclick="abrirModalProducto()"><i class="fas fa-plus"></i> Agregar</button></div>`;
    return;
  }
  grid.innerHTML = productos.map(p => {
    let sc = 'stock-ok', sl = '✅ En stock';
    if (p.stock <= 0) { sc = 'stock-out'; sl = '❌ Agotado'; }
    else if (p.stock <= p.stock_minimo) { sc = 'stock-low'; sl = '⚠️ Bajo'; }
    else if (p.stock_maximo > 0 && p.stock >= p.stock_maximo) { sc = 'stock-high'; sl = '📈 Exceso'; }
    const mg = p.precio_compra>0?((p.precio_venta-p.precio_compra)/p.precio_compra*100).toFixed(0):0;
    const pvb = tasaActual?`<div class="precio-bs">Bs ${fmtBs(p.precio_venta*tasaActual)}</div>`:'';
    const cod = p.codigo_barras?`<div class="codigo-barras-tag"><i class="fas fa-barcode"></i> ${p.codigo_barras}</div>`:'';
    return `<div class="producto-card">
      <img class="producto-card-img" src="${p.imagen_url||''}" onerror="this.src='https://via.placeholder.com/205x120/141626/6c63ff?text=📦'" alt="${p.nombre}" loading="lazy">
      <div class="producto-card-body">
        <div class="producto-card-cat">${p.categoria}</div>
        <div class="producto-card-name" title="${p.nombre}">${p.nombre}</div>
        <div class="precio-venta">$${fmt(p.precio_venta)}</div>${pvb}
        <div class="precio-compra">Costo: $${fmt(p.precio_compra)} · Margen: ${mg}%</div>${cod}
        <div class="producto-card-stock"><span class="stock-badge ${sc}">${sl}</span><span class="stock-num">${p.stock} ${p.unidad||''}</span></div>
      </div>
      <div class="producto-card-actions">
        <button class="btn-card btn-card-venta" onclick="irAFacturarProducto(${p.id})"><i class="fas fa-cash-register"></i> Vender</button>
        <button class="btn-card btn-card-edit" onclick="editarProducto(${p.id})"><i class="fas fa-pen"></i></button>
        <button class="btn-card btn-card-del" onclick="eliminarProducto(${p.id},'${p.nombre.replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;
  }).join('');
}
function filtrarInventario() { cargarInventario(); }
async function cargarCategorias() {
  const res = await fetch('/api/categorias');
  let cats = await res.json();
  if (!Array.isArray(cats)) cats = [];
  if (!cats.includes('Charcutería')) cats.push('Charcutería');
  cats.sort();
  const sel = document.getElementById('inv-categoria');
  const dl = document.getElementById('lista-categorias');
  if (sel) sel.innerHTML = '<option value="">Todas las categorías</option>' + cats.map(c=>`<option value="${c}">${c}</option>`).join('');
  if (dl) dl.innerHTML = cats.map(c=>`<option value="${c}">`).join('');
}

// ── MODAL PRODUCTO ─────────────────────────────────
function abrirModalProducto(codigoPrellenado) {
  editandoId = null;
  ['prod-id','prod-nombre','prod-categoria','prod-codigo-barras','prod-precio-compra','prod-precio-venta','prod-stock','prod-descripcion'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('prod-stock-min').value = '5';  document.getElementById('prod-stock-max').value = '0';
  const tipoEl = document.getElementById('prod-tipo-medida');
  if (tipoEl) tipoEl.value = 'unidad';
  actualizarUnidadesPorTipo('unidad');
  cargarSelectProveedores('');
  const urlEl = document.getElementById('prod-img-url');
  if (urlEl) urlEl.value = '';
  document.getElementById('prod-img-preview').src = '';
  document.getElementById('prod-img-preview').alt = 'Sin foto';
  const upTxt = document.getElementById('upload-label-txt');
  if (upTxt) upTxt.textContent = 'Subir foto desde la PC';
  _mostrarBtnBorrarFoto(false);
  document.getElementById('hint-compra').textContent = '';
  document.getElementById('hint-venta').textContent = '';
  document.getElementById('modal-prod-titulo').textContent = 'Nuevo Producto';
  if (codigoPrellenado) document.getElementById('prod-codigo-barras').value = codigoPrellenado;
  abrirModal('modal-producto');
}
function editarProducto(id) {
  const p = productosCache.find(x => x.id === id); if (!p) return;
  editandoId = id;
  document.getElementById('prod-id').value = id;
  document.getElementById('prod-nombre').value = p.nombre;
  document.getElementById('prod-categoria').value = p.categoria;
  document.getElementById('prod-codigo-barras').value = p.codigo_barras || '';
  const tipoEl = document.getElementById('prod-tipo-medida');
  if (tipoEl) tipoEl.value = p.tipo_medida || 'unidad';
  actualizarUnidadesPorTipo(p.unidad || 'unidad');
  cargarSelectProveedores(p.proveedor_id || '');
  document.getElementById('prod-precio-compra').value = p.precio_compra;
  document.getElementById('prod-precio-venta').value = p.precio_venta;
  document.getElementById('prod-stock').value = p.stock || 0;
  document.getElementById('prod-stock-min').value = p.stock_minimo;
  document.getElementById('prod-stock-max').value = p.stock_maximo || 0;
  document.getElementById('prod-descripcion').value = p.descripcion || '';
  document.getElementById('prod-img-url').value = p.imagen_url || '';
  document.getElementById('prod-img-preview').src = p.imagen_url || 'https://via.placeholder.com/76x76/1a1d30/6c63ff?text=📦';
  document.getElementById('upload-label-txt').textContent = p.imagen_url ? '✓ Cambiar foto' : 'Subir foto desde mi PC';
  document.getElementById('modal-prod-titulo').textContent = 'Editar Producto';
  actualizarHintsBs();
  abrirModal('modal-producto');
}
function actualizarHintsBs() {
  if (!tasaActual) return;
  const pc = parseFloat(document.getElementById('prod-precio-compra').value) || 0;
  const pv = parseFloat(document.getElementById('prod-precio-venta').value) || 0;
  document.getElementById('hint-compra').textContent = pc>0?`≈ Bs ${fmtBs(pc*tasaActual)}`:'';
  document.getElementById('hint-venta').textContent = pv>0?`≈ Bs ${fmtBs(pv*tasaActual)}`:'';
}

async function guardarProducto() {
  const nombre = document.getElementById('prod-nombre').value.trim();
  if (!nombre) { notificar('El nombre es requerido', 'warning'); return; }
  const data = {
    nombre, categoria: document.getElementById('prod-categoria').value || 'General',
    codigo_barras: document.getElementById('prod-codigo-barras').value.trim(),
    unidad: document.getElementById('prod-unidad').value,
    tipo_medida: document.getElementById('prod-tipo-medida')?.value || 'unidad',
    proveedor_id: document.getElementById('prod-proveedor')?.value || null,
    precio_compra: parseFloat(document.getElementById('prod-precio-compra').value) || 0,
    precio_venta: parseFloat(document.getElementById('prod-precio-venta').value) || 0,    stock: parseFloat(document.getElementById('prod-stock').value) || 0,
    stock_minimo: parseInt(document.getElementById('prod-stock-min').value) || 0,
    stock_maximo: parseInt(document.getElementById('prod-stock-max').value) || 0,
    descripcion: document.getElementById('prod-descripcion').value,
    imagen_url: document.getElementById('prod-img-url').value.trim(),
  };
  try {
    const url = editandoId ? `/api/productos/${editandoId}` : '/api/productos';
    const method = editandoId ? 'PUT' : 'POST';
    const res = await fetchAdmin(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    const d = await res.json();
    if (!res.ok) { notificar(d.error || 'Error al guardar', 'error'); return; }
    notificar(editandoId ? 'Producto actualizado ✓' : 'Producto agregado ✓', 'success');
    cerrarModal('modal-producto');
    cargarInventario(); cargarCategorias(); cargarDashboard(); cargarProductosVenta();
  } catch(e) {}
}
function eliminarProducto(id, nombre) {
  confirmarModal(`¿Eliminar "${nombre}"? Esta acción no se puede deshacer.`, async () => {
    try {
      const res = await fetchAdmin(`/api/productos/${id}`, {method:'DELETE'});
      const d = await res.json();
      if (!res.ok) { notificar(d.error || 'No se pudo eliminar', 'error'); return; }
      notificar(`"${nombre}" eliminado`, 'warning');
      cargarInventario(); cargarDashboard(); cargarProductosVenta();
    } catch(e) { notificar('Error al eliminar', 'error'); }
  });
}

// ── BUSCAR INFO POR CÓDIGO ──────────────────────────
async function buscarInfoPorCodigo() {
  const codigo = document.getElementById('prod-codigo-barras')?.value.trim();
  if (!codigo) { notificar('Escanea o escribe un código primero', 'warning'); return; }
  if (!isAdmin) { notificar('Inicia sesión de administrador para buscar info', 'warning'); return; }
  const btn = document.getElementById('btn-buscar-info-codigo');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Buscando...'; }
  try {
    const res = await fetchAdmin(`/api/productos/buscar-info-codigo/${encodeURIComponent(codigo)}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      notificar(d.error || 'No se pudo buscar (¿sesión admin?)', 'error');
      return;
    }
    if (d.encontrado && d.nombre) {
      const nomEl = document.getElementById('prod-nombre');
      if (nomEl) {
        // Rellena si está vacío; si ya hay texto, pregunta implícitamente sobrescribiendo solo si corto
        if (!nomEl.value.trim()) nomEl.value = d.nombre;
        else if (nomEl.value.trim().length < 3) nomEl.value = d.nombre;
        else nomEl.value = d.nombre; // el usuario pidió que funcione: aplicar nombre encontrado
      }
      notificar(`Encontrado: ${d.nombre}`, 'success');
    } else {
      notificar(d.mensaje || 'No se encontró info para ese código. Complétalo a mano.', 'warning');
    }
  } catch (e) {
    console.error(e);
    notificar('Error de red al buscar el código. Revisa internet.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origHtml || '<i class="fas fa-magnifying-glass"></i> Buscar info'; }
  }
}

// ── CÁMARA DE ESTA PC ────────────────────────────────
async function abrirScannerCamara(callback) {
  _scannerCallback = callback;
  abrirModal('modal-scanner-camara');
  // Formatos de código de barras de tienda (no solo QR)
  let formats = undefined;
  try {
    if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
      formats = [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.CODE_93,
        Html5QrcodeSupportedFormats.ITF,
        Html5QrcodeSupportedFormats.QR_CODE,
      ];
    }
  } catch (e) {}
  const config = {
    fps: 15,
    qrbox: { width: 300, height: 180 },
    aspectRatio: 1.777,
    disableFlip: false,
  };
  if (formats) config.formatsToSupport = formats;
  const onSuccess = (decodedText) => {
    const codigo = String(decodedText || '').trim();
    if (!codigo) return;
    cerrarScannerCamara();
    if (_scannerCallback) _scannerCallback(codigo);
  };
  const onScanError = () => {};
  try {
    html5QrCodeInstance = new Html5Qrcode("camara-reader");
    try {
      await html5QrCodeInstance.start({ facingMode: "environment" }, config, onSuccess, onScanError);
    } catch (e1) {
      try {
        await html5QrCodeInstance.start({ facingMode: "user" }, config, onSuccess, onScanError);
      } catch (e2) {
        const cams = await Html5Qrcode.getCameras();
        if (cams && cams.length) await html5QrCodeInstance.start(cams[0].id, config, onSuccess, onScanError);
        else throw new Error('Sin cámara disponible');
      }
    }
  } catch (err) {
    console.error(err);
    notificar('No se pudo iniciar el escáner. Usa el lector USB o escribe el código.', 'error');
    cerrarScannerCamara();
  }
}
function cerrarScannerCamara() {
  if (html5QrCodeInstance) {
    const inst = html5QrCodeInstance; html5QrCodeInstance = null;
    inst.stop().then(() => inst.clear()).catch(() => {});
  }
  cerrarModal('modal-scanner-camara');
}
function codigoEscaneadoParaProducto(codigo) {
  document.getElementById('prod-codigo-barras').value = codigo;
  buscarInfoPorCodigo();
}

// ── IMAGEN ───────────────────────────────────────────
function cargarImagenLocal(event) {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 5*1024*1024) { notificar('Máximo 5MB', 'warning'); return; }
  const reader = new FileReader();
  reader.onload = async e => {
    const b64 = e.target.result;
    document.getElementById('prod-img-preview').src = b64;
    document.getElementById('upload-label-txt').textContent = '✓ ' + file.name;
    try {
      const nombre = document.getElementById('prod-nombre').value.trim() || 'producto';
      const res = await fetchAdmin('/api/subir-imagen', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({imagen_b64:b64, nombre})});
      const d = await res.json();
      document.getElementById('prod-img-url').value = d.url || b64;
    } catch { document.getElementById('prod-img-url').value = b64; }
    _mostrarBtnBorrarFoto(true);
    notificar('Foto cargada ✓', 'success');
  };
  reader.readAsDataURL(file);
}


let _fotoProdStream = null;

async function abrirCamaraFotoProducto() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notificar('Este navegador no permite usar la cámara', 'error');
      return;
    }
    abrirModal('modal-foto-producto');
    const video = document.getElementById('foto-prod-video');
    _fotoProdStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = _fotoProdStream;
    await video.play();
  } catch (e) {
    console.error(e);
    notificar('No se pudo abrir la cámara. Revisa los permisos del navegador.', 'error');
    cerrarCamaraFotoProducto();
  }
}

function cerrarCamaraFotoProducto() {
  if (_fotoProdStream) {
    _fotoProdStream.getTracks().forEach(tr => tr.stop());
    _fotoProdStream = null;
  }
  const video = document.getElementById('foto-prod-video');
  if (video) video.srcObject = null;
  cerrarModal('modal-foto-producto');
}

async function capturarFotoProducto() {
  const video = document.getElementById('foto-prod-video');
  const canvas = document.getElementById('foto-prod-canvas');
  if (!video || !canvas || !video.videoWidth) {
    notificar('Espera a que la cámara cargue', 'warning');
    return;
  }
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  const b64 = canvas.toDataURL('image/jpeg', 0.85);
  document.getElementById('prod-img-preview').src = b64;
  const up = document.getElementById('upload-label-txt');
  if (up) up.textContent = '✓ Foto de cámara';
  try {
    const nombre = document.getElementById('prod-nombre').value.trim() || 'producto';
    const res = await fetchAdmin('/api/subir-imagen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagen_b64: b64, nombre })
    });
    const d = await res.json();
    document.getElementById('prod-img-url').value = d.url || b64;
  } catch (e) {
    document.getElementById('prod-img-url').value = b64;
  }
  _mostrarBtnBorrarFoto(true);
  notificar('Foto capturada ✓', 'success');
  cerrarCamaraFotoProducto();
}

function borrarFotoProducto() {
  const prev = document.getElementById('prod-img-preview');
  if (prev) { prev.src = ''; prev.removeAttribute('src'); prev.alt = 'Sin foto'; }
  const url = document.getElementById('prod-img-url');
  if (url) url.value = '';
  const up = document.getElementById('upload-label-txt');
  if (up) up.textContent = 'Subir foto desde la PC';
  const file = document.getElementById('input-file-hidden');
  if (file) file.value = '';
  _mostrarBtnBorrarFoto(false);
  notificar('Foto eliminada', 'warning');
}

function _mostrarBtnBorrarFoto(show) {
  const btn = document.getElementById('btn-borrar-foto');
  if (btn) btn.style.display = show ? 'inline-flex' : 'none';
}

function previewImagen() {
  const url = document.getElementById('prod-img-url').value;
  if (url) document.getElementById('prod-img-preview').src = url;
}

// ── MÉTODOS DE PAGO ──────────────────────────────────
async function cargarMetodosPagoPOS() {
  try {
    const res = await fetch('/api/metodos-pago?solo_activos=1');
    metodosPagoCache = await res.json();
    if (metodoPagoSeleccionado && !metodosPagoCache.some(m => m.id === metodoPagoSeleccionado)) metodoPagoSeleccionado = null;
    renderMetodoPagoBotones();
  } catch(e) {}
}
function renderMetodoPagoBotones() {
  const cont = document.getElementById('pos-metodo-botones');
  if (!cont) return;
  if (!metodosPagoCache.length) {
    cont.innerHTML = `<span style="color:var(--tm);font-size:12px">Sin métodos de pago activos. Un administrador debe crear uno en "Métodos de Pago".</span>`;
    return;
  }
  cont.innerHTML = metodosPagoCache.map(m => `<button type="button" class="metodo-pago-btn ${metodoPagoSeleccionado===m.id?'selected':''}" onclick="seleccionarMetodoPago(${m.id})">${m.nombre}</button>`).join('');
  renderMetodoPagoExtra();
}
function seleccionarMetodoPago(id) {
  metodoPagoSeleccionado = id;
  const conf = document.getElementById('pos-pago-confirmado');
  if (conf) conf.checked = false;
  renderMetodoPagoBotones();
}
function togglePagoEnPartes() {
  const cb = document.getElementById('pos-pago-en-partes');
  pagoEnPartes = !!(cb && cb.checked);
  if (!pagoEnPartes) {
    posPagos = [];
  }
  const conf = document.getElementById('pos-pago-confirmado');
  if (conf) conf.checked = false;
  renderMetodoPagoExtra();
  renderPagosLista();
}

function _tipoMetodoPago(metodo) {
  const n = (metodo?.nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (metodo?.requiere_datos_moviles || n.includes('movil') || n.includes('pago movil')) return 'movil';
  if (n.includes('efectivo')) return 'efectivo';
  if (n.includes('punto')) return 'punto';
  if (n.includes('biopago') || n.includes('bio pago')) return 'biopago';
  return 'otro';
}
function _totalCarrito() {
  return posCarrito.reduce((s, i) => s + (parseFloat(i.precio_unitario)||0) * (parseFloat(i.cantidad)||0), 0);
}
function _montoEnUSD(monto, moneda) {
  monto = parseFloat(monto) || 0;
  if (!monto) return 0;
  if ((moneda || 'USD').toUpperCase() === 'BS' || (moneda || '').toUpperCase() === 'VES') {
    if (!tasaActual || tasaActual <= 0) {
      notificar('Define la tasa del dólar para cobrar en bolívares', 'warning');
      return null;
    }
    return Math.round((monto / tasaActual) * 100) / 100;
  }
  return Math.round(monto * 100) / 100;
}
function _restanteEnMoneda(moneda) {
  const restUSD = _restantePagar();
  if ((moneda || 'USD').toUpperCase() === 'BS' || (moneda || '').toUpperCase() === 'VES') {
    if (!tasaActual || tasaActual <= 0) return restUSD;
    return Math.round(restUSD * tasaActual * 100) / 100;
  }
  return restUSD;
}
function _sumaPagos() {
  return posPagos.reduce((s, p) => s + (parseFloat(p.monto_usd != null ? p.monto_usd : p.monto) || 0), 0);
}
function _restantePagar() {
  return Math.max(0, Math.round((_totalCarrito() - _sumaPagos()) * 100) / 100);
}
function renderMetodoPagoExtra() {
  const cont = document.getElementById('pos-metodo-extra');
  const btnAdd = document.getElementById('btn-add-pago');
  const metodo = metodosPagoCache.find(m => m.id === metodoPagoSeleccionado);
  if (!metodo) {
    if (cont) cont.innerHTML = '';
    if (btnAdd) btnAdd.style.display = 'none';
    const confWrap = document.getElementById('pos-pago-confirm-wrap');
    if (confWrap && !posPagos.length) confWrap.style.display = 'none';
    renderPagosLista();
    return;
  }
  const tipo = _tipoMetodoPago(metodo);
  if (btnAdd) btnAdd.style.display = pagoEnPartes ? 'inline-flex' : 'none';
  const confWrap = document.getElementById('pos-pago-confirm-wrap');
  if (confWrap) confWrap.style.display = 'flex';

  // Bloque moneda + monto (USD o Bs)
  const monedaBlock = `
    <div class="form-group" style="margin-top:10px"><label>Moneda del monto *</label>
      <div class="metodo-pago-botones" style="margin-top:6px">
        <button type="button" class="metodo-pago-btn selected" id="btn-moneda-usd" onclick="seleccionarMonedaPago('USD')">Dólares (USD)</button>
        <button type="button" class="metodo-pago-btn" id="btn-moneda-bs" onclick="seleccionarMonedaPago('BS')">Bolívares (Bs)</button>
      </div>
      <input type="hidden" id="pos-pago-moneda" value="USD">
    </div>
    <div class="form-group"><label id="label-pos-monto">Monto *</label>
      <input type="number" id="pos-pago-monto" step="0.01" min="0.01" inputmode="decimal" placeholder="0.00">
      <div class="precio-bs-hint" id="hint-pago-monto"></div>
    </div>
    <button type="button" class="btn-secondary btn-sm" id="btn-mostrar-vuelto" onclick="toggleVuelto()" style="margin-top:8px;display:none">
      <i class="fas fa-calculator"></i> Calcular vuelto
    </button>
    <div id="vuelto-section" class="vuelto-section" style="display:none;margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg3)">
      <label style="font-size:12px;font-weight:700;display:block;margin-bottom:6px"><i class="fas fa-calculator"></i> Calcular vuelto (billete mayor)</label>
      <div class="form-group" style="margin-bottom:6px">
        <label id="label-recibido" style="font-size:11px">Billete / cantidad recibida</label>
        <input type="number" id="pos-pago-recibido" step="0.01" min="0" inputmode="decimal" placeholder="Ej: 5.00" oninput="calcularVuelto()">
      </div>
      <div id="vuelto-resultado" class="vuelto-resultado" style="font-size:13px;font-weight:700;margin-top:6px"></div>
    </div>`;

  let extra = '';
  if (tipo === 'movil') {
    const tieneD = metodo.datos_cedula || metodo.datos_banco || metodo.datos_telefono;
    const infoDatos = tieneD
      ? `<i class="fas fa-circle-info"></i><span>Dale al cliente: ${metodo.datos_cedula?`<strong>Cédula:</strong> ${metodo.datos_cedula} `:''}${metodo.datos_banco?`<strong>Banco:</strong> ${metodo.datos_banco} `:''}${metodo.datos_telefono?`<strong>Tel:</strong> ${metodo.datos_telefono}`:''}</span>`
      : `<i class="fas fa-circle-info"></i><span class="metodo-info-faltan">Configura tus datos en Administración → Métodos de Pago</span>`;
    extra = `<div class="metodo-info-box">${infoDatos}</div>
      <div class="form-group"><label>Referencia del cliente *</label>
        <input type="text" id="pos-pago-referencia" placeholder="Número de referencia" inputmode="numeric" autocomplete="off"></div>`;
  } else if (tipo === 'punto' || tipo === 'biopago') {
    extra = `<div class="form-group"><label>Referencia / aprobación *</label>
      <input type="text" id="pos-pago-referencia" placeholder="Nº de referencia o aprobación" autocomplete="off"></div>`;
  } else if (tipo === 'efectivo') {
    extra = ''; // solo moneda + monto
  } else {
    extra = `<div class="form-group"><label>Referencia (opcional)</label>
      <input type="text" id="pos-pago-referencia" placeholder="Nº de aprobación..." autocomplete="off"></div>`;
  }

  cont.innerHTML = monedaBlock + extra;
  // Punto: solo bolívares. Resto: USD por defecto (pueden cambiar).
  const tipoIni = _tipoMetodoPago(metodo);
  const btnVuelto = document.getElementById('btn-mostrar-vuelto');
  const vueltoSec = document.getElementById('vuelto-section');
  if (btnVuelto) btnVuelto.style.display = (tipoIni === 'efectivo') ? 'inline-flex' : 'none';
  if (vueltoSec) vueltoSec.style.display = 'none'; // siempre oculto al inicio
  if (tipoIni === 'punto') {
    // ocultar botón USD si existe y forzar BS
    seleccionarMonedaPago('BS');
    const btnUsd = document.getElementById('btn-moneda-usd');
    if (btnUsd) btnUsd.style.display = 'none';
  } else {
    seleccionarMonedaPago('USD');
  }
  renderPagosLista();
}
function seleccionarMonedaPago(moneda) {
  const inp = document.getElementById('pos-pago-moneda');
  if (inp) inp.value = moneda;
  const usd = document.getElementById('btn-moneda-usd');
  const bs = document.getElementById('btn-moneda-bs');
  if (usd) usd.classList.toggle('selected', moneda === 'USD');
  if (bs) bs.classList.toggle('selected', moneda === 'BS');
  const rest = _restanteEnMoneda(moneda);
  const montoInp = document.getElementById('pos-pago-monto');
  const label = document.getElementById('label-pos-monto');
  const hint = document.getElementById('hint-pago-monto');
  if (label) label.textContent = moneda === 'BS' ? 'Monto en bolívares (Bs) *' : 'Monto en dólares (USD) *';
  if (montoInp) {
    montoInp.value = rest ? rest.toFixed(2) : '';
    montoInp.placeholder = rest ? rest.toFixed(2) : '0.00';
  }
  if (hint) {
    if (moneda === 'BS' && tasaActual) {
      hint.textContent = `Equivale a ≈ $${fmt(_restantePagar())} del total · Tasa: ${fmtBs(tasaActual)} Bs/$`;
    } else if (moneda === 'USD' && tasaActual) {
      hint.textContent = `Equivale a ≈ Bs ${fmtBs(_restantePagar() * tasaActual)}`;
    } else {
      hint.textContent = moneda === 'BS' ? 'Define la tasa del dólar para usar bolívares' : '';
    }
  }
}
function seleccionarMonedaEfectivo(moneda) { seleccionarMonedaPago(moneda); }


function toggleVuelto() {
  const sec = document.getElementById('vuelto-section');
  const btn = document.getElementById('btn-mostrar-vuelto');
  if (!sec) return;
  const visible = sec.style.display !== 'none';
  sec.style.display = visible ? 'none' : 'block';
  if (btn) btn.innerHTML = visible
    ? '<i class="fas fa-calculator"></i> Calcular vuelto'
    : '<i class="fas fa-times"></i> Ocultar vuelto';
  if (!visible) {
    const inp = document.getElementById('pos-pago-recibido');
    if (inp) inp.focus();
  }
}

function calcularVuelto() {
  const recibidoInp = document.getElementById('pos-pago-recibido');
  const resEl = document.getElementById('vuelto-resultado');
  const monedaEl = document.getElementById('pos-pago-moneda');
  if (!recibidoInp || !resEl) return;
  const recibido = parseFloat(recibidoInp.value) || 0;
  const moneda = (monedaEl?.value || 'USD').toUpperCase();
  const totalUSD = _restantePagar();
  if (recibido <= 0) { resEl.innerHTML = ''; return; }

  let totalEnMoneda = totalUSD;
  if (moneda === 'BS' || moneda === 'VES') {
    if (!tasaActual || tasaActual <= 0) {
      resEl.innerHTML = '<span style="color:var(--orange)">Define la tasa del dólar para calcular en Bs</span>';
      return;
    }
    totalEnMoneda = Math.round(totalUSD * tasaActual * 100) / 100;
  }

  const vuelto = Math.round((recibido - totalEnMoneda) * 100) / 100;
  if (vuelto < -0.009) {
    resEl.innerHTML = `<span style="color:var(--red)">Falta $${fmt(Math.abs(vuelto))} ${moneda === 'BS' ? 'Bs' : ''}</span>`;
    return;
  }
  if (Math.abs(vuelto) < 0.009) {
    resEl.innerHTML = '<span style="color:var(--green)">Pago exacto — sin vuelto</span>';
    return;
  }

  let vueltoUSD, vueltoBs;
  if (moneda === 'BS' || moneda === 'VES') {
    vueltoBs = vuelto;
    vueltoUSD = tasaActual ? Math.round((vuelto / tasaActual) * 100) / 100 : null;
  } else {
    vueltoUSD = vuelto;
    vueltoBs = tasaActual ? Math.round(vuelto * tasaActual * 100) / 100 : null;
  }

  let html = `<div style="color:var(--green)">Devolver:</div>`;
  html += `<div style="font-size:16px;margin-top:2px">$${fmt(vueltoUSD)}</div>`;
  if (vueltoBs != null) {
    html += `<div style="font-size:14px;color:var(--orange)">≈ Bs ${fmtBs(vueltoBs)}</div>`;
  }
  resEl.innerHTML = html;
}

function _leerPagoFormulario() {
  const metodo = metodosPagoCache.find(m => m.id === metodoPagoSeleccionado);
  if (!metodo) return null;
  const tipo = _tipoMetodoPago(metodo);
  const ref = document.getElementById('pos-pago-referencia')?.value.trim() || '';
  const moneda = (document.getElementById('pos-pago-moneda')?.value.trim() || 'USD').toUpperCase();
  let montoIngresado = parseFloat(document.getElementById('pos-pago-monto')?.value);
  if (!montoIngresado || montoIngresado <= 0) {
    montoIngresado = _restanteEnMoneda(moneda);
  }
  if (tipo === 'movil' && !ref) { notificar('Falta la referencia del cliente', 'warning'); return null; }
  if ((tipo === 'punto' || tipo === 'biopago') && !ref) { notificar('Falta la referencia / aprobación', 'warning'); return null; }
  if (!montoIngresado || montoIngresado <= 0) { notificar('Indica cuánto pagó el cliente', 'warning'); return null; }
  if (moneda === 'BS' && (!tasaActual || tasaActual <= 0)) {
    notificar('Pon la tasa del dólar para cobrar en bolívares', 'warning'); return null;
  }
  const monto_usd = _montoEnUSD(montoIngresado, moneda);
  if (monto_usd == null) return null;
  return {
    metodo_pago_id: metodo.id,
    nombre: metodo.nombre,
    tipo,
    referencia: ref,
    moneda,
    monto: Math.round(montoIngresado * 100) / 100, // valor ingresado (USD o Bs)
    monto_usd, // siempre en dólares para cuadrar con la venta
  };
}
function agregarPagoActual() {
  const pago = _leerPagoFormulario();
  if (!pago) return;
  const restante = _restantePagar();
  const usd = pago.monto_usd != null ? pago.monto_usd : pago.monto;
  if (usd > restante + 0.009) {
    notificar(`El monto supera lo que falta ($${fmt(restante)})`, 'warning');
    return;
  }
  posPagos.push(pago);
  metodoPagoSeleccionado = null;
  renderMetodoPagoBotones();
  renderPagosLista();
  const det = pago.moneda === 'BS' ? `Bs ${fmtBs(pago.monto)} (≈$${fmt(usd)})` : `$${fmt(usd)}`;
  notificar(`Pago agregado: ${pago.nombre} ${det}. El resto se sugerirá en el siguiente pago.`, 'success');
}
function quitarPago(idx) {
  posPagos.splice(idx, 1);
  renderPagosLista();
  renderMetodoPagoExtra();
}
function renderPagosLista() {
  const lista = document.getElementById('pos-pagos-lista');
  const res = document.getElementById('pos-pagos-resumen');
  if (!lista) return;
  if (!posPagos.length) {
    lista.innerHTML = '';
    if (res) res.style.display = 'none';
    return;
  }
  lista.innerHTML = posPagos.map((p, i) => {
    const usd = p.monto_usd != null ? p.monto_usd : p.monto;
    const det = (p.moneda === 'BS') ? `Bs ${fmtBs(p.monto)} (≈$${fmt(usd)})` : `$${fmt(usd)}`;
    return `<div class="pos-pago-chip">
      <span><strong>${p.nombre}</strong> · ${det}
        ${p.referencia ? ` · Ref ${p.referencia}` : ''}
      </span>
      <button type="button" title="Quitar" onclick="quitarPago(${i})"><i class="fas fa-times"></i></button>
    </div>`;
  }).join('');
  const total = _totalCarrito();
  const suma = _sumaPagos();
  const falta = Math.round((total - suma) * 100) / 100;
  if (res) {
    res.style.display = 'block';
    res.innerHTML = falta > 0.009
      ? `Pagado: <strong>$${fmt(suma)}</strong> · Falta: <strong style="color:var(--orange)">$${fmt(falta)}</strong>`
      : `Pagado: <strong style="color:var(--green)">$${fmt(suma)}</strong> · Completo ✓`;
  }
}

async function cargarMetodosPagoAdmin() {
  if (!isAdmin) return;
  try {
    const res = await fetchAdmin('/api/metodos-pago');
    metodosPagoAdminCache = await res.json();
    renderMetodosPagoAdmin(metodosPagoAdminCache);
  } catch(e) {}
}
function renderMetodosPagoAdmin(metodos) {
  const cont = document.getElementById('metodos-pago-lista');
  if (!metodos.length) { cont.innerHTML = `<div class="empty-state"><i class="fas fa-credit-card"></i><p>Sin métodos de pago</p></div>`; return; }
  cont.innerHTML = metodos.map(m => {
    const datosTxt = m.requiere_datos_moviles
      ? `<div class="metodo-pago-datos">${(m.datos_cedula||m.datos_banco||m.datos_telefono)
          ? `${m.datos_cedula?`<strong>Cédula:</strong> ${m.datos_cedula}<br>`:''}${m.datos_banco?`<strong>Banco:</strong> ${m.datos_banco}<br>`:''}${m.datos_telefono?`<strong>Tel:</strong> ${m.datos_telefono}`:''}`
          : 'Faltan tus datos — edita para agregarlos'}</div>`
      : '';
    return `<div class="metodo-pago-card">
      <div class="metodo-pago-top">
        <div class="metodo-pago-icon"><i class="fas fa-credit-card"></i></div>
        <div class="metodo-pago-info"><div class="metodo-pago-nombre">${m.nombre}</div><div class="metodo-pago-estado ${m.activo?'activo':'inactivo'}">${m.activo?'● Activo':'○ Inactivo'}</div></div>
        <div class="metodo-pago-acciones">
          <button onclick='editarMetodoPago(${JSON.stringify(m)})' title="Editar"><i class="fas fa-pen"></i></button>
          <button onclick="toggleActivoMetodoPago(${m.id},${m.activo?0:1})" title="${m.activo?'Desactivar':'Activar'}"><i class="fas fa-power-off"></i></button>
          <button class="del-btn" onclick="eliminarMetodoPago(${m.id},'${m.nombre.replace(/'/g,"\\'")}')" title="Eliminar"><i class="fas fa-trash"></i></button>
        </div>
      </div>${datosTxt}
    </div>`;
  }).join('');
}
function abrirModalMetodoPago() {
  document.getElementById('metodo-id').value = '';
  document.getElementById('metodo-nombre').value = '';
  document.getElementById('metodo-requiere-moviles').checked = false;
  document.getElementById('metodo-datos-cedula').value = '';
  document.getElementById('metodo-datos-banco').value = '';
  document.getElementById('metodo-datos-telefono').value = '';
  document.getElementById('metodo-datos-fijos').style.display = 'none';
  document.getElementById('modal-metodo-titulo').textContent = 'Nuevo Método de Pago';
  abrirModal('modal-metodo-pago');
}
function editarMetodoPago(m) {
  document.getElementById('metodo-id').value = m.id;
  document.getElementById('metodo-nombre').value = m.nombre;
  document.getElementById('metodo-requiere-moviles').checked = !!m.requiere_datos_moviles;
  document.getElementById('metodo-datos-cedula').value = m.datos_cedula || '';
  document.getElementById('metodo-datos-banco').value = m.datos_banco || '';
  document.getElementById('metodo-datos-telefono').value = m.datos_telefono || '';
  document.getElementById('metodo-datos-fijos').style.display = m.requiere_datos_moviles ? 'block' : 'none';
  document.getElementById('modal-metodo-titulo').textContent = 'Editar Método de Pago';
  abrirModal('modal-metodo-pago');
}
function toggleMetodoDatosFijos() {
  document.getElementById('metodo-datos-fijos').style.display = document.getElementById('metodo-requiere-moviles').checked ? 'block' : 'none';
}
async function guardarMetodoPago() {
  const id = document.getElementById('metodo-id').value;
  const nombre = document.getElementById('metodo-nombre').value.trim();
  if (!nombre) { notificar('Escribe un nombre', 'warning'); return; }
  const body = {
    nombre,
    requiere_datos_moviles: document.getElementById('metodo-requiere-moviles').checked,
    datos_cedula: document.getElementById('metodo-datos-cedula').value.trim(),
    datos_banco: document.getElementById('metodo-datos-banco').value.trim(),
    datos_telefono: document.getElementById('metodo-datos-telefono').value.trim(),
  };
  try {
    const url = id ? `/api/metodos-pago/${id}` : '/api/metodos-pago';
    const method = id ? 'PUT' : 'POST';
    const res = await fetchAdmin(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    if (!res.ok) { notificar(d.error || 'Error', 'error'); return; }
    notificar(id ? 'Método actualizado ✓' : 'Método agregado ✓', 'success');
    cerrarModal('modal-metodo-pago');
    cargarMetodosPagoAdmin(); cargarMetodosPagoPOS();
  } catch(e) {}
}
async function toggleActivoMetodoPago(id, nuevoEstado) {
  try {
    await fetchAdmin(`/api/metodos-pago/${id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({activo: nuevoEstado})});
    cargarMetodosPagoAdmin(); cargarMetodosPagoPOS();
    notificar(nuevoEstado ? 'Método activado ✓' : 'Método desactivado ✓', 'success');
  } catch(e) {}
}
function eliminarMetodoPago(id, nombre) {
  confirmarModal(`¿Eliminar "${nombre}"? Si ya se usó en ventas, se desactivará en vez de borrarse.`, async () => {
    try {
      const res = await fetchAdmin(`/api/metodos-pago/${id}`, {method:'DELETE'});
      const d = await res.json();
      notificar(d.desactivado ? `"${nombre}" desactivado (ya tenía ventas)` : `"${nombre}" eliminado`, 'warning');
      cargarMetodosPagoAdmin(); cargarMetodosPagoPOS();
    } catch(e) {}
  });
}

// ── FACTURACIÓN / POS ────────────────────────────────
async function cargarProductosVenta() {
  const res = await fetch('/api/productos/venta');
  posProductosCache = await res.json();
  const sel = document.getElementById('pos-select-prod');
  if (sel) {
    sel.innerHTML = '<option value="">— Buscar producto —</option>' +
      posProductosCache.map(p => `<option value="${p.id}" data-precio="${p.precio_venta}" data-stock="${p.stock}" data-img="${p.imagen_url||''}" data-nombre="${p.nombre}" data-unidad="${p.unidad||''}">${p.nombre} ${p.stock<=0 ? '(Agotado)' : `(${p.stock} ${p.unidad||''} disp.)`}</option>`).join('');
  }
}
function enfocarBarcode() {
  const input = document.getElementById('pos-barcode-input');
  if (input) setTimeout(() => { try { input.focus(); input.select(); } catch(e) {} }, 80);
}

// Lector USB (Roccia y similares): actúan como teclado.
// Escriben el código muy rápido y suelen terminar con Enter.
let _bcBuffer = '';
let _bcLastKey = 0;
let _bcTimer = null;
// Evita que el lector (o la cámara) registre el mismo código muchas veces seguidas
let _bcBloqueoHasta = 0;
const BC_COOLDOWN_MS = 800; // 0.8s entre lecturas de pistola

async function _procesarCodigoBarras(codigo) {
  codigo = String(codigo || '').replace(/[\r\n\t]/g, '').trim();
  if (!codigo || codigo.length < 3) return;

  const ahora = Date.now();
  if (ahora < _bcBloqueoHasta) {
    const bcInput = document.getElementById('pos-barcode-input');
    if (bcInput) bcInput.value = '';
    return;
  }

  const bcInput = document.getElementById('pos-barcode-input');
  if (bcInput) bcInput.value = '';
  // Marcar cooldown ANTES de buscar para ignorar lecturas repetidas del pistola
  _bcBloqueoHasta = Date.now() + BC_COOLDOWN_MS;
  await posBuscarPorCodigo(codigo, true); // true = ya aplicó cooldown
  enfocarBarcode();
}

function setupPosBarcodeListener() {
  const bcInput = document.getElementById('pos-barcode-input');
  if (!bcInput) return;

  // Enter desde lector USB o teclado
  bcInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const codigo = bcInput.value.trim();
      if (codigo) await _procesarCodigoBarras(codigo);
      return;
    }
  });

  // Algunos lectores mandan Tab al final
  bcInput.addEventListener('keydown', async e => {
    if (e.key === 'Tab' && bcInput.value.trim().length >= 4) {
      e.preventDefault();
      await _procesarCodigoBarras(bcInput.value);
    }
  });

  // Captura global: si el foco no está en un input de texto, el lector igual escribe
  document.addEventListener('keypress', e => {
    const page = document.getElementById('page-facturacion');
    if (!page || !page.classList.contains('active')) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    const esInput = tag === 'input' || tag === 'textarea' || tag === 'select';
    // Si está escribiendo en otro campo (notas, cantidad), no interferir
    if (esInput && e.target.id !== 'pos-barcode-input') return;

    const now = Date.now();
    // Caracteres rápidos = lector de pistola
    if (now - _bcLastKey > 80) _bcBuffer = '';
    _bcLastKey = now;

    if (e.key === 'Enter') {
      if (_bcBuffer.length >= 3) {
        e.preventDefault();
        const code = _bcBuffer;
        _bcBuffer = '';
        _procesarCodigoBarras(code);
      }
      return;
    }
    if (e.key && e.key.length === 1) {
      _bcBuffer += e.key;
      if (!esInput || e.target.id === 'pos-barcode-input') {
        // reflejar en el input visible
        if (bcInput && document.activeElement !== bcInput) {
          bcInput.value = _bcBuffer;
        }
      }
      clearTimeout(_bcTimer);
      // Si el lector no manda Enter, procesar tras una pausa corta
      _bcTimer = setTimeout(() => {
        if (_bcBuffer.length >= 8) {
          const code = _bcBuffer;
          _bcBuffer = '';
          _procesarCodigoBarras(code);
        }
      }, 120);
    }
  });

  // Al hacer clic en el área de facturación, enfocar el campo del lector
  const pageFact = document.getElementById('page-facturacion');
  if (pageFact) {
    pageFact.addEventListener('click', e => {
      const t = e.target;
      if (t.closest('input, textarea, select, button, a, .modal-overlay')) return;
      enfocarBarcode();
    });
  }
}
async function posBuscarPorCodigo(codigo, desdeProcesar) {
  codigo = String(codigo || '').replace(/[\r\n\t]/g, '').trim();
  if (!codigo) return;
  // Si viene de la cámara (no de _procesarCodigoBarras), aplicar cooldown aquí
  if (!desdeProcesar) {
    const ahora = Date.now();
    if (typeof _bcBloqueoHasta !== 'undefined' && ahora < _bcBloqueoHasta) return;
    if (typeof _bcBloqueoHasta !== 'undefined') _bcBloqueoHasta = ahora + (typeof BC_COOLDOWN_MS !== 'undefined' ? BC_COOLDOWN_MS : 800);
  }

  try {
    const res = await fetch(`/api/productos/codigo/${encodeURIComponent(codigo)}`);
    const d = await res.json();
    if (!res.ok) { manejarCodigoNoEncontrado(codigo); return; }
    posAgregarProducto(d.id, d.nombre, d.precio_venta, d.stock, d.imagen_url, 1, d.unidad);
  } catch(e) { notificar('Error al buscar código', 'error'); }
}
function manejarCodigoNoEncontrado(codigo) {
  if (isAdmin) {
    notificar(`Código ${codigo} no registrado. Completa los datos para agregarlo.`, 'warning');
    abrirModalProducto(codigo);
    setTimeout(() => buscarInfoPorCodigo(), 300);
  } else {
    notificar(`Código ${codigo} no está registrado. Solicita a un administrador que lo agregue.`, 'warning');
  }
}
function posAgregarSeleccionado() {
  const sel = document.getElementById('pos-select-prod');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) { notificar('Selecciona un producto', 'warning'); return; }
  const cant = parseFloat(document.getElementById('pos-cantidad').value) || 1;
  const precioUnidad = parseFloat(opt.dataset.precio) || 0;
  const precioCaja = parseFloat(opt.dataset.precioCaja) || 0;
  const unidadesCaja = parseInt(opt.dataset.unidadesCaja) || 0;
  if (precioCaja > 0 && unidadesCaja > 0) {
    const usarCaja = confirm('¿Vender por CAJA ($' + fmt(precioCaja) + ') o por UNIDAD ($' + fmt(precioUnidad) + ')?\n\nOK = Caja\nCancelar = Unidad');
    if (usarCaja) {
      posAgregarProducto(parseInt(opt.value), opt.dataset.nombre + ' (caja)', precioCaja, parseFloat(opt.dataset.stock)||0, opt.dataset.img, cant, 'caja', cant);
    } else {
      const descuenta = cant / unidadesCaja;
      posAgregarProducto(parseInt(opt.value), opt.dataset.nombre, precioUnidad, parseFloat(opt.dataset.stock)||0, opt.dataset.img, cant, opt.dataset.unidad || 'u', descuenta);
    }
  } else {
    posAgregarProducto(parseInt(opt.value), opt.dataset.nombre, precioUnidad, parseFloat(opt.dataset.stock)||0, opt.dataset.img, cant, opt.dataset.unidad);
  }
  sel.value = ''; document.getElementById('pos-cantidad').value = 1;
}
function posAgregarProducto(id, nombre, precio, stockDisp, imagen, cantidad, unidad, stockDescuenta) {
  stockDescuenta = parseFloat(stockDescuenta);
  if (isNaN(stockDescuenta)) stockDescuenta = cantidad;
  cantidad = parseFloat(cantidad) || 0;
  if (cantidad <= 0) { notificar('Cantidad inválida', 'warning'); return; }
  if (stockDisp <= 0) { notificar(`"${nombre}" no tiene stock disponible`, 'error'); return; }
  const enCarrito = posCarrito.filter(i => i.producto_id === id).reduce((a,i) => a + (parseFloat(i.cantidad)||0), 0);
  if (enCarrito + cantidad > stockDisp + 0.0001) {
    notificar(`Stock insuficiente. Disponible: ${(stockDisp-enCarrito).toFixed(2)}`, 'warning');
    return;
  }
  const existing = posCarrito.find(i => i.producto_id === id && i.precio_unitario === precio);
  if (existing) existing.cantidad = Math.round((existing.cantidad + cantidad) * 1000) / 1000;
  else posCarrito.push({producto_id:id, nombre, imagen_url:imagen, cantidad, precio_unitario:precio, stock_disp:stockDisp, unidad: unidad || '', stock_descuenta: stockDescuenta});
  renderPosCarrito();
  notificar(`${nombre} × ${cantidad} ${unidad||''} agregado ✓`, 'success');
}
function posQuitar(idx) { posCarrito.splice(idx,1); renderPosCarrito(); }
function renderPosCarrito() {
  const tbody = document.getElementById('pos-carrito-tbody');
  if (!posCarrito.length) {
    tbody.innerHTML = `<tr id="pos-empty-row"><td colspan="6" class="carrito-vacio"><i class="fas fa-barcode"></i>Escanea o busca un producto para comenzar</td></tr>`;
    document.getElementById('pos-total-box').style.display = 'none';
    return;
  }
  let total = 0;
  tbody.innerHTML = posCarrito.map((item, idx) => {
    const sub = item.cantidad * item.precio_unitario;
    total += sub;
    const subBs = tasaActual ? `Bs ${fmtBs(sub*tasaActual)}` : '—';
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px">
        <img src="${item.imagen_url||''}" style="width:28px;height:28px;border-radius:6px;object-fit:cover" onerror="this.style.display='none'" alt="">
        <span style="font-weight:600">${item.nombre}</span></div></td>
      <td>${item.cantidad}${item.unidad ? ' '+item.unidad : ''}</td>
      <td style="font-family:'DM Mono',monospace">$${fmt(item.precio_unitario)}</td>
      <td style="font-weight:700">$${fmt(sub)}</td>
      <td style="color:var(--orange);font-family:'DM Mono',monospace;font-size:12px">${subBs}</td>
      <td><button class="btn-remove-item" onclick="posQuitar(${idx})" title="Quitar"><i class="fas fa-times"></i></button></td>
    </tr>`;
  }).join('');
  document.getElementById('pos-total-usd').textContent = `Total: $${fmt(total)}`;
  document.getElementById('pos-total-bs').textContent = tasaActual ? `≈ Bs ${fmtBs(total*tasaActual)}` : '';
  document.getElementById('pos-total-box').style.display = 'flex';
  const btnPagar = document.getElementById('btn-ir-pagar');
  if (btnPagar) btnPagar.style.display = total > 0 ? 'inline-flex' : 'none';
  // Si estamos en paso pago, actualizar totales allá también
  const tUsd = document.getElementById('pos-pago-total-usd');
  const tBs = document.getElementById('pos-pago-total-bs');
  if (tUsd) tUsd.textContent = `$${fmt(total)}`;
  if (tBs) tBs.textContent = tasaActual ? `≈ Bs ${fmtBs(total*tasaActual)}` : '';
}
function irAPagar() {
  if (!posCarrito.length) { notificar('Agrega productos primero', 'warning'); return; }
  const total = _totalCarrito();
  const paso = document.getElementById('pos-paso-pago');
  if (paso) paso.style.display = 'block';
  const tUsd = document.getElementById('pos-pago-total-usd');
  const tBs = document.getElementById('pos-pago-total-bs');
  if (tUsd) tUsd.textContent = `$${fmt(total)}`;
  if (tBs) tBs.textContent = tasaActual ? `≈ Bs ${fmtBs(total*tasaActual)}` : '';
  // reset pago state for this cobro
  metodoPagoSeleccionado = null;
  posPagos = [];
  pagoEnPartes = false;
  const cb = document.getElementById('pos-pago-en-partes');
  if (cb) cb.checked = false;
  const conf = document.getElementById('pos-pago-confirmado');
  if (conf) conf.checked = false;
  renderMetodoPagoBotones();
  renderPagosLista();
  if (paso) paso.scrollIntoView({behavior:'smooth', block:'start'});
}
function volverAlCarrito() {
  const paso = document.getElementById('pos-paso-pago');
  if (paso) paso.style.display = 'none';
  metodoPagoSeleccionado = null;
  posPagos = [];
  pagoEnPartes = false;
  const cb = document.getElementById('pos-pago-en-partes');
  if (cb) cb.checked = false;
}

async function posConfirmarVenta() {
  if (!posCarrito.length) { notificar('El carrito está vacío', 'warning'); return; }

  let pagos = [...posPagos];

  // Modo normal (un solo pago): leer el formulario actual
  if (!pagoEnPartes) {
    if (!metodoPagoSeleccionado) {
      notificar('Selecciona un método de pago', 'warning'); return;
    }
    const pago = _leerPagoFormulario();
    if (!pago) return;
    const tot = _totalCarrito();
    const pagoUSD = pago.monto_usd != null ? pago.monto_usd : pago.monto;
    if (Math.abs(pagoUSD - tot) > 0.05) {
      notificar(`El monto (≈$${fmt(pagoUSD)}) debe coincidir con el total ($${fmt(tot)})`, 'warning');
      return;
    }
    pagos = [pago];
  } else {
    // Pago en partes: si hay método seleccionado con datos, intentar agregarlo
    if (metodoPagoSeleccionado) {
      const pago = _leerPagoFormulario();
      if (pago) {
        const restante = _restantePagar();
        const usd = pago.monto_usd != null ? pago.monto_usd : pago.monto;
        if (usd <= restante + 0.009) {
          pagos = [...pagos, pago];
        }
      }
    }
    if (!pagos.length) {
      notificar('En pago en partes: agrega al menos un pago con el botón "Agregar este pago"', 'warning');
      return;
    }
    const total = _totalCarrito();
    const suma = Math.round(pagos.reduce((s,p)=>s+(p.monto_usd != null ? p.monto_usd : (p.monto||0)),0)*100)/100;
    if (Math.abs(suma - total) > 0.05) {
      notificar(`La suma de pagos ($${fmt(suma)}) no cubre el total ($${fmt(total)}). Falta $${fmt(total-suma)}`, 'warning');
      return;
    }
  }

  const conf = document.getElementById('pos-pago-confirmado');
  if (!conf || !conf.checked) {
    notificar('Marca la casilla: "Confirmo el pago" antes de cobrar', 'warning');
    const wrap = document.getElementById('pos-pago-confirm-wrap');
    if (wrap) { wrap.style.display = 'flex'; wrap.scrollIntoView({behavior:'smooth', block:'center'}); }
    return;
  }

  const notas = document.getElementById('pos-notas').value;
  const btn = document.getElementById('btn-cobrar');
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Procesando...';
  try {
    const res = await fetch('/api/ventas', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      items: posCarrito.map(i => ({...i, cantidad_stock: i.stock_descuenta != null ? i.stock_descuenta : i.cantidad})), notas,
      pagos: pagos.map(p => ({
        metodo_pago_id: p.metodo_pago_id,
        pago_referencia: p.referencia,
        pago_moneda: p.moneda,
        pago_monto: p.monto_usd != null ? p.monto_usd : p.monto,
        pago_monto_ingresado: p.monto
      }))
    })});
    const d = await res.json();
    if (!res.ok) { notificar(d.error || 'Error', 'error'); return; }

    const pagoExtra = { pagos: pagos }; // montos en la moneda que el cliente pagó
    mostrarReciboVenta(posCarrito, d.total, d.venta_grupo_id, d.metodo_pago_nombre, '', pagoExtra);

    posCarrito = []; renderPosCarrito();
    document.getElementById('pos-notas').value = '';
    metodoPagoSeleccionado = null; posPagos = []; pagoEnPartes = false;
    const cbPartes = document.getElementById('pos-pago-en-partes');
    if (cbPartes) cbPartes.checked = false;
    const conf2 = document.getElementById('pos-pago-confirmado');
    if (conf2) conf2.checked = false;
    const paso = document.getElementById('pos-paso-pago');
    if (paso) paso.style.display = 'none';
    renderMetodoPagoBotones(); renderPagosLista();
    cargarProductosVenta();
    if (isAdmin) { cargarDashboard(); cargarInventario(); }
  } catch(e) {
    notificar('Error al registrar la venta', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle"></i> Confirmar Venta';
  }
}



function generarReciboHTML(items, total, ventaNum, metodoPago, referencia, pagoExtra) {
  const ahora = new Date();
  const fecha = ahora.toLocaleDateString('es-VE', {day:'2-digit', month:'2-digit', year:'numeric'});
  const hora = ahora.toLocaleTimeString('es-VE', {hour:'2-digit', minute:'2-digit'});
  const nItems = items.reduce((a,i) => a + (parseFloat(i.cantidad)||0), 0);
  const cut = (s, n) => { s = String(s||''); return s.length > n ? s.slice(0,n-1)+'…' : s; };
  const filas = items.map(i => {
    const sub = (parseFloat(i.precio_unitario)||0)*(parseFloat(i.cantidad)||0);
    const palabras = String(i.nombre||'').trim().split(/\s+/);
    let corto = palabras.slice(0, 2).join(' ');
    if (palabras.length > 2) corto += '…';
    return `<div class="tk-l">${corto}</div>
<div class="tk-r"><span>${i.cantidad}${i.unidad?' '+i.unidad:''} x $${fmt(i.precio_unitario)}</span><span>$${fmt(sub)}</span></div>`;
  }).join('');

  let pagoDet = '';
  if (pagoExtra && Array.isArray(pagoExtra.pagos) && pagoExtra.pagos.length) {
    pagoExtra.pagos.forEach(p => {
      const mon = String(p.moneda || p.pago_moneda || 'USD').toUpperCase();
      // monto que el cliente entregó (en USD o Bs según eligió)
      let ingresado = p.pago_monto_ingresado != null ? p.pago_monto_ingresado
                    : (p.monto != null ? p.monto : null);
      const usd = p.monto_usd != null ? p.monto_usd : p.pago_monto;
      const nom = cut(p.nombre || 'Pago', 16);
      if (mon === 'BS' || mon === 'VES') {
        // Si por error ingresado es el USD, reconstruir Bs con la tasa
        let bs = ingresado;
        if (bs != null && usd != null && tasaActual && Math.abs(bs - usd) < 0.05) {
          bs = usd * tasaActual;
        }
        if (bs == null && usd != null && tasaActual) bs = usd * tasaActual;
        pagoDet += `<div class="tk-r"><span>${nom}</span><span>Bs ${fmtBs(bs||0)}</span></div>`;
      } else {
        const m = ingresado != null ? ingresado : usd;
        pagoDet += `<div class="tk-r"><span>${nom}</span><span>$${fmt(m||0)}</span></div>`;
      }
      const r = p.referencia || p.pago_referencia;
      if (r) pagoDet += `<div class="tk-l">Ref: ${cut(r, 26)}</div>`;
    });
  } else if (referencia) {
    pagoDet = `<div class="tk-l">Ref: ${cut(referencia,26)}</div>`;
  } else if (metodoPago) {
    pagoDet = `<div class="tk-l">${cut(metodoPago,28)}</div>`;
  }

  const totalBs = tasaActual ? fmtBs(total * tasaActual) : null;
  return `<div class="tk">
<div class="tk-c tk-b">DE TODITO MARKET</div>
<div class="tk-c">MyF, C.A</div>
<div class="tk-c">${fecha} ${hora}</div>
<div class="tk-c">Ticket #${ventaNum}</div>
<div class="tk-sep">--------------------------------</div>
${filas}
<div class="tk-sep">--------------------------------</div>
<div class="tk-r tk-b"><span>TOTAL $</span><span>$${fmt(total)}</span></div>
${totalBs ? `<div class="tk-r tk-b"><span>TOTAL Bs</span><span>Bs ${totalBs}</span></div>` : ''}
<div class="tk-sep">--------------------------------</div>
<div class="tk-c tk-b">PAGO</div>
${pagoDet}
<div class="tk-c">Items: ${nItems}</div>
<div class="tk-sep">--------------------------------</div>
<div class="tk-c">¡Gracias por su compra!</div>
</div>`;
}
function mostrarReciboVenta(items, total, ventaNum, metodoPago, referencia, pagoExtra) {
  const html = generarReciboHTML(items, total, ventaNum, metodoPago, referencia, pagoExtra);
  document.getElementById('recibo-preview').innerHTML = html;
  document.getElementById('recibo-imprimible').innerHTML = html;
  abrirModal('modal-venta-completada');
}
function imprimirRecibo() { window.print(); }

function reimprimirVenta(gi) {
  const g = ventasCache[gi];
  if (!g) return;
  const items = g.items.map(i => ({nombre:i.producto_nombre, cantidad:i.cantidad, precio_unitario:i.precio_unitario}));
  mostrarReciboVenta(items, g.total, g.venta_grupo_id, g.metodo_pago_nombre, g.pago_referencia);
}

// ── HISTORIAL VENTAS ──────────────────────────────────
async function cargarVentas() {
  if (!isAdmin) {
    notificar('Inicia sesión de administrador para ver ventas', 'warning');
    return;
  }
  const fi = document.getElementById('v-fecha-ini')?.value || '';
  const ff = document.getElementById('v-fecha-fin')?.value || '';
  const p = new URLSearchParams();
  if (fi) p.append('fecha_inicio', fi);
  if (ff) p.append('fecha_fin', ff);
  try {
    const res = await fetchAdmin(`/api/ventas?${p}`);
    if (!res.ok) {
      notificar('No se pudieron cargar las ventas', 'error');
      return;
    }
    ventasCache = await res.json();
    if (!Array.isArray(ventasCache)) ventasCache = [];
    renderVentas(ventasCache);
  } catch (e) {
    console.error(e);
    notificar('Error al cargar ventas', 'error');
  }
}
function renderVentas(grupos) {
  const totIng = grupos.reduce((a,g) => a+g.total, 0);
  const totGan = grupos.reduce((a,g) => a+g.ganancia, 0);
  document.getElementById('ventas-stats').innerHTML = `
    <div class="vstat"><div class="vstat-label">Total Ventas</div><div class="vstat-value">${grupos.length}</div></div>
    <div class="vstat"><div class="vstat-label">Ingresos</div><div class="vstat-value" style="color:var(--accent3)">$${fmt(totIng)}</div>${tasaActual?`<div class="vstat-bs">Bs ${fmtBs(totIng*tasaActual)}</div>`:''}</div>
    <div class="vstat"><div class="vstat-label">Ganancia</div><div class="vstat-value" style="color:var(--green)">$${fmt(totGan)}</div>${tasaActual?`<div class="vstat-bs">Bs ${fmtBs(totGan*tasaActual)}</div>`:''}</div>`;
  if (!grupos.length) {
    document.getElementById('ventas-lista').innerHTML = `<div class="empty-state"><i class="fas fa-shopping-cart"></i><p>Sin ventas en este período</p></div>`;
    return;
  }
  document.getElementById('ventas-lista').innerHTML = grupos.map((g, gi) => {
    const d = g.fecha ? new Date(g.fecha.replace(' ', 'T')) : null;
    const fecha = d ? d.toLocaleDateString('es-ES', {day:'2-digit', month:'2-digit', year:'2-digit'}) + ', ' + d.toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit', hour12:false}) : '—';
    const totalBs = tasaActual ? `<span class="venta-grupo-bs">Bs ${fmtBs(g.total*tasaActual)}</span>` : '';
    const items = g.items.map(item => `<div class="venta-item-row">
        <img class="venta-item-img" src="${item.imagen_url||''}" onerror="this.src='https://via.placeholder.com/30/1a1d30/6c63ff?text=📦'" alt="">
        <div class="venta-item-nombre">${item.producto_nombre}</div>
        <div class="venta-item-cant">${item.cantidad} uds</div>
        <div class="venta-item-precio">$${fmt(item.precio_unitario)}</div>
        <div class="venta-item-total">$${fmt(item.total)}</div>
      </div>`).join('');
    const refTxt = g.pago_referencia ? `<div class="venta-grupo-notas"><i class="fas fa-hashtag"></i> Referencia: ${g.pago_referencia}</div>` : '';
    const notasTxt = g.notas ? `<div class="venta-grupo-notas"><i class="fas fa-sticky-note"></i> ${g.notas}</div>` : '';
    return `<div class="venta-grupo">
      <div class="venta-grupo-header" onclick="toggleGrupo(${gi})">
        <span class="venta-grupo-num">Venta #${grupos.length-gi}</span>
        <span class="venta-grupo-metodo"><i class="fas fa-credit-card"></i> ${g.metodo_pago_nombre}</span>
        <span class="venta-grupo-fecha">${fecha}</span>
        <span style="color:var(--ts);font-size:12px">${g.items.length} prod.</span>
        <span class="venta-grupo-total">$${fmt(g.total)}</span>${totalBs}
        <div class="venta-grupo-actions" onclick="event.stopPropagation()">
          <button class="btn-edit-venta" onclick="reimprimirVenta(${gi})" title="Reimprimir"><i class="fas fa-print"></i></button>
          <button class="btn-edit-venta" onclick="abrirEditarVenta(${g.venta_grupo_id})" title="Editar"><i class="fas fa-pen"></i></button>
          <button class="btn-del-venta" onclick="eliminarGrupoVenta(${g.venta_grupo_id})" title="Eliminar"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div class="venta-grupo-items" id="grupo-items-${gi}">${items}${refTxt}${notasTxt}</div>
    </div>`;
  }).join('');
}
function toggleGrupo(gi) {
  const el = document.getElementById(`grupo-items-${gi}`);
  el.style.display = el.style.display === 'block' ? 'none' : 'block';
}
function limpiarFiltrosVentas() {
  const ini = document.getElementById('v-fecha-ini');
  const fin = document.getElementById('v-fecha-fin');
  if (ini) ini.value = '';
  if (fin) fin.value = '';
  // Sin fechas = todas las ventas
  cargarVentas().then(() => {
    notificar('Filtros limpiados — mostrando todas las ventas', 'success');
  }).catch(() => {
    notificar('Filtros limpiados', 'success');
  });
}
function eliminarGrupoVenta(gid) {
  confirmarModal('¿Eliminar esta venta completa? El stock se repondrá.', async () => {
    try {
      await fetchAdmin(`/api/ventas/grupo/${gid}`, {method:'DELETE'});
      notificar('Venta eliminada. Stock repuesto ✓', 'success');
      cargarVentas(); cargarDashboard(); cargarProductosVenta();
    } catch(e) {}
  });
}

// ── EDITAR VENTA ───────────────────────────────────────
async function abrirEditarVenta(gid) {
  const fi = document.getElementById('v-fecha-ini').value;
  const ff = document.getElementById('v-fecha-fin').value;
  const p = new URLSearchParams();
  if (fi) p.append('fecha_inicio', fi);
  if (ff) p.append('fecha_fin', ff);
  const res = await fetchAdmin(`/api/ventas?${p}`);
  const grupos = await res.json();
  const grupo = grupos.find(g => g.venta_grupo_id === gid);
  if (!grupo) return;
  editVentaItems = grupo.items.map(i => ({...i}));
  editVentaIdsOriginales = grupo.items.map(i => i.id);
  document.getElementById('edit-grupo-id').value = gid;
  document.getElementById('modal-editar-titulo').textContent = `Editar Venta — ${new Date(grupo.fecha).toLocaleDateString('es-ES')}`;
  document.getElementById('edit-pago-referencia').value = grupo.pago_referencia || '';

  try {
    const resM = await fetchAdmin('/api/metodos-pago');
    metodosPagoAdminCache = await resM.json();
    document.getElementById('edit-metodo-pago').innerHTML = metodosPagoAdminCache.map(m =>
      `<option value="${m.id}" ${m.id===grupo.metodo_pago_id?'selected':''}>${m.nombre}${!m.activo?' (inactivo)':''}</option>`).join('');
  } catch(e) {}
  toggleEditMetodoExtra();

  renderEditarVenta();
  abrirModal('modal-editar-venta');
}
function toggleEditMetodoExtra() {
  const sel = document.getElementById('edit-metodo-pago');
  const metodoId = parseInt(sel.value);
  const metodo = metodosPagoAdminCache.find(m => m.id === metodoId);
  document.getElementById('edit-referencia-wrap').style.display = 'block';
  const label = document.querySelector('#edit-referencia-wrap label');
  if (label) label.textContent = (metodo && metodo.requiere_datos_moviles) ? 'Referencia *' : 'Referencia';
}
function editQuitarItem(idx) {
  if (editVentaItems.length <= 1) { notificar('Para eliminar toda la venta usa la basura en la lista', 'warning'); return; }
  editVentaItems.splice(idx, 1);
  renderEditarVenta();
}
function renderEditarVenta() {
  let total = 0;
  document.getElementById('edit-tbody').innerHTML = editVentaItems.map((item, idx) => {
    const sub = item.cantidad * item.precio_unitario;
    total += sub;
    const subBs = tasaActual ? `Bs ${fmtBs(sub*tasaActual)}` : '—';
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px">
        <img src="${item.imagen_url||''}" style="width:28px;height:28px;border-radius:6px;object-fit:cover" onerror="this.style.display='none'" alt="">
        <span style="font-weight:600">${item.producto_nombre}</span></div></td>
      <td><input class="edit-qty" type="number" value="${item.cantidad}" min="1" onchange="editVentaItems[${idx}].cantidad=parseInt(this.value)||1;renderEditarVenta()"></td>
      <td><input class="edit-price" type="number" value="${item.precio_unitario.toFixed(2)}" step="0.01" min="0" onchange="editVentaItems[${idx}].precio_unitario=parseFloat(this.value)||0;renderEditarVenta()"></td>
      <td style="font-weight:700">$${fmt(sub)}</td>
      <td style="color:var(--orange);font-size:12px;font-family:'DM Mono',monospace">${subBs}</td>
      <td><button class="btn-remove-item" onclick="editQuitarItem(${idx})" title="Quitar"><i class="fas fa-times"></i></button></td>
    </tr>`;
  }).join('');
  const box = document.getElementById('edit-total-box');
  document.getElementById('edit-total-usd').textContent = `Total: $${fmt(total)}`;
  document.getElementById('edit-total-bs').textContent = tasaActual ? `≈ Bs ${fmtBs(total*tasaActual)}` : '';
  box.style.display = 'flex';
}
async function guardarEdicionVenta() {
  const gid = parseInt(document.getElementById('edit-grupo-id').value);
  const idsActuales = editVentaItems.map(i => i.id);
  const eliminar_ids = editVentaIdsOriginales.filter(id => !idsActuales.includes(id));
  const items = editVentaItems.map(i => ({id:i.id, cantidad:i.cantidad, precio_unitario:i.precio_unitario}));
  const metodo_pago_id = parseInt(document.getElementById('edit-metodo-pago').value) || null;
  const pago_referencia = document.getElementById('edit-pago-referencia').value.trim();
  try {
    const res = await fetchAdmin(`/api/ventas/grupo/${gid}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({items, eliminar_ids, metodo_pago_id, pago_referencia})});
    const d = await res.json();
    if (!res.ok) { notificar(d.error || 'Error al guardar', 'error'); return; }
    notificar('Venta actualizada ✓', 'success');
    cerrarModal('modal-editar-venta');
    cargarVentas(); cargarDashboard(); cargarProductosVenta();
  } catch(e) {}
}

// ── STOCK BAJO ─────────────────────────────────────────

function irAProductoDesdeNotif(id) {
  cerrarModal('modal-stock-bajo');
  activarPagina('inventario');
  setTimeout(() => {
    const p = productosCache.find(x => x.id === id);
    if (p) {
      document.getElementById('inv-search').value = p.nombre;
      filtrarInventario();
      setTimeout(() => editarProducto(id), 300);
    }
  }, 200);
}

async function mostrarStockBajo() {
  if (!isAdmin) return;
  try {
    const res = await fetchAdmin('/api/productos');
    const prods = await res.json();
    const bajos = prods.filter(p => p.stock <= p.stock_minimo);
    if (!bajos.length) { notificar('¡Todo el stock está bien! ✓', 'success'); return; }
    document.getElementById('stock-bajo-lista').innerHTML = bajos.map(p => `
      <div class="stock-bajo-item" style="cursor:pointer" onclick="irAProductoDesdeNotif(${p.id})">
        <img src="${p.imagen_url||''}" onerror="this.src='https://via.placeholder.com/38/1a1d30/6c63ff?text=📦'" alt="">
        <div class="stock-bajo-info"><div class="stock-bajo-nombre">${p.nombre}</div><div class="stock-bajo-detalle">Disponible: <strong>${p.stock}</strong> · Mínimo: ${p.stock_minimo}</div></div>
        <span class="stock-badge ${p.stock<=0?'stock-out':'stock-low'}">${p.stock<=0?'Agotado':'Bajo'}</span>
      </div>`).join('');
    abrirModal('modal-stock-bajo');
  } catch(e) {}
}

// ── EXPORTAR ───────────────────────────────────────────
async function exportar(fi, ff, formato='excel') {
  notificar(`Generando ${formato==='pdf'?'PDF':'Excel'}...`, 'success');
  const endpoint = formato === 'pdf' ? '/api/exportar-pdf' : '/api/exportar-excel';
  const ext = formato === 'pdf' ? 'pdf' : 'xlsx';
  try {
    const res = await fetchAdmin(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fecha_inicio:fi, fecha_fin:ff, tasa_manual:tasaActual||0})});
    if (!res.ok) { notificar('Error al generar el reporte', 'error'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `reporte_${new Date().toISOString().split('T')[0]}.${ext}`;
    a.click(); URL.revokeObjectURL(url);
    notificar('Reporte descargado ✓', 'success');
  } catch(e) {}
}
function exportarHoy(formato) { const h = new Date().toISOString().split('T')[0]; exportar(h,h,formato); }
function exportarMes(formato) { const n = new Date(); exportar(new Date(n.getFullYear(),n.getMonth(),1).toISOString().split('T')[0], n.toISOString().split('T')[0], formato); }
function exportarPersonalizado(formato) {
  const fi = document.getElementById('r-fecha-ini').value;
  const ff = document.getElementById('r-fecha-fin').value;
  if (!fi || !ff) { notificar('Selecciona ambas fechas', 'warning'); return; }
  if (fi > ff) { notificar('Fecha inicio debe ser menor', 'warning'); return; }
  exportar(fi, ff, formato);
}

// ── MODALES ─────────────────────────────────────────────
function abrirModal(id) { document.getElementById(id).classList.add('active'); }
function cerrarModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('active'); });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (document.getElementById('modal-login').classList.contains('active') && document.activeElement.id === 'login-password-input') intentarLogin();
});

function confirmarModal(mensaje, callback, titulo='Confirmar acción') {
  document.getElementById('confirmar-titulo').innerHTML = `<i class="fas fa-triangle-exclamation"></i> ${titulo}`;
  document.getElementById('confirmar-mensaje').textContent = mensaje;
  _confirmarCallback = callback;
  abrirModal('modal-confirmar');
}
document.getElementById('confirmar-btn-si').addEventListener('click', () => {
  cerrarModal('modal-confirmar');
  if (_confirmarCallback) { const cb = _confirmarCallback; _confirmarCallback = null; cb(); }
});

function notificar(msg, tipo='success') {
  const icons = {success:'fa-check-circle', error:'fa-times-circle', warning:'fa-exclamation-triangle'};
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.innerHTML = `<i class="fas ${icons[tipo]} toast-icon"></i><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
function toast(msg, tipo) { notificar(msg, tipo); }



function fmt(n) { return (parseFloat(n)||0).toLocaleString('es-ES', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function fmtBs(n) { return (parseFloat(n)||0).toLocaleString('es-VE', {minimumFractionDigits:2, maximumFractionDigits:2}); }


// ── PROVEEDORES + UNIDADES POR TIPO ─────────────────
const UNIDADES_POR_TIPO = {
  peso: ['kg', 'g'],
  liquido: ['litro', 'ml'],
  unidad: ['unidad', 'caja', 'paquete', 'docena', 'rollo', 'bolsa', 'botella'],
  largo: ['metro'],
};


function onCategoriaChange() {
  const cat = (document.getElementById('prod-categoria')?.value || '').toLowerCase();
  if (cat.includes('charcuter')) {
    const hint = document.getElementById('hint-unidad');
    if (hint) hint.textContent = 'Charcutería: elige Peso (kg) para rebanado o Unidad para enteros.';
  }
}

function actualizarUnidadesPorTipo(unidadActual) {
  const tipo = document.getElementById('prod-tipo-medida')?.value || 'unidad';
  const sel = document.getElementById('prod-unidad');
  if (!sel) return;
  const list = UNIDADES_POR_TIPO[tipo] || UNIDADES_POR_TIPO.unidad;
  sel.innerHTML = list.map(u => `<option value="${u}">${u}</option>`).join('');
  if (unidadActual && list.includes(unidadActual)) sel.value = unidadActual;
  else sel.value = list[0];
  const hints = {
    peso: 'Víveres, granos, harina… se miden en kg o g',
    liquido: 'Aceites, bebidas, detergentes líquidos… litro o ml',
    unidad: 'Productos por pieza, caja, paquete, etc.',
    largo: 'Cables, telas, mangueras… en metros',
  };
  const h = document.getElementById('hint-unidad');
  if (h) h.textContent = hints[tipo] || '';
}

async function cargarSelectProveedores(selectedId) {
  const sel = document.getElementById('prod-proveedor');
  if (!sel) return;
  try {
    const res = await fetchAdmin('/api/proveedores?activos=1');
    const list = await res.json();
    sel.innerHTML = '<option value="">— Sin proveedor —</option>' +
      (Array.isArray(list) ? list : []).map(p =>
        `<option value="${p.id}" ${String(p.id)===String(selectedId||'')?'selected':''}>${p.nombre}</option>`
      ).join('');
  } catch(e) {
    sel.innerHTML = '<option value="">— Sin proveedor —</option>';
  }
}

async function cargarProveedores() {
  const box = document.getElementById('proveedores-lista');
  if (!box) return;
  try {
    const res = await fetchAdmin('/api/proveedores');
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-truck"></i><p>No hay proveedores</p><br>
        <button class="btn-primary" onclick="abrirModalProveedor()"><i class="fas fa-plus"></i> Agregar primero</button></div>`;
      return;
    }
    box.innerHTML = list.map(p => `
      <div class="metodo-card">
        <div class="metodo-card-head">
          <strong>${p.nombre}</strong>
          <span class="stock-badge ${p.activo?'stock-ok':'stock-out'}">${p.activo?'Activo':'Inactivo'}</span>
        </div>
        <div class="metodo-card-body" style="font-size:13px;color:var(--ts);line-height:1.5">
          ${p.telefono?`<div><i class="fas fa-phone"></i> ${p.telefono}</div>`:''}
          ${p.rif_cedula?`<div><i class="fas fa-id-card"></i> ${p.rif_cedula}</div>`:''}
          ${p.direccion?`<div><i class="fas fa-map-marker-alt"></i> ${p.direccion}</div>`:''}
          ${p.notas?`<div style="margin-top:6px;font-style:italic">${p.notas}</div>`:''}
        </div>
        <div class="metodo-card-actions">
          <button class="btn-card btn-card-edit" onclick="editarProveedor(${p.id})"><i class="fas fa-pen"></i></button>
          <button class="btn-card btn-card-del" onclick="eliminarProveedor(${p.id},'${String(p.nombre||'').replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
        </div>
      </div>`).join('');
  } catch(e) {
    box.innerHTML = '<div class="empty-state">Error al cargar proveedores</div>';
  }
}

let _proveedoresCache = [];
async function abrirModalProveedor(id) {
  document.getElementById('prov-id').value = id || '';
  document.getElementById('modal-prov-titulo').textContent = id ? 'Editar Proveedor' : 'Nuevo Proveedor';
  ['prov-nombre','prov-telefono','prov-rif','prov-direccion','prov-notas'].forEach(i => {
    const el = document.getElementById(i); if (el) el.value = '';
  });
  if (id) {
    try {
      const res = await fetchAdmin('/api/proveedores');
      _proveedoresCache = await res.json();
      const p = (_proveedoresCache || []).find(x => x.id === id);
      if (p) {
        document.getElementById('prov-nombre').value = p.nombre || '';
        document.getElementById('prov-telefono').value = p.telefono || '';
        document.getElementById('prov-rif').value = p.rif_cedula || '';
        document.getElementById('prov-direccion').value = p.direccion || '';
        document.getElementById('prov-notas').value = p.notas || '';
      }
    } catch(e) {}
  }
  abrirModal('modal-proveedor');
}
function editarProveedor(id) { abrirModalProveedor(id); }

async function guardarProveedor() {
  const id = document.getElementById('prov-id').value;
  const nombre = document.getElementById('prov-nombre').value.trim();
  if (!nombre) { notificar('El nombre es requerido', 'warning'); return; }
  const body = {
    nombre,
    telefono: document.getElementById('prov-telefono').value.trim(),
    rif_cedula: document.getElementById('prov-rif').value.trim(),
    direccion: document.getElementById('prov-direccion').value.trim(),
    notas: document.getElementById('prov-notas').value.trim(),
    activo: true,
  };
  try {
    const url = id ? `/api/proveedores/${id}` : '/api/proveedores';
    const method = id ? 'PUT' : 'POST';
    const res = await fetchAdmin(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await res.json();
    if (!res.ok) { notificar(d.error || 'Error', 'error'); return; }
    notificar(id ? 'Proveedor actualizado ✓' : 'Proveedor agregado ✓', 'success');
    cerrarModal('modal-proveedor');
    cargarProveedores();
    cargarSelectProveedores();
  } catch(e) { notificar('Error al guardar', 'error'); }
}

function eliminarProveedor(id, nombre) {
  confirmarModal(`¿Eliminar proveedor "${nombre}"? Si tiene productos asociados se desactivará.`, async () => {
    try {
      const res = await fetchAdmin(`/api/proveedores/${id}`, {method:'DELETE'});
      const d = await res.json();
      if (!res.ok) { notificar(d.error || 'Error', 'error'); return; }
      notificar(d.desactivado ? (d.msg || 'Desactivado (tiene productos)') : `"${nombre}" eliminado`, 'warning');
      cargarProveedores();
      cargarSelectProveedores();
    } catch(e) { notificar('Error al eliminar', 'error'); }
  });
}
