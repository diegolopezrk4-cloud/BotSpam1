const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const http = require("http");
const fs = require("fs");
const config = require("./config_wsp");
const db = require("./db_wsp");
const motor = require("./motor_wsp");

const QR_PORT = process.env.QR_PORT || 3000;

// --- Grupo admin (persistido en archivo) ---
let adminGroupJid = null;
try {
    const saved = fs.readFileSync("admin_group.txt", "utf8").trim();
    if (saved) adminGroupJid = saved;
} catch (e) {}

function setAdminGroup(groupJid) {
    adminGroupJid = groupJid;
    fs.writeFileSync("admin_group.txt", groupJid);
    console.log(`\u{1F451} Grupo admin registrado: ${groupJid}`);
}

// --- Admin JIDs registrados (soporta LIDs) ---
const adminJids = new Set();
try {
    const saved = fs.readFileSync("admin_jids.txt", "utf8").trim();
    if (saved) saved.split("\n").forEach(j => { if (j.trim()) adminJids.add(j.trim()); });
    console.log(`\u{1F451} Admin JIDs cargados: ${adminJids.size}`);
} catch (e) {}

function addAdminJid(jid) {
    adminJids.add(jid);
    fs.writeFileSync("admin_jids.txt", [...adminJids].join("\n"));
    console.log(`\u{1F451} Admin JID registrado: ${jid}`);
}

// --- Normalizar JID (LID y @s.whatsapp.net al mismo numero) ---
function normalizeJid(jid) {
    return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
}

// --- Estado de usuarios (FSM) ---
const userState = {}; // { normalizedJid: { screen, data, step } }

function getState(jid) {
    return userState[normalizeJid(jid)] || { screen: null, data: {} };
}

function setState(jid, screen, data = {}) {
    userState[normalizeJid(jid)] = { screen, data };
}

function clearState(jid) {
    delete userState[normalizeJid(jid)];
}

// --- Variables globales ---
let botSock = null;
let currentQR = null;
let botStatus = "desconectado";

// --- Control de mensajes enviados por el bot ---
const botSentIds = new Set();
const processedMsgIds = new Set();
let botIsSending = false;

function trackSent(result) {
    if (result && result.key && result.key.id) {
        botSentIds.add(result.key.id);
        setTimeout(() => botSentIds.delete(result.key.id), 120000);
    }
}

function jidToNumber(jid) {
    return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
}

function isAdmin(jid) {
    if (adminJids.has(jid)) return true;
    const num = jidToNumber(jid);
    if (num === config.ADMIN_NUMBER) return true;
    if (config.BOT_NUMBER && num === config.BOT_NUMBER) return true;
    if (botSock && botSock.user) {
        const botJid = botSock.user.id;
        const botNum = jidToNumber(botJid);
        if (num === botNum) return true;
    }
    return false;
}

// --- Enviar mensaje helper ---
async function send(jid, text) {
    if (!botSock) { console.log(`[NO-WSP] send(${jid}): ${text.substring(0, 80)}...`); return; }
    botIsSending = true;
    try {
        const result = await botSock.sendMessage(jid, { text });
        trackSent(result);
    } finally {
        setTimeout(() => { botIsSending = false; }, 2000);
    }
}

async function sendImage(jid, imagePath, caption = "") {
    if (!botSock) { console.log(`[NO-WSP] sendImage(${jid})`); return; }
    botIsSending = true;
    try {
        if (fs.existsSync(imagePath)) {
            const result = await botSock.sendMessage(jid, {
                image: fs.readFileSync(imagePath),
                caption,
            });
            trackSent(result);
        } else {
            await send(jid, caption || "(imagen no encontrada)");
        }
    } finally {
        setTimeout(() => { botIsSending = false; }, 2000);
    }
}

async function sendToUser(phoneNumber, msg) {
    const jids = db.getAllJidsForNumber(phoneNumber);
    for (const j of jids) {
        try { await send(j, msg); } catch (e) {}
    }
    if (!jids.length) {
        try { await send(phoneNumber + "@s.whatsapp.net", msg); } catch (e) {}
    }
}

async function checkMembership(jid) {
    if (!db.tieneMembresia(jid)) {
        await send(jid, "\u26D4 *No tienes membresia activa.*\n\nResponde *10* para ver planes y pagar.");
        return false;
    }
    return true;
}

