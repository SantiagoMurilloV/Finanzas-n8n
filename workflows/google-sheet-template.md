# Template de Google Sheet — Finanzas Demo

Esta es la estructura que cada alumno debe crear en **su propia** Google Sheet
para que el workflow de n8n pueda guardar los movimientos.

---

## 1. Crear la Sheet

1. Abrí <https://sheets.google.com> y creá una nueva.
2. Renombrala a **"Finanzas n8n"** (o como quieras).
3. La pestaña por defecto se llama `Hoja 1` — renombrala a **`Movimientos`**
   (es importante porque el workflow va a buscar esa pestaña).

## 2. Pegá los headers

En la fila 1 (de A1 a G1), pegá exactamente esto:

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| `fecha` | `tipo` | `monto` | `categoria` | `descripcion` | `usuario` | `raw_text` |

**Truco rápido**: copiá la siguiente línea y pegala en A1 (Sheets divide
automáticamente por tabs):

```
fecha	tipo	monto	categoria	descripcion	usuario	raw_text
```

Quedará algo así:

```
┌─────────────────────┬─────────┬────────┬───────────┬──────────────────┬────────────┬──────────────────────────┐
│ fecha               │ tipo    │ monto  │ categoria │ descripcion      │ usuario    │ raw_text                 │
├─────────────────────┼─────────┼────────┼───────────┼──────────────────┼────────────┼──────────────────────────┤
│ 2026-05-04 14:30:12 │ gasto   │ 25000  │ comida    │ almuerzo         │ @santiago  │ compré un almuerzo de 25k│
│ 2026-05-04 18:00:01 │ ingreso │ 1500000│ freelance │ proyecto cliente │ @santiago  │ me pagaron 1.5M cliente  │
└─────────────────────┴─────────┴────────┴───────────┴──────────────────┴────────────┴──────────────────────────┘
```

## 3. Copiá el **Sheet ID** de la URL

La URL de tu sheet se ve así:

```
https://docs.google.com/spreadsheets/d/1AbCdEfGhIj_XXXXXXXXXXXXXXXXXXXXXXXXXX/edit
                                       └────────── ESTO ES EL SHEET ID ─────────┘
```

Copiá ese ID — lo vas a pegar en el nodo **Google Sheets** del workflow de n8n.

## 4. Formato del monto (opcional pero recomendado)

Para que la columna `monto` se vea como pesos colombianos:

1. Seleccioná la columna **C**.
2. **Formato → Número → Moneda personalizada**.
3. Ponele `"$"#,##0` (sin decimales, separador de miles).

Quedará: `$25.000`, `$1.500.000`, etc.

## 5. (Opcional) Fórmulas útiles para mostrar en clase

En cualquier celda libre, podés agregar:

| Fórmula | Para qué |
|---|---|
| `=SUMIF(B:B,"ingreso",C:C)` | Total ingresos |
| `=SUMIF(B:B,"gasto",C:C)` | Total gastos |
| `=SUMIF(B:B,"ingreso",C:C) - SUMIF(B:B,"gasto",C:C)` | Balance |
| `=COUNTIF(D:D,"comida")` | Cuántos movimientos en comida |

---

## Listo

Con tu Sheet creada y el Sheet ID copiado, ya podés ir al workflow en n8n y
configurar el nodo **Google Sheets** con tu credential y tu Sheet ID.
