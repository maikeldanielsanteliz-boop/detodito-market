from flask import Flask, render_template, request, jsonify, send_file, session, g
from database import init_db, get_db
from datetime import datetime, date, timedelta, timezone
import json
from functools import wraps
from werkzeug.security import generate_password_hash, check_password_hash
import os, requests, base64, io, re, socket, logging
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, Reference
from reportlab.lib import colors as rl_colors
from reportlab.lib.pagesizes import letter as rl_letter
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

app = Flask(__name__)
app.config['SECRET_KEY'] = 'todito_market_2024_secreto'
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024
app.permanent_session_lifetime = timedelta(hours=12)

UPLOAD_FOLDER = os.path.join(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", os.path.dirname(__file__)), "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

NOMBRE_TIENDA = "DE TODITO MARKET MyF, C.A"
logging.basicConfig(level=logging.INFO)

_tasa_cache = {'valor': None, 'fecha': None}


def obtener_tasa_dolar():
    hoy = date.today().isoformat()
    if _tasa_cache['fecha'] == hoy and _tasa_cache['valor']:
        return _tasa_cache['valor']
    try:
        r = requests.get('https://open.er-api.com/v6/latest/USD', timeout=6)
        if r.status_code == 200:
            tasa = r.json().get('rates', {}).get('VES')
            if tasa:
                _tasa_cache['valor'] = float(tasa)
                _tasa_cache['fecha'] = hoy
                return float(tasa)
    except Exception:
        pass
    return _tasa_cache['valor'] or None


def obtener_ip_local():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def validar_fortaleza_password(password):
    if len(password) < 8:
        return 'Debe tener al menos 8 caracteres'
    if not re.search(r'[A-Z]', password):
        return 'Debe incluir al menos una letra mayúscula'
    if not re.search(r'[a-z]', password):
        return 'Debe incluir al menos una letra minúscula'
    if not re.search(r'[0-9]', password):
        return 'Debe incluir al menos un número'
    return None


# ── TOLERANCIA A FALLOS ────────────────────────────────────────
@app.teardown_appcontext
def cerrar_db(error=None):
    db = g.pop('db', None)
    if db is not None:
        if error is not None:
            try: db.rollback()
            except Exception: pass
        db.close()


@app.errorhandler(Exception)
def manejar_error_global(e):
    try:
        db = get_db()
        db.rollback()
    except Exception:
        pass
    app.logger.error(f"Error no manejado en {request.path}: {e}")
    return jsonify({'error': 'Ocurrió un error interno. La operación no se guardó. Intenta de nuevo.'}), 500



def _to_int(val, default=0):
    try:
        if val is None or val == '':
            return default
        return int(float(val))
    except (TypeError, ValueError):
        return default

def _to_float(val, default=0.0):
    try:
        if val is None or val == '':
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


UNIDADES_POR_TIPO = {
    'peso': ['kg', 'g'],
    'liquido': ['litro', 'ml'],
    'unidad': ['unidad', 'caja', 'paquete', 'docena', 'rollo', 'bolsa', 'botella'],
    'largo': ['metro'],
}
TIPOS_MEDIDA_LABEL = {
    'peso': 'Peso (kg / g)',
    'liquido': 'Líquido (litro / ml)',
    'unidad': 'Por unidad / empaque',
    'largo': 'Largo (metro)',
}

def validar_unidad(tipo_medida, unidad):
    tipo = (tipo_medida or 'unidad').lower()
    uni = (unidad or 'unidad').lower()
    permitidas = UNIDADES_POR_TIPO.get(tipo, UNIDADES_POR_TIPO['unidad'])
    if uni not in permitidas:
        return f'Para tipo "{TIPOS_MEDIDA_LABEL.get(tipo, tipo)}" la unidad debe ser: {", ".join(permitidas)}'
    return None

def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('is_admin'):
            return jsonify({'error': 'No autorizado. Inicia sesión como administrador.'}), 401
        return f(*args, **kwargs)
    return wrapper


@app.route('/')
def index():
    return render_template('index.html', nombre_tienda=NOMBRE_TIENDA)


# ── AUTENTICACIÓN ──────────────────────────────────────────────
@app.route('/api/configurar-password-inicial', methods=['POST'])
def configurar_password_inicial():
    db = get_db()
    try:
        row = db.execute("SELECT valor FROM configuracion WHERE clave='admin_password_hash'").fetchone()
        if row:
            return jsonify({'error': 'La contraseña ya fue configurada. Usa "Cambiar contraseña".'}), 400
        nueva = (request.json or {}).get('password', '')
        error = validar_fortaleza_password(nueva)
        if error:
            return jsonify({'error': error}), 400
        db.execute("INSERT INTO configuracion (clave,valor) VALUES ('admin_password_hash', %s)",
                   (generate_password_hash(nueva),))
        db.commit()
        session['is_admin'] = True
        session.permanent = True
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo configurar la contraseña'}), 500


@app.route('/api/login', methods=['POST'])
def login():
    password = (request.json or {}).get('password', '')
    db = get_db()
    row = db.execute("SELECT valor FROM configuracion WHERE clave='admin_password_hash'").fetchone()
    if row and check_password_hash(row['valor'], password):
        session['is_admin'] = True
        session.permanent = True
        return jsonify({'ok': True})
    return jsonify({'error': 'Contraseña incorrecta'}), 401


@app.route('/api/logout', methods=['POST'])
def logout():
    session.pop('is_admin', None)
    return jsonify({'ok': True})


@app.route('/api/auth-status', methods=['GET'])
def auth_status():
    db = get_db()
    row = db.execute("SELECT valor FROM configuracion WHERE clave='admin_password_hash'").fetchone()
    return jsonify({'is_admin': bool(session.get('is_admin')), 'password_configurada': bool(row)})


@app.route('/api/cambiar-password', methods=['POST'])
@admin_required
def cambiar_password():
    db = get_db()
    try:
        d = request.json or {}
        actual = d.get('actual', '')
        nueva = d.get('nueva', '')
        row = db.execute("SELECT valor FROM configuracion WHERE clave='admin_password_hash'").fetchone()
        if not row or not check_password_hash(row['valor'], actual):
            return jsonify({'error': 'Contraseña actual incorrecta'}), 400
        error = validar_fortaleza_password(nueva)
        if error:
            return jsonify({'error': error}), 400
        db.execute("UPDATE configuracion SET valor=%s WHERE clave='admin_password_hash'",
                   (generate_password_hash(nueva),))
        db.commit()
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo cambiar la contraseña'}), 500


# ── SUBIR IMAGEN (admin) ──────────────────────────────────────
@app.route('/api/subir-imagen', methods=['POST'])
@admin_required
def subir_imagen():
    data = request.json
    imagen_b64 = data.get('imagen_b64', '')
    if not imagen_b64:
        return jsonify({'error': 'Sin imagen'}), 400
    try:
        header, b64data = (imagen_b64.split(',', 1) if ',' in imagen_b64 else ('', imagen_b64))
        ext = 'png' if 'png' in header else 'gif' if 'gif' in header else 'webp' if 'webp' in header else 'jpg'
        safe = re.sub(r'[^a-zA-Z0-9_-]', '_', data.get('nombre', 'img'))[:30]
        filename = f"{safe}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}.{ext}"
        with open(os.path.join(UPLOAD_FOLDER, filename), 'wb') as f:
            f.write(base64.b64decode(b64data))
        return jsonify({'url': f'/uploads/{filename}'})
    except Exception:
        return jsonify({'error': 'No se pudo guardar la imagen'}), 500


# ── SERVIR FOTOS ──────────────────────────────────────────────
from flask import send_from_directory
@app.route("/uploads/<filename>")
def servir_upload(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)


# ── TASA DÓLAR (pública) ──────────────────────────────────────
@app.route('/api/tasa-dolar', methods=['GET'])
def tasa_dolar():
    tasa = obtener_tasa_dolar()
    if tasa:
        return jsonify({'tasa': tasa, 'fecha': date.today().isoformat(), 'fuente': 'open.er-api.com'})
    return jsonify({'tasa': None, 'error': 'Sin conexión'}), 200


@app.route('/api/tasa-dolar', methods=['POST'])
def guardar_tasa_manual():
    tasa = float((request.json or {}).get('tasa', 0))
    if tasa <= 0:
        return jsonify({'error': 'Tasa inválida'}), 400
    _tasa_cache['valor'] = tasa
    _tasa_cache['fecha'] = date.today().isoformat()
    return jsonify({'ok': True, 'tasa': tasa})


# ── MÉTODOS DE PAGO ─────────────────────────────────────────────
# "requiere_datos_moviles" (ej. Pago Móvil): los datos del VENDEDOR
# (cédula, banco, teléfono) se configuran UNA VEZ aquí en el método,
# no se piden en cada venta. Lo único que varía por venta es la
# referencia que el cliente entrega después de pagar.
@app.route('/api/metodos-pago', methods=['GET'])
def get_metodos_pago():
    db = get_db()
    q = "SELECT * FROM metodos_pago"
    if request.args.get('solo_activos') == '1':
        q += " WHERE activo=1"
    q += " ORDER BY orden, nombre"
    return jsonify([dict(m) for m in db.execute(q).fetchall()])


@app.route('/api/metodos-pago', methods=['POST'])
@admin_required
def crear_metodo_pago():
    db = get_db()
    try:
        dj = request.json or {}
        nombre = dj.get('nombre', '').strip()
        if not nombre:
            return jsonify({'error': 'Nombre requerido'}), 400
        dup = db.execute("SELECT id FROM metodos_pago WHERE nombre=%s", (nombre,)).fetchone()
        if dup:
            return jsonify({'error': 'Ya existe un método de pago con ese nombre'}), 400
        requiere_moviles = 1 if dj.get('requiere_datos_moviles') else 0
        datos_cedula = (dj.get('datos_cedula') or '').strip()
        datos_banco = (dj.get('datos_banco') or '').strip()
        datos_telefono = (dj.get('datos_telefono') or '').strip()
        maxorden = db.execute("SELECT MAX(orden) FROM metodos_pago").fetchone()[0] or 0
        db.execute(
            """INSERT INTO metodos_pago (nombre,activo,orden,requiere_datos_moviles,datos_cedula,datos_banco,datos_telefono)
               VALUES (%s,1,%s,%s,%s,%s)""",
            (nombre, maxorden + 1, requiere_moviles, datos_cedula, datos_banco, datos_telefono))
        db.commit()
        return jsonify(dict(db.execute("SELECT * FROM metodos_pago ORDER BY id DESC LIMIT 1").fetchone())), 201
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo crear el método de pago'}), 500


@app.route('/api/metodos-pago/<int:mid>', methods=['PUT'])
@admin_required
def actualizar_metodo_pago(mid):
    db = get_db()
    try:
        d = request.json or {}
        if 'nombre' in d:
            nombre = d['nombre'].strip()
            if not nombre:
                return jsonify({'error': 'Nombre requerido'}), 400
            dup = db.execute("SELECT id FROM metodos_pago WHERE nombre=%s AND id!=%s", (nombre, mid)).fetchone()
            if dup:
                return jsonify({'error': 'Ya existe un método de pago con ese nombre'}), 400
            db.execute("UPDATE metodos_pago SET nombre=%s WHERE id=%s", (nombre, mid))
        if 'activo' in d:
            db.execute("UPDATE metodos_pago SET activo=%s WHERE id=%s", (1 if d['activo'] else 0, mid))
        if 'requiere_datos_moviles' in d:
            db.execute("UPDATE metodos_pago SET requiere_datos_moviles=%s WHERE id=%s",
                       (1 if d['requiere_datos_moviles'] else 0, mid))
        if any(k in d for k in ('datos_cedula', 'datos_banco', 'datos_telefono')):
            db.execute(
                "UPDATE metodos_pago SET datos_cedula=%s, datos_banco=%s, datos_telefono=%s WHERE id=%s",
                (d.get('datos_cedula', ''), d.get('datos_banco', ''), d.get('datos_telefono', ''), mid)
            )
        db.commit()
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo actualizar el método de pago'}), 500


@app.route('/api/metodos-pago/<int:mid>', methods=['DELETE'])
@admin_required
def eliminar_metodo_pago(mid):
    db = get_db()
    try:
        en_uso = db.execute("SELECT COUNT(*) FROM ventas WHERE metodo_pago_id=%s", (mid,)).fetchone()[0]
        if en_uso > 0:
            db.execute("UPDATE metodos_pago SET activo=0 WHERE id=%s", (mid,))
            db.commit()
            return jsonify({'ok': True, 'desactivado': True})
        db.execute("DELETE FROM metodos_pago WHERE id=%s", (mid,))
        db.commit()
        return jsonify({'ok': True, 'desactivado': False})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo eliminar el método de pago'}), 500


# ── BÚSQUEDA DE INFO POR CÓDIGO DE BARRAS (admin) ──────────────

# ── PROVEEDORES ───────────────────────────────────────────────
@app.route('/api/proveedores', methods=['GET'])
@admin_required
def get_proveedores():
    db = get_db()
    solo_activos = request.args.get('activos')
    q = "SELECT * FROM proveedores"
    if solo_activos == '1':
        q += " WHERE activo=1"
    q += " ORDER BY nombre"
    return jsonify([dict(r) for r in db.execute(q).fetchall()])


@app.route('/api/proveedores', methods=['POST'])
@admin_required
def crear_proveedor():
    db = get_db()
    try:
        d = request.json or {}
        nombre = (d.get('nombre') or '').strip()
        if not nombre:
            return jsonify({'error': 'Nombre del proveedor requerido'}), 400
        db.execute(
            """INSERT INTO proveedores (nombre, telefono, rif_cedula, direccion, notas, activo)
               VALUES (%s,%s,%s,%s,%s,1)""",
            (nombre, (d.get('telefono') or '').strip(), (d.get('rif_cedula') or '').strip(),
             (d.get('direccion') or '').strip(), (d.get('notas') or '').strip())
        )
        db.commit()
        new_id = db.execute("SELECT LAST_INSERT_ID() as id").fetchone()
        if new_id and new_id.get('id'):
            prov = db.execute("SELECT * FROM proveedores WHERE id=%s", (new_id['id'],)).fetchone()
            return jsonify(dict(prov)) if prov else jsonify({'id': new_id['id']}), 201
        return jsonify({'error': 'No se pudo obtener el ID'}), 500
    except Exception as e:
        db.rollback()
        return jsonify({'error': f'No se pudo crear el proveedor: {e}'}), 500


@app.route('/api/proveedores/<int:pid>', methods=['PUT'])
@admin_required
def actualizar_proveedor(pid):
    db = get_db()
    try:
        d = request.json or {}
        row = db.execute("SELECT id FROM proveedores WHERE id=%s", (pid,)).fetchone()
        if not row:
            return jsonify({'error': 'Proveedor no encontrado'}), 404
        nombre = (d.get('nombre') or '').strip()
        if not nombre:
            return jsonify({'error': 'Nombre requerido'}), 400
        db.execute(
            """UPDATE proveedores SET nombre=%s, telefono=%s, rif_cedula=%s, direccion=%s, notas=%s,
               activo=%s WHERE id=%s""",
            (nombre, (d.get('telefono') or '').strip(), (d.get('rif_cedula') or '').strip(),
             (d.get('direccion') or '').strip(), (d.get('notas') or '').strip(),
             1 if d.get('activo', True) else 0, pid)
        )
        db.commit()
        return jsonify({'ok': True})
    except Exception as e:
        db.rollback()
        return jsonify({'error': f'No se pudo actualizar: {e}'}), 500


@app.route('/api/proveedores/<int:pid>', methods=['DELETE'])
@admin_required
def eliminar_proveedor(pid):
    db = get_db()
    try:
        # Si hay productos asociados, solo desactivar
        en_uso = db.execute("SELECT COUNT(*) FROM productos WHERE proveedor_id=%s", (pid,)).fetchone()[0]
        if en_uso > 0:
            db.execute("UPDATE proveedores SET activo=0 WHERE id=%s", (pid,))
            db.commit()
            return jsonify({'ok': True, 'desactivado': True,
                            'msg': f'Tiene {en_uso} producto(s). Se desactivó en lugar de borrar.'})
        db.execute("DELETE FROM proveedores WHERE id=%s", (pid,))
        db.commit()
        return jsonify({'ok': True, 'desactivado': False})
    except Exception as e:
        db.rollback()
        return jsonify({'error': f'No se pudo eliminar: {e}'}), 500


@app.route('/api/productos/buscar-info-codigo/<codigo>', methods=['GET'])
@admin_required
def buscar_info_por_codigo(codigo):
    """Busca nombre del producto por código de barras en bases públicas."""
    codigo = (codigo or '').strip()
    if not codigo:
        return jsonify({'encontrado': False, 'error': 'Código vacío'})

    headers = {
        'User-Agent': 'DeToditoMarket/1.0 (inventario; contacto@local)',
        'Accept': 'application/json',
    }
    nombre = ''
    marca = ''
    cantidad = ''

    # 1) Open Food Facts v2
    try:
        url = f'https://world.openfoodfacts.org/api/v2/product/{codigo}.json'
        r = requests.get(url, headers=headers, timeout=8)
        if r.status_code == 200:
            data = r.json()
            if data.get('status') == 1 or data.get('product'):
                p = data.get('product') or {}
                nombre = (p.get('product_name_es') or p.get('product_name') or
                          p.get('generic_name_es') or p.get('generic_name') or '')
                marca = p.get('brands') or ''
                cantidad = p.get('quantity') or ''
                if nombre:
                    nom = nombre.strip()
                    if marca and marca.lower() not in nom.lower():
                        nom = f'{nom} ({marca.strip()})'
                    if cantidad and cantidad not in nom:
                        nom = f'{nom} {cantidad}'.strip()
                    return jsonify({'encontrado': True, 'nombre': nom.strip(), 'fuente': 'Open Food Facts'})
    except Exception as e:
        app.logger.warning(f'OFF v2 error: {e}')

    # 2) Open Food Facts v0 (más compatible)
    try:
        url = f'https://world.openfoodfacts.org/api/v0/product/{codigo}.json'
        r = requests.get(url, headers=headers, timeout=8)
        if r.status_code == 200:
            data = r.json()
            if data.get('status') == 1:
                p = data.get('product') or {}
                nombre = (p.get('product_name_es') or p.get('product_name') or '')
                if nombre:
                    return jsonify({'encontrado': True, 'nombre': nombre.strip(), 'fuente': 'Open Food Facts'})
    except Exception as e:
        app.logger.warning(f'OFF v0 error: {e}')

    # 3) Open Beauty Facts (cosméticos / cuidado personal)
    try:
        url = f'https://world.openbeautyfacts.org/api/v0/product/{codigo}.json'
        r = requests.get(url, headers=headers, timeout=8)
        if r.status_code == 200:
            data = r.json()
            if data.get('status') == 1:
                p = data.get('product') or {}
                nombre = (p.get('product_name_es') or p.get('product_name') or '')
                if nombre:
                    return jsonify({'encontrado': True, 'nombre': nombre.strip(), 'fuente': 'Open Beauty Facts'})
    except Exception as e:
        app.logger.warning(f'OBF error: {e}')

    return jsonify({
        'encontrado': False,
        'mensaje': 'No hay datos públicos para ese código. Escríbelo manualmente.'
    })


# ── PRODUCTOS — ADMINISTRACIÓN (completo, con costos) ─────────
@app.route('/api/productos', methods=['GET'])
@admin_required
def get_productos():
    db = get_db()
    q, params = "SELECT * FROM productos WHERE 1=1", []
    cat = request.args.get('categoria', '')
    bus = request.args.get('busqueda', '')
    if cat: q += " AND categoria=%s"; params.append(cat)
    if bus: q += " AND nombre LIKE %s"; params.append(f"%{bus}%")
    rows = db.execute(q + ' ORDER BY nombre', params).fetchall()
    result = []
    for p in rows:
        d = dict(p)
        if 'id' not in d and 'ID' in d:
            d['id'] = d['ID']
        result.append(d)
    return jsonify(result)


@app.route('/api/productos', methods=['POST'])
@admin_required
def crear_producto():
    db = get_db()
    try:
        d = request.json
        nombre = d.get('nombre', '').strip()
        if not nombre:
            return jsonify({'error': 'Nombre requerido'}), 400
        codigo = (d.get('codigo_barras') or '').strip()
        if codigo:
            dup = db.execute("SELECT id FROM productos WHERE codigo_barras=%s", (codigo,)).fetchone()
            if dup:
                return jsonify({'error': 'Ese código de barras ya está asignado a otro producto'}), 400
        tipo_med = (d.get('tipo_medida') or 'unidad').lower()
        unidad = (d.get('unidad') or 'unidad').lower()
        err_u = validar_unidad(tipo_med, unidad)
        if err_u:
            return jsonify({'error': err_u}), 400
        prov_id = d.get('proveedor_id')
        prov_id = int(prov_id) if prov_id not in (None, '', 0, '0') else None
        db.execute(
            """INSERT INTO productos (nombre,categoria,precio_compra,precio_venta,stock,stock_minimo,
               stock_maximo,unidad,imagen_url,descripcion,codigo_barras,proveedor_id,tipo_medida)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (nombre, d.get('categoria', 'General'), _to_float(d.get('precio_compra')),
             _to_float(d.get('precio_venta')), _to_float(d.get('stock')), _to_int(d.get('stock_minimo'), 0),
             _to_int(d.get('stock_maximo')), unidad, d.get('imagen_url', ''),
             d.get('descripcion', ''), codigo, prov_id, tipo_med,
             )
        )
        db.commit()
        new_id = db.execute("SELECT LAST_INSERT_ID() as id").fetchone()
        if new_id and new_id.get('id'):
            prod = db.execute("SELECT * FROM productos WHERE id=%s", (new_id['id'],)).fetchone()
            return jsonify(dict(prod)) if prod else jsonify({'id': new_id['id']}), 201
        return jsonify({'error': 'No se pudo obtener el ID del producto'}), 500
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error crear producto: {e}')
        return jsonify({'error': f'No se pudo guardar el producto: {str(e)}'}), 500


@app.route('/api/productos/<int:pid>', methods=['PUT'])
@admin_required
def actualizar_producto(pid):
    db = get_db()
    try:
        d = request.json or {}
        codigo = (d.get('codigo_barras') or '').strip()
        if codigo:
            dup = db.execute("SELECT id FROM productos WHERE codigo_barras=%s AND id!=%s", (codigo, pid)).fetchone()
            if dup:
                return jsonify({'error': 'Ese código de barras ya está asignado a otro producto'}), 400
        tipo_med = (d.get('tipo_medida') or 'unidad').lower()
        unidad = (d.get('unidad') or 'unidad').lower()
        err_u = validar_unidad(tipo_med, unidad)
        if err_u:
            return jsonify({'error': err_u}), 400
        prov_id = d.get('proveedor_id')
        prov_id = int(prov_id) if prov_id not in (None, '', 0, '0') else None

        db.execute(
            """UPDATE productos SET
               nombre=%s, categoria=%s, precio_compra=%s, precio_venta=%s, stock=%s,
               stock_minimo=%s, stock_maximo=%s, unidad=%s, imagen_url=%s, descripcion=%s,
               codigo_barras=%s, proveedor_id=%s, tipo_medida=%s
               
               WHERE id=%s""",
            (
                d.get('nombre', ''),
                d.get('categoria', 'General'),
                _to_float(d.get('precio_compra')),
                _to_float(d.get('precio_venta')),
                _to_float(d.get('stock')),
                _to_int(d.get('stock_minimo'), 0),
                _to_int(d.get('stock_maximo')),
                unidad,
                d.get('imagen_url', ''),
                d.get('descripcion', ''),
                codigo,
                prov_id,
                tipo_med,
                
                
                pid,
            )
        )
        db.commit()
        return jsonify({'ok': True})
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error actualizar producto: {e}')
        return jsonify({'error': f'No se pudo actualizar el producto: {str(e)}'}), 500


@app.route('/api/productos/<int:pid>', methods=['DELETE'])
@admin_required
def eliminar_producto(pid):
    db = get_db()
    try:
        # Si el producto tiene ventas, no se puede borrar (FK). Avisamos claramente.
        en_ventas = db.execute("SELECT COUNT(*) FROM ventas WHERE producto_id=%s", (pid,)).fetchone()[0]
        if en_ventas > 0:
            return jsonify({
                'error': 'No se puede eliminar: este producto ya tiene ventas registradas. '
                         'Puedes poner su stock en 0 o cambiar el nombre si ya no lo usas.'
            }), 400
        db.execute("DELETE FROM productos WHERE id=%s", (pid,))
        db.commit()
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo eliminar el producto'}), 500


# ── PRODUCTOS — FACTURACIÓN (público, sin costos) ──────────────
@app.route('/api/productos/venta', methods=['GET'])
def productos_venta():
    db = get_db()
    bus = request.args.get('busqueda', '')
    q = """SELECT id,nombre,categoria,precio_venta,stock,unidad,imagen_url,codigo_barras
           FROM productos WHERE 1=1"""
    params = []
    if bus:
        q += " AND (nombre LIKE %s OR codigo_barras LIKE %s)"
        params += [f"%{bus}%", f"%{bus}%"]
    q += " ORDER BY nombre"
    return jsonify([dict(p) for p in db.execute(q, params).fetchall()])


@app.route('/api/productos/codigo/<codigo>', methods=['GET'])
def producto_por_codigo(codigo):
    db = get_db()
    p = db.execute(
        """SELECT id,nombre,categoria,precio_venta,stock,unidad,imagen_url,codigo_barras
           FROM productos WHERE codigo_barras=%s""", (codigo,)).fetchone()
    if not p:
        return jsonify({'error': 'Producto no encontrado', 'codigo': codigo}), 404
    return jsonify(dict(p))



@app.route('/api/tipos-medida', methods=['GET'])
def tipos_medida():
    return jsonify({
        'tipos': [{'id': k, 'label': TIPOS_MEDIDA_LABEL[k], 'unidades': v}
                  for k, v in UNIDADES_POR_TIPO.items()]
    })

@app.route('/api/categorias', methods=['GET'])
def get_categorias():
    cats = get_db().execute("SELECT DISTINCT categoria FROM productos ORDER BY categoria").fetchall()
    return jsonify([c['categoria'] for c in cats])


# ── VENTAS ────────────────────────────────────────────────────
@app.route('/api/ventas', methods=['GET'])
@admin_required
def get_ventas():
    db = get_db()
    fi = request.args.get('fecha_inicio', '')
    ff = request.args.get('fecha_fin', '')
    q = """SELECT v.*, p.nombre as producto_nombre, p.imagen_url, p.unidad, p.precio_compra, m.nombre as metodo_pago_nombre
           FROM ventas v JOIN productos p ON v.producto_id=p.id
           LEFT JOIN metodos_pago m ON v.metodo_pago_id=m.id WHERE 1=1"""
    params = []
    if fi: q += " AND DATE(v.fecha)>=%s"; params.append(fi)
    if ff: q += " AND DATE(v.fecha)<=%s"; params.append(ff)
    q += " ORDER BY v.venta_grupo_id DESC, v.id ASC"
    rows = db.execute(q, params).fetchall()

    grupos = {}
    for r in rows:
        gid = r['venta_grupo_id']
        if gid not in grupos:
            grupos[gid] = {'venta_grupo_id': gid, 'fecha': r['fecha'], 'notas': r['notas'],
                           'metodo_pago_id': r['metodo_pago_id'],
                           'metodo_pago_nombre': r['metodo_pago_nombre'] or 'Sin especificar',
                           'pago_referencia': r['pago_referencia'],
                           'items': [], 'total': 0, 'ganancia': 0}
        grupos[gid]['items'].append({
            'id': r['id'], 'producto_id': r['producto_id'], 'producto_nombre': r['producto_nombre'],
            'imagen_url': r['imagen_url'], 'cantidad': r['cantidad'], 'unidad': r['unidad'] or '',
            'precio_unitario': r['precio_unitario'], 'precio_compra': r['precio_compra'], 'total': r['total'], 'ganancia': r['ganancia'],
        })
        grupos[gid]['total'] += r['total'] or 0
        grupos[gid]['ganancia'] += r['ganancia'] or 0
    return jsonify(list(grupos.values()))


@app.route('/api/ventas', methods=['POST'])
def registrar_venta():
    """Abierto para Facturación (no requiere admin). Valida TODO el stock
    antes de escribir nada (todo o nada). Si el método requiere datos
    móviles, solo pide la referencia — los datos del vendedor (cédula,
    banco, teléfono) ya están fijos en el método de pago."""
    db = get_db()
    try:
        data = request.json
        items = data.get('items', [])
        notas = data.get('notas', '')
        if not items:
            return jsonify({'error': 'Sin productos'}), 400

        # Pagos: lista (pago mixto) o un solo método (compatibilidad)
        pagos_in = data.get('pagos')
        if not pagos_in:
            metodo_pago_id = data.get('metodo_pago_id')
            if not metodo_pago_id:
                return jsonify({'error': 'Selecciona un método de pago'}), 400
            pagos_in = [{
                'metodo_pago_id': metodo_pago_id,
                'pago_referencia': (data.get('pago_referencia') or '').strip(),
                'pago_moneda': (data.get('pago_moneda') or '').strip().upper(),
                'pago_monto': data.get('pago_monto') or 0,
            }]

        pagos_ok = []
        for p in pagos_in:
            mid = p.get('metodo_pago_id')
            metodo = db.execute("SELECT * FROM metodos_pago WHERE id=%s AND activo=1", (mid,)).fetchone()
            if not metodo:
                return jsonify({'error': 'Método de pago inválido'}), 400
            nom = (metodo['nombre'] or '').strip().lower()
            ref = (p.get('pago_referencia') or p.get('referencia') or '').strip()
            moneda = (p.get('pago_moneda') or p.get('moneda') or '').strip().upper()
            try:
                monto = float(p.get('pago_monto') or p.get('monto') or 0)
            except (TypeError, ValueError):
                monto = 0
            if metodo['requiere_datos_moviles'] or 'móvil' in nom or 'movil' in nom:
                if not ref:
                    return jsonify({'error': f'Para {metodo["nombre"]} falta la referencia del cliente'}), 400
            elif 'efectivo' in nom:
                if moneda not in ('USD', 'BS', 'VES'):
                    return jsonify({'error': 'En Efectivo indica Dólares (USD) o Bolívares (Bs)'}), 400
                if moneda == 'VES':
                    moneda = 'BS'
            elif 'punto' in nom or 'biopago' in nom or 'bio pago' in nom:
                if monto <= 0:
                    return jsonify({'error': f'Para {metodo["nombre"]} indica el monto cobrado'}), 400
                if not ref:
                    return jsonify({'error': f'Para {metodo["nombre"]} falta la referencia / aprobación'}), 400
            pagos_ok.append({
                'metodo_pago_id': mid,
                'nombre': metodo['nombre'],
                'referencia': ref,
                'moneda': moneda,
                'monto': monto,
            })

        if not pagos_ok:
            return jsonify({'error': 'Agrega al menos un pago'}), 400

        metodo_pago_id = pagos_ok[0]['metodo_pago_id']
        pago_referencia = pagos_ok[0]['referencia']
        pago_moneda = pagos_ok[0]['moneda']
        pago_monto = pagos_ok[0]['monto']
        pagos_json = json.dumps(pagos_ok, ensure_ascii=False)

        cantidades_por_producto = {}
        for item in items:
            pid = item.get('producto_id')
            cantidad = float(item.get('cantidad', 1))
            if cantidad <= 0:
                return jsonify({'error': 'Cantidad inválida'}), 400
            descuenta = float(item.get("cantidad_stock", cantidad))
            cantidades_por_producto[pid] = cantidades_por_producto.get(pid, 0) + descuenta

        productos_info = {}
        for pid, cantidad_total in cantidades_por_producto.items():
            prod = db.execute("SELECT * FROM productos WHERE id=%s", (pid,)).fetchone()
            if not prod:
                return jsonify({'error': f'Producto #{pid} no encontrado'}), 404
            if prod['stock'] < cantidad_total:
                return jsonify({
                    'error': f'Sin stock suficiente de "{prod["nombre"]}" (disponible: {prod["stock"]}, solicitado: {cantidad_total})'
                }), 400
            productos_info[pid] = prod

        # Total esperado de la venta
        total_esperado = 0.0
        for item in items:
            pid = item.get('producto_id')
            cantidad = float(item.get('cantidad', 1))
            prod = productos_info[pid]
            precio = float(item.get('precio_unitario', prod['precio_venta']))
            total_esperado += precio * cantidad
        total_esperado = round(total_esperado, 2)

        montos = [p['monto'] for p in pagos_ok if p.get('monto') and p['monto'] > 0]
        if montos:
            suma = round(sum(montos), 2)
            if abs(suma - total_esperado) > 0.05:
                return jsonify({
                    'error': f'La suma de los pagos (${suma:.2f}) no coincide con el total de la venta (${total_esperado:.2f})'
                }), 400
        else:
            # Si ningún pago trae monto, asignar el total al primero (ej. compatibilidad)
            pagos_ok[0]['monto'] = total_esperado

        last = db.execute("SELECT MAX(venta_grupo_id) FROM ventas").fetchone()[0]
        grupo_id = (last or 0) + 1
        fecha = datetime.now(timezone(timedelta(hours=-4))).isoformat()
        total_general = 0

        for item in items:
            pid = item.get('producto_id')
            cantidad = float(item.get('cantidad', 1))
            prod = productos_info[pid]
            precio = float(item.get('precio_unitario', prod['precio_venta']))
            total = precio * cantidad
            ganancia = (float(precio) - float(prod['precio_compra'])) * float(cantidad)
            db.execute(
                """INSERT INTO ventas (producto_id,cantidad,precio_unitario,total,ganancia,notas,fecha,
                   venta_grupo_id,metodo_pago_id,pago_referencia,pago_moneda,pago_monto,pagos_json,precio_compra)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (pid, cantidad, precio, total, ganancia, notas, fecha, grupo_id, metodo_pago_id,
                 pago_referencia, pago_moneda, pago_monto, pagos_json, prod['precio_compra'])
            )
            descuenta = float(item.get("cantidad_stock", cantidad))
            db.execute("UPDATE productos SET stock=ROUND(stock-%s, 4) WHERE id=%s", (descuenta, pid))
            total_general += total

        db.commit()
        nombres = ' + '.join(p['nombre'] for p in pagos_ok)
        return jsonify({'ok': True, 'venta_grupo_id': grupo_id, 'total': total_general,
                        'metodo_pago_nombre': nombres, 'pagos': pagos_ok}), 201
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error registrar venta: {e}')
        return jsonify({'error': f'No se pudo registrar la venta: {str(e)}'}), 500


@app.route('/api/ventas/grupo/<int:gid>', methods=['PUT'])
@admin_required
def editar_venta_grupo(gid):
    db = get_db()
    try:
        data = request.json
        eliminar_ids = data.get('eliminar_ids', [])
        items = data.get('items', [])
        nuevo_metodo_pago_id = data.get('metodo_pago_id')

        for item in items:
            row = db.execute("SELECT * FROM ventas WHERE id=%s AND venta_grupo_id=%s", (item['id'], gid)).fetchone()
            if not row:
                continue
            prod = db.execute("SELECT * FROM productos WHERE id=%s", (row['producto_id'],)).fetchone()
            nueva_cant = float(item.get('cantidad', row['cantidad']))
            diff = nueva_cant - row['cantidad']
            if diff > 0 and prod['stock'] < diff:
                return jsonify({'error': f'Stock insuficiente para {prod["nombre"]}'}), 400

        for vid in eliminar_ids:
            row = db.execute("SELECT * FROM ventas WHERE id=%s AND venta_grupo_id=%s", (vid, gid)).fetchone()
            if row:
                db.execute("UPDATE productos SET stock=stock+%s WHERE id=%s", (row['cantidad'], row['producto_id']))
                db.execute("DELETE FROM ventas WHERE id=%s", (vid,))

        for item in items:
            row = db.execute("SELECT * FROM ventas WHERE id=%s AND venta_grupo_id=%s", (item['id'], gid)).fetchone()
            if not row:
                continue
            prod = db.execute("SELECT * FROM productos WHERE id=%s", (row['producto_id'],)).fetchone()
            nueva_cant = float(item.get('cantidad', row['cantidad']))
            nuevo_prec = float(item.get('precio_unitario', row['precio_unitario']))
            diff = nueva_cant - row['cantidad']
            nuevo_total = nueva_cant * nuevo_prec
            nueva_gan = (nuevo_prec - prod['precio_compra']) * nueva_cant
            db.execute("UPDATE ventas SET cantidad=%s,precio_unitario=%s,total=%s,ganancia=%s WHERE id=%s",
                       (nueva_cant, nuevo_prec, nuevo_total, nueva_gan, item['id']))
            db.execute("UPDATE productos SET stock=stock-%s WHERE id=%s", (diff, row['producto_id']))

        if nuevo_metodo_pago_id:
            db.execute("UPDATE ventas SET metodo_pago_id=%s WHERE venta_grupo_id=%s", (nuevo_metodo_pago_id, gid))

        if 'pago_referencia' in data:
            db.execute("UPDATE ventas SET pago_referencia=%s WHERE venta_grupo_id=%s",
                       (data.get('pago_referencia', ''), gid))

        db.commit()
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo actualizar la venta. No se aplicó ningún cambio.'}), 500



@app.route('/api/ventas/grupo/<int:gid>', methods=['DELETE'])
@admin_required
def eliminar_venta_grupo(gid):
    db = get_db()
    try:
        rows = db.execute("SELECT * FROM ventas WHERE venta_grupo_id=%s", (gid,)).fetchall()
        sin_producto = []
        for r in rows:
            prod = db.execute("SELECT id FROM productos WHERE id=%s", (r['producto_id'],)).fetchone()
            if prod:
                db.execute("UPDATE productos SET stock=stock+%s WHERE id=%s", (r['cantidad'], r['producto_id']))
            else:
                sin_producto.append(r['producto_id'])
        db.execute("DELETE FROM ventas WHERE venta_grupo_id=%s", (gid,))
        db.commit()
        if sin_producto:
            return jsonify({'ok': True, 'aviso': 'Algunos productos ya no existen, el stock no se pudo devolver'})
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo eliminar la venta'}), 500


# ── DASHBOARD (admin) ─────────────────────────────────────────
@app.route('/api/dashboard', methods=['GET'])
@admin_required
def dashboard():

    db = get_db()
    hoy = date.today().isoformat()
    tp = db.execute("SELECT COUNT(*) FROM productos").fetchone()[0]
    sb = db.execute("SELECT COUNT(*) FROM productos WHERE stock<=stock_minimo").fetchone()[0]
    so = db.execute("SELECT COUNT(*) FROM productos WHERE stock_maximo > 0 AND stock >= stock_maximo").fetchone()[0]
    vi = db.execute("SELECT SUM(stock*precio_compra) FROM productos").fetchone()[0] or 0
    vh = db.execute("SELECT COUNT(DISTINCT venta_grupo_id) as c, SUM(total) as t, SUM(ganancia) as g FROM ventas WHERE DATE(fecha)=%s", (hoy,)).fetchone()
    inicio_mes = hoy[:8] + '01'
    vm = db.execute("SELECT COUNT(DISTINCT venta_grupo_id) as c, SUM(total) as t, SUM(ganancia) as g FROM ventas WHERE DATE(fecha) >= %s AND DATE(fecha) <= %s", (inicio_mes, hoy)).fetchone()
    top = db.execute("SELECT p.nombre,p.imagen_url,SUM(v.cantidad) as tv,SUM(v.total) as ing FROM ventas v JOIN productos p ON v.producto_id=p.id GROUP BY p.id, p.nombre, p.imagen_url ORDER BY tv DESC LIMIT 5").fetchall()
    v7 = db.execute("SELECT DATE(fecha) as dia,SUM(total) as total,SUM(ganancia) as ganancia FROM ventas WHERE fecha>=DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY dia ORDER BY dia").fetchall()
    cats = db.execute("SELECT categoria,SUM(stock) as ts,COUNT(*) as np FROM productos GROUP BY categoria").fetchall()
    metodos = db.execute("""SELECT m.nombre, COUNT(DISTINCT v.venta_grupo_id) as n, SUM(v.total) as t
                            FROM ventas v JOIN metodos_pago m ON v.metodo_pago_id=m.id
                            WHERE DATE_FORMAT(v.fecha, '%Y-%m')=DATE_FORMAT(NOW(), '%Y-%m')
                            GROUP BY m.id, m.nombre ORDER BY t DESC""").fetchall()
    return jsonify({
        'total_productos': tp, 'stock_bajo': sb, 'stock_exceso': so, 'valor_inventario': round(vi, 2),
        'ventas_hoy': {'cantidad': vh['c'] or 0, 'total': round(float(vh['t'] or 0), 2), 'ganancia': round(float(vh['g'] or 0), 2)},
        'ventas_mes': {'cantidad': vm['c'] or 0, 'total': round(float(vm['t'] or 0), 2), 'ganancia': round(float(vm['g'] or 0), 2)},
        'top_productos': [dict(p) for p in top],
        'ventas_7dias': [dict(v) for v in v7],
        'categorias_stock': [dict(c) for c in cats],
        'metodos_pago_mes': [dict(m) for m in metodos],
    })


# ── HELPERS COMPARTIDOS PARA REPORTES ──────────────────────────
def _datos_reporte(db, fi, ff):
    tp2 = db.execute("SELECT COUNT(*) FROM productos").fetchone()[0]
    vi2 = db.execute("SELECT SUM(stock*precio_compra) FROM productos").fetchone()[0] or 0
    sb2 = db.execute("SELECT COUNT(*) FROM productos WHERE stock<=stock_minimo").fetchone()[0]

    qv = "SELECT COUNT(DISTINCT venta_grupo_id),SUM(total),SUM(ganancia) FROM ventas WHERE 1=1"
    pv = []
    if fi: qv += " AND DATE(fecha)>=%s"; pv.append(fi)
    if ff: qv += " AND DATE(fecha)<=%s"; pv.append(ff)
    rv = db.execute(qv, pv).fetchone()

    qt = """SELECT p.nombre,p.categoria,SUM(v.cantidad) as c,SUM(v.total) as t,SUM(v.ganancia) as g
            FROM ventas v JOIN productos p ON v.producto_id=p.id WHERE 1=1"""
    if fi: qt += f" AND DATE(v.fecha)>='{fi}'"
    if ff: qt += f" AND DATE(v.fecha)<='{ff}'"
    qt += " GROUP BY p.id ORDER BY c DESC LIMIT 10"
    top = db.execute(qt).fetchall()

    qd = "SELECT DATE(fecha) as d,COUNT(DISTINCT venta_grupo_id) as n,SUM(cantidad) as u,SUM(total) as t,SUM(ganancia) as g FROM ventas WHERE 1=1"
    pd3 = []
    if fi: qd += " AND DATE(fecha)>=%s"; pd3.append(fi)
    if ff: qd += " AND DATE(fecha)<=%s"; pd3.append(ff)
    qd += " GROUP BY d ORDER BY d DESC"
    por_dia = db.execute(qd, pd3).fetchall()

    qm = """SELECT m.nombre, COUNT(DISTINCT v.venta_grupo_id) as n, SUM(v.total) as t
            FROM ventas v JOIN metodos_pago m ON v.metodo_pago_id=m.id WHERE 1=1"""
    pm = []
    if fi: qm += " AND DATE(v.fecha)>=%s"; pm.append(fi)
    if ff: qm += " AND DATE(v.fecha)<=%s"; pm.append(ff)
    qm += " GROUP BY m.id ORDER BY t DESC"
    metodos = db.execute(qm, pm).fetchall()

    return {
        'total_productos': tp2, 'valor_inventario': vi2, 'stock_bajo': sb2,
        'num_ventas': rv[0] or 0, 'ingresos': rv[1] or 0, 'ganancia': rv[2] or 0,
        'top': top, 'por_dia': por_dia, 'metodos': metodos,
    }


# ── EXPORTAR EXCEL (admin) ────────────────────────────────────
@app.route('/api/exportar-excel', methods=['POST'])
@admin_required
def exportar_excel():
    db = get_db()
    data = request.json
    fi = data.get('fecha_inicio', '')
    ff = data.get('fecha_fin', '')
    tasa = obtener_tasa_dolar() or data.get('tasa_manual', 0) or 0
    rep = _datos_reporte(db, fi, ff)

    wb = openpyxl.Workbook()
    CP = '1A1A2E'; CS = '16213E'; CA = '0F3460'; VE = '2ECC71'; RO = 'E74C3C'; GC = 'F8F9FA'; BL = 'FFFFFF'
    borde = Border(bottom=Side(style='thin', color='DEE2E6'), right=Side(style='thin', color='DEE2E6'))

    def hc(ws, r, c, v, bg=CP, fg='FFFFFF', sz=11, bold=True, align='center'):
        cell = ws.cell(row=r, column=c, value=v)
        cell.font = Font(name='Calibri', bold=bold, size=sz, color=fg)
        cell.fill = PatternFill("solid", fgColor=bg)
        cell.alignment = Alignment(horizontal=align, vertical='center', wrap_text=True)
        cell.border = borde
        return cell

    def dc(ws, r, c, v, bg=BL, fg='2C3E50', bold=False, align='center', fmt=None):
        cell = ws.cell(row=r, column=c, value=v)
        cell.font = Font(name='Calibri', bold=bold, size=10, color=fg)
        cell.fill = PatternFill("solid", fgColor=bg)
        cell.alignment = Alignment(horizontal=align, vertical='center')
        cell.border = borde
        if fmt: cell.number_format = fmt
        return cell

    periodo = f"{fi}  →  {ff}" if fi else f"Completo — {date.today().strftime('%d/%m/%Y')}"
    tasa_txt = f"Tasa: 1 USD = {tasa:,.2f} Bs" if tasa else "Sin tasa"

    ws1 = wb.active; ws1.title = "Resumen"; ws1.sheet_view.showGridLines = False
    ws1.merge_cells('A1:G1')
    hc(ws1, 1, 1, f"🏪  {NOMBRE_TIENDA} — REPORTE EJECUTIVO", bg=CP, sz=15)
    ws1.row_dimensions[1].height = 42
    ws1.merge_cells('A2:G2')
    hc(ws1, 2, 1, f"Período: {periodo}     |     {tasa_txt}", bg=CS, sz=10, bold=False)
    ws1.row_dimensions[2].height = 22

    ing = rep['ingresos']; gan = rep['ganancia']; vi2 = rep['valor_inventario']

    ws1.merge_cells('A4:G4')
    hc(ws1, 4, 1, "INDICADORES CLAVE", bg="0A2848", sz=12); ws1.row_dimensions[4].height = 26
    kl = ["Productos", "Valor Inv. $", "Valor Inv. Bs", "Ventas", "Ingresos $", "Ingresos Bs", "Ganancia $"]
    kv = [rep['total_productos'], f"${vi2:,.2f}", f"Bs {vi2*tasa:,.0f}" if tasa else "—", rep['num_ventas'],
          f"${ing:,.2f}", f"Bs {ing*tasa:,.0f}" if tasa else "—", f"${gan:,.2f}"]
    kb = [CP, CA, CA, "1A4060", "1A6B3C", "1A6B3C", "7B2D8B"]
    for i, (l, v, bg) in enumerate(zip(kl, kv, kb), 1):
        hc(ws1, 5, i, l, bg=bg, sz=9); ws1.row_dimensions[5].height = 20
        hc(ws1, 6, i, v, bg=bg, sz=13); ws1.row_dimensions[6].height = 34

    ws1.merge_cells('A8:D8')
    hc(ws1, 8, 1, "💳  VENTAS POR MÉTODO DE PAGO", bg="0A2848", sz=12); ws1.row_dimensions[8].height = 26
    for i, l in enumerate(["Método", "Nº Ventas", "Total $", "Total Bs"], 1):
        hc(ws1, 9, i, l, bg=CA, sz=10); ws1.row_dimensions[9].height = 24
    fila_m = 10
    for m in rep['metodos']:
        bg = GC if fila_m % 2 == 0 else BL
        dc(ws1, fila_m, 1, m['nombre'], bg=bg, align='left', bold=True)
        dc(ws1, fila_m, 2, m['n'], bg=bg)
        dc(ws1, fila_m, 3, m['t'], bg=bg, fmt='"$"#,##0.00', fg=VE, bold=True)
        dc(ws1, fila_m, 4, f"Bs {(m['t'] or 0)*tasa:,.0f}" if tasa else "—", bg=bg, fg="E67E22")
        fila_m += 1
    if not rep['metodos']:
        dc(ws1, fila_m, 1, "Sin ventas registradas en el período", bg=BL, align='left')
        fila_m += 1

    fila_top = fila_m + 2
    ws1.merge_cells(f'A{fila_top}:G{fila_top}')
    hc(ws1, fila_top, 1, "🏆  TOP 10 PRODUCTOS", bg="0A2848", sz=12); ws1.row_dimensions[fila_top].height = 26
    fila_top += 1
    for i, l in enumerate(["#", "Producto", "Categoría", "Cant.", "Ingresos $", "Ingresos Bs", "Ganancia $"], 1):
        hc(ws1, fila_top, i, l, bg=CA, sz=10); ws1.row_dimensions[fila_top].height = 26
    fila_top += 1
    for idx, row in enumerate(rep['top'], 1):
        r = fila_top; bg = GC if idx % 2 == 0 else BL
        dc(ws1, r, 1, idx, bg=CA, fg='FFFFFF', bold=True)
        dc(ws1, r, 2, row['nombre'], bg=bg, align='left')
        dc(ws1, r, 3, row['categoria'], bg=bg)
        dc(ws1, r, 4, row['c'], bg=bg)
        dc(ws1, r, 5, row['t'], bg=bg, fmt='"$"#,##0.00', fg=VE, bold=True)
        dc(ws1, r, 6, f"Bs {(row['t'] or 0)*tasa:,.0f}" if tasa else "—", bg=bg, fg="E67E22")
        dc(ws1, r, 7, row['g'], bg=bg, fmt='"$"#,##0.00', fg=VE if (row['g'] or 0) > 0 else RO, bold=True)
        ws1.row_dimensions[r].height = 20
        fila_top += 1
    for col, w in zip(range(1, 8), [6, 26, 14, 10, 13, 14, 13]):
        ws1.column_dimensions[get_column_letter(col)].width = w

    ws2 = wb.create_sheet("Inventario"); ws2.sheet_view.showGridLines = False
    ws2.merge_cells('A1:J1'); hc(ws2, 1, 1, "📦  INVENTARIO COMPLETO", bg=CP, sz=14); ws2.row_dimensions[1].height = 36
    for i, l in enumerate(["ID", "Producto", "Categoría", "Código", "P.Compra $", "P.Compra Bs", "P.Venta $", "P.Venta Bs", "Stock", "Estado"], 1):
        hc(ws2, 2, i, l, bg=CA, sz=10); ws2.row_dimensions[2].height = 26
    prods = db.execute("SELECT * FROM productos ORDER BY categoria,nombre").fetchall()
    cat_actual = None; fila = 3
    for p in prods:
        if p['categoria'] != cat_actual:
            cat_actual = p['categoria']
            ws2.merge_cells(f'A{fila}:J{fila}')
            hc(ws2, fila, 1, f"  ▶  {cat_actual}", bg="0A2848", sz=10, align='left')
            ws2.row_dimensions[fila].height = 18; fila += 1
        bg = BL if fila % 2 == 0 else GC
        est = "✅ OK" if p['stock'] > p['stock_minimo'] else ("⚠️ Bajo" if p['stock'] > 0 else "❌ Agotado")
        fge = VE if p['stock'] > p['stock_minimo'] else ("E67E22" if p['stock'] > 0 else RO)
        dc(ws2, fila, 1, p['id'], bg=bg); dc(ws2, fila, 2, p['nombre'], bg=bg, align='left', bold=True)
        dc(ws2, fila, 3, p['categoria'], bg=bg)
        dc(ws2, fila, 4, p['codigo_barras'] or '—', bg=bg, align='left')
        dc(ws2, fila, 5, p['precio_compra'], bg=bg, fmt='"$"#,##0.00')
        dc(ws2, fila, 6, f"Bs {p['precio_compra']*tasa:,.0f}" if tasa else "—", bg=bg, fg="E67E22")
        dc(ws2, fila, 7, p['precio_venta'], bg=bg, fmt='"$"#,##0.00', fg=VE, bold=True)
        dc(ws2, fila, 8, f"Bs {p['precio_venta']*tasa:,.0f}" if tasa else "—", bg=bg, fg="E67E22", bold=True)
        dc(ws2, fila, 9, p['stock'], bg=bg, bold=True)
        dc(ws2, fila, 10, est, bg=bg, fg=fge, bold=True)
        ws2.row_dimensions[fila].height = 20; fila += 1
    for col, w in zip(range(1, 11), [6, 24, 13, 15, 11, 12, 11, 12, 8, 12]):
        ws2.column_dimensions[get_column_letter(col)].width = w

    # Ventas: Método + Referencia (lo único por venta) — NO cédula/banco/teléfono,
    # esos son del vendedor y se configuran una vez en Métodos de Pago.
    ws3 = wb.create_sheet("Ventas"); ws3.sheet_view.showGridLines = False
    ws3.merge_cells('A1:K1'); hc(ws3, 1, 1, "🛒  HISTORIAL DE VENTAS", bg=CP, sz=14); ws3.row_dimensions[1].height = 36
    for i, l in enumerate(["Venta", "Fecha", "Producto", "Cant.", "Precio $", "Total $", "Total Bs", "Ganancia $",
                           "Método", "Referencia", "Notas"], 1):
        hc(ws3, 2, i, l, bg=CA, sz=10); ws3.row_dimensions[2].height = 26
    qven = """SELECT v.*,p.nombre as pn, m.nombre as metodo FROM ventas v
              JOIN productos p ON v.producto_id=p.id
              LEFT JOIN metodos_pago m ON v.metodo_pago_id=m.id WHERE 1=1"""
    pvl = []
    if fi: qven += " AND DATE(v.fecha)>=%s"; pvl.append(fi)
    if ff: qven += " AND DATE(v.fecha)<=%s"; pvl.append(ff)
    qven += " ORDER BY v.venta_grupo_id DESC, v.id ASC"
    ventas = db.execute(qven, pvl).fetchall()
    ti = tg = 0; fila = 3; last_gid = None; gid_display = 0
    for v in ventas:
        bg = BL if v['venta_grupo_id'] % 2 == 0 else GC
        if v['venta_grupo_id'] != last_gid:
            last_gid = v['venta_grupo_id']; gid_display += 1
        tbs = (v['total'] or 0) * tasa if tasa else 0
        dc(ws3, fila, 1, f"#{gid_display}", bg=bg, bold=True)
        dc(ws3, fila, 2, v['fecha'][:10], bg=bg)
        dc(ws3, fila, 3, v['pn'], bg=bg, align='left', bold=True)
        dc(ws3, fila, 4, v['cantidad'], bg=bg)
        dc(ws3, fila, 5, v['precio_unitario'], bg=bg, fmt='"$"#,##0.00')
        dc(ws3, fila, 6, v['total'], bg=bg, fmt='"$"#,##0.00', bold=True)
        dc(ws3, fila, 7, f"Bs {tbs:,.0f}" if tasa else "—", bg=bg, fg="E67E22")
        g = v['ganancia'] or 0
        dc(ws3, fila, 8, g, bg=bg, fmt='"$"#,##0.00', fg=VE if g >= 0 else RO, bold=True)
        dc(ws3, fila, 9, v['metodo'] or '—', bg=bg)
        dc(ws3, fila, 10, v['pago_referencia'] or '', bg=bg, align='left')
        dc(ws3, fila, 11, v['notas'] or '', bg=bg, align='left')
        ti += v['total'] or 0; tg += g
        ws3.row_dimensions[fila].height = 20; fila += 1
    tr = fila
    ws3.merge_cells(f'A{tr}:E{tr}')
    hc(ws3, tr, 1, "TOTALES", bg=CP, sz=11, align='right')
    hc(ws3, tr, 6, f"${ti:,.2f}", bg=CP, sz=11)
    hc(ws3, tr, 7, f"Bs {ti*tasa:,.0f}" if tasa else "—", bg="0A2848", sz=11)
    hc(ws3, tr, 8, f"${tg:,.2f}", bg="1A6B3C", sz=11)
    ws3.row_dimensions[tr].height = 28
    for col, w in zip(range(1, 12), [8, 13, 24, 7, 11, 11, 14, 11, 13, 16, 18]):
        ws3.column_dimensions[get_column_letter(col)].width = w

    ws4 = wb.create_sheet("Por Dia"); ws4.sheet_view.showGridLines = False
    ws4.merge_cells('A1:F1'); hc(ws4, 1, 1, "📅  VENTAS POR DÍA", bg=CP, sz=14); ws4.row_dimensions[1].height = 36
    for i, l in enumerate(["Fecha", "Nº Ventas", "Unidades", "Ingresos $", "Ingresos Bs", "Ganancia $"], 1):
        hc(ws4, 2, i, l, bg=CA, sz=10); ws4.row_dimensions[2].height = 26
    for idx, d in enumerate(rep['por_dia'], 1):
        r = 2 + idx; bg = BL if idx % 2 == 0 else GC
        ibs = (d['t'] or 0) * tasa if tasa else 0
        dc(ws4, r, 1, d['d'], bg=bg, bold=True); dc(ws4, r, 2, d['n'], bg=bg); dc(ws4, r, 3, d['u'], bg=bg)
        dc(ws4, r, 4, d['t'], bg=bg, fmt='"$"#,##0.00', bold=True)
        dc(ws4, r, 5, f"Bs {ibs:,.0f}" if tasa else "—", bg=bg, fg="E67E22")
        dc(ws4, r, 6, d['g'], bg=bg, fmt='"$"#,##0.00', fg=VE if (d['g'] or 0) >= 0 else RO)
        ws4.row_dimensions[r].height = 20
    if len(rep['por_dia']) > 1:
        chart = BarChart(); chart.type = "col"; chart.title = "Ingresos por Día"
        chart.y_axis.title = "$"; chart.style = 10; chart.width = 22; chart.height = 14
        chart.add_data(Reference(ws4, min_col=4, min_row=3, max_row=2 + len(rep['por_dia'])))
        chart.set_categories(Reference(ws4, min_col=1, min_row=3, max_row=2 + len(rep['por_dia'])))
        ws4.add_chart(chart, "H3")
    for col, w in zip(range(1, 7), [14, 12, 12, 14, 16, 14]):
        ws4.column_dimensions[get_column_letter(col)].width = w

    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    fname = f"reporte_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return send_file(buf, as_attachment=True, download_name=fname,
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ── EXPORTAR PDF (admin) ───────────────────────────────────────
@app.route('/api/exportar-pdf', methods=['POST'])
@admin_required
def exportar_pdf():
    db = get_db()
    data = request.json
    fi = data.get('fecha_inicio', '')
    ff = data.get('fecha_fin', '')
    tasa = obtener_tasa_dolar() or data.get('tasa_manual', 0) or 0
    rep = _datos_reporte(db, fi, ff)

    AZUL = rl_colors.HexColor('#1A1A2E')
    AZUL2 = rl_colors.HexColor('#0F3460')
    VERDE = rl_colors.HexColor('#1A6B3C')
    NARANJA = rl_colors.HexColor('#E67E22')
    GRIS = rl_colors.HexColor('#F8F9FA')

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=rl_letter, topMargin=1.6*cm, bottomMargin=1.6*cm,
                            leftMargin=1.6*cm, rightMargin=1.6*cm)
    styles = getSampleStyleSheet()
    titulo_style = ParagraphStyle('titulo', parent=styles['Title'], fontSize=17, textColor=AZUL, spaceAfter=2)
    sub_style = ParagraphStyle('sub', parent=styles['Normal'], fontSize=9.5, textColor=rl_colors.HexColor('#555'), spaceAfter=14)
    seccion_style = ParagraphStyle('seccion', parent=styles['Heading2'], fontSize=12.5, textColor=AZUL2, spaceBefore=16, spaceAfter=8)
    nota_style = ParagraphStyle('nota', parent=styles['Normal'], fontSize=8.5, textColor=rl_colors.HexColor('#888'), spaceBefore=10)

    elementos = []
    elementos.append(Paragraph(f"🏪 {NOMBRE_TIENDA}", titulo_style))
    periodo = f"{fi} al {ff}" if fi else f"Reporte completo — {date.today().strftime('%d/%m/%Y')}"
    tasa_txt = f" &nbsp;|&nbsp; Tasa: 1 USD = {tasa:,.2f} Bs" if tasa else ""
    elementos.append(Paragraph(f"Reporte Ejecutivo &nbsp;·&nbsp; Período: {periodo}{tasa_txt}", sub_style))

    kpi_data = [
        ['Productos', 'Ventas', 'Ingresos', 'Ganancia'],
        [str(rep['total_productos']), str(rep['num_ventas']), f"${rep['ingresos']:,.2f}", f"${rep['ganancia']:,.2f}"]
    ]
    t = Table(kpi_data, colWidths=[4.2*cm]*4)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), AZUL), ('TEXTCOLOR', (0,0), (-1,0), rl_colors.white),
        ('BACKGROUND', (0,1), (-1,1), GRIS), ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'), ('GRID', (0,0), (-1,-1), 0.5, rl_colors.HexColor('#DDD')),
        ('FONTSIZE', (0,0), (-1,0), 9), ('FONTSIZE', (0,1), (-1,1), 13),
        ('FONTNAME', (0,1), (-1,1), 'Helvetica-Bold'),
        ('TOPPADDING', (0,0), (-1,-1), 8), ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ]))
    elementos.append(t)

    elementos.append(Paragraph("💳 Ventas por Método de Pago", seccion_style))
    mp_data = [['Método', 'Nº Ventas', 'Total $', 'Total Bs']]
    for m in rep['metodos']:
        mp_data.append([m['nombre'], str(m['n']), f"${m['t']:,.2f}",
                        f"Bs {(m['t'] or 0)*tasa:,.0f}" if tasa else "—"])
    if len(mp_data) == 1:
        mp_data.append(['Sin ventas en el período', '', '', ''])
    tm = Table(mp_data, colWidths=[5*cm, 3.7*cm, 3.7*cm, 4.3*cm])
    tm.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), AZUL2), ('TEXTCOLOR', (0,0), (-1,0), rl_colors.white),
        ('FONTSIZE', (0,0), (-1,-1), 9), ('ALIGN', (1,0), (-1,-1), 'CENTER'),
        ('GRID', (0,0), (-1,-1), 0.5, rl_colors.HexColor('#DDD')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [rl_colors.white, GRIS]),
        ('TOPPADDING', (0,0), (-1,-1), 6), ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('TEXTCOLOR', (2,1), (2,-1), VERDE), ('FONTNAME', (2,1), (2,-1), 'Helvetica-Bold'),
        ('TEXTCOLOR', (3,1), (3,-1), NARANJA),
    ]))
    elementos.append(tm)

    elementos.append(Paragraph("🏆 Top 10 Productos Más Vendidos", seccion_style))
    tp_data = [['#', 'Producto', 'Categoría', 'Cant.', 'Ingresos $', 'Ganancia $']]
    for i, row in enumerate(rep['top'], 1):
        tp_data.append([str(i), row['nombre'], row['categoria'], str(row['c']),
                        f"${row['t']:,.2f}", f"${row['g']:,.2f}"])
    if len(tp_data) == 1:
        tp_data.append(['—', 'Sin ventas en el período', '', '', '', ''])
    ttp = Table(tp_data, colWidths=[1*cm, 5.5*cm, 3*cm, 1.8*cm, 3*cm, 2.4*cm])
    ttp.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), AZUL2), ('TEXTCOLOR', (0,0), (-1,0), rl_colors.white),
        ('FONTSIZE', (0,0), (-1,-1), 8.5), ('ALIGN', (0,0), (0,-1), 'CENTER'),
        ('ALIGN', (3,0), (-1,-1), 'CENTER'),
        ('GRID', (0,0), (-1,-1), 0.5, rl_colors.HexColor('#DDD')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [rl_colors.white, GRIS]),
        ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('TEXTCOLOR', (4,1), (4,-1), VERDE),
    ]))
    elementos.append(ttp)

    elementos.append(Paragraph("📅 Ventas por Día", seccion_style))
    pd_data = [['Fecha', 'Nº Ventas', 'Unidades', 'Ingresos $', 'Ganancia $']]
    for d in rep['por_dia']:
        pd_data.append([d['d'], str(d['n']), str(d['u']), f"${d['t']:,.2f}", f"${d['g']:,.2f}"])
    if len(pd_data) == 1:
        pd_data.append(['—', 'Sin ventas en el período', '', '', ''])
    tpd = Table(pd_data, colWidths=[3.5*cm, 3*cm, 3*cm, 3.2*cm, 3*cm])
    tpd.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), AZUL2), ('TEXTCOLOR', (0,0), (-1,0), rl_colors.white),
        ('FONTSIZE', (0,0), (-1,-1), 8.5), ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('GRID', (0,0), (-1,-1), 0.5, rl_colors.HexColor('#DDD')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [rl_colors.white, GRIS]),
        ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ]))
    elementos.append(tpd)

    elementos.append(Paragraph(
        "Este PDF es un resumen ejecutivo para lectura e impresión rápida. "
        "Para el detalle línea por línea de cada venta e inventario completo, usa el reporte en Excel.",
        nota_style))

    doc.build(elementos)
    buf.seek(0)
    fname = f"reporte_{datetime.now().strftime('%Y%m%d_%H%M')}.pdf"
    return send_file(buf, as_attachment=True, download_name=fname, mimetype='application/pdf')


