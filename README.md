# Fondo de la Iglesia

App sencilla para llevar la economía de la iglesia: ingresos, egresos, categorías,
resumen mensual y exportación a CSV. Corre en **Cloudflare Workers + D1**.

> Esta rama (`cloudflare-d1`) no modifica nada de `master`.

## Estructura
- `src/index.ts` — API (Worker). Todo `/api/*` exige la clave de acceso.
- `public/index.html` — interfaz web (se sirve como Static Assets).
- `migrations/0001_init.sql` — tablas `categorias` y `movimientos` + categorías iniciales.
- `wrangler.jsonc` — configuración de Cloudflare (base D1 `fondo-de-la-iglesia`).

## Puesta en marcha
```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply fondo-de-la-iglesia --remote   # (ya aplicada; es idempotente)
npx wrangler secret put ACCESS_KEY                              # elija una clave larga
npx wrangler deploy
```

## Desarrollo local
```bash
echo 'ACCESS_KEY=una-clave-de-prueba' > .dev.vars   # no se sube a git
npx wrangler d1 migrations apply fondo-de-la-iglesia --local
npm run dev
```

## Modelo de datos
- **categorias**: `nombre`, `tipo` (ingreso | egreso), `activa`.
- **movimientos**: `fecha`, `tipo`, `categoria_id`, `monto_centavos`, `moneda` (CUP | USD | EUR),
  `persona`, `descripcion`, `comprobante`. Los montos se guardan en centavos (enteros) para evitar errores de redondeo.

## Seguridad
- La clave vive solo como *secret* de Cloudflare, nunca en el código.
- Recomendado además: poner **Cloudflare Access** delante del dominio para que solo entren las personas autorizadas.
- Haga copias: `npx wrangler d1 export fondo-de-la-iglesia --remote --output respaldo.sql`.
