@echo off
setlocal
set "RamWatchFolder=%LOCALAPPDATA%\RamWatch"
if not exist "%RamWatchFolder%\RamWatch.Native.exe" exit /b 0
"%RamWatchFolder%\RamWatch.Native.exe" --unregister
if errorlevel 1 exit /b 1
del /q "%RamWatchFolder%\RamWatch.Native.exe" "%RamWatchFolder%\NativeMessagingHost.json" "%RamWatchFolder%\Start-RAM-Watch.cmd"
echo Native sampler removed. Your ChromeProfile folder was kept to preserve your browsing data.
pause
