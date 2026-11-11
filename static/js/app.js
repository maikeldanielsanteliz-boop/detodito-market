/* DE TODITO MARKET MyF, C.A — app.js */

// Imagen por defecto (SVG incrustado, funciona sin internet)
const IMG_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="10" fill="#1a1d30"/>' +
  '<text x="50%" y="62%" font-size="34" text-anchor="middle">📦</text></svg>');

// Escapa texto para insertarlo de forma segura en HTML y atributos (evita que comillas o < > rompan la página)
function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Estado global de la aplicación ──
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
let editPagos = []; // pagos de la factura que se está editando
let posPagos = []; // pagos mixtos de la venta actual
let pagoEnPartes = false;

// Arranque: al cargar la página se inicializa tema, sesión, tasa, productos y menús
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
  setupCodigoProductoEnter();
  setupValidacionNumeros();
  cargarPausadas();
  document.getElementById('pausa-nombre').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmarPausar(); } });

  const hoy = _fechaLocal();
  document.getElementById('v-fecha-fin').value = hoy;
  const ini = new Date(); ini.setDate(1);
  document.getElementById('r-fecha-ini').value = _fechaLocal(ini);
  document.getElementById('r-fecha-fin').value = hoy;
});

// Muestra la hora y la fecha en la barra lateral, actualizadas cada segundo
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
// Cambia entre tema claro y oscuro y lo recuerda
function alternarTema() {
  const actual = document.documentElement.getAttribute('data-theme') || 'dark';
  const nuevo = actual === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', nuevo);
  try { localStorage.setItem('detodito_tema', nuevo); } catch(e) {}
  actualizarIconoTema(nuevo);
}
// Ajusta el ícono del botón de tema
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
// Muestra u oculta las secciones de administrador según la sesión
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
// Abre la ventana de inicio de sesión
function abrirLogin() {
  if (!passwordConfigurada) { abrirConfigurarPasswordInicial(); return; }
  document.getElementById('login-password-input').value = '';
  document.getElementById('login-error').style.display = 'none';
  abrirModal('modal-login');
  setTimeout(() => document.getElementById('login-password-input').focus(), 150);
}
// Envía la contraseña al servidor y entra como administrador
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
// Abre la ventana para crear la contraseña la primera vez
function abrirConfigurarPasswordInicial() {
  document.getElementById('setup-password-input').value = '';
  document.getElementById('setup-password-confirm').value = '';
  document.getElementById('setup-error').style.display = 'none';
  actualizarReglasPassword('', 'setup');
  abrirModal('modal-configurar-password');
}
// Valida y guarda la contraseña inicial de administrador
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
// Cierra la sesión de administrador
async function cerrarSesionAdmin() {
  await fetch('/api/logout', {method:'POST'});
  isAdmin = false;
  actualizarUIAuth();
  activarPagina('facturacion');
  notificar('Sesión cerrada', 'warning');
}
// Abre la ventana para cambiar la contraseña
function abrirCambiarPassword() {
  document.getElementById('cp-actual').value = '';
  document.getElementById('cp-nueva').value = '';
  document.getElementById('cp-error').style.display = 'none';
  actualizarReglasPassword('', 'cp');
  abrirModal('modal-cambiar-password');
}
// Valida y guarda la nueva contraseña
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
// fetch que, si la sesión expiró, pide iniciar sesión de nuevo
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
// Muestra la tasa del dólar en pantalla y refresca los precios en Bs
function mostrarTasa(tasa) {
  tasaActual = tasa;
  document.getElementById('tasa-display').innerHTML = `1 USD = <strong>${fmtBs(tasa)} Bs</strong>`;
}
// Calculadora: convierte dólares a bolívares
function convertirUSD() {
  if (!tasaActual) return;
  const v = parseFloat(document.getElementById('conv-usd').value) || 0;
  document.getElementById('conv-bs').value = v > 0 ? (v*tasaActual).toFixed(2) : '';
}
// Calculadora: convierte bolívares a dólares
function convertirBS() {
  if (!tasaActual) return;
  const v = parseFloat(document.getElementById('conv-bs').value) || 0;
  document.getElementById('conv-usd').value = v > 0 ? (v/tasaActual).toFixed(2) : '';
}
// Abre la ventana para escribir la tasa a mano
function abrirTasaManual() {
  if (tasaActual) document.getElementById('tasa-manual-input').value = tasaActual.toFixed(2);
  abrirModal('modal-tasa');
}
// Guarda la tasa escrita a mano en el servidor
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
// Muestra la sección elegida y carga sus datos
function activarPagina(page) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  const titles = {facturacion:'Facturación', dashboard:'Dashboard', inventario:'Inventario', ventas:'Historial de Ventas', 'metodos-pago':'Métodos de Pago', proveedores:'Proveedores', reportes:'Exportar Reportes'};
  document.getElementById('topbar-title').textContent = titles[page] || page;
  if (page === 'inventario') { cargarInventario(); cargarRevision(true); }
  if (page === 'ventas') cargarVentas();
  if (page === 'dashboard') cargarDashboard();
  if (page === 'metodos-pago') cargarMetodosPagoAdmin();
  if (page === 'proveedores') cargarProveedores();
  if (page === 'facturacion') { cargarProductosVenta(); cargarMetodosPagoPOS(); cargarPausadas(); enfocarBarcode(); }
}

// Salta a Facturación con el producto ya seleccionado
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


// Recarga los datos de la sección que se está viendo
function actualizarTodo() {
  const page = document.querySelector('.nav-item.active')?.dataset.page || 'facturacion';
  if (page === 'inventario') { cargarInventario(); cargarRevision(true); }
  else if (page === 'dashboard') cargarDashboard();
  else if (page === 'ventas') cargarVentas();
  else if (page === 'facturacion') { cargarProductosVenta(); cargarMetodosPagoPOS(); cargarPausadas(); }
  else if (page === 'metodos-pago') cargarMetodosPagoAdmin();
  else if (page === 'proveedores') cargarProveedores();
  notificar('Actualizado ✓', 'success');
}
// Suma kilos y gramos en un solo valor de stock
function syncStockDesdeKgG() {
  const kg = parseFloat(document.getElementById('prod-stock-kg')?.value) || 0;
  const g = parseFloat(document.getElementById('prod-stock-g')?.value) || 0;
  const total = kg + (g / 1000);
  const stock = document.getElementById('prod-stock');
  if (stock) stock.value = total.toFixed(3);
  const hint = document.getElementById('hint-stock-peso');
  if (hint) hint.textContent = 'Total: ' + total.toFixed(3) + ' kg';
}
// Alterna entre stock simple y stock en kg/g según el tipo de medida
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

// Atajo para ir a Facturación
function irAFacturacion() { activarPagina('facturacion'); }
// Abre o cierra el menú lateral (celular)
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
// Búsqueda global: filtra el inventario desde la barra superior
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
// Dibuja indicadores, gráficos y listas del panel
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
          <img class="top-img" src="${esc(p.imagen_url||'')}" onerror="this.onerror=null;this.src=IMG_PLACEHOLDER" alt="">
          <div class="top-info"><div class="top-name">${esc(p.nombre)}</div><div class="top-amount">${p.tv} uds · $${fmt(p.ing)}</div></div>
          <div class="top-value">${tasaActual?'Bs '+fmtBs(p.ing*tasaActual):'$'+fmt(p.ing)}</div>
        </div>`).join('');
  const maxS = Math.max(...d.categorias_stock.map(c=>c.ts), 1);
  const catHtml = d.categorias_stock.map(c => `
    <div class="cat-item"><div class="cat-label">${esc(c.categoria)}</div>
      <div class="cat-bar-wrap"><div class="cat-bar-fill" style="width:${(c.ts/maxS*100).toFixed(0)}%"></div></div>
      <div class="cat-count">${c.ts}</div></div>`).join('');
  const metodosHtml = (d.metodos_pago_mes && d.metodos_pago_mes.length)
    ? d.metodos_pago_mes.map(m => `<div class="metodo-mini-row"><span class="metodo-mini-nombre">${esc(m.nombre)}</span><span class="metodo-mini-valor">$${fmt(m.t)}</span></div>`).join('')
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
// Dibuja las tarjetas del inventario
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
    const cod = p.codigo_barras?`<div class="codigo-barras-tag"><i class="fas fa-barcode"></i> ${esc(p.codigo_barras)}</div>`:'';
    return `<div class="producto-card">
      <img class="producto-card-img" src="${esc(p.imagen_url||'')}" onerror="this.onerror=null;this.src=IMG_PLACEHOLDER" alt="${esc(p.nombre)}" loading="lazy">
      <div class="producto-card-body">
        <div class="producto-card-cat">${esc(p.categoria)}</div>
        <div class="producto-card-name" title="${esc(p.nombre)}">${esc(p.nombre)}</div>
        <div class="precio-venta">$${fmt(p.precio_venta)}</div>${pvb}
        <div class="precio-compra">Costo: $${fmt(p.precio_compra)} · Margen: ${mg}%</div>${cod}
        <div class="producto-card-stock"><span class="stock-badge ${sc}">${sl}</span><span class="stock-num">${p.stock} ${esc(p.unidad||'')}</span></div>
      </div>
      <div class="producto-card-actions">
        <button class="btn-card btn-card-venta" onclick="irAFacturarProducto(${p.id})"><i class="fas fa-cash-register"></i> Vender</button>
        <button class="btn-card btn-card-edit" onclick="editarProducto(${p.id})"><i class="fas fa-pen"></i></button>
        <button class="btn-card btn-card-del" data-nombre="${esc(p.nombre)}" onclick="eliminarProducto(${p.id}, this.dataset.nombre)"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;
  }).join('');
}
// Filtra el inventario por texto y categoría
function filtrarInventario() { cargarInventario(); }
// Llena el filtro y el autocompletado de categorías
async function cargarCategorias() {
  const res = await fetch('/api/categorias');
  let cats = await res.json();
  if (!Array.isArray(cats)) cats = [];
  if (!cats.includes('Charcutería')) cats.push('Charcutería');
  cats.sort();
  const sel = document.getElementById('inv-categoria');
  const dl = document.getElementById('lista-categorias');
  if (sel) sel.innerHTML = '<option value="">Todas las categorías</option>' + cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (dl) dl.innerHTML = cats.map(c=>`<option value="${esc(c)}">`).join('');
}

