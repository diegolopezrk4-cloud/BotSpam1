const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const db = require("./db_wsp");
const config = require("./config_wsp");

// Helper: detectar tipo de medio y construir payload para sendMessage
function buildMediaPayload(filePath, caption) {
    if (!filePath || !fs.existsSync(filePath)) return caption ? { text: caption } : null;
    const ext = path.extname(filePath).toLowerCase();
    const fileBuffer = fs.readFileSync(filePath);
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
        return { image: fileBuffer, caption: caption || "" };
    } else if ([".mp4", ".avi", ".mov", ".mkv", ".3gp"].includes(ext)) {
        return { video: fileBuffer, caption: caption || "" };
    } else if ([".mp3", ".ogg", ".m4a", ".wav", ".aac"].includes(ext)) {
        if (ext === ".ogg") {
            return { audio: fileBuffer, mimetype: "audio/ogg; codecs=opus", ptt: true };
        }
        return { audio: fileBuffer, mimetype: `audio/${ext.replace(".", "")}` };
    } else if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".zip"].includes(ext)) {
        return { document: fileBuffer, fileName: path.basename(filePath), caption: caption || "" };
    }
    return { document: fileBuffer, fileName: path.basename(filePath), caption: caption || "" };
}

// Helper: enviar mensaje y registrar para tasa de entrega
async function sendAndTrack(sock, jid, payload, userId) {
    const result = await sock.sendMessage(jid, payload);
    if (result?.key?.id && userId) {
        db.registrarMsgEnviado(userId, jid, result.key.id);
    }
    return result;
}

const tareasActivas = {};    // { campanaId: { running, cancel } }
const responderActivos = {}; // { userId: { running, cancel } }
const clientSessions = {};   // { "userId_nombre": socket }
const pendingLinks = {};     // { "userId_nombre": { qr, status, error } }
const clientChats = {};      // { "userId_nombre": { jid: { id, name } } } — chats capturados

function setupChatCapture(sock, key) {
    if (!clientChats[key]) clientChats[key] = {};
    sock.ev.on("messaging-history.set", ({ chats, contacts }) => {
        if (chats) {
            for (const c of chats) {
                if (c.id && c.id.endsWith("@s.whatsapp.net") && c.id !== "status@broadcast") {
                    clientChats[key][c.id] = { id: c.id, name: c.name || c.notify || null };
                }
            }
        }
        if (contacts) {
            for (const c of contacts) {
                if (c.id && c.id.endsWith("@s.whatsapp.net") && c.id !== "status@broadcast") {
                    if (!clientChats[key][c.id]) clientChats[key][c.id] = { id: c.id };
                    clientChats[key][c.id].name = c.name || c.notify || clientChats[key][c.id].name || null;
                }
            }
        }
    });
    sock.ev.on("chats.upsert", (newChats) => {
        for (const c of newChats) {
            if (c.id && c.id.endsWith("@s.whatsapp.net") && c.id !== "status@broadcast") {
                if (!clientChats[key][c.id]) clientChats[key][c.id] = { id: c.id };
                if (c.name) clientChats[key][c.id].name = c.name;
            }
        }
    });
    sock.ev.on("contacts.upsert", (newContacts) => {
        for (const c of newContacts) {
            if (c.id && c.id.endsWith("@s.whatsapp.net") && c.id !== "status@broadcast") {
                if (!clientChats[key][c.id]) clientChats[key][c.id] = { id: c.id };
                clientChats[key][c.id].name = c.name || c.notify || clientChats[key][c.id].name || null;
            }
        }
    });
    sock.ev.on("messages.upsert", ({ messages }) => {
        for (const m of messages) {
            const jid = m.key?.remoteJid;
            if (jid && jid.endsWith("@s.whatsapp.net") && jid !== "status@broadcast") {
                if (!clientChats[key][jid]) {
                    clientChats[key][jid] = { id: jid, name: m.pushName || null };
                } else if (m.pushName && !clientChats[key][jid].name) {
                    clientChats[key][jid].name = m.pushName;
                }
            }
        }
    });
    // Capturar receipts para tasa de entrega
    sock.ev.on("message-receipt.update", (updates) => {
        for (const update of updates) {
            const msgId = update.key?.id;
            if (!msgId) continue;
            if (update.receipt?.receiptTimestamp) {
                db.actualizarEstadoMsg(msgId, "delivered");
            }
            if (update.receipt?.readTimestamp) {
                db.actualizarEstadoMsg(msgId, "read");
            }
        }
    });
}
const reporteInterval = {};  // { userId: intervalId }

// Limite de envios diarios por cuenta (proteccion anti-ban)
const LIMITE_ENVIOS_DIARIOS = 500;

let _botSock = null;
let _botNombre = "Bot_Principal";

function setBotSocket(sock) {
    _botSock = sock;
}

function getSessionDir(userId, nombre) {
    const safe = `${userId.replace(/[^a-zA-Z0-9]/g, "_")}_${nombre}`;
    return path.join(config.SESSIONS_DIR, safe);
}

async function connectClientAccount(userId, nombre, telefono) {
    const sessionDir = getSessionDir(userId, nombre);
    fs.mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try {
        const { version: v } = await fetchLatestBaileysVersion();
        version = v;
    } catch (e) {}

    const sock = makeWASocket({
        auth: state,
        logger: require("pino")({ level: "silent" }),
        browser: Browsers.ubuntu("Chrome"),
        version,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2000,
    });
    sock.ev.on("creds.update", saveCreds);
    const chatKey = `${userId}_${nombre}`;
    setupChatCapture(sock, chatKey);

    return new Promise((resolve, reject) => {
        let resolved = false;
        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open" && !resolved) {
                resolved = true;
                clientSessions[chatKey] = sock;
                resolve(sock);
            }
            if (connection === "close" && !resolved) {
                resolved = true;
                reject(new Error("Conexion cerrada"));
            }
        });
        setTimeout(() => {
            if (!resolved) { resolved = true; reject(new Error("Timeout conectando cuenta")); }
        }, 60000);
    });
}

