@echo off
setlocal
cd /d "%~dp0"

echo Waiting...
echo ========================================

where node >nul 2>nul
if errorlevel 1 goto INSTALL_NODE
where npm >nul 2>nul
if errorlevel 1 goto INSTALL_NODE
goto CHECK_DEPENDENCIES

:INSTALL_NODE
echo Node.js or npm was not found. Downloading the latest Node.js LTS...
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; try { $release = Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1; if (-not $release) { throw 'Could not find the latest Node.js LTS release.' }; $arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) { 'Arm64' { 'arm64' } 'X64' { 'x64' } default { throw 'Automatic Node.js setup requires 64-bit Windows (x64 or ARM64).' } }; $name = 'node-' + $release.version + '-win-' + $arch; $base = Join-Path $env:LOCALAPPDATA 'Programs\nodejs'; $target = Join-Path $base $name; $zip = Join-Path $env:TEMP ($name + '.zip'); New-Item -ItemType Directory -Force -Path $base | Out-Null; Invoke-WebRequest ('https://nodejs.org/dist/' + $release.version + '/' + $name + '.zip') -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $base -Force; Remove-Item -LiteralPath $zip -Force; if (-not (Test-Path (Join-Path $target 'node.exe')) -or -not (Test-Path (Join-Path $target 'npm.cmd'))) { throw 'Node.js archive did not contain node.exe and npm.cmd.' }; Write-Output $target } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"`) do set "NODE_HOME=%%P"
if not defined NODE_HOME (
    echo Could not download or install Node.js. Check your internet connection and try again.
    pause
    exit /b 1
)
set "PATH=%NODE_HOME%;%PATH%"

:CHECK_DEPENDENCIES
call npm ls --depth=0 >nul 2>nul
if errorlevel 1 (
    echo Installing or repairing project dependencies...
    call npm install
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

call npm ls --depth=0
if errorlevel 1 (
    echo Some project dependencies are still missing. See the npm output above.
    pause
    exit /b 1
)

echo Starting the restaurant ordering system...
node index.js
if errorlevel 1 echo The server stopped because of an error.
pause
