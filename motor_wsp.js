const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const config = require("./config");

const tareasActivas = {};    // { campanaId: { running, cancel, paused, progressIndex } }
const responderActivos = {}; // { userId: { running, cancel, paused, respondidos } }
const clientSessions = {};   // { "userId_nombre": socket }
const pendingLinks = {};     // { "userId_nombre": { qr, status, error } }
const reporteInterval = {};  // { userId: intervalId }

// Estado de pausa de campanas: { campanaId: { grupoIndex, cuentaIndex, ciclo } }
const campanaProgress = {};

// Preguntas random/graciosas para el auto-responder
const PREGUNTAS_RANDOM = [
    "Jajaja oye y tu que opinas de eso? 😂",
    "Uy yo tambien busco eso! Tu de donde eres? 🤔",
    "Jaja alguien sabe si eso es verdad? 😅",
    "Wow no sabia eso! Donde lo viste? 👀",
    "Oigan y eso funciona o es puro cuento? 🤣",
    "Jajaja que buena pregunta, alguien sabe? 😂",
    "Ey yo tambien quiero saber! Alguno tiene info? 🙋",
    "Jaja me paso lo mismo! Y tu que hiciste? 😆",
    "Eso suena interesante, cuéntame mas! 🧐",
    "Jajaja pensé que era el unico que buscaba eso 😂",
    "Oye y eso donde lo consigo? Alguien sabe? 🤷",
    "Jaja que random! Pero si, yo tambien necesito 😅",
    "Uy que bueno que alguien preguntó eso! 🔥",
    "Jajaja justo estaba pensando en eso! 😂",
    "Wow no manches! Eso es real? 😱",
    "Oigan alguien tiene experiencia con eso? 🤔",
    "Jaja yo tambien ando en las mismas! 😆",
    "Que genial! Alguien ya lo probo? 👀",
    "Jajaja me hiciste el dia con esa pregunta 😂",
    "Ey buena onda! Yo te puedo ayudar con eso 💪",
];

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

    return new Promise((resolve, reject) => {
        let resolved = false;
        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open" && !resolved) {
                resolved = true;
                const key = `${userId}_${nombre}`;
                clientSessions[key] = sock;
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
        // Filtrar grupos de solo lectura (solo admins pueden escribir)
        if (groupMetadata.announce === true) return false;
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
    if (tareasActivas[campanaId]) {
        // Si estaba pausado, reanudar
        const existing = tareasActivas[campanaId];
        if (existing.paused) {
            existing.paused = false;
            console.log(`[Campana] Reanudando campana ${campanaId} desde progreso guardado`);
            return true;
        }
        return false;
    }

    let cancelled = false;
    let paused = false;
    const task = {
        running: true,
        cancel: () => { cancelled = true; },
        get paused() { return paused; },
        set paused(v) { paused = v; },
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

            // Restaurar progreso guardado si existe
            let startGrupoIndex = 0;
            let startCuentaIndex = 0;
            if (campanaProgress[campanaId]) {
                const saved = campanaProgress[campanaId];
                ciclo = saved.ciclo || 0;
                startGrupoIndex = saved.grupoIndex || 0;
                startCuentaIndex = saved.cuentaIndex || 0;
                delete campanaProgress[campanaId];
                console.log(`[Campana ${campana.nombre}] Reanudando desde ciclo=${ciclo}, cuenta=${startCuentaIndex}, grupo=${startGrupoIndex}`);
                try {
                    await botSock.sendMessage(userId, {
                        text: `\u25B6 *${campana.nombre}* reanudada desde donde se pausó.\nCiclo: ${ciclo} | Grupo: ${startGrupoIndex + 1}`,
                    });
                } catch (e) {}
            }

            while (!cancelled) {
                // Verificar si esta pausado
                while (paused && !cancelled) {
                    await delay(2000);
                }
                if (cancelled) break;

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

                for (let si = (startCuentaIndex > 0 ? startCuentaIndex : 0); si < socks.length; si++) {
                    if (cancelled || paused) break;
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

                    for (let gi = (si === startCuentaIndex && startGrupoIndex > 0 ? startGrupoIndex : 0); gi < gruposActuales.length; gi++) {
                        const grupoLink = gruposActuales[gi];
                        if (cancelled) break;
                        // Guardar progreso y pausar si se solicita
                        if (paused) {
                            campanaProgress[campanaId] = { grupoIndex: gi, cuentaIndex: si, ciclo };
                            console.log(`[Campana] Pausada en ciclo=${ciclo}, cuenta=${si}, grupo=${gi}`);
                            break;
                        }

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

                // Resetear indices de inicio despues del primer ciclo restaurado
                startCuentaIndex = 0;
                startGrupoIndex = 0;

                // Reporte de ciclo
                if (!cancelled && !paused) {
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
        delete campanaProgress[campanaId];
        db.setCampanaActiva(campanaId, false);
        return true;
    }
    // Aunque no haya tarea activa, asegurar que la DB este limpia
    db.setCampanaActiva(campanaId, false);
    return false;
}

function pausarCampana(campanaId) {
    const task = tareasActivas[campanaId];
    if (task && !task.paused) {
        task.paused = true;
        return true;
    }
    return false;
}

function reanudarCampana(campanaId, userId, botSock) {
    const task = tareasActivas[campanaId];
    if (task && task.paused) {
        task.paused = false;
        return true;
    }
    // Si no hay tarea activa pero hay progreso guardado, re-iniciar
    if (!task && campanaProgress[campanaId]) {
        return iniciarCampana(campanaId, userId, botSock);
    }
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
// Configuracion de rate-limit del responder
const RESPONDER_MAX_MENSAJES = 10;     // Enviar maximo N mensajes antes de pausar
const RESPONDER_PAUSA_SEGUNDOS = 300;  // Pausar 5 minutos (300s) despues de N mensajes

function iniciarResponder(userId, contacto, palabras, botSock) {
    if (responderActivos[userId]) {
        // Si estaba pausado, reanudar
        const existing = responderActivos[userId];
        if (existing.paused) {
            existing.paused = false;
            console.log(`[Responder] Reanudando para usuario ${userId} (respondidos: ${existing.respondidos})`);
            return true;
        }
        return false;
    }

    let cancelled = false;
    let paused = false;
    let respondidos = 0;
    const task = {
        running: true,
        cancel: () => { cancelled = true; },
        get paused() { return paused; },
        set paused(v) { paused = v; },
        get respondidos() { return respondidos; },
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
                    if (cancelled || paused) return;
                    for (const msg of messages) {
                        if (!msg.message || msg.key.fromMe) continue;
                        const jid = msg.key.remoteJid;
                        if (!jid || !jid.endsWith("@g.us")) continue;

                        const text = msg.message.conversation
                            || msg.message.extendedTextMessage?.text
                            || "";
                        const lower = text.toLowerCase();

                        for (const kw of keywordsLower) {
                            if (lower.includes(kw)) {
                                // Rate limiting: si ya se enviaron N mensajes, pausar
                                if (respondidos >= RESPONDER_MAX_MENSAJES) {
                                    if (!paused) {
                                        paused = true;
                                        console.log(`[Responder] Rate limit: ${respondidos} mensajes enviados, pausando ${RESPONDER_PAUSA_SEGUNDOS}s...`);
                                        try {
                                            await botSock.sendMessage(userId, {
                                                text: `\u23F8 *Auto-responder pausado*\n\n` +
                                                    `Se enviaron ${respondidos} mensajes.\n` +
                                                    `Esperando ${Math.round(RESPONDER_PAUSA_SEGUNDOS / 60)} minutos...\n\n` +
                                                    `Escribe *reanudar* para continuar antes.`,
                                            });
                                        } catch (e) {}
                                        // Esperar la pausa
                                        await delay(RESPONDER_PAUSA_SEGUNDOS * 1000);
                                        if (cancelled) return;
                                        paused = false;
                                        respondidos = 0;
                                        try {
                                            await botSock.sendMessage(userId, {
                                                text: `\u25B6 *Auto-responder reanudado* despues de la pausa.`,
                                            });
                                        } catch (e) {}
                                    }
                                    return;
                                }

                                try {
                                    // Usar preguntas random/graciosas
                                    const pregunta = PREGUNTAS_RANDOM[Math.floor(Math.random() * PREGUNTAS_RANDOM.length)];
                                    await sock.sendMessage(jid, {
                                        text: pregunta,
                                    }, { quoted: msg });
                                    db.registrarRespuesta(userId, jid, kw);
                                    respondidos++;
                                    console.log(`[Responder] ${nombre}: respondido ${respondidos}/${RESPONDER_MAX_MENSAJES} en ${jid}`);
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

function pausarResponder(userId) {
    const task = responderActivos[userId];
    if (task && !task.paused) {
        task.paused = true;
        return true;
    }
    return false;
}

function reanudarResponder(userId) {
    const task = responderActivos[userId];
    if (task && task.paused) {
        task.paused = false;
        return true;
    }
    return false;
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

async function enviarAPersonales(userId, mensaje, imagenPath, botSock) {
    if (envioPersonalActivo[userId]) return false;

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
            const DELAY_ENTRE_ENVIOS = 10000; // 10 segundos

            try {
                await botSock.sendMessage(userId, {
                    text: `\u{1F4E8} *ENVIO PERSONAL INICIADO*\n\n\u{1F464} ${total} chat(s) personales encontrados\n\u23F1 Delay: 10 segundos entre cada envio\n\u23F3 Tiempo estimado: ~${Math.round(total * 10 / 60)} min\n\n\u{1F4A1} Escribe *cancelar envio* para detener.`,
                });
            } catch (e) {}

            for (const chat of chats) {
                if (cancelled) break;

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
                } catch (e) {
                    errores++;
                    console.error(`Error enviando a ${chat.numero}: ${e.message}`);
                    db.registrarEnvio(userId, 0, chat.jid, "error_personal");
                }

                // Progreso cada 10 envios
                if (enviados % 10 === 0 && enviados > 0) {
                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u{1F4E8} Progreso: ${enviados}/${total} enviados (${errores} errores)...`,
                        });
                    } catch (e) {}
                }

                // Esperar 10 segundos entre cada envio
                if (!cancelled) {
                    await delay(DELAY_ENTRE_ENVIOS);
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

async function enviarASeleccionados(userId, jids, mensaje, imagenPath, botSock) {
    if (envioPersonalActivo[userId]) return false;

    let cancelled = false;
    const task = {
        running: true,
        cancel: () => { cancelled = true; },
    };
    envioPersonalActivo[userId] = task;

    (async () => {
        try {
            const total = jids.length;
            let enviados = 0;
            let errores = 0;
            const DELAY_ENTRE_ENVIOS = 10000; // 10 segundos

            try {
                await botSock.sendMessage(userId, {
                    text: `\u{1F4E8} *ENVIO PERSONAL INICIADO*\n\n\u{1F464} ${total} contacto(s) seleccionados\n\u23F1 Delay: 10 segundos entre cada envio\n\u23F3 Tiempo estimado: ~${Math.round(total * 10 / 60)} min`,
                });
            } catch (e) {}

            for (const jid of jids) {
                if (cancelled) break;

                try {
                    const textoFinal = addInvisibleChars(variarMensaje(mensaje, userId));
                    if (imagenPath && fs.existsSync(imagenPath)) {
                        await botSock.sendMessage(jid, {
                            image: fs.readFileSync(imagenPath),
                            caption: textoFinal,
                        });
                    } else {
                        await botSock.sendMessage(jid, { text: textoFinal });
                    }
                    enviados++;
                    db.registrarEnvio(userId, 0, jid, "enviado_personal");
                } catch (e) {
                    errores++;
                    db.registrarEnvio(userId, 0, jid, "error_personal");
                }

                if (enviados % 10 === 0 && enviados > 0) {
                    try {
                        await botSock.sendMessage(userId, {
                            text: `\u{1F4E8} Progreso: ${enviados}/${total} enviados (${errores} errores)...`,
                        });
                    } catch (e) {}
                }

                if (!cancelled) {
                    await delay(DELAY_ENTRE_ENVIOS);
                }
            }

            try {
                await botSock.sendMessage(userId, {
                    text: `\u2705 *ENVIO PERSONAL COMPLETADO*\n\n\u{1F4E8} Total: ${total}\n\u2705 Enviados: ${enviados}\n\u274C Errores: ${errores}${cancelled ? "\n\u{1F6D1} Cancelado por el usuario" : ""}`,
                });
            } catch (e) {}

        } catch (e) {
            console.error(`Error envio personal ${userId}: ${e.message}`);
        } finally {
            delete envioPersonalActivo[userId];
        }
    })();

    return true;
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

module.exports = {
    tareasActivas,
    getCampanasActivas,
    campanaProgress,
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
    pausarCampana,
    reanudarCampana,
    iniciarReporteDiario,
    detenerReporteDiario,
    iniciarResponder,
    detenerResponder,
    pausarResponder,
    reanudarResponder,
    listarChatsPersonales,
    enviarAPersonales,
    enviarASeleccionados,
    detenerEnvioPersonal,
};
