# DE TODITO MARKET MyF, C.A — Sistema de Inventario y Facturación

Versión lista para producción.

---

## ¿Dónde se guardan los datos?

Todos los datos (productos, stock, ventas, contraseña, métodos de pago, tasa del dólar) se guardan en **un solo archivo**:

```
inventario/instance/inventario.db
```

Es una base de datos **SQLite** (archivo local).

### Cómo revisar o respaldar tus datos

1. Cierra el programa.
2. Copia el archivo `instance/inventario.db` a un USB o a la nube (Google Drive, etc.).
3. Para restaurar: reemplaza ese archivo por tu copia.

También puedes abrir `inventario.db` con programas gratuitos como **DB Browser for SQLite** (https://sqlitebrowser.org) y ver tablas, exportar a Excel, etc.

### ¿Base de datos en la nube?

Para una sola tienda / una sola PC **es mejor dejarla local** (más simple, más rápida, sin costo mensual y funciona sin internet).

Solo conviene nube si:
- Varias personas van a usar el sistema desde sitios diferentes al mismo tiempo.
- Quieres acceso remoto permanente.

Si en el futuro lo necesitas, se puede migrar a PostgreSQL o MySQL en la nube.

---

## Cómo ejecutarlo (modo normal)

1. Instala Python 3.10 o superior.
2. Abre una terminal en la carpeta del proyecto.
3. Ejecuta:

```bash
pip install -r requirements.txt
python app.py
```

4. Abre en el navegador: **http://localhost:5000**

La primera vez te pedirá crear la contraseña de administrador (mínimo 8 caracteres, mayúscula, minúscula y número).

---

## Cómo crear un .exe (Windows)

En la misma PC con Windows:

```bash
pip install pyinstaller
pyinstaller --onefile --add-data "templates;templates" --add-data "static;static" --name "DeToditoMarket" app.py
```

El ejecutable quedará en la carpeta `dist/DeToditoMarket.exe`.

**Importante:**  
La base de datos se crea junto al .exe en una carpeta `instance`.  
Copia también las carpetas `templates` y `static` junto al .exe (o usa la opción `--add-data` como arriba).

Si tienes problemas con el .exe, es más estable ejecutarlo con `python app.py`.

---

## Stock Mínimo y Máximo

- **Stock Mínimo**: cuando el stock llega a este número o menos → aviso “Stock Bajo”.
- **Stock Máximo**: (opcional) cuando el stock llega a este número o más → aviso “Exceso”.  
  Si lo dejas en **0** = sin límite máximo.

---

## Estructura del proyecto

```
DeToditoMarket_Final/
├── app.py                 ← Programa principal
├── database.py            ← Definición de la base de datos
├── requirements.txt
├── README.md
├── instance/
│   └── inventario.db      ← AQUÍ se guardan TODOS tus datos
├── static/
│   ├── css/style.css
│   ├── js/app.js
│   └── uploads/           ← Fotos de productos
└── templates/
    └── index.html
```

---

## Notas importantes

- No subas la carpeta `.venv` ni `__pycache__`.
- Haz copias de seguridad de `instance/inventario.db` con frecuencia.
- El sistema está limpio (sin productos de ejemplo).
- Tipografía profesional: Inter + JetBrains Mono.


---

## Activar cámara del celular (HTTPS)

1. Ejecuta **generar_https.bat** (una sola vez).
2. Se crean los archivos  y .
3. Vuelve a abrir el programa con **ejecutar.bat**.
4. En el celular abre la dirección que muestra la pantalla (empieza con **https://**).
5. Acepta el aviso de "sitio no seguro" / "Avanzado → Continuar".
6. Ya puedes usar el botón de la cámara 📷 desde el celular.

Sin estos archivos el programa sigue funcionando normal por http, pero el navegador del celular bloquea la cámara.

---

## Si al guardar un producto dice error

1. Cierra el programa por completo.
2. Vuelve a abrirlo con **ejecutar.bat** (así se actualiza la base de datos).
3. Intenta guardar de nuevo.

Si sigue fallando, el mensaje ahora muestra el motivo exacto.


## Cámara del celular

Al abrir el programa se activa HTTPS solo (crea el certificado la primera vez).

1. Abre con **ejecutar.bat**.
2. En el celular entra a la dirección **https://** que aparece en pantalla.
3. Acepta el aviso de seguridad (Avanzado → Continuar). Solo la primera vez.
4. Usa el botón 📷 para escanear con la cámara del celular.

No hace falta ejecutar nada extra.