// ===========================================================================
//  Dashboard de Finanzas en vivo - Demo para curso de n8n
// ---------------------------------------------------------------------------
//  Flujo:
//    Telegram  ->  n8n (con agente IA que interpreta el texto)
//                       |
//                       v
//                  POST /api/movimientos  (este servidor)
//                       |
//                       v
//                  SQLite + WebSocket  -->  Dashboard en pantalla
// ===========================================================================

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 3000;
const API_TOKEN = process.env.API_TOKEN || ''; // vacío = sin auth (modo clase)
// DATA_DIR permite redirigir la DB a un volumen persistente (Railway, Fly, etc.)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// PUBLIC_URL: detección automática según el proveedor de hosting.
// Prioridad: variable explícita > Railway > Render > Fly > localhost.
function detectPublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RAILWAY_STATIC_URL) return process.env.RAILWAY_STATIC_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  return `http://localhost:${PORT}`;
}
const PUBLIC_URL = detectPublicUrl();

// ---------- DB (SQLite, archivo único en DATA_DIR) ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'finanzas.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS movimientos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo        TEXT NOT NULL CHECK(tipo IN ('gasto', 'ingreso')),
    monto       REAL NOT NULL,
    categoria   TEXT DEFAULT 'otros',
    descripcion TEXT,
    usuario     TEXT,
    raw_text    TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mov_created ON movimientos(created_at DESC);
`);

// Tabla auxiliar para configuración (meta de ahorro, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const stmt = {
  insert: db.prepare(`
    INSERT INTO movimientos (tipo, monto, categoria, descripcion, usuario, raw_text)
    VALUES (@tipo, @monto, @categoria, @descripcion, @usuario, @raw_text)
  `),
  list: db.prepare(`
    SELECT * FROM movimientos
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `),
  byId: db.prepare(`SELECT * FROM movimientos WHERE id = ?`),
  delete: db.prepare(`DELETE FROM movimientos WHERE id = ?`),
  reset: db.prepare(`DELETE FROM movimientos`),
  totals: db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
      COALESCE(SUM(CASE WHEN tipo = 'gasto'   THEN monto ELSE 0 END), 0) AS gastos,
      COUNT(*) AS total_movimientos,
      MIN(date(created_at)) AS primer_dia,
      MAX(date(created_at)) AS ultimo_dia
    FROM movimientos
  `),
  byCategory: db.prepare(`
    SELECT categoria, tipo, SUM(monto) AS total, COUNT(*) AS n
    FROM movimientos
    GROUP BY categoria, tipo
    ORDER BY total DESC
  `),
  serieDiaria: db.prepare(`
    SELECT
      date(created_at) AS dia,
      COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
      COALESCE(SUM(CASE WHEN tipo = 'gasto'   THEN monto ELSE 0 END), 0) AS gastos
    FROM movimientos
    GROUP BY date(created_at)
    ORDER BY dia ASC
  `),
  topGasto: db.prepare(`
    SELECT * FROM movimientos WHERE tipo = 'gasto'
    ORDER BY monto DESC LIMIT 1
  `),
  topIngreso: db.prepare(`
    SELECT * FROM movimientos WHERE tipo = 'ingreso'
    ORDER BY monto DESC LIMIT 1
  `),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
};

// ---------- App + WebSocket ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware opcional de token (solo si API_TOKEN está definido)
function requireToken(req, res, next) {
  if (!API_TOKEN) return next();
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: 'Token inválido o ausente' });
  }
  next();
}

// ---------- Helpers ----------
function normalizar(body) {
  // Acepta lo que mande el agente IA en n8n y lo normaliza.
  // Sé flexible: si la IA manda un poco distinto, el dashboard no debería romperse.
  let tipo = String(body.tipo || '').toLowerCase().trim();
  if (!['gasto', 'ingreso'].includes(tipo)) {
    // Aliases comunes que un LLM puede generar
    if (['expense', 'expenditure', 'compra', 'pago'].includes(tipo)) tipo = 'gasto';
    else if (['income', 'ingresos', 'cobro', 'salario', 'sueldo'].includes(tipo)) tipo = 'ingreso';
    else tipo = 'gasto'; // default
  }

  const monto = Number(body.monto ?? body.amount ?? 0);
  if (!Number.isFinite(monto) || monto <= 0) {
    return { error: 'monto debe ser un número positivo' };
  }

  const categoria = String(body.categoria || body.category || 'otros').toLowerCase().trim().slice(0, 32);
  const descripcion = body.descripcion ? String(body.descripcion).slice(0, 256) : null;
  const usuario = body.usuario ? String(body.usuario).slice(0, 64) : null;
  const raw_text = body.raw_text ? String(body.raw_text).slice(0, 512) : null;

  return { data: { tipo, monto, categoria, descripcion, usuario, raw_text } };
}

