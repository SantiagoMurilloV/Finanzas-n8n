// =====================================================================
//  Cliente del dashboard - Almacenamiento LOCAL por dispositivo
//  - Cada dispositivo guarda su propio state en localStorage.
//  - Los movimientos llegan por WebSocket desde n8n.
//  - El server NO es la fuente de verdad: solo broadcastea entradas nuevas.
// =====================================================================

const $ = (sel) => document.querySelector(sel);
const STORAGE_KEY = 'finanzas-demo-state-v1';
const VIEW_STORAGE_KEY = 'finanzas-demo-view-v1';
const VALID_SCREENS = new Set(['dashboard', 'ahorro', 'movimientos', 'n8n']);

let chartSerie = null;
let chartCategorias = null;

// Paleta para categorías (hasta 8 colores rotativos)
const PALETTE = ['#6c8cff', '#8b5cf6', '#22d3ee', '#34d399', '#f59e0b', '#f87171', '#ec4899', '#a78bfa'];
const FIXED_EXPENSE_KEYWORDS = [
  'arriendo', 'alquiler', 'hipoteca', 'servicio', 'servicios', 'luz', 'agua',
  'gas', 'internet', 'telefono', 'teléfono', 'celular', 'plan', 'credito',
  'crédito', 'prestamo', 'préstamo', 'deuda', 'cuota', 'transporte', 'gasolina',
  'peaje', 'parqueadero', 'seguro', 'eps', 'medicina prepagada', 'administracion',
  'administración', 'suscripcion', 'suscripción', 'netflix', 'spotify', 'gimnasio',
  'colegio', 'guarderia', 'guardería',
];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function currentMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function normalizeMonthKey(value) {
  const candidate = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(candidate) ? candidate : '';
}