// Vincular cuenta de cliente con QR
async function linkAccount(userId, nombre) {
    const key = `${userId}_${nombre}`;

    if (pendingLinks[key] && pendingLinks[key].sock) {
        try { pendingLinks[key].sock.end(); } catch (e) {}
    }

    const sessionDir = getSessionDir(userId, nombre);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(sessionDir, { recursive: true });

    let version;
    try {
        const { version: v } = await fetchLatestBaileysVersion();
        version = v;
    } catch (e) {}

    const linkData = { qr: null, status: "conectando", error: null, sock: null };
    pendingLinks[key] = linkData;

    const MAX_RETRIES = 5;
    let attempt = 0;

    return new Promise((resolve, reject) => {
        let resolved = false;
        let globalTimeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                linkData.status = "timeout";
                linkData.error = "Timeout: no se escaneo el QR a tiempo.";
                reject(new Error("Timeout"));
            }
        }, 120000);

        async function tryConnect() {
            attempt++;
            if (attempt > MAX_RETRIES) {
                if (!resolved) {
                    resolved = true;
                    linkData.status = "error";
                    linkData.error = "Demasiados reintentos.";
                    clearTimeout(globalTimeout);
                    reject(new Error("Max retries"));
                }
                return;
            }

            const { state: freshState, saveCreds: freshSave } = await useMultiFileAuthState(sessionDir);
            const sock = makeWASocket({
                auth: freshState,
                logger: require("pino")({ level: "silent" }),
                browser: Browsers.ubuntu("Chrome"),
                version,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 2000,
            });
            sock.ev.on("creds.update", freshSave);
            setupChatCapture(sock, key);
            linkData.sock = sock;

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    linkData.qr = qr;
                    linkData.status = "esperando_qr";
                }

                if (connection === "open" && !resolved) {
                    resolved = true;
                    linkData.status = "conectado";
                    linkData.error = null;
                    const ckey = `${userId}_${nombre}`;
                    clientSessions[ckey] = sock;
                    clearTimeout(globalTimeout);
                    resolve({ success: true });
                }

                if (connection === "close" && !resolved) {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code === DisconnectReason.loggedOut || code === 401) {
                        resolved = true;
                        linkData.status = "error";
                        linkData.error = "Sesion rechazada. Intenta de nuevo.";
                        clearTimeout(globalTimeout);
                        reject(new Error("Sesion rechazada"));
                    } else {
                        linkData.status = "conectando";
                        await delay(3000);
                        tryConnect();
                    }
                }
            });
        }

        tryConnect();
    });
}

function getLinkStatus(userId, nombre) {
    const key = `${userId}_${nombre}`;
    return pendingLinks[key] || null;
}

function clearLink(userId, nombre) {
    const key = `${userId}_${nombre}`;
    if (pendingLinks[key]) {
        if (pendingLinks[key].sock) {
            try { pendingLinks[key].sock.end(); } catch (e) {}
        }
        delete pendingLinks[key];
    }
}

async function getOrConnectClient(userId, nombre) {
    if (nombre === _botNombre && _botSock && _botSock.user) {
        return _botSock;
    }
    const key = `${userId}_${nombre}`;
    if (clientSessions[key]) {
        try {
            if (clientSessions[key].user) return clientSessions[key];
        } catch (e) {}
    }
    const sesiones = db.getSesiones(userId);
    const sesion = sesiones.find(s => s.nombre === nombre);
    if (!sesion) throw new Error(`Cuenta '${nombre}' no encontrada`);
    return await connectClientAccount(userId, nombre, sesion.telefono);
}

// ============================================================
// MEJORA 6: Auto-reconexion de cuentas durante campana
// ============================================================
async function reconectarCuenta(userId, nombre) {
    const key = `${userId}_${nombre}`;
    // Limpiar sesion anterior
    if (clientSessions[key]) {
        try { clientSessions[key].end(); } catch (e) {}
        delete clientSessions[key];
    }
    // Reconectar
    try {
        const sesiones = db.getSesiones(userId);
        const sesion = sesiones.find(s => s.nombre === nombre);
        if (!sesion) return null;
        const sock = await connectClientAccount(userId, nombre, sesion.telefono);
        console.log(`[Reconexion] Cuenta '${nombre}' reconectada exitosamente`);
        return sock;
    } catch (e) {
        console.error(`[Reconexion] Error reconectando '${nombre}': ${e.message}`);
        return null;
    }
}

function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function addInvisibleChars(text) {
    const invisibles = ["\u200B", "\u200C", "\u200D", "\uFEFF"];
    let result = "";
    for (let i = 0; i < text.length; i++) {
        result += text[i];
        if (Math.random() < 0.05) {
            result += invisibles[Math.floor(Math.random() * invisibles.length)];
        }
    }
    return result;
}

// ============================================================
// MEJORA 1: Variacion de mensajes
// Reemplaza palabras por sus sinonimos de forma aleatoria
// para que cada mensaje sea diferente y evitar deteccion
// ============================================================
function variarMensaje(mensaje, userId) {
    const sinonimos = db.getSinonimos(userId);
    if (!sinonimos.length) return mensaje;

    let resultado = mensaje;
    for (const s of sinonimos) {
        const alternativas = s.alternativas.split(",").map(a => a.trim()).filter(a => a);
        if (!alternativas.length) continue;
        // Incluir la palabra original como opcion
        const opciones = [s.palabra, ...alternativas];
        const regex = new RegExp(escapeRegex(s.palabra), "gi");
        resultado = resultado.replace(regex, () => {
            return opciones[Math.floor(Math.random() * opciones.length)];
        });
    }
    return resultado;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// sendToGroup con verificacion de entrega
// ============================================================
async function sendToGroup(sock, groupJid, mensaje, imagenPath) {
    const textoFinal = addInvisibleChars(mensaje);
    try {
        try {
            const metadata = await sock.groupMetadata(groupJid);
            if (metadata.announce) {
                const myJid = sock.user?.id;
                const myNum = myJid ? myJid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "") : "";
                const meParticipant = metadata.participants?.find(p => {
                    const pNum = p.id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
                    return pNum === myNum;
                });
                if (!meParticipant || (meParticipant.admin !== "admin" && meParticipant.admin !== "superadmin")) {
                    return { sent: false, delivered: false, reason: "readonly" };
                }
            }
        } catch (metaErr) {
            return { sent: false, delivered: false, reason: "not_member" };
        }

        let result;
        if (imagenPath && fs.existsSync(imagenPath)) {
            result = await sock.sendMessage(groupJid, {
                image: fs.readFileSync(imagenPath),
                caption: textoFinal,
            });
        } else {
            result = await sock.sendMessage(groupJid, { text: textoFinal });
        }

        // Verificar entrega (15s timeout)
        const msgId = result?.key?.id;
        if (!msgId) return { sent: true, delivered: false, reason: "no_id" };

        const deliveryResult = await new Promise((resolve) => {
            let done = false;
            const handler = (updates) => {
                for (const upd of updates) {
                    if (upd.key?.id === msgId) {
                        const status = upd.update?.status;
                        if (status >= 2) {
                            if (!done) { done = true; resolve({ delivered: true }); }
                        }
                        if (status === 0) {
                            if (!done) { done = true; resolve({ delivered: false, reason: "rejected" }); }
                        }
                    }
                }
            };
            sock.ev.on("messages.update", handler);
            setTimeout(() => {
                try { sock.ev.off("messages.update", handler); } catch (e) {}
                if (!done) { done = true; resolve({ delivered: false, reason: "pending" }); }
            }, 15000);
        });

        return { sent: true, ...deliveryResult };
    } catch (e) {
        console.error(`Error enviando a ${groupJid}: ${e.message}`);
        const msg = (e.message || "").toLowerCase();
        // MEJORA 8: Deteccion de ban
        if (msg.includes("stream:error") || msg.includes("conflict") || msg.includes("replaced")) {
            return { sent: false, delivered: false, reason: "ban_detected" };
        }
        if (msg.includes("forbidden") || msg.includes("not-authorized") ||
            msg.includes("item-not-found") || msg.includes("not allowed") ||
            msg.includes("403") || msg.includes("404") ||
            msg.includes("not a participant") || msg.includes("gone")) {
            return { sent: false, delivered: false, reason: "forbidden" };
        }
        if (msg.includes("connection closed") || msg.includes("timed out") || msg.includes("socket")) {
            return { sent: false, delivered: false, reason: "disconnected" };
        }
        return { sent: false, delivered: false, reason: "error" };
    }
}

