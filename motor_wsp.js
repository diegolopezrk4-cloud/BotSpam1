const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const db = require("./db_wsp");
const config = require("./config_wsp");

const tareasActivas = {};    // { campanaId: { running, cancel } }
const responderActivos = {}; // { userId: { running, cancel } }
const clientSessions = {};   // { "userId_nombre": socket }
const pendingLinks = {};     // { "userId_nombre": { qr, status, error } }
const reporteInterval = {};  // { userId: intervalId }

// Track last activity per group: { grupoJid: timestamp }
// Updated by message listeners — used to detect if someone else posted after our spam
const grupoUltimaActividad = {};

// Track campaign rest state for countdown: { campanaId: { inicio: timestamp_ms, duracion_seg: number } }
const campanaReposo = {};

// Limite de envios diarios por cuenta (sin limite)
const LIMITE_ENVIOS_DIARIOS = 999999;

// Whole-word matching to avoid partial matches (e.g. 'no' in 'noches')
function matchWholeWord(text, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|\\s|[^a-zA-Z\\u00C0-\\u024F])' + escaped + '(?:$|\\s|[^a-zA-Z\\u00C0-\\u024F])', 'i').test(text) || text === word;
}

let _botSock = null;
let _botNombre = "Bot_Principal";

function setBotSocket(sock) {
    _botSock = sock;
}

function getSessionDir(userId, nombre) {
    const safe = `${userId.replace(/[^a-zA-Z0-9]/g, "_")}_${nombre}`;
    return path.join(config.SESSIONS_DIR, safe);
}

// Lock to prevent simultaneous reconnection attempts per account
const reconnectLocks = {};

async function connectClientAccount(userId, nombre, telefono) {
    const sessionDir = getSessionDir(userId, nombre);
    const key = `${userId}_${nombre}`;
    fs.mkdirSync(sessionDir, { recursive: true });

    async function createSocket() {
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
            keepAliveIntervalMs: 10000,
            retryRequestDelayMs: 2000,
        });
        sock.ev.on("creds.update", saveCreds);
        // Track group activity from other users for anti-duplicate spam
        sock.ev.on("messages.upsert", ({ messages }) => {
            for (const msg of messages) {
                const jid = msg.key?.remoteJid;
                if (jid && jid.endsWith("@g.us") && !msg.key.fromMe && msg.message) {
                    registrarActividadGrupo(jid);
                }
            }
        });
        return sock;
    }

    const sock = await createSocket();

    return new Promise((resolve, reject) => {
        let resolved = false;
        let reconnectAttempts = 0;
        const MAX_RECONNECT = 5;

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open") {
                reconnectAttempts = 0;
                clientSessions[key] = sock;
                if (!resolved) {
                    resolved = true;
                    resolve(sock);
                }
            }
            if (connection === "close") {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (clientSessions[key] === sock) {
                    delete clientSessions[key];
                }
                if (code === 401 || code === DisconnectReason.loggedOut) {
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
                    if (!resolved) {
                        resolved = true;
                        reject(new Error("Sesion WSP expirada o cerrada. Re-vincula tu cuenta desde Cuentas WSP."));
                    }
                } else if (resolved && reconnectAttempts < MAX_RECONNECT) {
                    // Auto-reconnect after initial connection was established
                    reconnectAttempts++;
                    console.log(`[WSP] Cuenta ${nombre} desconectada (code ${code}). Reconectando intento ${reconnectAttempts}/${MAX_RECONNECT}...`);
                    await delay(3000 * reconnectAttempts);
                    try {
                        const newSock = await connectClientAccount(userId, nombre, telefono);
                        clientSessions[key] = newSock;
                    } catch (e) {
                        console.log(`[WSP] Reconexion fallida para ${nombre}: ${e.message}`);
                    }
                } else if (!resolved) {
                    resolved = true;
                    reject(new Error("Conexion cerrada" + (code ? ` (code ${code})` : "") + ". Intenta de nuevo."));
                }
            }
        });
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { sock.end(); } catch (e) {}
                reject(new Error("Timeout conectando cuenta (60s)"));
            }
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
                        try { sock.end(); } catch (e) {}
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
            const sock = clientSessions[key];
            if (sock.user && sock.ws && sock.ws.readyState === sock.ws.OPEN) {
                return sock;
            }
            // Connection is stale, clean up and reconnect
            try { sock.end(); } catch (e) {}
            delete clientSessions[key];
        } catch (e) {
            delete clientSessions[key];
        }
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

// Track group activity from other users (called from index_wsp.js message listener)
function registrarActividadGrupo(grupoJid) {
    grupoUltimaActividad[grupoJid] = Date.now();
}

// Record when campaign sends to a group (persists to DB)
function registrarEnvioCampana(campanaId, grupoJid) {
    db.registrarEnvioCampanaDB(campanaId, grupoJid);
}

// Check if group had activity from others since our last campaign send
function grupoTieneActividadNueva(campanaId, grupoJid) {
    const row = db.getUltimoEnvioCampana(campanaId, grupoJid);
    if (!row) return true; // never sent = treat as new
    const envioTime = new Date(row.ultimo_envio + "Z").getTime();
    const ultimaActividad = grupoUltimaActividad[grupoJid];
    // If we sent recently (last 30 min) from THIS campaign, skip even without activity data
    const minutesSinceSend = (Date.now() - envioTime) / 60000;
    if (minutesSinceSend < 30) return false;
    if (ultimaActividad === undefined) return true; // no data (e.g. after restart) — allow send
    return ultimaActividad > envioTime;
}

