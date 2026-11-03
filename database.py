import os
import mysql.connector
from flask import g

class MySQLRow(dict):
    """Simula sqlite3.Row para acceso por nombre o índice."""
    def __getitem__(self, key):
        if isinstance(key, int):
            vals = list(self.values())
            if 0 <= key < len(vals):
                return vals[key]
            raise IndexError(key)
        # Try exact match, then case-insensitive
        if key in self:
            return super().__getitem__(key)
        for k in self:
            if k.lower() == str(key).lower():
                return super().__getitem__(k)
        raise KeyError(key)

class MySQLCursor:
    """Wrapper para que mysql.connector se parezca a sqlite3."""
    def __init__(self, conn):
        self.conn = conn
        self.cursor = conn.cursor(dictionary=True)
    
    def execute(self, sql, params=None):
        self.cursor.execute(sql, params or ())
        return self
    
    def fetchone(self):
        row = self.cursor.fetchone()
        return MySQLRow(row) if row else None
    
    def fetchall(self):
        return [MySQLRow(r) for r in self.cursor.fetchall()]
    
    def commit(self):
        self.conn.commit()
    
    def rollback(self):
        self.conn.rollback()
    
    def close(self):
        self.cursor.close()

def get_db():
    if 'db' not in g:
        conn = mysql.connector.connect(
            host=os.environ.get('MYSQLHOST'),
            user=os.environ.get('MYSQLUSER'),
            password=os.environ.get('MYSQLPASSWORD'),
            database=os.environ.get('MYSQLDATABASE') or os.environ.get('MYSQL_DATABASE'),
            port=int(os.environ.get('MYSQLPORT', 3306)),
            autocommit=False
        )
        g.db = MySQLCursor(conn)
        g._conn = conn
    return g.db

def init_db():
    conn = mysql.connector.connect(
        host=os.environ.get('MYSQLHOST'),
        user=os.environ.get('MYSQLUSER'),
        password=os.environ.get('MYSQLPASSWORD'),
        database=os.environ.get('MYSQLDATABASE') or os.environ.get('MYSQL_DATABASE'),
        port=int(os.environ.get('MYSQLPORT', 3306)),
        autocommit=False
    )
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS productos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nombre VARCHAR(255) NOT NULL,
            categoria VARCHAR(100) DEFAULT 'General',
            descripcion TEXT,
            precio_compra DECIMAL(10,2) DEFAULT 0,
            precio_venta DECIMAL(10,2) DEFAULT 0,
            stock DECIMAL(10,4) DEFAULT 0,
            stock_minimo INT DEFAULT 5,
            stock_maximo INT DEFAULT 0,
            unidad VARCHAR(50) DEFAULT 'unidad',
            imagen_url VARCHAR(500) DEFAULT '',
            codigo_barras VARCHAR(100) DEFAULT '',
            proveedor_id INT DEFAULT NULL,
            tipo_medida VARCHAR(50) DEFAULT 'unidad',
            fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ventas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            producto_id INT NOT NULL,
            cantidad DECIMAL(10,4) NOT NULL,
            precio_unitario DECIMAL(10,2) NOT NULL,
            total DECIMAL(10,2) NOT NULL,
            ganancia DECIMAL(10,2) DEFAULT 0,
            notas TEXT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            venta_grupo_id INT DEFAULT NULL,
            metodo_pago_id INT DEFAULT NULL,
            pago_referencia VARCHAR(255) DEFAULT '',
            pago_moneda VARCHAR(10) DEFAULT 'USD',
            pago_monto DECIMAL(10,2) DEFAULT 0,
            pagos_json TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS configuracion (
            clave VARCHAR(100) PRIMARY KEY,
            valor TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS metodos_pago (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nombre VARCHAR(100) NOT NULL,
            activo TINYINT DEFAULT 1,
            orden INT DEFAULT 0,
            requiere_datos_moviles TINYINT DEFAULT 0,
            datos_cedula VARCHAR(50) DEFAULT '',
            datos_banco VARCHAR(100) DEFAULT '',
            datos_telefono VARCHAR(50) DEFAULT ''
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS proveedores (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nombre VARCHAR(255) NOT NULL,
            telefono VARCHAR(50) DEFAULT '',
            rif_cedula VARCHAR(50) DEFAULT '',
            direccion TEXT,
            notas TEXT,
            activo TINYINT DEFAULT 1,
            fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()

def close_db(e=None):
    db = g.pop('db', None)
    conn = g.pop('_conn', None)
    if db:
        db.close()
    if conn:
        conn.close()
