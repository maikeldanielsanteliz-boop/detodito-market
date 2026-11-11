@echo off
title DE TODITO MARKET
cd /d "%~dp0"
echo ========================================
echo   DE TODITO MARKET MyF, C.A
echo ========================================
echo.

rem --- Busca Python: primero la ruta de esta PC, luego el lanzador "py" y por ultimo "python" del PATH ---
set PYEXE=
if exist "C:\Program Files\Python312\python.exe" set PYEXE="C:\Program Files\Python312\python.exe"
if not defined PYEXE (
    where py >nul 2>&1
    if not errorlevel 1 set PYEXE=py -3
)
if not defined PYEXE (
    where python >nul 2>&1
    if not errorlevel 1 set PYEXE=python
)
if not defined PYEXE (
    echo ERROR: No se encontro Python.
    echo Instalalo desde https://www.python.org/downloads/ y marca "Add Python to PATH".
    pause
    exit /b 1
)

echo Instalando dependencias...
%PYEXE% -m pip install -r requirements.txt -q
if errorlevel 1 echo (No se pudieron actualizar las dependencias; si ya estaban instaladas, el programa continua)
echo.
echo Iniciando...
%PYEXE% app.py
pause