function monthKeyFromCreatedAt(value) {
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}`;
  }

  const date = parseMovDate(value) || new Date();
  return Number.isNaN(date.getTime()) ? currentMonthKey() : currentMonthKey(date);
}

function dayKeyFromCreatedAt(value) {
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }

  const date = parseMovDate(value) || new Date();
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return `${currentMonthKey(now)}-${pad2(now.getDate())}`;
  }

  return `${currentMonthKey(date)}-${pad2(date.getDate())}`;
}

function formatMonthLabel(monthKey) {
  const normalized = normalizeMonthKey(monthKey);
  if (!normalized) return 'mes actual';

  const [year, month] = normalized.split('-');
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('es-CO', {
    month: 'long',
    year: 'numeric',
  });
}

function parseMovDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === 'string') {
    const normalized = value.includes(' ') && !value.endsWith('Z') ? value.replace(' ', 'T') : value;
    const direct = new Date(normalized);
    if (!Number.isNaN(direct.getTime())) return direct;

    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (match) {
      return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4] || 0),
        Number(match[5] || 0),
        Number(match[6] || 0),
      );
    }
  }

  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function getAvailableMonths(movimientos = []) {
  const months = new Set();
  for (const mov of movimientos) {
    months.add(monthKeyFromCreatedAt(mov.created_at));
  }
  return Array.from(months).filter(Boolean).sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
}

function resolveSelectedMonth(movimientos, selectedMonth) {
  return normalizeMonthKey(selectedMonth) || getAvailableMonths(movimientos)[0] || currentMonthKey();
}

function isMovementInMonth(movimiento, monthKey) {
  return monthKeyFromCreatedAt(movimiento.created_at) === monthKey;
}

function getDaysToRender(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  return monthKey === currentMonthKey() ? Math.min(new Date().getDate(), daysInMonth) : daysInMonth;
}

function buildMonthlySeries(movimientos, monthKey) {
  const map = {};
  for (const mov of movimientos) {
    if (!isMovementInMonth(mov, monthKey)) continue;
    const dayKey = dayKeyFromCreatedAt(mov.created_at);
    if (!map[dayKey]) map[dayKey] = { ingresos: 0, gastos: 0 };

    if (mov.tipo === 'ingreso') map[dayKey].ingresos += Number(mov.monto) || 0;
    else map[dayKey].gastos += Number(mov.monto) || 0;
  }

  const serie = [];
  const totalDays = getDaysToRender(monthKey);
  for (let day = 1; day <= totalDays; day++) {
    const dayKey = `${monthKey}-${pad2(day)}`;
    const row = map[dayKey] || { ingresos: 0, gastos: 0 };
    serie.push({
      dia: dayKey,
      label: String(day),
      ingresos: row.ingresos,
      gastos: row.gastos,
      balance_dia: row.ingresos - row.gastos,
    });
  }
  return serie;
}

function clasificarGasto(movimiento) {
  if (!movimiento || movimiento.tipo !== 'gasto') return null;
  const source = `${movimiento.categoria || ''} ${movimiento.descripcion || ''} ${movimiento.raw_text || ''}`
    .toLowerCase();
  return FIXED_EXPENSE_KEYWORDS.some((keyword) => source.includes(keyword)) ? 'fijo' : 'variable';
}

// =====================================================================
//  ALMACENAMIENTO LOCAL
// =====================================================================

const Storage = {
  defaults: () => ({
    movimientos: [],
    meta_ahorro: 0,
    next_id: 1,
    selected_month: currentMonthKey(),
  }),

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Storage.defaults();
      const s = JSON.parse(raw);
      const movimientos = Array.isArray(s.movimientos) ? s.movimientos : [];
      return {
        movimientos,
        meta_ahorro: Number(s.meta_ahorro) || 0,
        next_id: Number(s.next_id) || 1,
        selected_month: resolveSelectedMonth(movimientos, s.selected_month),
      };
    } catch (e) {
      return Storage.defaults();
    }
  },

  save(s) {
    const payload = {
      ...s,
      selected_month: resolveSelectedMonth(s.movimientos || [], s.selected_month),
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) {}
  },

  add(s, mov) {
    const m = {
      ...mov,
      id: mov.id || s.next_id,
      created_at: mov.created_at || new Date().toISOString(),
    };
    // Evitar duplicados (si llega el mismo id por reconexión)
    if (!s.movimientos.find((x) => x.id === m.id && x.created_at === m.created_at)) {
      s.movimientos.unshift(m);
      s.next_id = Math.max(s.next_id, m.id) + 1;
    }
    s.selected_month = resolveSelectedMonth(s.movimientos, s.selected_month);
    Storage.save(s);
    return s;
  },

  remove(s, id) {
    s.movimientos = s.movimientos.filter((m) => m.id !== id);
    s.selected_month = resolveSelectedMonth(s.movimientos, s.selected_month);
    Storage.save(s);
    return s;
  },

  reset(s) {
    s.movimientos = [];
    s.next_id = 1;
    s.selected_month = currentMonthKey();
    Storage.save(s);
    return s;
  },

  setMeta(s, monto) {
    s.meta_ahorro = Number(monto) || 0;
    Storage.save(s);
    return s;
  },

  setSelectedMonth(s, monthKey) {
    s.selected_month = resolveSelectedMonth(s.movimientos, monthKey);
    Storage.save(s);
    return s;
  },
};

// =====================================================================
//  CÁLCULOS DE INSIGHTS (todo client-side)
// =====================================================================

function porCategoria(movimientos) {
  const m = {};
  for (const x of movimientos) {
    const k = `${x.categoria}|${x.tipo}`;
    if (!m[k]) m[k] = { categoria: x.categoria, tipo: x.tipo, total: 0, n: 0 };
    m[k].total += Number(x.monto) || 0;
    m[k].n += 1;
  }
  return Object.values(m).sort((a, b) => b.total - a.total);
}

function calcularSnapshot(state) {
  const { movimientos, meta_ahorro } = state;
  const selectedMonth = resolveSelectedMonth(movimientos, state.selected_month);
  const movimientosMes = movimientos.filter((m) => isMovementInMonth(m, selectedMonth));
  const ingresosMovimientos = movimientosMes.filter((m) => m.tipo === 'ingreso');
  const gastosMovimientos = movimientosMes.filter((m) => m.tipo === 'gasto');

  const ingresos = ingresosMovimientos.reduce((a, b) => a + (Number(b.monto) || 0), 0);
  const gastos = gastosMovimientos.reduce((a, b) => a + (Number(b.monto) || 0), 0);
  const gastosFijos = gastosMovimientos
    .filter((m) => clasificarGasto(m) === 'fijo')
    .reduce((a, b) => a + (Number(b.monto) || 0), 0);
  const gastosVariables = Math.max(0, gastos - gastosFijos);
  const capacidadAhorro = ingresos - gastos;

  const cats = porCategoria(movimientosMes);
  const serie = buildMonthlySeries(movimientosMes, selectedMonth);

  const tasaAhorro = ingresos > 0 ? (capacidadAhorro / ingresos) * 100 : 0;
  const diasConDatos = new Set(
    serie.filter((d) => d.ingresos > 0 || d.gastos > 0).map((d) => d.dia)
  ).size;
  const dias = Math.max(1, diasConDatos);
  const promG = gastos / dias;
  const promI = ingresos / dias;

  let diaMasCaro = null;
  let maxGastoDia = 0;
  for (const d of serie) {
    if (d.gastos > maxGastoDia) {
      maxGastoDia = d.gastos;
      diaMasCaro = d.dia;
    }
  }

  const gastosPorCat = cats.filter((c) => c.tipo === 'gasto');
  const topCat = gastosPorCat[0] || null;
  const totalGastoCats = gastosPorCat.reduce((a, b) => a + b.total, 0) || 1;
  const topCatsPct = gastosPorCat.slice(0, 6).map((c) => ({
    categoria: c.categoria,
    total: c.total,
    n: c.n,
    porcentaje: (c.total / totalGastoCats) * 100,
  }));

  let mayorGasto = null;
  let mayorIngreso = null;
  for (const m of movimientosMes) {
    if (m.tipo === 'gasto' && (!mayorGasto || Number(m.monto) > Number(mayorGasto.monto))) mayorGasto = m;
    if (m.tipo === 'ingreso' && (!mayorIngreso || Number(m.monto) > Number(mayorIngreso.monto))) mayorIngreso = m;
  }

  let saludScore = 0;
  let saludLabel = 'sin datos';
  if (ingresos > 0) {
    if (capacidadAhorro < 0) { saludScore = 15; saludLabel = 'gastando más de lo que entra'; }
    else if (tasaAhorro < 10) { saludScore = 40; saludLabel = 'ahorro bajo'; }
    else if (tasaAhorro < 20) { saludScore = 65; saludLabel = 'ahorro saludable'; }
    else if (tasaAhorro < 35) { saludScore = 85; saludLabel = 'muy bien'; }
    else { saludScore = 95; saludLabel = 'excelente'; }
  } else if (gastos > 0) {
    saludScore = 10;
    saludLabel = 'sin ingresos este mes';
  }

  return {
    selected_month: selectedMonth,
    selected_month_label: formatMonthLabel(selectedMonth),
    available_months: getAvailableMonths(movimientos),
    ingresos,
    gastos,
    gastos_fijos: gastosFijos,
    gastos_variables: gastosVariables,
    balance: capacidadAhorro,
    capacidad_ahorro: capacidadAhorro,
    total_movimientos: movimientosMes.length,
    total_movimientos_historicos: movimientos.length,
    total_ingresos_movimientos: ingresosMovimientos.length,
    total_gastos_movimientos: gastosMovimientos.length,
    ultimos: movimientosMes.slice(0, 20),
    por_categoria: cats,
    serie_diaria: serie,
    meta_ahorro,
    progreso_meta: meta_ahorro > 0 ? Math.max(0, Math.min(100, (capacidadAhorro / meta_ahorro) * 100)) : 0,
    insights: {
      tasa_ahorro: Number(tasaAhorro.toFixed(1)),
      promedio_diario_gasto: Number(promG.toFixed(2)),
      promedio_diario_ingreso: Number(promI.toFixed(2)),
      dias_con_datos: diasConDatos,
      mayor_gasto: mayorGasto,
      mayor_ingreso: mayorIngreso,
      top_categoria_gasto: topCat ? { categoria: topCat.categoria, total: topCat.total } : null,
      top_categorias_gasto_pct: topCatsPct,
      total_gastos_fijos: Number(gastosFijos.toFixed(2)),
      total_gastos_variables: Number(gastosVariables.toFixed(2)),
      porcentaje_gasto_fijo: gastos > 0 ? (gastosFijos / gastos) * 100 : 0,
      porcentaje_gasto_variable: gastos > 0 ? (gastosVariables / gastos) * 100 : 0,
      ahorro_recomendado_min: Number((ingresos * 0.10).toFixed(2)),
      ahorro_recomendado_ideal: Number((ingresos * 0.20).toFixed(2)),
      dia_mas_caro: diaMasCaro,
      monto_dia_mas_caro: maxGastoDia,
      salud_score: saludScore,
      salud_label: saludLabel,
    },
  };
}

// =====================================================================
//  ESTADO Y RENDER
// =====================================================================

let state = Storage.load();
let snapshot = calcularSnapshot(state);
let activeScreen = (() => {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    return VALID_SCREENS.has(saved) ? saved : 'dashboard';
  } catch (e) {
    return 'dashboard';
  }
})();
const topbarNav = document.querySelector('.topbar-nav');
const screenNavTrigger = $('#screen-nav-trigger');
const screenNavTriggerLabel = $('#screen-nav-trigger-label');
const mobileNavQuery = window.matchMedia('(max-width: 560px)');
let isScreenNavExpanded = false;

function recalc() {
  snapshot = calcularSnapshot(state);
  renderAll();
}

// ---------- Helpers ----------
const fmt = (n) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n || 0);

const fmtPct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

const tiempoRel = (iso) => {
  if (!iso) return '';
  const parsed = parseMovDate(iso);
  if (!parsed) return '';
  const t = parsed.getTime();
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 5) return 'justo ahora';
  if (diff < 60) return `hace ${Math.floor(diff)}s`;
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  return parsed.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function labelForScreen(screen) {
  const btn = document.querySelector(`[data-screen-tab="${screen}"]`);
  return btn?.dataset.navLabel || btn?.textContent?.trim() || 'Dashboard';
}

function syncScreenNavTrigger() {
  if (!screenNavTrigger || !screenNavTriggerLabel) return;
  const label = labelForScreen(activeScreen);
  screenNavTriggerLabel.textContent = label;
  screenNavTrigger.setAttribute(
    'aria-label',
    `${isScreenNavExpanded ? 'Cerrar' : 'Abrir'} navegación. Sección actual: ${label}.`
  );
}

function setScreenNavExpanded(expanded) {
  const next = Boolean(expanded && mobileNavQuery.matches);
  isScreenNavExpanded = next;
  topbarNav?.classList.toggle('is-expanded', next);
  if (screenNavTrigger) {
    screenNavTrigger.setAttribute('aria-expanded', next ? 'true' : 'false');
  }
  syncScreenNavTrigger();
}

function setActiveScreen(screen, opts = {}) {
  const next = VALID_SCREENS.has(screen) ? screen : 'dashboard';
  activeScreen = next;
  document.body.dataset.appView = next;

  document.querySelectorAll('[data-screen-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.screenTab === next);
  });

  document.querySelectorAll('[data-screen-panel]').forEach((panel) => {
    const isActive = panel.dataset.screenPanel === next;
    panel.classList.toggle('is-active', isActive);
    if (isActive && !opts.preserveScroll) panel.scrollTop = 0;
  });

  syncScreenNavTrigger();
  if (opts.collapseNav) setScreenNavExpanded(false);

  try { localStorage.setItem(VIEW_STORAGE_KEY, next); } catch (e) {}

  if (next === 'dashboard' || next === 'ahorro') {
    requestAnimationFrame(() => {
      chartSerie?.resize();
      chartCategorias?.resize();
      chartSerie?.update('none');
      chartCategorias?.update('none');
    });
  }
}

// ---------- Render: KPIs ----------
function renderMonthCard() {
  const i = snapshot.insights || {};
  const monthInput = $('#month-picker');
  monthInput.value = snapshot.selected_month;

  $('#dashboard-month-pill').textContent = snapshot.selected_month_label;
  $('#dashboard-count-badge').textContent = `${snapshot.total_movimientos} ${snapshot.total_movimientos === 1 ? 'registro' : 'registros'}`;
  $('#dashboard-summary').textContent = snapshot.total_movimientos > 0
    ? `${snapshot.total_ingresos_movimientos} ingresos y ${snapshot.total_gastos_movimientos} gastos en ${snapshot.selected_month_label}.`
    : `Sin movimientos cargados en ${snapshot.selected_month_label}.`;

  $('#month-pill').textContent = snapshot.selected_month_label;
  $('#meta-subtitle').textContent = `Definí cuánto querés ahorrar y comparalo con ${snapshot.selected_month_label}.`;

  if (snapshot.total_movimientos > 0) {
    $('#month-summary').textContent = `${snapshot.total_movimientos} movimientos · ${snapshot.total_ingresos_movimientos} ingresos · ${snapshot.total_gastos_movimientos} gastos`;
  } else if (snapshot.total_movimientos_historicos > 0) {
    $('#month-summary').textContent = `No hay movimientos cargados en ${snapshot.selected_month_label}.`;
  } else {
    $('#month-summary').textContent = 'Todavía no hay movimientos registrados en este dispositivo.';
  }

  $('#formula-ingresos').textContent = fmt(snapshot.ingresos);
  $('#formula-fijos').textContent = fmt(snapshot.gastos_fijos);
  $('#formula-variables').textContent = fmt(snapshot.gastos_variables);
  $('#formula-capacidad').textContent = fmt(snapshot.capacidad_ahorro);

  const resultCard = $('#formula-result-card');
  if (snapshot.capacidad_ahorro > 0) {
    resultCard.dataset.tone = 'positive';
    $('#formula-result-label').textContent = 'Podés ahorrar';
  } else if (snapshot.capacidad_ahorro < 0) {
    resultCard.dataset.tone = 'negative';
    $('#formula-result-label').textContent = 'Déficit del mes';
  } else {
    resultCard.dataset.tone = 'neutral';
    $('#formula-result-label').textContent = 'Capacidad';
  }

  $('#ahorro-rate').textContent = snapshot.ingresos > 0 ? fmtPct(i.tasa_ahorro) : '—';
  $('#ahorro-rate-sub').textContent = snapshot.ingresos > 0
    ? i.salud_label || 'sin datos'
    : snapshot.gastos > 0
      ? 'Registrá ingresos para calcular la tasa real.'
      : 'Sin ingresos suficientes para calcular.';

  $('#ahorro-range').textContent = '10% - 20%';
  $('#ahorro-range-sub').textContent = snapshot.ingresos > 0
    ? `Entre ${fmt(i.ahorro_recomendado_min)} y ${fmt(i.ahorro_recomendado_ideal)} según tus ingresos del mes.`
    : 'Registrá ingresos del mes para calcular un objetivo.';
}

function renderKPIs() {
  $('#kpi-balance').textContent = fmt(snapshot.capacidad_ahorro);
  $('#kpi-ingresos').textContent = fmt(snapshot.ingresos);
  $('#kpi-gastos').textContent = fmt(snapshot.gastos);
  $('#kpi-ahorro').textContent = fmtPct(snapshot.insights?.tasa_ahorro);

  const i = snapshot.insights || {};
  if (snapshot.total_movimientos === 0) {
    $('#kpi-balance-trend').textContent = 'sin movimientos en este mes';
  } else if (snapshot.capacidad_ahorro > 0) {
    $('#kpi-balance-trend').textContent = `podés ahorrar ${fmt(snapshot.capacidad_ahorro)}`;
  } else if (snapshot.capacidad_ahorro < 0) {
    $('#kpi-balance-trend').textContent = `te faltan ${fmt(Math.abs(snapshot.capacidad_ahorro))}`;
  } else {
    $('#kpi-balance-trend').textContent = 'quedás en equilibrio';
  }

  $('#kpi-ingresos-sub').textContent = `${snapshot.total_ingresos_movimientos} ingresos registrados`;
  $('#kpi-gastos-sub').textContent = `fijos ${fmt(snapshot.gastos_fijos)} · variables ${fmt(snapshot.gastos_variables)}`;
  $('#kpi-ahorro-sub').textContent = i.salud_label || 'sin datos';
}

// ---------- Render: Meta de ahorro ----------
function renderMeta() {
  const meta = snapshot.meta_ahorro || 0;
  const ahorrado = snapshot.capacidad_ahorro || 0;
  const pct = snapshot.progreso_meta || 0;

  $('#meta-actual').textContent = fmt(ahorrado);
  $('#meta-target').textContent = meta > 0 ? fmt(meta) : 'sin meta';

  $('#progress-bar').style.width = `${pct}%`;
  $('#progress-text').textContent = meta > 0 ? `${pct.toFixed(0)}%` : '—';

  const msg = $('#meta-msg');
  if (meta <= 0) {
    msg.textContent = `Definí una meta para ${snapshot.selected_month_label}.`;
  } else if (ahorrado < 0) {
    msg.textContent = `Estás en negativo. Necesitás ${fmt(meta - ahorrado)} para alcanzar tu meta de ${snapshot.selected_month_label}.`;
  } else if (pct >= 100) {
    msg.textContent = `Meta cumplida en ${snapshot.selected_month_label}. Llevás ${fmt(ahorrado - meta)} extra.`;
  } else {
    msg.textContent = `Te faltan ${fmt(meta - ahorrado)} para llegar a la meta de ${snapshot.selected_month_label}.`;
  }
}

// ---------- Render: Insights ----------
function renderInsights() {
  const i = snapshot.insights || {};

  $('#salud-bar').style.width = `${i.salud_score || 0}%`;
  $('#salud-badge').textContent = i.salud_label || 'sin datos';

  $('#ins-prom-gasto').textContent = fmt(i.promedio_diario_gasto);

  $('#ins-dia-caro').textContent = snapshot.ingresos > 0 ? fmtPct(i.tasa_ahorro) : '—';
  $('#ins-dia-caro-sub').textContent = snapshot.ingresos > 0
    ? i.salud_label || 'sin datos'
    : snapshot.gastos > 0
      ? 'sin ingresos en el mes'
      : 'sin datos';

  if (i.top_categoria_gasto) {
    $('#ins-top-cat').textContent = i.top_categoria_gasto.categoria;
    $('#ins-top-cat-sub').textContent = fmt(i.top_categoria_gasto.total);
  } else {
    $('#ins-top-cat').textContent = '—';
    $('#ins-top-cat-sub').textContent = '';
  }

  $('#ins-proy').textContent = '10% - 20%';
  $('#ins-proy-sub').textContent = snapshot.ingresos > 0
    ? `entre ${fmt(i.ahorro_recomendado_min)} y ${fmt(i.ahorro_recomendado_ideal)}`
    : 'registrá ingresos para calcularlo';

  $('#ins-mayor-g').textContent = fmt(i.total_gastos_fijos);
  $('#ins-mayor-g-sub').textContent = snapshot.gastos > 0
    ? `${i.porcentaje_gasto_fijo.toFixed(0)}% del gasto mensual`
    : 'sin gastos fijos';

  $('#ins-mayor-i').textContent = fmt(i.total_gastos_variables);
  $('#ins-mayor-i-sub').textContent = snapshot.gastos > 0
    ? `${i.porcentaje_gasto_variable.toFixed(0)}% del gasto mensual`
    : 'sin gastos variables';
}

// ---------- Render: Charts ----------
function renderChartSerie() {
  const serie = snapshot.serie_diaria || [];
  const labels = serie.map((d) => d.label);
  const ingresos = serie.map((d) => d.ingresos);
  const gastos = serie.map((d) => d.gastos);

  $('#serie-period-label').textContent = snapshot.selected_month_label;

  if (chartSerie) {
    chartSerie.data.labels = labels;
    chartSerie.data.datasets[0].data = ingresos;
    chartSerie.data.datasets[1].data = gastos;
    chartSerie.update('none');
    return;
  }

  const ctx = $('#chart-serie').getContext('2d');
  const gradGreen = ctx.createLinearGradient(0, 0, 0, 240);
  gradGreen.addColorStop(0, 'rgba(52, 211, 153, 0.35)');
  gradGreen.addColorStop(1, 'rgba(52, 211, 153, 0)');
  const gradRed = ctx.createLinearGradient(0, 0, 0, 240);
  gradRed.addColorStop(0, 'rgba(248, 113, 113, 0.30)');
  gradRed.addColorStop(1, 'rgba(248, 113, 113, 0)');

  chartSerie = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Ingresos',
          data: ingresos,
          borderColor: '#34d399',
          backgroundColor: gradGreen,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
        {
          label: 'Gastos',
          data: gastos,
          borderColor: '#f87171',
          backgroundColor: gradRed,
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
      ],
    },
    options: chartLineOptions(),
  });
}

function renderChartCategorias() {
  const cats = snapshot.insights?.top_categorias_gasto_pct || [];
  const labels = cats.map((c) => c.categoria);
  const data = cats.map((c) => c.total);
  const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);

  if (chartCategorias) {
    chartCategorias.data.labels = labels;
    chartCategorias.data.datasets[0].data = data;
    chartCategorias.data.datasets[0].backgroundColor = colors;
    chartCategorias.update('none');
  } else {
    const ctx = $('#chart-categorias').getContext('2d');
    chartCategorias = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors,
          borderColor: 'rgba(5, 8, 22, 0.7)',
          borderWidth: 2,
          hoverOffset: 8,
        }],
      },
      options: chartDoughnutOptions(),
    });
  }

  const total = data.reduce((a, b) => a + b, 0);
  $('#cat-total-label').textContent = total > 0
    ? `${snapshot.selected_month_label} · total ${fmt(total)}`
    : snapshot.selected_month_label;

  const legend = $('#legend-categorias');
  legend.innerHTML = cats.length
    ? cats.map((c, i) => `
        <span class="legend-item">
          <span class="legend-dot" style="background: ${PALETTE[i % PALETTE.length]}"></span>
          ${escapeHtml(c.categoria)} · ${c.porcentaje.toFixed(0)}%
        </span>
      `).join('')
    : '<span class="muted small">Aún no hay gastos.</span>';
}

function chartLineOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        align: 'end',
        labels: {
          color: '#c0c7e6',
          font: { size: 12, family: 'Inter' },
          usePointStyle: true,
          boxWidth: 8,
          boxHeight: 8,
        },
      },
      tooltip: tooltipStyle(),
    },
    scales: {
      x: {
        grid: { color: 'rgba(108, 140, 255, 0.08)' },
        ticks: {
          color: '#7e87b3',
          font: { size: 11 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8,
        },
      },
      y: {
        grid: { color: 'rgba(108, 140, 255, 0.08)' },
        ticks: { color: '#7e87b3', font: { size: 11 }, callback: (v) => fmt(v) },
        beginAtZero: true,
      },
    },
  };
}

function chartDoughnutOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: { display: false },
      tooltip: { ...tooltipStyle(), callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` } },
    },
  };
}

