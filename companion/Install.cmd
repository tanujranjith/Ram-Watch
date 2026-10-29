@echo off
setlocal
echo RAM Watch - install the native sampler for this Windows user
echo No administrator access, background service, or startup task is needed.
echo Open Companion setup from the extension menu and copy its extension ID.
"%~dp0bin\RamWatch.Native.exe" --install
pause