// --- Servidor web para QR ---
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // API para estado de vinculacion (JSON)
    if (url.pathname === "/link-status") {
        const userId = url.searchParams.get("u");
        const nombre = url.searchParams.get("n");
        if (!userId || !nombre) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "falta u o n" }));
        }
        const linkStatus = motor.getLinkStatus(userId, nombre);
        const status = linkStatus ? linkStatus.status : "no_iniciado";
        let qrImg = "";
        if (linkStatus && linkStatus.qr) {
            try { qrImg = await QRCode.toDataURL(linkStatus.qr, { width: 300, margin: 2 }); } catch (e) {}
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status, qr: qrImg, error: linkStatus?.error || null }));
    }

    // Pagina de vinculacion de cuenta
    if (url.pathname === "/link") {
        const userId = url.searchParams.get("u");
        const nombre = url.searchParams.get("n");
        if (!userId || !nombre) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            return res.end("<h1>Error: falta parametro u (user) o n (nombre)</h1>");
        }

        // Iniciar proceso de vinculacion
        motor.linkAccount(userId, nombre).catch(e => {
            console.error(`Link error: ${e.message}`);
        });

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>Vincular Cuenta \u2014 J&D</title>
<style>
body{background:#111;color:#fff;font-family:Arial;text-align:center;padding:40px}
.box{background:#1a1a2e;border-radius:16px;padding:30px;max-width:420px;margin:0 auto}
.status{padding:10px;border-radius:8px;margin:10px 0;font-weight:bold}
.connected{background:#0a3d0a;color:#4caf50}
.waiting{background:#3d3d0a;color:#ffeb3b}
.disconnected{background:#3d0a0a;color:#f44336}
.instructions{text-align:left;margin:15px 0;font-size:14px}
</style></head><body>
<div class="box">
<h1>\u{1F4F1} Vincular Cuenta</h1>
<h2>${nombre}</h2>
<div id="content"><div class="status disconnected">\u23F3 Preparando QR...</div><p>Espera unos segundos...</p></div>
</div>
<script>
const u = "${encodeURIComponent(userId)}";
const n = "${encodeURIComponent(nombre)}";
let lastQr = "";
async function poll() {
    try {
        const r = await fetch("/link-status?u=" + u + "&n=" + n);
        const d = await r.json();
        const el = document.getElementById("content");
        if (d.status === "conectado") {
            el.innerHTML = '<div class="status connected">\u2705 VINCULADO \u2014 Cuenta lista</div><p>Ya puedes cerrar esta pagina y volver al bot.</p>';
            return;
        } else if (d.status === "esperando_qr" && d.qr) {
            if (d.qr !== lastQr) { lastQr = d.qr;
            el.innerHTML = '<div class="status waiting">\u23F3 Escanea el QR con tu celular</div>' +
                '<img src="' + d.qr + '" width="300" height="300">' +
                '<div class="instructions"><strong>\u{1F4F2} Instrucciones:</strong><ol>' +
                '<li>Abre <strong>WhatsApp</strong> en el celular</li>' +
                '<li>Ve a <strong>Ajustes > Dispositivos vinculados</strong></li>' +
                '<li>Toca <strong>Vincular dispositivo</strong></li>' +
                '<li><strong>Escanea este QR</strong></li></ol></div>'; }
        } else if (d.status === "error" || d.status === "timeout") {
            el.innerHTML = '<div class="status disconnected">\u274C ' + (d.error || "Error") + '</div><p>Vuelve al bot e intenta de nuevo.</p>';
            return;
        }
    } catch (e) {}
    setTimeout(poll, 3000);
}
poll();
</script>
</body></html>`);
    }

    // ═══════════════════════════════════════
    //   API REST PARA CONTROL DESDE TELEGRAM
    // ═══════════════════════════════════════
    if (url.pathname.startsWith("/api/")) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");

        // Helper para leer body POST
        const readBody = () => new Promise((resolve) => {
            let data = "";
            req.on("data", c => data += c);
            req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        });

        try {
            // GET /api/status — Estado del bot WSP
            if (url.pathname === "/api/status") {
                res.writeHead(200);
                return res.end(JSON.stringify({
                    ok: true,
                    status: botStatus,
                    bot_number: botSock?.user?.id ? jidToNumber(botSock.user.id) : null,
                }));
            }

            // GET /api/grupos?u=USER_ID — Lista de grupos
            if (url.pathname === "/api/grupos" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const grupos = db.getGrupos(userId);
                const maxG = db.getMaxGrupos(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, grupos, max: maxG }));
            }

            // POST /api/grupos/add — Agregar grupo { u, link }
            if (url.pathname === "/api/grupos/add" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.link) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o link" })); }
                db.agregarGrupo(body.u, body.link);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // POST /api/grupos/del — Eliminar grupo { u, id }
            if (url.pathname === "/api/grupos/del" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o id" })); }
                db.eliminarGrupo(body.u, body.id);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // POST /api/grupos/delall — Eliminar todos { u }
            if (url.pathname === "/api/grupos/delall" && req.method === "POST") {
                const body = await readBody();
                if (!body.u) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                db.eliminarTodosGrupos(body.u);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // GET /api/sesiones?u=USER_ID — Cuentas WSP vinculadas
            if (url.pathname === "/api/sesiones" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const sesiones = db.getSesiones(userId);
                const baneadas = db.getCuentasBaneadas(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, sesiones, baneadas }));
            }

            // GET /api/campanas?u=USER_ID — Lista de campañas
            if (url.pathname === "/api/campanas" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const campanas = db.getCampanas(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, campanas }));
            }

            // POST /api/campanas/crear — Crear campaña { u, nombre, mensaje }
            if (url.pathname === "/api/campanas/crear" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.nombre || !body.mensaje) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u, nombre o mensaje" })); }
                const id = db.crearCampana(body.u, body.nombre, body.mensaje, body.imagen || null);
                // Auto-asignar grupos y sesiones
                const grupos = db.getGrupos(body.u);
                for (const g of grupos) { db.agregarGrupoCampana(id, g.link); }
                const sesiones = db.getSesiones(body.u);
                for (const s of sesiones) { db.agregarSesionCampana(id, s.nombre); }
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, id }));
            }

            // POST /api/campanas/del — Eliminar campaña { id }
            if (url.pathname === "/api/campanas/del" && req.method === "POST") {
                const body = await readBody();
                if (!body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta id" })); }
                db.eliminarCampana(body.id);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // POST /api/iniciar — Iniciar campaña { u, id }
            if (url.pathname === "/api/iniciar" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o id" })); }
                const camp = db.getCampanaById(body.id);
                if (!camp) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "campana no encontrada" })); }
                motor.iniciarCampana(body.id, body.u, botSock);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, campana: camp.nombre }));
            }

            // POST /api/detener — Detener campaña { id }
            if (url.pathname === "/api/detener" && req.method === "POST") {
                const body = await readBody();
                if (!body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta id" })); }
                motor.detenerCampana(body.id);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // GET /api/historial?u=USER_ID — Historial de envíos
            if (url.pathname === "/api/historial" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const envios = db.getHistorialEnvios(userId, 30);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, envios }));
            }

            // GET /api/dashboard?u=USER_ID — Dashboard
            if (url.pathname === "/api/dashboard" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const dash = db.getDashboard(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, dashboard: dash }));
            }

            // POST /api/vincular — Iniciar vinculación de cuenta WSP { u, nombre, telefono }
            if (url.pathname === "/api/vincular" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.nombre) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o nombre" })); }
                const telefono = body.telefono || "pendiente";
                // Registrar sesión en DB si no existe
                const existentes = db.getSesiones(body.u);
                const yaExiste = existentes.some(s => s.nombre === body.nombre);
                if (!yaExiste) {
                    db.agregarSesion(body.u, body.nombre, telefono);
                }
                // Iniciar vinculación
                motor.linkAccount(body.u, body.nombre).then(() => {
                    // Cuando se vincula exitosamente, actualizar teléfono
                    const key = `${body.u}_${body.nombre}`;
                    const sock = motor.clientSessions[key];
                    if (sock && sock.user && sock.user.id) {
                        const realPhone = jidToNumber(sock.user.id);
                        // Actualizar telefono en DB
                        try {
                            const stm = db.getDb().prepare("UPDATE sesiones SET telefono=? WHERE user_id=? AND nombre=?");
                            stm.run(realPhone, body.u, body.nombre);
                        } catch (e) {}
                    }
                }).catch(e => {
                    console.error(`Link error: ${e.message}`);
                });
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, link_url: `/link?u=${encodeURIComponent(body.u)}&n=${encodeURIComponent(body.nombre)}` }));
            }

            // POST /api/desvincular — Eliminar cuenta WSP
            if (url.pathname === "/api/desvincular" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.nombre) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o nombre" })); }
                try {
                    motor.disconnectClient(body.u, body.nombre);
                    db.eliminarSesion(body.u, body.nombre);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, msg: `Cuenta '${body.nombre}' eliminada` }));
                } catch (e) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            }

            // GET /api/usuarios?u=USER_ID — Info de usuario WSP
            if (url.pathname === "/api/usuarios" && req.method === "GET") {
                const wspId = url.searchParams.get("u");
                if (!wspId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const user = db.getUsuario(wspId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, usuario: user || null }));
            }

            // GET /api/usuarios/todos — Todos los usuarios WSP
            if (url.pathname === "/api/usuarios/todos" && req.method === "GET") {
                const usuarios = db.getTodosUsuarios();
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, usuarios }));
            }

            // POST /api/activar — Activar membresía WSP { wsp_id, dias }
            if (url.pathname === "/api/activar" && req.method === "POST") {
                const body = await readBody();
                if (!body.wsp_id || !body.dias) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta wsp_id o dias" })); }
                // Buscar usuario por número o ID (soporta LID con :device)
                let user = db.getUsuario(body.wsp_id);
                if (!user) {
                    user = db.findUserByNumber(body.wsp_id);
                }
                if (!user) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ ok: false, error: "usuario no encontrado" }));
                }
                // Activar por numero para cubrir todos los formatos de JID
                db.activarMembresiaByNumber(jidToNumber(user.wsp_id), parseInt(body.dias));
                const plan = parseInt(body.dias) === 1 ? "diario" : parseInt(body.dias) === 7 ? "semanal" : "mensual";
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, plan, wsp_id: user.wsp_id, nombre: user.nombre }));
            }

            // POST /api/desactivar — Desactivar/banear usuario WSP { wsp_id }
            if (url.pathname === "/api/desactivar" && req.method === "POST") {
                const body = await readBody();
                if (!body.wsp_id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta wsp_id" })); }
                db.banByNumber(body.wsp_id);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // GET /api/activas — Campañas activas
            if (url.pathname === "/api/activas") {
                const activas = motor.getCampanasActivas ? motor.getCampanasActivas() : [];
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, activas }));
            }

            // GET /api/detectar?u=USER_ID — Detectar grupos de WhatsApp
            if (url.pathname === "/api/detectar" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                if (!botSock) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "bot no conectado" })); }
                try {
                    const allGroups = await botSock.groupFetchAllParticipating();
                    const grupos = [];
                    for (const [jid, meta] of Object.entries(allGroups)) {
                        if (!jid.endsWith("@g.us")) continue;
                        grupos.push({
                            jid,
                            subject: meta.subject || "Sin nombre",
                            size: meta.participants?.length || 0,
                            announce: meta.announce || false,
                        });
                    }
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, grupos }));
                } catch (e) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            }

            // GET /api/detectar_cliente?u=USER_ID&cuenta=NOMBRE — Detectar grupos via cuenta cliente
            if (url.pathname === "/api/detectar_cliente" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                const cuenta = url.searchParams.get("cuenta");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                try {
                    const sesiones = db.getSesiones(userId);
                    if (!sesiones.length) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "sin cuentas vinculadas" })); }
                    const nombre = cuenta || sesiones[0].nombre;
                    const sock = await motor.getOrConnectClient(userId, nombre);
                    const allGroups = await sock.groupFetchAllParticipating();
                    const grupos = [];
                    for (const [jid, meta] of Object.entries(allGroups)) {
                        if (!motor.esGrupoReal(jid, meta)) continue;
                        let link = null;
                        try { link = "https://chat.whatsapp.com/" + (await sock.groupInviteCode(jid)); } catch (e) {}
                        grupos.push({
                            jid,
                            subject: meta.subject || "Sin nombre",
                            size: meta.participants?.length || 0,
                            link,
                        });
                    }
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, grupos, cuenta: nombre }));
                } catch (e) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            }

            // GET /api/mensajes?u=USER_ID — Lista de mensajes guardados
            if (url.pathname === "/api/mensajes" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const mensajes = db.getMensajes(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, mensajes }));
            }

            // POST /api/mensajes/crear — Crear mensaje { u, nombre, texto }
            if (url.pathname === "/api/mensajes/crear" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.nombre || !body.texto) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u, nombre o texto" })); }
                const id = db.crearMensaje(body.u, body.nombre, body.texto, body.imagen_path || null);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, id }));
            }

            // POST /api/mensajes/editar — Editar mensaje { id, texto }
            if (url.pathname === "/api/mensajes/editar" && req.method === "POST") {
                const body = await readBody();
                if (!body.id || !body.texto) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta id o texto" })); }
                db.editarMensaje(body.id, body.texto, body.imagen_path);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // POST /api/mensajes/del — Eliminar mensaje { id }
            if (url.pathname === "/api/mensajes/del" && req.method === "POST") {
                const body = await readBody();
                if (!body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta id" })); }
                db.eliminarMensaje(body.id);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // POST /api/enviar_unico — Enviar mensaje a todos los grupos una sola vez
            if (url.pathname === "/api/enviar_unico" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.mensaje_id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o mensaje_id" })); }
                const msg = db.getMensajeById(body.mensaje_id);
                if (!msg) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "mensaje no encontrado" })); }
                let grupos;
                if (body.grupos_seleccionados && Array.isArray(body.grupos_seleccionados)) {
                    grupos = body.grupos_seleccionados.map(link => ({ link }));
                } else {
                    grupos = db.getGrupos(body.u);
                }
                if (!grupos.length) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "sin grupos" })); }
                const sesiones = db.getSesiones(body.u);
                if (!sesiones.length) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "sin cuentas vinculadas" })); }

                const envioId = db.crearEnvioUnico(body.u, body.mensaje_id, grupos.length);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, envio_id: envioId, grupos: grupos.length }));

                // Enviar en background
                (async () => {
                    let ok = 0, errores = 0;
                    const socks = [];
                    for (const s of sesiones) {
                        try {
                            const sock = await motor.getOrConnectClient(body.u, s.nombre);
                            socks.push(sock);
                        } catch (e) {}
                    }
                    if (!socks.length) {
                        db.actualizarEnvioUnico(envioId, 0, grupos.length, "error");
                        return;
                    }
                    let sockIdx = 0;
                    for (const g of grupos) {
                        const sock = socks[sockIdx % socks.length];
                        sockIdx++;
                        try {
                            const groupJid = await motor.resolveGroupJid ? await motor.resolveGroupJid(sock, g.link) : null;
                            if (!groupJid) { errores++; continue; }
                            const texto = motor.variarMensaje(msg.texto, body.u);
                            const result = await motor.sendToGroup(sock, groupJid, texto, msg.imagen_path);
                            if (result.sent) { ok++; } else { errores++; }
                        } catch (e) { errores++; }
                        // Espera entre envios (5-15s)
                        await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));
                    }
                    db.actualizarEnvioUnico(envioId, ok, errores, "completado");
                })();
                return;
            }

            // GET /api/envios_unicos?u=USER_ID — Historial de envios unicos
            if (url.pathname === "/api/envios_unicos" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const envios = db.getEnviosUnicos(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, envios }));
            }

            // POST /api/mensajes/duplicar — Duplicar mensaje { id }
            if (url.pathname === "/api/mensajes/duplicar" && req.method === "POST") {
                const body = await readBody();
                if (!body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta id" })); }
                const newId = db.duplicarMensaje(body.id);
                if (!newId) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "mensaje no encontrado" })); }
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, id: newId }));
            }

            // GET /api/programados?u=USER_ID — Envios programados
            if (url.pathname === "/api/programados" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const programados = db.getEnviosProgramados(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, programados }));
            }

            // POST /api/programados/crear — Programar envio { u, mensaje_id, hora, minuto, repetir }
            if (url.pathname === "/api/programados/crear" && req.method === "POST") {
                const body = await readBody();
                if (!body.u || !body.mensaje_id || body.hora === undefined || body.minuto === undefined) {
                    res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u, mensaje_id, hora o minuto" }));
                }
                const id = db.crearEnvioProgramado(body.u, body.mensaje_id, body.hora, body.minuto, body.repetir ? 1 : 0);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, id }));
            }

            // POST /api/programados/toggle — Activar/desactivar { id, activo }
            if (url.pathname === "/api/programados/toggle" && req.method === "POST") {
                const body = await readBody();
                if (!body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta id" })); }
                db.toggleEnvioProgramado(body.id, body.activo);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // POST /api/programados/del — Eliminar envio programado { id }
            if (url.pathname === "/api/programados/del" && req.method === "POST") {
                const body = await readBody();
                if (!body.id) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta id" })); }
                db.eliminarEnvioProgramado(body.id);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // GET /api/grupo_stats?u=USER_ID — Estadisticas por grupo
            if (url.pathname === "/api/grupo_stats" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const stats = db.getGrupoStatsResumen(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, stats }));
            }

            // POST /api/autojoin — Auto-unirse a grupos por invite link { u, links: ["https://chat.whatsapp.com/xxx"], cuenta }
            if (url.pathname === "/api/autojoin" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                const links = body.links || [];
                const cuenta = body.cuenta;
                if (!userId || !links.length) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o links" })); }
                try {
                    const sesiones = db.getSesiones(userId);
                    if (!sesiones.length) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "sin cuentas vinculadas" })); }
                    const nombre = cuenta || sesiones[0].nombre;
                    const sock = await motor.getOrConnectClient(userId, nombre);
                    const resultados = [];
                    for (const link of links) {
                        try {
                            const code = link.replace("https://chat.whatsapp.com/", "").trim();
                            if (!code) { resultados.push({ link, ok: false, error: "link inválido" }); continue; }
                            const info = await sock.groupAcceptInvite(code);
                            resultados.push({ link, ok: true, grupo_jid: info });
                            // Agregar a la base de datos
                            db.agregarGrupo(userId, link);
                        } catch (e) {
                            resultados.push({ link, ok: false, error: e.message || "no se pudo unir" });
                        }
                        await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
                    }
                    const ok = resultados.filter(r => r.ok).length;
                    const errores = resultados.filter(r => !r.ok).length;
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, resultados, unidos: ok, fallidos: errores, cuenta: nombre }));
                } catch (e) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            }

            // GET /api/chats_personales?u=USER_ID&cuenta=NOMBRE — Listar chats personales
            if (url.pathname === "/api/chats_personales" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                const cuentaParam = url.searchParams.get("cuenta");
                // Buscar sock: cuenta especifica, botSock, o primera cuenta
                let sock = null;
                let cuentaUsada = null;
                if (cuentaParam && userId) {
                    try { sock = await motor.getOrConnectClient(userId, cuentaParam); cuentaUsada = cuentaParam; } catch (e) {}
                }
                if (!sock) sock = botSock;
                if (!sock && userId) {
                    const sesiones = db.getSesiones(userId);
                    for (const s of sesiones) {
                        try { sock = await motor.getOrConnectClient(userId, s.nombre); cuentaUsada = s.nombre; break; } catch (e) {}
                    }
                }
                if (!sock) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "sin cuenta WSP conectada" })); }
                try {
                    const chats = await motor.listarChatsPersonales(sock, userId);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, total: chats.length, chats, cuenta: cuentaUsada }));
                } catch (e) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            }

            // POST /api/enviar_personal — Enviar mensaje a chats personales
            if (url.pathname === "/api/enviar_personal" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                const mensaje = body.mensaje;
                const cuentaParam = body.cuenta;
                if (!userId || !mensaje) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o mensaje" })); }
                // Buscar sock: cuenta especifica, botSock, o primera cuenta
                let sock = null;
                if (cuentaParam && userId) {
                    try { sock = await motor.getOrConnectClient(userId, cuentaParam); } catch (e) {}
                }
                if (!sock) sock = botSock;
                if (!sock) {
                    const sesiones = db.getSesiones(userId);
                    for (const s of sesiones) {
                        try { sock = await motor.getOrConnectClient(userId, s.nombre); break; } catch (e) {}
                    }
                }
                if (!sock) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "sin cuenta WSP conectada" })); }
                // Verificar si ya hay envio activo
                if (motor.envioPersonalActivo[userId]) {
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: false, error: "ya hay un envio activo. Usa /wspcancelarpersonal para cancelarlo." }));
                }
                // Fire-and-forget: iniciar envio en background
                motor.enviarAPersonales(userId, mensaje, null, sock).catch(e => {
                    console.error(`Error en envio personal: ${e.message}`);
                });
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, message: "envio iniciado" }));
            }

            // POST /api/cancelar_envio_personal — Cancelar envio personal
            if (url.pathname === "/api/cancelar_envio_personal" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const stopped = motor.detenerEnvioPersonal(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: stopped }));
            }

            // GET /api/miembros_grupo?u=USER_ID&grupo=GROUP_JID&cuenta=NOMBRE — Listar miembros de un grupo
            if (url.pathname === "/api/miembros_grupo" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                const grupoJid = url.searchParams.get("grupo");
                const cuentaParam = url.searchParams.get("cuenta");
                if (!userId || !grupoJid) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o grupo" })); }
                let sock = null;
                if (cuentaParam) {
                    try { sock = await motor.getOrConnectClient(userId, cuentaParam); } catch (e) {}
                }
                if (!sock) sock = botSock;
                if (!sock) {
                    const sesiones = db.getSesiones(userId);
                    for (const s of sesiones) {
                        try { sock = await motor.getOrConnectClient(userId, s.nombre); break; } catch (e) {}
                    }
                }
                if (!sock) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "sin cuenta WSP conectada" })); }
                try {
                    const miembros = await motor.listarMiembrosGrupo(sock, grupoJid);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, total: miembros.length, miembros }));
                } catch (e) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            }

            // POST /api/enviar_miembros — Enviar DM a miembros de un grupo
            if (url.pathname === "/api/enviar_miembros" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                const grupoJid = body.grupo;
                const mensaje = body.mensaje;
                if (!userId || !grupoJid || !mensaje) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u, grupo o mensaje" })); }
                let sock = botSock;
                if (!sock) {
                    const sesiones = db.getSesiones(userId);
                    for (const s of sesiones) {
                        try { sock = await motor.getOrConnectClient(userId, s.nombre); break; } catch (e) {}
                    }
                }
                if (!sock) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "sin cuenta WSP conectada" })); }
                // Verificar si ya hay envio activo
                if (motor.envioPersonalActivo[userId]) {
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: false, error: "ya hay un envio activo. Usa /wspcancelarpersonal para cancelarlo." }));
                }
                // Fire-and-forget: iniciar envio en background
                motor.enviarAMiembrosGrupo(userId, grupoJid, mensaje, null, sock).catch(e => {
                    console.error(`Error en envio a miembros: ${e.message}`);
                });
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, message: "envio a miembros iniciado" }));
            }

            // GET /api/envio_config?u=USER_ID — Obtener config de envio
            if (url.pathname === "/api/envio_config" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const cfg = db.getEnvioConfig(userId);
                const horario = db.getHorarioEnvio(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, config: cfg, horario }));
            }

            // POST /api/envio_config — Actualizar config de envio
            if (url.pathname === "/api/envio_config" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                if (body.delay_seg !== undefined) {
                    db.setEnvioConfig(userId, body.delay_seg || 10, body.lote_tamano || 0, body.lote_pausa_seg || 300);
                }
                if (body.hora_inicio !== undefined) {
                    db.setHorarioEnvio(userId, body.hora_inicio || 0, body.hora_fin || 24);
                }
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true }));
            }

            // GET /api/lista_negra?u=USER_ID — Obtener lista negra
            if (url.pathname === "/api/lista_negra" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const lista = db.getListaNegra(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, total: lista.length, numeros: lista }));
            }

            // POST /api/lista_negra — Agregar/eliminar de lista negra
            if (url.pathname === "/api/lista_negra" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                const accion = body.accion; // "agregar", "eliminar", "limpiar"
                if (!userId || !accion) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o accion" })); }
                if (accion === "agregar") {
                    const ok = db.agregarListaNegra(userId, body.numero, body.razon);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok, message: ok ? "agregado" : "ya existe" }));
                } else if (accion === "eliminar") {
                    const ok = db.eliminarListaNegra(userId, body.numero);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok }));
                } else if (accion === "limpiar") {
                    const count = db.limpiarListaNegra(userId);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, eliminados: count }));
                }
                res.writeHead(400);
                return res.end(JSON.stringify({ ok: false, error: "accion invalida" }));
            }

            // GET /api/auto_respuestas?u=USER_ID — Listar auto respuestas
            if (url.pathname === "/api/auto_respuestas" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const lista = db.getAutoRespuestas(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, total: lista.length, respuestas: lista }));
            }

            // POST /api/auto_respuestas — CRUD auto respuestas
            if (url.pathname === "/api/auto_respuestas" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                const accion = body.accion;
                if (!userId || !accion) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u o accion" })); }
                if (accion === "agregar") {
                    const ok = db.agregarAutoRespuesta(userId, body.palabra_clave, body.respuesta);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok, message: ok ? "agregado" : "ya existe" }));
                } else if (accion === "eliminar") {
                    const ok = db.eliminarAutoRespuesta(userId, body.id);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok }));
                } else if (accion === "limpiar") {
                    const count = db.limpiarAutoRespuestas(userId);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: true, eliminados: count }));
                }
                res.writeHead(400);
                return res.end(JSON.stringify({ ok: false, error: "accion invalida" }));
            }

            // POST /api/enviar_a_lista — Enviar a lista de numeros especificos
            if (url.pathname === "/api/enviar_a_lista" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                const numeros = body.numeros; // array de numeros
                const mensaje = body.mensaje;
                if (!userId || !numeros || !mensaje) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u, numeros o mensaje" })); }
                let sock = botSock;
                if (!sock) {
                    const sesiones = db.getSesiones(userId);
                    for (const s of sesiones) {
                        try { sock = await motor.getOrConnectClient(userId, s.nombre); break; } catch (e) {}
                    }
                }
                if (!sock) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "sin cuenta WSP conectada" })); }
                if (motor.envioPersonalActivo[userId]) {
                    res.writeHead(200);
                    return res.end(JSON.stringify({ ok: false, error: "ya hay un envio activo" }));
                }
                const jids = numeros.map(n => n.replace(/[^0-9]/g, "") + "@s.whatsapp.net");
                motor.enviarASeleccionados(userId, jids, mensaje, body.media_path || null, sock).catch(e => {
                    console.error(`Error en envio a lista: ${e.message}`);
                });
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, message: `envio iniciado a ${jids.length} numero(s)` }));
            }

            // GET /panel — Panel web completo (sirve panel.html)
            if (url.pathname === "/panel" && req.method === "GET") {
                try {
                    const fs = require("fs");
                    const path = require("path");
                    const html = fs.readFileSync(path.join(__dirname, "panel.html"), "utf-8");
                    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                    return res.end(html);
                } catch (e) {
                    res.writeHead(500);
                    return res.end("Error cargando panel: " + e.message);
                }
            }

            // (panel legacy - removed, now served from panel.html)
            if (false) {
                const userId = null;
                const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot de Spam J&D - Panel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;background:#0f0f23;color:#e0e0e0;min-height:100vh}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:20px;text-align:center;border-bottom:2px solid #0f3460}
.header h1{color:#e94560;font-size:24px}
.container{max-width:1200px;margin:20px auto;padding:0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-top:20px}
.card{background:#16213e;border-radius:12px;padding:20px;border:1px solid #0f3460;transition:transform 0.2s}
.card:hover{transform:translateY(-2px)}
.card h3{color:#e94560;margin-bottom:10px;font-size:16px}
.stat{font-size:32px;font-weight:bold;color:#4ade80}
.stat.warn{color:#fbbf24}
.stat.danger{color:#ef4444}
.input-group{margin:10px 0}
.input-group label{display:block;margin-bottom:5px;color:#94a3b8}
.input-group input,.input-group select{width:100%;padding:8px 12px;border:1px solid #0f3460;border-radius:6px;background:#1a1a2e;color:#e0e0e0}
.btn{padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;margin:5px}
.btn-primary{background:#e94560;color:white}
.btn-secondary{background:#0f3460;color:white}
.btn:hover{opacity:0.8}
.table{width:100%;border-collapse:collapse;margin-top:10px}
.table th,.table td{padding:8px 12px;text-align:left;border-bottom:1px solid #0f3460}
.table th{color:#e94560}
.status-bar{display:flex;gap:20px;margin:15px 0;flex-wrap:wrap}
.status-item{display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%}
.dot.green{background:#4ade80}
.dot.red{background:#ef4444}
.dot.yellow{background:#fbbf24}
#userId{padding:10px;border:1px solid #0f3460;border-radius:6px;background:#1a1a2e;color:white;width:250px;margin:10px}
.section{margin:30px 0}
.section h2{color:#e94560;border-bottom:1px solid #0f3460;padding-bottom:10px;margin-bottom:15px}
</style>
</head>
<body>
<div class="header"><h1>🤖 Bot de Spam J&D v2.0 — Panel de Control</h1></div>
<div class="container">
<div style="text-align:center;margin:20px 0">
<label style="color:#94a3b8">Tu User ID: </label>
<input id="userId" placeholder="Ingresa tu User ID" value="${userId || ""}">
<button class="btn btn-primary" onclick="loadAll()">Cargar</button>
</div>
<div class="grid">
<div class="card"><h3>📊 Reporte del Dia</h3><div id="reporte">Cargando...</div></div>
<div class="card"><h3>📈 Tasa de Entrega</h3><div id="tasa">Cargando...</div></div>
<div class="card"><h3>⚙ Config de Envio</h3><div id="config">Cargando...</div></div>
<div class="card"><h3>🚫 Lista Negra</h3><div id="listaNegra">Cargando...</div></div>
<div class="card"><h3>🤖 Auto-Respuestas</h3><div id="autoResp">Cargando...</div></div>
<div class="card"><h3>📱 Estado del Sistema</h3><div id="status">Cargando...</div></div>
</div>
</div>
<script>
const API='';
function uid(){return document.getElementById('userId').value}
async function api(path){
  try{const r=await fetch(API+path);return await r.json()}catch(e){return{ok:false,error:e.message}}
}
async function loadAll(){
  const u=uid();if(!u){alert('Ingresa tu User ID');return}
  const m=await api('/api/check_membresia?u='+u);
  if(!m.ok||!m.activa){document.body.innerHTML='<div style="text-align:center;padding:100px;font-family:sans-serif;background:#0f0f23;color:#e94560;min-height:100vh"><h1>⛔ Membresía expirada</h1><p style="color:#e0e0e0;margin-top:20px">Tu membresía ha expirado o no está activa.<br>Contacta al administrador para renovar.</p></div>';return}
  loadReporte(u);loadTasa(u);loadConfig(u);loadListaNegra(u);loadAutoResp(u);loadStatus();
}
async function loadReporte(u){
  const r=await api('/api/reporte_diario?u='+u);
  document.getElementById('reporte').innerHTML=r.ok?
    '<div class="stat">'+r.totalEnvios+'</div>Total envios<br>✅ '+r.exitosos+' exitosos | ❌ '+r.fallidos+' fallidos<br>💬 '+r.respuestas+' respuestas':'Sin datos';
}
async function loadTasa(u){
  const r=await api('/api/tasa_entrega?u='+u);
  document.getElementById('tasa').innerHTML=r.ok?
    '<div class="stat">'+r.tasa_entrega+'%</div>Tasa entrega<br>📨 '+r.total+' enviados | ✅ '+r.entregados+' entregados<br>👁 '+r.leidos+' leidos ('+r.tasa_lectura+'%)':'Sin datos';
}
async function loadConfig(u){
  const r=await api('/api/envio_config?u='+u);
  if(!r.ok){document.getElementById('config').innerHTML='Error';return}
  const c=r.config||{},h=r.horario||{};
  document.getElementById('config').innerHTML=
    '⏱ Delay: <b>'+c.delay_seg+'s</b><br>'+
    '📦 Lotes: <b>'+(c.lote_tamano>0?c.lote_tamano+' envios, pausa '+c.lote_pausa_seg+'s':'Desactivado')+'</b><br>'+
    '🕐 Horario: <b>'+(h.hora_inicio===0&&h.hora_fin===24?'24h':h.hora_inicio+':00-'+h.hora_fin+':00')+'</b>';
}
async function loadListaNegra(u){
  const r=await api('/api/lista_negra?u='+u);
  document.getElementById('listaNegra').innerHTML=r.ok?
    '<div class="stat'+(r.total>0?' warn':'')+'">'+ r.total+'</div>numeros bloqueados':'Sin datos';
}
async function loadAutoResp(u){
  const r=await api('/api/auto_respuestas?u='+u);
  document.getElementById('autoResp').innerHTML=r.ok?
    '<div class="stat">'+r.total+'</div>reglas activas':'Sin datos';
}
async function loadStatus(){
  const r=await api('/api/status');
  const s=r.ok?r:{};
  document.getElementById('status').innerHTML=
    '<div class="status-bar">'+
    '<div class="status-item"><div class="dot '+(s.botOnline?'green':'red')+'"></div>Bot '+(s.botOnline?'Online':'Offline')+'</div>'+
    '</div>Cuentas: '+(s.sesiones||0);
}
if(uid())loadAll();
</script>
</body></html>`;
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                return res.end(html);
            }

            // GET /api/tasa_entrega?u=USER_ID — Tasa de entrega/lectura
            if (url.pathname === "/api/tasa_entrega" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const tasa = db.getTasaEntrega(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, ...tasa }));
            }

            // GET /api/reporte_diario?u=USER_ID — Reporte del dia
            if (url.pathname === "/api/reporte_diario" && req.method === "GET") {
                const userId = url.searchParams.get("u");
                if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const reporte = db.getReporteDiario(userId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, ...reporte }));
            }

            // POST /api/agregar_miembros — Agregar miembros de un grupo a otro
            if (url.pathname === "/api/agregar_miembros" && req.method === "POST") {
                const body = await readBody();
                const userId = body.u;
                const grupoOrigen = body.origen;
                const grupoDestino = body.destino;
                if (!userId || !grupoOrigen || !grupoDestino) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u, origen o destino" })); }
                let sock = botSock;
                if (!sock) {
                    const sesiones = db.getSesiones(userId);
                    for (const s of sesiones) {
                        try { sock = await motor.getOrConnectClient(userId, s.nombre); break; } catch (e) {}
                    }
                }
                if (!sock) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "sin cuenta WSP conectada" })); }
                try {
                    const result = await motor.agregarMiembrosAGrupo(sock, grupoOrigen, grupoDestino, userId);
                    res.writeHead(200);
                    return res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            }

            // GET /api/check_membresia?u=TELEGRAM_ID — Verificar membresía
            if (url.pathname === "/api/check_membresia" && req.method === "GET") {
                const telegramId = url.searchParams.get("u");
                if (!telegramId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta u" })); }
                const activa = db.checkMembresiaTg(telegramId);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, activa }));
            }

            // POST /api/panel_registro — Registrar usuario del panel
            if (url.pathname === "/api/panel_registro" && req.method === "POST") {
                const body = await readBody();
                if (!body.telegram_id || !body.password) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta telegram_id o password" })); }
                const activa = db.checkMembresiaTg(body.telegram_id);
                if (!activa) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "no_membresia" })); }
                const existing = db.getPanelUser(body.telegram_id);
                if (existing) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: "ya_registrado" })); }
                const crypto = require("crypto");
                const hash = crypto.createHash("sha256").update(body.password).digest("hex");
                db.registrarPanelUser(body.telegram_id, hash);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, msg: "Registro exitoso" }));
            }

            // POST /api/panel_login — Login del panel
            if (url.pathname === "/api/panel_login" && req.method === "POST") {
                const body = await readBody();
                if (!body.telegram_id || !body.password) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "falta telegram_id o password" })); }
                const activa = db.checkMembresiaTg(body.telegram_id);
                if (!activa) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "no_membresia" })); }
                const user = db.getPanelUser(body.telegram_id);
                if (!user) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "no_registrado" })); }
                const crypto = require("crypto");
                const hash = crypto.createHash("sha256").update(body.password).digest("hex");
                if (user.password !== hash) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error: "password_incorrecta" })); }
                const token = crypto.randomBytes(32).toString("hex");
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, token, telegram_id: body.telegram_id }));
            }

            // POST /api/panel_cambiar_password — Cambiar contraseña
            if (url.pathname === "/api/panel_cambiar_password" && req.method === "POST") {
                const body = await readBody();
                if (!body.telegram_id || !body.old_password || !body.new_password) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "faltan campos" })); }
                const user = db.getPanelUser(body.telegram_id);
                if (!user) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "no_registrado" })); }
                const crypto = require("crypto");
                const oldHash = crypto.createHash("sha256").update(body.old_password).digest("hex");
                if (user.password !== oldHash) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error: "password_incorrecta" })); }
                const newHash = crypto.createHash("sha256").update(body.new_password).digest("hex");
                db.registrarPanelUser(body.telegram_id, newHash);
                res.writeHead(200);
                return res.end(JSON.stringify({ ok: true, msg: "Password actualizada" }));
            }

            // Endpoint no encontrado
            res.writeHead(404);
            return res.end(JSON.stringify({ ok: false, error: "endpoint no encontrado" }));

        } catch (e) {
            res.writeHead(500);
            return res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    }

    // API para estado del bot (JSON)
    if (url.pathname === "/bot-status") {
        let qrImg = "";
        if (currentQR) {
            try { qrImg = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 }); } catch (e) {}
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: botStatus, qr: qrImg }));
    }

    // Pagina principal del bot
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>WhatsApp Bot J&D</title>
<style>
body{background:#111;color:#fff;font-family:Arial;text-align:center;padding:40px}
.box{background:#1a1a2e;border-radius:16px;padding:30px;max-width:400px;margin:0 auto}
.status{padding:10px;border-radius:8px;margin:10px 0;font-weight:bold}
.connected{background:#0a3d0a;color:#4caf50}
.waiting{background:#3d3d0a;color:#ffeb3b}
.disconnected{background:#3d0a0a;color:#f44336}
.instructions{text-align:left;margin:15px 0;font-size:14px}
</style></head><body>
<div class="box">
<h1>\u{1F6E1} Bot WhatsApp J&D</h1>
<div id="content"><div class="status disconnected">\u{1F4E1} Conectando...</div><p>Espera unos segundos.</p></div>
</div>
<script>
let lastQr = "";
async function poll() {
    try {
        const r = await fetch("/bot-status");
        const d = await r.json();
        const el = document.getElementById("content");
        if (d.status === "conectado") {
            el.innerHTML = '<div class="status connected">\u2705 CONECTADO \u2014 Bot funcionando</div><p>Ya puedes cerrar esta pagina.</p>';
            return;
        } else if (d.status === "esperando_qr" && d.qr) {
            if (d.qr !== lastQr) { lastQr = d.qr;
            el.innerHTML = '<div class="status waiting">\u23F3 Escanea el QR con tu celular</div>' +
                '<img src="' + d.qr + '" width="300" height="300">' +
                '<div class="instructions"><strong>\u{1F4F2} Instrucciones:</strong><ol>' +
                '<li>Abre <strong>WhatsApp</strong> en tu celular</li>' +
                '<li>Ve a <strong>Ajustes > Dispositivos vinculados</strong></li>' +
                '<li>Toca <strong>Vincular dispositivo</strong></li>' +
                '<li><strong>Escanea este QR</strong></li></ol></div>'; }
        } else {
            el.innerHTML = '<div class="status disconnected">\u{1F4E1} Conectando al servidor...</div><p>Espera unos segundos...</p>';
        }
    } catch (e) {}
    setTimeout(poll, 3000);
}
poll();
</script>
</body></html>`);
});

server.listen(QR_PORT, "0.0.0.0", () => {
    console.log(`\u{1F310} Servidor QR en http://0.0.0.0:${QR_PORT}`);
});

// --- INICIO DEL BOT ---
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("sessions");

    let version;
    try {
        const { version: v } = await fetchLatestBaileysVersion();
        version = v;
    } catch (e) {}

    botSock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        version,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2000,
    });

    botSock.ev.on("creds.update", saveCreds);

    botSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            botStatus = "esperando_qr";
            console.log("\u{1F4F1} QR generado. Escanea desde la pagina web.");
        }

        if (connection === "open") {
            currentQR = null;
            botStatus = "conectado";
            console.log("\n\u2705 Bot de WhatsApp J&D conectado exitosamente!");

            motor.setBotSocket(botSock);
            console.log(`\u{1F4F1} Bot disponible como cuenta de spam: '${motor.BOT_NOMBRE}'`);
            console.log("\u{1F4F1} Listo para recibir mensajes.\n");

            // Resolver JID del admin
            try {
                const results = await botSock.onWhatsApp(config.ADMIN_NUMBER + "@s.whatsapp.net");
                if (results && results.length > 0) {
                    addAdminJid(results[0].jid);
                    console.log(`\u{1F451} Admin JID resuelto: ${results[0].jid}`);
                }
                if (config.BOT_NUMBER) {
                    const botResults = await botSock.onWhatsApp(config.BOT_NUMBER + "@s.whatsapp.net");
                    if (botResults && botResults.length > 0) {
                        addAdminJid(botResults[0].jid);
                        console.log(`\u{1F451} Bot JID resuelto: ${botResults[0].jid}`);
                    }
                }
            } catch (e) {
                console.log(`   (No se pudo resolver admin JID: ${e.message})`);
            }
        }

        if (connection === "close") {
            botStatus = "desconectado";
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                console.log("\u274C Bot deslogueado. Borrando sesion...");
                try { fs.rmSync("sessions", { recursive: true, force: true }); } catch (e) {}
            }
            console.log(`\u{1F504} Reconectando bot... (codigo: ${code})`);
            setTimeout(startBot, 5000);
        }
    });

    // --- RECEPCION DE MENSAJES ---
    botSock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
            if (!msg.message) continue;
            const jid = msg.key.remoteJid;
            if (!jid || jid === "status@broadcast") continue;

            // Si es mensaje enviado por el bot, ignorar
            if (msg.key.id && botSentIds.has(msg.key.id)) continue;
            if (botIsSending && msg.key.fromMe) continue;

            // Grupos: solo permitir comandos admin
            if (jid.endsWith("@g.us")) {
                const participant = msg.key.participant;
                if (!participant || !isAdmin(participant)) continue;
                const grpText = msg.message.conversation
                    || msg.message.extendedTextMessage?.text
                    || "";
                const grpTrimmed = grpText.trim();
                if (!grpTrimmed.startsWith("/")) continue;

                if (grpTrimmed.toLowerCase() === "/registrargrupo") {
                    setAdminGroup(jid);
                    await send(jid, "\u2705 Este grupo ha sido registrado como *Grupo Admin*.\n\nAqui recibiras las solicitudes de pago y puedes usar comandos como:\n/activar [codigo] [dias]\n/desactivar [codigo]\n/ban [codigo]\n/usuarios");
                    continue;
                }

                if (!adminGroupJid || jid !== adminGroupJid) continue;
                console.log(`   \u2705 Admin cmd desde grupo: "${grpTrimmed}"`);
                try {
                    await handleAdminGroupCmd(jid, participant, grpTrimmed);
                } catch (e) {
                    console.error("Error cmd grupo admin:", e.message);
                }
                continue;
            }

            // Deduplicar
            if (msg.key.id && processedMsgIds.has(msg.key.id)) continue;
            if (msg.key.id) {
                processedMsgIds.add(msg.key.id);
                setTimeout(() => processedMsgIds.delete(msg.key.id), 60000);
            }

            const text = msg.message.conversation
                || msg.message.extendedTextMessage?.text
                || msg.message.imageMessage?.caption
                || "";

            const pushName = msg.pushName || jidToNumber(jid);
            console.log(`\u{1F4E9} Mensaje: fromMe=${msg.key.fromMe}, jid=${jid}, texto="${text.substring(0,50)}", isAdmin=${isAdmin(jid)}`);

            if (msg.key.fromMe) {
                if (!isAdmin(jid)) continue;
                const trimCheck = text.trim();
                if (!trimCheck.startsWith("/")) continue;
                console.log(`   \u2705 Admin cmd self: "${trimCheck}"`);
            }

            try {
                db.crearUsuario(jid, pushName);
                await handleMessage(jid, msg);
            } catch (e) {
                console.error(`Error procesando mensaje: ${e.message}`);
            }
        }
    });
}