function tooltipStyle() {
  return {
    backgroundColor: 'rgba(15, 21, 48, 0.95)',
    titleColor: '#eef1ff',
    bodyColor: '#c0c7e6',
    borderColor: 'rgba(108, 140, 255, 0.35)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    titleFont: { family: 'Inter', size: 12, weight: '600' },
    bodyFont: { family: 'Inter', size: 12 },
    displayColors: true,
    boxPadding: 4,
  };
}

// ---------- Render: Lista ----------
function iconoMov(m) { return m.tipo === 'ingreso' ? '↑' : '↓'; }

function renderLista() {
  const ul = $('#lista');
  const empty = $('#empty');
  ul.innerHTML = '';
  $('#lista-period-label').textContent = snapshot.selected_month_label;
  $('#lista-count-badge').textContent = `${snapshot.total_movimientos} ${snapshot.total_movimientos === 1 ? 'registro' : 'registros'}`;

  if (!snapshot.ultimos?.length) {
    empty.innerHTML = snapshot.total_movimientos_historicos > 0
      ? `No hay movimientos cargados en <strong>${escapeHtml(snapshot.selected_month_label)}</strong>.<br /><small>Probá con otro mes o registrá nuevos movimientos.</small>`
      : 'Esperando que llegue el primer movimiento desde n8n…<br /><small>Mandale un mensaje al bot, ej: <em>compré un almuerzo de 50</em></small>';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  for (const m of snapshot.ultimos) {
    const bucket = clasificarGasto(m);
    const li = document.createElement('li');
    li.className = `mov ${m.tipo}`;
    li.innerHTML = `
      <div class="mov-icon">${iconoMov(m)}</div>
      <div class="mov-body">
        <span class="mov-titulo">${escapeHtml(m.descripcion || m.raw_text || m.categoria || '(sin descripción)')}</span>
        <span class="mov-meta">
          ${bucket ? `<span class="bucket ${bucket}">${bucket}</span>` : ''}
          <span class="cat">${escapeHtml(m.categoria || 'otros')}</span>
          ${m.usuario ? escapeHtml(m.usuario) + ' · ' : ''}${tiempoRel(m.created_at)}
        </span>
      </div>
      <div class="mov-monto">${m.tipo === 'gasto' ? '−' : '+'}${fmt(m.monto)}</div>
      <button class="mov-del" data-id="${m.id}" title="Borrar">×</button>
    `;
    ul.appendChild(li);
  }
}

// ---------- Render: All ----------
function renderAll() {
  renderMonthCard();
  renderKPIs();
  renderMeta();
  renderInsights();
  renderChartSerie();
  renderChartCategorias();
  renderLista();
  setActiveScreen(activeScreen, { preserveScroll: true });
}

// =====================================================================
//  ENDPOINT INFO (lo único que pide al server)
// =====================================================================
async function cargarEndpointInfo() {
  try {
    const r = await fetch('/api/endpoint-info');
    const info = await r.json();
    $('#endpoint-url').textContent = info.url;
    $('#json-sample').textContent = JSON.stringify(info.body_ejemplo, null, 2);
    $('#auth-badge').textContent = info.requiere_token ? 'requiere token' : 'sin token';

    $('#btn-copy-url').onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await navigator.clipboard.writeText(info.url);
      toast('Endpoint copiado');
    };
    $('#btn-copy-json').onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await navigator.clipboard.writeText(JSON.stringify(info.body_ejemplo, null, 2));
      toast('JSON copiado');
    };
  } catch (err) {
    console.error('endpoint-info error', err);
  }
}

