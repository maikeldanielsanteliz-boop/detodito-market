"""Conexión a MySQL (PyMySQL), creación de tablas y migraciones automáticas."""
import json
import logging
import re

import pymysql
import pymysql.cursors
from pymysql.constants import FIELD_TYPE
from pymysql.converters import conversions
from flask import g

import config

log = logging.getLogger('detodito.db')


class Fila(dict):
    """Fila de resultado: se lee por nombre (fila['stock']) o por posición (fila[0])."""
    def __getitem__(self, clave):
        if isinstance(clave, int):
            return list(self.values())[clave]
        return super().__getitem__(clave)


class _CursorFila(pymysql.cursors.DictCursor):
    dict_type = Fila   # cada fila se devuelve como Fila


def _fecha_a_texto(valor):
    """DATETIME -> texto ISO ('2026-11-08T14:30:00'), el formato que lee el navegador."""
    if isinstance(valor, bytes):
        valor = valor.decode()
    return valor.replace(' ', 'T')


def _a_texto(valor):
    """Convierte bytes a texto (para fechas DATE)."""
    return valor.decode() if isinstance(valor, bytes) else valor


# Conversión de tipos: los DECIMAL llegan como float (JSON) y las fechas como texto
_CONV = conversions.copy()
_CONV[FIELD_TYPE.DECIMAL] = float
_CONV[FIELD_TYPE.NEWDECIMAL] = float
_CONV[FIELD_TYPE.DATETIME] = _fecha_a_texto
_CONV[FIELD_TYPE.TIMESTAMP] = _fecha_a_texto
_CONV[FIELD_TYPE.DATE] = _a_texto


def _adaptar(sql):
    """Las consultas usan '?' como marcador; PyMySQL usa '%s' (y '%' literal se duplica)."""
    return sql.replace('%', '%%').replace('?', '%s')


class Conexion:
    """Envoltorio de la conexión: execute() devuelve un cursor con filas tipo Fila."""
    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=None):
        if isinstance(params, dict):
            raise TypeError("Usa marcadores '?' con una lista de valores (no nombres)")
        cur = self._raw.cursor()
        if params:
            cur.execute(_adaptar(sql), tuple(params))
        else:
            cur.execute(sql)
        return cur

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        try:
            self._raw.close()
        except Exception:
            pass


def _conectar(con_base=True):
    """Abre una conexión nueva a MySQL (sin transacciones automáticas)."""
    cfg = dict(config.MYSQL)
    if not con_base:
        cfg.pop('database', None)
    return pymysql.connect(**cfg, cursorclass=_CursorFila, conv=_CONV,
                           autocommit=False, connect_timeout=10)


def get_db():
    """Conexión de la petición actual (se abre una vez y se cierra al terminar la petición)."""
    if 'db' not in g:
        g.db = Conexion(_conectar())
    return g.db


# ───────────────────────── ESQUEMA ─────────────────────────
_MOTOR = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"