async function resolveGroupJid(sock, link) {
    if (link.includes("chat.whatsapp.com/")) {
        const code = link.split("chat.whatsapp.com/").pop().split(/[?#]/)[0];
        try {
            const metadata = await sock.groupGetInviteInfo(code);
            return metadata.id;
        } catch (e) {
            return null;
        }
    }
    if (link.endsWith("@g.us")) return link;
    return null;
}

function esGrupoReal(groupId, groupMetadata) {
    if (!groupId.endsWith("@g.us")) return false;
    if (groupMetadata) {
        if (groupMetadata.isCommunityAnnounce) return false;
        if (groupMetadata.isCommunity && groupMetadata.linkedParent) return false;
        if (groupMetadata.announce === true) return false;
        if (groupMetadata.isNewsletter) return false;
    }
    return true;
}

// ============================================================
// MEJORA 3: Verificar si estamos dentro del horario programado
// ============================================================
function dentroDeHorario(campanaId) {
    const horario = db.getCampanaHorario(campanaId);
    const horaActual = parseInt(new Date().toLocaleString("en-US", { timeZone: config.TIMEZONE, hour: "numeric", hour12: false }));
    if (horario.hora_inicio <= horario.hora_fin) {
        return horaActual >= horario.hora_inicio && horaActual < horario.hora_fin;
    } else {
        // Horario nocturno (ej: 22 a 6)
        return horaActual >= horario.hora_inicio || horaActual < horario.hora_fin;
    }
}

// ============================================================
// CAMPANA ENGINE con las 10 mejoras
// ============================================================
function iniciarCampana(campanaId, userId, botSock) {
    if (tareasActivas[campanaId]) return false;

    let cancelled = false;
    const task = {
        running: true,
        cancel: () => { cancelled = true; },
    };
    tareasActivas[campanaId] = task;

    (async () => {
        try {
            const campana = db.getCampanaById(campanaId);
            if (!campana) return;
            db.setCampanaActiva(campanaId, true);

            const sesionesNombres = db.getSesionesCampana(campanaId);
            let gruposLinks = db.getGruposCampana(campanaId);
            const conf = db.getCampanaConfig(campanaId);
            const horario = db.getCampanaHorario(campanaId);

            // MEJORA 4: Cargar templates para rotacion
            const templates = db.getTemplates(userId);

            if (!sesionesNombres.length || !gruposLinks.length) {
                await botSock.sendMessage(userId, { text: "\u26A0 Campana sin cuentas o grupos asignados." });
                return;
            }

            // Conectar cuentas, filtrar baneadas
            const socks = [];
            for (const nombre of sesionesNombres) {
                // MEJORA 8: Verificar si la cuenta esta baneada
                const estado = db.getCuentaEstado(userId, nombre);
                if (estado && estado.baneada) {
                    console.log(`[Campana] Cuenta '${nombre}' baneada, saltando...`);
                    continue;
                }
                try {
                    const s = await getOrConnectClient(userId, nombre);
                    socks.push({ nombre, sock: s });
                } catch (e) {
                    console.error(`Error conectando ${nombre}: ${e.message}`);
                }
            }
            if (!socks.length) {
                await botSock.sendMessage(userId, { text: "\u274C No se pudo conectar ninguna cuenta." });
                return;
            }

            const numCuentas = socks.length;
            let ciclo = 0;
            const gruposEliminados = [];
            let delayMultiplier = 1.0;
            let consecutivePending = 0;
            const MAX_CONSECUTIVE_PENDING = 3;
            const PAUSA_RATE_LIMIT = 300;

            try {
                let tiempoMsg = "";
                if (numCuentas === 1) {
                    tiempoMsg = `\u23F1 Entre grupos: ${conf.intervalo_min}-${conf.intervalo_max}s\n\u23F0 Entre ciclos: 10 min (1 cuenta)`;
                } else {
                    tiempoMsg = `\u23F1 Entre grupos: ${conf.intervalo_min}-${conf.intervalo_max}s\n\u{1F504} Entre cuentas: 5-10 min\n\u23F0 Entre ciclos: ${conf.espera_ciclo || 600}s`;
                }
                let horarioMsg = "";
                if (horario.hora_inicio !== 0 || horario.hora_fin !== 24) {
                    horarioMsg = `\n\u{1F553} Horario: ${horario.hora_inicio}:00 - ${horario.hora_fin}:00`;
                }
                let templateMsg = templates.length ? `\n\u{1F4DD} ${templates.length} template(s) para rotacion` : "";

                await botSock.sendMessage(userId, {
                    text: `\u{1F680} Campana '${campana.nombre}' iniciada!\n\u{1F464} ${socks.length} cuenta(s)\n\u{1F310} ${gruposLinks.length} grupo(s)\n${tiempoMsg}${horarioMsg}${templateMsg}\n\n\u{1F4A1} Limite diario: ${LIMITE_ENVIOS_DIARIOS} envios/cuenta`,
                });
            } catch (e) {}

            while (!cancelled) {
                ciclo++;
                console.log(`[Campana ${campana.nombre}] Ciclo #${ciclo}`);

                // MEJORA 3: Verificar horario programado
                if (!dentroDeHorario(campanaId)) {
                    const hor = db.getCampanaHorario(campanaId);
                    console.log(`   [Horario] Fuera de horario (${hor.hora_inicio}:00-${hor.hora_fin}:00). Esperando...`);
                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u{1F553} *${campana.nombre}*: Fuera de horario (${hor.hora_inicio}:00-${hor.hora_fin}:00).\n\u23F3 Esperando hasta la proxima ventana...`,
                        });
                    } catch (e) {}
                    // Revisar cada 5 minutos
                    while (!dentroDeHorario(campanaId) && !cancelled) {
                        await delay(300 * 1000);
                    }
                    if (cancelled) break;
                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u2705 *${campana.nombre}*: Dentro de horario. Reanudando envios...`,
                        });
                    } catch (e) {}
                }

                gruposLinks = db.getGruposCampana(campanaId);
                if (!gruposLinks.length) {
                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u26A0 *${campana.nombre}*: No quedan grupos validos. Campana detenida.` +
                                (gruposEliminados.length ? `\n\u{1F5D1} Se eliminaron ${gruposEliminados.length} grupo(s).` : ""),
                        });
                    } catch (e) {}
                    break;
                }

                // MEJORA 5: Filtrar blacklist
                const blacklist = db.getBlacklist(userId);
                const blLinks = new Set(blacklist.map(b => b.grupo_link));
                gruposLinks = gruposLinks.filter(gl => !blLinks.has(gl));

                for (let si = 0; si < socks.length; si++) {
                    if (cancelled) break;
                    let currentSock = socks[si];

                    // MEJORA 9: Verificar limite diario
                    const enviosHoy = db.getEnviosDiarios(userId, currentSock.nombre);
                    if (enviosHoy >= LIMITE_ENVIOS_DIARIOS) {
                        console.log(`   [Limite] Cuenta '${currentSock.nombre}' alcanzo limite diario (${enviosHoy}/${LIMITE_ENVIOS_DIARIOS})`);
                        try {
                            await botSock.sendMessage(userId, {
                                text: `\u26A0 *${currentSock.nombre}*: Limite diario alcanzado (${enviosHoy}/${LIMITE_ENVIOS_DIARIOS}). Saltando cuenta.`,
                            });
                        } catch (e) {}
                        continue;
                    }

                    const gruposActuales = [...gruposLinks];

                    for (const grupoLink of gruposActuales) {
                        if (cancelled) break;

                        // Verificar limite diario en cada iteracion
                        const enviosActuales = db.getEnviosDiarios(userId, currentSock.nombre);
                        if (enviosActuales >= LIMITE_ENVIOS_DIARIOS) {
                            console.log(`   [Limite] Cuenta '${currentSock.nombre}' alcanzo limite durante envio.`);
                            break;
                        }

                        const groupJid = await resolveGroupJid(currentSock.sock, grupoLink);
                        if (!groupJid) {
                            db.eliminarGrupoPorLink(userId, grupoLink);
                            db.eliminarGrupoCampana(campanaId, grupoLink);
                            db.actualizarStatsCampana(campanaId, 0, 1);
                            db.registrarEnvio(userId, campanaId, grupoLink, "error_jid_eliminado");
                            gruposEliminados.push(grupoLink);
                            const idx = gruposLinks.indexOf(grupoLink);
                            if (idx !== -1) gruposLinks.splice(idx, 1);
                            continue;
                        }

                        // MEJORA 1 + 4: Variar mensaje o usar template rotativo
                        let mensajeAEnviar = campana.mensaje;
                        let imagenAEnviar = campana.imagen_path;

                        if (templates.length > 0) {
                            // Rotar templates aleatoriamente
                            const tmpl = templates[Math.floor(Math.random() * templates.length)];
                            mensajeAEnviar = tmpl.mensaje;
                            if (tmpl.imagen_path) imagenAEnviar = tmpl.imagen_path;
                        }

                        // Aplicar variacion de sinonimos
                        mensajeAEnviar = variarMensaje(mensajeAEnviar, userId);

                        const result = await sendToGroup(currentSock.sock, groupJid, mensajeAEnviar, imagenAEnviar);

                        if (result.sent && result.delivered) {
                            db.actualizarStatsCampana(campanaId, 1, 0);
                            db.registrarEnvio(userId, campanaId, grupoLink, "enviado");
                            db.actualizarGrupoStats(userId, grupoLink, "enviado");
                            db.incrementarEnvioDiario(userId, currentSock.nombre);
                            consecutivePending = 0;
                            if (delayMultiplier > 1.0) {
                                delayMultiplier = Math.max(1.0, delayMultiplier - 0.2);
                            }
                        } else if (result.sent && result.reason === "pending") {
                            db.actualizarStatsCampana(campanaId, 0, 1);
                            db.registrarEnvio(userId, campanaId, grupoLink, "pending_no_entregado");
                            db.actualizarGrupoStats(userId, grupoLink, "pending");
                            consecutivePending++;
                            delayMultiplier = Math.min(3.0, delayMultiplier + 0.5);

                            if (consecutivePending >= MAX_CONSECUTIVE_PENDING) {
                                console.log(`   \u{1F6D1} ${consecutivePending} pending seguidos. Pausando ${PAUSA_RATE_LIMIT}s...`);
                                try {
                                    await botSock.sendMessage(userId, {
                                        text: `\u26A0 *${campana.nombre}*: ${consecutivePending} mensajes pendientes seguidos con '${currentSock.nombre}'.\n\u23F3 Pausando ${Math.round(PAUSA_RATE_LIMIT/60)} min...`,
                                    });
                                } catch (e) {}
                                await delay(PAUSA_RATE_LIMIT * 1000);
                                consecutivePending = 0;
                                delayMultiplier = 2.0;
                            }
                        } else if (!result.sent) {
                            // MEJORA 8: Deteccion de ban
                            if (result.reason === "ban_detected") {
                                console.log(`   \u{1F6A8} BAN DETECTADO en cuenta '${currentSock.nombre}'`);
                                db.marcarCuentaBaneada(userId, currentSock.nombre);
                                try {
                                    await botSock.sendMessage(userId, {
                                        text: `\u{1F6A8} *BAN DETECTADO*\n\nLa cuenta *${currentSock.nombre}* ha sido baneada/desconectada por WhatsApp.\n\nSe ha marcado como baneada y no se usara mas.\n\nSigue con las demas cuentas si hay.`,
                                    });
                                } catch (e) {}
                                break; // Salir del loop de grupos para esta cuenta
                            }

                            // MEJORA 6: Auto-reconexion si se desconecto
                            if (result.reason === "disconnected") {
                                console.log(`   [Reconexion] Intentando reconectar '${currentSock.nombre}'...`);
                                try {
                                    await botSock.sendMessage(userId, {
                                        text: `\u{1F504} Cuenta '${currentSock.nombre}' desconectada. Intentando reconectar...`,
                                    });
                                } catch (e) {}
                                const newSock = await reconectarCuenta(userId, currentSock.nombre);
                                if (newSock) {
                                    currentSock.sock = newSock;
                                    socks[si].sock = newSock;
                                    try {
                                        await botSock.sendMessage(userId, {
                                            text: `\u2705 Cuenta '${currentSock.nombre}' reconectada. Continuando...`,
                                        });
                                    } catch (e) {}
                                    continue; // Reintentar este grupo
                                } else {
                                    try {
                                        await botSock.sendMessage(userId, {
                                            text: `\u274C No se pudo reconectar '${currentSock.nombre}'. Saltando cuenta.`,
                                        });
                                    } catch (e) {}
                                    break;
                                }
                            }

                            // Eliminar grupo si es error permanente
                            if (result.reason === "readonly" || result.reason === "not_member" || result.reason === "forbidden") {
                                db.eliminarGrupoPorLink(userId, grupoLink);
                                db.eliminarGrupoCampana(campanaId, grupoLink);
                                db.registrarEnvio(userId, campanaId, grupoLink, `eliminado_${result.reason}`);
                                db.actualizarGrupoStats(userId, grupoLink, "fallido");
                                gruposEliminados.push(grupoLink);
                                const idx = gruposLinks.indexOf(grupoLink);
                                if (idx !== -1) gruposLinks.splice(idx, 1);
                            }
                            db.actualizarStatsCampana(campanaId, 0, 1);
                        } else {
                            db.actualizarStatsCampana(campanaId, 0, 1);
                            db.registrarEnvio(userId, campanaId, grupoLink, result.reason || "error");
                            db.actualizarGrupoStats(userId, grupoLink, "fallido");
                        }

                        // Espera entre grupos (adaptativa)
                        const baseWait = randomDelay(conf.intervalo_min, conf.intervalo_max);
                        const actualWait = Math.round(baseWait * delayMultiplier);
                        await delay(actualWait * 1000);
                    }

                    // Espera entre cuentas (2+)
                    if (numCuentas >= 2 && si < socks.length - 1 && !cancelled) {
                        const waitCuenta = randomDelay(300, 600) * 1000;
                        console.log(`   Esperando ${Math.round(waitCuenta/1000)}s antes de siguiente cuenta...`);
                        await delay(waitCuenta);
                    }
                }

                // Reporte de ciclo
                if (!cancelled) {
                    const c = db.getCampanaById(campanaId);
                    gruposLinks = db.getGruposCampana(campanaId);

                    let reporteExtra = "";
                    if (gruposEliminados.length) {
                        reporteExtra += `\n\u{1F5D1} ${gruposEliminados.length} grupo(s) eliminados`;
                        gruposEliminados.length = 0;
                    }
                    if (delayMultiplier > 1.0) {
                        reporteExtra += `\n\u26A0 Delay x${delayMultiplier.toFixed(1)}`;
                    }

                    // Envios diarios por cuenta
                    const enviosDia = db.getEnviosDiariosTotal(userId);
                    let enviosDiaMsg = "";
                    if (enviosDia.length) {
                        enviosDiaMsg = "\n\u{1F4CA} Envios hoy: " + enviosDia.map(e => `${e.cuenta_nombre}=${e.total}`).join(", ");
                    }

                    let esperaMsg = numCuentas === 1
                        ? `\u23F0 Esperando 10 min...`
                        : `\u23F0 Esperando ${conf.espera_ciclo || 600}s...`;

                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u{1F4CA} *${campana.nombre}* ciclo #${ciclo}\n\u2705 ${c.enviados} env | \u274C ${c.errores} err\n\u{1F310} ${gruposLinks.length} grupo(s)\n${esperaMsg}${reporteExtra}${enviosDiaMsg}`,
                        });
                    } catch (e) {}

                    if (numCuentas === 1) {
                        await delay(600 * 1000);
                    } else {
                        await delay((conf.espera_ciclo || 600) * 1000);
                    }
                    delayMultiplier = Math.max(1.0, delayMultiplier - 0.5);
                }
            }
        } catch (e) {
            console.error(`Error campana ${campanaId}: ${e.message}`);
        } finally {
            db.setCampanaActiva(campanaId, false);
            delete tareasActivas[campanaId];
        }
    })();

    return true;
}

