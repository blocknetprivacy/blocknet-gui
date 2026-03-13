@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d "%~dp0src-tauri"
cargo clean -p blocknet-wallet 2>&1
cargo build --no-default-features 2>&1
if %errorlevel% equ 0 (
    echo BUILD SUCCESS - launching app...
    start "" "%~dp0src-tauri\target\debug\blocknet-wallet.exe"
)