// ── MODAL PRODUCTO ─────────────────────────────────
function abrirModalProducto(codigoPrellenado) {
  editandoId = null;
  ['prod-id','prod-nombre','prod-categoria','prod-codigo-barras','prod-precio-compra','prod-precio-venta','prod-stock','prod-descripcion'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('prod-stock-min').value = '5';
  document.getElementById('prod-stock-max').value = '0';
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
// Abre el formulario con los datos del producto elegido
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
  document.getElementById('prod-stock').value = p.stock;
  document.getElementById('prod-stock-min').value = p.stock_minimo;
  document.getElementById('prod-stock-max').value = p.stock_maximo || 0;
  document.getElementById('prod-descripcion').value = p.descripcion || '';
  document.getElementById('prod-img-url').value = p.imagen_url || '';
  document.getElementById('prod-img-preview').src = p.imagen_url || IMG_PLACEHOLDER;
  document.getElementById('upload-label-txt').textContent = p.imagen_url ? '✓ Cambiar foto' : 'Subir foto desde mi PC';
  document.getElementById('modal-prod-titulo').textContent = 'Editar Producto';
  actualizarHintsBs();
  abrirModal('modal-producto');
}
// Muestra el equivalente en Bs de los precios escritos
function actualizarHintsBs() {
  if (!tasaActual) return;
  const pc = parseFloat(document.getElementById('prod-precio-compra').value) || 0;
  const pv = parseFloat(document.getElementById('prod-precio-venta').value) || 0;
  document.getElementById('hint-compra').textContent = pc>0?`≈ Bs ${fmtBs(pc*tasaActual)}`:'';
  document.getElementById('hint-venta').textContent = pv>0?`≈ Bs ${fmtBs(pv*tasaActual)}`:'';
}
// Nombre para comparar duplicados: sin mayúsculas, acentos ni espacios repetidos (Huevo = HUEVO = huevo)
function _claveNombre(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
// Revisa los datos del formulario de producto y devuelve la lista de problemas (igual que el servidor)
function _problemasProducto(f) {
  const p = [];
  const nombre = f.nombre.replace(/\s+/g, ' ').trim();
  if (!nombre) p.push('falta el nombre');
  else if (nombre.length < 2) p.push('el nombre es demasiado corto');
  else if (!/\p{L}/u.test(nombre)) p.push('el nombre debe tener letras (no solo números o símbolos)');
  // Lee un número escrito en el formulario: vacío = 0; texto inválido = error
  const num = (txt, etiqueta) => {
    txt = String(txt).trim();
    if (txt === '') return 0;
    const n = Number(txt);
    if (!isFinite(n)) { p.push(`${etiqueta} no es un número válido`); return null; }
    return n;
  };
  const pv = num(f.precio_venta, 'el precio de venta'), pc = num(f.precio_compra, 'el precio de compra');
  const st = num(f.stock, 'el stock'), smin = num(f.stock_minimo, 'el stock mínimo'), smax = num(f.stock_maximo, 'el stock máximo');
  if (pv !== null) {
    if (pv < 0) p.push('el precio de venta no puede ser negativo');
    else if (pv === 0) p.push('el precio de venta debe ser mayor que $0');
    else if (pv > 1000000) p.push('el precio de venta es demasiado alto; revisa si escribiste un dígito de más');
  }
  if (pc !== null) {
    if (pc < 0) p.push('el precio de compra no puede ser negativo');
    else if (pc > 1000000) p.push('el precio de compra es demasiado alto; revisa si escribiste un dígito de más');
  }
  if (st !== null) {
    if (st < 0) p.push('el stock no puede ser negativo');
    else if (f.tipo_medida === 'unidad' && Math.abs(st - Math.round(st)) > 1e-9) p.push('este producto se mide por unidad: el stock debe ser un número entero (sin decimales)');
  }
  [['el stock mínimo', smin], ['el stock máximo', smax]].forEach(([e, v]) => {
    if (v === null) return;
    if (v < 0) p.push(`${e} no puede ser negativo`);
    else if (Math.abs(v - Math.round(v)) > 1e-9) p.push(`${e} debe ser un número entero`);
  });
  if (smin !== null && smax !== null && smax > 0 && smax < smin) p.push('el stock máximo no puede ser menor que el stock mínimo');
  if (/\s/.test(f.codigo_barras.trim())) p.push('el código de barras no debe tener espacios');
  return p;
}
// Muestra en notificaciones cada problema de un producto mal elaborado
function _avisarProblemas(lista) {
  lista.slice(0, 4).forEach(m => notificar('Producto mal elaborado: ' + m, 'error'));
  if (lista.length > 4) notificar(`...y ${lista.length - 4} problema(s) más`, 'error');
}
// Valida y guarda el producto (crea o edita)
async function guardarProducto() {
  const val = id => (document.getElementById(id)?.value ?? '');
  const crudo = {
    nombre: val('prod-nombre'), tipo_medida: val('prod-tipo-medida') || 'unidad', codigo_barras: val('prod-codigo-barras'),
    precio_compra: val('prod-precio-compra'), precio_venta: val('prod-precio-venta'),
    stock: val('prod-stock'), stock_minimo: val('prod-stock-min'), stock_maximo: val('prod-stock-max'),
  };
  // 1) Datos mal escritos (precio en 0 o negativo, stock negativo, nombre vacío...)
  const problemas = _problemasProducto(crudo);
  if (problemas.length) { _avisarProblemas(problemas); return; }
  // 2) Nombre repetido (ignora mayúsculas, acentos y espacios); "Huevo cartón" no choca con "Huevo"
  const nombre = crudo.nombre.replace(/\s+/g, ' ').trim();
  const clave = _claveNombre(nombre);
  const original = editandoId ? productosCache.find(p => p.id === editandoId) : null;
  if (!original || _claveNombre(original.nombre) !== clave) {
    const dup = productosCache.find(p => p.id !== editandoId && _claveNombre(p.nombre) === clave);
    if (dup) {
      notificar(`Producto duplicado: ya existe "${dup.nombre}" (el mismo nombre, sin importar mayúsculas o minúsculas). Si es otra presentación, distínguela en el nombre, por ejemplo "${nombre} cartón".`, 'error');
      return;
    }
  }
  const data = {
    nombre, categoria: val('prod-categoria') || 'General',
    codigo_barras: crudo.codigo_barras.trim(),
    unidad: val('prod-unidad'),
    tipo_medida: crudo.tipo_medida,
    proveedor_id: val('prod-proveedor') || null,
    precio_compra: parseFloat(crudo.precio_compra) || 0,
    precio_venta: parseFloat(crudo.precio_venta) || 0,
    stock: parseFloat(crudo.stock) || 0,
    stock_minimo: parseInt(crudo.stock_minimo) || 0,
    stock_maximo: parseInt(crudo.stock_maximo) || 0,
    descripcion: val('prod-descripcion'),
    imagen_url: val('prod-img-url').trim(),
  };
  try {
    const url = editandoId ? `/api/productos/${editandoId}` : '/api/productos';
    const method = editandoId ? 'PUT' : 'POST';
    const res = await fetchAdmin(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    const d = await res.json();
    if (!res.ok) {
      if (d.errores && d.errores.length) _avisarProblemas(d.errores);   // el servidor también revisa los datos
      else notificar(d.error || 'Error al guardar', 'error');
      return;
    }
    notificar(editandoId ? 'Producto actualizado ✓' : 'Producto agregado ✓', 'success');
    (d.advertencias || []).forEach(a => notificar('Atención: ' + a, 'warning'));
    cerrarModal('modal-producto');
    cargarInventario(); cargarCategorias(); cargarDashboard(); cargarProductosVenta(); cargarRevision(false);
  } catch(e) { notificar('Error de conexión al guardar el producto', 'error'); }
}
// ── REVISIÓN DE PRODUCTOS MAL ELABORADOS ───────────────────
let _revision = {total: 0, productos: []};
let _revisionAvisada = false;   // el aviso automático sale una vez por sesión
// Pide al servidor los productos con datos incorrectos y actualiza el contador
async function cargarRevision(avisar) {
  if (!isAdmin) return;
  try {
    const res = await fetchAdmin('/api/productos/revision');
    if (!res.ok) return;
    _revision = await res.json();
  } catch (e) { return; }
  const b = document.getElementById('revision-badge');
  if (b) { b.textContent = _revision.total; b.style.display = _revision.total ? 'inline-block' : 'none'; }
  if (avisar && _revision.total && !_revisionAvisada) {
    _revisionAvisada = true;
    notificar(`Hay ${_revision.total} producto(s) con datos mal elaborados. Pulsa "Revisar datos" para verlos.`, 'warning');
  }
}
// Abre la ventana con la lista de productos a corregir
async function abrirRevision() {
  await cargarRevision(false);
  renderRevision();
  abrirModal('modal-revision');
}
// Dibuja cada producto con sus problemas (rojo = no se puede vender, naranja = solo aviso)
function renderRevision() {
  const cont = document.getElementById('revision-lista');
  if (!_revision.productos.length) { cont.innerHTML = '<div class="pausadas-vacio"><i class="fas fa-circle-check"></i><br>Todos los productos están bien elaborados</div>'; return; }
  cont.innerHTML = _revision.productos.map(p => `<div class="pausada-item">
    <div class="pausada-info"><strong>${esc(p.nombre)}</strong>
      ${p.graves.map(g => `<small style="color:var(--red)"><i class="fas fa-circle-exclamation"></i> ${esc(g)}</small>`).join('')}
      ${p.avisos.map(a => `<small style="color:var(--orange)"><i class="fas fa-triangle-exclamation"></i> ${esc(a)}</small>`).join('')}
    </div>
    <div class="pausada-acciones"><button class="btn-primary btn-sm" onclick="cerrarModal('modal-revision');irAProductoDesdeNotif(${p.id})"><i class="fas fa-pen"></i> Corregir</button></div>
  </div>`).join('');
}
// Pide confirmación y elimina el producto
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
      if (!res.ok || !d.url) throw new Error(d.error || 'No se pudo subir la foto');
      document.getElementById('prod-img-url').value = d.url;
      _mostrarBtnBorrarFoto(true);
      notificar('Foto cargada ✓', 'success');
    } catch (err) {
      // Si no se pudo subir, no se guarda la imagen (evita llenar la base de datos con datos de la foto)
      document.getElementById('prod-img-preview').src = IMG_PLACEHOLDER;
      document.getElementById('prod-img-url').value = '';
      notificar(err.message || 'No se pudo subir la foto', 'error');
    }
  };
  reader.readAsDataURL(file);
}


