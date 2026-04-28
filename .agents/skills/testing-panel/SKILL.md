# Testing the BotSpam1 Web Panel

## Overview
The BotSpam1 project has a two-tier architecture:
- **panel_server.js** (port 3001): Serves the static `panel.html` single-page app and proxies API calls to the backend
- **index_wsp.js** (port 3000): The WhatsApp API backend (requires npm dependencies like `@whiskeysockets/baileys`)

## Quick Start — Panel UI Testing

The panel server only uses built-in Node.js modules (`http`, `fs`, `path`), so it can run standalone without `npm install`:

```bash
cd /home/ubuntu/repos/BotSpam1
# Kill any existing process on port 3001
fuser -k 3001/tcp 2>/dev/null; sleep 1
node panel_server.js
```

Then open `http://localhost:3001` in Chrome.

## What Can Be Tested Without the Backend API

- **Platform selector** (WSP/TG cards on first load)
- **Login/register screen** (title, icon, subtitle change per platform)
- **Static admin panel HTML** (plan cards: Semanal S/15, Mensual S/30, Permanente ∞)
- **Membership overlay structure** (contact info, plan prices)
- **Sidebar navigation** (all sections render their empty states)
- **Cuentas Telegram section** (instructions for /vincular)

## What Requires the Full Backend

- Actual login/register flows (needs `/api/panel_login`, `/api/panel_register`)
- Membership activation and expiration checks (needs `/api/check_membresia`)
- Personal chats loading (needs WhatsApp connection + `/api/chats_personales`)
- Statistics endpoint (needs `/api/grupo_stats`)
- Admin user table with dynamic data (needs `/api/admin/usuarios`)
- WhatsApp account linking (needs baileys library)

## Simulating State via Playwright CDP

Since the `computer` console tool may not always detect Chrome as foreground, use Playwright CDP as a reliable alternative:

```python
from playwright.sync_api import sync_playwright
p = sync_playwright().start()
browser = p.chromium.connect_over_cdp('http://localhost:29229')
page = browser.contexts[0].pages[0]

# Example: simulate logged-in state
page.evaluate('''
    localStorage.setItem("panel_uid", "12345");
    localStorage.setItem("panel_token", "fake");
    localStorage.setItem("panel_admin", "1");
    document.getElementById("authLogin").style.display = "none";
    document.getElementById("platformSelector").style.display = "none";
    document.getElementById("app").style.display = "block";
    document.querySelectorAll(".admin-only").forEach(el => el.style.display = "");
''')

# Example: show membership overlay
page.evaluate('document.getElementById("membresiaOverlay").style.display = "flex"')

browser.close()
p.stop()
```

## Key UI Navigation Paths

1. **First load** → Platform selector (WSP/TG cards)
2. **Click WSP card** → Login screen with "Panel WhatsApp" title
3. **Click TG card** → Login screen with "Panel Telegram" title
4. **"Cambiar plataforma" link** → Back to platform selector
5. **After login** → Dashboard with sidebar navigation
6. **Sidebar "Admin Panel"** → Shows plan cards + user management table
7. **Sidebar "Cuentas Telegram"** → TG account linking instructions
8. **Sidebar "Estadisticas"** → Statistics page

## Key Files

- `panel.html` — Single-page app (all HTML, CSS, JS in one file, ~1150 lines)
- `panel_server.js` — Static file server + API proxy (~67 lines)
- `index_wsp.js` — Backend API server (~3600 lines)
- `db_wsp.js` — Database layer with SQLite (~1300 lines)
- `motor_wsp.js` — WhatsApp message sending engine (~1400 lines)
- `config_wsp.js` — Configuration (plans, prices, timings)

## Notes

- The project has NO `package.json` — dependencies are managed manually
- No CI/CD is configured in the repository
- The Duck DNS domain is `jdbotspam.duckdns.org` — token must be set as `DUCKDNS_TOKEN` env var
- Admin contact: WSP +51976680776, TG @JhonnyVip05
- Plans: Semanal S/15 (7d), Mensual S/30 (30d), Permanente (no expiration)

## Devin Secrets Needed

- `DUCKDNS_TOKEN` — Required only for DNS update testing (not needed for UI testing)