function detenerCampana(campanaId) {
    const task = tareasActivas[campanaId];
    if (task) {
        task.cancel();
        task.running = false;
        delete tareasActivas[campanaId];
        db.setCampanaActiva(campanaId, false);
        return true;
    }
    // Aunque no haya tarea activa, asegurar que la DB este limpia
    db.setCampanaActiva(campanaId, false);
    return false;
}

// ============================================================
// MEJORA 10: Reporte diario automatico
// Envia resumen cada 24h al usuario
// ============================================================
function iniciarReporteDiario(userId, botSock) {
    if (reporteInterval[userId]) return;
    // Enviar reporte cada 24 horas (86400000 ms)
    reporteInterval[userId] = setInterval(async () => {
        try {
            const reporte = db.getReporteDiario(userId);
            const baneadas = db.getCuentasBaneadas(userId);
            let texto = `\u{1F4CA} *REPORTE DIARIO*\n\n`;
            texto += `\u{1F4E8} Total envios: ${reporte.totalEnvios}\n`;
            texto += `\u2705 Exitosos: ${reporte.exitosos}\n`;
            texto += `\u274C Fallidos: ${reporte.fallidos}\n`;
            texto += `\u{1F4AC} Respuestas: ${reporte.respuestas}\n`;
            if (reporte.porCuenta.length) {
                texto += `\n\u{1F464} *Por cuenta:*\n`;
                for (const c of reporte.porCuenta) {
                    texto += `  ${c.cuenta_nombre}: ${c.total} envios\n`;
                }
            }
            if (baneadas.length) {
                texto += `\n\u{1F6A8} *Cuentas baneadas:* ${baneadas.map(b => b.cuenta_nombre).join(", ")}`;
            }
            await botSock.sendMessage(userId, { text: texto });
        } catch (e) {
            console.error(`Error reporte diario: ${e.message}`);
        }
    }, 86400000);
}

