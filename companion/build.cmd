@echo off
setlocal
set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo Install Visual Studio 2022 Build Tools with Desktop development with C++.
  exit /b 1
)
call "%VCVARS%" >nul
if errorlevel 1 exit /b 1
pushd "%~dp0"
if not exist bin mkdir bin
set "TARGET=RamWatch.Native"
set "TESTFLAGS="
if "%~1"=="test" (
  set "TARGET=RamWatch.Native.test"
  set "TESTFLAGS=/DRAMWATCH_TESTING"
)
cl /nologo /std:c++17 /O1 /MT /EHsc /utf-8 /W4 %TESTFLAGS% RamWatch.Native.cpp /Fo:bin\%TARGET%.obj /Fe:bin\%TARGET%.exe /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA winhttp.lib psapi.lib windowsapp.lib shell32.lib advapi32.lib
set "BUILD_RESULT=%errorlevel%"
if exist "bin\%TARGET%.obj" del /q "bin\%TARGET%.obj"
popd
exit /b %BUILD_RESULT%
