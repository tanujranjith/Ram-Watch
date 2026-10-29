@echo off
setlocal
set "chrome=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome%" set "chrome=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome%" set "chrome=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%chrome%" (
  echo Chrome was not found.
  pause
  exit /b 1
)
start "" "%chrome%" --user-data-dir="%LOCALAPPDATA%\RamWatch\ChromeProfile" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --disk-cache-size=67108864 --media-cache-size=16777216 --no-first-run
