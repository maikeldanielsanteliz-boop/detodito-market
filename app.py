from flask import Flask, render_template, request, jsonify, send_file, session, g
from database import init_db, get_db
from datetime import datetime, date, timedelta
import json
from functools import wraps
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.exceptions import HTTPException
import unicodedata
from decimal import Decimal, ROUND_HALF_UP
import pymysql
import os, requests, base64, io, re, socket, logging, math, secrets, time
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, Reference
from reportlab.lib import colors as rl_colors
from reportlab.lib.pagesizes import letter as rl_letter
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, 'instance')   # base de datos y clave de sesión
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'static', 'uploads')   # fotos de productos
os.makedirs(INSTANCE_DIR, exist_ok=True)
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


def _cargar_secret_key():
    """Devuelve una clave de sesión aleatoria; se crea una vez y se guarda en instance/secret.key."""
    ruta = os.path.join(INSTANCE_DIR, 'secret.key')
    try:
        with open(ruta, 'r', encoding='utf-8') as f:
            clave = f.read().strip()
        if len(clave) >= 32:
            return clave
    except OSError:
        pass
    clave = secrets.token_hex(32)
    try:
        with open(ruta, 'w', encoding='utf-8') as f:
            f.write(clave)
    except OSError:
        pass  # sin permiso de escritura: la clave vive en memoria (la sesión se pierde al reiniciar)
    return clave


app = Flask(__name__)
# Firma de las sesiones (clave aleatoria guardada en instance/)
app.config['SECRET_KEY'] = _cargar_secret_key()
app.config['MAX_CONTENT_LENGTH'] = 12 * 1024 * 1024   # límite de la petición (una foto de 5 MB en base64 ocupa ~7 MB)
# La sesión de administrador dura 12 horas
app.permanent_session_lifetime = timedelta(hours=12)

# Nombre que aparece en el sistema, el recibo y los reportes
NOMBRE_TIENDA = "DE TODITO MARKET MyF, C.A"
# Registro de eventos en la consola
logging.basicConfig(level=logging.INFO)

# Caché de la tasa del dólar (se consulta una vez al día)
_tasa_cache = {'valor': None, 'fecha': None, 'ultimo_intento': 0}
TOLERANCIA_PAGO = 0.02   # diferencia máxima (USD) por redondeo entre pagos y total de la factura


def _cargar_tasa_guardada():
    """Recupera la última tasa conocida de la base de datos (sobrevive a reinicios y a cortes de internet)."""
    try:
        db = get_db()
        v = db.execute("SELECT valor FROM configuracion WHERE clave='tasa_valor'").fetchone()
        f = db.execute("SELECT valor FROM configuracion WHERE clave='tasa_fecha'").fetchone()
        if v and _to_float(v['valor']) > 0:
            _tasa_cache['valor'] = _to_float(v['valor'])
            _tasa_cache['fecha'] = f['valor'] if f else None
    except Exception as e:
        app.logger.warning(f'No se pudo leer la tasa guardada: {e}')


def _guardar_tasa(valor, fecha):
    """Guarda la tasa en memoria y en la base de datos."""
    _tasa_cache['valor'] = float(valor)
    _tasa_cache['fecha'] = fecha
    try:
        db = get_db()
        for clave, val in (('tasa_valor', str(valor)), ('tasa_fecha', fecha)):
            if db.execute("SELECT 1 FROM configuracion WHERE clave=?", (clave,)).fetchone():
                db.execute("UPDATE configuracion SET valor=? WHERE clave=?", (val, clave))
            else:
                db.execute("INSERT INTO configuracion (clave, valor) VALUES (?, ?)", (clave, val))
        db.commit()
    except Exception as e:
        app.logger.warning(f'No se pudo guardar la tasa: {e}')


def tasa_vigente():
    """Última tasa conocida SIN consultar internet (para registrar ventas rápido, incluso sin conexión)."""
    if not _tasa_cache['valor']:
        _cargar_tasa_guardada()
    return _tasa_cache['valor']


# Consulta la tasa USD→VES en internet (una vez al día); si falla, usa la última guardada
def obtener_tasa_dolar():
    hoy = date.today().isoformat()
    if not _tasa_cache['valor']:
        _cargar_tasa_guardada()
    if _tasa_cache['fecha'] == hoy and _tasa_cache['valor']:
        return _tasa_cache['valor']
    # Sin conexión no se reintenta en cada petición: solo una vez por minuto
    if time.time() - _tasa_cache['ultimo_intento'] > 60:
        _tasa_cache['ultimo_intento'] = time.time()
        try:
            # Servicio público de tasas de cambio
            r = requests.get('https://open.er-api.com/v6/latest/USD', timeout=6)
            if r.status_code == 200:
                tasa = r.json().get('rates', {}).get('VES')
                if tasa:
                    _guardar_tasa(float(tasa), hoy)
                    return float(tasa)
        except Exception:
            pass
    return _tasa_cache['valor'] or None


# Obtiene la IP de esta PC en la red WiFi para entrar desde el celular
def obtener_ip_local():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# Exige 8+ caracteres con mayúscula, minúscula y número
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


# Captura errores inesperados y responde en JSON sin detener el servidor
@app.errorhandler(Exception)
def manejar_error_global(e):
    # MySQL apagado o con datos de acceso incorrectos
    if isinstance(e, pymysql.err.OperationalError):
        app.logger.error(f'MySQL: {e}')
        return jsonify({'error': 'No hay conexión con la base de datos MySQL. Revisa que esté encendida.'}), 503
    # Errores HTTP normales (404, 405, 413...) se devuelven con su código real
    if isinstance(e, HTTPException):
        if request.path.startswith('/api/'):
            msg = 'La foto es demasiado pesada (máximo 5 MB)' if e.code == 413 else (e.description or 'Solicitud inválida')
            return jsonify({'error': msg}), e.code
        return e
    try:
        db = get_db()
        db.rollback()
    except Exception:
        pass
    app.logger.error(f"Error no manejado en {request.path}: {e}")
    return jsonify({'error': 'Ocurrió un error interno. La operación no se guardó. Intenta de nuevo.'}), 500