function detenerReporteDiario(userId) {
    if (reporteInterval[userId]) {
        clearInterval(reporteInterval[userId]);
        delete reporteInterval[userId];
    }
}

// --- RESPONDER ENGINE ---
function iniciarResponder(userId, contacto, palabras, botSock) {
    if (responderActivos[userId]) return false;

    let cancelled = false;
    const task = {
        running: true,
        cancel: () => { cancelled = true; },
    };
    responderActivos[userId] = task;

    (async () => {
        try {
            const sesiones = db.getSesiones(userId);
            if (!sesiones.length) return;

            const socks = [];
            for (const s of sesiones) {
                try {
                    const sock = await getOrConnectClient(userId, s.nombre);
                    socks.push({ nombre: s.nombre, sock });
                } catch (e) {
                    console.error(`Responder: error conectando ${s.nombre}: ${e.message}`);
                }
            }
            if (!socks.length) return;

            const keywordsLower = palabras.map(p => p.toLowerCase().trim());

            for (const { nombre, sock } of socks) {
                sock.ev.on("messages.upsert", async ({ messages }) => {
                    if (cancelled) return;
                    for (const msg of messages) {
                        if (!msg.message || msg.key.fromMe) continue;
                        const jid = msg.key.remoteJid;
                        if (!jid || !jid.endsWith("@g.us")) continue;

                        const text = msg.message.conversation
                            || msg.message.extendedTextMessage?.text
                            || "";
                        const lower = text.toLowerCase();

                        // Primero verificar auto-respuestas inteligentes
                        const autoResp = db.buscarAutoRespuesta(userId, text);
                        if (autoResp) {
                            try {
                                await sock.sendMessage(jid, { text: autoResp.respuesta }, { quoted: msg });
                                db.registrarRespuesta(userId, jid, autoResp.palabra_clave);
                            } catch (e) {
                                console.error(`Auto-respuesta error: ${e.message}`);
                            }
                            continue;
                        }
                        // Luego verificar keywords clasicas
                        for (const kw of keywordsLower) {
                            if (lower.includes(kw)) {
                                try {
                                    await sock.sendMessage(jid, {
                                        text: `Hola! Te recomiendo contactar a ${contacto} \u{1F4F1}`,
                                    }, { quoted: msg });
                                    db.registrarRespuesta(userId, jid, kw);
                                } catch (e) {
                                    console.error(`Responder error: ${e.message}`);
                                }
                                break;
                            }
                        }
                    }
                });
            }

            while (!cancelled) {
                await delay(5000);
            }
        } catch (e) {
            console.error(`Responder error ${userId}: ${e.message}`);
        } finally {
            delete responderActivos[userId];
        }
    })();

    return true;
}

