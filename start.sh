#!/bin/bash
# Script para actualizar e iniciar todo el bot J&D
# Uso: bash start.sh

cd /root/BotSpam1 || { echo "ERROR: No se encontro /root/BotSpam1"; exit 1; }

echo "🔄 Deteniendo servicios anteriores..."
pkill -f "node index_wsp.js" 2>/dev/null
pkill -f "node panel_server.js" 2>/dev/null
pkill -f "python3 bot.py" 2>/dev/null
sleep 2

echo "📦 Actualizando codigo..."
git config pull.rebase false
git pull origin devin/1777418928-fix-all-wsp-commands 2>/dev/null || git pull 2>/dev/null

echo "📦 Instalando dependencias Node..."
npm install 2>/dev/null

echo "📦 Instalando dependencias Python..."
pip3 install --break-system-packages telethon aiohttp aiogram qrcode pillow 2>/dev/null

echo "🚀 Iniciando servicios..."
cd /root/BotSpam1
nohup node index_wsp.js >> wsp.log 2>&1 &
echo "   ✅ WSP API iniciado (puerto 3000) - PID: $!"
nohup node panel_server.js >> panel.log 2>&1 &
echo "   ✅ Panel Web iniciado (puerto 3001) - PID: $!"
nohup python3 bot.py >> bot.log 2>&1 &
echo "   ✅ Bot TG iniciado (puerto 3002) - PID: $!"

sleep 3
echo ""
echo "🟢 Todo corriendo! Verifica con:"
echo "   tail -5 wsp.log panel.log bot.log"
echo ""
echo "🌐 Panel: https://jdbotspam.duckdns.org"
