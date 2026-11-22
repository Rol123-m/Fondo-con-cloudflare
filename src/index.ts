// src/index.ts
// API del Fondo de la Iglesia: Cloudflare Worker + D1.
// Todo lo que está bajo /api/ exige "Authorization: Bearer <ACCESS_KEY>".

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACCESS_KEY: string; // secreto: npx wrangler secret put ACCESS_KEY
}

type Tipo = "ingreso" | "egreso";

const TIPOS: readonly string[] = ["ingreso", "egreso"];
const MONEDAS: readonly string[] = ["CUP", "USD", "EUR"];
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const HEADERS_SEGURIDAD = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: HEADERS_SEGURIDAD });
}

// ---------- Autenticación ----------

async function sha256(texto: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
}

/** Compara la clave en tiempo constante (se comparan hashes del mismo largo). */
async function autorizado(request: Request, env: Env): Promise<boolean> {
  if (!env.ACCESS_KEY) {
    throw new HttpError(500, "Falta configurar el secreto ACCESS_KEY");
  }
  const cabecera = request.headers.get("Authorization") ?? "";
  const token = cabecera.startsWith("Bearer ") ? cabecera.slice(7) : "";
  const [a, b] = await Promise.all([sha256(token), sha256(env.ACCESS_KEY)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ---------- Validación ----------

function fechaValida(f: unknown): f is string {
  if (typeof f !== "string" || !FECHA_RE.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

function textoOpcional(v: unknown, max: number, campo: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new HttpError(400, `${campo} debe ser texto`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${campo} es demasiado largo (máx. ${max})`);
  return t || null;
}

interface MovimientoValidado {
  fecha: string;
  tipo: Tipo;
  categoria_id: number;
  monto_centavos: number;
  moneda: string;
  descripcion: string | null;
  persona: string | null;
  comprobante: string | null;
}

async function leerMovimiento(request: Request, env: Env): Promise<MovimientoValidado> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "El cuerpo debe ser JSON válido");
  }

  if (!fechaValida(body.fecha)) throw new HttpError(400, "Fecha inválida (use AAAA-MM-DD)");
  if (typeof body.tipo !== "string" || !TIPOS.includes(body.tipo)) {
    throw new HttpError(400, "Tipo debe ser 'ingreso' o 'egreso'");
  }
  const monto = Number(body.monto);
  if (!Number.isFinite(monto) || monto <= 0 || monto > 1_000_000_000) {
    throw new HttpError(400, "El monto debe ser un número mayor que 0");
  }
  const moneda = typeof body.moneda === "string" ? body.moneda : "CUP";
  if (!MONEDAS.includes(moneda)) throw new HttpError(400, "Moneda no válida");

  const categoriaId = Number(body.categoria_id);
  if (!Number.isInteger(categoriaId)) throw new HttpError(400, "Categoría inválida");
  const cat = await env.DB.prepare("SELECT tipo, activa FROM categorias WHERE id = ?")
    .bind(categoriaId)
    .first<{ tipo: string; activa: number }>();
  if (!cat) throw new HttpError(400, "La categoría no existe");
  if (cat.tipo !== body.tipo) throw new HttpError(400, "La categoría no corresponde al tipo de movimiento");

  return {
    fecha: body.fecha,
    tipo: body.tipo as Tipo,
    categoria_id: categoriaId,
    monto_centavos: Math.round(monto * 100),
    moneda,
    descripcion: textoOpcional(body.descripcion, 500, "Descripción"),
    persona: textoOpcional(body.persona, 120, "Persona"),
    comprobante: textoOpcional(body.comprobante, 60, "Comprobante"),
  };
}

// ---------- Utilidades de consulta ----------

function mesActual(): { desde: string; hasta: string } {
  const hoy = new Date();
  const y = hoy.getUTCFullYear();
  const m = hoy.getUTCMonth();
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const mm = String(m + 1).padStart(2, "0");
  return { desde: `${y}-${mm}-01`, hasta: `${y}-${mm}-${String(ultimo).padStart(2, "0")}` };
}

function rango(url: URL): { desde: string; hasta: string } {
  const def = mesActual();
  const desde = url.searchParams.get("desde") ?? def.desde;
  const hasta = url.searchParams.get("hasta") ?? def.hasta;
  if (!fechaValida(desde) || !fechaValida(hasta)) {
    throw new HttpError(400, "Rango de fechas inválido (use AAAA-MM-DD)");
  }
  return { desde, hasta };
}

function celdaCsv(valor: unknown): string {
  let s = valor === null || valor === undefined ? "" : String(valor);
  // Evita inyección de fórmulas al abrir el CSV en Excel/Sheets
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const SELECT_MOVIMIENTOS = `
  SELECT m.id, m.fecha, m.tipo, m.categoria_id, c.nombre AS categoria,
         ROUND(m.monto_centavos / 100.0, 2) AS monto, m.moneda,
         m.descripcion, m.persona, m.comprobante
  FROM movimientos m
  JOIN categorias c ON c.id = m.categoria_id`;

// ---------- Rutas ----------

async function manejarApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const metodo = request.method;
  let m: RegExpMatchArray | null;

  // --- Categorías ---
  if (pathname === "/api/categorias" && metodo === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, nombre, tipo, activa FROM categorias ORDER BY tipo, nombre",
    ).all();
    return json(results);
  }

  if (pathname === "/api/categorias" && metodo === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const nombre = typeof body?.nombre === "string" ? body.nombre.trim() : "";
    const tipo = body?.tipo;
    if (!nombre || nombre.length > 80) throw new HttpError(400, "Nombre inválido (1 a 80 caracteres)");
    if (typeof tipo !== "string" || !TIPOS.includes(tipo)) throw new HttpError(400, "Tipo inválido");
    try {
      const r = await env.DB.prepare("INSERT INTO categorias (nombre, tipo) VALUES (?, ?)")
        .bind(nombre, tipo)
        .run();
      return json({ id: r.meta.last_row_id, nombre, tipo, activa: 1 }, 201);
    } catch {
      throw new HttpError(409, "Ya existe una categoría con ese nombre");
    }
  }

  if ((m = pathname.match(/^\/api\/categorias\/(\d+)$/)) && metodo === "PATCH") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.activa !== "boolean") throw new HttpError(400, "Enviar { activa: true|false }");
    const r = await env.DB.prepare("UPDATE categorias SET activa = ? WHERE id = ?")
      .bind(body.activa ? 1 : 0, Number(m[1]))
      .run();
    if (!r.meta.changes) throw new HttpError(404, "Categoría no encontrada");
    return json({ ok: true });
  }

  // --- Movimientos ---
  if (pathname === "/api/movimientos" && metodo === "GET") {
    const { desde, hasta } = rango(url);
    const condiciones = ["m.fecha BETWEEN ? AND ?"];
    const params: (string | number)[] = [desde, hasta];

    const tipo = url.searchParams.get("tipo");
    if (tipo) {
      if (!TIPOS.includes(tipo)) throw new HttpError(400, "Tipo inválido");
      condiciones.push("m.tipo = ?");
      params.push(tipo);
    }
    const cat = url.searchParams.get("categoria_id");
    if (cat) {
      if (!/^\d+$/.test(cat)) throw new HttpError(400, "Categoría inválida");
      condiciones.push("m.categoria_id = ?");
      params.push(Number(cat));
    }
    const limite = Math.min(Number(url.searchParams.get("limit")) || 500, 2000);

    const { results } = await env.DB.prepare(
      `${SELECT_MOVIMIENTOS} WHERE ${condiciones.join(" AND ")}
       ORDER BY m.fecha DESC, m.id DESC LIMIT ?`,
    )
      .bind(...params, limite)
      .all();
    return json(results);
  }

  if (pathname === "/api/movimientos" && metodo === "POST") {
    const v = await leerMovimiento(request, env);
    const r = await env.DB.prepare(
      `INSERT INTO movimientos
         (fecha, tipo, categoria_id, monto_centavos, moneda, descripcion, persona, comprobante)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(v.fecha, v.tipo, v.categoria_id, v.monto_centavos, v.moneda, v.descripcion, v.persona, v.comprobante)
      .run();
    return json({ id: r.meta.last_row_id }, 201);
  }

  if ((m = pathname.match(/^\/api\/movimientos\/(\d+)$/))) {
    const id = Number(m[1]);
    if (metodo === "PUT") {
      const v = await leerMovimiento(request, env);
      const r = await env.DB.prepare(
        `UPDATE movimientos
            SET fecha = ?, tipo = ?, categoria_id = ?, monto_centavos = ?, moneda = ?,
                descripcion = ?, persona = ?, comprobante = ?, actualizado_en = datetime('now')
          WHERE id = ?`,
      )
        .bind(v.fecha, v.tipo, v.categoria_id, v.monto_centavos, v.moneda, v.descripcion, v.persona, v.comprobante, id)
        .run();
      if (!r.meta.changes) throw new HttpError(404, "Movimiento no encontrado");
      return json({ ok: true });
    }
    if (metodo === "DELETE") {
      const r = await env.DB.prepare("DELETE FROM movimientos WHERE id = ?").bind(id).run();
      if (!r.meta.changes) throw new HttpError(404, "Movimiento no encontrado");
      return json({ ok: true });
    }
  }

  // --- Resumen ---
  if (pathname === "/api/resumen" && metodo === "GET") {
    const { desde, hasta } = rango(url);

    const totalesSql = (filtro: string) => `
      SELECT moneda,
             ROUND(SUM(CASE WHEN tipo = 'ingreso' THEN monto_centavos ELSE 0 END) / 100.0, 2) AS ingresos,
             ROUND(SUM(CASE WHEN tipo = 'egreso'  THEN monto_centavos ELSE 0 END) / 100.0, 2) AS egresos,
             ROUND(SUM(CASE WHEN tipo = 'ingreso' THEN monto_centavos ELSE -monto_centavos END) / 100.0, 2) AS balance
        FROM movimientos ${filtro}
       GROUP BY moneda ORDER BY moneda`;

    const [periodo, acumulado, porCategoria] = await env.DB.batch([
      env.DB.prepare(totalesSql("WHERE fecha BETWEEN ? AND ?")).bind(desde, hasta),
      env.DB.prepare(totalesSql("")),
      env.DB.prepare(
        `SELECT c.nombre AS categoria, m.tipo, m.moneda,
                ROUND(SUM(m.monto_centavos) / 100.0, 2) AS total
           FROM movimientos m JOIN categorias c ON c.id = m.categoria_id
          WHERE m.fecha BETWEEN ? AND ?
          GROUP BY c.nombre, m.tipo, m.moneda
          ORDER BY m.tipo, total DESC`,
      ).bind(desde, hasta),
    ]);

    return json({
      periodo: { desde, hasta },
      totales_periodo: periodo.results,
      saldo_acumulado: acumulado.results,
      por_categoria: porCategoria.results,
    });
  }

  // --- Exportar CSV ---
  if (pathname === "/api/export.csv" && metodo === "GET") {
    const { desde, hasta } = rango(url);
    const { results } = await env.DB.prepare(
      `${SELECT_MOVIMIENTOS} WHERE m.fecha BETWEEN ? AND ? ORDER BY m.fecha, m.id`,
    )
      .bind(desde, hasta)
      .all<Record<string, unknown>>();

    const columnas = ["fecha", "tipo", "categoria", "monto", "moneda", "persona", "descripcion", "comprobante"];
    const lineas = [columnas.join(",")];
    for (const fila of results) lineas.push(columnas.map((c) => celdaCsv(fila[c])).join(","));

    return new Response("\uFEFF" + lineas.join("\r\n"), {
      headers: {
        ...HEADERS_SEGURIDAD,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fondo-iglesia_${desde}_${hasta}.csv"`,
      },
    });
  }

  throw new HttpError(404, "Ruta no encontrada");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // Todo lo que no es /api/ lo sirve el frontend estático
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (!(await autorizado(request, env))) return json({ error: "No autorizado" }, 401);
      return await manejarApi(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("Error no controlado:", e);
      return json({ error: "Error interno" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