function detenerResponder(userId) {
    const task = responderActivos[userId];
    if (task) {
        task.cancel();
        delete responderActivos[userId];
        return true;
    }
    return false;
}

function getCampanasActivas() {
    return Object.keys(tareasActivas).map(id => parseInt(id));
}

// ============================================================
// ROTACION DE CUENTAS — obtener cuentas disponibles en rotacion
// ============================================================
const _rotacionIndex = {};

async function obtenerSockRotado(userId) {
    const sesiones = db.getSesiones(userId);
    if (!sesiones.length) return null;

    if (!_rotacionIndex[userId]) _rotacionIndex[userId] = 0;
    const idx = _rotacionIndex[userId] % sesiones.length;
    _rotacionIndex[userId]++;

    try {
        const sock = await getOrConnectClient(userId, sesiones[idx].nombre);
        return sock;
    } catch (e) {
        // Si falla, intentar con las demas
        for (let i = 0; i < sesiones.length; i++) {
            if (i === idx) continue;
            try {
                return await getOrConnectClient(userId, sesiones[i].nombre);
            } catch (e2) {}
        }
        return null;
    }
}

// ============================================================
// ENVIO PERSONAL — Enviar a chats personales con delay configurable
// ============================================================
const envioPersonalActivo = {};

// Helper: verificar si estamos en horario permitido (usuario)
function dentroDeHorarioUsuario(userId) {
    const horario = db.getHorarioEnvio(userId);
    if (horario.hora_inicio === 0 && horario.hora_fin === 24) return true;
    const ahora = new Date();
    const horaActual = parseInt(ahora.toLocaleString("en-US", { timeZone: config.TIMEZONE, hour: "numeric", hour12: false }));
    if (horario.hora_inicio < horario.hora_fin) {
        return horaActual >= horario.hora_inicio && horaActual < horario.hora_fin;
    }
    return horaActual >= horario.hora_inicio || horaActual < horario.hora_fin;
}

// Helper: esperar hasta que estemos en horario (con soporte de cancelación)
async function esperarHorario(userId, isCancelled) {
    while (!dentroDeHorarioUsuario(userId)) {
        if (isCancelled && isCancelled()) return;
        await delay(60000); // Revisar cada minuto
    }
}

// Helper: reemplazar variables en mensaje
function reemplazarVariables(texto, contacto) {
    let result = texto;
    if (contacto.nombre) result = result.replace(/\{nombre\}/gi, contacto.nombre);
    if (contacto.numero) result = result.replace(/\{numero\}/gi, contacto.numero);
    if (contacto.jid) {
        const num = contacto.jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
        result = result.replace(/\{numero\}/gi, num);
        if (!contacto.nombre) result = result.replace(/\{nombre\}/gi, num);
    }
    return result;
}

// Helper: delay inteligente con lotes (con soporte de cancelación via callback)
async function delayConLotes(userId, enviados, isCancelled) {
    if (isCancelled && isCancelled()) return;
    const cfg = db.getEnvioConfig(userId);
    const delayMs = (cfg.delay_seg || 10) * 1000;
    let totalMs;
    if (cfg.lote_tamano > 0 && enviados > 0 && enviados % cfg.lote_tamano === 0) {
        totalMs = (cfg.lote_pausa_seg || 300) * 1000;
    } else {
        totalMs = delayMs;
    }
    // Break long delays into 1-second chunks for responsive cancellation
    const chunks = Math.ceil(totalMs / 1000);
    for (let i = 0; i < chunks; i++) {
        if (isCancelled && isCancelled()) return;
        await delay(Math.min(1000, totalMs - i * 1000));
    }
}

async function listarChatsPersonales(sock, userId) {
    const chats = [];
    // 1. Buscar chats capturados en clientChats (de eventos messaging-history, chats.upsert, messages.upsert)
    for (const key of Object.keys(clientChats)) {
        if (!userId || key.startsWith(userId + "_")) {
            const stored = clientChats[key];
            for (const jid of Object.keys(stored)) {
                const c = stored[jid];
                const num = jid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "");
                chats.push({
                    jid: jid,
                    nombre: c.name || num,
                    numero: num,
                });
            }
        }
    }
    // 2. Si no hay chats en memoria, esperar un momento por si los eventos aun no han llegado
    if (!chats.length && sock && sock.user) {
        await delay(3000);
        for (const key of Object.keys(clientChats)) {
            if (!userId || key.startsWith(userId + "_")) {
                const stored = clientChats[key];
                for (const jid of Object.keys(stored)) {
                    const c = stored[jid];
                    const num = jid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "");
                    chats.push({ jid, nombre: c.name || num, numero: num });
                }
            }
        }
    }
    // 3. Intentar fetchAllContacts, fetchStatus o store.contacts
    if (!chats.length && sock) {
        try {
            const contacts = await sock.fetchAllContacts?.() || [];
            for (const c of contacts) {
                if (c.id && c.id.endsWith("@s.whatsapp.net") && c.id !== "status@broadcast") {
                    const num = c.id.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "");
                    chats.push({ jid: c.id, nombre: c.name || c.notify || num, numero: num });
                }
            }
        } catch (e) {}
    }
    // 4. Intentar obtener de sock.store.contacts si existe
    if (!chats.length && sock && sock.store && sock.store.contacts) {
        try {
            const storeContacts = sock.store.contacts;
            for (const jid of Object.keys(storeContacts)) {
                if (jid.endsWith("@s.whatsapp.net") && jid !== "status@broadcast") {
                    const c = storeContacts[jid];
                    const num = jid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "");
                    chats.push({ jid, nombre: c.name || c.notify || num, numero: num });
                }
            }
        } catch (e) {}
    }
    // 5. Fallback a chats guardados en la base de datos
    if (!chats.length && userId) {
        try {
            const dbChats = db.getChatsPersonales(userId, "");
            for (const c of dbChats) {
                const num = c.jid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "");
                chats.push({ jid: c.jid, nombre: c.nombre || num, numero: num });
            }
        } catch (e) {}
    }
    // Eliminar duplicados por jid
    const seen = new Set();
    return chats.filter(c => {
        if (seen.has(c.jid)) return false;
        seen.add(c.jid);
        return true;
    });
}