let _fotoProdStream = null;

// Abre la cámara para tomar la foto del producto
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

// Apaga la cámara de fotos
function cerrarCamaraFotoProducto() {
  if (_fotoProdStream) {
    _fotoProdStream.getTracks().forEach(tr => tr.stop());
    _fotoProdStream = null;
  }
  const video = document.getElementById('foto-prod-video');
  if (video) video.srcObject = null;
  cerrarModal('modal-foto-producto');
}

// Toma la foto, la comprime y la sube al servidor
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
    if (!res.ok || !d.url) throw new Error(d.error || 'No se pudo subir la foto');
    document.getElementById('prod-img-url').value = d.url;
    _mostrarBtnBorrarFoto(true);
    notificar('Foto capturada ✓', 'success');
  } catch (e) {
    // Si no se pudo subir, no se guarda la imagen (evita llenar la base de datos con datos de la foto)
    document.getElementById('prod-img-preview').src = IMG_PLACEHOLDER;
    document.getElementById('prod-img-url').value = '';
    notificar(e.message || 'No se pudo subir la foto', 'error');
  }
  cerrarCamaraFotoProducto();
}

// Quita la foto del producto
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

// Muestra u oculta el botón de quitar foto
function _mostrarBtnBorrarFoto(show) {
  const btn = document.getElementById('btn-borrar-foto');
  if (btn) btn.style.display = show ? 'inline-flex' : 'none';
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
// Dibuja los botones de métodos de pago en Facturación
function renderMetodoPagoBotones() {
  const cont = document.getElementById('pos-metodo-botones');
  if (!cont) return;
  if (!metodosPagoCache.length) {
    cont.innerHTML = `<span style="color:var(--tm);font-size:12px">Sin métodos de pago activos. Un administrador debe crear uno en "Métodos de Pago".</span>`;
    return;
  }
  cont.innerHTML = metodosPagoCache.map(m => `<button type="button" class="metodo-pago-btn ${metodoPagoSeleccionado===m.id?'selected':''}" onclick="seleccionarMetodoPago(${m.id})">${esc(m.nombre)}</button>`).join('');
  renderMetodoPagoExtra();
}
// Marca el método de pago elegido y muestra sus campos
function seleccionarMetodoPago(id) {
  metodoPagoSeleccionado = id;
  const conf = document.getElementById('pos-pago-confirmado');
  if (conf) conf.checked = false;
  renderMetodoPagoBotones();
}
// Activa o desactiva el pago mixto (varios métodos)
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

// Clasifica el método: efectivo, pago móvil, punto/biopago u otro
function _tipoMetodoPago(metodo) {
  const n = (metodo?.nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (metodo?.requiere_datos_moviles || n.includes('movil') || n.includes('pago movil')) return 'movil';
  if (n.includes('efectivo')) return 'efectivo';
  if (n.includes('punto')) return 'punto';
  if (n.includes('biopago') || n.includes('bio pago')) return 'biopago';
  return 'otro';
}
// Total en USD del carrito actual
// Evita escribir números negativos o con letras (e, +) en cualquier campo numérico
function setupValidacionNumeros() {
  let ultimoAviso = 0;
  const avisar = () => {
    if (Date.now() - ultimoAviso > 2000) { ultimoAviso = Date.now(); notificar('No se permiten números negativos', 'warning'); }
  };
  document.addEventListener('keydown', e => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'number') return;
    if (e.key === '-') { e.preventDefault(); avisar(); }
    else if (e.key === '+' || e.key === 'e' || e.key === 'E') e.preventDefault();
  });
  // Si llega un valor negativo (por ejemplo pegado), se borra y se avisa
  document.addEventListener('input', e => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.type === 'number' && parseFloat(el.value) < 0) { el.value = ''; avisar(); }
  });
}
// Redondea a centavos (igual que el servidor), sin errores de coma flotante
function _redondear2(n) { return Math.round((Number(n) + Number.EPSILON) * 100 + 1e-9) / 100; }
// Subtotal de una línea del carrito: precio × cantidad en centavos
function _subtotalLinea(item) { return _redondear2((parseFloat(item.precio_unitario)||0) * (parseFloat(item.cantidad)||0)); }
// Diferencia máxima (USD) tolerada por redondeo entre los pagos y el total (igual que el servidor)
const TOLERANCIA_PAGO = 0.02;
// Total en USD del carrito actual (suma de subtotales en centavos)
function _totalCarrito() {
  return _redondear2(posCarrito.reduce((s, i) => s + _subtotalLinea(i), 0));
}
// Convierte un monto en Bs o USD a dólares
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
// Lo que falta por pagar, expresado en la moneda indicada
function _restanteEnMoneda(moneda) {
  const restUSD = _restantePagar();
  if ((moneda || 'USD').toUpperCase() === 'BS' || (moneda || '').toUpperCase() === 'VES') {
    if (!tasaActual || tasaActual <= 0) return restUSD;
    return Math.round(restUSD * tasaActual * 100) / 100;
  }
  return restUSD;
}
// Suma (en USD) de los pagos ya agregados
function _sumaPagos() {
  return posPagos.reduce((s, p) => s + (parseFloat(p.monto_usd != null ? p.monto_usd : p.monto) || 0), 0);
}
// Lo que falta por pagar en USD
function _restantePagar() {
  return Math.max(0, Math.round((_totalCarrito() - _sumaPagos()) * 100) / 100);
}
// Dibuja los campos del método elegido (referencia, moneda, monto, vuelto)
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
      ? `<i class="fas fa-circle-info"></i><span>Dale al cliente: ${metodo.datos_cedula?`<strong>Cédula:</strong> ${esc(metodo.datos_cedula)} `:''}${metodo.datos_banco?`<strong>Banco:</strong> ${esc(metodo.datos_banco)} `:''}${metodo.datos_telefono?`<strong>Tel:</strong> ${esc(metodo.datos_telefono)}`:''}</span>`
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
// Cambia la moneda del pago en efectivo (USD o Bs)
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
// Muestra u oculta la calculadora de vuelto
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

// Calcula el vuelto o lo que falta según lo que entrega el cliente
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

