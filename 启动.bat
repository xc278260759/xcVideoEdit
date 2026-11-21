@echo off
setlocal

set "ROOT=%~dp0"
set "APP=%ROOT:~0,-1%"
set "EXE=%ROOT%node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
  echo Electron runtime not found.
  echo Run these in this folder first:
  echo     npm install
  echo     node node_modules\electron\install.js
  pause
  exit /b 1
)

start "" "%EXE%" "%APP%"
exit /b 0