// ============================================================
// sendToGroup con verificacion de entrega
// ============================================================
async function sendToGroup(sock, groupJid, mensaje, imagenPath) {
    const textoFinal = addInvisibleChars(mensaje);
    try {
        let metadata = null;
        for (let metaRetry = 0; metaRetry < 2; metaRetry++) {
            try {
                metadata = await sock.groupMetadata(groupJid);
                break;
            } catch (metaErr) {
                const errMsg = (metaErr.message || "").toLowerCase();
                if (errMsg.includes("not-authorized") || errMsg.includes("forbidden") || errMsg.includes("item-not-found") || errMsg.includes("404")) {
                    return { sent: false, delivered: false, reason: "not_member" };
                }
                // Connection-level errors: return disconnected immediately (no retry)
                if (errMsg.includes("connection closed") || errMsg.includes("timed out") ||
                    errMsg.includes("not connected") || errMsg.includes("socket") ||
                    errMsg.includes("disconnected") || errMsg.includes("stream:error") ||
                    errMsg.includes("connection lost") || errMsg.includes("econnreset") ||
                    errMsg.includes("econnrefused") || errMsg.includes("epipe") ||
                    errMsg.includes("websocket") || errMsg.includes("close") ||
                    errMsg.includes("gone") || errMsg.includes("conflict")) {
                    return { sent: false, delivered: false, reason: "disconnected" };
                }
                if (metaRetry === 0) {
                    await delay(2000);
                    continue;
                }
                return { sent: false, delivered: false, reason: "metadata_error" };
            }
        }
        if (metadata && metadata.announce) {
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
            const cleanup = () => { try { sock.ev.off("messages.update", handler); } catch (e) {} };
            const handler = (updates) => {
                for (const upd of updates) {
                    if (upd.key?.id === msgId) {
                        const status = upd.update?.status;
                        if (status >= 2) {
                            if (!done) { done = true; cleanup(); resolve({ delivered: true }); }
                        }
                        if (status === 0) {
                            if (!done) { done = true; cleanup(); resolve({ delivered: false, reason: "rejected" }); }
                        }
                    }
                }
            };
            sock.ev.on("messages.update", handler);
            setTimeout(() => {
                if (!done) { done = true; resolve({ delivered: false, reason: "pending" }); }
                try { sock.ev.off("messages.update", handler); } catch (e) {}
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
        // Nota: NO filtrar announce (solo-admin) aqui — sendToGroup ya verifica si somos admin
        // Filtrar newsletters/canales
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

            if (!sesionesNombres.length || !gruposLinks.length) {
                try { if (botSock) await botSock.sendMessage(userId, { text: "\u26A0 Campana sin cuentas o grupos asignados." }); } catch (e) {}
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
                try { if (botSock) await botSock.sendMessage(userId, { text: "\u274C No se pudo conectar ninguna cuenta." }); } catch (e) {}
                return;
            }

            const numCuentas = socks.length;
            let ciclo = 0;
            const gruposEliminados = [];
            let delayMultiplier = 1.0;
            let consecutivePending = 0;
            const MAX_CONSECUTIVE_PENDING = 3;
            const PAUSA_RATE_LIMIT = 300;
            let reconnectFailures = 0;

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
                await botSock.sendMessage(userId, {
                    text: `\u{1F680} Campana '${campana.nombre}' iniciada!\n\u{1F464} ${socks.length} cuenta(s)\n\u{1F310} ${gruposLinks.length} grupo(s)\n${tiempoMsg}${horarioMsg}\n\n\u{1F4A1} Limite diario: ${LIMITE_ENVIOS_DIARIOS} envios/cuenta`,
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

                    let consecutiveErrors = 0;
                    const MAX_CONSECUTIVE_ERRORS = 5;

                    for (const grupoLink of gruposActuales) {
                        if (cancelled) break;

                        try {
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

                        // Skip group if no new activity since our last send (avoid duplicate spam)
                        if (!grupoTieneActividadNueva(campanaId, groupJid)) {
                            console.log(`   [Anti-dup] Grupo ${grupoLink}: sin actividad nueva, saltando`);
                            continue;
                        }

                        // Use campaign's own message (don't override with shared templates)
                        let mensajeAEnviar = campana.mensaje;
                        let imagenAEnviar = campana.imagen_path;

                        mensajeAEnviar = variarMensaje(mensajeAEnviar, userId);

                        const result = await sendToGroup(currentSock.sock, groupJid, mensajeAEnviar, imagenAEnviar);

                        if (result.sent && (result.delivered || result.reason === "pending" || result.reason === "no_id")) {
                            registrarEnvioCampana(campanaId, groupJid);
                            db.actualizarStatsCampana(campanaId, 1, 0);
                            db.registrarEnvio(userId, campanaId, grupoLink, result.delivered ? "enviado" : "enviado_pending");
                            db.actualizarGrupoStats(userId, grupoLink, "enviado");
                            db.incrementarEnvioDiario(userId, currentSock.nombre);
                            consecutiveErrors = 0;
                            reconnectFailures = 0;
                            if (result.delivered) {
                                consecutivePending = 0;
                                if (delayMultiplier > 1.0) {
                                    delayMultiplier = Math.max(1.0, delayMultiplier - 0.2);
                                }
                            } else {
                                consecutivePending++;
                                if (consecutivePending >= MAX_CONSECUTIVE_PENDING) {
                                    delayMultiplier = Math.min(2.0, delayMultiplier + 0.3);
                                    consecutivePending = 0;
                                }
                            }
                        } else if (!result.sent) {
                            if (result.reason === "ban_detected") {
                                console.log(`   \u{1F6A8} BAN DETECTADO en cuenta '${currentSock.nombre}'`);
                                db.marcarCuentaBaneada(userId, currentSock.nombre);
                                try {
                                    await botSock.sendMessage(userId, {
                                        text: `\u{1F6A8} *BAN DETECTADO*\n\nLa cuenta *${currentSock.nombre}* ha sido baneada/desconectada por WhatsApp.\n\nSe ha marcado como baneada y no se usara mas.\n\nSigue con las demas cuentas si hay.`,
                                    });
                                } catch (e) {}
                                break;
                            }

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
                                    consecutiveErrors = 0;
                                    continue;
                                } else {
                                    try {
                                        await botSock.sendMessage(userId, {
                                            text: `\u274C No se pudo reconectar '${currentSock.nombre}'. Saltando cuenta.`,
                                        });
                                    } catch (e) {}
                                    break;
                                }
                            }

                            if (result.reason === "readonly" || result.reason === "not_member" || result.reason === "forbidden") {
                                db.eliminarGrupoPorLink(userId, grupoLink);
                                db.eliminarGrupoCampana(campanaId, grupoLink);
                                db.registrarEnvio(userId, campanaId, grupoLink, `eliminado_${result.reason}`);
                                db.actualizarGrupoStats(userId, grupoLink, "fallido");
                                gruposEliminados.push(grupoLink);
                                const idx = gruposLinks.indexOf(grupoLink);
                                if (idx !== -1) gruposLinks.splice(idx, 1);
                            } else if (result.reason === "metadata_error") {
                                db.registrarEnvio(userId, campanaId, grupoLink, "error_temporal");
                                db.actualizarGrupoStats(userId, grupoLink, "fallido");
                                console.log(`[Campana] Grupo ${grupoLink}: error temporal de metadata, NO eliminado`);
                            }
                            db.actualizarStatsCampana(campanaId, 0, 1);
                            consecutiveErrors++;
                        } else {
                            db.actualizarStatsCampana(campanaId, 0, 1);
                            db.registrarEnvio(userId, campanaId, grupoLink, result.reason || "error");
                            db.actualizarGrupoStats(userId, grupoLink, "fallido");
                            consecutiveErrors++;
                        }

                        // Too many consecutive errors: pause and try to reconnect
                        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                            reconnectFailures++;
                            // Escalating pause: 60s first time, then 5min, then 10min
                            const pausaSeg = reconnectFailures <= 1 ? 60 : reconnectFailures <= 3 ? 300 : 600;
                            console.log(`   [ErrorRecovery] ${consecutiveErrors} errores consecutivos (intento #${reconnectFailures}), pausando ${pausaSeg}s...`);
                            try {
                                await botSock.sendMessage(userId, {
                                    text: `\u26A0 *${campana.nombre}*: ${consecutiveErrors} errores seguidos (intento #${reconnectFailures}).\n\u23F3 Pausando ${Math.round(pausaSeg/60)} min para recuperarse...`,
                                });
                            } catch (e) {}
                            // After too many reconnect failures, stop the campaign
                            if (reconnectFailures >= 5) {
                                console.log(`   [ErrorRecovery] Demasiados intentos fallidos, deteniendo campana`);
                                try {
                                    await botSock.sendMessage(userId, {
                                        text: `\u274C *${campana.nombre}*: Detenida automaticamente despues de ${reconnectFailures} intentos fallidos.\n\u{1F4A1} Revisa tu conexion y vuelve a iniciar manualmente.`,
                                    });
                                } catch (e) {}
                                cancelled = true;
                                break;
                            }
                            await delay(pausaSeg * 1000);
                            if (cancelled) break;
                            const newSock = await reconectarCuenta(userId, currentSock.nombre);
                            if (newSock) {
                                currentSock.sock = newSock;
                                socks[si].sock = newSock;
                            }
                            consecutiveErrors = 0;
                        }

                        // Espera entre grupos (adaptativa)
                        const baseWait = randomDelay(conf.intervalo_min, conf.intervalo_max);
                        const actualWait = Math.round(baseWait * delayMultiplier);
                        await delay(actualWait * 1000);

                        } catch (groupErr) {
                            console.error(`   [Campana] Error inesperado en grupo ${grupoLink}: ${groupErr.message}`);
                            db.actualizarStatsCampana(campanaId, 0, 1);
                            db.registrarEnvio(userId, campanaId, grupoLink, "error_inesperado");
                            consecutiveErrors++;
                            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                                console.log(`   [ErrorRecovery] Demasiados errores, pausando 60s...`);
                                await delay(60000);
                                consecutiveErrors = 0;
                            }
                            await delay(5000);
                        }
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

                    // Marcar en_reposo con timestamp para countdown en el panel
                    const esperaSeg = numCuentas === 1 ? 600 : (conf.espera_ciclo || 600);
                    campanaReposo[campanaId] = { inicio: Date.now(), duracion_seg: esperaSeg };
                    db.setCampanaEstadoDetalle(campanaId, 'en_reposo');

                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u{1F4CA} *${campana.nombre}* ciclo #${ciclo}\n\u2705 ${c ? c.enviados : '?'} env | \u274C ${c ? c.errores : '?'} err\n\u{1F310} ${gruposLinks.length} grupo(s)\n${esperaMsg}${reporteExtra}${enviosDiaMsg}`,
                        });
                    } catch (e) {}

                    await delay(esperaSeg * 1000);
                    delayMultiplier = Math.max(1.0, delayMultiplier - 0.5);
                    // Restaurar estado activa despues de la pausa (si no fue cancelada)
                    delete campanaReposo[campanaId];
                    if (!cancelled) db.setCampanaEstadoDetalle(campanaId, 'activa');
                }
            }
        } catch (e) {
            console.error(`Error campana ${campanaId}: ${e.message}`);
            // Auto-restart: la campana NO debe morir por errores inesperados
            if (!cancelled) {
                db.setCampanaEstadoDetalle(campanaId, 'reiniciando');
                try {
                    if (botSock && botSock.sendMessage) {
                        await botSock.sendMessage(userId.includes('@') ? userId : userId + '@s.whatsapp.net', {
                            text: `\u26A0\uFE0F Campana error inesperado. Reiniciando en 60s...\n\u{1F4CB} ${e.message}`
                        });
                    }
                } catch (notifErr) {}
                await delay(60000);
                if (!cancelled) {
                    delete tareasActivas[campanaId];
                    delete campanaReposo[campanaId];
                    iniciarCampana(campanaId, userId, botSock);
                    return;
                }
            }
        } finally {
            if (tareasActivas[campanaId]) {
                db.setCampanaActiva(campanaId, false, 'detenida');
                delete tareasActivas[campanaId];
                delete campanaReposo[campanaId];
            }
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
        delete campanaReposo[campanaId];
        db.setCampanaActiva(campanaId, false, 'detenida');
        return true;
    }
    // Aunque no haya tarea activa, asegurar que la DB este limpia
    delete campanaReposo[campanaId];
    db.setCampanaActiva(campanaId, false, 'detenida');
    return false;
}