def _dinero(valor):
    """Redondea a 2 decimales (centavos) sin errores de coma flotante (0.1+0.2 -> 0.30)."""
    try:
        return float(Decimal(str(valor)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
    except Exception:
        return 0.0


def _subtotal(precio, cantidad):
    """Precio × cantidad redondeado a centavos."""
    return _dinero(Decimal(str(precio)) * Decimal(str(cantidad)))


def _margen(precio, costo, cantidad):
    """Ganancia de una línea: (precio - costo) × cantidad, en centavos."""
    return _dinero((Decimal(str(precio)) - Decimal(str(costo))) * Decimal(str(cantidad)))


def _like(texto):
    """Texto para LIKE ... ESCAPE '!': los símbolos % y _ escritos por el usuario se toman literales."""
    t = str(texto).replace('!', '!!').replace('%', '!%').replace('_', '!_')
    return f"%{t}%"


def _body():
    """Cuerpo JSON de la petición como dict (vacío si no viene o es inválido)."""
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


# Convierte a entero de forma segura (devuelve el valor por defecto si no es válido)
def _to_int(val, default=0):
    try:
        if val is None or val == '':
            return default
        n = float(val)
        return int(n) if math.isfinite(n) else default
    except (TypeError, ValueError, OverflowError):
        return default

# Convierte a decimal de forma segura (descarta NaN e infinito)
def _to_float(val, default=0.0):
    try:
        if val is None or val == '':
            return default
        n = float(val)
        return n if math.isfinite(n) else default
    except (TypeError, ValueError):
        return default


# Unidades permitidas para cada tipo de medida
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

# Verifica que la unidad (kg, litro, unidad...) corresponda al tipo de medida
def validar_unidad(tipo_medida, unidad):
    tipo = (tipo_medida or 'unidad').lower()
    uni = (unidad or 'unidad').lower()
    permitidas = UNIDADES_POR_TIPO.get(tipo, UNIDADES_POR_TIPO['unidad'])
    if uni not in permitidas:
        return f'Para tipo "{TIPOS_MEDIDA_LABEL.get(tipo, tipo)}" la unidad debe ser: {", ".join(permitidas)}'
    return None

# Decorador: solo permite el paso a quien tenga sesión de administrador
def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('is_admin'):
            return jsonify({'error': 'No autorizado. Inicia sesión como administrador.'}), 401
        return f(*args, **kwargs)
    return wrapper


# Página principal (interfaz completa)
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
        nueva = str(_body().get('password') or '')
        error = validar_fortaleza_password(nueva)
        if error:
            return jsonify({'error': error}), 400
        db.execute("INSERT INTO configuracion (clave,valor) VALUES ('admin_password_hash', ?)",
                   (generate_password_hash(nueva),))
        db.commit()
        session['is_admin'] = True
        session.permanent = True
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo configurar la contraseña'}), 500


_intentos_login = {}          # ip -> [fallos, instante_de_desbloqueo]
MAX_INTENTOS_LOGIN = 5        # fallos permitidos antes de bloquear
BLOQUEO_LOGIN_SEG = 60        # segundos de bloqueo


# Inicio de sesión de administrador, con bloqueo temporal tras varios intentos fallidos
@app.route('/api/login', methods=['POST'])
def login():
    # Control de intentos fallidos por dirección IP
    ip = request.remote_addr or 'local'
    fallos, hasta = _intentos_login.get(ip, [0, 0])
    if hasta > time.time():
        return jsonify({'error': f'Demasiados intentos. Espera {int(hasta - time.time()) + 1} s.'}), 429
    password = str(_body().get('password') or '')
    db = get_db()
    row = db.execute("SELECT valor FROM configuracion WHERE clave='admin_password_hash'").fetchone()
    if row and check_password_hash(row['valor'], password):
        _intentos_login.pop(ip, None)
        session['is_admin'] = True
        session.permanent = True
        return jsonify({'ok': True})
    fallos += 1
    _intentos_login[ip] = [0, time.time() + BLOQUEO_LOGIN_SEG] if fallos >= MAX_INTENTOS_LOGIN else [fallos, 0]
    return jsonify({'error': 'Contraseña incorrecta'}), 401


# Cierra la sesión de administrador
@app.route('/api/logout', methods=['POST'])
def logout():
    session.pop('is_admin', None)
    return jsonify({'ok': True})


# Informa si hay sesión de administrador y si ya existe contraseña
@app.route('/api/auth-status', methods=['GET'])
def auth_status():
    db = get_db()
    row = db.execute("SELECT valor FROM configuracion WHERE clave='admin_password_hash'").fetchone()
    return jsonify({'is_admin': bool(session.get('is_admin')), 'password_configurada': bool(row)})


# Cambia la contraseña de administrador (pide la actual)
@app.route('/api/cambiar-password', methods=['POST'])
@admin_required
def cambiar_password():
    db = get_db()
    try:
        d = _body()
        actual = str(d.get('actual') or '')
        nueva = str(d.get('nueva') or '')
        row = db.execute("SELECT valor FROM configuracion WHERE clave='admin_password_hash'").fetchone()
        if not row or not check_password_hash(row['valor'], actual):
            return jsonify({'error': 'Contraseña actual incorrecta'}), 400
        error = validar_fortaleza_password(nueva)
        if error:
            return jsonify({'error': error}), 400
        db.execute("UPDATE configuracion SET valor=? WHERE clave='admin_password_hash'",
                   (generate_password_hash(nueva),))
        db.commit()
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo cambiar la contraseña'}), 500


# ── SUBIR IMAGEN (admin) ──────────────────────────────────────
def _extension_imagen(datos):
    """Detecta el formato real de la imagen por sus primeros bytes (None si no es imagen válida)."""
    if datos[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if datos[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if datos[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if datos[:4] == b'RIFF' and datos[8:12] == b'WEBP':
        return 'webp'
    return None


# Guarda la foto de un producto (solo admin; valida el formato real del archivo)
@app.route('/api/subir-imagen', methods=['POST'])
@admin_required
def subir_imagen():
    data = _body()
    imagen_b64 = data.get('imagen_b64') or ''
    if not isinstance(imagen_b64, str) or not imagen_b64:
        return jsonify({'error': 'Sin imagen'}), 400
    try:
        b64data = imagen_b64.split(',', 1)[1] if ',' in imagen_b64 else imagen_b64
        contenido = base64.b64decode(b64data)
    except Exception:
        return jsonify({'error': 'Imagen inválida'}), 400
    if len(contenido) > 5 * 1024 * 1024:
        return jsonify({'error': 'La foto pesa más de 5 MB'}), 400
    ext = _extension_imagen(contenido)
    if not ext:
        return jsonify({'error': 'Formato no soportado. Usa JPG, PNG, GIF o WEBP'}), 400
    try:
        safe = re.sub(r'[^a-zA-Z0-9_-]', '_', str(data.get('nombre') or 'img'))[:30]
        filename = f"{safe}_{datetime.now().strftime('%Y%m%d%H%M%S%f')}.{ext}"
        with open(os.path.join(UPLOAD_FOLDER, filename), 'wb') as f:
            f.write(contenido)
        return jsonify({'url': f'/static/uploads/{filename}'})
    except Exception:
        return jsonify({'error': 'No se pudo guardar la imagen'}), 500


# ── TASA DÓLAR (pública) ──────────────────────────────────────
@app.route('/api/tasa-dolar', methods=['GET'])
def tasa_dolar():
    tasa = obtener_tasa_dolar()
    if tasa:
        return jsonify({'tasa': tasa, 'fecha': _tasa_cache['fecha'] or date.today().isoformat(), 'fuente': 'open.er-api.com'})
    return jsonify({'tasa': None, 'error': 'Sin conexión'}), 200


# Guarda una tasa escrita a mano (útil sin internet)
@app.route('/api/tasa-dolar', methods=['POST'])
def guardar_tasa_manual():
    tasa = _to_float(_body().get('tasa'))
    if tasa <= 0 or tasa > 1_000_000:
        return jsonify({'error': 'Tasa inválida'}), 400
    _guardar_tasa(tasa, date.today().isoformat())
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


# Crea un método de pago nuevo
@app.route('/api/metodos-pago', methods=['POST'])
@admin_required
def crear_metodo_pago():
    db = get_db()
    try:
        dj = _body()
        nombre = str(dj.get('nombre') or '').strip()
        if not nombre:
            return jsonify({'error': 'Nombre requerido'}), 400
        dup = db.execute("SELECT id FROM metodos_pago WHERE nombre=?", (nombre,)).fetchone()
        if dup:
            return jsonify({'error': 'Ya existe un método de pago con ese nombre'}), 400
        requiere_moviles = 1 if dj.get('requiere_datos_moviles') else 0
        datos_cedula = (dj.get('datos_cedula') or '').strip()
        datos_banco = (dj.get('datos_banco') or '').strip()
        datos_telefono = (dj.get('datos_telefono') or '').strip()
        maxorden = db.execute("SELECT MAX(orden) FROM metodos_pago").fetchone()[0] or 0
        cur = db.execute(
            """INSERT INTO metodos_pago (nombre,activo,orden,requiere_datos_moviles,datos_cedula,datos_banco,datos_telefono)
               VALUES (?,1,?,?,?,?,?)""",
            (nombre, maxorden + 1, requiere_moviles, datos_cedula, datos_banco, datos_telefono))
        db.commit()
        return jsonify(dict(db.execute("SELECT * FROM metodos_pago WHERE id=?", (cur.lastrowid,)).fetchone())), 201
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo crear el método de pago'}), 500


# Edita nombre, estado y datos de un método de pago
@app.route('/api/metodos-pago/<int:mid>', methods=['PUT'])
@admin_required
def actualizar_metodo_pago(mid):
    db = get_db()
    try:
        d = _body()
        if 'nombre' in d:
            nombre = str(d['nombre'] or '').strip()
            if not nombre:
                return jsonify({'error': 'Nombre requerido'}), 400
            dup = db.execute("SELECT id FROM metodos_pago WHERE nombre=? AND id!=?", (nombre, mid)).fetchone()
            if dup:
                return jsonify({'error': 'Ya existe un método de pago con ese nombre'}), 400
            db.execute("UPDATE metodos_pago SET nombre=? WHERE id=?", (nombre, mid))
        if 'activo' in d:
            db.execute("UPDATE metodos_pago SET activo=? WHERE id=?", (1 if d['activo'] else 0, mid))
        if 'requiere_datos_moviles' in d:
            db.execute("UPDATE metodos_pago SET requiere_datos_moviles=? WHERE id=?",
                       (1 if d['requiere_datos_moviles'] else 0, mid))
        if any(k in d for k in ('datos_cedula', 'datos_banco', 'datos_telefono')):
            db.execute(
                "UPDATE metodos_pago SET datos_cedula=?, datos_banco=?, datos_telefono=? WHERE id=?",
                (d.get('datos_cedula', ''), d.get('datos_banco', ''), d.get('datos_telefono', ''), mid)
            )
        db.commit()
        return jsonify({'ok': True})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo actualizar el método de pago'}), 500


# Borra el método; si ya tiene ventas solo lo desactiva
@app.route('/api/metodos-pago/<int:mid>', methods=['DELETE'])
@admin_required
def eliminar_metodo_pago(mid):
    db = get_db()
    try:
        en_uso = (db.execute("SELECT COUNT(*) FROM ventas WHERE metodo_pago_id=?", (mid,)).fetchone()[0]
                  + db.execute("SELECT COUNT(*) FROM pagos_venta WHERE metodo_pago_id=?", (mid,)).fetchone()[0])
        if en_uso > 0:
            db.execute("UPDATE metodos_pago SET activo=0 WHERE id=?", (mid,))
            db.commit()
            return jsonify({'ok': True, 'desactivado': True})
        db.execute("DELETE FROM metodos_pago WHERE id=?", (mid,))
        db.commit()
        return jsonify({'ok': True, 'desactivado': False})
    except Exception:
        db.rollback()
        return jsonify({'error': 'No se pudo eliminar el método de pago'}), 500


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


# Registra un proveedor nuevo
@app.route('/api/proveedores', methods=['POST'])
@admin_required
def crear_proveedor():
    db = get_db()
    try:
        d = _body()
        nombre = (d.get('nombre') or '').strip()
        if not nombre:
            return jsonify({'error': 'Nombre del proveedor requerido'}), 400
        cur = db.execute(
            """INSERT INTO proveedores (nombre, telefono, rif_cedula, direccion, notas, activo)
               VALUES (?,?,?,?,?,1)""",
            (nombre, (d.get('telefono') or '').strip(), (d.get('rif_cedula') or '').strip(),
             (d.get('direccion') or '').strip(), (d.get('notas') or '').strip())
        )
        db.commit()
        return jsonify(dict(db.execute("SELECT * FROM proveedores WHERE id=?", (cur.lastrowid,)).fetchone())), 201
    except Exception as e:
        db.rollback()
        app.logger.error(f'No se pudo crear el proveedor: {e}')
        return jsonify({'error': 'No se pudo crear el proveedor'}), 500


# Edita los datos de un proveedor
@app.route('/api/proveedores/<int:pid>', methods=['PUT'])
@admin_required
def actualizar_proveedor(pid):
    db = get_db()
    try:
        d = _body()
        row = db.execute("SELECT id FROM proveedores WHERE id=?", (pid,)).fetchone()
        if not row:
            return jsonify({'error': 'Proveedor no encontrado'}), 404
        nombre = (d.get('nombre') or '').strip()
        if not nombre:
            return jsonify({'error': 'Nombre requerido'}), 400
        db.execute(
            """UPDATE proveedores SET nombre=?, telefono=?, rif_cedula=?, direccion=?, notas=?,
               activo=? WHERE id=?""",
            (nombre, (d.get('telefono') or '').strip(), (d.get('rif_cedula') or '').strip(),
             (d.get('direccion') or '').strip(), (d.get('notas') or '').strip(),
             1 if d.get('activo', True) else 0, pid)
        )
        db.commit()
        return jsonify({'ok': True})
    except Exception as e:
        db.rollback()
        app.logger.error(f'No se pudo actualizar: {e}')
        return jsonify({'error': 'No se pudo actualizar'}), 500


# Borra el proveedor; si tiene productos asociados solo lo desactiva
@app.route('/api/proveedores/<int:pid>', methods=['DELETE'])
@admin_required
def eliminar_proveedor(pid):
    db = get_db()
    try:
        # Si hay productos asociados, solo desactivar
        en_uso = db.execute("SELECT COUNT(*) FROM productos WHERE proveedor_id=?", (pid,)).fetchone()[0]
        if en_uso > 0:
            db.execute("UPDATE proveedores SET activo=0 WHERE id=?", (pid,))
            db.commit()
            return jsonify({'ok': True, 'desactivado': True,
                            'msg': f'Tiene {en_uso} producto(s). Se desactivó en lugar de borrar.'})
        db.execute("DELETE FROM proveedores WHERE id=?", (pid,))
        db.commit()
        return jsonify({'ok': True, 'desactivado': False})
    except Exception as e:
        db.rollback()
        app.logger.error(f'No se pudo eliminar: {e}')
        return jsonify({'error': 'No se pudo eliminar'}), 500


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
    # Filtros opcionales por categoría y por texto
    q, params = "SELECT * FROM productos WHERE 1=1", []
    cat = request.args.get('categoria', '')
    bus = request.args.get('busqueda', '')
    if cat: q += " AND categoria=?"; params.append(cat)
    if bus: q += " AND (nombre LIKE ? ESCAPE '!' OR codigo_barras LIKE ? ESCAPE '!')"; params += [_like(bus), _like(bus)]
    return jsonify([dict(p) for p in db.execute(q + ' ORDER BY nombre', params).fetchall()])


# Orden de las columnas de productos en los INSERT / UPDATE
_ORDEN_PRODUCTO = ['nombre', 'categoria', 'precio_compra', 'precio_venta', 'stock', 'stock_minimo',
                   'stock_maximo', 'unidad', 'imagen_url', 'descripcion', 'codigo_barras', 'proveedor_id', 'tipo_medida']
PREFIJO_MAL_PRODUCTO = 'Producto mal elaborado: '
PRECIO_MAXIMO = 1_000_000      # por encima de esto casi seguro es un dígito de más
STOCK_MAXIMO_VALOR = 10_000_000


def _limpiar_nombre(nombre):
    """Quita espacios sobrantes (al inicio, al final y repetidos en el medio)."""
    return re.sub(r'\s+', ' ', str(nombre or '')).strip()


def _clave_nombre(nombre):
    """Nombre para comparar duplicados: sin mayúsculas, acentos ni espacios repetidos (Huevo = HUEVO = huevo)."""
    t = unicodedata.normalize('NFKD', str(nombre or ''))
    t = ''.join(ch for ch in t if not unicodedata.combining(ch))
    return re.sub(r'\s+', ' ', t).strip().casefold()


def _nombre_duplicado(db, nombre, excluir_id=None):
    """Devuelve el producto que ya tiene ese nombre (ignorando mayúsculas), o None. 'Huevo cartón' no choca con 'Huevo'."""
    clave = _clave_nombre(nombre)
    for f in db.execute("SELECT id, nombre FROM productos").fetchall():
        if f['id'] != excluir_id and _clave_nombre(f['nombre']) == clave:
            return f
    return None


def _respuesta_duplicado(dup, nombre):
    """Respuesta 409 de producto duplicado, con una sugerencia."""
    return jsonify({
        'error': f'Producto duplicado: ya existe "{dup["nombre"]}" (el mismo nombre, sin importar mayúsculas o minúsculas). '
                 f'Si es otra presentación, distínguela en el nombre, por ejemplo "{nombre} cartón".',
        'duplicado': True, 'id_existente': dup['id']}), 409


def _leer_numero(d, clave, etiqueta, errores, vacio=0.0):
    """Lee un número del formulario: vacío -> valor por defecto; texto o NaN/infinito -> se anota el error."""
    v = d.get(clave)
    if v is None or (isinstance(v, str) and not v.strip()):
        return vacio
    try:
        n = float(v)
    except (TypeError, ValueError):
        errores.append(f'{etiqueta} no es un número válido')
        return None
    if not math.isfinite(n):
        errores.append(f'{etiqueta} no es un número válido')
        return None
    return n


def _es_por_unidad(prod):
    """True si el producto se mide por unidades enteras (no kg ni litros)."""
    return str(prod['tipo_medida'] or 'unidad').lower() == 'unidad'


def _campos_producto(d):
    """Valida y normaliza los datos de un producto. Devuelve (campos, errores, advertencias)."""
    errores, avisos = [], []
    nombre = _limpiar_nombre(d.get('nombre'))
    if not nombre:
        errores.append('falta el nombre')
    elif len(nombre) < 2:
        errores.append('el nombre es demasiado corto')
    elif len(nombre) > 255:
        errores.append('el nombre es demasiado largo (máximo 255 caracteres)')
    elif not re.search(r'[^\W\d_]', nombre):
        errores.append('el nombre debe tener letras (no solo números o símbolos)')

    tipo_med = str(d.get('tipo_medida') or 'unidad').lower()
    unidad = str(d.get('unidad') or 'unidad').lower()
    err_u = validar_unidad(tipo_med, unidad)
    if err_u:
        errores.append(err_u[0].lower() + err_u[1:] if err_u else err_u)

    precio_venta = _leer_numero(d, 'precio_venta', 'el precio de venta', errores)
    precio_compra = _leer_numero(d, 'precio_compra', 'el precio de compra', errores)
    stock = _leer_numero(d, 'stock', 'el stock', errores)
    smin = _leer_numero(d, 'stock_minimo', 'el stock mínimo', errores)
    smax = _leer_numero(d, 'stock_maximo', 'el stock máximo', errores)

    if precio_venta is not None:
        if precio_venta < 0:
            errores.append('el precio de venta no puede ser negativo')
        elif precio_venta == 0:
            errores.append('el precio de venta debe ser mayor que $0')
        elif precio_venta > PRECIO_MAXIMO:
            errores.append(f'el precio de venta (${precio_venta:,.2f}) es demasiado alto; revisa si escribiste un dígito de más')
    if precio_compra is not None:
        if precio_compra < 0:
            errores.append('el precio de compra no puede ser negativo')
        elif precio_compra > PRECIO_MAXIMO:
            errores.append(f'el precio de compra (${precio_compra:,.2f}) es demasiado alto; revisa si escribiste un dígito de más')
    if stock is not None:
        if stock < 0:
            errores.append('el stock no puede ser negativo')
        elif stock > STOCK_MAXIMO_VALOR:
            errores.append('el stock es demasiado grande; revisa el número')
        elif tipo_med == 'unidad' and abs(stock - round(stock)) > 1e-9:
            errores.append('este producto se mide por unidad: el stock debe ser un número entero (sin decimales)')
    for etiqueta, v in (('el stock mínimo', smin), ('el stock máximo', smax)):
        if v is None:
            continue
        if v < 0:
            errores.append(f'{etiqueta} no puede ser negativo')
        elif abs(v - round(v)) > 1e-9:
            errores.append(f'{etiqueta} debe ser un número entero')
    if smin is not None and smax is not None and smax > 0 and smax < smin:
        errores.append('el stock máximo no puede ser menor que el stock mínimo')

    codigo = str(d.get('codigo_barras') or '').strip()
    if re.search(r'\s', codigo):
        errores.append('el código de barras no debe tener espacios')
    elif len(codigo) > 100:
        errores.append('el código de barras es demasiado largo')
    imagen_url = str(d.get('imagen_url') or '')
    if len(imagen_url) > 500:
        errores.append('la dirección de la imagen es demasiado larga')
    if errores:
        return None, errores, avisos

    if precio_venta < precio_compra:
        avisos.append(f'el precio de venta (${precio_venta:g}) es menor que el costo (${precio_compra:g}): venderás con pérdida')
    prov_id = _to_int(d.get('proveedor_id'), 0) or None   # 0 / vacío = sin proveedor
    return {
        'nombre': nombre,
        'categoria': _limpiar_nombre(d.get('categoria')) or 'General',
        'precio_compra': round(precio_compra, 4),
        'precio_venta': round(precio_venta, 4),
        'stock': round(stock, 3),
        'stock_minimo': int(round(smin)),
        'stock_maximo': int(round(smax)),
        'unidad': unidad,
        'imagen_url': imagen_url,
        'descripcion': str(d.get('descripcion') or ''),
        'codigo_barras': codigo,
        'proveedor_id': prov_id,
        'tipo_medida': tipo_med,
    }, errores, avisos


def _error_producto(errores):
    """Respuesta 400 con todos los problemas del producto."""
    return jsonify({'error': PREFIJO_MAL_PRODUCTO + '; '.join(errores), 'errores': errores}), 400


# Crea un producto nuevo (valida datos y rechaza nombres duplicados)
@app.route('/api/productos', methods=['POST'])
@admin_required
def crear_producto():
    db = get_db()
    try:
        c, errores, avisos = _campos_producto(_body())
        if errores:
            return _error_producto(errores)
        dup = _nombre_duplicado(db, c['nombre'])
        if dup:
            return _respuesta_duplicado(dup, c['nombre'])
        if c['codigo_barras']:
            dup = db.execute("SELECT id, nombre FROM productos WHERE codigo_barras=?", (c['codigo_barras'],)).fetchone()
            if dup:
                return jsonify({'error': f'Código de barras repetido: ya lo tiene "{dup["nombre"]}"', 'duplicado': True}), 409
        cur = db.execute(
            """INSERT INTO productos (nombre,categoria,precio_compra,precio_venta,stock,stock_minimo,
               stock_maximo,unidad,imagen_url,descripcion,codigo_barras,proveedor_id,tipo_medida)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", [c[k] for k in _ORDEN_PRODUCTO])
        db.commit()
        fila = dict(db.execute("SELECT * FROM productos WHERE id=?", (cur.lastrowid,)).fetchone())
        fila['advertencias'] = avisos
        return jsonify(fila), 201
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error crear producto: {e}')
        return jsonify({'error': 'No se pudo guardar el producto'}), 500


# Actualiza un producto existente (mismas validaciones que al crearlo)
@app.route('/api/productos/<int:pid>', methods=['PUT'])
@admin_required
def actualizar_producto(pid):
    db = get_db()
    try:
        actual = db.execute("SELECT id, nombre FROM productos WHERE id=?", (pid,)).fetchone()
        if not actual:
            return jsonify({'error': 'Producto no encontrado'}), 404
        c, errores, avisos = _campos_producto(_body())
        if errores:
            return _error_producto(errores)
        # Solo se revisa el duplicado si cambió el nombre (así se pueden seguir editando productos antiguos repetidos)
        if _clave_nombre(c['nombre']) != _clave_nombre(actual['nombre']):
            dup = _nombre_duplicado(db, c['nombre'], excluir_id=pid)
            if dup:
                return _respuesta_duplicado(dup, c['nombre'])
        if c['codigo_barras']:
            dup = db.execute("SELECT id, nombre FROM productos WHERE codigo_barras=? AND id!=?", (c['codigo_barras'], pid)).fetchone()
            if dup:
                return jsonify({'error': f'Código de barras repetido: ya lo tiene "{dup["nombre"]}"', 'duplicado': True}), 409
        db.execute(
            """UPDATE productos SET
               nombre=?, categoria=?, precio_compra=?, precio_venta=?,
               stock=?, stock_minimo=?, stock_maximo=?, unidad=?,
               imagen_url=?, descripcion=?, codigo_barras=?,
               proveedor_id=?, tipo_medida=?
               WHERE id=?""", [c[k] for k in _ORDEN_PRODUCTO] + [pid])
        db.commit()
        return jsonify({'ok': True, 'advertencias': avisos})
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error actualizar producto: {e}')
        return jsonify({'error': 'No se pudo actualizar el producto'}), 500


# Revisa todo el inventario y lista los productos con datos mal elaborados
@app.route('/api/productos/revision', methods=['GET'])
@admin_required
def revisar_productos():
    """Productos con precio en $0, nombre repetido, stock raro, etc. 'grave' impide vender; 'aviso' solo advierte."""
    db = get_db()
    filas = db.execute("SELECT id,nombre,precio_compra,precio_venta,stock,stock_minimo,stock_maximo,tipo_medida "
                       "FROM productos ORDER BY nombre").fetchall()
    por_clave = {}
    for f in filas:
        por_clave.setdefault(_clave_nombre(f['nombre']), []).append(f)
    salida = []
    for f in filas:
        graves, avisos = [], []
        if not re.search(r'[^\W\d_]', str(f['nombre'] or '')):
            graves.append('El nombre no tiene letras')
        if (f['precio_venta'] or 0) <= 0:
            graves.append('Precio de venta en $0: no se puede vender hasta corregirlo')
        elif (f['precio_venta'] or 0) < (f['precio_compra'] or 0):
            avisos.append(f'Precio de venta (${f["precio_venta"]:g}) menor al costo (${f["precio_compra"]:g}): se vende con pérdida')
        if (f['stock'] or 0) < 0:
            graves.append('Stock negativo')
        if _es_por_unidad(f) and abs((f['stock'] or 0) - round(f['stock'] or 0)) > 1e-9:
            avisos.append('Stock con decimales en un producto que se mide por unidad')
        if (f['stock_maximo'] or 0) > 0 and (f['stock_maximo'] or 0) < (f['stock_minimo'] or 0):
            avisos.append('El stock máximo es menor que el mínimo')
        otros = [o['id'] for o in por_clave[_clave_nombre(f['nombre'])] if o['id'] != f['id']]
        if otros:
            graves.append('Nombre repetido (también en ' + ', '.join(f'#{i}' for i in otros) + '): elimina o renombra uno')
        if graves or avisos:
            salida.append({'id': f['id'], 'nombre': f['nombre'], 'graves': graves, 'avisos': avisos})
    return jsonify({'total': len(salida), 'productos': salida})


# Elimina un producto (no se permite si ya tiene ventas)
@app.route('/api/productos/<int:pid>', methods=['DELETE'])
@admin_required
def eliminar_producto(pid):
    db = get_db()
    try:
        # Si el producto tiene ventas, no se puede borrar (FK). Avisamos claramente.
        en_ventas = db.execute("SELECT COUNT(*) FROM ventas WHERE producto_id=?", (pid,)).fetchone()[0]
        if en_ventas > 0:
            return jsonify({
                'error': 'No se puede eliminar: este producto ya tiene ventas registradas. '
                         'Puedes poner su stock en 0 o cambiar el nombre si ya no lo usas.'
            }), 400
        db.execute("DELETE FROM productos WHERE id=?", (pid,))
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
    q = """SELECT id,nombre,categoria,precio_venta,stock,unidad,imagen_url,codigo_barras,tipo_medida
           FROM productos WHERE 1=1"""
    params = []
    if bus:
        q += " AND (nombre LIKE ? ESCAPE '!' OR codigo_barras LIKE ? ESCAPE '!')"
        params += [_like(bus), _like(bus)]
    q += " ORDER BY nombre"
    return jsonify([dict(p) for p in db.execute(q, params).fetchall()])


# Busca un producto por código de barras (lector o cámara)
@app.route('/api/productos/codigo/<codigo>', methods=['GET'])
def producto_por_codigo(codigo):
    db = get_db()
    p = db.execute(
        """SELECT id,nombre,categoria,precio_venta,stock,unidad,imagen_url,codigo_barras,tipo_medida
           FROM productos WHERE codigo_barras=?""", (codigo,)).fetchone()
    if not p:
        return jsonify({'error': 'Producto no encontrado', 'codigo': codigo}), 404
    return jsonify(dict(p))



# Tipos de medida y unidades permitidas para el formulario
@app.route('/api/tipos-medida', methods=['GET'])
def tipos_medida():
    return jsonify({
        'tipos': [{'id': k, 'label': TIPOS_MEDIDA_LABEL[k], 'unidades': v}
                  for k, v in UNIDADES_POR_TIPO.items()]
    })

# Categorías existentes (para filtros y autocompletado)
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
    filtro, params = '', []
    if fi: filtro += " AND DATE(fecha)>=?"; params.append(fi)
    if ff: filtro += " AND DATE(fecha)<=?"; params.append(ff)
    rows = db.execute(
        f"""SELECT v.*, p.nombre AS producto_nombre, p.imagen_url, p.unidad AS unidad
            FROM ventas v JOIN productos p ON v.producto_id=p.id
            WHERE v.venta_grupo_id IN (SELECT DISTINCT venta_grupo_id FROM ventas WHERE 1=1{filtro})
            ORDER BY v.venta_grupo_id DESC, v.id ASC""", params).fetchall()
    pagos_rows = db.execute(
        f"""SELECT pv.*, m.nombre AS metodo_nombre FROM pagos_venta pv
            LEFT JOIN metodos_pago m ON pv.metodo_pago_id=m.id
            WHERE pv.venta_grupo_id IN (SELECT DISTINCT venta_grupo_id FROM ventas WHERE 1=1{filtro})
            ORDER BY pv.venta_grupo_id, pv.id""", params).fetchall()

    grupos = {}
    for r in rows:
        gid = r['venta_grupo_id']
        if gid not in grupos:
            grupos[gid] = {'venta_grupo_id': gid, 'fecha': r['fecha'], 'notas': r['notas'],
                           'metodo_pago_id': r['metodo_pago_id'], 'metodo_pago_nombre': 'Sin especificar',
                           'pago_referencia': r['pago_referencia'], 'tasa_bs': r['tasa_bs'],
                           'pagos': [], 'items': [], 'total': 0, 'ganancia': 0}
        grupos[gid]['items'].append({
            'id': r['id'], 'producto_id': r['producto_id'], 'producto_nombre': r['producto_nombre'],
            'imagen_url': r['imagen_url'], 'unidad': r['unidad'], 'cantidad': r['cantidad'],
            'precio_unitario': r['precio_unitario'], 'total': r['total'], 'ganancia': r['ganancia'],
        })
        grupos[gid]['total'] += r['total'] or 0
        grupos[gid]['ganancia'] += r['ganancia'] or 0

    # Pagos de cada factura (puede haber varios: pago mixto)
    for pr in pagos_rows:
        g_ = grupos.get(pr['venta_grupo_id'])
        if g_ is not None:
            g_['pagos'].append({
                'id': pr['id'], 'metodo_pago_id': pr['metodo_pago_id'],
                'metodo_pago_nombre': pr['metodo_nombre'] or 'Sin especificar', 'moneda': pr['moneda'],
                'monto_usd': pr['monto_usd'], 'monto_moneda': pr['monto_moneda'],
                'tasa': pr['tasa'], 'referencia': pr['referencia'] or ''})
    for g_ in grupos.values():
        g_['total'] = _dinero(g_['total'])
        g_['ganancia'] = _dinero(g_['ganancia'])
        if g_['pagos']:
            g_['metodo_pago_id'] = g_['pagos'][0]['metodo_pago_id']
            g_['metodo_pago_nombre'] = ' + '.join(p['metodo_pago_nombre'] for p in g_['pagos'])
            g_['pago_referencia'] = ' / '.join(p['referencia'] for p in g_['pagos'] if p['referencia'])
    return jsonify(list(grupos.values()))


def _siguiente_factura(db):
    """Número de la nueva factura. La fila del contador queda bloqueada hasta el commit,
    así dos cajas que cobren a la vez nunca reciben el mismo número."""
    fila = db.execute("SELECT valor FROM configuracion WHERE clave='seq_venta_grupo' FOR UPDATE").fetchone()
    if fila is None:
        mx = db.execute("SELECT COALESCE(MAX(venta_grupo_id), 0) FROM ventas").fetchone()[0]
        nuevo = int(mx or 0) + 1
        db.execute("INSERT INTO configuracion (clave, valor) VALUES ('seq_venta_grupo', ?)", (str(nuevo),))
    else:
        nuevo = int(_to_float(fila['valor'])) + 1
        db.execute("UPDATE configuracion SET valor=? WHERE clave='seq_venta_grupo'", (str(nuevo),))
    return nuevo


def _normalizar_pagos(db, data):
    """Valida los pagos recibidos. Devuelve (lista_de_pagos, mensaje_de_error)."""
    pagos_in = data.get('pagos')
    if not pagos_in:
        metodo_pago_id = data.get('metodo_pago_id')
        if not metodo_pago_id:
            return None, 'Selecciona un método de pago'
        pagos_in = [{
            'metodo_pago_id': metodo_pago_id,
            'pago_referencia': str(data.get('pago_referencia') or '').strip(),
            'pago_moneda': str(data.get('pago_moneda') or '').strip().upper(),
            'pago_monto': data.get('pago_monto') or 0,
        }]
    if not isinstance(pagos_in, list) or not all(isinstance(p, dict) for p in pagos_in):
        return None, 'Pagos inválidos'
    if len(pagos_in) > 10:
        return None, 'Demasiados pagos en una sola factura'

    pagos = []
    usadas = set()   # (método, referencia) ya escritos en esta misma factura
    for p in pagos_in:
        mid = _to_int(p.get('metodo_pago_id'))
        metodo = db.execute("SELECT * FROM metodos_pago WHERE id=? AND activo=1", (mid,)).fetchone()
        if not metodo:
            return None, 'Método de pago inválido'
        nom = (metodo['nombre'] or '').strip().lower()
        ref = str(p.get('pago_referencia') or p.get('referencia') or '').strip()[:100]
        moneda = str(p.get('pago_moneda') or p.get('moneda') or '').strip().upper()
        if moneda == 'VES':
            moneda = 'BS'
        monto = _to_float(p.get('pago_monto') or p.get('monto'))
        ingresado = _to_float(p.get('pago_monto_ingresado'))
        if monto < 0 or ingresado < 0:
            return None, 'Monto de pago inválido: no puede ser negativo'
        if monto > 10_000_000 or ingresado > 1_000_000_000:
            return None, 'Monto de pago demasiado grande: revisa el número'
        if metodo['requiere_datos_moviles'] or 'móvil' in nom or 'movil' in nom:
            if not ref:
                return None, f'Para {metodo["nombre"]} falta la referencia del cliente'
            # Un pago móvil tiene una referencia única: si ya se usó, es un error o un intento de cobrar dos veces
            previo = db.execute("SELECT venta_grupo_id FROM pagos_venta WHERE metodo_pago_id=? AND referencia=? LIMIT 1", (mid, ref)).fetchone()
            if previo:
                return None, f'La referencia {ref} de {metodo["nombre"]} ya fue registrada en la factura #{previo["venta_grupo_id"]}. Verifica el número.'
        elif 'efectivo' in nom:
            if moneda not in ('USD', 'BS'):
                return None, 'En Efectivo indica Dólares (USD) o Bolívares (Bs)'
        elif 'punto' in nom or 'biopago' in nom or 'bio pago' in nom:
            if monto <= 0:
                return None, f'Para {metodo["nombre"]} indica el monto cobrado'
            if not ref:
                return None, f'Para {metodo["nombre"]} falta la referencia / aprobación'
        if moneda not in ('USD', 'BS'):
            moneda = 'USD'
        if ref:
            if (mid, ref.lower()) in usadas:
                return None, f'La referencia {ref} está repetida en esta factura'
            usadas.add((mid, ref.lower()))
        pagos.append({'metodo_pago_id': mid, 'nombre': metodo['nombre'], 'referencia': ref,
                      'moneda': moneda, 'monto': monto, 'ingresado': ingresado})
    return pagos, None


@app.route('/api/ventas', methods=['POST'])
def registrar_venta():
    """Abierto para Facturación (no requiere admin). Valida TODO (stock, precios y pagos)
    antes de escribir nada (todo o nada). El precio de cada producto sale siempre de la base
    de datos; el navegador solo indica qué producto y cuánta cantidad."""
    db = get_db()
    try:
        data = _body()
        items = data.get('items')
        notas = str(data.get('notas') or '')[:500]
        if not isinstance(items, list) or not items:
            return jsonify({'error': 'Sin productos'}), 400

        # Valida cada pago según su método (referencia, moneda y monto)
        pagos_ok, error = _normalizar_pagos(db, data)
        if error:
            return jsonify({'error': error}), 400

        # Líneas de venta validadas: (producto_id, cantidad)
        lineas = []
        for item in items:
            if not isinstance(item, dict):
                return jsonify({'error': 'Producto inválido'}), 400
            pid = _to_int(item.get('producto_id'))
            cantidad = _to_float(item.get('cantidad', 1))
            if pid <= 0 or cantidad <= 0:
                return jsonify({'error': 'Cantidad inválida'}), 400
            if cantidad > 1_000_000:
                return jsonify({'error': 'Cantidad demasiado grande: revisa el número'}), 400
            lineas.append((pid, cantidad))
        cantidades_por_producto = {}
        for pid, cantidad in lineas:
            cantidades_por_producto[pid] = cantidades_por_producto.get(pid, 0) + cantidad

        # Bloquea las filas de los productos (así dos cajas no venden el mismo stock a la vez)
        ids = sorted(cantidades_por_producto)
        marcas = ','.join('?' * len(ids))
        productos_info = {f['id']: f for f in db.execute(
            f"SELECT * FROM productos WHERE id IN ({marcas}) ORDER BY id FOR UPDATE", ids).fetchall()}
        for pid, cantidad_total in cantidades_por_producto.items():
            prod = productos_info.get(pid)
            if not prod:
                return jsonify({'error': f'Producto #{pid} no encontrado'}), 404
            if (prod['precio_venta'] or 0) <= 0:
                return jsonify({'error': f'{PREFIJO_MAL_PRODUCTO}"{prod["nombre"]}" tiene el precio en $0. Corrígelo en Inventario antes de venderlo.'}), 400
            if _es_por_unidad(prod) and abs(cantidad_total - round(cantidad_total)) > 1e-9:
                return jsonify({'error': f'"{prod["nombre"]}" se vende por unidad: la cantidad debe ser un número entero (sin decimales)'}), 400
            if prod['stock'] + 1e-9 < cantidad_total:
                return jsonify({
                    'error': f'Sin stock suficiente de "{prod["nombre"]}" (disponible: {prod["stock"]:g}, solicitado: {cantidad_total:g})'
                }), 400

        # Total de la venta: suma de líneas redondeadas a centavos, con precios de la base de datos
        detalle = [(pid, cantidad, _subtotal(productos_info[pid]['precio_venta'], cantidad)) for pid, cantidad in lineas]
        total = _dinero(sum(d[2] for d in detalle))

        # Los pagos deben cubrir exactamente el total (el centavo de redondeo se absorbe en el último)
        tasa = tasa_vigente()
        if len(pagos_ok) == 1:
            p = pagos_ok[0]
            if p['monto'] > 0 and abs(p['monto'] - total) > TOLERANCIA_PAGO:
                return jsonify({'error': f'El pago (${p["monto"]:.2f}) no coincide con el total de la venta (${total:.2f})'}), 400
            p['monto'] = total
        else:
            if any(p['monto'] <= 0 for p in pagos_ok):
                return jsonify({'error': 'En pago mixto cada pago debe tener su monto'}), 400
            suma = _dinero(sum(p['monto'] for p in pagos_ok))
            if abs(suma - total) > TOLERANCIA_PAGO:
                return jsonify({
                    'error': f'La suma de los pagos (${suma:.2f}) no coincide con el total de la venta (${total:.2f})'
                }), 400
            pagos_ok[-1]['monto'] = _dinero(pagos_ok[-1]['monto'] + (total - suma))
        for p in pagos_ok:
            p['monto'] = _dinero(p['monto'])
            if p['moneda'] == 'BS':
                if not tasa:
                    return jsonify({'error': 'No hay tasa del dólar. Defínela para cobrar en bolívares'}), 400
                esperado = p['monto'] * tasa
                if p['ingresado'] > 0 and abs(p['ingresado'] - esperado) > TOLERANCIA_PAGO * tasa + 0.01:
                    return jsonify({'error': f'El monto en bolívares (Bs {p["ingresado"]:,.2f}) no corresponde a ${p["monto"]:.2f} con la tasa {tasa:g}'}), 400
                p['monto_moneda'] = p['ingresado'] if p['ingresado'] > 0 else _dinero(Decimal(str(p['monto'])) * Decimal(str(tasa)))
            else:
                p['monto_moneda'] = p['monto']
            p['tasa'] = tasa

        grupo_id = _siguiente_factura(db)
        fecha = datetime.now().isoformat(timespec='seconds')
        p0 = pagos_ok[0]
        # Guarda una fila por producto vendido y descuenta el inventario
        for pid, cantidad, subtotal in detalle:
            prod = productos_info[pid]
            db.execute(
                """INSERT INTO ventas (producto_id,cantidad,precio_unitario,total,ganancia,notas,fecha,
                   venta_grupo_id,metodo_pago_id,pago_referencia,pago_moneda,pago_monto,tasa_bs)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (pid, cantidad, prod['precio_venta'], subtotal, _margen(prod['precio_venta'], prod['precio_compra'], cantidad),
                 notas, fecha, grupo_id, p0['metodo_pago_id'], p0['referencia'], p0['moneda'], p0['monto'], tasa))
            db.execute("UPDATE productos SET stock=ROUND(stock-?, 3) WHERE id=?", (cantidad, pid))
        # Un registro por cada pago de la factura
        for p in pagos_ok:
            db.execute(
                """INSERT INTO pagos_venta (venta_grupo_id,metodo_pago_id,moneda,monto_usd,monto_moneda,tasa,referencia)
                   VALUES (?,?,?,?,?,?,?)""",
                (grupo_id, p['metodo_pago_id'], p['moneda'], p['monto'], p['monto_moneda'], p['tasa'], p['referencia']))

        db.commit()
        nombres = ' + '.join(p['nombre'] for p in pagos_ok)
        return jsonify({'ok': True, 'venta_grupo_id': grupo_id, 'total': total, 'tasa_bs': tasa,
                        'metodo_pago_nombre': nombres, 'pagos': pagos_ok}), 201
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error registrar venta: {e}')
        return jsonify({'error': 'No se pudo registrar la venta. Ningún producto fue descontado.'}), 500


# Edita cantidades y precios de una factura y ajusta el stock
@app.route('/api/ventas/grupo/<int:gid>', methods=['PUT'])
@admin_required
def editar_venta_grupo(gid):
    db = get_db()
    try:
        data = _body()
        eliminar_ids = {_to_int(v) for v in data['eliminar_ids']} if isinstance(data.get('eliminar_ids'), list) else set()
        items = data.get('items') if isinstance(data.get('items'), list) else []
        nuevo_metodo = _to_int(data.get('metodo_pago_id'))

        filas = db.execute("SELECT * FROM ventas WHERE venta_grupo_id=? ORDER BY id", (gid,)).fetchall()
        if not filas:
            return jsonify({'error': 'Venta no encontrada'}), 404
        pagos = db.execute("SELECT * FROM pagos_venta WHERE venta_grupo_id=? ORDER BY id", (gid,)).fetchall()
        por_id = {f['id']: f for f in filas}
        total_antes = _dinero(sum(f['total'] for f in filas))

        # 1) Validar todo antes de escribir (todo o nada)
        cambios = []   # (fila_venta, producto, nueva_cantidad, nuevo_precio)
        for item in items:
            if not isinstance(item, dict):
                continue
            row = por_id.get(_to_int(item.get('id')))
            if not row or row['id'] in eliminar_ids:
                continue
            prod = db.execute("SELECT * FROM productos WHERE id=? FOR UPDATE", (row['producto_id'],)).fetchone()
            nueva_cant = _to_float(item.get('cantidad'), row['cantidad'])
            nuevo_prec = _to_float(item.get('precio_unitario'), row['precio_unitario'])
            if nueva_cant <= 0 or nuevo_prec < 0:
                return jsonify({'error': 'Cantidad o precio inválido'}), 400
            extra = nueva_cant - row['cantidad']
            if extra > 1e-9 and prod['stock'] + 1e-9 < extra:
                return jsonify({'error': f'Stock insuficiente para {prod["nombre"]}'}), 400
            cambios.append((row, prod, nueva_cant, nuevo_prec))
        nuevos_totales = {c[0]['id']: _subtotal(c[3], c[2]) for c in cambios}
        total_despues = _dinero(sum(nuevos_totales.get(f['id'], f['total']) for f in filas if f['id'] not in eliminar_ids))

        if len(pagos) > 1 and abs(total_despues - total_antes) > 0.005:
            return jsonify({'error': 'Esta factura se pagó con varios métodos. Si cambia el total, anúlala y factura de nuevo.'}), 400
        if nuevo_metodo:
            if not db.execute("SELECT id FROM metodos_pago WHERE id=?", (nuevo_metodo,)).fetchone():
                return jsonify({'error': 'Método de pago inválido'}), 400
            if len(pagos) > 1 and nuevo_metodo != pagos[0]['metodo_pago_id']:
                return jsonify({'error': 'Esta factura tiene pago mixto: no se puede cambiar el método de pago'}), 400

        # 2) Líneas eliminadas: se devuelve su stock
        for vid in eliminar_ids:
            row = por_id.get(vid)
            if row:
                db.execute("UPDATE productos SET stock=ROUND(stock+?, 3) WHERE id=?", (float(row['cantidad']), row['producto_id']))
                db.execute("DELETE FROM ventas WHERE id=?", (vid,))

        # 3) Líneas modificadas: se ajusta el stock por la diferencia
        for row, prod, nueva_cant, nuevo_prec in cambios:
            diff = nueva_cant - row['cantidad']
            db.execute("UPDATE ventas SET cantidad=?,precio_unitario=?,total=?,ganancia=? WHERE id=?",
                       (nueva_cant, nuevo_prec, _subtotal(nuevo_prec, nueva_cant),
                        _margen(nuevo_prec, prod['precio_compra'], nueva_cant), row['id']))
            db.execute("UPDATE productos SET stock=ROUND(stock-?, 3) WHERE id=?", (diff, row['producto_id']))

        # 4) Pagos: si la factura tiene un solo pago, se ajusta al nuevo total / método / referencia
        quedan = db.execute("SELECT COUNT(*) FROM ventas WHERE venta_grupo_id=?", (gid,)).fetchone()[0]
        if quedan == 0:
            db.execute("DELETE FROM pagos_venta WHERE venta_grupo_id=?", (gid,))
        else:
            total_final = _dinero(db.execute("SELECT SUM(total) FROM ventas WHERE venta_grupo_id=?", (gid,)).fetchone()[0])
            ref_nueva = str(data.get('pago_referencia') or '')[:100] if 'pago_referencia' in data else None
            if len(pagos) == 1:
                p = pagos[0]
                moneda_monto = (_dinero(Decimal(str(total_final)) * Decimal(str(p['tasa']))) if p['moneda'] == 'BS' and p['tasa']
                                else (total_final if p['moneda'] == 'USD' else None))
                db.execute("UPDATE pagos_venta SET monto_usd=?, monto_moneda=?, metodo_pago_id=?, referencia=? WHERE id=?",
                           (total_final, moneda_monto, nuevo_metodo or p['metodo_pago_id'],
                            p['referencia'] if ref_nueva is None else ref_nueva, p['id']))
                db.execute("UPDATE ventas SET pago_monto=?, metodo_pago_id=?, pago_referencia=? WHERE venta_grupo_id=?",
                           (total_final, nuevo_metodo or p['metodo_pago_id'],
                            p['referencia'] if ref_nueva is None else ref_nueva, gid))
            elif not pagos:
                if nuevo_metodo:
                    db.execute("UPDATE ventas SET metodo_pago_id=? WHERE venta_grupo_id=?", (nuevo_metodo, gid))
                if ref_nueva is not None:
                    db.execute("UPDATE ventas SET pago_referencia=? WHERE venta_grupo_id=?", (ref_nueva, gid))

        db.commit()
        return jsonify({'ok': True})
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error editar venta: {e}')
        return jsonify({'error': 'No se pudo actualizar la venta. No se aplicó ningún cambio.'}), 500


# Anula una factura y devuelve los productos al inventario
@app.route('/api/ventas/grupo/<int:gid>', methods=['DELETE'])
@admin_required
def eliminar_venta_grupo(gid):
    db = get_db()
    try:
        rows = db.execute("SELECT * FROM ventas WHERE venta_grupo_id=? ORDER BY id", (gid,)).fetchall()
        if not rows:
            return jsonify({'error': 'Venta no encontrada'}), 404
        for r in rows:
            db.execute("UPDATE productos SET stock=ROUND(stock+?, 3) WHERE id=?", (float(r['cantidad']), r['producto_id']))
        db.execute("DELETE FROM ventas WHERE venta_grupo_id=?", (gid,))
        db.execute("DELETE FROM pagos_venta WHERE venta_grupo_id=?", (gid,))
        db.commit()
        return jsonify({'ok': True})
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error eliminar venta: {e}')
        return jsonify({'error': 'No se pudo eliminar la venta'}), 500


# ── FACTURAS EN PAUSA (Facturación; no requiere admin) ──────────
MAX_PAUSADAS = 30   # límite de facturas guardadas a la vez


def _limpiar_items_pausa(db, items):
    """Valida y junta (por producto) los items de una factura en pausa. Devuelve (lista, error)."""
    if not isinstance(items, list) or not items:
        return None, 'La factura está vacía'
    juntos = {}
    for it in items:
        if not isinstance(it, dict):
            return None, 'Producto inválido'
        pid = _to_int(it.get('producto_id'))
        cantidad = _to_float(it.get('cantidad'))
        if pid <= 0 or cantidad <= 0:
            return None, 'Cantidad inválida'
        juntos[pid] = juntos.get(pid, 0) + cantidad
    limpia = []
    for pid, cantidad in juntos.items():
        prod = db.execute("SELECT id, nombre FROM productos WHERE id=?", (pid,)).fetchone()
        if not prod:
            return None, f'Producto #{pid} no encontrado'
        limpia.append({'producto_id': pid, 'cantidad': round(cantidad, 3), 'nombre': prod['nombre']})
    return limpia, None


@app.route('/api/facturas-pausadas', methods=['GET'])
def listar_facturas_pausadas():
    """Lista las facturas en pausa con su total calculado a los precios de hoy."""
    db = get_db()
    filas = db.execute("SELECT id, nombre, notas, items_json, fecha_creacion FROM facturas_pausadas ORDER BY id").fetchall()
    listas = {}
    for f in filas:
        try:
            listas[f['id']] = json.loads(f['items_json'])
        except (ValueError, TypeError):
            listas[f['id']] = []
    ids = sorted({it['producto_id'] for its in listas.values() for it in its if isinstance(it, dict) and 'producto_id' in it})
    precios = {}
    if ids:
        marcas = ','.join('?' * len(ids))
        precios = {p['id']: p['precio_venta'] for p in db.execute(
            f"SELECT id, precio_venta FROM productos WHERE id IN ({marcas})", ids).fetchall()}
    salida = []
    for f in filas:
        its = [it for it in listas[f['id']] if isinstance(it, dict)]
        total = _dinero(sum(_subtotal(precios[it['producto_id']], it['cantidad']) for it in its if it.get('producto_id') in precios))
        salida.append({'id': f['id'], 'nombre': f['nombre'], 'notas': f['notas'], 'fecha': f['fecha_creacion'],
                       'num_items': len(its), 'total': total})
    return jsonify(salida)


@app.route('/api/facturas-pausadas', methods=['POST'])
def pausar_factura():
    """Guarda el carrito actual como factura en pausa para retomarlo después."""
    db = get_db()
    try:
        data = _body()
        items, error = _limpiar_items_pausa(db, data.get('items'))
        if error:
            return jsonify({'error': error}), 400
        if db.execute("SELECT COUNT(*) FROM facturas_pausadas").fetchone()[0] >= MAX_PAUSADAS:
            return jsonify({'error': f'Hay demasiadas facturas en pausa (máximo {MAX_PAUSADAS}). Retoma o elimina alguna.'}), 400
        nombre = str(data.get('nombre') or '').strip()[:100] or 'Factura en pausa'
        notas = str(data.get('notas') or '')[:500]
        cur = db.execute("INSERT INTO facturas_pausadas (nombre, notas, items_json, fecha_creacion) VALUES (?,?,?,?)",
                         (nombre, notas, json.dumps(items, ensure_ascii=False), datetime.now().isoformat(timespec='seconds')))
        db.commit()
        return jsonify({'ok': True, 'id': cur.lastrowid, 'nombre': nombre}), 201
    except Exception as e:
        db.rollback()
        app.logger.error(f'Error pausar factura: {e}')
        return jsonify({'error': 'No se pudo pausar la factura'}), 500


@app.route('/api/facturas-pausadas/<int:pid>', methods=['GET'])
def detalle_factura_pausada(pid):
    """Devuelve la factura en pausa con precios y stock ACTUALES, ajustando lo que ya no se pueda vender."""
    db = get_db()
    fila = db.execute("SELECT * FROM facturas_pausadas WHERE id=?", (pid,)).fetchone()
    if not fila:
        return jsonify({'error': 'La factura en pausa ya no existe'}), 404
    try:
        guardados = json.loads(fila['items_json'])
    except (ValueError, TypeError):
        guardados = []
    items, avisos = [], []
    for it in guardados:
        nombre = it.get('nombre') or f"Producto #{it.get('producto_id')}"
        prod = db.execute("SELECT id,nombre,precio_venta,stock,unidad,imagen_url FROM productos WHERE id=?",
                          (_to_int(it.get('producto_id')),)).fetchone()
        if not prod:
            avisos.append(f'"{nombre}" ya no existe y se quitó de la factura')
            continue
        cantidad = _to_float(it.get('cantidad'))
        if prod['stock'] <= 0:
            avisos.append(f'"{prod["nombre"]}" no tiene stock y se quitó de la factura')
            continue
        if cantidad > prod['stock'] + 1e-9:
            avisos.append(f'"{prod["nombre"]}": solo quedan {prod["stock"]:g}, se ajustó la cantidad')
            cantidad = prod['stock']
        items.append({'producto_id': prod['id'], 'nombre': prod['nombre'], 'imagen_url': prod['imagen_url'],
                      'cantidad': cantidad, 'precio_unitario': prod['precio_venta'],
                      'stock_disp': prod['stock'], 'unidad': prod['unidad']})
    return jsonify({'id': fila['id'], 'nombre': fila['nombre'], 'notas': fila['notas'], 'items': items, 'avisos': avisos})


@app.route('/api/facturas-pausadas/<int:pid>', methods=['DELETE'])
def eliminar_factura_pausada(pid):
    """Borra una factura en pausa (al retomarla o descartarla)."""
    db = get_db()
    db.execute("DELETE FROM facturas_pausadas WHERE id=?", (pid,))
    db.commit()
    return jsonify({'ok': True})


# ── DASHBOARD (admin) ─────────────────────────────────────────
@app.route('/api/dashboard', methods=['GET'])
@admin_required
def dashboard():
    db = get_db()
    hoy = date.today()
    hoy_s = hoy.isoformat()
    inicio_mes = hoy.replace(day=1).isoformat()
    hace_7 = (hoy - timedelta(days=6)).isoformat()
    # Totales de inventario
    tp = db.execute("SELECT COUNT(*) FROM productos").fetchone()[0]
    sb = db.execute("SELECT COUNT(*) FROM productos WHERE stock<=stock_minimo").fetchone()[0]
    so = db.execute("SELECT COUNT(*) FROM productos WHERE stock_maximo > 0 AND stock >= stock_maximo").fetchone()[0]
    vi = db.execute("SELECT SUM(stock*precio_compra) FROM productos").fetchone()[0] or 0
    # Ventas de hoy
    vh = db.execute("SELECT COUNT(DISTINCT venta_grupo_id),SUM(total),SUM(ganancia) FROM ventas WHERE DATE(fecha)=?", (hoy_s,)).fetchone()
    # Ventas del mes en curso
    vm = db.execute("SELECT COUNT(DISTINCT venta_grupo_id),SUM(total),SUM(ganancia) FROM ventas WHERE DATE(fecha)>=? AND DATE(fecha)<=?", (inicio_mes, hoy_s)).fetchone()
    # 5 productos más vendidos
    top = db.execute("SELECT p.nombre,p.imagen_url,SUM(v.cantidad) as tv,SUM(v.total) as ing FROM ventas v JOIN productos p ON v.producto_id=p.id GROUP BY p.id, p.nombre, p.imagen_url ORDER BY tv DESC LIMIT 5").fetchall()
    # Ventas de los últimos 7 días
    v7 = db.execute("SELECT DATE(fecha) as dia,SUM(total) as total,SUM(ganancia) as ganancia FROM ventas WHERE DATE(fecha)>=? GROUP BY DATE(fecha) ORDER BY dia", (hace_7,))
    # Stock por categoría
    cats = db.execute("SELECT categoria,SUM(stock) as ts,COUNT(*) as np FROM productos GROUP BY categoria").fetchall()
    # Ventas del mes por método de pago (cada pago de una factura mixta cuenta en su método)
    metodos = db.execute("""SELECT m.nombre, COUNT(DISTINCT pv.venta_grupo_id) as n, SUM(pv.monto_usd) as t
                            FROM pagos_venta pv
                            JOIN (SELECT venta_grupo_id, MIN(fecha) AS fecha FROM ventas GROUP BY venta_grupo_id) f
                              ON f.venta_grupo_id=pv.venta_grupo_id
                            JOIN metodos_pago m ON pv.metodo_pago_id=m.id
                            WHERE DATE(f.fecha)>=? AND DATE(f.fecha)<=?
                            GROUP BY m.id, m.nombre ORDER BY t DESC""", (inicio_mes, hoy_s)).fetchall()
    return jsonify({
        'total_productos': tp, 'stock_bajo': sb, 'stock_exceso': so, 'valor_inventario': _dinero(vi),
        'ventas_hoy': {'cantidad': vh[0] or 0, 'total': _dinero(vh[1] or 0), 'ganancia': _dinero(vh[2] or 0)},
        'ventas_mes': {'cantidad': vm[0] or 0, 'total': _dinero(vm[1] or 0), 'ganancia': _dinero(vm[2] or 0)},
        'top_productos': [dict(p) for p in top],
        'ventas_7dias': [dict(v) for v in v7],
        'categorias_stock': [dict(c) for c in cats],
        'metodos_pago_mes': [dict(m) for m in metodos],
    })


# ── HELPERS COMPARTIDOS PARA REPORTES ──────────────────────────
def _datos_reporte(db, fi, ff, tasa=0):
    """Consulta los datos comunes de los reportes. Los montos en Bs usan la tasa de cada venta
    (si la venta no la guardó, la tasa actual)."""
    tasa = tasa or 0
    # Totales de inventario
    tp2 = db.execute("SELECT COUNT(*) FROM productos").fetchone()[0]
    vi2 = db.execute("SELECT SUM(stock*precio_compra) FROM productos").fetchone()[0] or 0
    sb2 = db.execute("SELECT COUNT(*) FROM productos WHERE stock<=stock_minimo").fetchone()[0]

    def filtro(col):
        sql, par = '', []
        if fi: sql += f" AND DATE({col})>=?"; par.append(fi)
        if ff: sql += f" AND DATE({col})<=?"; par.append(ff)
        return sql, par

    # Totales de ventas del período
    f, pf = filtro('fecha')
    rv = db.execute("SELECT COUNT(DISTINCT venta_grupo_id),SUM(total),SUM(ganancia),SUM(total*COALESCE(tasa_bs,?)) "
                    "FROM ventas WHERE 1=1" + f, [tasa] + pf).fetchone()

    # Top 10 de productos del período
    f, pf = filtro('v.fecha')
    top = db.execute("""SELECT p.nombre,p.categoria,SUM(v.cantidad) as c,SUM(v.total) as t,SUM(v.ganancia) as g,
                        SUM(v.total*COALESCE(v.tasa_bs,?)) as tbs
                        FROM ventas v JOIN productos p ON v.producto_id=p.id WHERE 1=1""" + f +
                     " GROUP BY p.id, p.nombre, p.categoria ORDER BY c DESC LIMIT 10", [tasa] + pf).fetchall()

    # Ventas agrupadas por día
    f, pf = filtro('fecha')
    por_dia = db.execute("SELECT DATE(fecha) as d,COUNT(DISTINCT venta_grupo_id) as n,SUM(cantidad) as u,SUM(total) as t,"
                         "SUM(ganancia) as g,SUM(total*COALESCE(tasa_bs,?)) as tbs FROM ventas WHERE 1=1" + f +
                         " GROUP BY DATE(fecha) ORDER BY d DESC", [tasa] + pf).fetchall()

    # Ventas agrupadas por método de pago (cada pago de una factura mixta cuenta en su método)
    f, pf = filtro('f.fecha')
    metodos = db.execute("""SELECT m.nombre, COUNT(DISTINCT pv.venta_grupo_id) as n, SUM(pv.monto_usd) as t,
                            SUM(pv.monto_usd*COALESCE(pv.tasa,?)) as tbs
                            FROM pagos_venta pv
                            JOIN (SELECT venta_grupo_id, MIN(fecha) AS fecha FROM ventas GROUP BY venta_grupo_id) f
                              ON f.venta_grupo_id=pv.venta_grupo_id
                            JOIN metodos_pago m ON pv.metodo_pago_id=m.id WHERE 1=1""" + f +
                          " GROUP BY m.id, m.nombre ORDER BY t DESC", [tasa] + pf).fetchall()

    return {
        'total_productos': tp2, 'valor_inventario': vi2, 'stock_bajo': sb2,
        'num_ventas': rv[0] or 0, 'ingresos': rv[1] or 0, 'ganancia': rv[2] or 0, 'ingresos_bs': rv[3] or 0,
        'top': top, 'por_dia': por_dia, 'metodos': metodos,
    }


def _textos_de_pago(db, fi, ff):
    """Por factura: ('Efectivo + Pago Móvil', 'ref1 / ref2') para el detalle de ventas de los reportes."""
    filtro, par = '', []
    if fi: filtro += " AND DATE(fecha)>=?"; par.append(fi)
    if ff: filtro += " AND DATE(fecha)<=?"; par.append(ff)
    filas = db.execute(f"""SELECT pv.venta_grupo_id AS gid, m.nombre AS metodo, pv.referencia AS ref
                           FROM pagos_venta pv LEFT JOIN metodos_pago m ON pv.metodo_pago_id=m.id
                           WHERE pv.venta_grupo_id IN (SELECT DISTINCT venta_grupo_id FROM ventas WHERE 1=1{filtro})
                           ORDER BY pv.venta_grupo_id, pv.id""", par).fetchall()
    nombres, refs = {}, {}
    for r in filas:
        nombres.setdefault(r['gid'], []).append(r['metodo'] or 'Sin especificar')
        if r['ref']:
            refs.setdefault(r['gid'], []).append(r['ref'])
    return ({g: ' + '.join(n) for g, n in nombres.items()}, {g: ' / '.join(r) for g, r in refs.items()})


# ── EXPORTAR EXCEL (admin) ────────────────────────────────────
@app.route('/api/exportar-excel', methods=['POST'])
@admin_required
def exportar_excel():
    db = get_db()
    data = _body()
    fi = str(data.get('fecha_inicio') or '')
    ff = str(data.get('fecha_fin') or '')
    tasa = obtener_tasa_dolar() or _to_float(data.get('tasa_manual')) or 0
    rep = _datos_reporte(db, fi, ff, tasa)

    # Libro de Excel y paleta de colores del reporte
    wb = openpyxl.Workbook()
    CP = '1A1A2E'; CS = '16213E'; CA = '0F3460'; VE = '2ECC71'; RO = 'E74C3C'; GC = 'F8F9FA'; BL = 'FFFFFF'
    borde = Border(bottom=Side(style='thin', color='DEE2E6'), right=Side(style='thin', color='DEE2E6'))

    # Celda de encabezado con estilo
    def hc(ws, r, c, v, bg=CP, fg='FFFFFF', sz=11, bold=True, align='center'):
        cell = ws.cell(row=r, column=c, value=v)
        cell.font = Font(name='Calibri', bold=bold, size=sz, color=fg)
        cell.fill = PatternFill("solid", fgColor=bg)
        cell.alignment = Alignment(horizontal=align, vertical='center', wrap_text=True)
        cell.border = borde
        return cell

    # Celda de datos con estilo
    def dc(ws, r, c, v, bg=BL, fg='2C3E50', bold=False, align='center', fmt=None):
        cell = ws.cell(row=r, column=c, value=v)
        cell.font = Font(name='Calibri', bold=bold, size=10, color=fg)
        cell.fill = PatternFill("solid", fgColor=bg)
        cell.alignment = Alignment(horizontal=align, vertical='center')
        cell.border = borde
        if fmt: cell.number_format = fmt
        return cell

    # Texto del período y de la tasa para el encabezado
    periodo = f"{fi}  →  {ff}" if fi else f"Completo — {date.today().strftime('%d/%m/%Y')}"
    tasa_txt = f"Tasa: 1 USD = {tasa:,.2f} Bs" if tasa else "Sin tasa"

    # Hoja 1: resumen ejecutivo (indicadores, métodos de pago y top 10)
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
          f"${ing:,.2f}", f"Bs {rep['ingresos_bs']:,.0f}" if rep['ingresos_bs'] else "—", f"${gan:,.2f}"]
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
        dc(ws1, fila_m, 4, f"Bs {(m['tbs'] or 0):,.0f}" if m['tbs'] else "—", bg=bg, fg="E67E22")
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
        dc(ws1, r, 6, f"Bs {(row['tbs'] or 0):,.0f}" if row['tbs'] else "—", bg=bg, fg="E67E22")
        dc(ws1, r, 7, row['g'], bg=bg, fmt='"$"#,##0.00', fg=VE if (row['g'] or 0) > 0 else RO, bold=True)
        ws1.row_dimensions[r].height = 20
        fila_top += 1
    for col, w in zip(range(1, 8), [6, 26, 14, 10, 13, 14, 13]):
        ws1.column_dimensions[get_column_letter(col)].width = w

    # Hoja 2: inventario actual con costos, precios y estado del stock
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
    qven = """SELECT v.*,p.nombre as pn FROM ventas v
              JOIN productos p ON v.producto_id=p.id WHERE 1=1"""
    pvl = []
    if fi: qven += " AND DATE(v.fecha)>=?"; pvl.append(fi)
    if ff: qven += " AND DATE(v.fecha)<=?"; pvl.append(ff)
    qven += " ORDER BY v.venta_grupo_id DESC, v.id ASC"
    ventas = db.execute(qven, pvl).fetchall()
    metodo_de, ref_de = _textos_de_pago(db, fi, ff)
    ti = tg = tbs_total = 0; fila = 3
    for v in ventas:
        bg = BL if v['venta_grupo_id'] % 2 == 0 else GC
        tbs = (v['total'] or 0) * (v['tasa_bs'] or tasa or 0)
        tbs_total += tbs
        dc(ws3, fila, 1, f"#{v['venta_grupo_id']}", bg=bg, bold=True)
        dc(ws3, fila, 2, v['fecha'][:10], bg=bg)
        dc(ws3, fila, 3, v['pn'], bg=bg, align='left', bold=True)
        dc(ws3, fila, 4, v['cantidad'], bg=bg)
        dc(ws3, fila, 5, v['precio_unitario'], bg=bg, fmt='"$"#,##0.00')
        dc(ws3, fila, 6, v['total'], bg=bg, fmt='"$"#,##0.00', bold=True)
        dc(ws3, fila, 7, f"Bs {tbs:,.0f}" if tbs else "—", bg=bg, fg="E67E22")
        g = v['ganancia'] or 0
        dc(ws3, fila, 8, g, bg=bg, fmt='"$"#,##0.00', fg=VE if g >= 0 else RO, bold=True)
        dc(ws3, fila, 9, metodo_de.get(v['venta_grupo_id']) or '—', bg=bg)
        dc(ws3, fila, 10, ref_de.get(v['venta_grupo_id'], ''), bg=bg, align='left')
        dc(ws3, fila, 11, v['notas'] or '', bg=bg, align='left')
        ti += v['total'] or 0; tg += g
        ws3.row_dimensions[fila].height = 20; fila += 1
    tr = fila
    ws3.merge_cells(f'A{tr}:E{tr}')
    hc(ws3, tr, 1, "TOTALES", bg=CP, sz=11, align='right')
    hc(ws3, tr, 6, f"${ti:,.2f}", bg=CP, sz=11)
    hc(ws3, tr, 7, f"Bs {tbs_total:,.0f}" if tbs_total else "—", bg="0A2848", sz=11)
    hc(ws3, tr, 8, f"${tg:,.2f}", bg="1A6B3C", sz=11)
    ws3.row_dimensions[tr].height = 28
    for col, w in zip(range(1, 12), [8, 13, 24, 7, 11, 11, 14, 11, 13, 16, 18]):
        ws3.column_dimensions[get_column_letter(col)].width = w

    # Hoja 4: totales por día
    ws4 = wb.create_sheet("Por Dia"); ws4.sheet_view.showGridLines = False
    ws4.merge_cells('A1:F1'); hc(ws4, 1, 1, "📅  VENTAS POR DÍA", bg=CP, sz=14); ws4.row_dimensions[1].height = 36
    for i, l in enumerate(["Fecha", "Nº Ventas", "Unidades", "Ingresos $", "Ingresos Bs", "Ganancia $"], 1):
        hc(ws4, 2, i, l, bg=CA, sz=10); ws4.row_dimensions[2].height = 26
    for idx, d in enumerate(rep['por_dia'], 1):
        r = 2 + idx; bg = BL if idx % 2 == 0 else GC
        ibs = d['tbs'] or 0
        dc(ws4, r, 1, d['d'], bg=bg, bold=True); dc(ws4, r, 2, d['n'], bg=bg); dc(ws4, r, 3, d['u'], bg=bg)
        dc(ws4, r, 4, d['t'], bg=bg, fmt='"$"#,##0.00', bold=True)
        dc(ws4, r, 5, f"Bs {ibs:,.0f}" if ibs else "—", bg=bg, fg="E67E22")
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
    data = _body()
    fi = str(data.get('fecha_inicio') or '')
    ff = str(data.get('fecha_fin') or '')
    tasa = obtener_tasa_dolar() or _to_float(data.get('tasa_manual')) or 0
    rep = _datos_reporte(db, fi, ff, tasa)

    # Colores del reporte PDF
    AZUL = rl_colors.HexColor('#1A1A2E')
    AZUL2 = rl_colors.HexColor('#0F3460')
    VERDE = rl_colors.HexColor('#1A6B3C')
    NARANJA = rl_colors.HexColor('#E67E22')
    GRIS = rl_colors.HexColor('#F8F9FA')

    buf = io.BytesIO()
    # Documento tamaño carta y estilos de texto
    doc = SimpleDocTemplate(buf, pagesize=rl_letter, topMargin=1.6*cm, bottomMargin=1.6*cm,
                            leftMargin=1.6*cm, rightMargin=1.6*cm)
    styles = getSampleStyleSheet()
    titulo_style = ParagraphStyle('titulo', parent=styles['Title'], fontSize=17, textColor=AZUL, spaceAfter=2)
    sub_style = ParagraphStyle('sub', parent=styles['Normal'], fontSize=9.5, textColor=rl_colors.HexColor('#555'), spaceAfter=14)
    seccion_style = ParagraphStyle('seccion', parent=styles['Heading2'], fontSize=12.5, textColor=AZUL2, spaceBefore=16, spaceAfter=8)
    nota_style = ParagraphStyle('nota', parent=styles['Normal'], fontSize=8.5, textColor=rl_colors.HexColor('#888'), spaceBefore=10)

    # Contenido del PDF: título, indicadores y tablas
    elementos = []
    elementos.append(Paragraph(NOMBRE_TIENDA, titulo_style))
    periodo = f"{fi} al {ff}" if fi else f"Reporte completo — {date.today().strftime('%d/%m/%Y')}"
    tasa_txt = f" &nbsp;|&nbsp; Tasa: 1 USD = {tasa:,.2f} Bs" if tasa else ""
    elementos.append(Paragraph(f"Reporte Ejecutivo &nbsp;·&nbsp; Período: {periodo}{tasa_txt}", sub_style))

    # Tabla de indicadores principales
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

    elementos.append(Paragraph("Ventas por Método de Pago", seccion_style))
    # Tabla de ventas por método de pago
    mp_data = [['Método', 'Nº Ventas', 'Total $', 'Total Bs']]
    for m in rep['metodos']:
        mp_data.append([m['nombre'], str(m['n']), f"${m['t']:,.2f}",
                        f"Bs {(m['tbs'] or 0):,.0f}" if m['tbs'] else "—"])
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

    elementos.append(Paragraph("Top 10 Productos Más Vendidos", seccion_style))
    # Tabla del top 10 de productos
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

    elementos.append(Paragraph("Ventas por Día", seccion_style))
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
        from datetime import timezone
        import ipaddress

        # Nombres válidos del certificado: localhost, 127.0.0.1 y la IP de la red
        alt_names = [x509.DNSName(u"localhost"), x509.IPAddress(ipaddress.IPv4Address("127.0.0.1"))]
        try:
            ip_lan = obtener_ip_local()
            if ip_lan != "127.0.0.1":
                alt_names.append(x509.IPAddress(ipaddress.IPv4Address(ip_lan)))
        except Exception:
            pass
        # Clave privada RSA de 2048 bits
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, u"DeToditoMarket"),
        ])
        # Certificado autofirmado válido por 10 años
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(days=3650))
            .add_extension(
                x509.SubjectAlternativeName(alt_names),
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
    # Crea o actualiza la base de datos al iniciar
    try:
        init_db()
    except pymysql.err.OperationalError as e:
        print("\n   ERROR: no se pudo conectar a MySQL.")
        print(f"   Detalle: {e}")
        print("   Revisa que MySQL esté encendido y que los datos de config.py (usuario, clave, base) sean correctos.\n")
        raise SystemExit(1)
    except Exception as e:
        print(f"\n   ERROR al preparar la base de datos: {e}\n")
        raise SystemExit(1)
    # Dirección para entrar desde el celular
    ip_local = obtener_ip_local()
    base_dir = os.path.dirname(os.path.abspath(__file__))
    # Archivos del certificado HTTPS (para la cámara del celular)
    cert = os.path.join(base_dir, 'cert.pem')
    key = os.path.join(base_dir, 'key.pem')

    # Si no hay certificado, lo crea solo (para la camara del celular)
    if not (os.path.isfile(cert) and os.path.isfile(key)):
        print("\n   Generando certificado HTTPS automaticamente...")
        _generar_certificado_https(cert, key)

    usar_https = os.path.isfile(cert) and os.path.isfile(key)
    if usar_https:
        # Si el certificado está dañado, se arranca en HTTP en lugar de fallar
        try:
            import ssl
            ssl.create_default_context(ssl.Purpose.CLIENT_AUTH).load_cert_chain(cert, key)
        except Exception as e:
            print(f"   (Certificado HTTPS inválido, se usará HTTP: {e})")
            usar_https = False
    proto = 'https' if usar_https else 'http'
    ssl_ctx = (cert, key) if usar_https else None

    print("\n" + "=" * 56)
    print(f"   {NOMBRE_TIENDA}")
    print("=" * 56)
    print(f"   En esta PC:                    {proto}://localhost:5000")
    print(f"   Desde el celular (misma WiFi):  {proto}://{ip_local}:5000")
    if usar_https:
        print("   HTTPS activo - camara del celular lista")
        print("   (En el celular: Avanzado > Continuar / Aceptar)")
    else:
        print("   Sin HTTPS (camara del celular no disponible)")
    print("=" * 56)
    print("   Primera vez: se te pedira crear la contraseña de admin")
    print("=" * 56 + "\n")
    # Escucha en toda la red local (0.0.0.0) para poder entrar desde otros equipos
    app.run(debug=False, port=5000, host='0.0.0.0', ssl_context=ssl_ctx)
