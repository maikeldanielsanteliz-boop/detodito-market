@echo off
title Generar certificado HTTPS
cd /d "%~dp0"

echo ========================================
echo  Generar certificado para camara celular
echo ========================================
echo.

where openssl >nul 2>&1
if %errorlevel% neq 0 (
    echo OpenSSL no encontrado.
    echo.
    echo Opcion 1: Instala Git for Windows (incluye openssl)
    echo   https://git-scm.com/download/win
    echo.
    echo Opcion 2: Usa Python para generar el certificado...
    python -c "from cryptography import x509; print('cryptography ok')" 2>nul
    if %errorlevel% neq 0 (
        echo Instalando cryptography...
        python -m pip install cryptography -q
    )
    python -c "
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta, timezone
import ipaddress

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'DeToditoMarket')])
cert = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(datetime.now(timezone.utc))
    .not_valid_after(datetime.now(timezone.utc) + timedelta(days=3650))
    .add_extension(x509.SubjectAlternativeName([
        x509.DNSName('localhost'),
        x509.IPAddress(ipaddress.IPv4Address('127.0.0.1')),
    ]), critical=False)
    .sign(key, hashes.SHA256())
)
with open('key.pem', 'wb') as f:
    f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
with open('cert.pem', 'wb') as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))
print('Listo: cert.pem y key.pem creados.')
print('Vuelve a ejecutar el programa (ejecutar.bat).')
"
    pause
    exit /b 0
)

openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=DeToditoMarket"
echo.
echo Listo: cert.pem y key.pem creados.
echo Vuelve a ejecutar el programa (ejecutar.bat).
pause