function getCampanaReposo(campanaId) {
    return campanaReposo[campanaId] || null;
}

function isCampanaRunning(campanaId) {
    return !!tareasActivas[campanaId];
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
            const autoReglas = db.getAutoRespuestas(userId);
            const autoReglasMap = {};
            for (const r of autoReglas) {
                const kw = (r.palabra || "").toLowerCase().trim();
                if (kw) autoReglasMap[kw] = (r.respuesta || "").split("|").map(s => s.trim()).filter(s => s);
            }
            const autoRespCounters = {};

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
                        const pushName = msg.pushName || "";

                        // Check auto_respuestas rules first (varied responses)
                        let matched = false;
                        for (const [kw, respuestas] of Object.entries(autoReglasMap)) {
                            if (matchWholeWord(lower, kw) && respuestas.length > 0) {
                                if (!autoRespCounters[kw]) autoRespCounters[kw] = 0;
                                const idx = autoRespCounters[kw] % respuestas.length;
                                autoRespCounters[kw]++;
                                let respText = respuestas[idx]
                                    .replace(/\{usuario\}/gi, pushName || contacto)
                                    .replace(/\{contacto\}/gi, contacto);
                                try {
                                    await sock.sendMessage(jid, { text: respText }, { quoted: msg });
                                    db.registrarRespuesta(userId, jid, kw);
                                } catch (e) {
                                    console.error(`Responder error: ${e.message}`);
                                }
                                matched = true;
                                break;
                            }
                        }
                        if (matched) continue;

                        // Fallback to simple keyword match
                        for (const kw of keywordsLower) {
                            if (matchWholeWord(lower, kw)) {
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
// ENVIO PERSONAL: Leer chats personales y enviar con delay
// ============================================================
const envioPersonalActivo = {}; // { userId: { running, cancel } }

async function listarChatsPersonales(botSock) {
    const chats = [];
    try {
        const store = botSock.store || null;
        // Obtener todos los chats usando fetchAllContacts o store
        // Baileys no tiene un "getChats" directo, pero podemos listar contactos
        // y chats recientes usando las conversaciones
        const contacts = await botSock.fetchAllContacts?.() || [];
        const contactJids = new Set();
        for (const c of contacts) {
            if (c.id && c.id.endsWith("@s.whatsapp.net") && c.id !== "status@broadcast") {
                contactJids.add(c.id);
                const num = c.id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
                chats.push({
                    jid: c.id,
                    nombre: c.name || c.notify || num,
                    numero: num,
                });
            }
        }
    } catch (e) {
        console.error(`Error listando chats personales: ${e.message}`);
    }
    return chats;
}

async function enviarAPersonales(userId, mensaje, imagenPath, botSock, cuenta, batchSize, delayMinutes) {
    if (envioPersonalActivo[userId]) return false;
    if (!batchSize) {
        const envioConfig = db.getUserEnvioConfig(userId);
        batchSize = envioConfig.lote_tamano || 0;
        delayMinutes = batchSize ? Math.ceil((envioConfig.lote_pausa_seg || 300) / 60) : 0;
    }

    let cancelled = false;
    const task = {
        running: true,
        cancel: () => { cancelled = true; },
    };
    envioPersonalActivo[userId] = task;

    (async () => {
        try {
            // Obtener la lista de chats personales
            const chats = await listarChatsPersonales(botSock);
            // Incluir numeros manuales subidos por el usuario
            if (cuenta) {
                try {
                    const manuales = db.getNumerosManuales(userId, cuenta);
                    const existingJids = new Set(chats.map(c => c.jid));
                    for (const m of manuales) {
                        if (!existingJids.has(m.jid)) {
                            chats.push({ jid: m.jid, nombre: m.nombre || m.numero, numero: m.numero, manual: true });
                        }
                    }
                } catch (e) {
                    console.error(`Error cargando numeros manuales: ${e.message}`);
                }
            }
            if (!chats.length) {
                try {
                    await botSock.sendMessage(userId, {
                        text: "\u274C No se encontraron chats personales para enviar.",
                    });
                } catch (e) {}
                return;
            }

            const total = chats.length;
            let enviados = 0;
            let errores = 0;
            // Random cooldown between 3-8 seconds
            const DELAY_MIN_P = 3000;
            const DELAY_MAX_P = 8000;

            const batchInfo = batchSize ? `\n\u{1F4E6} Lotes de ${batchSize} mensajes, pausa ${delayMinutes} min entre lotes` : '';
            try {
                await botSock.sendMessage(userId, {
                    text: `\u{1F4E8} *ENVIO PERSONAL INICIADO*\n\n\u{1F464} ${total} chat(s) personales encontrados\n\u23F1 Delay: 3-8 seg aleatorio entre cada envio${batchInfo}\n\u23F3 Tiempo estimado: ~${Math.round(total * 5.5 / 60)} min\n\n\u{1F4A1} Escribe *cancelar envio* para detener.`,
                });
            } catch (e) {}

            for (let chatIdx = 0; chatIdx < chats.length; chatIdx++) {
                const chat = chats[chatIdx];
                if (cancelled) {
                    // Save progress before breaking so pause/resume works
                    db.guardarProgresoEnvio(userId, 'personal_' + userId, chatIdx, total, mensaje, chats.map(c => c.jid), 'Chats personales');
                    break;
                }

                try {
                    const textoFinal = addInvisibleChars(variarMensaje(mensaje, userId));
                    if (imagenPath && fs.existsSync(imagenPath)) {
                        await botSock.sendMessage(chat.jid, {
                            image: fs.readFileSync(imagenPath),
                            caption: textoFinal,
                        });
                    } else {
                        await botSock.sendMessage(chat.jid, { text: textoFinal });
                    }
                    enviados++;
                    db.registrarEnvio(userId, 0, chat.jid, "enviado_personal");
                    if (_promoListeners[userId]) _promoListeners[userId].promoSentJids.add(chat.jid);
                } catch (e) {
                    errores++;
                    console.error(`Error enviando a ${chat.numero}: ${e.message}`);
                    db.registrarEnvio(userId, 0, chat.jid, "error_personal");
                    // Add to retry queue (Mejora 4)
                    try { db.agregarRetryQueue(userId, chat.jid, mensaje, imagenPath); } catch (re) {}
                }

                // Progreso cada 10 envios
                if (enviados % 10 === 0 && enviados > 0) {
                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u{1F4E8} Progreso: ${enviados}/${total} enviados (${errores} errores)...`,
                        });
                    } catch (e) {}
                }

                // Batch pause: if batch_size configured, pause every N messages
                if (batchSize && enviados > 0 && enviados % batchSize === 0 && !cancelled) {
                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u23F8 Pausa de lote: ${enviados}/${total} enviados. Esperando ${delayMinutes} min...`,
                        });
                    } catch (e) {}
                    // Save progress in case of cancel during pause
                    db.guardarProgresoEnvio(userId, 'personal_' + userId, enviados, total, mensaje, chats.map(c => c.jid), 'Chats personales');
                    await delay((delayMinutes || 5) * 60 * 1000);
                    if (cancelled) break;
                }

                // Esperar entre cada envio
                if (!cancelled) {
                    const cooldownP = DELAY_MIN_P + Math.floor(Math.random() * (DELAY_MAX_P - DELAY_MIN_P));
                    await delay(cooldownP);
                }
            }

            // Resultado final
            try {
                await botSock.sendMessage(userId, {
                    text: `\u2705 *ENVIO PERSONAL COMPLETADO*\n\n\u{1F4E8} Total: ${total}\n\u2705 Enviados: ${enviados}\n\u274C Errores: ${errores}${cancelled ? "\n\u{1F6D1} Cancelado por el usuario" : ""}`,
                });
            } catch (e) {}

        } catch (e) {
            console.error(`Error envio personal ${userId}: ${e.message}`);
            try {
                await botSock.sendMessage(userId, {
                    text: `\u274C Error en envio personal: ${e.message}`,
                });
            } catch (ex) {}
        } finally {
            delete envioPersonalActivo[userId];
        }
    })();

    return true;
}

