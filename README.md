# Dashboard Finanzas — Demo n8n + Telegram

Dashboard en vivo para mostrar en clases de **n8n**. Cuando un alumno (o vos)
escribe por Telegram algo como _"compré un almuerzo de 25 mil"_ (montos en **COP**):

1. **Telegram** envía el mensaje a **n8n** (vía Telegram Trigger).
2. **n8n** lo interpreta (con un agente IA, o con un parser simple sin IA).
3. **n8n** hace un `POST` al endpoint `/api/movimientos` de este servidor.
4. El servidor guarda en **SQLite** y emite por **WebSocket**.
5. La **UI** (este dashboard) muestra el movimiento en tiempo real, proyectable.

---

## Stack

- **Backend**: Node.js + Express + Socket.IO + SQLite (`better-sqlite3`)
- **Frontend**: HTML + CSS + JS plano (cero build, leíble por alumnos)
- **DB**: archivo único en `data/finanzas.db`

---

## Instalación rápida

```bash
cd finanzas-demo
cp .env.example .env
npm install
npm start
```

Abrí: <http://localhost:3000>

---

## Variables de entorno (`.env`)

```ini
PORT=3000
PUBLIC_URL=http://localhost:3000     # cambiala a tu URL de ngrok / deploy
API_TOKEN=                            # opcional, dejá vacío en clase
```

