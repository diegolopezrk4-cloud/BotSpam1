# Testing BotSpam1 Panel

## Local Dev Setup

1. Install dependencies: `cd /home/ubuntu/repos/BotSpam1 && npm install`
2. Start API server: `node index_wsp.js` (port 3000) — starts WhatsApp API + QR server
3. Start panel server: `node panel_server.js` (port 3001) — serves panel.html and proxies /api/* to port 3000
4. Panel is accessible at `http://localhost:3001`

## Architecture

- **panel_server.js** (port 3001): Static file server for panel.html + reverse proxy to API
- **index_wsp.js** (port 3000): WhatsApp API server using Baileys v6.7.16
- **db_wsp.js**: SQLite database (better-sqlite3) at `./wsp_titan.db`
- **motor_wsp.js**: WhatsApp message sending engine
- **bot.py** (port 3002): Telegram bot (Python/aiogram) — optional for WSP testing

## Test User Setup

Register a test user via API:
```bash
curl -s -X POST http://localhost:3000/api/panel_registro \
  -H "Content-Type: application/json" \
  -d '{"telegram_id":"testuser123","password":"test1234","username":"TestDevin"}'
```

Login via API:
```bash
curl -s -X POST http://localhost:3000/api/panel_login \
  -H "Content-Type: application/json" \
  -d '{"telegram_id":"testuser123","password":"test1234"}'
```

## Panel Navigation

- Login screen: Select "WhatsApp" platform → enter Telegram ID + password → "Iniciar Sesion"
- Sidebar navigation: Click menu items to switch sections
- Key sections: Dashboard, Cuentas WSP, Grupos, Mensajes, Envio Unico, Envio Personal, Envio a Miembros, Envio Interactivo, Programados, Campanas
- Monitoreo sections: Logs del Bot, Cola de Reintentos
- Config sections: Config Envio, Lista Negra Grupos, Lista Negra Numeros, Auto-Responder

## Key API Endpoints for Testing

- `POST /api/panel_registro` — register user
- `POST /api/panel_login` — login (bcrypt)
- `GET /api/promo/respuestas?u=USER_ID` — get promo responses + stats
- `POST /api/promo/enviar_y_escuchar` — send promo + activate listener (todo-en-uno)
- `GET /api/promo/keywords?u=USER_ID` — list promo keywords
- `POST /api/promo/keywords/agregar` — add keyword (body: u, palabra, respuesta_texto, tipo)
- `GET /api/retry/stats?u=USER_ID` — retry queue stats
- `GET /api/logs?u=USER_ID&limite=100` — bot logs
- `POST /api/logs/limpiar` — clear logs (body: u)

## Limitations

- WhatsApp features (message sending, promo listening, anti-spam) require a real WhatsApp connection via QR scan — these cannot be tested without linking a phone
- The API server might show ExperimentalWarning about ESM loading — this is expected and harmless
- Telegram bot (bot.py on port 3002) is optional for WSP panel testing

## Syntax Checking

Verify JavaScript files compile without errors:
```bash
node -c index_wsp.js && node -c db_wsp.js && node -c motor_wsp.js && echo "All OK"
```

## Devin Secrets Needed

No secrets required for local panel testing. WhatsApp connection requires scanning QR code from a real phone.