function getMetaAhorro() {
  const row = stmt.getSetting.get('meta_ahorro');
  return row ? Number(row.value) : 0;
}

// Devuelve los últimos N días con ceros rellenados (útil para gráfico continuo)
function rellenarSerie(rowsByDay, dias = 14) {
  const map = Object.fromEntries(rowsByDay.map((r) => [r.dia, r]));
  const out = [];
  const hoy = new Date();
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoy);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const r = map[key];
    out.push({
      dia: key,
      ingresos: r ? Number(r.ingresos) : 0,
      gastos: r ? Number(r.gastos) : 0,
      balance_dia: r ? Number(r.ingresos) - Number(r.gastos) : 0,
    });
  }
  return out;
}

function calcularInsights(totals, porCategoria, serie) {
  const ingresos = Number(totals.ingresos);
  const gastos = Number(totals.gastos);
  const balance = ingresos - gastos;

  // Tasa de ahorro: (ingresos - gastos) / ingresos × 100
  const tasaAhorro = ingresos > 0 ? Math.max(0, (balance / ingresos) * 100) : 0;

  // Días con movimientos (para promedios reales, no días totales)
  const diasConDatos = new Set(
    serie.filter((d) => d.ingresos > 0 || d.gastos > 0).map((d) => d.dia)
  ).size;
  const dias = Math.max(1, diasConDatos);

  const promedioDiarioGasto = gastos / dias;
  const promedioDiarioIngreso = ingresos / dias;

  // Día más caro (mayor gasto)
  let diaMasCaro = null;
  let maxGastoDia = 0;
  for (const d of serie) {
    if (d.gastos > maxGastoDia) {
      maxGastoDia = d.gastos;
      diaMasCaro = d.dia;
    }
  }

  // Top categoría de gasto
  const gastosPorCat = porCategoria.filter((c) => c.tipo === 'gasto');
  const topCategoriaGasto = gastosPorCat[0] || null;
  const totalGastosPorCat = gastosPorCat.reduce((a, b) => a + Number(b.total), 0) || 1;
  const topCategoriasConPct = gastosPorCat.slice(0, 6).map((c) => ({
    categoria: c.categoria,
    total: Number(c.total),
    n: c.n,
    porcentaje: (Number(c.total) / totalGastosPorCat) * 100,
  }));

  // Proyección a 30 días (basado en ritmo actual)
  const proyeccionGasto30d = promedioDiarioGasto * 30;
  const proyeccionIngreso30d = promedioDiarioIngreso * 30;
  const proyeccionAhorro30d = proyeccionIngreso30d - proyeccionGasto30d;

  // "Salud financiera" — score simple 0-100
  // Basado en tasa de ahorro: <0% = 0, 0-10% = 30, 10-20% = 60, 20%+ = 90+
  let saludScore = 0;
  let saludLabel = 'sin datos';
  if (ingresos > 0) {
    if (balance < 0) { saludScore = 15; saludLabel = 'gastando más de lo que entra'; }
    else if (tasaAhorro < 10) { saludScore = 40; saludLabel = 'ahorro bajo'; }
    else if (tasaAhorro < 20) { saludScore = 65; saludLabel = 'ahorro saludable'; }
    else if (tasaAhorro < 35) { saludScore = 85; saludLabel = 'muy bien'; }
    else { saludScore = 95; saludLabel = 'excelente'; }
  }

  return {
    tasa_ahorro: Number(tasaAhorro.toFixed(1)),
    promedio_diario_gasto: Number(promedioDiarioGasto.toFixed(2)),
    promedio_diario_ingreso: Number(promedioDiarioIngreso.toFixed(2)),
    dias_con_datos: diasConDatos,
    dia_mas_caro: diaMasCaro,
    monto_dia_mas_caro: maxGastoDia,
    mayor_gasto: stmt.topGasto.get() || null,
    mayor_ingreso: stmt.topIngreso.get() || null,
    top_categoria_gasto: topCategoriaGasto
      ? { categoria: topCategoriaGasto.categoria, total: Number(topCategoriaGasto.total) }
      : null,
    top_categorias_gasto_pct: topCategoriasConPct,
    proyeccion_gasto_30d: Number(proyeccionGasto30d.toFixed(2)),
    proyeccion_ingreso_30d: Number(proyeccionIngreso30d.toFixed(2)),
    proyeccion_ahorro_30d: Number(proyeccionAhorro30d.toFixed(2)),
    salud_score: saludScore,
    salud_label: saludLabel,
  };
}