// Lee y valida el pago escrito en el formulario
function _leerPagoFormulario() {
  const metodo = metodosPagoCache.find(m => m.id === metodoPagoSeleccionado);
  if (!metodo) return null;
  const tipo = _tipoMetodoPago(metodo);
  const ref = document.getElementById('pos-pago-referencia')?.value.trim() || '';
  const moneda = (document.getElementById('pos-pago-moneda')?.value.trim() || 'USD').toUpperCase();
  // El monto escrito debe ser un número válido mayor que 0; solo si se deja vacío se sugiere lo que falta
  const crudoMonto = String(document.getElementById('pos-pago-monto')?.value ?? '').trim();
  let montoIngresado;
  if (crudoMonto === '') {
    montoIngresado = _restanteEnMoneda(moneda);
  } else {
    montoIngresado = Number(crudoMonto);
    if (!isFinite(montoIngresado)) { notificar('El monto no es un número válido', 'warning'); return null; }
    if (montoIngresado <= 0) { notificar('El monto debe ser mayor que 0', 'warning'); return null; }
    if (montoIngresado > 1000000000) { notificar('El monto es demasiado grande: revisa el número', 'warning'); return null; }
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
// Agrega el pago actual a la lista de pagos mixtos
function agregarPagoActual() {
  const restante = _restantePagar();
  if (restante <= 0.009) { notificar('La factura ya está completamente pagada: no hace falta otro pago', 'warning'); return; }
  const pago = _leerPagoFormulario();
  if (!pago) return;
  const usd = pago.monto_usd != null ? pago.monto_usd : pago.monto;
  // La misma referencia no puede usarse dos veces en la factura
  if (pago.referencia && posPagos.some(p => p.metodo_pago_id === pago.metodo_pago_id && String(p.referencia).toLowerCase() === pago.referencia.toLowerCase())) {
    notificar(`La referencia ${pago.referencia} ya está en otro pago de esta factura`, 'warning');
    return;
  }
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
// Quita un pago de la lista de pagos mixtos
function quitarPago(idx) {
  posPagos.splice(idx, 1);
  renderPagosLista();
  renderMetodoPagoExtra();
}
// Dibuja la lista de pagos agregados y lo que resta
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
      <span><strong>${esc(p.nombre)}</strong> · ${det}
        ${p.referencia ? ` · Ref ${esc(p.referencia)}` : ''}
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

// Carga los métodos de pago para administrarlos
async function cargarMetodosPagoAdmin() {
  if (!isAdmin) return;
  try {
    const res = await fetchAdmin('/api/metodos-pago');
    metodosPagoAdminCache = await res.json();
    renderMetodosPagoAdmin(metodosPagoAdminCache);
  } catch(e) {}
}
// Dibuja la tabla de métodos de pago
function renderMetodosPagoAdmin(metodos) {
  const cont = document.getElementById('metodos-pago-lista');
  if (!metodos.length) { cont.innerHTML = `<div class="empty-state"><i class="fas fa-credit-card"></i><p>Sin métodos de pago</p></div>`; return; }
  cont.innerHTML = metodos.map(m => {
    const datosTxt = m.requiere_datos_moviles
      ? `<div class="metodo-pago-datos">${(m.datos_cedula||m.datos_banco||m.datos_telefono)
          ? `${m.datos_cedula?`<strong>Cédula:</strong> ${esc(m.datos_cedula)}<br>`:''}${m.datos_banco?`<strong>Banco:</strong> ${esc(m.datos_banco)}<br>`:''}${m.datos_telefono?`<strong>Tel:</strong> ${esc(m.datos_telefono)}`:''}`
          : 'Faltan tus datos — edita para agregarlos'}</div>`
      : '';
    return `<div class="metodo-pago-card">
      <div class="metodo-pago-top">
        <div class="metodo-pago-icon"><i class="fas fa-credit-card"></i></div>
        <div class="metodo-pago-info"><div class="metodo-pago-nombre">${esc(m.nombre)}</div><div class="metodo-pago-estado ${m.activo?'activo':'inactivo'}">${m.activo?'● Activo':'○ Inactivo'}</div></div>
        <div class="metodo-pago-acciones">
          <button onclick='editarMetodoPago(${JSON.stringify(m)})' title="Editar"><i class="fas fa-pen"></i></button>
          <button onclick="toggleActivoMetodoPago(${m.id},${m.activo?0:1})" title="${m.activo?'Desactivar':'Activar'}"><i class="fas fa-power-off"></i></button>
          <button class="del-btn" data-nombre="${esc(m.nombre)}" onclick="eliminarMetodoPago(${m.id}, this.dataset.nombre)" title="Eliminar"><i class="fas fa-trash"></i></button>
        </div>
      </div>${datosTxt}
    </div>`;
  }).join('');
}
// Abre el formulario para un método de pago nuevo
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
// Abre el formulario con los datos del método elegido
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
// Muestra los datos del vendedor (cédula, banco, teléfono) si aplica
function toggleMetodoDatosFijos() {
  document.getElementById('metodo-datos-fijos').style.display = document.getElementById('metodo-requiere-moviles').checked ? 'block' : 'none';
}
// Valida y guarda el método de pago
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
// Activa o desactiva un método de pago
async function toggleActivoMetodoPago(id, nuevoEstado) {
  try {
    await fetchAdmin(`/api/metodos-pago/${id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({activo: nuevoEstado})});
    cargarMetodosPagoAdmin(); cargarMetodosPagoPOS();
    notificar(nuevoEstado ? 'Método activado ✓' : 'Método desactivado ✓', 'success');
  } catch(e) {}
}
// Pide confirmación y elimina (o desactiva) el método
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
      posProductosCache.map(p => `<option value="${p.id}" data-precio="${p.precio_venta}" data-stock="${p.stock}" data-img="${esc(p.imagen_url||'')}" data-nombre="${esc(p.nombre)}" data-unidad="${esc(p.unidad||'')}" data-tipo="${esc(p.tipo_medida||'unidad')}">${esc(p.nombre)} ${p.stock<=0 ? '(Agotado)' : `(${p.stock} ${p.unidad||''} disp.)`}</option>`).join('');
  }
}
// Pone el cursor en el campo del lector de códigos
function enfocarBarcode() {
  const input = document.getElementById('pos-barcode-input');
  if (input) setTimeout(() => { try { input.focus(); input.select(); } catch(e) {} }, 80);
}

// Pistola lectora USB (Roccia y similares): actúa como teclado.
// Escriben el código muy rápido y suelen terminar con Enter.
let _bcBuffer = '';
let _bcLastKey = 0;
let _bcTimer = null;
// Evita que la pistola registre el mismo código muchas veces seguidas
let _bcBloqueoHasta = 0;
const BC_COOLDOWN_MS = 800; // 0.8s entre lecturas de pistola

// Procesa un código leído (limpia, evita lecturas repetidas y busca el producto)
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

// En el formulario de producto, la pistola escribe el código y presiona Enter: se busca la info y el cursor pasa al nombre
function setupCodigoProductoEnter() {
  const inp = document.getElementById('prod-codigo-barras');
  if (!inp) return;
  inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!inp.value.trim()) return;
    if (isAdmin) buscarInfoPorCodigo();
    const nom = document.getElementById('prod-nombre');
    if (nom) nom.focus();
  });
}
// Detecta el lector USB (teclado rápido) y envía el código a Facturación
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
// Busca un producto por código y lo agrega al carrito
async function posBuscarPorCodigo(codigo, desdeProcesar) {
  codigo = String(codigo || '').replace(/[\r\n\t]/g, '').trim();
  if (!codigo) return;
  // Si la llamada es directa (no viene de _procesarCodigoBarras), aplicar el cooldown aquí
  if (!desdeProcesar) {
    const ahora = Date.now();
    if (typeof _bcBloqueoHasta !== 'undefined' && ahora < _bcBloqueoHasta) return;
    if (typeof _bcBloqueoHasta !== 'undefined') _bcBloqueoHasta = ahora + (typeof BC_COOLDOWN_MS !== 'undefined' ? BC_COOLDOWN_MS : 800);
  }

  try {
    const res = await fetch(`/api/productos/codigo/${encodeURIComponent(codigo)}`);
    const d = await res.json();
    if (!res.ok) { manejarCodigoNoEncontrado(codigo); return; }
    posAgregarProducto(d.id, d.nombre, d.precio_venta, d.stock, d.imagen_url, 1, d.unidad, d.tipo_medida);
  } catch(e) { notificar('Error al buscar código', 'error'); }
}
// Código desconocido: el admin puede registrarlo, el cajero recibe un aviso
function manejarCodigoNoEncontrado(codigo) {
  if (isAdmin) {
    notificar(`Código ${codigo} no registrado. Completa los datos para agregarlo.`, 'warning');
    abrirModalProducto(codigo);
    setTimeout(() => buscarInfoPorCodigo(), 300);
  } else {
    notificar(`Código ${codigo} no está registrado. Solicita a un administrador que lo agregue.`, 'warning');
  }
}
// Agrega al carrito el producto elegido en la lista desplegable
function posAgregarSeleccionado() {
  const sel = document.getElementById('pos-select-prod');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) { notificar('Selecciona un producto', 'warning'); return; }
  const crudo = document.getElementById('pos-cantidad').value.trim();
  const cant = crudo === '' ? 1 : Number(crudo);
  if (!isFinite(cant) || cant <= 0) { notificar('La cantidad debe ser un número mayor que 0', 'warning'); return; }
  posAgregarProducto(parseInt(opt.value), opt.dataset.nombre, parseFloat(opt.dataset.precio) || 0,
                     parseFloat(opt.dataset.stock) || 0, opt.dataset.img, cant, opt.dataset.unidad, opt.dataset.tipo);
  sel.value = ''; document.getElementById('pos-cantidad').value = 1;
}
// Agrega (o suma) un producto al carrito validando cantidad y stock disponible
function posAgregarProducto(id, nombre, precio, stockDisp, imagen, cantidad, unidad, tipo) {
  cantidad = parseFloat(cantidad) || 0;
  if (cantidad <= 0) { notificar('Cantidad inválida: debe ser mayor que 0', 'warning'); return; }
  // Producto con el precio en 0 (o dañado): no se vende y se avisa
  if (!(parseFloat(precio) > 0)) {
    notificar(`Producto mal elaborado: "${nombre}" tiene el precio en $${fmt(parseFloat(precio) || 0)}. ${isAdmin ? 'Corrígelo en Inventario.' : 'Avisa al administrador para que lo corrija.'}`, 'error');
    return;
  }
  if ((tipo || 'unidad') === 'unidad' && Math.abs(cantidad - Math.round(cantidad)) > 1e-9) {
    notificar(`"${nombre}" se vende por unidad: escribe un número entero (sin decimales)`, 'warning'); return;
  }
  if (stockDisp <= 0) { notificar(`"${nombre}" no tiene stock disponible`, 'error'); return; }
  const enCarrito = posCarrito.filter(i => i.producto_id === id).reduce((a,i) => a + (parseFloat(i.cantidad)||0), 0);
  if (enCarrito + cantidad > stockDisp + 0.0001) {
    notificar(`Stock insuficiente. Disponible: ${(stockDisp-enCarrito).toFixed(2)}`, 'warning');
    return;
  }
  const existing = posCarrito.find(i => i.producto_id === id && i.precio_unitario === precio);
  if (existing) existing.cantidad = Math.round((existing.cantidad + cantidad) * 1000) / 1000;
  else posCarrito.push({producto_id:id, nombre, imagen_url:imagen, cantidad, precio_unitario:precio, stock_disp:stockDisp, unidad: unidad || ''});
  renderPosCarrito();
  notificar(`${nombre} × ${cantidad} ${unidad||''} agregado ✓`, 'success');
}
// Quita una línea del carrito
function posQuitar(idx) { posCarrito.splice(idx,1); renderPosCarrito(); }
// Dibuja el carrito y sus totales en USD y Bs
function renderPosCarrito() {
  const tbody = document.getElementById('pos-carrito-tbody');
  if (!posCarrito.length) {
    tbody.innerHTML = `<tr id="pos-empty-row"><td colspan="6" class="carrito-vacio"><i class="fas fa-barcode"></i>Escanea o busca un producto para comenzar</td></tr>`;
    document.getElementById('pos-total-box').style.display = 'none';
    return;
  }
  let total = 0;
  tbody.innerHTML = posCarrito.map((item, idx) => {
    const sub = _subtotalLinea(item);
    total += sub;
    const subBs = tasaActual ? `Bs ${fmtBs(sub*tasaActual)}` : '—';
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px">
        <img src="${esc(item.imagen_url||'')}" style="width:28px;height:28px;border-radius:6px;object-fit:cover" onerror="this.style.display='none'" alt="">
        <span style="font-weight:600">${esc(item.nombre)}</span></div></td>
      <td>${item.cantidad}${item.unidad ? ' '+item.unidad : ''}</td>
      <td style="font-family:'DM Mono',monospace">$${fmt(item.precio_unitario)}</td>
      <td style="font-weight:700">$${fmt(sub)}</td>
      <td style="color:var(--orange);font-family:'DM Mono',monospace;font-size:12px">${subBs}</td>
      <td><button class="btn-remove-item" onclick="posQuitar(${idx})" title="Quitar"><i class="fas fa-times"></i></button></td>
    </tr>`;
  }).join('');
  total = _redondear2(total);
  document.getElementById('pos-total-usd').textContent = `Total: $${fmt(total)}`;
  document.getElementById('pos-total-bs').textContent = tasaActual ? `≈ Bs ${fmtBs(total*tasaActual)}` : '';
  document.getElementById('pos-total-box').style.display = 'flex';
  const btnPagar = document.getElementById('btn-ir-pagar');
  if (btnPagar) btnPagar.style.display = total > 0 ? 'inline-flex' : 'none';
  const btnPausar = document.getElementById('btn-pausar');
  if (btnPausar) btnPausar.style.display = 'inline-flex';
  // Si estamos en paso pago, actualizar totales allá también
  const tUsd = document.getElementById('pos-pago-total-usd');
  const tBs = document.getElementById('pos-pago-total-bs');
  if (tUsd) tUsd.textContent = `$${fmt(total)}`;
  if (tBs) tBs.textContent = tasaActual ? `≈ Bs ${fmtBs(total*tasaActual)}` : '';
}
// Pasa del carrito al paso de pago
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
// Regresa del pago al carrito
function volverAlCarrito() {
  const paso = document.getElementById('pos-paso-pago');
  if (paso) paso.style.display = 'none';
  metodoPagoSeleccionado = null;
  posPagos = [];
  pagoEnPartes = false;
  const cb = document.getElementById('pos-pago-en-partes');
  if (cb) cb.checked = false;
}

// ── FACTURAS EN PAUSA ──────────────────────────────────────
let _pausadas = [];   // facturas en pausa guardadas en el servidor (se comparten entre PC y celular)

// Deja el carrito y el paso de pago como nuevos (tras cobrar o pausar)
function _vaciarCarritoPos() {
  posCarrito = []; renderPosCarrito();
  document.getElementById('pos-notas').value = '';
  metodoPagoSeleccionado = null; posPagos = []; pagoEnPartes = false;
  const cbPartes = document.getElementById('pos-pago-en-partes');
  if (cbPartes) cbPartes.checked = false;
  const conf = document.getElementById('pos-pago-confirmado');
  if (conf) conf.checked = false;
  const paso = document.getElementById('pos-paso-pago');
  if (paso) paso.style.display = 'none';
  renderMetodoPagoBotones(); renderPagosLista();
}
// Carga la lista de facturas en pausa y actualiza el contador
async function cargarPausadas() {
  try {
    const res = await fetch('/api/facturas-pausadas');
    if (res.ok) _pausadas = await res.json();
  } catch (e) { /* sin conexión: se conserva la última lista */ }
  actualizarBadgePausadas();
}
// Muestra cuántas facturas hay en pausa junto al botón
function actualizarBadgePausadas() {
  const b = document.getElementById('pausadas-badge');
  if (!b) return;
  b.textContent = _pausadas.length;
  b.style.display = _pausadas.length ? 'inline-block' : 'none';
}
// Abre la ventana para pausar la factura actual
function abrirPausar() {
  if (!posCarrito.length) { notificar('El carrito está vacío: no hay nada que pausar', 'warning'); return; }
  const inp = document.getElementById('pausa-nombre');
  if (inp) inp.value = '';
  abrirModal('modal-pausar');
  setTimeout(() => { if (inp) inp.focus(); }, 100);
}
// Envía el carrito actual al servidor como factura en pausa (devuelve true si se guardó)
async function _enviarPausa(nombre) {
  try {
    const res = await fetch('/api/facturas-pausadas', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      nombre, notas: document.getElementById('pos-notas').value,
      items: posCarrito.map(i => ({producto_id: i.producto_id, cantidad: i.cantidad}))
    })});
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { notificar(d.error || 'No se pudo pausar la factura', 'error'); return false; }
    return true;
  } catch (e) {
    notificar('Sin conexión con el servidor: la factura no se pausó', 'error');
    return false;
  }
}
// Guarda la factura en pausa y deja el carrito libre para el siguiente cliente
async function confirmarPausar() {
  const btn = document.getElementById('btn-guardar-pausa');
  btn.disabled = true;
  try {
    const nombre = document.getElementById('pausa-nombre').value.trim();
    if (!(await _enviarPausa(nombre))) return;
    cerrarModal('modal-pausar');
    _vaciarCarritoPos();
    await cargarPausadas();
    notificar('Factura en pausa ✓ Ya puedes atender a otro cliente', 'success');
    enfocarBarcode();
  } finally { btn.disabled = false; }
}
// Abre la lista de facturas en pausa
async function abrirPausadas() {
  await cargarPausadas();
  renderPausadas();
  abrirModal('modal-pausadas');
}
// Dibuja la lista de facturas en pausa con su total a los precios de hoy
function renderPausadas() {
  const cont = document.getElementById('pausadas-lista');
  if (!_pausadas.length) { cont.innerHTML = '<div class="pausadas-vacio"><i class="fas fa-pause-circle"></i><br>No hay facturas en pausa</div>'; return; }
  cont.innerHTML = _pausadas.map(p => {
    const hora = p.fecha ? new Date(p.fecha).toLocaleString('es-VE', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : '';
    const bs = tasaActual ? ` · Bs ${fmtBs(p.total * tasaActual)}` : '';
    return `<div class="pausada-item">
      <div class="pausada-info"><strong>${esc(p.nombre)}</strong><small>${p.num_items} producto(s) · ${esc(hora)}</small></div>
      <div class="pausada-total">$${fmt(p.total)}<small style="display:block;font-weight:400;color:var(--orange);font-size:11px">${bs.replace(' · ','')}</small></div>
      <div class="pausada-acciones">
        <button class="btn-primary btn-sm" onclick="retomarPausada(${p.id})"><i class="fas fa-play"></i> Retomar</button>
        <button class="btn-secondary btn-sm" onclick="eliminarPausada(${p.id})" title="Descartar"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;
  }).join('');
}
// Carga una factura en pausa en el carrito (si ya hay productos, los pausa automáticamente para no perderlos)
async function retomarPausada(id) {
  if (posCarrito.length) {
    const hora = new Date().toLocaleTimeString('es-VE', {hour:'2-digit', minute:'2-digit'});
    if (!(await _enviarPausa('Pausada automáticamente ' + hora))) return;
  }
  let d;
  try {
    const res = await fetch(`/api/facturas-pausadas/${id}`);
    d = await res.json();
    if (!res.ok) { notificar(d.error || 'No se pudo retomar la factura', 'error'); await cargarPausadas(); renderPausadas(); return; }
  } catch (e) { notificar('Sin conexión con el servidor', 'error'); return; }
  _vaciarCarritoPos();
  posCarrito = d.items.map(i => ({producto_id: i.producto_id, nombre: i.nombre, imagen_url: i.imagen_url, cantidad: i.cantidad,
                                  precio_unitario: i.precio_unitario, stock_disp: i.stock_disp, unidad: i.unidad || ''}));
  document.getElementById('pos-notas').value = d.notas || '';
  renderPosCarrito();
  try { await fetch(`/api/facturas-pausadas/${id}`, {method:'DELETE'}); } catch (e) { /* si falla, se puede borrar luego */ }
  await cargarPausadas();
  cerrarModal('modal-pausadas');
  (d.avisos || []).forEach(a => notificar(a, 'warning'));
  notificar(`Factura "${d.nombre}" retomada ✓`, 'success');
  enfocarBarcode();
}
// Descarta una factura en pausa (pide confirmación)
function eliminarPausada(id) {
  confirmarModal('¿Descartar esta factura en pausa? Se perderán sus productos.', async () => {
    try { await fetch(`/api/facturas-pausadas/${id}`, {method:'DELETE'}); } catch (e) { notificar('Sin conexión con el servidor', 'error'); return; }
    await cargarPausadas(); renderPausadas();
    notificar('Factura en pausa descartada', 'success');
  });
}

// Valida el pago, registra la venta en el servidor y muestra el recibo
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
    if (Math.abs(pagoUSD - tot) > TOLERANCIA_PAGO) {
      notificar(`El monto (≈$${fmt(pagoUSD)}) debe coincidir con el total ($${fmt(tot)})`, 'warning');
      return;
    }
    pagos = [pago];
  } else {
    // Pago en partes: si hay método seleccionado con datos, intentar agregarlo
    const restante = _restantePagar();
    if (metodoPagoSeleccionado && restante > 0.009) {
      const pago = _leerPagoFormulario();
      if (!pago) return;   // _leerPagoFormulario ya explicó qué falta
      const usd = pago.monto_usd != null ? pago.monto_usd : pago.monto;
      if (usd > restante + 0.009) {
        notificar(`El pago escrito ($${fmt(usd)}) es mayor que lo que falta ($${fmt(restante)}). Ajusta el monto.`, 'warning');
        return;
      }
      pagos = [...pagos, pago];
    }
    if (!pagos.length) {
      notificar('En pago en partes: agrega al menos un pago con el botón "Agregar este pago"', 'warning');
      return;
    }
    const total = _totalCarrito();
    const suma = Math.round(pagos.reduce((s,p)=>s+(p.monto_usd != null ? p.monto_usd : (p.monto||0)),0)*100)/100;
    if (Math.abs(suma - total) > TOLERANCIA_PAGO) {
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
      items: posCarrito.map(i => ({producto_id: i.producto_id, cantidad: i.cantidad})), notas,
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

    // El recibo usa los datos confirmados por el servidor (total, pagos y tasa de la venta)
    mostrarReciboVenta(posCarrito, d.total, d.venta_grupo_id, d.metodo_pago_nombre, '', {pagos: d.pagos}, {tasa: d.tasa_bs});

    _vaciarCarritoPos();
    cargarProductosVenta();
    if (isAdmin) { cargarDashboard(); cargarInventario(); }
  } catch(e) {
    notificar('Error al registrar la venta', 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle"></i> Confirmar Venta';
  }
}



// Construye el ticket de venta listo para imprimir
function generarReciboHTML(items, total, ventaNum, metodoPago, referencia, pagoExtra, opc) {
  opc = opc || {};   // opc.fecha y opc.tasa: la de la venta (al reimprimir, no la de hoy)
  const ahora = opc.fecha ? new Date(opc.fecha) : new Date();
  const tasaRecibo = opc.tasa || tasaActual;
  const fecha = ahora.toLocaleDateString('es-VE', {day:'2-digit', month:'2-digit', year:'numeric'});
  const hora = ahora.toLocaleTimeString('es-VE', {hour:'2-digit', minute:'2-digit'});
  const nItems = items.reduce((a,i) => a + (parseFloat(i.cantidad)||0), 0);
  const cut = (s, n) => { s = String(s||''); return esc(s.length > n ? s.slice(0,n-1)+'…' : s); };
  const filas = items.map(i => {
    const sub = _subtotalLinea(i);
    const palabras = String(i.nombre||'').trim().split(/\s+/);
    let corto = palabras.slice(0, 2).join(' ');
    if (palabras.length > 2) corto += '…';
    return `<div class="tk-l">${esc(corto)}</div>
<div class="tk-r"><span>${i.cantidad}${i.unidad?' '+i.unidad:''} x $${fmt(i.precio_unitario)}</span><span>$${fmt(sub)}</span></div>`;
  }).join('');

  let pagoDet = '';
  if (pagoExtra && Array.isArray(pagoExtra.pagos) && pagoExtra.pagos.length) {
    pagoExtra.pagos.forEach(p => {
      const mon = String(p.moneda || 'USD').toUpperCase();
      const usd = p.monto_usd != null ? p.monto_usd : p.monto;   // equivalente en dólares
      const nom = cut(p.nombre || p.metodo_pago_nombre || 'Pago', 16);
      if (mon === 'BS' || mon === 'VES') {
        // Bolívares que pagó el cliente (en facturas antiguas sin ese dato se calcula con la tasa)
        const bs = p.monto_moneda != null ? p.monto_moneda : (usd != null && tasaRecibo ? usd * tasaRecibo : null);
        pagoDet += `<div class="tk-r"><span>${nom}</span><span>${bs != null ? 'Bs ' + fmtBs(bs) : '$' + fmt(usd || 0)}</span></div>`;
      } else {
        pagoDet += `<div class="tk-r"><span>${nom}</span><span>$${fmt(p.monto_moneda != null ? p.monto_moneda : (usd || 0))}</span></div>`;
      }
      if (p.referencia) pagoDet += `<div class="tk-l">Ref: ${cut(p.referencia, 26)}</div>`;
    });
  } else if (referencia) {
    pagoDet = `<div class="tk-l">Ref: ${cut(referencia,26)}</div>`;
  } else if (metodoPago) {
    pagoDet = `<div class="tk-l">${cut(metodoPago,28)}</div>`;
  }

  const totalBs = tasaRecibo ? fmtBs(total * tasaRecibo) : null;
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
// Muestra el recibo en pantalla
function mostrarReciboVenta(items, total, ventaNum, metodoPago, referencia, pagoExtra, opc) {
  const html = generarReciboHTML(items, total, ventaNum, metodoPago, referencia, pagoExtra, opc);
  document.getElementById('recibo-preview').innerHTML = html;
  document.getElementById('recibo-imprimible').innerHTML = html;
  abrirModal('modal-venta-completada');
}
// Imprime el recibo
function imprimirRecibo() { window.print(); }

// Vuelve a imprimir el recibo de una venta anterior
function reimprimirVenta(gi) {
  const g = ventasCache[gi];
  if (!g) return;
  const items = g.items.map(i => ({nombre:i.producto_nombre, cantidad:i.cantidad, unidad:i.unidad || '', precio_unitario:i.precio_unitario}));
  mostrarReciboVenta(items, g.total, g.venta_grupo_id, g.metodo_pago_nombre, g.pago_referencia, {pagos: g.pagos}, {fecha: g.fecha, tasa: g.tasa_bs});
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
// Dibuja el historial de ventas agrupado por factura
function renderVentas(grupos) {
  const totIng = _redondear2(grupos.reduce((a,g) => a+g.total, 0));
  const totGan = _redondear2(grupos.reduce((a,g) => a+g.ganancia, 0));
  // Bs de cada venta con la tasa de ese día (si no se guardó, la tasa actual)
  const tasaDe = g => g.tasa_bs || tasaActual || 0;
  const totIngBs = grupos.reduce((a,g) => a + g.total * tasaDe(g), 0);
  const totGanBs = grupos.reduce((a,g) => a + g.ganancia * tasaDe(g), 0);
  document.getElementById('ventas-stats').innerHTML = `
    <div class="vstat"><div class="vstat-label">Total Ventas</div><div class="vstat-value">${grupos.length}</div></div>
    <div class="vstat"><div class="vstat-label">Ingresos</div><div class="vstat-value" style="color:var(--accent3)">$${fmt(totIng)}</div>${totIngBs?`<div class="vstat-bs">Bs ${fmtBs(totIngBs)}</div>`:''}</div>
    <div class="vstat"><div class="vstat-label">Ganancia</div><div class="vstat-value" style="color:var(--green)">$${fmt(totGan)}</div>${totGanBs?`<div class="vstat-bs">Bs ${fmtBs(totGanBs)}</div>`:''}</div>`;
  if (!grupos.length) {
    document.getElementById('ventas-lista').innerHTML = `<div class="empty-state"><i class="fas fa-shopping-cart"></i><p>Sin ventas en este período</p></div>`;
    return;
  }
  document.getElementById('ventas-lista').innerHTML = grupos.map((g, gi) => {
    const fecha = new Date(g.fecha).toLocaleString('es-ES', {dateStyle:'short', timeStyle:'short'});
    const totalBs = tasaDe(g) ? `<span class="venta-grupo-bs">Bs ${fmtBs(g.total*tasaDe(g))}</span>` : '';
    const items = g.items.map(item => `<div class="venta-item-row">
        <img class="venta-item-img" src="${esc(item.imagen_url||'')}" onerror="this.onerror=null;this.src=IMG_PLACEHOLDER" alt="">
        <div class="venta-item-nombre">${esc(item.producto_nombre)}</div>
        <div class="venta-item-cant">${item.cantidad} ${esc(item.unidad || 'uds')}</div>
        <div class="venta-item-precio">$${fmt(item.precio_unitario)}</div>
        <div class="venta-item-total">$${fmt(item.total)}</div>
      </div>`).join('');
    // Cada pago de la factura (puede haber varios métodos y monedas)
    const pagosTxt = (g.pagos && g.pagos.length) ? `<div class="venta-grupo-notas"><i class="fas fa-credit-card"></i> ${g.pagos.map(p => {
      const enBs = String(p.moneda).toUpperCase() === 'BS' && p.monto_moneda != null;
      return `${esc(p.metodo_pago_nombre)}: ${enBs ? 'Bs ' + fmtBs(p.monto_moneda) + ' (≈ $' + fmt(p.monto_usd) + ')' : '$' + fmt(p.monto_usd)}${p.referencia ? ' · Ref ' + esc(p.referencia) : ''}`;
    }).join('<br>')}</div>` : '';
    const refTxt = (!pagosTxt && g.pago_referencia) ? `<div class="venta-grupo-notas"><i class="fas fa-hashtag"></i> Referencia: ${esc(g.pago_referencia)}</div>` : '';
    const notasTxt = g.notas ? `<div class="venta-grupo-notas"><i class="fas fa-sticky-note"></i> ${esc(g.notas)}</div>` : '';
    return `<div class="venta-grupo">
      <div class="venta-grupo-header" onclick="toggleGrupo(${gi})">
        <span class="venta-grupo-num">Venta #${g.venta_grupo_id}</span>
        <span class="venta-grupo-metodo"><i class="fas fa-credit-card"></i> ${esc(g.metodo_pago_nombre)}</span>
        <span class="venta-grupo-fecha">${fecha}</span>
        <span style="color:var(--ts);font-size:12px">${g.items.length} prod.</span>
        <span class="venta-grupo-total">$${fmt(g.total)}</span>${totalBs}
        <div class="venta-grupo-actions" onclick="event.stopPropagation()">
          <button class="btn-edit-venta" onclick="reimprimirVenta(${gi})" title="Reimprimir"><i class="fas fa-print"></i></button>
          <button class="btn-edit-venta" onclick="abrirEditarVenta(${g.venta_grupo_id})" title="Editar"><i class="fas fa-pen"></i></button>
          <button class="btn-del-venta" onclick="eliminarGrupoVenta(${g.venta_grupo_id})" title="Eliminar"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <div class="venta-grupo-items" id="grupo-items-${gi}">${items}${pagosTxt}${refTxt}${notasTxt}</div>
    </div>`;
  }).join('');
}
// Despliega o contrae el detalle de una venta
function toggleGrupo(gi) {
  const el = document.getElementById(`grupo-items-${gi}`);
  el.style.display = el.style.display === 'block' ? 'none' : 'block';
}
// Borra los filtros del historial de ventas
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
// Pide confirmación y anula la venta (el stock vuelve al inventario)
function eliminarGrupoVenta(gid) {
  confirmarModal('¿Eliminar esta venta completa? El stock se repondrá.', async () => {
    try {
      const res = await fetchAdmin(`/api/ventas/grupo/${gid}`, {method:'DELETE'});
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { notificar(d.error || 'No se pudo eliminar la venta', 'error'); return; }
      notificar('Venta eliminada. Stock repuesto ✓', 'success');
      cargarVentas(); cargarDashboard(); cargarProductosVenta();
    } catch(e) { notificar('Error de conexión al eliminar la venta', 'error'); }
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
  editPagos = grupo.pagos || [];
  editVentaIdsOriginales = grupo.items.map(i => i.id);
  document.getElementById('edit-grupo-id').value = gid;
  document.getElementById('modal-editar-titulo').textContent = `Editar Venta — ${new Date(grupo.fecha).toLocaleDateString('es-ES')}`;
  document.getElementById('edit-pago-referencia').value = grupo.pago_referencia || '';

  try {
    const resM = await fetchAdmin('/api/metodos-pago');
    metodosPagoAdminCache = await resM.json();
    document.getElementById('edit-metodo-pago').innerHTML = metodosPagoAdminCache.map(m =>
      `<option value="${m.id}" ${m.id===grupo.metodo_pago_id?'selected':''}>${esc(m.nombre)}${!m.activo?' (inactivo)':''}</option>`).join('');
  } catch(e) {}
  toggleEditMetodoExtra();
  // Pago mixto: el método y la referencia no se editan aquí (cada pago tiene su monto)
  const mixto = editPagos.length > 1;
  document.getElementById('edit-metodo-pago').disabled = mixto;
  document.getElementById('edit-pago-referencia').disabled = mixto;
  const nota = document.getElementById('edit-pagos-nota');
  nota.style.display = mixto ? 'block' : 'none';
  nota.textContent = mixto ? `Esta factura se pagó con varios métodos (${editPagos.map(p => p.metodo_pago_nombre).join(' + ')}). Puedes corregir productos mientras el total no cambie; si cambia, anúlala y factura de nuevo.` : '';

  renderEditarVenta();
  abrirModal('modal-editar-venta');
}
// Muestra el campo de referencia al editar el método de pago
function toggleEditMetodoExtra() {
  const sel = document.getElementById('edit-metodo-pago');
  const metodoId = parseInt(sel.value);
  const metodo = metodosPagoAdminCache.find(m => m.id === metodoId);
  document.getElementById('edit-referencia-wrap').style.display = 'block';
  const label = document.querySelector('#edit-referencia-wrap label');
  if (label) label.textContent = (metodo && metodo.requiere_datos_moviles) ? 'Referencia *' : 'Referencia';
}
// Quita un producto de la venta que se está editando
function editQuitarItem(idx) {
  if (editVentaItems.length <= 1) { notificar('Para eliminar toda la venta usa la basura en la lista', 'warning'); return; }
  editVentaItems.splice(idx, 1);
  renderEditarVenta();
}
// Dibuja la tabla de edición de una venta
function renderEditarVenta() {
  let total = 0;
  document.getElementById('edit-tbody').innerHTML = editVentaItems.map((item, idx) => {
    const sub = _subtotalLinea(item);
    total += sub;
    const subBs = tasaActual ? `Bs ${fmtBs(sub*tasaActual)}` : '—';
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px">
        <img src="${esc(item.imagen_url||'')}" style="width:28px;height:28px;border-radius:6px;object-fit:cover" onerror="this.style.display='none'" alt="">
        <span style="font-weight:600">${esc(item.producto_nombre)}</span></div></td>
      <td><input class="edit-qty" type="number" value="${item.cantidad}" min="0.01" step="0.01" onchange="editVentaItems[${idx}].cantidad=parseFloat(this.value)||1;renderEditarVenta()"></td>
      <td><input class="edit-price" type="number" value="${item.precio_unitario}" step="any" min="0" onchange="editVentaItems[${idx}].precio_unitario=parseFloat(this.value)||0;renderEditarVenta()"></td>
      <td style="font-weight:700">$${fmt(sub)}</td>
      <td style="color:var(--orange);font-size:12px;font-family:'DM Mono',monospace">${subBs}</td>
      <td><button class="btn-remove-item" onclick="editQuitarItem(${idx})" title="Quitar"><i class="fas fa-times"></i></button></td>
    </tr>`;
  }).join('');
  total = _redondear2(total);
  const box = document.getElementById('edit-total-box');
  document.getElementById('edit-total-usd').textContent = `Total: $${fmt(total)}`;
  document.getElementById('edit-total-bs').textContent = tasaActual ? `≈ Bs ${fmtBs(total*tasaActual)}` : '';
  box.style.display = 'flex';
}
// Envía al servidor los cambios hechos a la venta
async function guardarEdicionVenta() {
  const gid = parseInt(document.getElementById('edit-grupo-id').value);
  const idsActuales = editVentaItems.map(i => i.id);
  const eliminar_ids = editVentaIdsOriginales.filter(id => !idsActuales.includes(id));
  const items = editVentaItems.map(i => ({id:i.id, cantidad:i.cantidad, precio_unitario:i.precio_unitario}));
  const cuerpo = {items, eliminar_ids};
  if (editPagos.length <= 1) {   // con un solo pago se puede cambiar el método y la referencia
    cuerpo.metodo_pago_id = parseInt(document.getElementById('edit-metodo-pago').value) || null;
    cuerpo.pago_referencia = document.getElementById('edit-pago-referencia').value.trim();
  }
  try {
    const res = await fetchAdmin(`/api/ventas/grupo/${gid}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(cuerpo)});
    const d = await res.json();
    if (!res.ok) { notificar(d.error || 'Error al guardar', 'error'); return; }
    notificar('Venta actualizada ✓', 'success');
    cerrarModal('modal-editar-venta');
    cargarVentas(); cargarDashboard(); cargarProductosVenta();
  } catch(e) { notificar('Error de conexión al guardar la venta', 'error'); }
}

// ── STOCK BAJO ─────────────────────────────────────────

// Desde el aviso de stock bajo, abre el producto para editarlo
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

// Lista los productos con stock bajo o agotado
async function mostrarStockBajo() {
  if (!isAdmin) return;
  try {
    const res = await fetchAdmin('/api/productos');
    const prods = await res.json();
    const bajos = prods.filter(p => p.stock <= p.stock_minimo);
    if (!bajos.length) { notificar('¡Todo el stock está bien! ✓', 'success'); return; }
    document.getElementById('stock-bajo-lista').innerHTML = bajos.map(p => `
      <div class="stock-bajo-item" style="cursor:pointer" onclick="irAProductoDesdeNotif(${p.id})">
        <img src="${esc(p.imagen_url||'')}" onerror="this.onerror=null;this.src=IMG_PLACEHOLDER" alt="">
        <div class="stock-bajo-info"><div class="stock-bajo-nombre">${esc(p.nombre)}</div><div class="stock-bajo-detalle">Disponible: <strong>${p.stock}</strong> · Mínimo: ${p.stock_minimo}</div></div>
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
    a.download = `reporte_${_fechaLocal()}.${ext}`;
    a.click(); URL.revokeObjectURL(url);
    notificar('Reporte descargado ✓', 'success');
  } catch(e) {}
}
// Reporte de hoy
function exportarHoy(formato) { const h = _fechaLocal(); exportar(h,h,formato); }
// Reporte del mes en curso
function exportarMes(formato) { const n = new Date(); exportar(_fechaLocal(new Date(n.getFullYear(), n.getMonth(), 1)), _fechaLocal(n), formato); }
// Reporte del rango de fechas elegido
function exportarPersonalizado(formato) {
  const fi = document.getElementById('r-fecha-ini').value;
  const ff = document.getElementById('r-fecha-fin').value;
  if (!fi || !ff) { notificar('Selecciona ambas fechas', 'warning'); return; }
  if (fi > ff) { notificar('Fecha inicio debe ser menor', 'warning'); return; }
  exportar(fi, ff, formato);
}

// ── MODALES ─────────────────────────────────────────────
function abrirModal(id) { document.getElementById(id).classList.add('active'); }
// Cierra una ventana modal
function cerrarModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('active'); });
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (document.getElementById('modal-login').classList.contains('active') && document.activeElement.id === 'login-password-input') intentarLogin();
});

