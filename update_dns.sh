#!/bin/bash
# Duck DNS Auto-Update Script
# Actualiza el dominio jdbotspam.duckdns.org con tu IP publica actual
#
# Configuracion:
#   export DUCKDNS_TOKEN="tu-token-aqui"
#   bash update_dns.sh
#
# Para ejecutar automaticamente cada 5 minutos, agrega al crontab:
#   */5 * * * * DUCKDNS_TOKEN="tu-token" /ruta/a/update_dns.sh > /dev/null 2>&1

DOMAIN="jdbotspam"

if [ -z "$DUCKDNS_TOKEN" ]; then
    echo "Error: DUCKDNS_TOKEN no configurado"
    echo "Usa: export DUCKDNS_TOKEN='tu-token' && bash update_dns.sh"
    exit 1
fi

echo "Actualizando Duck DNS..."
RESULT=$(curl -s "https://www.duckdns.org/update?domains=${DOMAIN}&token=${DUCKDNS_TOKEN}&ip=")

if [ "$RESULT" = "OK" ]; then
    echo "DNS actualizado exitosamente: ${DOMAIN}.duckdns.org"
else
    echo "Error actualizando DNS: $RESULT"
fi
