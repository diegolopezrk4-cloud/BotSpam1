#!/bin/bash
# Script para actualizar e iniciar todo el bot J&D
# Uso: bash start.sh

cd /root/BotSpam1 || { echo "ERROR: No se encontro /root/BotSpam1"; exit 1; }

echo "🔄 Deteniendo servicios anteriores..."
# Matar por nombre de proceso
pkill -f "node index_wsp.js" 2>/dev/null
pkill -f "node panel_server.js" 2>/dev/null
pkill -f "python3 bot.py" 2>/dev/null
sleep 1
# Matar por puerto (por si pkill no los mato)
fuser -k 3000/tcp 2>/dev/null
fuser -k 3001/tcp 2>/dev/null
fuser -k 3002/tcp 2>/dev/null
sleep 2

# Verificar que los puertos estan libres
for port in 3000 3001 3002; do
    if fuser $port/tcp 2>/dev/null; then
        echo "⚠ ADVERTENCIA: Puerto $port sigue ocupado. Matando con SIGKILL..."
        fuser -k -9 $port/tcp 2>/dev/null
        sleep 1
    fi
done

echo "📦 Limpiando cache Python..."
find . -name '__pycache__' -exec rm -rf {} + 2>/dev/null

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
echo "   lsof -i :3000 -i :3001 -i :3002"
echo ""
echo "🌐 Panel: https://jdbotspam.duckdns.org"
