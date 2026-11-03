@echo off
title DE TODITO MARKET
cd /d "%~dp0"
set PYTHON="C:\Users\Usuario\AppData\Local\Programs\Python\Python315\python.exe"
echo ========================================
echo   DE TODITO MARKET MyF, C.A
echo ========================================
echo.
if not exist %PYTHON% (
    echo ERROR: No se encontro Python en %PYTHON%
    pause
    exit /b 1
)
echo Instalando dependencias...
%PYTHON% -m pip install -r requirements.txt -q
echo.
echo Iniciando...
%PYTHON% app.py
pause
