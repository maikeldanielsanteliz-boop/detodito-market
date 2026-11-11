
"""Configuración de la conexión a MySQL.

Lee primero las variables DETODITO_DB_* y, si no existen, usa las de Railway (MYSQLHOST, etc.).
"""
import os

MYSQL = {
    'host': os.environ.get('DETODITO_DB_HOST') or os.environ.get('MYSQLHOST') or '127.0.0.1',
    'port': int(os.environ.get('DETODITO_DB_PORT') or os.environ.get('MYSQLPORT') or '3306'),
    'user': os.environ.get('DETODITO_DB_USER') or os.environ.get('MYSQLUSER') or 'root',
    'password': os.environ.get('DETODITO_DB_PASSWORD') or os.environ.get('MYSQLPASSWORD') or '',
    'database': os.environ.get('DETODITO_DB_NAME') or os.environ.get('MYSQL_DATABASE') or 'db',
    'charset': 'utf8mb4',
}