// --- HANDLER COMANDOS ADMIN DESDE GRUPO ---
async function handleAdminGroupCmd(groupJid, participantJid, text) {
    const cleanText = text.replace(/^\//, "").trim();
    const cleanLower = cleanText.toLowerCase();

    if (text.trim().toLowerCase() === "/registrargrupo") {
        setAdminGroup(groupJid);
        return await send(groupJid, "\u2705 Este grupo ha sido registrado como *Grupo Admin*.\n\nAqui recibiras las solicitudes de pago y puedes usar comandos como:\n/activar [codigo] [dias]\n/desactivar [codigo]\n/ban [codigo]\n/usuarios");
    }

    if (cleanLower.startsWith("activar ")) {
        return await adminActivar(groupJid, cleanText);
    }
    if (cleanLower.startsWith("desactivar ")) {
        return await adminDesactivar(groupJid, cleanText);
    }
    if (cleanLower.startsWith("ban ")) {
        return await adminBan(groupJid, cleanText);
    }
    if (cleanLower === "usuarios") {
        return await adminUsuarios(groupJid);
    }
    if (cleanLower === "admin") {
        return await showAdmin(groupJid);
    }

    await send(groupJid, "Comando no reconocido.\n\nComandos:\n/activar [codigo] [dias]\n/desactivar [codigo]\n/ban [codigo]\n/usuarios\n/admin");
}

// --- HANDLER PRINCIPAL ---
async function handleMessage(jid, msg) {
    const text = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || "";
    const pushName = msg.pushName || jidToNumber(jid);
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const state = getState(jid);

    // Limpiar asteriscos de formato bold
    const cleanText = trimmed.replace(/^\*+|\*+$/g, "").trim();
    const cleanLower = cleanText.toLowerCase();

    // Cancelar envio personal
    if (lower === "cancelar envio" || lower === "cancelarenvio") {
        const stopped = motor.detenerEnvioPersonal(jid);
        if (stopped) return await send(jid, "\u{1F6D1} Envio personal cancelado.");
        return await send(jid, "\u274C No hay envio personal activo.");
    }

    // Volver al menu
    if (lower === "0" || lower === "menu" || lower === "volver") {
        clearState(jid);
        return await sendMainMenu(jid, pushName);
    }

    // Comando /soyadmin
    if (lower === "/soyadmin" || lower.startsWith("/soyadmin ")) {
        const parts = trimmed.split(/\s+/);
        const clave = parts[1] || "";
        if (clave === config.ADMIN_NUMBER) {
            addAdminJid(jid);
            return await send(jid, `\u2705 *Admin registrado!*\n\nTu JID (${jid}) ha sido guardado.\nAhora tienes acceso de admin y membresia ilimitada.\n\nEscribe *menu* para ver el menu.`);
        } else {
            return await send(jid, `\u274C Clave incorrecta.\n\nUso: /soyadmin [ADMIN_NUMBER]\nEj: /soyadmin ${config.ADMIN_NUMBER.substring(0,4)}...`);
        }
    }

    // Comandos admin con / (funcionan SIEMPRE)
    if (isAdmin(jid) && (cleanLower.startsWith("/activar ") || cleanLower.startsWith("activar "))) {
        clearState(jid);
        const cmdText = cleanText.replace(/^\//, "");
        return await adminActivar(jid, cmdText);
    }
    if (isAdmin(jid) && (cleanLower.startsWith("/desactivar ") || cleanLower.startsWith("desactivar "))) {
        clearState(jid);
        const cmdText = cleanText.replace(/^\//, "");
        return await adminDesactivar(jid, cmdText);
    }
    if (isAdmin(jid) && (cleanLower.startsWith("/ban ") || cleanLower.startsWith("ban "))) {
        clearState(jid);
        const cmdText = cleanText.replace(/^\//, "");
        return await adminBan(jid, cmdText);
    }
    if (isAdmin(jid) && cleanLower.startsWith("/desmarcarban ")) {
        clearState(jid);
        const cuentaNombre = cleanText.replace(/^\/desmarcarban\s+/i, "").trim();
        db.desmarcarCuentaBaneada(jid, cuentaNombre);
        return await send(jid, `\u2705 Cuenta '${cuentaNombre}' desmarcada como baneada.`);
    }
    if (isAdmin(jid) && (lower === "/usuarios" || lower === "usuarios")) {
        clearState(jid);
        return await adminUsuarios(jid);
    }
    if (isAdmin(jid) && (lower === "/admin" || lower === "admin")) {
        clearState(jid);
        return await showAdmin(jid);
    }

    // Si hay un estado FSM activo, manejar ahi
    if (state.screen) {
        return await handleFSM(jid, msg, text, trimmed, state);
    }

    // Comandos con /
    if (lower.startsWith("/")) {
        const cmd = lower.replace(/^\//, "");
        if (cmd === "cmds" || cmd === "comandos" || cmd === "help") return await showCmds(jid);
        if (isAdmin(jid)) {
            switch (cmd) {
                case "cuentas": return await showCuentas(jid);
                case "grupos": return await showGrupos(jid);
                case "campanas": case "campana": return await showCampanas(jid);
                case "iniciar": case "start_camp": return await showIniciar(jid);
                case "detener": case "stop": return await showDetener(jid);
                case "responder": case "autoresponder": return await showResponder(jid);
                case "intervalo": return await showIntervalo(jid);
                case "historial": case "stats": return await showHistorial(jid);
                case "dashboard": case "dash": return await showDashboard(jid);
                case "eliminar": case "borrar": return await showEliminar(jid);
                case "templates": case "template": return await showTemplates(jid);
                case "blacklist": return await showBlacklist(jid);
                case "grupostats": case "estadisticas": return await showGrupoStats(jid);
                case "horario": return await showHorario(jid);
                case "sinonimos": return await showSinonimos(jid);
                case "exportar": case "importar": return await showExportar(jid);
                case "limitediario": case "limite": return await showLimiteDiario(jid);
                case "reporte": return await showReporteDiario(jid);
                case "personal": case "enviopersonal": return await showEnvioPersonal(jid);
                case "cancelarenvio": {
                    const stopped = motor.detenerEnvioPersonal(jid);
                    if (stopped) return await send(jid, "\u{1F6D1} Envio personal cancelado.");
                    return await send(jid, "\u274C No hay envio personal activo.");
                }
            }
        }
        switch (cmd) {
            case "menu": return await sendMainMenu(jid, pushName);
            case "membresia": case "mem": return await showMembresia(jid);
            case "planes": case "pagar": return await showPlanes(jid);
            case "guia": return await showGuia(jid);
            case "me": case "perfil": return await showPerfil(jid, pushName);
            case "start": return await sendMainMenu(jid, pushName);
            case "reporte": return await showReporteDiario(jid);
        }
        return;
    }

    // Menu principal por numero
    const esAdmin = isAdmin(jid);
    if (esAdmin) {
        switch (lower) {
            case "menu": case "hola": case "hi": case "start":
                return await sendMainMenu(jid, pushName);
            case "1": return await showCuentas(jid);
            case "2": return await showGrupos(jid);
            case "3": return await showCampanas(jid);
            case "4": return await showIniciar(jid);
            case "5": return await showDetener(jid);
            case "6": return await showResponder(jid);
            case "7": return await showIntervalo(jid);
            case "8": return await showHistorial(jid);
            case "9": return await showMembresia(jid);
            case "10": return await showPlanes(jid);
            case "11": return await showDashboard(jid);
            case "12": return await showEliminar(jid);
            case "13": return await showGuia(jid);
            case "me": case "perfil": case "mi perfil": case "14":
                return await showPerfil(jid, pushName);
            case "15": return await showTemplates(jid);
            case "16": return await showBlacklist(jid);
            case "17": return await showGrupoStats(jid);
            case "18": return await showHorario(jid);
            case "19": return await showSinonimos(jid);
            case "20": return await showExportar(jid);
            case "21": return await showLimiteDiario(jid);
            case "22": return await showReporteDiario(jid);
            default:
                return;
        }
    } else {
        switch (lower) {
            case "menu": case "hola": case "hi": case "start":
                return await sendMainMenu(jid, pushName);
            case "1": return await showMembresia(jid);
            case "2": return await showPlanes(jid);
            case "3": return await showGuia(jid);
            case "me": case "perfil": case "mi perfil": case "4":
                return await showPerfil(jid, pushName);
            default:
                return;
        }
    }
}

// --- MENU PRINCIPAL ---
async function sendMainMenu(jid, nombre) {
    clearState(jid);
    const user = db.getUsuario(jid);
    const userCodigo = user ? (user.codigo || "---") : "---";
    let membresiaMsg;
    if (isAdmin(jid)) {
        membresiaMsg = "\u{1F451} Administrador \u2014 Acceso total";
    } else if (db.tieneMembresia(jid)) {
        const u = db.getUsuario(jid);
        membresiaMsg = `Plan ${u.plan} \u2014 Expira: ${u.fecha_expira}`;
    } else {
        membresiaMsg = "\u26D4 Sin membresia \u2014 Responde 10";
    }

    if (isAdmin(jid)) {
        await send(jid,
            `\u{1F6E1} *BOT J&D \u2014 ADMIN* \u{1F6E1}\n` +
            `Sistema Pro de Difusion WSP\n\n` +
            `Hola ${nombre}! \u{1F451}\n` +
            `${membresiaMsg}\n\n` +
            `\u2501\u2501 *SPAM* \u2501\u2501\n` +
            `*1.* \u{1F464} Cuentas — /cuentas\n` +
            `*2.* \u{1F310} Grupos — /grupos\n` +
            `*3.* \u{1F4CB} Campa\u00F1as — /campanas\n` +
            `*4.* \u{1F680} Iniciar — /iniciar\n` +
            `*5.* \u{1F6D1} Detener — /detener\n` +
            `*6.* \u{1F916} Responder — /responder\n` +
            `*7.* \u23F1 Intervalo — /intervalo\n` +
            `*8.* \u{1F4CA} Historial — /historial\n\n` +
            `\u2501\u2501 *GENERAL* \u2501\u2501\n` +
            `*9.* \u23F0 Membres\u00EDa — /membresia\n` +
            `*10.* \u{1F4B3} Planes — /planes\n` +
            `*11.* \u{1F4CA} Dashboard — /dashboard\n` +
            `*12.* \u{1F5D1} Eliminar — /eliminar\n` +
            `*13.* \u{1F4D6} Gu\u00EDa — /guia\n` +
            `*14.* \u{1F464} Mi perfil — /perfil\n\n` +
            `\u2501\u2501 *PRO* \u2501\u2501\n` +
            `*15.* \u{1F4DD} Templates — /templates\n` +
            `*16.* \u{1F6AB} Blacklist — /blacklist\n` +
            `*17.* \u{1F4CA} Stats grupo — /grupostats\n` +
            `*18.* \u{1F553} Horario — /horario\n` +
            `*19.* \u{1F504} Sinonimos — /sinonimos\n` +
            `*20.* \u{1F4E6} Exportar — /exportar\n` +
            `*21.* \u{1F6E1} Limite — /limitediario\n` +
            `*22.* \u{1F4CA} Reporte — /reporte\n` +
            `*23.* \u{1F4E8} Envio Personal — /personal\n\n` +
            `Escribe /start para comenzar`
        );
    } else {
        await send(jid,
            `\u{1F6E1} *BOT J&D* \u{1F6E1}\n` +
            `Sistema Pro de Difusion WSP\n\n` +
            `Hola ${nombre}! \u{1F44B}\n` +
            `\u{1F3F7} Tu codigo: *${userCodigo}*\n` +
            `${membresiaMsg}\n\n` +
            `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
            `Responde con el *numero*:\n\n` +
            `*1.* \u23F0 Membres\u00EDa — /membresia\n` +
            `*2.* \u{1F4B3} Planes — /planes\n` +
            `*3.* \u{1F4D6} Gu\u00EDa — /guia\n` +
            `*4.* \u{1F464} Mi perfil — /perfil\n\n` +
            `Escribe /start para comenzar`
        );
    }
}

// --- COMANDOS (/cmds) ---
async function showCmds(jid) {
    let texto = `\u{1F4AC} *COMANDOS DISPONIBLES*\n\n`;
    texto += `\u2501\u2501 *GENERALES* \u2501\u2501\n`;
    texto += `/menu \u2014 Menu principal\n`;
    texto += `/membresia, /mem \u2014 Ver membresia\n`;
    texto += `/planes, /pagar \u2014 Ver planes y pagar\n`;
    texto += `/guia \u2014 Guia de uso\n`;
    texto += `/me, /perfil \u2014 Mi perfil\n`;
    texto += `/cmds, /comandos \u2014 Esta lista\n`;

    if (isAdmin(jid)) {
        texto += `\n\u2501\u2501 *SPAM (Admin)* \u2501\u2501\n`;
        texto += `/cuentas \u2014 Gestionar cuentas WSP\n`;
        texto += `/grupos \u2014 Gestionar grupos objetivo\n`;
        texto += `/campanas \u2014 Crear/ver campanas\n`;
        texto += `/iniciar \u2014 Iniciar campana\n`;
        texto += `/detener, /stop \u2014 Detener campana\n`;
        texto += `/responder \u2014 Auto-responder\n`;
        texto += `/intervalo \u2014 Configurar intervalo\n`;
        texto += `/historial, /stats \u2014 Historial envios\n`;
        texto += `/dashboard, /dash \u2014 Dashboard\n`;
        texto += `/eliminar, /borrar \u2014 Eliminar datos\n`;
        texto += `\n\u2501\u2501 *PRO* \u2501\u2501\n`;
        texto += `/templates \u2014 Templates de mensajes\n`;
        texto += `/blacklist \u2014 Grupos bloqueados\n`;
        texto += `/grupostats \u2014 Estadisticas por grupo\n`;
        texto += `/horario \u2014 Programar horario\n`;
        texto += `/sinonimos \u2014 Variacion de mensajes\n`;
        texto += `/exportar \u2014 Exportar/Importar datos\n`;
        texto += `/limitediario \u2014 Limite envios por dia\n`;
        texto += `/reporte \u2014 Reporte diario\n`;
        texto += `\n\u2501\u2501 *ADMIN (Grupo)* \u2501\u2501\n`;
        texto += `/activar [codigo] [dias] \u2014 Activar membresia\n`;
        texto += `/desactivar [codigo] \u2014 Desactivar\n`;
        texto += `/ban [codigo] \u2014 Banear usuario\n`;
        texto += `/usuarios \u2014 Listar usuarios\n`;
        texto += `/registrargrupo \u2014 Registrar grupo admin\n`;
        texto += `/soyadmin [clave] \u2014 Registrar JID admin\n`;
    }

    await send(jid, texto);
}

// --- GUIA DE USO ---
async function showGuia(jid) {
    await send(jid,
        `\u{1F4D6} *GUIA DE USO*\n\n` +
        `1\uFE0F\u20E3 *Registra tus cuentas* (opcion 1)\n` +
        `   Agrega los numeros de WhatsApp que usaras\n\n` +
        `2\uFE0F\u20E3 *Agrega grupos* (opcion 2)\n` +
        `   Pega los links de los grupos objetivo\n` +
        `   O usa "Detectar mis grupos" para auto-detectar\n\n` +
        `3\uFE0F\u20E3 *Crea una campana* (opcion 3)\n` +
        `   Escribe el mensaje que quieres enviar\n\n` +
        `4\uFE0F\u20E3 *Inicia la campana* (opcion 4)\n` +
        `   El bot enviara tu mensaje a los grupos\n\n` +
        `\u{1F4A1} *Tips:*\n` +
        `\u2022 Agrega varias cuentas para rotacion (menos ban)\n` +
        `\u2022 1 cuenta: envia a todos y espera 10 min\n` +
        `\u2022 2+ cuentas: rota entre ellas cada 5-10 min\n` +
        `\u2022 Los grupos donde no se puede enviar se eliminan auto\n` +
        `\u2022 Configura el intervalo (opcion 7) para mas control\n\n` +
        `*0.* \u{1F519} Volver al menu`
    );
}

// --- MI PERFIL ---
async function showPerfil(jid, nombre) {
    const user = db.getUsuario(jid);
    const dash = db.getDashboard(jid);
    const codigoUser = user ? (user.codigo || "---") : "---";
    let texto = `\u{1F464} *MI PERFIL*\n\n` +
        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
        `\u{1F194} ID: ${jidToNumber(jid)}\n` +
        `\u{1F3F7} Codigo: *${codigoUser}*\n` +
        `\u{1F4DB} Nombre: ${nombre}\n` +
        `\u{1F4C5} Registro: ${user ? user.fecha_registro || "\u2014" : "\u2014"}\n` +
        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n` +
        `\u{1F4CA} Cuentas: ${dash.cuentas}\n` +
        `\u{1F310} Grupos: ${dash.grupos}\n` +
        `\u{1F4CB} Campanas: ${dash.campanas}\n` +
        `\u2705 Enviados: ${dash.totalEnviados}\n` +
        `\u274C Errores: ${dash.totalErrores}\n\n` +
        `*0.* \u{1F519} Volver al menu`;
    await send(jid, texto);
}

// --- MEMBRESIA ---
async function showMembresia(jid) {
    const user = db.getUsuario(jid);
    if (isAdmin(jid)) {
        return await send(jid, `\u{1F451} *ADMIN* \u2014 Membresia ilimitada.\n\n*0.* \u{1F519} Volver`);
    }
    if (user && user.activo && db.tieneMembresia(jid)) {
        return await send(jid,
            `\u23F0 *MEMBRESIA ACTIVA*\n\n` +
            `\u{1F4E6} Plan: ${user.plan}\n` +
            `\u23F3 Expira: ${user.fecha_expira}\n\n` +
            `*0.* \u{1F519} Volver`
        );
    }
    await send(jid, `\u26D4 *Sin membresia activa.*\n\nResponde *10* para ver planes y pagar.\n\n*0.* \u{1F519} Volver`);
}

// --- PLANES ---
async function showPlanes(jid) {
    let texto = `\u{1F4B3} *PLANES DISPONIBLES*\n\n`;
    const planes = Object.entries(config.PLANES);
    for (let i = 0; i < planes.length; i++) {
        const [nombre, info] = planes[i];
        texto += `*${i + 1}.* ${info.emoji} ${nombre.charAt(0).toUpperCase() + nombre.slice(1)} \u2014 ${info.precio} (${info.dias}d)\n`;
    }
    texto += `\n\u{1F4F1} Pago por YAPE al: ${config.YAPE_NUM}\n`;
    texto += `\nResponde el *numero* del plan\n*0.* \u{1F519} Volver`;
    setState(jid, "planes");
    await send(jid, texto);
}

// --- DASHBOARD ---
async function showDashboard(jid) {
    if (!await checkMembership(jid)) return;
    const dash = db.getDashboard(jid);
    await send(jid,
        `\u{1F4CA} *DASHBOARD*\n\n` +
        `\u{1F464} Cuentas: ${dash.cuentas}\n` +
        `\u{1F310} Grupos: ${dash.grupos}\n` +
        `\u{1F4CB} Campanas: ${dash.campanas} (${dash.campanasActivas} activas)\n` +
        `\u2705 Enviados: ${dash.totalEnviados}\n` +
        `\u274C Errores: ${dash.totalErrores}\n` +
        `\u{1F916} Auto-responder: ${dash.responderActivo ? "ON" : "OFF"} (${dash.keywords} keywords)\n\n` +
        `*0.* \u{1F519} Volver`
    );
}

// --- HISTORIAL ---
async function showHistorial(jid) {
    if (!await checkMembership(jid)) return;
    const hist = db.getHistorialEnvios(jid, 20);
    if (!hist.length) return await send(jid, "\u{1F4CA} Sin historial de envios.\n\n*0.* \u{1F519} Volver");
    let texto = `\u{1F4CA} *ULTIMOS ENVIOS*\n\n`;
    for (const h of hist) {
        const icon = h.resultado === "enviado" ? "\u2705" : "\u274C";
        const link = h.grupo_link.substring(0, 30);
        texto += `${icon} ${link}... | ${h.fecha}\n`;
    }
    texto += `\n*0.* \u{1F519} Volver`;
    await send(jid, texto);
}

// --- ELIMINAR ---
async function showEliminar(jid) {
    if (!await checkMembership(jid)) return;
    await send(jid,
        `\u{1F5D1} *ELIMINAR DATOS*\n\n` +
        `*1.* Eliminar todos los grupos\n` +
        `*2.* Eliminar historial de envios\n` +
        `*3.* Eliminar una campana\n\n` +
        `*0.* \u{1F519} Volver`
    );
    setState(jid, "eliminar");
}

// --- RESPONDER ---
async function showResponder(jid) {
    if (!await checkMembership(jid)) return;
    const conf = db.getResponderConfig(jid);
    const keywords = db.getKeywords(jid);
    let texto = `\u{1F916} *AUTO-RESPONDER*\n\n`;
    if (conf) {
        texto += `Estado: ${conf.activo ? "\u2705 ACTIVO" : "\u274C INACTIVO"}\n`;
        texto += `Contacto: ${conf.contacto}\n`;
        texto += `Keywords: ${keywords.length ? keywords.join(", ") : "(ninguna)"}\n\n`;
    } else {
        texto += `Estado: No configurado\n\n`;
    }
    texto += `*1.* Configurar contacto\n`;
    texto += `*2.* Configurar keywords\n`;
    if (conf) {
        texto += `*3.* ${conf.activo ? "Desactivar" : "Activar"}\n`;
    }
    texto += `*0.* \u{1F519} Volver`;
    setState(jid, "responder");
    await send(jid, texto);
}

// ====================================
// GESTION DE CUENTAS
// ====================================
async function showCuentas(jid) {
    if (!await checkMembership(jid)) return;

    const botPhone = `+${config.BOT_NUMBER || config.ADMIN_NUMBER}`;
    const botNombre = motor.BOT_NOMBRE;
    const sesionesCheck = db.getSesiones(jid);
    if (!sesionesCheck.find(s => s.nombre === botNombre)) {
        db.agregarSesion(jid, botNombre, botPhone);
    }

    const sesiones = db.getSesiones(jid);
    let texto = "\u{1F464} *GESTION DE CUENTAS*\n\n";
    if (sesiones.length) {
        for (let i = 0; i < sesiones.length; i++) {
            const s = sesiones[i];
            const esBotPrincipal = s.nombre === botNombre;
            texto += `  ${i + 1}. ${s.nombre} \u2014 ${s.telefono}`;
            if (esBotPrincipal) texto += " \u2705 (auto)";
            texto += "\n";
        }
        texto += `\nTotal: ${sesiones.length}/${config.MAX_CUENTAS_POR_USUARIO}\n`;
    } else {
        texto += "  (sin cuentas registradas)\n";
    }
    texto += "\n\u{1F4D6} *Info:*\n";
    texto += `\u2022 *${botNombre}* = cuenta del bot, lista sin QR\n`;
    texto += "\u2022 Otras cuentas necesitan vincular con QR\n";
    texto += "\u2022 Agrega mas cuentas para rotacion (menos ban)\n";
    texto += "\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
    texto += "*1.* \u2795 Agregar cuenta\n";
    if (sesiones.length > 1) {
        texto += "*2.* \u{1F5D1} Eliminar cuenta\n";
    }
    if (sesiones.filter(s => s.nombre !== botNombre).length > 0) {
        texto += "*3.* \u{1F517} Vincular cuenta (QR)\n";
    }
    texto += "*0.* \u{1F519} Volver al men\u00FA";
    setState(jid, "cuentas", { sesiones });
    await send(jid, texto);
}

// ====================================
// GESTION DE GRUPOS
// ====================================
// ====================================
// ENVIO PERSONAL
// ====================================
async function showEnvioPersonal(jid) {
    if (!await checkMembership(jid)) return;
    await send(jid, "\u{1F50D} Buscando chats personales...");
    try {
        // Usar botSock o cuenta cliente
        let sock = botSock;
        if (!sock) {
            const sesiones = db.getSesiones(jid);
            for (const s of sesiones) {
                try { sock = await motor.getOrConnectClient(jid, s.nombre); break; } catch (e) {}
            }
        }
        if (!sock) {
            return await send(jid, "\u274C No hay cuenta WSP conectada.\nVincula una cuenta primero desde Telegram.\n\n*0.* Volver");
        }
        const chats = await motor.listarChatsPersonales(sock, jid);
        if (!chats.length) {
            return await send(jid,
                `\u274C No se encontraron chats personales.\n\nLa cuenta necesita unos minutos para sincronizar el historial de chats despues de conectarse.\n\n*0.* Volver`
            );
        }
        let texto = `\u{1F4E8} *ENVIO PERSONAL*\n\n`;
        texto += `\u{1F464} *${chats.length} chat(s) personales encontrados:*\n\n`;
        for (let i = 0; i < Math.min(chats.length, 50); i++) {
            texto += `  ${i + 1}. ${chats[i].nombre} (${chats[i].numero})\n`;
        }
        if (chats.length > 50) texto += `  ... y ${chats.length - 50} mas\n`;
        texto += `\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
        texto += `*1.* \u{1F4E8} Enviar a TODOS\n`;
        texto += `*2.* \u{1F4CB} Seleccionar contactos\n`;
        texto += `*0.* \u{1F519} Volver al menu`;
        setState(jid, "envio_personal", { chats });
        await send(jid, texto);
    } catch (e) {
        await send(jid, `\u274C Error al listar chats: ${e.message}`);
    }
}

async function showGrupos(jid) {
    if (!await checkMembership(jid)) return;
    const grupos = db.getGrupos(jid);
    const maxG = db.getMaxGrupos(jid);
    let texto = "\u{1F310} *GESTION DE GRUPOS*\n\n";
    if (grupos.length) {
        for (let i = 0; i < grupos.length; i++) {
            const g = grupos[i];
            const display = g.nombre || (g.link.endsWith("@g.us") ? g.link.replace("@g.us", "") : g.link);
            texto += `  ${i + 1}. ${display}\n`;
        }
        texto += `\nTotal: ${grupos.length}/${maxG}\n`;
    } else {
        texto += "  (sin grupos)\n";
    }
    texto += "\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
    texto += "*1.* \u2795 Agregar por link\n";
    texto += "*2.* \u{1F50D} Detectar mis grupos (auto)\n";
    if (grupos.length) {
        texto += "*3.* \u{1F5D1} Eliminar grupo\n";
        texto += "*4.* \u270F Editar grupo\n";
        texto += "*5.* \u{1F5D1} Eliminar todos\n";
    }
    texto += "*0.* \u{1F519} Volver al men\u00FA";
    setState(jid, "grupos");
    await send(jid, texto);
}

// ====================================
// GESTION DE CAMPANAS
// ====================================
async function showCampanas(jid) {
    if (!await checkMembership(jid)) return;
    const campanas = db.getCampanas(jid);
    let texto = "\u{1F4CB} *CAMPANAS*\n\n";
    if (campanas.length) {
        for (let i = 0; i < campanas.length; i++) {
            const c = campanas[i];
            const status = c.activa ? "\u{1F7E2}" : "\u26AA";
            texto += `  ${status} ${i + 1}. ${c.nombre} (${c.enviados} env | ${c.errores} err)\n`;
        }
    } else {
        texto += "  (sin campanas)\n";
    }
    texto += "\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
    texto += "*1.* \u2795 Nueva campana\n";
    if (campanas.length) {
        texto += "*2.* \u270F Editar campana\n";
        texto += "*3.* \u{1F5D1} Eliminar campana\n";
        texto += "*4.* \u{1F4CB} Clonar campana\n";
    }
    texto += "*0.* \u{1F519} Volver al men\u00FA";
    setState(jid, "campanas", { campanas });
    await send(jid, texto);
}

// --- INICIAR CAMPANA ---
async function showIniciar(jid) {
    if (!await checkMembership(jid)) return;
    const campanas = db.getCampanas(jid);
    if (!campanas.length) return await send(jid, "\u274C No tienes campanas. Crea una primero (opcion 3).\n\n*0.* \u{1F519} Volver");
    let texto = "\u{1F680} *INICIAR CAMPANA*\n\n";
    for (let i = 0; i < campanas.length; i++) {
        const c = campanas[i];
        const status = c.activa ? "\u{1F7E2} ACTIVA" : "\u26AA";
        texto += `*${i + 1}.* ${c.nombre} ${status}\n`;
    }
    texto += "\nResponde el *numero* de la campana\n*0.* \u{1F519} Volver";
    setState(jid, "iniciar", { campanas });
    await send(jid, texto);
}

// --- DETENER CAMPANA ---
async function showDetener(jid) {
    const campanas = db.getCampanas(jid).filter(c => c.activa);
    if (!campanas.length) return await send(jid, "\u{1F6D1} No hay campanas activas.\n\n*0.* \u{1F519} Volver");
    let texto = "\u{1F6D1} *DETENER CAMPANA*\n\n";
    for (let i = 0; i < campanas.length; i++) {
        texto += `*${i + 1}.* ${campanas[i].nombre}\n`;
    }
    texto += "\nResponde el *numero*\n*0.* \u{1F519} Volver";
    setState(jid, "detener", { campanas });
    await send(jid, texto);
}

// --- INTERVALO ---
async function showIntervalo(jid) {
    if (!await checkMembership(jid)) return;
    const campanas = db.getCampanas(jid);
    if (!campanas.length) return await send(jid, "\u274C No tienes campanas.\n\n*0.* \u{1F519} Volver");
    let texto = "\u23F1 *INTERVALO DE ENVIO*\n\n";
    for (let i = 0; i < campanas.length; i++) {
        const confI = db.getCampanaConfig(campanas[i].id);
        texto += `*${i + 1}.* ${campanas[i].nombre}\n`;
        texto += `   Grupos: ${confI.intervalo_min}-${confI.intervalo_max}s\n`;
        texto += `   Cuentas: ${confI.espera_cuenta || 300}s\n`;
        texto += `   Ciclo: ${confI.espera_ciclo || 600}s\n\n`;
    }
    texto += "\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n";
    texto += "\u{1F4D6} *Como funciona:*\n";
    texto += "1 cuenta: envia a todos, espera 10 min, repite\n";
    texto += "2+ cuentas: rota entre cuentas cada 5-10 min\n\n";
    texto += "Responde el *numero* de la campana\n*0.* \u{1F519} Volver";
    setState(jid, "intervalo", { campanas });
    await send(jid, texto);
}

// --- ADMIN PANEL ---
async function showAdmin(jid) {
    const todos = db.getTodosUsuarios();
    const total = todos.length;
    const activos = todos.filter(u => u.activo).length;
    const campAct = Object.keys(motor.tareasActivas).length;
    await send(jid,
        `\u{1F451} *PANEL ADMIN*\n\n` +
        `\u{1F465} Usuarios: ${total} (${activos} activos)\n` +
        `\u{1F680} Campanas activas: ${campAct}\n\n` +
        `Comandos (con / al inicio):\n` +
        `  */activar [codigo] [dias]*\n` +
        `  */desactivar [codigo]*\n` +
        `  */ban [codigo]*\n` +
        `  */usuarios* \u2014 lista\n\n` +
        `\u{1F4A1} El [codigo] es el ID unico de cada usuario.\n` +
        `Lo ves en las solicitudes de pago.\n\n` +
        `*0.* \u{1F519} Volver al men\u00FA`
    );
}

// --- ADMIN: activar membresia por codigo ---
async function adminActivar(jid, text) {
    try {
        const parts = text.split(/\s+/);
        if (parts.length < 3) return await send(jid, "Uso: activar [codigo] [dias]\n\nEl codigo es el ID del usuario (ej: 1001)");
        let target = parts[1].replace(/^\*+|\*+$/g, "").trim();
        const dias = parseInt(parts[2].replace(/^\*+|\*+$/g, ""));
        if (isNaN(dias) || dias < 1) return await send(jid, "\u274C Dias debe ser numero positivo.");

        console.log(`   ADMIN ACTIVAR: target=${target}, dias=${dias}`);

        const result = db.activarMembresiaByCodigo(target, dias);
        console.log(`   ADMIN ACTIVAR resultado:`, JSON.stringify(result));
        if (!result) {
            return await send(jid, `\u274C No se encontro usuario con codigo *${target}*.\n\nEscribe *usuarios* para ver la lista.`);
        }

        const planName = dias === 1 ? "Diario" : dias === 7 ? "Semanal" : "Mensual";
        await send(jid, `\u2705 Activado ${planName} (${dias}d)\nCodigo: *${target}*\nNombre: ${result.nombre || "?"}`);

        const confirmMsg = `\u{1F389} *Membres\u00EDa activada!*\n\n\u{1F4E6} Plan: ${planName}\n\u23F3 ${dias} d\u00EDa(s)\n\nEscribe *menu* para empezar.`;
        try {
            await send(result.wspId, confirmMsg);
            console.log(`   Confirmacion enviada a: ${result.wspId}`);
        } catch (e) {
            console.error(`   Error enviando confirmacion a ${result.wspId}: ${e.message}`);
        }
    } catch (err) {
        console.error("ERROR en adminActivar:", err);
        await send(jid, `\u274C Error: ${err.message}`);
    }
}

// --- ADMIN: desactivar por codigo ---
async function adminDesactivar(jid, text) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) return await send(jid, "Uso: desactivar [codigo]");
    let target = parts[1].replace(/^\*+|\*+$/g, "").trim();
    const user = db.desactivarByCodigo(target);
    if (!user) return await send(jid, `\u274C No se encontro usuario con codigo *${target}*.`);
    await send(jid, `\u2705 Desactivado: codigo *${target}* (${user.nombre || jidToNumber(user.wsp_id)})`);
}

// --- ADMIN: ban por codigo ---
async function adminBan(jid, text) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) return await send(jid, "Uso: ban [codigo]");
    let target = parts[1].replace(/^\*+|\*+$/g, "").trim();
    const user = db.banByCodigo(target);
    if (!user) return await send(jid, `\u274C No se encontro usuario con codigo *${target}*.`);
    const clientNum = jidToNumber(user.wsp_id);
    await send(jid, `\u{1F528} Baneado: codigo *${target}* (${user.nombre || clientNum})`);
    await sendToUser(clientNum, "\u26D4 Tu acceso ha sido suspendido.");
}

// --- ADMIN: listar usuarios ---
async function adminUsuarios(jid) {
    const usuarios = db.getTodosUsuarios();
    if (!usuarios.length) return await send(jid, "No hay usuarios.");
    let texto = "\u{1F465} *USUARIOS*\n\n";
    texto += "*Codigo | Nombre | Plan*\n";
    for (const u of usuarios.slice(0, 30)) {
        const estado = u.activo ? "\u2705" : "\u274C";
        const cod = u.codigo || "---";
        texto += `${estado} *${cod}* | ${u.nombre || jidToNumber(u.wsp_id)} | ${u.plan}\n`;
    }
    if (usuarios.length > 30) texto += `\n... y ${usuarios.length - 30} m\u00E1s`;
    await send(jid, texto);
}

// ====================================
// FSM (Finite State Machine)
// ====================================
async function handleFSM(jid, msg, text, trimmed, state) {
    const { screen, data } = state;
    const lower = trimmed.toLowerCase();
    const pushName = msg.pushName || jidToNumber(jid);

    // Cancelar / volver
    if (trimmed === "0") {
        clearState(jid);
        return await sendMainMenu(jid, pushName);
    }

    switch (screen) {
        // --- CUENTAS ---
        case "cuentas": {
            if (trimmed === "1") {
                if (db.getSesiones(jid).length >= config.MAX_CUENTAS_POR_USUARIO) {
                    return await send(jid, `\u274C Limite de ${config.MAX_CUENTAS_POR_USUARIO} cuentas alcanzado.`);
                }
                setState(jid, "cuenta_nueva", { step: "telefono" });
                return await send(jid, "\u{1F4F1} Envia el *numero de telefono* con codigo de pais:\n\nEj: +51987654321\n\n*0.* Cancelar");
            }
            if (trimmed === "2") {
                const sesiones = db.getSesiones(jid);
                if (sesiones.length <= 1) return await send(jid, "No hay cuentas para eliminar.");
                let texto = "\u{1F5D1} Selecciona cuenta a eliminar:\n\n";
                for (let i = 0; i < sesiones.length; i++) {
                    texto += `*${i + 1}.* ${sesiones[i].nombre} \u2014 ${sesiones[i].telefono}\n`;
                }
                texto += "\n*0.* Cancelar";
                setState(jid, "cuentas_del", { sesiones });
                return await send(jid, texto);
            }
            if (trimmed === "3") {
                const sesiones = db.getSesiones(jid);
                const sesionesLink = sesiones.filter(s => s.nombre !== motor.BOT_NOMBRE);
                if (!sesionesLink.length) return await send(jid, "\u2705 Solo tienes la cuenta del bot, que ya esta vinculada automaticamente.\n\nAgrega otra cuenta para vincular con QR.");
                let texto = "\u{1F517} Selecciona cuenta a vincular:\n\n";
                for (let i = 0; i < sesionesLink.length; i++) {
                    texto += `*${i + 1}.* ${sesionesLink[i].nombre} \u2014 ${sesionesLink[i].telefono}\n`;
                }
                texto += "\n*0.* Cancelar";
                setState(jid, "cuentas_link", { sesiones: sesionesLink });
                return await send(jid, texto);
            }
            return await sendMainMenu(jid, pushName);
        }

        case "cuenta_nueva": {
            if (data.step === "telefono") {
                const tel = trimmed.replace(/\s/g, "");
                if (!tel.startsWith("+") || tel.length < 8) {
                    return await send(jid, "\u274C Formato invalido. Usa: +51987654321");
                }
                setState(jid, "cuenta_nueva", { step: "nombre", telefono: tel });
                return await send(jid, `\u2705 Telefono: ${tel}\n\nAhora escribe un *nombre* para esta cuenta:\n\nEj: MiCuenta1\n\n*0.* Cancelar`);
            }
            if (data.step === "nombre") {
                if (trimmed.length > 20) return await send(jid, "\u26A0 Max 20 caracteres.");
                const nombre = trimmed.replace(/[^a-zA-Z0-9_]/g, "_");
                db.agregarSesion(jid, nombre, data.telefono);
                clearState(jid);
                await send(jid, `\u2705 Cuenta '${nombre}' agregada!\n\nTelefono: ${data.telefono}\n\nUsa la opcion *3* para vincularla con QR.`);
                return await showCuentas(jid);
            }
            break;
        }

        case "cuentas_del": {
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.sesiones.length) {
                clearState(jid);
                return await showCuentas(jid);
            }
            const cuenta = data.sesiones[idx];
            if (cuenta.nombre === motor.BOT_NOMBRE) {
                clearState(jid);
                await send(jid, "\u26A0 No puedes eliminar la cuenta del bot. Es automatica.");
                return await showCuentas(jid);
            }
            db.eliminarSesion(jid, cuenta.nombre);
            const sessionDir = motor.getSessionDir(jid, cuenta.nombre);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            clearState(jid);
            await send(jid, `\u2705 Cuenta '${cuenta.nombre}' eliminada.`);
            return await showCuentas(jid);
        }

        case "cuentas_link": {
            const idxLink = parseInt(trimmed) - 1;
            if (isNaN(idxLink) || idxLink < 0 || idxLink >= data.sesiones.length) {
                clearState(jid);
                return await showCuentas(jid);
            }
            const cuentaLink = data.sesiones[idxLink];
            if (cuentaLink.nombre === motor.BOT_NOMBRE) {
                clearState(jid);
                await send(jid, "\u2705 La cuenta del bot ya esta vinculada automaticamente. No necesita QR.");
                return await showCuentas(jid);
            }
            clearState(jid);
            const linkUrl = `http://64.23.201.243:${QR_PORT}/link?u=${encodeURIComponent(jid)}&n=${encodeURIComponent(cuentaLink.nombre)}`;
            await send(jid,
                `\u{1F517} *VINCULAR: ${cuentaLink.nombre}*\n\n` +
                `Abre este enlace en tu navegador:\n${linkUrl}\n\n` +
                `Luego escanea el QR con el celular del numero ${cuentaLink.telefono}.\n\n` +
                `*0.* Volver`
            );
            // Iniciar vinculacion
            motor.linkAccount(jid, cuentaLink.nombre).catch(e => {
                console.error(`Link error: ${e.message}`);
            });
            return;
        }

        // --- GRUPOS ---
        case "grupos": {
            if (trimmed === "1") {
                setState(jid, "grupos_add");
                return await send(jid, "\u2795 *AGREGAR GRUPOS*\n\nEnvia los links (uno por linea):\n\nEjemplo:\nhttps://chat.whatsapp.com/ABC123\nhttps://chat.whatsapp.com/XYZ789\n\nEscribe *0* para cancelar");
            }
            if (trimmed === "2") {
                // ============================================================
                // CAMBIO: Detectar solo GRUPOS reales (no canales/newsletters)
                // ============================================================
                await send(jid, "\u{1F50D} Buscando grupos en el WhatsApp del bot...\n\u26A0 Solo se mostraran *grupos reales* (no canales).");
                try {
                    const allGroups = await botSock.groupFetchAllParticipating();
                    const groupIds = Object.keys(allGroups);

                    // FILTRAR: solo grupos reales (@g.us), no canales/newsletters
                    const realGroups = [];
                    for (const gid of groupIds) {
                        const g = allGroups[gid];
                        if (motor.esGrupoReal(gid, g)) {
                            realGroups.push({ id: gid, name: g.subject || gid, members: g.participants ? g.participants.length : "?" });
                        }
                    }

                    if (!realGroups.length) {
                        return await send(jid, "\u274C El bot no esta en ningun grupo real (solo canales/newsletters encontrados).\n\nEscribe *0* para volver.");
                    }

                    let texto = `\u{1F50D} *${realGroups.length} GRUPOS ENCONTRADOS*\n`;
                    texto += `(${groupIds.length - realGroups.length} canales/newsletters filtrados)\n\n`;
                    for (let i = 0; i < realGroups.length; i++) {
                        texto += `*${i + 1}.* ${realGroups[i].name} (${realGroups[i].members})\n`;
                    }
                    texto += `\n\u{1F4A1} Escribe los numeros separados por coma:\n`;
                    texto += `Ej: *1,3,5,7* o *T* para todos\n`;
                    texto += `\n*0.* Cancelar`;
                    setState(jid, "grupos_detect", { groupList: realGroups });
                    return await send(jid, texto);
                } catch (e) {
                    console.error("Error detectando grupos:", e.message);
                    return await send(jid, `\u274C Error al detectar grupos: ${e.message}\n\nEscribe *0* para volver.`);
                }
            }
            if (trimmed === "3") {
                const grupos = db.getGrupos(jid);
                if (!grupos.length) return await send(jid, "No tienes grupos.");
                let texto = "\u{1F5D1} *ELIMINAR GRUPOS*\n\n";
                for (let i = 0; i < grupos.length; i++) {
                    const g = grupos[i];
                    const display = g.nombre || (g.link.endsWith("@g.us") ? g.link.replace("@g.us", "") : g.link.substring(0, 40));
                    texto += `*${i + 1}.* ${display}\n`;
                }
                texto += `\n\u{1F4A1} Escribe los numeros separados por coma:`;
                texto += `\nEj: *1,3,5* o *T* para eliminar todos`;
                texto += "\n\n*0.* Cancelar";
                setState(jid, "grupos_del", { grupos });
                return await send(jid, texto);
            }
            if (trimmed === "4") {
                const grupos = db.getGrupos(jid);
                if (!grupos.length) return await send(jid, "No tienes grupos.");
                let texto = "\u270F Selecciona grupo a editar:\n\n";
                for (let i = 0; i < grupos.length; i++) {
                    const g = grupos[i];
                    const display = g.nombre || (g.link.endsWith("@g.us") ? g.link.replace("@g.us", "") : g.link.substring(0, 40));
                    texto += `*${i + 1}.* ${display}\n`;
                }
                texto += "\n*0.* Cancelar";
                setState(jid, "grupos_edit_select", { grupos });
                return await send(jid, texto);
            }
            if (trimmed === "5") {
                setState(jid, "grupos_delall_confirm");
                return await send(jid, "\u26A0 \u00BFEliminar TODOS los grupos?\n\n*1.* S\u00ED, eliminar todos\n*0.* No, cancelar");
            }
            return await sendMainMenu(jid, pushName);
        }

        case "grupos_detect": {
            const { groupList } = data;
            const maxG = db.getMaxGrupos(jid);
            const current = db.getGrupos(jid);

            if (lower === "t" || lower === "todos") {
                let added = 0, dupes = 0;
                for (const g of groupList) {
                    if (current.length + added >= maxG) break;
                    if (db.agregarGrupo(jid, g.id, g.name)) added++;
                    else dupes++;
                }
                clearState(jid);
                let resp = "";
                if (added) resp += `\u2705 ${added} grupo(s) agregado(s)\n`;
                if (dupes) resp += `\u26A0 ${dupes} ya estaban registrados\n`;
                await send(jid, resp);
                return await showGrupos(jid);
            }

            const indices = trimmed.split(/[,\s\n]+/).map(n => parseInt(n) - 1);
            let added = 0, dupes = 0;
            for (const idx of indices) {
                if (isNaN(idx) || idx < 0 || idx >= groupList.length) continue;
                if (current.length + added >= maxG) break;
                if (db.agregarGrupo(jid, groupList[idx].id, groupList[idx].name)) added++;
                else dupes++;
            }
            clearState(jid);
            if (!added && !dupes) {
                await send(jid, "\u274C Seleccion invalida.");
            } else {
                let resp = "";
                if (added) resp += `\u2705 ${added} grupo(s) agregado(s)\n`;
                if (dupes) resp += `\u26A0 ${dupes} ya estaban registrados\n`;
                await send(jid, resp);
            }
            return await showGrupos(jid);
        }

        case "grupos_add": {
            const lines = trimmed.split("\n").map(l => l.trim()).filter(l => l);
            const maxG = db.getMaxGrupos(jid);
            const current = db.getGrupos(jid);
            let added = 0, errors = 0, skipped = 0, dupes = 0;
            await send(jid, `\u23F3 Procesando ${lines.length} link(s)...`);
            for (const link of lines) {
                if (current.length + added >= maxG) {
                    skipped++;
                    continue;
                }
                if (link.includes("chat.whatsapp.com/") || link.endsWith("@g.us")) {
                    const result = db.agregarGrupo(jid, link);
                    if (result) added++;
                    else dupes++;
                } else {
                    errors++;
                }
            }
            clearState(jid);
            let resp = `\u{1F4CB} *RESULTADO DE AGREGAR GRUPOS*\n\n`;
            resp += `\u{1F4E5} Total links recibidos: ${lines.length}\n`;
            if (added) resp += `\u2705 Agregados: ${added}\n`;
            if (dupes) resp += `\u26A0 Ya existian: ${dupes}\n`;
            if (errors) resp += `\u274C Links invalidos: ${errors}\n`;
            if (skipped) resp += `\u{1F6AB} Limite alcanzado (${maxG}): ${skipped} omitidos\n`;
            if (!added && !dupes && !errors && !skipped) resp += `\u274C No se agrego ningun grupo.\n`;
            resp += `\n\u{1F310} Total grupos ahora: ${current.length + added}/${maxG}`;
            await send(jid, resp);
            return await showGrupos(jid);
        }

        case "envio_personal": {
            if (trimmed === "1") {
                setState(jid, "envio_personal_msg", { modo: "todos", chats: data.chats });
                return await send(jid,
                    `\u{1F4DD} *Escribe el mensaje* que quieres enviar a los ${data.chats.length} chat(s) personales.\n\n` +
                    `\u26A0 Se enviara con 10 seg de delay entre cada envio.\n\n*0.* Cancelar`
                );
            }
            if (trimmed === "2") {
                let texto = `\u{1F4CB} *SELECCIONAR CONTACTOS*\n\n`;
                for (let i = 0; i < Math.min(data.chats.length, 50); i++) {
                    texto += `*${i + 1}.* ${data.chats[i].nombre}\n`;
                }
                texto += `\n\u{1F4A1} Escribe los numeros separados por coma:\n`;
                texto += `Ej: *1,3,5* o *T* para todos\n\n*0.* Cancelar`;
                setState(jid, "envio_personal_select", { chats: data.chats });
                return await send(jid, texto);
            }
            clearState(jid);
            return await sendMainMenu(jid, pushName);
        }

        case "envio_personal_select": {
            let selectedJids = [];
            if (lower === "t" || lower === "todos") {
                selectedJids = data.chats.map(c => c.jid);
            } else {
                const indices = trimmed.split(/[,\s\n]+/).map(n => parseInt(n) - 1);
                for (const idx of indices) {
                    if (!isNaN(idx) && idx >= 0 && idx < data.chats.length) {
                        selectedJids.push(data.chats[idx].jid);
                    }
                }
            }
            if (!selectedJids.length) {
                return await send(jid, "\u274C No se selecciono ningun contacto valido. Intenta de nuevo.");
            }
            setState(jid, "envio_personal_msg", { modo: "seleccionados", jids: selectedJids, chats: data.chats });
            return await send(jid,
                `\u2705 ${selectedJids.length} contacto(s) seleccionados.\n\n\u{1F4DD} Escribe el mensaje a enviar:\n\n*0.* Cancelar`
            );
        }

        case "envio_personal_msg": {
            if (!trimmed) {
                return await send(jid, "\u274C Escribe un mensaje. No puede estar vacio.");
            }
            const mensaje = trimmed;
            clearState(jid);
            // Usar botSock o cuenta cliente
            let personalSock = botSock;
            if (!personalSock) {
                const sesiones = db.getSesiones(jid);
                for (const s of sesiones) {
                    try { personalSock = await motor.getOrConnectClient(jid, s.nombre); break; } catch (e) {}
                }
            }
            if (!personalSock) {
                return await send(jid, "\u274C No hay cuenta WSP conectada. Vincula una cuenta primero.");
            }
            if (data.modo === "todos") {
                const allJids = data.chats.map(c => c.jid);
                motor.enviarASeleccionados(jid, allJids, mensaje, null, personalSock);
                return await send(jid,
                    `\u{1F4E8} *Envio personal iniciado!*\n\n` +
                    `\u{1F464} Contactos: ${allJids.length}\n` +
                    `\u23F1 Delay: 10 seg entre cada envio\n` +
                    `\u{1F4CA} Recibiras progreso cada 10 envios.\n\n` +
                    `Escribe *cancelar envio* para detener.`
                );
            } else {
                motor.enviarASeleccionados(jid, data.jids, mensaje, null, personalSock);
                return await send(jid,
                    `\u{1F4E8} *Envio personal iniciado!*\n\n` +
                    `\u{1F464} Contactos: ${data.jids.length}\n` +
                    `\u23F1 Delay: 10 seg entre cada envio\n\n` +
                    `Escribe *cancelar envio* para detener.`
                );
            }
        }

        case "grupos_del": {
            // Soporta eliminar varios: "1,3,5" o "T" para todos
            if (lower === "t" || lower === "todos") {
                const total = data.grupos.length;
                for (const g of data.grupos) {
                    db.eliminarGrupo(jid, g.id);
                }
                clearState(jid);
                await send(jid, `\u2705 ${total} grupo(s) eliminado(s).`);
                return await showGrupos(jid);
            }

            const indices = trimmed.split(/[,\s\n]+/).map(n => parseInt(n) - 1);
            let deleted = 0;
            // Ordenar de mayor a menor para no afectar indices
            const validIndices = indices.filter(i => !isNaN(i) && i >= 0 && i < data.grupos.length);
            const uniqueIndices = [...new Set(validIndices)].sort((a, b) => b - a);
            for (const idx of uniqueIndices) {
                db.eliminarGrupo(jid, data.grupos[idx].id);
                deleted++;
            }
            clearState(jid);
            if (deleted) {
                await send(jid, `\u2705 ${deleted} grupo(s) eliminado(s).`);
            } else {
                await send(jid, "\u274C Seleccion invalida.");
            }
            return await showGrupos(jid);
        }

        case "grupos_edit_select": {
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.grupos.length) {
                clearState(jid);
                return await showGrupos(jid);
            }
            setState(jid, "grupos_edit", { grupoId: data.grupos[idx].id });
            return await send(jid, "Envia el nuevo link del grupo:\n\n*0.* Cancelar");
        }

        case "grupos_edit": {
            if (trimmed.includes("chat.whatsapp.com/") || trimmed.endsWith("@g.us")) {
                db.actualizarGrupoLink(jid, data.grupoId, trimmed);
                clearState(jid);
                await send(jid, "\u2705 Grupo actualizado.");
            } else {
                clearState(jid);
                await send(jid, "\u274C Link invalido.");
            }
            return await showGrupos(jid);
        }

        case "grupos_delall_confirm": {
            if (trimmed === "1") {
                db.eliminarTodosGrupos(jid);
                clearState(jid);
                await send(jid, "\u2705 Todos los grupos eliminados.");
            } else {
                clearState(jid);
            }
            return await showGrupos(jid);
        }

        // --- CAMPANAS ---
        case "campanas": {
            if (trimmed === "1") {
                setState(jid, "camp_nueva", { step: "nombre" });
                return await send(jid, "\u{1F4CB} *NUEVA CAMPANA*\n\nEscribe el *nombre* de la campana:\n\nEj: Promo Enero\n\n*0.* Cancelar");
            }
            if (trimmed === "2" && data.campanas && data.campanas.length) {
                let texto = "\u270F Selecciona campana a editar:\n\n";
                for (let i = 0; i < data.campanas.length; i++) {
                    texto += `*${i + 1}.* ${data.campanas[i].nombre}\n`;
                }
                texto += "\n*0.* Cancelar";
                setState(jid, "camp_editar", { campanas: data.campanas });
                return await send(jid, texto);
            }
            if (trimmed === "3" && data.campanas && data.campanas.length) {
                let texto = "\u{1F5D1} *ELIMINAR CAMPANAS*\n\n";
                for (let i = 0; i < data.campanas.length; i++) {
                    texto += `*${i + 1}.* ${data.campanas[i].nombre}\n`;
                }
                texto += `\n\u{1F4A1} Escribe los numeros separados por coma:`;
                texto += `\nEj: *1,2* o *T* para eliminar todas`;
                texto += "\n\n*0.* Cancelar";
                setState(jid, "camp_eliminar", { campanas: data.campanas });
                return await send(jid, texto);
            }
            if (trimmed === "4" && data.campanas && data.campanas.length) {
                let texto = "\u{1F4CB} Selecciona campana a clonar:\n\n";
                for (let i = 0; i < data.campanas.length; i++) {
                    texto += `*${i + 1}.* ${data.campanas[i].nombre}\n`;
                }
                texto += "\n*0.* Cancelar";
                setState(jid, "camp_clonar", { campanas: data.campanas });
                return await send(jid, texto);
            }
            return await sendMainMenu(jid, pushName);
        }

        case "camp_nueva": {
            if (data.step === "nombre") {
                if (trimmed.length > 50) return await send(jid, "\u26A0 Max 50 caracteres.");
                setState(jid, "camp_nueva", { step: "mensaje", nombre: trimmed });
                return await send(jid, `\u2705 Nombre: *${trimmed}*\n\nAhora env\u00EDa el *mensaje* de la campa\u00F1a.\n\nPuedes enviar:\n\u2022 Solo texto\n\u2022 Foto con texto en la descripcion\n\nEscribe *0* para cancelar`);
            }
            if (data.step === "mensaje") {
                let campMensaje = trimmed;
                let campImagenPath = null;

                const campImageMsg = msg.message?.imageMessage;
                if (campImageMsg) {
                    campMensaje = campImageMsg.caption || "";
                    try {
                        const imgBuf = await downloadMediaMessage(msg, "buffer", {});
                        const buf = Buffer.isBuffer(imgBuf) ? imgBuf : Buffer.from(imgBuf);
                        fs.mkdirSync("media", { recursive: true });
                        campImagenPath = `media/camp_${Date.now()}.jpg`;
                        fs.writeFileSync(campImagenPath, buf);
                    } catch (e) {
                        try {
                            const imgBuf2 = await botSock.downloadMediaMessage(msg);
                            const buf2 = Buffer.isBuffer(imgBuf2) ? imgBuf2 : Buffer.from(imgBuf2);
                            fs.mkdirSync("media", { recursive: true });
                            campImagenPath = `media/camp_${Date.now()}.jpg`;
                            fs.writeFileSync(campImagenPath, buf2);
                        } catch (e2) {}
                    }
                }

                if (!campMensaje && !campImagenPath) {
                    return await send(jid, "\u274C Debes enviar un mensaje o una foto con texto.");
                }

                const campanaId = db.crearCampana(jid, data.nombre, campMensaje, campImagenPath);
                const sesiones = db.getSesiones(jid);
                const grupos = db.getGrupos(jid);
                for (const s of sesiones) db.agregarSesionCampana(campanaId, s.nombre);
                for (const g of grupos) db.agregarGrupoCampana(campanaId, g.link);

                clearState(jid);
                await send(jid,
                    `\u{1F389} Campa\u00F1a '*${data.nombre}*' creada!\n\n` +
                    `\u{1F464} ${sesiones.length} cuenta(s) asignada(s)\n` +
                    `\u{1F310} ${grupos.length} grupo(s) asignado(s)\n` +
                    (campImagenPath ? `\u{1F4F7} Con imagen adjunta\n` : ``) +
                    `\nUsa *4* (Iniciar) o */iniciar* para lanzarla.`
                );
                return await showCampanas(jid);
            }
            break;
        }

        case "camp_editar": {
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.campanas.length) {
                clearState(jid);
                return await showCampanas(jid);
            }
            setState(jid, "camp_editar_msg", { campanaId: data.campanas[idx].id, nombre: data.campanas[idx].nombre });
            return await send(jid, `\u270F Env\u00EDa el nuevo mensaje para '*${data.campanas[idx].nombre}*':\n\nPuedes enviar texto o foto con texto.\n\nEscribe *0* para cancelar`);
        }

        case "camp_editar_msg": {
            let editMsg = trimmed;
            let editImgPath = null;
            const editImageMsg = msg.message?.imageMessage;
            if (editImageMsg) {
                editMsg = editImageMsg.caption || "";
                try {
                    const imgBuf = await downloadMediaMessage(msg, "buffer", {});
                    const buf = Buffer.isBuffer(imgBuf) ? imgBuf : Buffer.from(imgBuf);
                    fs.mkdirSync("media", { recursive: true });
                    editImgPath = `media/camp_${Date.now()}.jpg`;
                    fs.writeFileSync(editImgPath, buf);
                } catch (e) {
                    try {
                        const imgBuf2 = await botSock.downloadMediaMessage(msg);
                        const buf2 = Buffer.isBuffer(imgBuf2) ? imgBuf2 : Buffer.from(imgBuf2);
                        fs.mkdirSync("media", { recursive: true });
                        editImgPath = `media/camp_${Date.now()}.jpg`;
                        fs.writeFileSync(editImgPath, buf2);
                    } catch (e2) {}
                }
            }
            db.actualizarCampanaMensaje(data.campanaId, editMsg, editImgPath);
            clearState(jid);
            await send(jid, `\u2705 Campa\u00F1a '*${data.nombre}*' actualizada.` + (editImgPath ? ` (con imagen)` : ``));
            return await showCampanas(jid);
        }

        case "camp_eliminar": {
            if (lower === "t" || lower === "todos") {
                let total = 0;
                for (const c of data.campanas) {
                    if (c.activa) motor.detenerCampana(c.id);
                    db.eliminarCampana(c.id);
                    total++;
                }
                clearState(jid);
                await send(jid, `\u2705 ${total} campana(s) eliminada(s).`);
                return await showCampanas(jid);
            }
            const indices = trimmed.split(/[,\s]+/).map(n => parseInt(n) - 1);
            const validIndices = [...new Set(indices.filter(i => !isNaN(i) && i >= 0 && i < data.campanas.length))].sort((a, b) => b - a);
            let deleted = 0;
            for (const idx of validIndices) {
                const camp = data.campanas[idx];
                if (camp.activa) motor.detenerCampana(camp.id);
                db.eliminarCampana(camp.id);
                deleted++;
            }
            clearState(jid);
            if (deleted) await send(jid, `\u2705 ${deleted} campana(s) eliminada(s).`);
            else await send(jid, "\u274C Seleccion invalida.");
            return await showCampanas(jid);
        }

        case "camp_clonar": {
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.campanas.length) {
                clearState(jid);
                return await showCampanas(jid);
            }
            const nuevoNombre = data.campanas[idx].nombre + "_copia";
            db.clonarCampana(jid, data.campanas[idx].id, nuevoNombre);
            clearState(jid);
            await send(jid, `\u2705 Campana clonada como '${nuevoNombre}'.`);
            return await showCampanas(jid);
        }

        // --- INICIAR ---
        case "iniciar": {
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.campanas.length) {
                clearState(jid);
                return await sendMainMenu(jid, pushName);
            }
            const camp = data.campanas[idx];
            // Refrescar estado real desde DB y tareas activas
            const campReal = db.getCampanaById(camp.id);
            if (motor.tareasActivas[camp.id]) {
                // Si hay tarea activa, detenerla primero para reiniciar
                motor.detenerCampana(camp.id);
                await send(jid, `\u{1F504} Campana '${camp.nombre}' reiniciada...`);
            }
            clearState(jid);
            const ok = motor.iniciarCampana(camp.id, jid, botSock);
            if (ok) {
                await send(jid, `\u{1F680} Iniciando campana '${camp.nombre}'...\n\nEnviando a grupos inmediatamente.`);
            } else {
                await send(jid, `\u274C Error al iniciar campana. Intenta de nuevo en unos segundos.`);
            }
            return;
        }

        // --- DETENER ---
        case "detener": {
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.campanas.length) {
                clearState(jid);
                return await sendMainMenu(jid, pushName);
            }
            const camp = data.campanas[idx];
            motor.detenerCampana(camp.id);
            clearState(jid);
            await send(jid, `\u{1F6D1} Campana '${camp.nombre}' detenida.`);
            return;
        }

        // --- INTERVALO ---
        case "intervalo": {
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= data.campanas.length) {
                clearState(jid);
                return await sendMainMenu(jid, pushName);
            }
            const confI = db.getCampanaConfig(data.campanas[idx].id);
            setState(jid, "intervalo_set", { campanaId: data.campanas[idx].id, nombre: data.campanas[idx].nombre });
            return await send(jid,
                `\u23F1 *${data.campanas[idx].nombre}*\n\n` +
                `Config actual:\n` +
                `\u2022 Entre grupos: ${confI.intervalo_min}-${confI.intervalo_max}s\n` +
                `\u2022 Entre cuentas: ${confI.espera_cuenta || 300}s\n` +
                `\u2022 Entre ciclos: ${confI.espera_ciclo || 600}s\n\n` +
                `Envia 4 numeros separados por espacio:\n` +
                `*grupoMin grupoMax cuentas ciclo*\n\n` +
                `Ej: *10 30 300 600*\n` +
                `(10-30s entre grupos, 5min cuentas, 10min ciclo)\n\n` +
                `*0.* Cancelar`
            );
        }

        case "intervalo_set": {
            const parts = trimmed.split(/\s+/);
            if (parts.length < 2) return await send(jid, "\u274C Formato: grupoMin grupoMax cuentas ciclo\nEj: 10 30 300 600");
            const min = parseInt(parts[0]), max = parseInt(parts[1]);
            const espCuenta = parts[2] ? parseInt(parts[2]) : 300;
            const espCiclo = parts[3] ? parseInt(parts[3]) : 600;
            if (isNaN(min) || isNaN(max)) return await send(jid, "\u274C Deben ser numeros.");
            if (min < 3) return await send(jid, "\u274C Minimo 3 segundos entre grupos.");
            if (max > 3600) return await send(jid, "\u274C Maximo 3600 segundos.");
            db.setCampanaConfig(data.campanaId, min, Math.max(min, max), espCuenta, espCiclo);
            clearState(jid);
            await send(jid,
                `\u2705 *Intervalo actualizado:*\n` +
                `\u2022 Entre grupos: ${min}-${Math.max(min, max)}s\n` +
                `\u2022 Entre cuentas: ${espCuenta}s (${Math.round(espCuenta/60)} min)\n` +
                `\u2022 Entre ciclos: ${espCiclo}s (${Math.round(espCiclo/60)} min)`
            );
            return await showIntervalo(jid);
        }

        // --- PLANES / PAGO ---
        case "planes": {
            const planKeys = Object.keys(config.PLANES);
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= planKeys.length) {
                clearState(jid);
                return await sendMainMenu(jid, pushName);
            }
            const plan = planKeys[idx];
            const info = config.PLANES[plan];
            const user = db.getUsuario(jid);
            const clientCodigo = user ? (user.codigo || "???") : "???";
            setState(jid, "pago_todo", { plan, dias: info.dias, precio: info.precio, emoji: info.emoji });
            return await send(jid,
                `\u{1F4B3} *PROCESO DE PAGO*\n\n` +
                `Plan: ${info.emoji} ${plan.charAt(0).toUpperCase() + plan.slice(1)} \u2014 ${info.precio}\n\n` +
                `\u{1F4F1} Env\u00EDa tu pago por YAPE a:\n   ${config.YAPE_NUM}\n\n` +
                `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
                `\u{1F4F8} *Env\u00EDa la FOTO del pago* con este texto\nen la descripcion de la foto:\n\n` +
                `*NombreYape | CodigoVerificacion*\n\n` +
                `Ejemplo: Juan Perez | 839201\n\n` +
                `\u{1F4A1} Adjunta la captura y escribe nombre\ny codigo separados por *|*\n\n` +
                `Escribe *0* para cancelar.`
            );
        }

        case "pago_todo": {
            const imageMsg = msg.message?.imageMessage;
            if (!imageMsg) {
                return await send(jid, "\u274C Debes enviar una *FOTO* de la captura del pago.\n\nEn la descripcion de la foto escribe:\n*NombreYape | CodigoVerificacion*\n\nEj: Juan Perez | 839201");
            }
            const caption = imageMsg.caption || "";
            const partesPago = caption.split("|").map(p => p.trim());
            if (partesPago.length < 2 || !partesPago[0] || !partesPago[1]) {
                return await send(jid, "\u274C En la descripcion de la foto escribe:\n*NombreYape | CodigoVerificacion*\n\nEj: Juan Perez | 839201\n\nIntenta de nuevo enviando la foto.");
            }
            const nombreYape = partesPago[0];
            const codigo = partesPago[1];
            const { plan, dias, precio, emoji } = data;

            let imgBuffer = null;
            let imgPath = null;
            try {
                const stream = await downloadMediaMessage(msg, "buffer", {});
                imgBuffer = Buffer.isBuffer(stream) ? stream : Buffer.from(stream);
                fs.mkdirSync("media", { recursive: true });
                imgPath = `media/pago_${jidToNumber(jid)}_${Date.now()}.jpg`;
                fs.writeFileSync(imgPath, imgBuffer);
            } catch (e) {
                try {
                    const stream2 = await botSock.downloadMediaMessage(msg);
                    imgBuffer = Buffer.isBuffer(stream2) ? stream2 : Buffer.from(stream2);
                    fs.mkdirSync("media", { recursive: true });
                    imgPath = `media/pago_${jidToNumber(jid)}_${Date.now()}.jpg`;
                    fs.writeFileSync(imgPath, imgBuffer);
                } catch (e2) {}
            }

            clearState(jid);

            await send(jid,
                `\u2705 *PAGO ENVIADO*\n\n` +
                `\u{1F4E6} Plan: ${emoji} ${plan.charAt(0).toUpperCase() + plan.slice(1)} \u2014 ${precio}\n` +
                `\u{1F464} Yape de: ${nombreYape}\n` +
                `\u{1F522} C\u00F3digo: ${codigo}\n\n` +
                `\u23F3 El admin revisar\u00E1 tu pago y activar\u00E1 tu membres\u00EDa.`
            );

            const clientUser = db.getUsuario(jid);
            const clientCodigo = clientUser ? clientUser.codigo : "???";
            const adminTarget = adminGroupJid || (botSock.user ? botSock.user.id : config.ADMIN_NUMBER + "@s.whatsapp.net");
            const pName = msg.pushName || jidToNumber(jid);

            try {
                const captionAdmin =
                    `\u{1F4B0} *SOLICITUD DE PAGO*\n\n` +
                    `\u{1F464} ${pName}\n` +
                    `\u{1F194} ${jidToNumber(jid)}\n\n` +
                    `\u{1F3F7} Codigo: *${clientCodigo}*\n\n` +
                    `\u{1F4E6} Plan: ${emoji} ${plan.charAt(0).toUpperCase() + plan.slice(1)} \u2014 ${precio}\n` +
                    `\u{1F4F1} Nombre Yape: ${nombreYape}\n` +
                    `\u{1F522} C\u00F3digo verificacion: ${codigo}\n\n` +
                    `Para activar responde:\n/activar ${clientCodigo} ${dias}`;

                if (imgBuffer) {
                    botIsSending = true;
                    const imgResult = await botSock.sendMessage(adminTarget, {
                        image: imgBuffer,
                        caption: captionAdmin,
                    });
                    trackSent(imgResult);
                    setTimeout(() => { botIsSending = false; }, 2000);
                } else {
                    await send(adminTarget, captionAdmin);
                }
            } catch (e) {
                console.error("Error notificando admin:", e.message);
                try {
                    await send(adminTarget,
                        `\u{1F4B0} *SOLICITUD DE PAGO*\n\n` +
                        `\u{1F464} ${pName}\n` +
                        `\u{1F3F7} Codigo: *${clientCodigo}*\n\n` +
                        `\u{1F4E6} Plan: ${emoji} ${plan.charAt(0).toUpperCase() + plan.slice(1)} \u2014 ${precio}\n` +
                        `\u{1F4F1} Nombre Yape: ${nombreYape}\n` +
                        `\u{1F522} C\u00F3digo verificacion: ${codigo}\n\n` +
                        `(foto no disponible)\n\n` +
                        `Para activar responde:\n/activar ${clientCodigo} ${dias}`
                    );
                } catch (e2) {}
            }
            return;
        }

        // --- RESPONDER ---
        case "responder": {
            if (trimmed === "1") {
                setState(jid, "responder_contacto");
                return await send(jid, "Escribe el *numero/contacto* para auto-responder:\n\nEj: +51987654321\n\n*0.* Cancelar");
            }
            if (trimmed === "2") {
                setState(jid, "responder_keywords");
                return await send(jid, "Escribe las *palabras clave* separadas por coma:\n\nEj: precio, info, disponible\n\n*0.* Cancelar");
            }
            if (trimmed === "3") {
                const conf = db.getResponderConfig(jid);
                if (conf) {
                    if (conf.activo) {
                        motor.detenerResponder(jid);
                        db.toggleResponder(jid, 0);
                        await send(jid, "\u274C Auto-responder desactivado.");
                    } else {
                        const keywords = db.getKeywords(jid);
                        if (!conf.contacto || !keywords.length) {
                            return await send(jid, "\u26A0 Configura contacto y keywords primero.");
                        }
                        db.toggleResponder(jid, 1);
                        motor.iniciarResponder(jid, conf.contacto, keywords, botSock);
                        await send(jid, "\u2705 Auto-responder activado!");
                    }
                }
                return await showResponder(jid);
            }
            return await sendMainMenu(jid, pushName);
        }

        case "responder_contacto": {
            db.setResponderConfig(jid, trimmed, 0);
            clearState(jid);
            await send(jid, `\u2705 Contacto configurado: ${trimmed}`);
            return await showResponder(jid);
        }

        case "responder_keywords": {
            const palabras = trimmed.split(",").map(p => p.trim()).filter(p => p);
            db.limpiarKeywords(jid);
            db.agregarKeywords(jid, palabras);
            clearState(jid);
            await send(jid, `\u2705 ${palabras.length} keyword(s) configuradas.`);
            return await showResponder(jid);
        }

        // --- ELIMINAR ---
        case "eliminar": {
            if (trimmed === "1") {
                db.eliminarTodosGrupos(jid);
                clearState(jid);
                await send(jid, "\u2705 Todos los grupos eliminados.");
                return await sendMainMenu(jid, pushName);
            }
            if (trimmed === "2") {
                db.limpiarHistorial(jid);
                clearState(jid);
                await send(jid, "\u2705 Historial limpiado.");
                return await sendMainMenu(jid, pushName);
            }
            if (trimmed === "3") {
                const campanas = db.getCampanas(jid);
                if (!campanas.length) {
                    clearState(jid);
                    return await send(jid, "No tienes campanas.");
                }
                let texto = "\u{1F5D1} *ELIMINAR CAMPANAS*\n\n";
                for (let i = 0; i < campanas.length; i++) {
                    texto += `*${i + 1}.* ${campanas[i].nombre}\n`;
                }
                texto += `\n\u{1F4A1} Escribe los numeros separados por coma:`;
                texto += `\nEj: *1,2* o *T* para eliminar todas`;
                texto += "\n\n*0.* Cancelar";
                setState(jid, "camp_eliminar", { campanas });
                return await send(jid, texto);
            }
            return await sendMainMenu(jid, pushName);
        }

        // ==========================================
        // MEJORA 15: TEMPLATES
        // ==========================================
        case "templates_menu": {
            if (trimmed === "1") {
                setState(jid, "template_nombre");
                return await send(jid, "\u{1F4DD} Escribe el *nombre* del template:\n\n*0.* Cancelar");
            }
            if (trimmed === "2") {
                const templates = db.getTemplates(jid);
                if (!templates.length) return await send(jid, "No tienes templates.");
                let texto = "\u{1F5D1} Selecciona template a eliminar:\n\n";
                for (let i = 0; i < templates.length; i++) {
                    texto += `*${i + 1}.* ${templates[i].nombre}\n`;
                }
                texto += `\n*T* para eliminar todos\n*0.* Cancelar`;
                setState(jid, "template_del", { templates });
                return await send(jid, texto);
            }
            if (trimmed === "3") {
                const templates = db.getTemplates(jid);
                if (!templates.length) return await send(jid, "No tienes templates.");
                let texto = "\u{1F4CB} *TUS TEMPLATES:*\n\n";
                for (const t of templates) {
                    texto += `\u{1F4DD} *${t.nombre}*\n`;
                    texto += `${t.mensaje.substring(0, 100)}${t.mensaje.length > 100 ? "..." : ""}\n\n`;
                }
                return await send(jid, texto + "\n*0.* Volver al menu");
            }
            return await sendMainMenu(jid, pushName);
        }

        case "template_nombre": {
            setState(jid, "template_mensaje", { nombre: trimmed });
            return await send(jid, "\u{1F4DD} Ahora escribe el *mensaje* del template:\n\n*0.* Cancelar");
        }

        case "template_mensaje": {
            db.agregarTemplate(jid, data.nombre, trimmed);
            clearState(jid);
            await send(jid, `\u2705 Template '${data.nombre}' creado.`);
            return await showTemplates(jid);
        }

        case "template_del": {
            if (lower === "t" || lower === "todos") {
                for (const t of data.templates) db.eliminarTemplate(t.id);
                clearState(jid);
                await send(jid, `\u2705 ${data.templates.length} template(s) eliminados.`);
                return await showTemplates(jid);
            }
            const indices = trimmed.split(/[,\s]+/).map(n => parseInt(n) - 1);
            let deleted = 0;
            for (const idx of [...new Set(indices)].sort((a, b) => b - a)) {
                if (idx >= 0 && idx < data.templates.length) {
                    db.eliminarTemplate(data.templates[idx].id);
                    deleted++;
                }
            }
            clearState(jid);
            if (deleted) await send(jid, `\u2705 ${deleted} template(s) eliminado(s).`);
            else await send(jid, "\u274C Seleccion invalida.");
            return await showTemplates(jid);
        }

        // ==========================================
        // MEJORA 16: BLACKLIST
        // ==========================================
        case "blacklist_menu": {
            if (trimmed === "1") {
                const grupos = db.getGrupos(jid);
                if (!grupos.length) return await send(jid, "No tienes grupos registrados.");
                let texto = "\u{1F6AB} Selecciona grupo(s) para blacklist:\n\n";
                for (let i = 0; i < grupos.length; i++) {
                    const display = grupos[i].nombre || grupos[i].link.substring(0, 40);
                    texto += `*${i + 1}.* ${display}\n`;
                }
                texto += `\nEj: *1,3,5* o *T* para todos\n*0.* Cancelar`;
                setState(jid, "blacklist_add", { grupos });
                return await send(jid, texto);
            }
            if (trimmed === "2") {
                const bl = db.getBlacklist(jid);
                if (!bl.length) return await send(jid, "Blacklist vacia.");
                let texto = "\u{1F6AB} Selecciona para quitar de blacklist:\n\n";
                for (let i = 0; i < bl.length; i++) {
                    texto += `*${i + 1}.* ${bl[i].grupo_link.substring(0, 40)}\n`;
                }
                texto += `\n*T* para limpiar toda la blacklist\n*0.* Cancelar`;
                setState(jid, "blacklist_del", { blacklist: bl });
                return await send(jid, texto);
            }
            if (trimmed === "3") {
                const bl = db.getBlacklist(jid);
                if (!bl.length) return await send(jid, "Blacklist vacia.");
                let texto = "\u{1F6AB} *BLACKLIST:*\n\n";
                for (const b of bl) {
                    texto += `\u2022 ${b.grupo_link.substring(0, 40)}${b.razon ? ` (${b.razon})` : ""}\n`;
                }
                return await send(jid, texto + "\n*0.* Volver");
            }
            return await sendMainMenu(jid, pushName);
        }

        case "blacklist_add": {
            const indices = trimmed.split(/[,\s]+/).map(n => parseInt(n) - 1);
            let added = 0;
            if (lower === "t" || lower === "todos") {
                for (const g of data.grupos) { db.agregarBlacklist(jid, g.link); added++; }
            } else {
                for (const idx of new Set(indices)) {
                    if (idx >= 0 && idx < data.grupos.length) {
                        db.agregarBlacklist(jid, data.grupos[idx].link);
                        added++;
                    }
                }
            }
            clearState(jid);
            if (added) await send(jid, `\u2705 ${added} grupo(s) agregado(s) a blacklist.`);
            else await send(jid, "\u274C Seleccion invalida.");
            return await showBlacklist(jid);
        }

        case "blacklist_del": {
            if (lower === "t" || lower === "todos") {
                db.limpiarBlacklist(jid);
                clearState(jid);
                await send(jid, "\u2705 Blacklist limpiada.");
                return await showBlacklist(jid);
            }
            const indices = trimmed.split(/[,\s]+/).map(n => parseInt(n) - 1);
            let deleted = 0;
            for (const idx of [...new Set(indices)].sort((a, b) => b - a)) {
                if (idx >= 0 && idx < data.blacklist.length) {
                    db.eliminarBlacklistById(data.blacklist[idx].id);
                    deleted++;
                }
            }
            clearState(jid);
            if (deleted) await send(jid, `\u2705 ${deleted} grupo(s) quitado(s) de blacklist.`);
            else await send(jid, "\u274C Seleccion invalida.");
            return await showBlacklist(jid);
        }

        // ==========================================
        // MEJORA 18: HORARIO
        // ==========================================
        case "horario_select": {
            const campanas = db.getCampanas(jid);
            const idx = parseInt(trimmed) - 1;
            if (isNaN(idx) || idx < 0 || idx >= campanas.length) {
                clearState(jid);
                return await sendMainMenu(jid, pushName);
            }
            const c = campanas[idx];
            const h = db.getCampanaHorario(c.id);
            setState(jid, "horario_set", { campanaId: c.id, nombre: c.nombre });
            return await send(jid, `\u{1F553} *${c.nombre}*\nHorario actual: ${h.hora_inicio}:00 - ${h.hora_fin}:00\n\nEscribe el nuevo horario:\nEj: *8-22* (8am a 10pm)\nEj: *0-24* (todo el dia)\n\n*0.* Cancelar`);
        }

        case "horario_set": {
            const parts = trimmed.split(/[-:,\s]+/).map(n => parseInt(n));
            if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1]) || parts[0] < 0 || parts[0] > 23 || parts[1] < 1 || parts[1] > 24) {
                return await send(jid, "\u274C Formato invalido. Ej: *8-22*");
            }
            db.setCampanaHorario(data.campanaId, parts[0], parts[1]);
            clearState(jid);
            await send(jid, `\u2705 Horario de '${data.nombre}' actualizado: ${parts[0]}:00 - ${parts[1]}:00`);
            return await sendMainMenu(jid, pushName);
        }

        // ==========================================
        // MEJORA 19: SINONIMOS
        // ==========================================
        case "sinonimos_menu": {
            if (trimmed === "1") {
                setState(jid, "sinonimo_palabra");
                return await send(jid, "\u{1F504} Escribe la *palabra* original:\n\nEj: Hola\n\n*0.* Cancelar");
            }
            if (trimmed === "2") {
                const sins = db.getSinonimos(jid);
                if (!sins.length) return await send(jid, "No tienes sinonimos.");
                let texto = "\u{1F5D1} Selecciona sinonimo a eliminar:\n\n";
                for (let i = 0; i < sins.length; i++) {
                    texto += `*${i + 1}.* ${sins[i].palabra} -> ${sins[i].alternativas}\n`;
                }
                texto += `\n*T* para eliminar todos\n*0.* Cancelar`;
                setState(jid, "sinonimo_del", { sinonimos: sins });
                return await send(jid, texto);
            }
            if (trimmed === "3") {
                const sins = db.getSinonimos(jid);
                if (!sins.length) return await send(jid, "No tienes sinonimos.");
                let texto = "\u{1F504} *TUS SINONIMOS:*\n\n";
                for (const s of sins) {
                    texto += `\u2022 *${s.palabra}* -> ${s.alternativas}\n`;
                }
                texto += `\n\u{1F4A1} Ejemplo: si tienes "Hola -> Hey,Que tal"\nEl bot enviara "Hola", "Hey" o "Que tal" aleatoriamente.`;
                return await send(jid, texto + "\n\n*0.* Volver");
            }
            return await sendMainMenu(jid, pushName);
        }

        case "sinonimo_palabra": {
            setState(jid, "sinonimo_alternativas", { palabra: trimmed });
            return await send(jid, `\u{1F504} Ahora escribe las *alternativas* para "${trimmed}" separadas por coma:\n\nEj: Hey, Que tal, Buenos dias\n\n*0.* Cancelar`);
        }

        case "sinonimo_alternativas": {
            db.agregarSinonimo(jid, data.palabra, trimmed);
            clearState(jid);
            await send(jid, `\u2705 Sinonimo creado: "${data.palabra}" -> "${trimmed}"`);
            return await showSinonimos(jid);
        }

        case "sinonimo_del": {
            if (lower === "t" || lower === "todos") {
                db.limpiarSinonimos(jid);
                clearState(jid);
                await send(jid, "\u2705 Todos los sinonimos eliminados.");
                return await showSinonimos(jid);
            }
            const indices = trimmed.split(/[,\s]+/).map(n => parseInt(n) - 1);
            let deleted = 0;
            for (const idx of [...new Set(indices)].sort((a, b) => b - a)) {
                if (idx >= 0 && idx < data.sinonimos.length) {
                    db.eliminarSinonimo(data.sinonimos[idx].id);
                    deleted++;
                }
            }
            clearState(jid);
            if (deleted) await send(jid, `\u2705 ${deleted} sinonimo(s) eliminado(s).`);
            else await send(jid, "\u274C Seleccion invalida.");
            return await showSinonimos(jid);
        }

        // ==========================================
        // MEJORA 20: EXPORTAR/IMPORTAR
        // ==========================================
        case "exportar_menu": {
            if (trimmed === "1") {
                const grupos = db.exportarGrupos(jid);
                if (!grupos.length) return await send(jid, "No tienes grupos.");
                let texto = "\u{1F4E6} *EXPORTAR GRUPOS*\n\nCopia y guarda este texto:\n\n---\n";
                for (const g of grupos) {
                    texto += `${g.link}|${g.nombre || ""}\n`;
                }
                texto += "---\n\n*0.* Volver";
                clearState(jid);
                return await send(jid, texto);
            }
            if (trimmed === "2") {
                setState(jid, "importar_grupos");
                return await send(jid, "\u{1F4E5} Pega los grupos a importar:\n\nFormato (uno por linea):\nlink_grupo|nombre\n\nO simplemente pega los links:\nhttps://chat.whatsapp.com/xxx\n\n*0.* Cancelar");
            }
            if (trimmed === "3") {
                const campanas = db.exportarCampanas(jid);
                if (!campanas.length) return await send(jid, "No tienes campanas.");
                let texto = "\u{1F4E6} *CAMPANAS EXPORTADAS*\n\n";
                for (const c of campanas) {
                    texto += `\u{1F4CB} *${c.nombre}*\n`;
                    texto += `Mensaje: ${c.mensaje.substring(0, 80)}...\n`;
                    texto += `Cuentas: ${c.sesiones.join(", ") || "ninguna"}\n`;
                    texto += `Grupos: ${c.grupos.length}\n\n`;
                }
                clearState(jid);
                return await send(jid, texto + "*0.* Volver");
            }
            return await sendMainMenu(jid, pushName);
        }

        case "importar_grupos": {
            const lines = trimmed.split("\n").map(l => l.trim()).filter(l => l);
            let added = 0;
            const maxG = db.getMaxGrupos(jid);
            const current = db.getGrupos(jid);
            for (const line of lines) {
                if (current.length + added >= maxG) break;
                const parts = line.split("|");
                const link = parts[0].trim();
                const nombre = parts[1] ? parts[1].trim() : null;
                if (link.includes("chat.whatsapp.com/") || link.endsWith("@g.us")) {
                    if (db.agregarGrupo(jid, link, nombre)) added++;
                }
            }
            clearState(jid);
            if (added) await send(jid, `\u2705 ${added} grupo(s) importado(s).`);
            else await send(jid, "\u274C No se pudo importar ningun grupo.");
            return await showExportar(jid);
        }

        default:
            clearState(jid);
            return await sendMainMenu(jid, pushName);
    }
}

// ==========================================
// NUEVAS FUNCIONES show*
// ==========================================

// --- 15. TEMPLATES ---
async function showTemplates(jid) {
    clearState(jid);
    const templates = db.getTemplates(jid);
    let texto = `\u{1F4DD} *TEMPLATES DE MENSAJES*\n\n`;
    texto += `Total: ${templates.length}\n\n`;
    if (templates.length) {
        for (const t of templates) {
            texto += `\u2022 *${t.nombre}*: ${t.mensaje.substring(0, 50)}...\n`;
        }
        texto += `\n`;
    }
    texto += `\u{1F4A1} Los templates se rotan automaticamente al enviar campanas.\n\n`;
    texto += `*1.* \u2795 Crear template\n`;
    texto += `*2.* \u{1F5D1} Eliminar template\n`;
    texto += `*3.* \u{1F4CB} Ver todos\n\n`;
    texto += `*0.* \u{1F519} Volver al menu`;
    setState(jid, "templates_menu");
    return await send(jid, texto);
}

// --- 16. BLACKLIST ---
async function showBlacklist(jid) {
    clearState(jid);
    const bl = db.getBlacklist(jid);
    let texto = `\u{1F6AB} *BLACKLIST DE GRUPOS*\n\n`;
    texto += `Grupos bloqueados: ${bl.length}\n`;
    texto += `\u{1F4A1} Los grupos en blacklist no reciben mensajes de campanas.\n\n`;
    texto += `*1.* \u2795 Agregar a blacklist\n`;
    texto += `*2.* \u{1F5D1} Quitar de blacklist\n`;
    texto += `*3.* \u{1F4CB} Ver blacklist\n\n`;
    texto += `*0.* \u{1F519} Volver al menu`;
    setState(jid, "blacklist_menu");
    return await send(jid, texto);
}

// --- 17. GRUPO STATS ---
async function showGrupoStats(jid) {
    clearState(jid);
    const top = db.getGrupoStatsTop(jid, 10);
    const worst = db.getGrupoStatsWorst(jid, 5);

    let texto = `\u{1F4CA} *ESTADISTICAS POR GRUPO*\n\n`;

    if (top.length) {
        texto += `\u{1F3C6} *TOP 10 - Mejor tasa de exito:*\n`;
        for (let i = 0; i < top.length; i++) {
            const g = top[i];
            const name = g.grupo_link.substring(0, 30);
            texto += `${i + 1}. ${name} - ${g.tasa_exito}% (\u2705${g.enviados} \u274C${g.fallidos} \u23F3${g.pending})\n`;
        }
    } else {
        texto += `Sin estadisticas aun. Inicia una campana primero.\n`;
    }

    if (worst.length) {
        texto += `\n\u26A0 *PEORES GRUPOS (considerar eliminar):*\n`;
        for (const g of worst) {
            const name = g.grupo_link.substring(0, 30);
            texto += `\u2022 ${name} - ${g.tasa_exito}% exito\n`;
        }
    }

    texto += `\n*0.* \u{1F519} Volver al menu`;
    return await send(jid, texto);
}

// --- 18. HORARIO ---
async function showHorario(jid) {
    clearState(jid);
    const campanas = db.getCampanas(jid);
    if (!campanas.length) return await send(jid, "No tienes campanas.\n\n*0.* Volver");
    let texto = `\u{1F553} *PROGRAMAR HORARIO*\n\n`;
    texto += `\u{1F4A1} Define cuando la campana puede enviar mensajes.\nFuera de horario, la campana se pausa automaticamente.\n\n`;
    for (let i = 0; i < campanas.length; i++) {
        const h = db.getCampanaHorario(campanas[i].id);
        const horarioStr = (h.hora_inicio === 0 && h.hora_fin === 24) ? "Todo el dia" : `${h.hora_inicio}:00 - ${h.hora_fin}:00`;
        texto += `*${i + 1}.* ${campanas[i].nombre} (${horarioStr})\n`;
    }
    texto += `\n*0.* \u{1F519} Volver al menu`;
    setState(jid, "horario_select");
    return await send(jid, texto);
}

// --- 19. SINONIMOS ---
async function showSinonimos(jid) {
    clearState(jid);
    const sins = db.getSinonimos(jid);
    let texto = `\u{1F504} *VARIACION DE MENSAJES (SINONIMOS)*\n\n`;
    texto += `Total: ${sins.length} sinonimo(s)\n`;
    texto += `\u{1F4A1} El bot reemplaza palabras por sus sinonimos aleatoriamente.\nCada mensaje es diferente para evitar deteccion de spam.\n\n`;
    if (sins.length) {
        for (const s of sins) {
            texto += `\u2022 *${s.palabra}* -> ${s.alternativas}\n`;
        }
        texto += `\n`;
    }
    texto += `*1.* \u2795 Agregar sinonimo\n`;
    texto += `*2.* \u{1F5D1} Eliminar sinonimo\n`;
    texto += `*3.* \u{1F4CB} Ver todos\n\n`;
    texto += `*0.* \u{1F519} Volver al menu`;
    setState(jid, "sinonimos_menu");
    return await send(jid, texto);
}

// --- 20. EXPORTAR/IMPORTAR ---
async function showExportar(jid) {
    clearState(jid);
    let texto = `\u{1F4E6} *EXPORTAR / IMPORTAR*\n\n`;
    texto += `*1.* \u{1F4E4} Exportar grupos\n`;
    texto += `*2.* \u{1F4E5} Importar grupos\n`;
    texto += `*3.* \u{1F4E4} Exportar campanas (solo ver)\n\n`;
    texto += `*0.* \u{1F519} Volver al menu`;
    setState(jid, "exportar_menu");
    return await send(jid, texto);
}

// --- 21. LIMITE DIARIO ---
async function showLimiteDiario(jid) {
    clearState(jid);
    const envios = db.getEnviosDiariosTotal(jid);
    const baneadas = db.getCuentasBaneadas(jid);
    let texto = `\u{1F6E1} *LIMITE DIARIO DE ENVIOS*\n\n`;
    texto += `Limite actual: *${motor.LIMITE_ENVIOS_DIARIOS}* envios por cuenta/dia\n\n`;

    if (envios.length) {
        texto += `\u{1F4CA} *Envios hoy:*\n`;
        for (const e of envios) {
            const pct = Math.round(e.total / motor.LIMITE_ENVIOS_DIARIOS * 100);
            texto += `\u2022 ${e.cuenta_nombre}: ${e.total}/${motor.LIMITE_ENVIOS_DIARIOS} (${pct}%)\n`;
        }
    } else {
        texto += `Sin envios hoy.\n`;
    }

    if (baneadas.length) {
        texto += `\n\u{1F6A8} *Cuentas baneadas:*\n`;
        for (const b of baneadas) {
            texto += `\u2022 ${b.cuenta_nombre} (desde: ${b.fecha_ban})\n`;
        }
        texto += `\n\u{1F4A1} Para desmarcar una cuenta baneada, escribe:\n/desmarcarban [nombre_cuenta]`;
    }

    texto += `\n\n*0.* \u{1F519} Volver al menu`;
    return await send(jid, texto);
}

// --- 22. REPORTE DIARIO ---
async function showReporteDiario(jid) {
    clearState(jid);
    const reporte = db.getReporteDiario(jid);
    const baneadas = db.getCuentasBaneadas(jid);
    let texto = `\u{1F4CA} *REPORTE DEL DIA*\n\n`;
    texto += `\u{1F4E8} Total envios: ${reporte.totalEnvios}\n`;
    texto += `\u2705 Exitosos: ${reporte.exitosos}\n`;
    texto += `\u274C Fallidos: ${reporte.fallidos}\n`;
    if (reporte.totalEnvios > 0) {
        texto += `\u{1F3AF} Tasa exito: ${Math.round(reporte.exitosos / reporte.totalEnvios * 100)}%\n`;
    }
    texto += `\u{1F4AC} Respuestas: ${reporte.respuestas}\n`;

    if (reporte.porCuenta.length) {
        texto += `\n\u{1F464} *Por cuenta:*\n`;
        for (const c of reporte.porCuenta) {
            texto += `\u2022 ${c.cuenta_nombre}: ${c.total} envios\n`;
        }
    }

    if (baneadas.length) {
        texto += `\n\u{1F6A8} Cuentas baneadas: ${baneadas.map(b => b.cuenta_nombre).join(", ")}`;
    }

    // Activar reporte automatico diario
    motor.iniciarReporteDiario(jid, botSock);

    texto += `\n\n\u{1F4A1} El reporte automatico se envia cada 24h.`;
    texto += `\n\n*0.* \u{1F519} Volver al menu`;
    return await send(jid, texto);
}

// --- INICIAR ---
const NO_WSP_BOT = process.env.NO_WSP_BOT === "1" || process.env.NO_WSP_BOT === "true";

// Inicializar DB y directorios siempre (necesario para API)
db.init();
db.setAdminJids(adminJids);
fs.mkdirSync("sessions", { recursive: true });
fs.mkdirSync(config.SESSIONS_DIR, { recursive: true });
fs.mkdirSync("media", { recursive: true });

if (NO_WSP_BOT) {
    botStatus = "solo_api";
    console.log("\n\u{1F4E1} Modo SOLO API (sin cuenta de bot WSP).");
    console.log("   Notificaciones y comandos solo por Telegram.");
    console.log(`   API disponible en http://0.0.0.0:${QR_PORT}\n`);
} else {
    startBot();
}

// --- SCHEDULER: Envios programados (cada minuto) ---
setInterval(async () => {
    try {
        const ahora = new Date();
        const hora = parseInt(ahora.toLocaleString("en-US", { timeZone: config.TIMEZONE, hour: "numeric", hour12: false }));
        const minuto = ahora.getMinutes();
        const hoy = ahora.toISOString().split("T")[0];

        const programados = db.getEnviosProgramadosActivos();
        for (const prog of programados) {
            if (prog.hora !== hora || prog.minuto !== minuto) continue;
            if (prog.ultimo_envio && prog.ultimo_envio.startsWith(hoy) && !prog.repetir) continue;

            console.log(`[Scheduler] Ejecutando envio programado #${prog.id}: ${prog.mensaje_nombre}`);
            db.actualizarUltimoEnvio(prog.id);

            const grupos = db.getGrupos(prog.user_id);
            if (!grupos.length) continue;
            const sesiones = db.getSesiones(prog.user_id);
            if (!sesiones.length) continue;

            const envioId = db.crearEnvioUnico(prog.user_id, prog.mensaje_id, grupos.length);
            let ok = 0, errores = 0;
            const socks = [];
            for (const s of sesiones) {
                try { socks.push(await motor.getOrConnectClient(prog.user_id, s.nombre)); } catch (e) {}
            }
            if (!socks.length) { db.actualizarEnvioUnico(envioId, 0, grupos.length, "error"); continue; }

            let sockIdx = 0;
            for (const g of grupos) {
                const sock = socks[sockIdx % socks.length];
                sockIdx++;
                try {
                    const groupJid = await motor.resolveGroupJid(sock, g.link);
                    if (!groupJid) { errores++; continue; }
                    const texto = motor.variarMensaje(prog.texto, prog.user_id);
                    const result = await motor.sendToGroup(sock, groupJid, texto, prog.imagen_path);
                    if (result.sent) { ok++; } else { errores++; }
                } catch (e) { errores++; }
                await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));
            }
            db.actualizarEnvioUnico(envioId, ok, errores, "completado");

            if (!prog.repetir) {
                db.toggleEnvioProgramado(prog.id, false);
            }
        }
    } catch (e) {
        console.error(`[Scheduler] Error: ${e.message}`);
    }
}, 60000);
