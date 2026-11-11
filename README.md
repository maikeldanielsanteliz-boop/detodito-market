[README.md](https://github.com/user-attachments/files/34665803/README.md)
# DE TODITO MARKET MyF, C.A — Inventario y Facturación

## 1. Base de datos: MySQL

Todo (productos, stock, ventas, pagos, facturas en pausa, contraseña) se guarda en **MySQL**.

1. Ten MySQL (o MariaDB) encendido.
2. Abre `config.py` y pon tus datos (por defecto la base se llama `db`): `host`, `port`, `user`, `password` y `database` (nombre de tu base ya migrada).
   También puedes usar variables de entorno `DETODITO_DB_HOST`, `DETODITO_DB_PORT`, `DETODITO_DB_USER`, `DETODITO_DB_PASSWORD`, `DETODITO_DB_NAME`.
   Si necesitas cargar tus datos en un MySQL vacío: `mysql -u USUARIO -p db < data.sql`.
3. Al iniciar, el programa **revisa y ajusta solo** la base:
   - agrega clave primaria y numeración automática (`AUTO_INCREMENT`) a los `id` (una migración desde SQLite los deja sin clave),
   - amplía columnas que quedaron del tamaño justo de los datos (por ejemplo `cantidad` con máximo 9.99, el número de factura con máximo 127, nombres de 10 letras, la ruta de la foto de 62 caracteres),
   - elimina restos de SQLite (`sqlite_sequence`) y columnas obsoletas, solo si están vacías,
   - crea las tablas que falten (incluida la de pagos y la de facturas en pausa),
   - convierte a `DECIMAL` el stock, las cantidades y los precios si al migrar quedaron como `INT`/`DOUBLE` (así no se pierden los decimales de kg/litros),
   - copia los pagos de las facturas antiguas a la tabla nueva de pagos.
   No borra ni cambia tus datos.

**Respaldo:** usa `mysqldump` (o MySQL Workbench → Data Export) con frecuencia.

### Probar que todo funciona con tu MySQL

```bash
python probar_mysql.py
```

Crea una base **temporal**, simula una migración desde SQLite, ejecuta el flujo completo (ventas, pagos mixtos, pausa, reportes) y la borra. No toca tus datos. Si algo falla, copia el resultado completo.

---

## 2. Cómo ejecutarlo

**Windows:** doble clic en `ejecutar.bat` (instala dependencias y arranca).

**Manual:**

```bash
pip install -r requirements.txt
python app.py
```

Abre **https://localhost:5000**. La primera vez pide crear la contraseña de administrador
(mínimo 8 caracteres, con mayúscula, minúscula y número).

---

## 3. Pistola lectora de códigos

Conecta la pistola USB (funciona como teclado). En **Facturación** no hace falta hacer clic en nada: al disparar, el producto se agrega al carrito.
Para registrar un producto nuevo, haz clic en "Código de Barras" del formulario y escanea ahí.
Si disparas un código que no existe, el administrador recibe el formulario de producto con el código ya escrito.

---

## 4. Factura en pausa

En Facturación, con productos en el carrito, pulsa **Pausar** para guardar la factura y atender a otro cliente.
El botón **En pausa (n)** muestra las guardadas: **Retomar** (si ya tienes otra en curso, esta se pausa sola para no perderla) o descartar.
Se guardan en MySQL: sobreviven a un refresco y se ven desde cualquier equipo. El inventario no se descuenta hasta cobrar, y al retomar se usan los precios y el stock de ese momento.

---

## 5. Pagos

- Pago en partes: varios métodos y monedas en una misma factura (por ejemplo, Efectivo en $ + Pago Móvil en Bs).
- Cada pago se guarda por separado con su método, moneda, monto, referencia y la tasa del día. Los reportes y el panel reparten cada pago a su método.
- Los precios y totales se calculan siempre en el servidor, con la base de datos, redondeados a centavos.
- En una factura con un solo pago, al editarla el pago se ajusta al nuevo total. Una factura con varios métodos no admite cambiar su total (anúlala y factura de nuevo).

---

## 6. Validaciones de productos y pagos

- **Producto mal elaborado:** al guardar un producto se revisa y se avisa en notificaciones si el precio de venta es $0, negativo o no es número; si el precio es demasiado alto (dígito de más); si el stock es negativo o con decimales en un producto "por unidad"; si el stock máximo es menor que el mínimo; o si el nombre es muy corto / sin letras. Los precios aceptan hasta 4 decimales (por ejemplo $0.034 por caramelo). Si el precio de venta es menor al costo, se guarda pero con un aviso de pérdida.
- **Productos duplicados:** no se puede crear (ni renombrar) un producto con el mismo nombre de otro, sin importar mayúsculas, acentos o espacios sobrantes: "Huevo", "HUEVO" y "huevo" son el mismo; "Huevo cartón" sí es distinto. Los productos antiguos que ya estén repetidos se pueden seguir editando sin cambiar el nombre.
- **Revisar datos:** en Inventario, el botón "Revisar datos" lista los productos que hay que corregir (precio en $0, nombres repetidos, stock raro) y avisa al entrar. Un producto con precio $0 no se puede vender hasta corregirlo.
- **Números negativos:** ningún campo numérico acepta "-". En Facturación, la cantidad debe ser mayor que 0 y entera para productos por unidad (kg y litros aceptan decimales).
- **Pago en partes:** el monto debe ser mayor que 0 y no puede superar lo que falta; si se deja vacío se sugiere exactamente lo que falta. En Pago Móvil la referencia no puede repetirse (ni en la misma factura ni en otra ya registrada).

---

## 7. Cámara del celular (solo fotos de productos)

El programa crea solo el certificado HTTPS (`cert.pem`, `key.pem`). En el celular (misma WiFi) entra a la dirección **https://** que aparece al arrancar y acepta el aviso (Avanzado → Continuar). No compartas `key.pem`.

---

## Estructura

```
DeToditoMarket_Final/
├── app.py            ← Servidor y reglas del negocio
├── database.py       ← Conexión a MySQL, tablas y migraciones
├── config.py         ← Datos de conexión a MySQL
├── probar_mysql.py   ← Prueba automática con tu MySQL (usa una base temporal)
├── ejecutar.bat      ← Arranque en Windows
├── requirements.txt
├── instance/         ← secret.key (se crea sola)
├── cert.pem / key.pem ← certificado HTTPS (se crean solos al iniciar)
├── static/ (css, js, uploads con las fotos)
└── templates/index.html
```

## Notas

- Los íconos y las fuentes se descargan de internet; sin conexión el sistema funciona, pero pueden no verse los íconos.
- La tasa del dólar se obtiene de internet y se guarda; sin conexión se usa la última o se escribe a mano.
- Haz copias de seguridad de MySQL con frecuencia.
