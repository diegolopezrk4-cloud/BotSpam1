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

    // Proxy API requests to the WSP API server
    if (url.pathname.startsWith("/api/")) {
        const options = {
            hostname: API_HOST,
            port: API_PORT,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` }
        };

        const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on("error", (e) => {
            res.writeHead(502);
            res.end(JSON.stringify({ ok: false, error: "API no disponible: " + e.message }));
        });

        req.pipe(proxyReq);
        return;
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