_TABLAS = [
    # Catálogo de productos (stock en DECIMAL para kg/litros con decimales)
    f"""CREATE TABLE IF NOT EXISTS productos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        categoria VARCHAR(100) NOT NULL DEFAULT 'General',
        descripcion TEXT NULL,
        precio_compra DECIMAL(14,4) NOT NULL DEFAULT 0,
        precio_venta DECIMAL(14,4) NOT NULL DEFAULT 0,
        stock DECIMAL(14,3) NOT NULL DEFAULT 0,
        stock_minimo INT NOT NULL DEFAULT 5,
        stock_maximo INT NOT NULL DEFAULT 0,
        unidad VARCHAR(30) NOT NULL DEFAULT 'unidad',
        imagen_url VARCHAR(500) NOT NULL DEFAULT '',
        codigo_barras VARCHAR(100) NOT NULL DEFAULT '',
        proveedor_id INT NULL,
        tipo_medida VARCHAR(20) NOT NULL DEFAULT 'unidad',
        fecha_creacion DATETIME NULL DEFAULT CURRENT_TIMESTAMP
    ) {_MOTOR}""",
    # Una fila por producto vendido; las filas de una misma factura comparten venta_grupo_id
    f"""CREATE TABLE IF NOT EXISTS ventas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        producto_id INT NOT NULL,
        cantidad DECIMAL(14,3) NOT NULL,
        precio_unitario DECIMAL(14,4) NOT NULL,
        total DECIMAL(14,2) NOT NULL,
        ganancia DECIMAL(14,2) NOT NULL DEFAULT 0,
        notas VARCHAR(500) NOT NULL DEFAULT '',
        fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        venta_grupo_id INT NOT NULL DEFAULT 0,
        metodo_pago_id INT NULL,
        pago_referencia VARCHAR(100) NOT NULL DEFAULT '',
        pago_moneda VARCHAR(10) NOT NULL DEFAULT '',
        pago_monto DECIMAL(14,2) NOT NULL DEFAULT 0,
        pagos_json TEXT NULL,
        tasa_bs DECIMAL(14,4) NULL
    ) {_MOTOR}""",
    # Ajustes clave/valor (hash de la contraseña, contador de facturas, última tasa)
    f"""CREATE TABLE IF NOT EXISTS configuracion (
        clave VARCHAR(100) NOT NULL PRIMARY KEY,
        valor TEXT NULL
    ) {_MOTOR}""",
    # Formas de pago configurables (Efectivo, Punto, Pago Móvil, Biopago...)
    f"""CREATE TABLE IF NOT EXISTS metodos_pago (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE,
        activo TINYINT NOT NULL DEFAULT 1,
        orden INT NOT NULL DEFAULT 0,
        requiere_datos_moviles TINYINT NOT NULL DEFAULT 0,
        datos_cedula VARCHAR(50) NOT NULL DEFAULT '',
        datos_banco VARCHAR(100) NOT NULL DEFAULT '',
        datos_telefono VARCHAR(50) NOT NULL DEFAULT ''
    ) {_MOTOR}""",
    # Proveedores asociados a los productos
    f"""CREATE TABLE IF NOT EXISTS proveedores (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(150) NOT NULL,
        telefono VARCHAR(50) NOT NULL DEFAULT '',
        rif_cedula VARCHAR(50) NOT NULL DEFAULT '',
        direccion VARCHAR(255) NOT NULL DEFAULT '',
        notas VARCHAR(500) NOT NULL DEFAULT '',
        activo TINYINT NOT NULL DEFAULT 1,
        fecha_creacion DATETIME NULL DEFAULT CURRENT_TIMESTAMP
    ) {_MOTOR}""",
    # Un registro por cada pago de una factura (permite pagos mixtos: varios métodos y monedas)
    f"""CREATE TABLE IF NOT EXISTS pagos_venta (
        id INT AUTO_INCREMENT PRIMARY KEY,
        venta_grupo_id INT NOT NULL,
        metodo_pago_id INT NULL,
        moneda VARCHAR(10) NOT NULL DEFAULT 'USD',
        monto_usd DECIMAL(14,2) NOT NULL,
        monto_moneda DECIMAL(14,2) NULL,
        tasa DECIMAL(14,4) NULL,
        referencia VARCHAR(100) NOT NULL DEFAULT ''
    ) {_MOTOR}""",
    # Facturas en pausa: carritos guardados para retomarlos después
    f"""CREATE TABLE IF NOT EXISTS facturas_pausadas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL DEFAULT '',
        notas VARCHAR(500) NOT NULL DEFAULT '',
        items_json MEDIUMTEXT NOT NULL,
        fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) {_MOTOR}""",
]

# Columnas imprescindibles: si faltan, la base migrada está incompleta y se avisa con claridad
_REQUERIDAS = {
    'productos': ['id', 'nombre', 'categoria', 'precio_compra', 'precio_venta', 'stock',
                  'stock_minimo', 'unidad', 'imagen_url', 'codigo_barras'],
    'ventas': ['id', 'producto_id', 'cantidad', 'precio_unitario', 'total', 'ganancia', 'notas', 'fecha'],
    'configuracion': ['clave', 'valor'],
    'metodos_pago': ['id', 'nombre', 'activo'],
    'proveedores': ['id', 'nombre'],
}