let _taskIdCounter = 0;
async function enviarASeleccionados(userId, jids, mensaje, imagenPath, botSock, batchSize, delayMinutes, grupoNombre, grupoJid, startIndex, cuenta) {
    if (envioPersonalActivo[userId]) return false;

    let cancelled = false;
    const taskId = ++_taskIdCounter;
    const task = {
        running: true,
        taskId,
        cancel: () => { cancelled = true; },
    };
    envioPersonalActivo[userId] = task;

    batchSize = parseInt(batchSize) || 0;
    delayMinutes = parseInt(delayMinutes) || 5;
    startIndex = parseInt(startIndex) || 0;

    const userJid = userId.includes('@') ? userId : userId + '@s.whatsapp.net';

    // Helper to get a fresh socket when connection drops
    async function getFreshSock() {
        if (cuenta) {
            try {
                const fresh = await getOrConnectClient(userId, cuenta);
                if (fresh && fresh.user) return fresh;
            } catch (e) {
                console.log(`[EnvioMiembros] Reconnect via cuenta '${cuenta}' failed: ${e.message}`);
            }
        }
        // Try any connected session for this user
        try {
            const sesiones = db.getSesiones(userId);
            for (const s of sesiones) {
                try {
                    const fresh = await getOrConnectClient(userId, s.nombre);
                    if (fresh && fresh.user) { cuenta = s.nombre; return fresh; }
                } catch (e) {}
            }
        } catch (e) {}
        return null;
    }

    function isConnectionError(err) {
        const msg = (err.message || '').toLowerCase();
        return msg.includes('disconnect') || msg.includes('timeout') || msg.includes('connection') ||
               msg.includes('socket') || msg.includes('closed') || msg.includes('not open') ||
               msg.includes('unavailable') || err.name === 'DisconnectError';
    }

    (async () => {
        try {
            const total = jids.length;
            let enviados = 0;
            let errores = 0;
            let consecutiveErrors = 0;
            // Anti-ban v2: wider delay range + typing simulation + random long pauses
            const DELAY_MIN = 15000;
            const DELAY_MAX = 45000;
            // Anti-ban: if no batch config, auto-batch every 5 messages with 10 min pause
            if (!batchSize) { batchSize = 5; delayMinutes = delayMinutes >= 10 ? delayMinutes : 10; }
            const DELAY_ENTRE_LOTES = batchSize ? delayMinutes * 60 * 1000 : 0;
            const displayName = grupoNombre || grupoJid || "seleccionados";

            const batchInfo = batchSize ? `\n📦 Lotes: ${batchSize} por lote, pausa ${delayMinutes} min entre lotes` : "";
            const resumeInfo = startIndex > 0 ? `\n🔄 Reanudando desde #${startIndex + 1}` : "";
            try {
                await botSock.sendMessage(userJid, {
                    text: `\u{1F4E8} *ENVIO A MIEMBROS INICIADO*\n📂 Grupo: ${displayName}\n\n\u{1F464} ${total} miembro(s)${resumeInfo}\n\u{1F6E1} Anti-ban v2: delay 15-45s + typing + pausas aleatorias${batchInfo}\n\u23F3 Tiempo estimado: ~${Math.round((total - startIndex) * 30 / 60)} min`,
                });
            } catch (e) {}

            // Save progress at the start so we can resume if interrupted
            if (grupoJid) {
                db.guardarProgresoEnvio(userId, grupoJid, startIndex, total, mensaje, jids, grupoNombre);
            }

            for (let i = startIndex; i < jids.length; i++) {
                if (cancelled) {
                    // Save progress for resume
                    if (grupoJid) {
                        db.guardarProgresoEnvio(userId, grupoJid, i, total, mensaje, jids, grupoNombre);
                    }
                    break;
                }
                const jid = jids[i];

                // Pausa entre lotes (anti-ban)
                if (batchSize && enviados > 0 && enviados % batchSize === 0) {
                    // Save progress before pause
                    if (grupoJid) {
                        db.guardarProgresoEnvio(userId, grupoJid, i, total, mensaje, jids, grupoNombre);
                    }
                    try {
                        await botSock.sendMessage(userJid, {
                            text: `⏸ Lote de ${batchSize} completado (${i}/${total}). Pausando ${delayMinutes} minutos...`,
                        });
                    } catch (e) {}
                    // Anti-ban: add random jitter (±30%) to batch pause
                    const jitter = DELAY_ENTRE_LOTES * (0.7 + Math.random() * 0.6);
                    await delay(Math.round(jitter));
                    if (cancelled) {
                        if (grupoJid) {
                            db.guardarProgresoEnvio(userId, grupoJid, i, total, mensaje, jids, grupoNombre);
                        }
                        break;
                    }
                    // Refresh socket after batch pause (connection may have dropped)
                    const freshAfterPause = await getFreshSock();
                    if (freshAfterPause) botSock = freshAfterPause;
                    try {
                        await botSock.sendMessage(userJid, {
                            text: `▶️ Reanudando envio... (${i}/${total})`,
                        });
                    } catch (e) {}
                }

                // Proactively check socket health before each send
                if (!botSock || !botSock.user || (botSock.ws && botSock.ws.readyState !== botSock.ws.OPEN)) {
                    console.log(`[EnvioMiembros] Socket stale, reconnecting...`);
                    const freshSock = await getFreshSock();
                    if (freshSock) {
                        botSock = freshSock;
                        consecutiveErrors = 0;
                    } else {
                        console.log(`[EnvioMiembros] Cannot reconnect, stopping send`);
                        if (grupoJid) db.guardarProgresoEnvio(userId, grupoJid, i, total, mensaje, jids, grupoNombre);
                        break;
                    }
                }

                try {
                    // Verify number has WhatsApp before sending (skip for @lid JIDs — they're in the group)
                    const numToCheck = jid.replace(/@s\.whatsapp\.net$/, "");
                    if (jid.endsWith("@s.whatsapp.net")) {
                        try {
                            const [onWa] = await botSock.onWhatsApp(jid);
                            if (!onWa || !onWa.exists) {
                                console.log(`[EnvioMiembros] #${i+1}/${total} → ${jid} NO TIENE WSP, saltando`);
                                errores++;
                                db.registrarEnvio(userId, 0, jid, "sin_whatsapp", grupoNombre, "personal");
                                continue;
                            }
                        } catch (verifyErr) {
                            console.log(`[EnvioMiembros] Verificacion WSP fallo para ${jid}: ${verifyErr.message}, enviando igual...`);
                        }
                    }

                    // Check if number is in individual blacklist
                    if (db.estaEnBlacklistNumero(userId, numToCheck)) {
                        console.log(`[EnvioMiembros] #${i+1}/${total} → ${jid} en blacklist, saltando`);
                        continue;
                    }

                    const textoFinal = addInvisibleChars(variarMensaje(mensaje, userId));
                    console.log(`[EnvioMiembros] #${i+1}/${total} → ${jid}`);

                    // Anti-ban: simulate typing before sending (looks human)
                    try {
                        await botSock.presenceSubscribe(jid);
                        await delay(500 + Math.random() * 1000);
                        await botSock.sendPresenceUpdate("composing", jid);
                        await delay(2000 + Math.random() * 3000);
                        await botSock.sendPresenceUpdate("paused", jid);
                    } catch (e) {}

                    let result;
                    if (imagenPath && fs.existsSync(imagenPath)) {
                        result = await botSock.sendMessage(jid, {
                            image: fs.readFileSync(imagenPath),
                            caption: textoFinal,
                        });
                    } else {
                        result = await botSock.sendMessage(jid, { text: textoFinal });
                    }

                    // Track delivery status
                    const msgId = result?.key?.id;
                    let estadoEntrega = null;
                    if (msgId) {
                        try {
                            const deliveryResult = await new Promise((resolve) => {
                                let done = false;
                                const handler = (updates) => {
                                    for (const upd of updates) {
                                        if (upd.key?.id === msgId) {
                                            const status = upd.update?.status;
                                            if (status >= 3) { if (!done) { done = true; resolve("leido"); } }
                                            else if (status >= 2) { if (!done) { done = true; resolve("entregado"); } }
                                            else if (status === 0) { if (!done) { done = true; resolve("rechazado"); } }
                                        }
                                    }
                                };
                                botSock.ev.on("messages.update", handler);
                                setTimeout(() => {
                                    try { botSock.ev.off("messages.update", handler); } catch (e) {}
                                    if (!done) { done = true; resolve("pendiente"); }
                                }, 8000);
                            });
                            estadoEntrega = deliveryResult;
                        } catch (e) {}
                    }

                    console.log(`[EnvioMiembros]   OK → key.id=${msgId || "?"} entrega=${estadoEntrega || "?"}`);
                    enviados++;
                    consecutiveErrors = 0;
                    db.registrarEnvio(userId, 0, jid, "enviado_personal", grupoNombre, "personal", estadoEntrega, (mensaje || "").substring(0, 50));
                    if (_promoListeners[userId]) _promoListeners[userId].promoSentJids.add(jid);
                } catch (e) {
                    console.log(`[EnvioMiembros]   ERROR → ${e.message}`);
                    errores++;
                    consecutiveErrors++;

                    // On connection error, try to reconnect before continuing
                    if (isConnectionError(e)) {
                        console.log(`[EnvioMiembros] Connection error detected, attempting reconnect...`);
                        const freshSock = await getFreshSock();
                        if (freshSock) {
                            botSock = freshSock;
                            console.log(`[EnvioMiembros] Reconnected successfully`);
                        }
                    }

                    // Stop after 10 consecutive errors (connection likely dead)
                    if (consecutiveErrors >= 10) {
                        console.log(`[EnvioMiembros] 10 consecutive errors, stopping`);
                        if (grupoJid) db.guardarProgresoEnvio(userId, grupoJid, i + 1, total, mensaje, jids, grupoNombre);
                        try { await botSock.sendMessage(userJid, { text: `⚠️ Envio pausado tras 10 errores consecutivos. Puedes reanudar desde el panel.` }); } catch (ne) {}
                        break;
                    }

                    db.registrarEnvio(userId, 0, jid, "error_personal", grupoNombre, "personal");
                    // Add to retry queue (Mejora 4)
                    try { db.agregarRetryQueue(userId, jid, mensaje, imagenPath); } catch (re) {}
                }

                // Save progress periodically (every 5 sends)
                if (grupoJid && (enviados + errores) % 5 === 0) {
                    db.guardarProgresoEnvio(userId, grupoJid, i + 1, total, mensaje, jids, grupoNombre);
                }

                if (enviados % 10 === 0 && enviados > 0 && !(batchSize && enviados % batchSize === 0)) {
                    try {
                        await botSock.sendMessage(userJid, {
                            text: `\u{1F4E8} Progreso: ${i + 1}/${total} (${enviados} ok, ${errores} err)...`,
                        });
                    } catch (e) {}
                }

                if (!cancelled) {
                    // Anti-ban v2: progressive delay — add 3s per 5 messages sent
                    const progressiveExtra = Math.floor(enviados / 5) * 3000;
                    let cooldown = DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN)) + progressiveExtra;
                    // Anti-ban v2: random long pause (20% chance of 60-120s extra pause)
                    if (Math.random() < 0.2) {
                        const longPause = 60000 + Math.floor(Math.random() * 60000);
                        console.log(`[EnvioMiembros] Anti-ban: pausa larga aleatoria ${Math.round(longPause/1000)}s`);
                        cooldown += longPause;
                    }
                    await delay(cooldown);
                }
            }

            // If completed (not cancelled), remove progress
            if (!cancelled && grupoJid) {
                db.eliminarProgresoEnvio(userId, grupoJid);
            }

            try {
                await botSock.sendMessage(userJid, {
                    text: `\u2705 *ENVIO A MIEMBROS ${cancelled ? "PAUSADO" : "COMPLETADO"}*\n📂 Grupo: ${displayName}\n\n\u{1F4E8} Total: ${total}\n\u2705 Enviados: ${enviados}\n\u274C Errores: ${errores}${cancelled ? "\n\u{1F6D1} Pausado — puedes reanudar desde el panel" : ""}`,
                });
            } catch (e) {}

        } catch (e) {
            console.error(`Error envio personal ${userId}: ${e.message}`);
        } finally {
            if (envioPersonalActivo[userId]?.taskId === taskId) {
                delete envioPersonalActivo[userId];
            }
        }
    })();

    return true;
}

