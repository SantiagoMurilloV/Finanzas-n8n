// =====================================================================
//  Cliente del dashboard - WebSocket + Chart.js + insights
// =====================================================================

const $ = (sel) => document.querySelector(sel);

let state = {};
let chartSerie = null;
let chartCategorias = null;

// Paleta para categorías (hasta 8 colores rotativos)
const PALETTE = ['#6c8cff', '#8b5cf6', '#22d3ee', '#34d399', '#f59e0b', '#f87171', '#ec4899', '#a78bfa'];

// ---------- Helpers ----------
const fmt = (n) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n || 0);

const fmtPct = (n) => `${(Number(n) || 0).toFixed(1)}%`;

const tiempoRel = (iso) => {
  const t = new Date(iso + 'Z').getTime();
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 5) return 'justo ahora';
  if (diff < 60) return `hace ${Math.floor(diff)}s`;
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  return new Date(iso + 'Z').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
};

const fmtFecha = (yyyymmdd) => {
  if (!yyyymmdd) return '—';
  const [y, m, d] = yyyymmdd.split('-');
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('es-CO', {
    day: 'numeric', month: 'short',
  });
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

// ---------- Render: KPIs ----------
function renderKPIs() {
  $('#kpi-balance').textContent = fmt(state.balance);
  $('#kpi-ingresos').textContent = fmt(state.ingresos);
  $('#kpi-gastos').textContent = fmt(state.gastos);
  $('#kpi-ahorro').textContent = fmtPct(state.insights?.tasa_ahorro);

  const i = state.insights || {};
  $('#kpi-balance-trend').textContent =
    state.balance >= 0 ? '✓ en positivo' : '⚠ en negativo';
  $('#kpi-ingresos-sub').textContent = `proy. 30d: ${fmt(i.proyeccion_ingreso_30d)}`;
  $('#kpi-gastos-sub').textContent = `proy. 30d: ${fmt(i.proyeccion_gasto_30d)}`;
  $('#kpi-ahorro-sub').textContent = i.salud_label || 'sin datos';
}

// ---------- Render: Meta de ahorro ----------
function renderMeta() {
  const meta = state.meta_ahorro || 0;
  const ahorrado = state.balance || 0;
  const pct = state.progreso_meta || 0;

  $('#meta-actual').textContent = fmt(ahorrado);
  $('#meta-target').textContent = meta > 0 ? fmt(meta) : 'sin meta';

  $('#progress-bar').style.width = `${pct}%`;
  $('#progress-text').textContent = meta > 0 ? `${pct.toFixed(0)}%` : '—';

  const msg = $('#meta-msg');
  if (meta <= 0) {
    msg.textContent = 'Definí una meta para empezar a hacer seguimiento.';
  } else if (ahorrado < 0) {
    msg.textContent = `Estás en negativo. Necesitás ${fmt(meta - ahorrado)} para llegar a la meta.`;
  } else if (pct >= 100) {
    msg.textContent = `¡Meta cumplida! Llevás ${fmt(ahorrado - meta)} extra.`;
  } else {
    msg.textContent = `Te faltan ${fmt(meta - ahorrado)} para llegar a la meta.`;
  }
}

// ---------- Render: Insights ----------
function renderInsights() {
  const i = state.insights || {};

  // Salud bar
  $('#salud-bar').style.width = `${i.salud_score || 0}%`;
  $('#salud-badge').textContent = i.salud_label || 'sin datos';

  $('#ins-prom-gasto').textContent = fmt(i.promedio_diario_gasto);

  $('#ins-dia-caro').textContent = fmtFecha(i.dia_mas_caro);
  $('#ins-dia-caro-sub').textContent = i.monto_dia_mas_caro
    ? fmt(i.monto_dia_mas_caro) + ' gastado'
    : '—';

  if (i.top_categoria_gasto) {
    $('#ins-top-cat').textContent = i.top_categoria_gasto.categoria;
    $('#ins-top-cat-sub').textContent = fmt(i.top_categoria_gasto.total);
  } else {
    $('#ins-top-cat').textContent = '—';
    $('#ins-top-cat-sub').textContent = '';
  }

  $('#ins-proy').textContent = fmt(i.proyeccion_ahorro_30d);

  if (i.mayor_gasto) {
    $('#ins-mayor-g').textContent = fmt(i.mayor_gasto.monto);
    $('#ins-mayor-g-sub').textContent = i.mayor_gasto.descripcion || i.mayor_gasto.categoria;
  } else {
    $('#ins-mayor-g').textContent = '—';
    $('#ins-mayor-g-sub').textContent = '';
  }

  if (i.mayor_ingreso) {
    $('#ins-mayor-i').textContent = fmt(i.mayor_ingreso.monto);
    $('#ins-mayor-i-sub').textContent = i.mayor_ingreso.descripcion || i.mayor_ingreso.categoria;
  } else {
    $('#ins-mayor-i').textContent = '—';
    $('#ins-mayor-i-sub').textContent = '';
  }
}

// ---------- Render: Charts ----------
function renderChartSerie() {
  const serie = state.serie_diaria || [];
  const labels = serie.map((d) => {
    const [y, m, dd] = d.dia.split('-');
    return `${dd}/${m}`;
  });
  const ingresos = serie.map((d) => d.ingresos);
  const gastos = serie.map((d) => d.gastos);

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
  const cats = state.insights?.top_categorias_gasto_pct || [];
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

  // Total y leyenda manual
  const total = data.reduce((a, b) => a + b, 0);
  $('#cat-total-label').textContent = total > 0 ? `total ${fmt(total)}` : '';

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
        ticks: { color: '#7e87b3', font: { size: 11 } },
      },
      y: {
        grid: { color: 'rgba(108, 140, 255, 0.08)' },
        ticks: {
          color: '#7e87b3',
          font: { size: 11 },
          callback: (v) => fmt(v),
        },
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
      tooltip: {
        ...tooltipStyle(),
        callbacks: {
          label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}`,
        },
      },
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

  if (!state.ultimos?.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  for (const m of state.ultimos) {
    const li = document.createElement('li');
    li.className = `mov ${m.tipo}`;
    li.innerHTML = `
      <div class="mov-icon">${iconoMov(m)}</div>
      <div class="mov-body">
        <span class="mov-titulo">${escapeHtml(m.descripcion || m.raw_text || m.categoria || '(sin descripción)')}</span>
        <span class="mov-meta">
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

// ---------- Render: Apply snapshot ----------
function aplicarSnapshot(s) {
  state = s;
  renderKPIs();
  renderMeta();
  renderInsights();
  renderChartSerie();
  renderChartCategorias();
  renderLista();
}

// ---------- Endpoint info ----------
async function cargarEndpointInfo() {
  try {
    const r = await fetch('/api/endpoint-info');
    const info = await r.json();
    $('#endpoint-url').textContent = info.url;
    $('#json-sample').textContent = JSON.stringify(info.body_ejemplo, null, 2);
    $('#auth-badge').textContent = info.requiere_token ? 'requiere token' : 'sin token';

    $('#btn-copy-url').onclick = async () => {
      await navigator.clipboard.writeText(info.url);
      toast('Endpoint copiado');
    };
    $('#btn-copy-json').onclick = async (e) => {
      e.preventDefault();
      await navigator.clipboard.writeText(JSON.stringify(info.body_ejemplo, null, 2));
      toast('JSON copiado');
    };
  } catch (err) {
    console.error('endpoint-info error', err);
  }
}

// ---------- Modal Meta de ahorro ----------
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
$('#modal-save').addEventListener('click', async () => {
  const monto = Number($('#meta-input').value);
  if (!Number.isFinite(monto) || monto < 0) {
    toast('Monto inválido');
    return;
  }
  await fetch('/api/meta-ahorro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ monto }),
  });
  cerrarModal();
  toast(monto > 0 ? `Meta: ${fmt(monto)}` : 'Meta eliminada');
});
$('#meta-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#modal-save').click();
  if (e.key === 'Escape') cerrarModal();
});

