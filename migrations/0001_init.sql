-- Fondo de la Iglesia: esquema inicial (idempotente)
CREATE TABLE IF NOT EXISTS categorias (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre  TEXT NOT NULL,
  tipo    TEXT NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  activa  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (nombre, tipo)
);

CREATE TABLE IF NOT EXISTS movimientos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha           TEXT NOT NULL,                      -- YYYY-MM-DD
  tipo            TEXT NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  categoria_id    INTEGER NOT NULL REFERENCES categorias(id),
  monto_centavos  INTEGER NOT NULL CHECK (monto_centavos > 0),
  moneda          TEXT NOT NULL DEFAULT 'CUP' CHECK (moneda IN ('CUP', 'USD', 'EUR')),
  descripcion     TEXT,
  persona         TEXT,                               -- quien da / a quien se paga
  comprobante     TEXT,                               -- no. de recibo o factura
  creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mov_fecha     ON movimientos(fecha);
CREATE INDEX IF NOT EXISTS idx_mov_categoria ON movimientos(categoria_id);

INSERT OR IGNORE INTO categorias (nombre, tipo) VALUES
  ('Diezmos', 'ingreso'),
  ('Ofrendas', 'ingreso'),
  ('Ofrenda de misiones', 'ingreso'),
  ('Donaciones', 'ingreso'),
  ('Otros ingresos', 'ingreso'),
  ('Ayuda a necesitados', 'egreso'),
  ('Mantenimiento del templo', 'egreso'),
  ('Servicios (luz, agua, etc.)', 'egreso'),
  ('Materiales de ministerios', 'egreso'),
  ('Misiones', 'egreso'),
  ('Apoyo pastoral', 'egreso'),
  ('Otros egresos', 'egreso');