// =====================================================================
//  ACCIONES (todo local, no toca el server)
// =====================================================================

// Modal Meta de ahorro
function abrirModalMeta() {
  const backdrop = $('#modal-backdrop');
  const input = $('#meta-input');
  input.value = state.meta_ahorro || '';
  backdrop.classList.add('show');
  setTimeout(() => input.focus(), 100);
}
function cerrarModal() { $('#modal-backdrop').classList.remove('show'); }

$('#btn-edit-meta').addEventListener('click', abrirModalMeta);
$('#modal-cancel').addEventListener('click', cerrarModal);
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') cerrarModal();
});
$('#modal-save').addEventListener('click', () => {
  const monto = Number($('#meta-input').value);
  if (!Number.isFinite(monto) || monto < 0) {
    toast('Monto inválido');
    return;
  }
  state = Storage.setMeta(state, monto);
  recalc();
  cerrarModal();
  toast(monto > 0 ? `Meta: ${fmt(monto)}` : 'Meta eliminada');
});
$('#meta-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#modal-save').click();
  if (e.key === 'Escape') cerrarModal();
});

const onMonthChange = (e) => {
  const monthKey = normalizeMonthKey(e.target.value);
  if (!monthKey) return;
  state = Storage.setSelectedMonth(state, monthKey);
  recalc();
};