async function enviarAPersonales(userId, mensaje, imagenPath, botSock) {
    if (envioPersonalActivo[userId]) return "activo";
    let cancelled = false;
    const task = { running: true, cancel: () => { cancelled = true; } };
    envioPersonalActivo[userId] = task;

    try {
        const chats = await listarChatsPersonales(botSock, userId);
        if (!chats.length) {
            delete envioPersonalActivo[userId];
            try { await botSock.sendMessage(userId, { text: "\u274C No se encontraron chats personales. La cuenta necesita tiempo para sincronizar el historial de chats." }); } catch (e) {}
            return false;
        }

        // Filtrar lista negra
        const chatsFiltrados = chats.filter(c => {
            const num = c.jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
            return !db.estaEnListaNegra(userId, num);
        });

        const cfg = db.getEnvioConfig(userId);
        const total = chatsFiltrados.length;
        let enviados = 0, errores = 0, saltados = chats.length - total;

        try {
            let infoLotes = cfg.lote_tamano > 0 ? `\nLotes: ${cfg.lote_tamano} envios, pausa ${cfg.lote_pausa_seg}s` : "";
            await botSock.sendMessage(userId, {
                text: `\u{1F4E8} Iniciando envio personal a ${total} chat(s)...\nDelay: ${cfg.delay_seg}s entre cada envio.${infoLotes}${saltados > 0 ? `\n\u{1F6AB} ${saltados} en lista negra (saltados)` : ""}\nEscribe "cancelar envio" para detener.`
            });
        } catch (e) {}

        for (const chat of chatsFiltrados) {
            if (cancelled) break;
            // Verificar horario
            await esperarHorario(userId, () => cancelled);
            if (cancelled) break;
            try {
                let textoFinal = reemplazarVariables(mensaje, chat);
                textoFinal = addInvisibleChars(variarMensaje(textoFinal, userId));
                const payload = buildMediaPayload(imagenPath, textoFinal) || { text: textoFinal };
                await sendAndTrack(botSock, chat.jid, payload, userId);
                enviados++;
                db.registrarEnvio(userId, 0, chat.jid, "enviado_personal");
            } catch (e) {
                errores++;
                db.registrarEnvio(userId, 0, chat.jid, "error_personal");
            }
            if (enviados % 10 === 0 && enviados > 0) {
                try { await botSock.sendMessage(userId, { text: `\u{1F4CA} Progreso: ${enviados}/${total}...` }); } catch (e) {}
            }
            if (!cancelled) {
                await delayConLotes(userId, enviados, () => cancelled);
            }
        }

        delete envioPersonalActivo[userId];
        const resumen = cancelled
            ? `\u{1F6D1} Envio personal cancelado.\n\n\u2705 Enviados: ${enviados}/${total}\n\u274C Errores: ${errores}`
            : `\u2705 *Envio personal completado*\n\n\u{1F4E8} Enviados: ${enviados}/${total}\n\u274C Errores: ${errores}`;
        try { await botSock.sendMessage(userId, { text: resumen }); } catch (e) {}
        return true;
    } catch (e) {
        delete envioPersonalActivo[userId];
        console.error(`Error en envio personal: ${e.message}`);
        return false;
    }
}

async function enviarASeleccionados(userId, jids, mensaje, imagenPath, botSock) {
    if (envioPersonalActivo[userId]) return false;
    let cancelled = false;
    const task = { running: true, cancel: () => { cancelled = true; } };
    envioPersonalActivo[userId] = task;

    try {
        // Filtrar lista negra
        const jidsFiltrados = jids.filter(jid => {
            const num = jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
            return !db.estaEnListaNegra(userId, num);
        });
        const cfg = db.getEnvioConfig(userId);
        const total = jidsFiltrados.length;
        let enviados = 0, errores = 0;

        try {
            let infoLotes = cfg.lote_tamano > 0 ? `\nLotes: ${cfg.lote_tamano} envios, pausa ${cfg.lote_pausa_seg}s` : "";
            await botSock.sendMessage(userId, {
                text: `\u{1F4E8} Enviando a ${total} contacto(s)...\nDelay: ${cfg.delay_seg}s${infoLotes}`
            });
        } catch (e) {}

        for (const jid of jidsFiltrados) {
            if (cancelled) break;
            await esperarHorario(userId, () => cancelled);
            if (cancelled) break;
            try {
                const contacto = { jid, numero: jid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "") };
                let textoFinal = reemplazarVariables(mensaje, contacto);
                textoFinal = addInvisibleChars(variarMensaje(textoFinal, userId));
                const payload = buildMediaPayload(imagenPath, textoFinal) || { text: textoFinal };
                await sendAndTrack(botSock, jid, payload, userId);
                enviados++;
                db.registrarEnvio(userId, 0, jid, "enviado_personal");
            } catch (e) {
                errores++;
                db.registrarEnvio(userId, 0, jid, "error_personal");
            }
            if (enviados % 10 === 0 && enviados > 0) {
                try { await botSock.sendMessage(userId, { text: `\u{1F4CA} Progreso: ${enviados}/${total}...` }); } catch (e) {}
            }
            if (!cancelled) {
                await delayConLotes(userId, enviados, () => cancelled);
            }
        }

        delete envioPersonalActivo[userId];
        const resumen = cancelled
            ? `\u{1F6D1} Envio cancelado.\n\n\u2705 Enviados: ${enviados}/${total}\n\u274C Errores: ${errores}`
            : `\u2705 *Envio completado*\n\n\u{1F4E8} Enviados: ${enviados}/${total}\n\u274C Errores: ${errores}`;
        try { await botSock.sendMessage(userId, { text: resumen }); } catch (e) {}
        return true;
    } catch (e) {
        delete envioPersonalActivo[userId];
        return false;
    }
}

function detenerEnvioPersonal(userId) {
    const task = envioPersonalActivo[userId];
    if (task) {
        task.cancel();
        delete envioPersonalActivo[userId];
        return true;
    }
    return false;
}

// ============================================================
// ENVIO A MIEMBROS DE GRUPO — Extraer miembros y enviar DM
// ============================================================
async function listarMiembrosGrupo(sock, groupJid) {
    const miembros = [];
    try {
        const metadata = await sock.groupMetadata(groupJid);
        console.log(`[miembros] Grupo ${groupJid}: ${metadata?.participants?.length || 0} participantes encontrados`);
        if (!metadata || !metadata.participants) return miembros;
        for (const p of metadata.participants) {
            if (!p.id || p.id === "status@broadcast") continue;
            // Aceptar @s.whatsapp.net y @lid (linked device IDs)
            if (p.id.endsWith("@s.whatsapp.net") || p.id.endsWith("@lid")) {
                const num = p.id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
                miembros.push({
                    jid: p.id,
                    numero: num,
                    admin: p.admin || null,
                });
            }
        }
    } catch (e) {
        console.error(`Error listando miembros del grupo ${groupJid}: ${e.message}`);
    }
    return miembros;
}