// Ventana de confirmación; ejecuta la acción solo si se acepta
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

// Muestra un aviso temporal (éxito, error o advertencia)
function notificar(msg, tipo='success') {
  const icons = {success:'fa-check-circle', error:'fa-times-circle', warning:'fa-exclamation-triangle'};
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.innerHTML = `<i class="fas ${icons[tipo]} toast-icon"></i><span>${esc(msg)}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
// Alias de notificar
function toast(msg, tipo) { notificar(msg, tipo); }


// Fecha local AAAA-MM-DD (toISOString usa hora UTC y después de las 8 pm daría el día siguiente)
function _fechaLocal(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Formatea un número como monto con 2 decimales
function fmt(n) { return (parseFloat(n)||0).toLocaleString('es-ES', {minimumFractionDigits:2, maximumFractionDigits:2}); }
// Formatea un número como monto en bolívares
function fmtBs(n) { return (parseFloat(n)||0).toLocaleString('es-VE', {minimumFractionDigits:2, maximumFractionDigits:2}); }


// ── PROVEEDORES + UNIDADES POR TIPO ─────────────────
const UNIDADES_POR_TIPO = {
  peso: ['kg', 'g'],
  liquido: ['litro', 'ml'],
  unidad: ['unidad', 'caja', 'paquete', 'docena', 'rollo', 'bolsa', 'botella'],
  largo: ['metro'],
};


// Sugiere el tipo de medida según la categoría escrita
function onCategoriaChange() {
  const cat = (document.getElementById('prod-categoria')?.value || '').toLowerCase();
  if (cat.includes('charcuter')) {
    const hint = document.getElementById('hint-unidad');
    if (hint) hint.textContent = 'Charcutería: elige Peso (kg) para rebanado o Unidad para enteros.';
  }
}

// Llena la lista de unidades según el tipo de medida
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

// Llena la lista de proveedores del formulario de producto
async function cargarSelectProveedores(selectedId) {
  const sel = document.getElementById('prod-proveedor');
  if (!sel) return;
  try {
    const res = await fetchAdmin('/api/proveedores?activos=1');
    const list = await res.json();
    sel.innerHTML = '<option value="">— Sin proveedor —</option>' +
      (Array.isArray(list) ? list : []).map(p =>
        `<option value="${p.id}" ${String(p.id)===String(selectedId||'')?'selected':''}>${esc(p.nombre)}</option>`
      ).join('');
  } catch(e) {
    sel.innerHTML = '<option value="">— Sin proveedor —</option>';
  }
}

// Carga y dibuja la lista de proveedores
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
          <strong>${esc(p.nombre)}</strong>
          <span class="stock-badge ${p.activo?'stock-ok':'stock-out'}">${p.activo?'Activo':'Inactivo'}</span>
        </div>
        <div class="metodo-card-body" style="font-size:13px;color:var(--ts);line-height:1.5">
          ${p.telefono?`<div><i class="fas fa-phone"></i> ${esc(p.telefono)}</div>`:''}
          ${p.rif_cedula?`<div><i class="fas fa-id-card"></i> ${esc(p.rif_cedula)}</div>`:''}
          ${p.direccion?`<div><i class="fas fa-map-marker-alt"></i> ${esc(p.direccion)}</div>`:''}
          ${p.notas?`<div style="margin-top:6px;font-style:italic">${esc(p.notas)}</div>`:''}
        </div>
        <div class="metodo-card-actions">
          <button class="btn-card btn-card-edit" onclick="editarProveedor(${p.id})"><i class="fas fa-pen"></i></button>
          <button class="btn-card btn-card-del" data-nombre="${esc(p.nombre)}" onclick="eliminarProveedor(${p.id}, this.dataset.nombre)"><i class="fas fa-trash"></i></button>
        </div>
      </div>`).join('');
  } catch(e) {
    box.innerHTML = '<div class="empty-state">Error al cargar proveedores</div>';
  }
}

let _proveedoresCache = [];
// Abre el formulario de proveedor (nuevo o existente)
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
// Abre el formulario con los datos del proveedor
function editarProveedor(id) { abrirModalProveedor(id); }

// Valida y guarda el proveedor
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

// Pide confirmación y elimina (o desactiva) el proveedor
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