$('#month-picker').addEventListener('input', onMonthChange);
$('#month-picker').addEventListener('change', onMonthChange);

document.querySelectorAll('[data-screen-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setActiveScreen(btn.dataset.screenTab, { collapseNav: true });
  });
});

screenNavTrigger?.addEventListener('click', (e) => {
  e.stopPropagation();
  setScreenNavExpanded(!isScreenNavExpanded);
});

document.addEventListener('click', (e) => {
  if (!isScreenNavExpanded) return;
  if (e.target.closest('.topbar-nav')) return;
  setScreenNavExpanded(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isScreenNavExpanded) {
    setScreenNavExpanded(false);
  }
});

if (typeof mobileNavQuery.addEventListener === 'function') {
  mobileNavQuery.addEventListener('change', (e) => {
    if (!e.matches) setScreenNavExpanded(false);
  });
} else if (typeof mobileNavQuery.addListener === 'function') {
  mobileNavQuery.addListener((e) => {
    if (!e.matches) setScreenNavExpanded(false);
  });
}

// Borrar movimiento individual (solo local)
$('#lista').addEventListener('click', (e) => {
  const btn = e.target.closest('.mov-del');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (!confirm('¿Borrar este movimiento de este dispositivo?')) return;
  state = Storage.remove(state, id);
  recalc();
});