// ---------- Acciones lista ----------
$('#lista').addEventListener('click', async (e) => {
  const btn = e.target.closest('.mov-del');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm('¿Borrar este movimiento?')) return;
  await fetch(`/api/movimientos/${id}`, { method: 'DELETE' });
});

$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Vas a borrar TODOS los movimientos. ¿Seguro?')) return;
  await fetch('/api/reset', { method: 'POST' });
  toast('Todo limpio');
});

// ---------- Socket ----------
const socket = io();

socket.on('connect', () => {
  $('#conn-dot').classList.replace('off', 'on');
  $('#conn-text').textContent = 'En vivo';
});
socket.on('disconnect', () => {
  $('#conn-dot').classList.replace('on', 'off');
  $('#conn-text').textContent = 'Desconectado';
});
socket.on('hidratar', aplicarSnapshot);
socket.on('nuevo-movimiento', ({ snapshot, movimiento }) => {
  aplicarSnapshot(snapshot);
  toast(
    `${movimiento.tipo === 'gasto' ? '↓' : '↑'} ${fmt(movimiento.monto)} · ${movimiento.categoria}`
  );
});
socket.on('movimiento-borrado', ({ snapshot }) => aplicarSnapshot(snapshot));
socket.on('reset', ({ snapshot }) => { aplicarSnapshot(snapshot); toast('Reset'); });
socket.on('meta-actualizada', ({ snapshot }) => aplicarSnapshot(snapshot));

// ---------- Init ----------
cargarEndpointInfo();

// Refrescar tiempos relativos cada 30s
setInterval(() => { if (state.ultimos) renderLista(); }, 30000);

// ---------- PWA: registrar service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((reg) => console.log('[PWA] SW registrado:', reg.scope))
      .catch((err) => console.warn('[PWA] SW falló:', err));
  });
}