> Si vas a llamar al servidor desde n8n cloud (o desde otro lado), `PUBLIC_URL`
> debe ser una URL **alcanzable desde internet**. Ver sección [Exponer a internet](#exponer-a-internet).

---

## Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| `GET`  | `/` | Dashboard live |
| `GET`  | `/api/endpoint-info` | Devuelve URL + JSON de ejemplo (lo consume la UI) |
| `GET`  | `/api/state` | Snapshot completo (KPIs + lista) |
| `POST` | `/api/movimientos` | **Lo que llama n8n** |
| `DELETE` | `/api/movimientos/:id` | Borrar uno (botón ×) |
| `POST` | `/api/reset` | Limpiar todo (botón "Limpiar todo") |
| `GET`  | `/api/health` | Healthcheck |

### Body que espera `POST /api/movimientos`

```json
{
  "tipo": "gasto",                   // "gasto" | "ingreso"
  "monto": 25000,                    // número > 0 (en COP)
  "categoria": "almuerzo",           // string corto
  "descripcion": "compré un almuerzo",
  "usuario": "@santiago",            // opcional
  "raw_text": "compré un almuerzo"   // opcional, mensaje original
}
```

El servidor es **flexible**: acepta `expense`/`income`, mapea aliases, y si
falta algún campo no crítico le pone defaults. Eso ayuda cuando el LLM responde
distinto de lo esperado.

---

## Exponer a internet (para que Telegram alcance n8n y n8n alcance este dashboard)

Telegram **exige HTTPS** para webhooks. n8n necesita salir a internet (o ya
tener URL pública si usás n8n Cloud). Y **este dashboard** también necesita ser
alcanzable desde n8n.

### Opción A — `ngrok` (más simple)

```bash
# 1. Instalá ngrok y autenticá una vez:
ngrok config add-authtoken <TU_TOKEN>

# 2. Levantá el dashboard:
npm start                # corre en :3000

# 3. En otra terminal exponelo:
ngrok http 3000
# → te da una URL tipo https://abc123.ngrok-free.app
```

Copiá esa URL en `.env`:

```ini
PUBLIC_URL=https://abc123.ngrok-free.app
```

Reiniciá `npm start` y la UI ya muestra esa URL en el panel "Endpoint para tu n8n".

### Opción B — Deploy en Render / Railway (gratis, URL fija)

1. Subí el repo a GitHub.
2. Render → "New Web Service" → conectalo.
3. Build: `npm install` · Start: `npm start`.
4. Setea `PUBLIC_URL` en las env vars (ej: `https://finanzas-demo.onrender.com`).

### Opción C — n8n Cloud + ngrok del dashboard

n8n Cloud ya viene con HTTPS, así que **no necesitás túnel para el lado de n8n**.
Solo necesitás túnel para tu dashboard local (con ngrok).

---

## Conectar con Telegram

1. Hablale a **@BotFather** en Telegram → `/newbot` → guardá el token.
2. En n8n, creá una credencial "Telegram API" con ese token.
3. Importá uno de los workflows de la carpeta `workflows/`:
   - `01-telegram-finanzas-con-ia.json` → usa **OpenAI** para interpretar texto libre.
   - `02-telegram-finanzas-sin-ia.json` → usa parser manual (`gasto 25000 almuerzo` o `gasto 25k almuerzo`), **gratis**.
4. En el nodo **HTTP Request → POST → Dashboard**, reemplazá la URL por
   tu `PUBLIC_URL/api/movimientos`.
5. Activá el workflow.
6. Mandale un mensaje al bot. La orden debería aparecer en el dashboard al instante.

---

## Guardar también en Google Sheets (cada alumno con SU sheet)

Los workflows ya traen un nodo **"Google Sheets: Append"** que escribe cada
movimiento en una hoja de cálculo. Cada alumno usa su propia sheet — solo tienen
que cambiar **2 cosas**:

### Paso 1 — Cada alumno crea su Google Sheet

Seguí las instrucciones de [`workflows/google-sheet-template.md`](./workflows/google-sheet-template.md):

- Creá una nueva sheet en Google.
- Renombrá la pestaña a **`Movimientos`** (importante: ese nombre es exacto).
- Pegá los headers en A1 (copiá esta línea, Sheets divide por tabs):

  ```
  fecha	tipo	monto	categoria	descripcion	usuario	raw_text
  ```

- Copiá el **Sheet ID** desde la URL:
  `https://docs.google.com/spreadsheets/d/`**`1AbCd…XXXXXX`**`/edit`

### Paso 2 — Cada alumno conecta su Google Account en n8n

En el workflow, hacé click en el nodo **"Google Sheets: Append"** y:

1. Click en **Credentials → Create new** → "Google Sheets OAuth2 API".
2. Login con tu cuenta de Google → autorizar n8n.
3. (En n8n Cloud esto es automático. En self-hosted hay que crear OAuth client en Google Cloud — ver docs).

### Paso 3 — Cada alumno pega SU Sheet ID

En el mismo nodo "Google Sheets: Append":

- Campo **Document**: cambiá `REPLACE_CON_TU_SHEET_ID` por el Sheet ID que copiaste en el paso 1.
  - O usá el dropdown "From list" — n8n muestra todas tus sheets.
- Campo **Sheet**: dejalo en `Movimientos` (es el nombre de la pestaña).

### Paso 4 — Activar y probar

Activá el workflow → mandale un mensaje al bot → revisá que aparezca:

- En tu **dashboard** (live).
- En tu **Google Sheet** (fila nueva al final).

> Tip didáctico para clase: abrí Google Sheets en otra pestaña del proyector.
> Cuando mandes el mensaje al bot, los alumnos ven **dos cosas a la vez**: el
> dashboard pintando la tarjeta y la sheet llenándose con la fila nueva. Muy visual.

---

## Workflows incluidos

### `01-telegram-finanzas-con-ia.json`

```
Telegram Trigger
   ↓
AI Agent (system prompt extrae JSON)
   ↓ (usa OpenAI Chat Model — gpt-4o-mini)
Code: Normalizar JSON
   ↓
HTTP Request: POST → Dashboard
   ↓
Telegram: Responder al usuario
   ↓
Google Sheets: Append (la sheet del alumno)
```

**Pros**: el alumno escribe natural ("me compré un café por 8 mil").
**Contras**: requiere clave de OpenAI (paga).

### `02-telegram-finanzas-sin-ia.json`

```
Telegram Trigger
   ↓
Code: Parsear comando ("gasto 25000 almuerzo")
   ↓
IF: ¿comando inválido?
   ├── sí → Telegram: ayuda con formato
   └── no → HTTP Request: POST → Dashboard
                  ↓
              Telegram: Responder OK
                  ↓
              Google Sheets: Append (la sheet del alumno)
```

**Pros**: 100% gratis, enseña Code/IF/Switch + Google Sheets.
**Contras**: el alumno tiene que aprender el formato `gasto <monto> <descripcion>`.

---

## Para mostrar en clase

1. Proyector → tab 1: <http://localhost:3000> (el dashboard).
2. Proyector → tab 2: tu n8n (para mostrar los nodos en vivo).
3. Tu celular: Telegram con el bot abierto.
4. Mandás un mensaje, los alumnos ven aparecer la tarjeta animada.
5. Botón **"Limpiar todo"** entre clase y clase para resetear.

---

## Estructura

```
finanzas-demo/
├── server.js
├── package.json
├── .env.example
├── README.md
├── data/                   # SQLite se crea acá automáticamente
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── workflows/
    ├── 01-telegram-finanzas-con-ia.json
    └── 02-telegram-finanzas-sin-ia.json
```

---

## Ideas para extender (próximas clases)

- **Cron diario** en n8n: a las 9pm te manda por Telegram el resumen del día.
- **Categoría inteligente**: agregar Switch en n8n para detectar emergencias (`gasto > 500000 COP`).
- **Multi-usuario**: filtrar por `chat_id` para que cada alumno vea solo lo suyo.
- **Google Sheets**: agregar nodo paralelo que escriba en una hoja de cálculo.
- **Alertas**: si los gastos del día > X, mandar mensaje a un canal de Telegram.

---

## Troubleshooting

- **"Cannot find module 'better-sqlite3'"** → corré `npm install`.
- **n8n recibe Telegram pero el POST falla** → revisá que `PUBLIC_URL` sea HTTPS y alcanzable.
- **El dashboard no muestra nada** → abrí DevTools → Network → revisá si llega `nuevo-movimiento` por Socket.IO.
- **Telegram no dispara el workflow** → en n8n el workflow debe estar **Active** (toggle arriba a la derecha).