async function enviarAMiembrosGrupo(userId, groupJid, mensaje, imagenPath, sock) {
    if (envioPersonalActivo[userId]) return "activo";
    let cancelled = false;
    const task = { running: true, cancel: () => { cancelled = true; } };
    envioPersonalActivo[userId] = task;

    try {
        const miembros = await listarMiembrosGrupo(sock, groupJid);
        if (!miembros.length) {
            delete envioPersonalActivo[userId];
            try { await sock.sendMessage(userId, { text: "\u274C No se encontraron miembros en el grupo." }); } catch (e) {}
            return false;
        }

        // Filtrar lista negra y al propio usuario
        const myJid = sock.user?.id;
        const myNum = myJid ? myJid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "") : "";
        const miembrosFiltrados = miembros.filter(m => {
            const num = m.jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
            if (num === myNum) return false;
            return !db.estaEnListaNegra(userId, num);
        });

        const cfg = db.getEnvioConfig(userId);
        const total = miembrosFiltrados.length;
        let enviados = 0, errores = 0, saltados = miembros.length - total;

        try {
            let infoLotes = cfg.lote_tamano > 0 ? `\nLotes: ${cfg.lote_tamano} envios, pausa ${cfg.lote_pausa_seg}s` : "";
            await sock.sendMessage(userId, {
                text: `\u{1F4E8} Enviando DM a ${total} miembro(s) del grupo...\nDelay: ${cfg.delay_seg}s entre cada envio.${infoLotes}${saltados > 0 ? `\n\u{1F6AB} ${saltados} saltados (lista negra/propios)` : ""}\nEscribe "cancelar envio" para detener.`
            });
        } catch (e) {}

        for (const m of miembrosFiltrados) {
            if (cancelled) break;
            await esperarHorario(userId, () => cancelled);
            if (cancelled) break;
            try {
                let textoFinal = reemplazarVariables(mensaje, m);
                textoFinal = addInvisibleChars(variarMensaje(textoFinal, userId));
                const payload = buildMediaPayload(imagenPath, textoFinal) || { text: textoFinal };
                await sendAndTrack(sock, m.jid, payload, userId);
                enviados++;
                db.registrarEnvio(userId, 0, m.jid, "enviado_miembro");
            } catch (e) {
                errores++;
                db.registrarEnvio(userId, 0, m.jid, "error_miembro");
            }
            if (enviados % 10 === 0 && enviados > 0) {
                try { await sock.sendMessage(userId, { text: `\u{1F4CA} Progreso: ${enviados}/${total}...` }); } catch (e) {}
            }
            if (!cancelled) {
                await delayConLotes(userId, enviados, () => cancelled);
            }
        }

        delete envioPersonalActivo[userId];
        const resumen = cancelled
            ? `\u{1F6D1} Envio a miembros cancelado.\n\n\u2705 Enviados: ${enviados}/${total}\n\u274C Errores: ${errores}`
            : `\u2705 *Envio a miembros completado*\n\n\u{1F4E8} Enviados: ${enviados}/${total}\n\u274C Errores: ${errores}`;
        try { await sock.sendMessage(userId, { text: resumen }); } catch (e) {}
        return true;
    } catch (e) {
        delete envioPersonalActivo[userId];
        console.error(`Error en envio a miembros: ${e.message}`);
        return false;
    }
}

// ============================================================
// AGREGAR MIEMBROS DE UN GRUPO A OTRO GRUPO
// ============================================================
async function agregarMiembrosAGrupo(sock, grupoOrigen, grupoDestino, userId) {
    const resultado = { agregados: 0, errores: 0, detalles: [] };
    try {
        const miembros = await listarMiembrosGrupo(sock, grupoOrigen);
        if (!miembros.length) return { ok: false, error: "No se encontraron miembros en el grupo origen" };

        // Verificar que somos admin en el grupo destino
        const metaDest = await sock.groupMetadata(grupoDestino);
        const myJid = sock.user?.id;
        const myNum = myJid ? myJid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "") : "";
        const soyAdmin = metaDest?.participants?.some(p => {
            const pNum = p.id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
            return (pNum === myNum || p.id === myJid) && (p.admin === "admin" || p.admin === "superadmin");
        });
        if (!soyAdmin) return { ok: false, error: "No eres admin en el grupo destino" };

        // Obtener miembros actuales del destino para no duplicar
        const miembrosDestino = new Set(metaDest.participants.map(p =>
            p.id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "")
        ));

        // Filtrar miembros que no estan en destino y que tienen JID @s.whatsapp.net
        const porAgregar = miembros.filter(m => {
            if (!m.jid.endsWith("@s.whatsapp.net")) return false;
            const num = m.jid.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "");
            return !miembrosDestino.has(num);
        });

        if (!porAgregar.length) return { ok: true, agregados: 0, error: "Todos los miembros ya estan en el grupo destino" };

        // Agregar en lotes de 5 con delay
        const BATCH_SIZE = 5;
        const DELAY_MS = 3000;
        for (let i = 0; i < porAgregar.length; i += BATCH_SIZE) {
            const batch = porAgregar.slice(i, i + BATCH_SIZE).map(m => m.jid);
            try {
                const resp = await sock.groupParticipantsUpdate(grupoDestino, batch, "add");
                for (const r of (resp || [])) {
                    if (r.status === "200" || r.status === 200) {
                        resultado.agregados++;
                        resultado.detalles.push({ jid: r.jid, estado: "agregado" });
                    } else {
                        resultado.errores++;
                        resultado.detalles.push({ jid: r.jid, estado: `error_${r.status}` });
                    }
                }
            } catch (e) {
                resultado.errores += batch.length;
                console.error(`Error agregando batch a grupo: ${e.message}`);
            }
            if (i + BATCH_SIZE < porAgregar.length) {
                await delay(DELAY_MS);
            }
        }

        resultado.ok = true;
        resultado.total = porAgregar.length;
        return resultado;
    } catch (e) {
        console.error(`Error en agregarMiembrosAGrupo: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

function disconnectClient(userId, nombre) {
    const key = `${userId}_${nombre}`;
    if (clientSessions[key]) {
        try { clientSessions[key].end(); } catch (e) {}
        delete clientSessions[key];
    }
    if (clientChats[key]) delete clientChats[key];
    clearLink(userId, nombre);
    const sessionDir = getSessionDir(userId, nombre);
    const fs = require("fs");
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
}

module.exports = {
    tareasActivas,
    getCampanasActivas,
    responderActivos,
    clientSessions,
    pendingLinks,
    reporteInterval,
    LIMITE_ENVIOS_DIARIOS,
    getSessionDir,
    setBotSocket,
    BOT_NOMBRE: _botNombre,
    esGrupoReal,
    variarMensaje,
    connectClientAccount,
    getOrConnectClient,
    reconectarCuenta,
    disconnectClient,
    linkAccount,
    getLinkStatus,
    clearLink,
    iniciarCampana,
    detenerCampana,
    iniciarReporteDiario,
    detenerReporteDiario,
    iniciarResponder,
    detenerResponder,
    resolveGroupJid,
    sendToGroup,
    envioPersonalActivo,
    listarChatsPersonales,
    enviarAPersonales,
    enviarASeleccionados,
    detenerEnvioPersonal,
    listarMiembrosGrupo,
    enviarAMiembrosGrupo,
    agregarMiembrosAGrupo,
    obtenerSockRotado,
    buildMediaPayload,
};
