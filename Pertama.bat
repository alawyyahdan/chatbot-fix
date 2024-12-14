@echo off
echo Memulai instalasi dependensi...
npm install
if %errorlevel% neq 0 (
    echo Gagal melakukan instalasi dependensi.
    pause
    exit /b %errorlevel%
)

echo Instalasi dependensi selesai.
echo Menjalankan aplikasi...
start cmd /k "npm run start"