function snapshot() {
  const totals = stmt.totals.get();
  const porCategoria = stmt.byCategory.all();
  const serie = rellenarSerie(stmt.serieDiaria.all(), 14);
  const meta = getMetaAhorro();
  const balance = Number(totals.ingresos) - Number(totals.gastos);

  return {
    ingresos: Number(totals.ingresos),
    gastos: Number(totals.gastos),
    balance,
    total_movimientos: totals.total_movimientos,
    ultimos: stmt.list.all(20),
    por_categoria: porCategoria,
    serie_diaria: serie,
    meta_ahorro: meta,
    progreso_meta: meta > 0 ? Math.max(0, Math.min(100, (balance / meta) * 100)) : 0,
    insights: calcularInsights(totals, porCategoria, serie),
  };
}

// ---------- Rutas ----------

// Info para que la UI muestre qué endpoint pegar en n8n
app.get('/api/endpoint-info', (req, res) => {
  res.json({
    url: `${PUBLIC_URL}/api/movimientos`,
    metodo: 'POST',
    headers: API_TOKEN
      ? { 'Content-Type': 'application/json', Authorization: 'Bearer <TU_TOKEN>' }
      : { 'Content-Type': 'application/json' },
    body_ejemplo: {
      tipo: 'gasto',
      monto: 25000,
      categoria: 'almuerzo',
      descripcion: 'compré un almuerzo',
      usuario: '@santiago',
      raw_text: 'compré un almuerzo de 25 mil',
    },
    requiere_token: Boolean(API_TOKEN),
  });
});

// Snapshot completo (para hidratar la UI al cargar)
app.get('/api/state', (req, res) => {
  res.json(snapshot());
});

// Crear movimiento (esto es lo que llama n8n)
app.post('/api/movimientos', requireToken, (req, res) => {
  const { data, error } = normalizar(req.body || {});
  if (error) return res.status(400).json({ error });

  const info = stmt.insert.run(data);
  const movimiento = stmt.byId.get(info.lastInsertRowid);

  // Avisar a todos los dashboards conectados
  io.emit('nuevo-movimiento', { movimiento, snapshot: snapshot() });

  res.status(201).json({ ok: true, movimiento });
});

// Borrar movimiento (botón en la UI)
app.delete('/api/movimientos/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = stmt.delete.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'No existe' });
  io.emit('movimiento-borrado', { id, snapshot: snapshot() });
  res.json({ ok: true });
});

// Reset total (botón "Limpiar todo" en la UI - útil para cada clase)
app.post('/api/reset', (req, res) => {
  stmt.reset.run();
  io.emit('reset', { snapshot: snapshot() });
  res.json({ ok: true });
});

// Configurar meta de ahorro
app.post('/api/meta-ahorro', (req, res) => {
  const monto = Number(req.body?.monto);
  if (!Number.isFinite(monto) || monto < 0) {
    return res.status(400).json({ error: 'monto debe ser un número >= 0' });
  }
  stmt.setSetting.run({ key: 'meta_ahorro', value: String(monto) });
  io.emit('meta-actualizada', { snapshot: snapshot() });
  res.json({ ok: true, meta: monto });
});

// Healthcheck
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  // Mandamos snapshot al cliente que se acaba de conectar
  socket.emit('hidratar', snapshot());
});

// ---------- Arranque ----------
server.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Dashboard de Finanzas - Demo n8n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Local:        http://localhost:${PORT}`);
  console.log(`  Endpoint n8n: ${PUBLIC_URL}/api/movimientos`);
  console.log(`  Token:        ${API_TOKEN ? 'SI (Bearer)' : 'NO (modo clase)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