// Limpiar todo (solo local)
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Vas a borrar TODOS los movimientos guardados en este dispositivo. ¿Seguro?')) return;
  state = Storage.reset(state);
  recalc();
  toast('Almacenamiento local limpio');
});

// =====================================================================
//  SOCKET — recibe movimientos nuevos del server y los guarda en local
// =====================================================================
const socket = io();
const connBeacon = $('#conn-beacon');

socket.on('connect', () => {
  $('#conn-dot').classList.replace('off', 'on');
  connBeacon.title = 'Conectado';
  connBeacon.setAttribute('aria-label', 'Conectado');
});
socket.on('disconnect', () => {
  $('#conn-dot').classList.replace('on', 'off');
  connBeacon.title = 'Desconectado';
  connBeacon.setAttribute('aria-label', 'Desconectado');
});

// Cuando llega un movimiento nuevo desde n8n -> guardarlo en este dispositivo
socket.on('nuevo-movimiento', ({ movimiento }) => {
  if (!movimiento || !movimiento.tipo) return;
  state = Storage.add(state, movimiento);
  recalc();
  toast(
    `${movimiento.tipo === 'gasto' ? '↓' : '↑'} ${fmt(movimiento.monto)} · ${movimiento.categoria}`
  );
});

// Eventos legacy del server (movimiento-borrado, reset, meta-actualizada, hidratar)
// se ignoran a propósito: cada dispositivo es dueño de su propio estado local.

// =====================================================================
//  INIT
// =====================================================================
cargarEndpointInfo();
renderAll();

// Refrescar tiempos relativos cada 30s
setInterval(() => { if (snapshot.ultimos?.length) renderLista(); }, 30000);

// =====================================================================
//  PWA: registrar service worker
// =====================================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((reg) => console.log('[PWA] SW registrado:', reg.scope))
      .catch((err) => console.warn('[PWA] SW falló:', err));
  });
}