function detenerEnvioPersonal(userId) {
    const task = envioPersonalActivo[userId];
    if (task) {
        task.cancel();
        return true;
    }
    return false;
}

// ============================================================
// Scheduled member sends checker
// ============================================================
let _schedulerInterval = null;

function iniciarSchedulerMiembros(botSock) {
    if (_schedulerInterval) return;
    // Check every minute for scheduled sends
    _schedulerInterval = setInterval(async () => {
        try {
            const now = new Date();
            const peruTime = new Date(now.toLocaleString("en-US", { timeZone: config.TIMEZONE }));
            const horaActual = String(peruTime.getHours()).padStart(2, "0") + ":" + String(peruTime.getMinutes()).padStart(2, "0");
            const diaActual = peruTime.getDay();

            // Get all active scheduled sends from all users
            const allUsers = db.getTodosUsuarios();
            for (const user of allUsers) {
                const programados = db.getProgramadosMiembros(user.wsp_id);
                for (const prog of programados) {
                    if (!prog.activo) continue;
                    const diasPermitidos = (prog.dias_semana || "0,1,2,3,4,5,6").split(",").map(Number);
                    if (!diasPermitidos.includes(diaActual)) continue;
                    if (prog.hora_envio !== horaActual) continue;
                    // Check if already sent today
                    if (prog.ultimo_envio) {
                        const lastSend = new Date(prog.ultimo_envio + "Z");
                        const hoyPeru = peruTime.toISOString().split("T")[0];
                        const lastSendPeru = new Date(lastSend.toLocaleString("en-US", { timeZone: config.TIMEZONE }));
                        const lastSendDate = lastSendPeru.toISOString().split("T")[0];
                        if (lastSendDate === hoyPeru) continue;
                    }
                    // Execute the scheduled send
                    console.log(`[Scheduler] Ejecutando envio programado #${prog.id} para ${user.wsp_id}`);
                    db.actualizarUltimoEnvioProgramado(prog.id);
                    try {
                        let sock;
                        if (prog.cuenta) {
                            sock = await getOrConnectClient(user.wsp_id, prog.cuenta);
                        } else if (botSock) {
                            sock = botSock;
                        } else continue;

                        const meta = await sock.groupMetadata(prog.grupo_jid);
                        const rawParticipants = meta.participants || [];
                        const myJid = sock.user?.id || "";
                        const myNum = myJid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
                        const blNumeros = db.getBlacklistNumeros(user.wsp_id);
                        const blSet = new Set(blNumeros.map(b => b.numero));
                        const seen = new Set();
                        const jids = [];
                        for (const p of rawParticipants) {
                            let jid = (p.jid && p.jid.endsWith("@s.whatsapp.net")) ? p.jid : p.id;
                            if (!jid || jid.endsWith("@lid")) continue;
                            if (jid.includes(":")) {
                                const suffix = jid.endsWith("@s.whatsapp.net") ? "@s.whatsapp.net" : "@lid";
                                jid = jid.split(":")[0] + suffix;
                            }
                            const num = jid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
                            if (!num || !/^\d{7,15}$/.test(num) || num === myNum || blSet.has(num) || seen.has(num)) continue;
                            if (prog.country_code && !num.startsWith(prog.country_code)) continue;
                            if (prog.admin_filter === "admin" && p.admin !== "admin" && p.admin !== "superadmin") continue;
                            if (prog.admin_filter === "noadmin" && (p.admin === "admin" || p.admin === "superadmin")) continue;
                            seen.add(num);
                            jids.push(jid);
                        }
                        if (jids.length) {
                            const grupoNombre = meta.subject || prog.grupo_nombre || prog.grupo_jid;
                            enviarASeleccionados(user.wsp_id, jids, prog.mensaje, prog.imagen_path, sock, prog.batch_size || 0, prog.delay_minutes || 5, grupoNombre, prog.grupo_jid, 0, prog.cuenta || null);
                        }
                    } catch (e) {
                        console.error(`[Scheduler] Error envio programado #${prog.id}: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            console.error(`[Scheduler] Error general: ${e.message}`);
        }
    }, 60000);
}

// --- PROMO ESCUCHA (Envio Interactivo) ---
const _promoListeners = {}; // { userId: { handlers: [], cancel: fn, respondedJids, startTime } }

function iniciarPromoEscucha(userId, sock, palabraAceptar, palabraRechazar, respAceptar, respRechazar, respAceptarImagen, respRechazarImagen) {
    if (!_promoListeners[userId]) {
        _promoListeners[userId] = { handlers: [], cancelled: false, respondedJids: new Set(), promoSentJids: new Set(), startTime: Date.now() };
        try {
            const existing = db.getPromoRespuestas(userId);
            for (const r of existing) {
                if (r.jid) _promoListeners[userId].respondedJids.add(r.jid);
            }
        } catch (e) {}
        try {
            const sentJids = db.getPromoSentJids(userId);
            for (const jid of sentJids) {
                if (jid) _promoListeners[userId].promoSentJids.add(jid);
            }
        } catch (e) {}
    }
    const state = _promoListeners[userId];
    const acLower = (palabraAceptar || 'si').toLowerCase().trim();
    const reLower = (palabraRechazar || 'no').toLowerCase().trim();

    // Load multi-keywords if configured (Mejora 7)
    let extraKeywords = [];
    try { extraKeywords = db.getPromoKeywords(userId); } catch (e) {}

    const handler = async ({ messages }) => {
        if (state.cancelled) return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
            if (state.respondedJids.has(jid)) continue;
            if (state.promoSentJids.size > 0 && !state.promoSentJids.has(jid)) continue;

            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();
            const pushName = msg.pushName || "";
            const numero = jid.replace(/@s\.whatsapp\.net$/, "");

            // Check extra keywords first (Mejora 7)
            let matched = false;
            for (const kw of extraKeywords) {
                if (matchWholeWord(text, kw.palabra.toLowerCase().trim())) {
                    state.respondedJids.add(jid);
                    db.registrarPromoRespuesta(userId, jid, numero, pushName, kw.tipo || 'aceptado');
                    db.agregarLog(userId, 'promo', `${numero} (${pushName}) respondio "${text}" -> keyword "${kw.palabra}"`);
                    console.log(`[Promo] ${numero} (${pushName}) keyword "${kw.palabra}" con "${text}" (respuesta unica)`);
                    if (kw.respuesta_imagen && fs.existsSync(kw.respuesta_imagen)) {
                        try { await sock.sendMessage(jid, { image: fs.readFileSync(kw.respuesta_imagen), caption: kw.respuesta_texto || '' }); } catch (e) {}
                    } else if (kw.respuesta_texto) {
                        try { await sock.sendMessage(jid, { text: kw.respuesta_texto }); } catch (e) {}
                    }
                    matched = true;
                    break;
                }
            }
            if (matched) continue;

            // Default accept/reject keywords
            if (matchWholeWord(text, acLower)) {
                state.respondedJids.add(jid);
                db.registrarPromoRespuesta(userId, jid, numero, pushName, 'aceptado');
                db.agregarLog(userId, 'promo', `${numero} (${pushName}) ACEPTO con "${text}"`);
                console.log(`[Promo] ${numero} (${pushName}) ACEPTO con "${text}" (respuesta unica)`);
                // Mejora 8: respond with image if configured
                if (respAceptarImagen && fs.existsSync(respAceptarImagen)) {
                    try { await sock.sendMessage(jid, { image: fs.readFileSync(respAceptarImagen), caption: respAceptar || '' }); } catch (e) {}
                } else if (respAceptar) {
                    try { await sock.sendMessage(jid, { text: respAceptar }); } catch (e) {}
                }
            } else if (matchWholeWord(text, reLower)) {
                state.respondedJids.add(jid);
                db.registrarPromoRespuesta(userId, jid, numero, pushName, 'rechazado');
                db.agregarLog(userId, 'promo', `${numero} (${pushName}) RECHAZO con "${text}"`);
                console.log(`[Promo] ${numero} (${pushName}) RECHAZO con "${text}" (respuesta unica)`);
                if (respRechazarImagen && fs.existsSync(respRechazarImagen)) {
                    try { await sock.sendMessage(jid, { image: fs.readFileSync(respRechazarImagen), caption: respRechazar || '' }); } catch (e) {}
                } else if (respRechazar) {
                    try { await sock.sendMessage(jid, { text: respRechazar }); } catch (e) {}
                }
            }
        }
    };
    sock.ev.on("messages.upsert", handler);
    state.handlers.push({ sock, handler });
}

function detenerPromoEscuchaFn(userId) {
    const state = _promoListeners[userId];
    if (state) {
        state.cancelled = true;
        for (const { sock, handler } of state.handlers) {
            try { sock.ev.off("messages.upsert", handler); } catch (e) {}
        }
        delete _promoListeners[userId];
    }
}

// --- RETRY QUEUE PROCESSOR (Mejora 4) ---
let _retryInterval = null;
function iniciarRetryProcessor() {
    if (_retryInterval) return;
    _retryInterval = setInterval(async () => {
        try {
            const pendientes = db.getRetryPendientesGlobal();
            for (const item of pendientes) {
                try {
                    const sesiones = db.getSesiones(item.user_id);
                    if (!sesiones.length) continue;
                    const sock = await getOrConnectClient(item.user_id, sesiones[0].nombre);
                    if (!sock) continue;

                    if (item.imagen_path && fs.existsSync(item.imagen_path)) {
                        await sock.sendMessage(item.jid, { image: fs.readFileSync(item.imagen_path), caption: item.mensaje || '' });
                    } else {
                        await sock.sendMessage(item.jid, { text: item.mensaje });
                    }
                    db.actualizarRetry(item.id, item.intentos + 1, 'enviado', '');
                    db.agregarLog(item.user_id, 'retry', `Retry exitoso para ${item.jid} (intento ${item.intentos + 1})`);
                    console.log(`[Retry] Enviado a ${item.jid} (intento ${item.intentos + 1})`);
                    await delay(2000);
                } catch (e) {
                    const newIntentos = item.intentos + 1;
                    const estado = newIntentos >= item.max_intentos ? 'fallido' : 'pendiente';
                    db.actualizarRetry(item.id, newIntentos, estado, e.message);
                    db.agregarLog(item.user_id, 'retry_error', `Retry fallido para ${item.jid}: ${e.message} (intento ${newIntentos})`);
                    console.log(`[Retry] Error ${item.jid}: ${e.message} (intento ${newIntentos}/${item.max_intentos})`);
                }
            }
        } catch (e) {
            console.error(`[Retry] Error general: ${e.message}`);
        }
    }, 60000); // Check every minute
}

// --- PROMO TIMEOUT CHECKER (Mejora 3) ---
let _timeoutInterval = null;
function iniciarPromoTimeoutChecker() {
    if (_timeoutInterval) return;
    _timeoutInterval = setInterval(async () => {
        try {
            // Check all active promo listeners for timeouts
            for (const userId of Object.keys(_promoListeners)) {
                const state = _promoListeners[userId];
                if (!state || state.cancelled) continue;

                const timeoutConfig = db.getPromoTimeout(userId);
                if (!timeoutConfig) continue;

                const timeoutMs = (timeoutConfig.timeout_horas || 24) * 3600 * 1000;
                const elapsed = Date.now() - state.startTime;

                if (elapsed >= timeoutMs) {
                    // Mark unresponded contacts and optionally send reminders
                    const escucha = db.getPromoEscucha(userId);
                    if (timeoutConfig.recordatorio_activo && timeoutConfig.mensaje_recordatorio && state.handlers.length > 0) {
                        const sock = state.handlers[0].sock;
                        // Get all contacts that received the promo but didn't respond
                        // We don't have a list of who received it, so we just log the timeout
                        db.agregarLog(userId, 'promo_timeout', `Promo timeout alcanzado (${timeoutConfig.timeout_horas}h). Respondieron: ${state.respondedJids.size}`);
                    }

                    // Auto-stop after timeout
                    db.agregarLog(userId, 'promo_timeout', `Escucha promo detenida automaticamente por timeout (${timeoutConfig.timeout_horas}h)`);
                    console.log(`[Promo] Timeout para ${userId} (${timeoutConfig.timeout_horas}h). Deteniendo escucha.`);
                    db.detenerPromoEscucha(userId);
                    detenerPromoEscuchaFn(userId);
                }
            }
        } catch (e) {
            console.error(`[PromoTimeout] Error: ${e.message}`);
        }
    }, 60000); // Check every minute
}

module.exports = {
    tareasActivas,
    getCampanasActivas,
    responderActivos,
    envioPersonalActivo,
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
    linkAccount,
    getLinkStatus,
    clearLink,
    iniciarCampana,
    detenerCampana,
    getCampanaReposo,
    isCampanaRunning,
    iniciarReporteDiario,
    detenerReporteDiario,
    iniciarResponder,
    detenerResponder,
    listarChatsPersonales,
    enviarAPersonales,
    enviarASeleccionados,
    detenerEnvioPersonal,
    sendToGroup,
    resolveGroupJid,
    registrarActividadGrupo,
    iniciarSchedulerMiembros,
    iniciarPromoEscucha,
    detenerPromoEscucha: detenerPromoEscuchaFn,
    iniciarRetryProcessor,
    iniciarPromoTimeoutChecker,
};