# Columnas que pueden faltar en bases de datos de versiones anteriores (se agregan solas)
_OPCIONALES = {
    'productos': {
        'descripcion': 'TEXT NULL',
        'stock_maximo': 'INT NOT NULL DEFAULT 0',
        'proveedor_id': 'INT NULL',
        'tipo_medida': "VARCHAR(20) NOT NULL DEFAULT 'unidad'",
    },
    'ventas': {
        'venta_grupo_id': 'INT NOT NULL DEFAULT 0',
        'metodo_pago_id': 'INT NULL',
        'pago_referencia': "VARCHAR(100) NOT NULL DEFAULT ''",
        'pago_moneda': "VARCHAR(10) NOT NULL DEFAULT ''",
        'pago_monto': 'DECIMAL(14,2) NOT NULL DEFAULT 0',
        'pagos_json': 'TEXT NULL',
        'tasa_bs': 'DECIMAL(14,4) NULL',
    },
    'metodos_pago': {
        'orden': 'INT NOT NULL DEFAULT 0',
        'requiere_datos_moviles': 'TINYINT NOT NULL DEFAULT 0',
        'datos_cedula': "VARCHAR(50) NOT NULL DEFAULT ''",
        'datos_banco': "VARCHAR(100) NOT NULL DEFAULT ''",
        'datos_telefono': "VARCHAR(50) NOT NULL DEFAULT ''",
    },
}

# Cómo debe ser cada columna. Una migración desde SQLite deja columnas del tamaño justo de los datos
# (cantidad con máximo 9.99, número de factura con máximo 127, nombres de 10 letras...) y sin claves.
#   'pk' = entero con clave primaria y numeración automática   'pkTexto' = texto (100) con clave primaria
#   'int' = entero    ('texto', n) = VARCHAR(n)    'largo' = TEXT    ('dec', precisión, escala) = DECIMAL    'flag' = 0/1
_ESQUEMA = {
    'productos': {
        'id': 'pk', 'nombre': ('texto', 255), 'categoria': ('texto', 100), 'descripcion': 'largo',
        'precio_compra': ('dec', 14, 4), 'precio_venta': ('dec', 14, 4), 'stock': ('dec', 14, 3),
        'stock_minimo': 'int', 'stock_maximo': 'int', 'unidad': ('texto', 30), 'imagen_url': ('texto', 500),
        'codigo_barras': ('texto', 100), 'proveedor_id': 'int', 'tipo_medida': ('texto', 20),
    },
    'ventas': {
        'id': 'pk', 'producto_id': 'int', 'cantidad': ('dec', 14, 3), 'precio_unitario': ('dec', 14, 4),
        'total': ('dec', 14, 2), 'ganancia': ('dec', 14, 2), 'notas': ('texto', 500), 'venta_grupo_id': 'int',
        'metodo_pago_id': 'int', 'pago_referencia': ('texto', 100), 'pago_moneda': ('texto', 10),
        'pago_monto': ('dec', 14, 2), 'pagos_json': 'largo',
    },
    'metodos_pago': {
        'id': 'pk', 'nombre': ('texto', 100), 'datos_cedula': ('texto', 50),
        'datos_banco': ('texto', 100), 'datos_telefono': ('texto', 50),
    },
    'proveedores': {
        'id': 'pk', 'nombre': ('texto', 150), 'telefono': ('texto', 50), 'rif_cedula': ('texto', 50),
        'direccion': ('texto', 255), 'notas': ('texto', 500), 'activo': 'flag',
    },
    'configuracion': {'clave': 'pkTexto', 'valor': 'largo'},
}

# Restos de versiones anteriores (precio por caja, datos de pago antiguos). Solo se eliminan si están vacíos.
_OBSOLETAS = {
    'productos': ['precio_caja', 'unidades_por_caja'],
    'ventas': ['pago_cedula', 'pago_banco', 'pago_telefono'],
}

_INDICES = [
    ('productos', 'idx_codigo_barras', 'codigo_barras'),
    ('productos', 'idx_productos_categoria', 'categoria'),
    ('ventas', 'idx_ventas_grupo', 'venta_grupo_id'),
    ('ventas', 'idx_ventas_fecha', 'fecha'),
    ('ventas', 'idx_ventas_producto', 'producto_id'),
    ('pagos_venta', 'idx_pagos_grupo', 'venta_grupo_id'),
    ('pagos_venta', 'idx_pagos_metodo', 'metodo_pago_id'),
]


