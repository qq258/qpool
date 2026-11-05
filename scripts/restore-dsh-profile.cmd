@echo off
setlocal
set "PROFILE=%USERPROFILE%\.dsh\profiles\desktop"
set "PATCH=%PROFILE%\cordis.patch.yml"

if not exist "%PATCH%" (
  echo [x] patch file not found: %PATCH%
  exit /b 1
)

set "LATEST="
for /f "delims=" %%f in ('dir /b /o-d "%PROFILE%\cordis.patch.yml.bak-*" 2^>nul') do (
  if not defined LATEST set "LATEST=%%f"
)

if not defined LATEST (
  echo [x] no backup found in %PROFILE%
  exit /b 1
)

copy /y "%PROFILE%\%LATEST%" "%PATCH%" >nul
echo [ok] restored %PATCH% from %LATEST%
echo     restart DSH to pick it up.
endlocal
