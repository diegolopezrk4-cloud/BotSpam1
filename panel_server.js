/**
 * Panel Web Server — Servidor independiente para el panel de control
 * Puerto: 3001 (separado del API WSP en 3000)
 * 
 * Sirve panel.html y proxea /api/* a localhost:3000
 * Asi no hay problemas de CORS ni conflictos con el QR page
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PANEL_PORT || 3001;
const API_HOST = process.env.API_HOST || "127.0.0.1";
const API_PORT = process.env.API_PORT || 3000;

const PANEL_FILE = path.join(__dirname, "panel.html");

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Get real client IP for forwarding
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";

    // Proxy TG requests to the Python bot server (port 3002)
    if (url.pathname.startsWith("/api/tg-auth/") || url.pathname.startsWith("/api/tg/") || url.pathname.startsWith("/api/sesiones_tg")) {
        const options = {
            hostname: "127.0.0.1",
            port: 3002,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: "127.0.0.1:3002", "x-forwarded-for": clientIp }
        };

        const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on("error", (e) => {
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: "Bot TG no disponible: " + e.message })); }
        });

        const tgTimeout = (url.pathname.includes('detectar') || url.pathname.includes('carpeta')) ? 120000 : 30000;
        proxyReq.setTimeout(tgTimeout, () => {
            proxyReq.destroy();
            if (!res.headersSent) { res.writeHead(504); res.end(JSON.stringify({ ok: false, error: "Bot TG no responde (timeout)" })); }
        });

        req.pipe(proxyReq);
        return;
    }

    // Proxy WSP API requests + QR link pages to the WSP API server
    if (url.pathname.startsWith("/api/") || url.pathname === "/link" || url.pathname === "/link-status") {
        const options = {
            hostname: API_HOST,
            port: API_PORT,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `${API_HOST}:${API_PORT}`, "x-forwarded-for": clientIp }
        };

        const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on("error", (e) => {
            if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ ok: false, error: "API no disponible: " + e.message })); }
        });

        const wspTimeout = (url.pathname.includes('detectar') || url.pathname.includes('miembros')) ? 120000 : 30000;
        proxyReq.setTimeout(wspTimeout, () => {
            proxyReq.destroy();
            if (!res.headersSent) { res.writeHead(504); res.end(JSON.stringify({ ok: false, error: "API WSP no responde (timeout)" })); }
        });

        req.pipe(proxyReq);
        return;
    }

    // Serve static PWA files
    if (url.pathname === "/manifest.json") {
        try {
            const data = fs.readFileSync(path.join(__dirname, "manifest.json"), "utf-8");
            res.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" });
            return res.end(data);
        } catch (e) { res.writeHead(404); return res.end("Not found"); }
    }
    if (url.pathname === "/sw.js") {
        try {
            const data = fs.readFileSync(path.join(__dirname, "sw.js"), "utf-8");
            res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
            return res.end(data);
        } catch (e) { res.writeHead(404); return res.end("Not found"); }
    }
    // Serve PWA icon files
    if (url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png") {
        try {
            const data = fs.readFileSync(path.join(__dirname, url.pathname.slice(1)));
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
            return res.end(data);
        } catch (e) { res.writeHead(404); return res.end("Not found"); }
    }

    // Serve panel.html for everything else
    try {
        const html = fs.readFileSync(PANEL_FILE, "utf-8");
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache"
        });
        res.end(html);
    } catch (e) {
        res.writeHead(500);
        res.end("Error cargando panel: " + e.message);
    }
});

const DOMAIN = process.env.PANEL_DOMAIN || "jdbotspam.duckdns.org";

server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🌐 Panel Web corriendo en http://0.0.0.0:${PORT}`);
    console.log(`   🌍 Dominio: http://${DOMAIN}:${PORT}`);
    console.log(`   API proxy → http://${API_HOST}:${API_PORT}`);
    console.log(`   Comparte este link con tus clientes\n`);
});