def _info_columna(db, tabla, columna):
    """Tipo, tamaño, permiso de nulos y clave de una columna según information_schema (None si no existe)."""
    return db.execute(
        "SELECT DATA_TYPE AS tipo, NUMERIC_PRECISION AS precis, NUMERIC_SCALE AS escala, "
        "CHARACTER_MAXIMUM_LENGTH AS largo, IS_NULLABLE AS nulo, COLUMN_KEY AS clave, EXTRA AS extra "
        "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        (tabla, columna)).fetchone()


def _columnas_de(db, tabla):
    """Nombres (en minúsculas) de las columnas de una tabla."""
    filas = db.execute(
        "SELECT COLUMN_NAME AS nombre FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", (tabla,)).fetchall()
    return {f['nombre'].lower() for f in filas}


def _exigir_columnas(db):
    """Verifica que la base migrada tenga las columnas básicas; si no, explica qué falta."""
    for tabla, cols in _REQUERIDAS.items():
        existentes = _columnas_de(db, tabla)
        faltan = [c for c in cols if c not in existentes]
        if faltan:
            raise RuntimeError(f"A la tabla '{tabla}' le faltan columnas: {', '.join(faltan)}. "
                               f"Revisa la migración a MySQL.")


def _asegurar_columnas(db):
    """Agrega las columnas opcionales que falten (bases creadas con versiones anteriores)."""
    for tabla, cols in _OPCIONALES.items():
        existentes = _columnas_de(db, tabla)
        for nombre, definicion in cols.items():
            if nombre not in existentes:
                db.execute(f"ALTER TABLE {tabla} ADD COLUMN {nombre} {definicion}")
                log.info("Columna agregada: %s.%s", tabla, nombre)


def _tiene_clave_primaria(db, tabla):
    """True si la tabla ya tiene una clave primaria."""
    return db.execute("SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() "
                      "AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' LIMIT 1", (tabla,)).fetchone() is not None


def _validar_clave(db, tabla, columna):
    """Antes de usar una columna como clave primaria no puede tener valores vacíos ni repetidos."""
    vacios = db.execute(f"SELECT COUNT(*) FROM {tabla} WHERE {columna} IS NULL OR CAST({columna} AS CHAR) = ''").fetchone()[0]
    repetidos = db.execute(f"SELECT COUNT(*) FROM (SELECT {columna} FROM {tabla} GROUP BY {columna} "
                           f"HAVING COUNT(*) > 1) r").fetchone()[0]
    if vacios or repetidos:
        raise RuntimeError(f"La columna {tabla}.{columna} tiene {vacios} valores vacíos y {repetidos} repetidos; "
                           f"no se puede usar como clave. Corrígelos y vuelve a iniciar.")


def _modificar(db, tabla, columna, definicion):
    """Cambia el tipo de una columna (y avisa por pantalla; solo ocurre la primera vez)."""
    db.execute(f"ALTER TABLE {tabla} MODIFY COLUMN {columna} {definicion}")
    print(f"   Columna {tabla}.{columna} ajustada a {definicion.split(' NOT')[0].split(' NULL')[0]}")


def _normalizar_columna(db, tabla, columna, regla):
    """Ajusta una columna a la regla de _ESQUEMA si es más pequeña o de otro tipo."""
    info = _info_columna(db, tabla, columna)
    if not info:
        return
    tipo = str(info['tipo']).lower()
    nulo = 'NULL' if info['nulo'] == 'YES' else 'NOT NULL'
    es_texto = tipo in ('varchar', 'char', 'tinytext', 'text', 'mediumtext', 'longtext')
    clase = regla if isinstance(regla, str) else regla[0]

    if clase == 'pk':
        auto = 'auto_increment' in str(info['extra'] or '').lower()
        if info['clave'] == 'PRI' and auto and tipo in ('int', 'bigint'):
            return
        _validar_clave(db, tabla, columna)
        hay_pk = _tiene_clave_primaria(db, tabla)
        if hay_pk and info['clave'] != 'PRI':
            log.warning("%s ya tiene otra clave primaria; %s no se modifica", tabla, columna)
            return
        extra = '' if hay_pk else f", ADD PRIMARY KEY ({columna})"
        db.execute(f"ALTER TABLE {tabla} MODIFY COLUMN {columna} INT NOT NULL AUTO_INCREMENT{extra}")
        print(f"   Columna {tabla}.{columna} ahora es clave primaria con numeración automática")
    elif clase == 'pkTexto':
        if info['clave'] == 'PRI' and tipo == 'varchar' and (info['largo'] or 0) >= 100:
            return
        _validar_clave(db, tabla, columna)
        hay_pk = _tiene_clave_primaria(db, tabla)
        extra = '' if hay_pk else f", ADD PRIMARY KEY ({columna})"
        db.execute(f"ALTER TABLE {tabla} MODIFY COLUMN {columna} VARCHAR(100) NOT NULL{extra}")
        print(f"   Columna {tabla}.{columna} ajustada a VARCHAR(100) con clave primaria")
    elif clase == 'int':
        if tipo in ('int', 'bigint'):
            return
        if es_texto:   # texto vacío -> sin valor
            db.execute(f"UPDATE {tabla} SET {columna} = NULL WHERE {columna} = ''")
        _modificar(db, tabla, columna, f"INT {'NULL' if es_texto else nulo}")
    elif clase == 'texto':
        if tipo in ('varchar', 'char') and (info['largo'] or 0) < regla[1]:
            _modificar(db, tabla, columna, f"VARCHAR({regla[1]}) {nulo}")
    elif clase == 'largo':
        if tipo in ('varchar', 'char'):
            _modificar(db, tabla, columna, f"TEXT {nulo}")
    elif clase == 'dec':
        _, precision, escala = regla
        if tipo == 'decimal' and (info['precis'] or 0) >= precision and (info['escala'] or 0) >= escala:
            return
        if es_texto or tipo != 'decimal':
            db.execute(f"UPDATE {tabla} SET {columna} = 0 WHERE {columna} IS NULL")
        _modificar(db, tabla, columna, f"DECIMAL({precision},{escala}) NOT NULL DEFAULT 0")
    elif clase == 'flag':
        if tipo in ('tinyint', 'smallint', 'int', 'bigint'):
            return
        db.execute(f"UPDATE {tabla} SET {columna} = '1' WHERE {columna} IS NULL OR {columna} = ''")
        _modificar(db, tabla, columna, "TINYINT NOT NULL DEFAULT 1")


def _normalizar_esquema(db):
    """Aplica _ESQUEMA a todas las tablas (ver el comentario de _ESQUEMA)."""
    for tabla, columnas in _ESQUEMA.items():
        for columna, regla in columnas.items():
            _normalizar_columna(db, tabla, columna, regla)


def _limpiar_obsoletos(db):
    """Elimina restos de SQLite y columnas de versiones anteriores, solo si no tienen datos."""
    db.execute("DROP TABLE IF EXISTS sqlite_sequence")
    for tabla, columnas in _OBSOLETAS.items():
        existentes = _columnas_de(db, tabla)
        for columna in columnas:
            if columna not in existentes:
                continue
            con_datos = db.execute(
                f"SELECT COUNT(*) FROM {tabla} WHERE COALESCE(CAST({columna} AS CHAR), '') NOT IN ('', '0', '0.0', '0.00')"
            ).fetchone()[0]
            if con_datos == 0:
                db.execute(f"ALTER TABLE {tabla} DROP COLUMN {columna}")
                print(f"   Columna obsoleta {tabla}.{columna} eliminada (estaba vacía)")


def _asegurar_indices(db):
    """Crea los índices que aceleran las búsquedas (si alguno falla no es crítico)."""
    for tabla, nombre, columna in _INDICES:
        try:
            existe = db.execute(
                "SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() "
                "AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1", (tabla, nombre)).fetchone()
            if existe:
                continue
            info = _info_columna(db, tabla, columna)
            # Una columna TEXT migrada necesita longitud de prefijo para poder indexarse
            col = f"{columna}(100)" if info and str(info['tipo']).lower().endswith('text') else columna
            db.execute(f"CREATE INDEX {nombre} ON {tabla} ({col})")
        except pymysql.err.MySQLError as e:
            log.warning("No se pudo crear el índice %s: %s", nombre, e)


def _como_float(valor, defecto=0.0):
    """Convierte a float sin fallar (devuelve el valor por defecto si no es número)."""
    try:
        return float(valor)
    except (TypeError, ValueError):
        return defecto


def rellenar_pagos(db):
    """Crea en pagos_venta los pagos de las facturas antiguas que aún no los tienen.
    Usa pagos_json (si existe) o, si no, el método de pago guardado en la propia venta."""
    grupos = db.execute(
        "SELECT v.venta_grupo_id AS gid FROM ventas v WHERE v.venta_grupo_id > 0 "
        "AND NOT EXISTS (SELECT 1 FROM pagos_venta p WHERE p.venta_grupo_id = v.venta_grupo_id) "
        "GROUP BY v.venta_grupo_id").fetchall()
    for gr in grupos:
        gid = gr['gid']
        primera = db.execute("SELECT * FROM ventas WHERE venta_grupo_id = ? ORDER BY id LIMIT 1", (gid,)).fetchone()
        total = _como_float(db.execute("SELECT SUM(total) FROM ventas WHERE venta_grupo_id = ?", (gid,)).fetchone()[0])
        pagos = []
        try:
            lista = json.loads(primera['pagos_json']) if primera['pagos_json'] else []
            for p in lista if isinstance(lista, list) else []:
                pagos.append((p.get('metodo_pago_id'), str(p.get('moneda') or 'USD').upper() or 'USD',
                              round(_como_float(p.get('monto')), 2), str(p.get('referencia') or '')))
        except (ValueError, TypeError, AttributeError):
            pagos = []
        if not pagos:
            moneda = str(primera['pago_moneda'] or 'USD').upper() or 'USD'
            pagos = [(primera['metodo_pago_id'], moneda, round(total, 2), str(primera['pago_referencia'] or ''))]
        for mid, moneda, monto, ref in pagos:
            mid = int(mid) if str(mid or '').isdigit() else None
            # Facturas antiguas: se conoce el monto en USD; el monto en Bs y la tasa no se guardaban
            db.execute("INSERT INTO pagos_venta (venta_grupo_id, metodo_pago_id, moneda, monto_usd, "
                       "monto_moneda, tasa, referencia) VALUES (?,?,?,?,?,?,?)",
                       (gid, mid, moneda, monto, monto if moneda == 'USD' else None, None, ref))


def _sembrar_datos(db):
    """Contador de facturas y métodos de pago iniciales."""
    mx = int(_como_float(db.execute("SELECT COALESCE(MAX(venta_grupo_id), 0) FROM ventas").fetchone()[0]))
    fila = db.execute("SELECT valor FROM configuracion WHERE clave = 'seq_venta_grupo'").fetchone()
    if fila is None:
        db.execute("INSERT INTO configuracion (clave, valor) VALUES ('seq_venta_grupo', ?)", (str(mx),))
    elif int(_como_float(fila['valor'])) < mx:
        db.execute("UPDATE configuracion SET valor = ? WHERE clave = 'seq_venta_grupo'", (str(mx),))
    if db.execute("SELECT COUNT(*) FROM metodos_pago").fetchone()[0] == 0:
        for i, (nombre, movil) in enumerate([("Efectivo", 0), ("Punto", 0), ("Pago Móvil", 1), ("Biopago", 0)]):
            db.execute("INSERT INTO metodos_pago (nombre, activo, orden, requiere_datos_moviles) "
                       "VALUES (?, 1, ?, ?)", (nombre, i, movil))


def _crear_base_si_falta():
    """Crea la base de datos si no existe (si no hay permiso, se asume que ya existe)."""
    nombre = str(config.MYSQL['database'])
    if not re.fullmatch(r'[A-Za-z0-9_]+', nombre):
        raise ValueError("El nombre de la base de datos solo puede tener letras, números y _")
    try:
        raw = _conectar(con_base=False)
        try:
            raw.cursor().execute(f"CREATE DATABASE IF NOT EXISTS `{nombre}` "
                                 f"CHARACTER SET utf8mb4")
            raw.commit()
        finally:
            raw.close()
    except pymysql.err.OperationalError:
        raise                      # servidor apagado o datos de acceso incorrectos
    except pymysql.err.MySQLError as e:
        log.warning("No se pudo crear la base (se asume que ya existe): %s", e)


def init_db():
    """Crea las tablas que falten y adapta una base migrada desde SQLite."""
    _crear_base_si_falta()
    raw = _conectar()
    db = Conexion(raw)
    try:
        for ddl in _TABLAS:
            db.execute(ddl)
        _exigir_columnas(db)
        _asegurar_columnas(db)
        _normalizar_esquema(db)
        _limpiar_obsoletos(db)
        _asegurar_indices(db)
        raw.commit()
        rellenar_pagos(db)
        _sembrar_datos(db)
        raw.commit()
    except Exception:
        raw.rollback()
        raise
    finally:
        db.close()
    # Nota: no hay contraseña de administrador por defecto; se crea la primera vez desde la web.
