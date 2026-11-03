import sqlite3
import os
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    psycopg2 = None
from flask import g

# Volumen de Railway
_data_dir = '/data'
os.makedirs(_data_dir, exist_ok=True)
DATABASE = os.path.join(_data_dir, 'inventario.db')

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA journal_mode = WAL")
        g.db.execute("PRAGMA synchronous = FULL")
    return g.db

def init_db():
    os.makedirs(os.path.dirname(DATABASE), exist_ok=True)
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS productos (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre          TEXT NOT NULL,
            categoria       TEXT DEFAULT 'General',
            descripcion     TEXT DEFAULT '',
            precio_compra   REAL DEFAULT 0,
            precio_venta    REAL DEFAULT 0,
            stock           INTEGER DEFAULT 0,
            stock_minimo    INTEGER DEFAULT 5,
            stock_maximo    INTEGER DEFAULT 0,
            unidad          TEXT DEFAULT 'unidad',
            imagen_url      TEXT DEFAULT '',
            codigo_barras   TEXT DEFAULT '',
            fecha_creacion  TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS ventas (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            producto_id     INTEGER NOT NULL,
            cantidad        INTEGER NOT NULL,
            precio_unitario REAL NOT NULL,
            total           REAL NOT NULL,
            ganancia        REAL DEFAULT 0,
            notas           TEXT DEFAULT '',
            fecha           TEXT DEFAULT (datetime('now')),
            venta_grupo_id  INTEGER DEFAULT 0,
            metodo_pago_id  INTEGER,
            pago_referencia TEXT DEFAULT '',
            FOREIGN KEY (producto_id) REFERENCES productos(id)
        );
        CREATE TABLE IF NOT EXISTS configuracion (
            clave TEXT PRIMARY KEY,
            valor TEXT
        );
        CREATE TABLE IF NOT EXISTS metodos_pago (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre                 TEXT NOT NULL UNIQUE,
            activo                 INTEGER DEFAULT 1,
            orden                  INTEGER DEFAULT 0,
            requiere_datos_moviles INTEGER DEFAULT 0,
            datos_cedula           TEXT DEFAULT '',
            datos_banco            TEXT DEFAULT '',
            datos_telefono         TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS proveedores (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre          TEXT NOT NULL,
            telefono        TEXT DEFAULT '',
            rif_cedula      TEXT DEFAULT '',
            direccion       TEXT DEFAULT '',
            notas           TEXT DEFAULT '',
            activo          INTEGER DEFAULT 1,
            fecha_creacion  TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_codigo_barras ON productos(codigo_barras);
    """)

    # ── Migraciones ──
    cols_prod = [r[1] for r in conn.execute("PRAGMA table_info(productos)").fetchall()]
    if 'codigo_barras' not in cols_prod:
        conn.execute("ALTER TABLE productos ADD COLUMN codigo_barras TEXT DEFAULT ''")
    if 'stock_maximo' not in cols_prod:
        conn.execute("ALTER TABLE productos ADD COLUMN stock_maximo INTEGER DEFAULT 0")
    if 'proveedor_id' not in cols_prod:
        conn.execute("ALTER TABLE productos ADD COLUMN proveedor_id INTEGER")
    if 'precio_caja' not in cols_prod:
        conn.execute("ALTER TABLE productos ADD COLUMN precio_caja REAL DEFAULT 0")
    if 'unidades_por_caja' not in cols_prod:
        conn.execute("ALTER TABLE productos ADD COLUMN unidades_por_caja INTEGER DEFAULT 0")
    if 'tipo_medida' not in cols_prod:
        conn.execute("ALTER TABLE productos ADD COLUMN tipo_medida TEXT DEFAULT 'unidad'")

    cols_venta = [r[1] for r in conn.execute("PRAGMA table_info(ventas)").fetchall()]
    if 'venta_grupo_id' not in cols_venta:
        conn.execute("ALTER TABLE ventas ADD COLUMN venta_grupo_id INTEGER DEFAULT 0")
        ventas = conn.execute("SELECT id FROM ventas ORDER BY id").fetchall()
        for v in ventas:
            conn.execute("UPDATE ventas SET venta_grupo_id=? WHERE id=?", (v['id'], v['id']))
    if 'metodo_pago_id' not in cols_venta:
        conn.execute("ALTER TABLE ventas ADD COLUMN metodo_pago_id INTEGER")
    if 'pago_referencia' not in cols_venta:
        conn.execute("ALTER TABLE ventas ADD COLUMN pago_referencia TEXT DEFAULT ''")
    if 'pago_moneda' not in cols_venta:
        conn.execute("ALTER TABLE ventas ADD COLUMN pago_moneda TEXT DEFAULT ''")
    if 'pago_monto' not in cols_venta:
        conn.execute("ALTER TABLE ventas ADD COLUMN pago_monto REAL DEFAULT 0")
    if 'pagos_json' not in cols_venta:
        conn.execute("ALTER TABLE ventas ADD COLUMN pagos_json TEXT DEFAULT ''")
    # Columnas de versiones intermedias que ya no se usan por venta (se dejan,
    # inofensivas, para no romper bases de datos existentes con ALTER DROP):
    for col in ['pago_cedula', 'pago_banco', 'pago_telefono']:
        if col not in cols_venta:
            conn.execute(f"ALTER TABLE ventas ADD COLUMN {col} TEXT DEFAULT ''")

    cols_metodo = [r[1] for r in conn.execute("PRAGMA table_info(metodos_pago)").fetchall()]
    if cols_metodo and 'requiere_datos_moviles' not in cols_metodo:
        conn.execute("ALTER TABLE metodos_pago ADD COLUMN requiere_datos_moviles INTEGER DEFAULT 0")
    for col in ['datos_cedula', 'datos_banco', 'datos_telefono']:
        if cols_metodo and col not in cols_metodo:
            conn.execute(f"ALTER TABLE metodos_pago ADD COLUMN {col} TEXT DEFAULT ''")

    conn.commit()

    # Nota: NO hay contraseña de administrador por defecto. app.py expone
    # /api/configurar-password-inicial para que el dueño la cree él mismo
    # la primera vez (mínimo 8 caracteres, mayúscula, minúscula y número).

    # ── Métodos de pago por defecto ──
    if conn.execute("SELECT COUNT(*) FROM metodos_pago").fetchone()[0] == 0:
        metodos_default = [("Efectivo", 0), ("Punto", 0), ("Pago Móvil", 1), ("Biopago", 0)]
        for i, (nombre, requiere_moviles) in enumerate(metodos_default):
            conn.execute(
                "INSERT INTO metodos_pago (nombre, activo, orden, requiere_datos_moviles) VALUES (?,1,?,?)",
                (nombre, i, requiere_moviles))
        conn.commit()

    # No se insertan productos de ejemplo (versión lista para producción).
    # La base de datos arranca vacía. Agrega tus productos desde Administración.
    conn.close()