def _generar_certificado_https(cert_path, key_path):
    """Crea un certificado autofirmado para que la cámara del celular funcione."""
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from datetime import datetime, timedelta, timezone
        import ipaddress

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, u"DeToditoMarket"),
        ])
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=3650))
            .add_extension(
                x509.SubjectAlternativeName([
                    x509.DNSName(u"localhost"),
                    x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                ]),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )
        with open(key_path, "wb") as f:
            f.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            ))
        with open(cert_path, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
        return True
    except Exception as e:
        print(f"   (No se pudo generar certificado automatico: {e})")
        return False


if __name__ == '__main__':
    init_db()
    # Railway asigna el puerto
    port = int(os.environ.get('PORT', 5000))
    is_railway = os.environ.get('RAILWAY_ENVIRONMENT') is not None
    
    if is_railway:
        # En Railway: HTTP simple
        app.run(debug=False, port=port, host='0.0.0.0')
    else:
        # Local: con HTTPS para camara
        ip_local = obtener_ip_local()
        base_dir = os.path.dirname(os.path.abspath(__file__))
        cert = os.path.join(base_dir, 'cert.pem')
        key = os.path.join(base_dir, 'key.pem')
        if not (os.path.isfile(cert) and os.path.isfile(key)):
            _generar_certificado_https(cert, key)
        usar_https = os.path.isfile(cert) and os.path.isfile(key)
        ssl_ctx = (cert, key) if usar_https else None
        app.run(debug=False, port=5000, host='0.0.0.0', ssl_context=ssl_ctx)

@app.route('/api/ventas-pausadas', methods=['GET'])
def listar_pausadas():
    db = get_db()
    rows = db.execute("SELECT id, nombre, carrito, fecha FROM ventas_pausadas ORDER BY id DESC").fetchall()
    return jsonify([{'id': r['id'], 'nombre': r['nombre'], 'carrito': r['carrito'], 'fecha': str(r['fecha'])} for r in rows])

@app.route('/api/ventas-pausadas', methods=['POST'])
def crear_pausada():
    db = get_db()
    data = request.get_json() or {}
    nombre = data.get('nombre', 'Cliente')
    carrito = data.get('carrito', '[]')
    db.execute("INSERT INTO ventas_pausadas (nombre, carrito) VALUES (%s, %s)", (nombre, carrito))
    db.commit()
    return jsonify({'ok': True})

@app.route('/api/ventas-pausadas/<int:pid>', methods=['DELETE'])
def borrar_pausada(pid):
    db = get_db()
    db.execute("DELETE FROM ventas_pausadas WHERE id=%s", (pid,))
    db.commit()
    return jsonify({'ok': True})
