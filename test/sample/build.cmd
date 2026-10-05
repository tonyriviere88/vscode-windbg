@echo off
rem Builds the debugging sample with the newest Visual Studio C++ toolset.
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo vswhere.exe not found: install Visual Studio with the C++ workload.
    exit /b 1
)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
    echo No Visual Studio installation with the C++ x64 tools was found.
    exit /b 1
)
set "PATH=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer;%PATH%"
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist out mkdir out
cl /nologo /Zi /Od /EHsc /std:c++17 /MDd /LD late.cpp /Fe:out\late.dll /Fo:out\ /Fd:out\late.pdb /link /DEBUG:FULL || exit /b 1
cl /nologo /Zi /Od /EHsc /std:c++17 /MDd /LD plugin.cpp /Fe:out\plugin.dll /Fo:out\ /Fd:out\plugin.pdb /link /DEBUG:FULL || exit /b 1
cl /nologo /Zi /Od /EHsc /std:c++17 /MDd sample.cpp /Fe:out\sample.exe /Fo:out\ /Fd:out\sample.pdb /link /DEBUG:FULL out\plugin.lib
