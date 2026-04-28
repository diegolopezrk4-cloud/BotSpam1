const Database = require("better-sqlite3");
const path = require("path");
const config = require("./config_wsp");

let db;

// Helper: fecha/hora en zona horaria de Peru (America/Lima)
function nowPeru() {
    return new Date().toLocaleString("sv-SE", { timeZone: config.TIMEZONE }).replace("T", " ");
}

function hoyPeru() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: config.TIMEZONE });
}

function expiraPeru(dias) {
    const fecha = new Date(Date.now() + dias * 86400000);
    return fecha.toLocaleString("sv-SE", { timeZone: config.TIMEZONE }).replace("T", " ");
}

function init() {
    db = new Database(config.DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(`
        CREATE TABLE IF NOT EXISTS usuarios (
            wsp_id TEXT PRIMARY KEY,
            nombre TEXT DEFAULT '',
            codigo TEXT DEFAULT NULL,
            plan TEXT DEFAULT 'sin_plan',
            fecha_expira TEXT DEFAULT NULL,
            activo INTEGER DEFAULT 0,
            fecha_registro TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sesiones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            nombre TEXT,
            telefono TEXT,
            activa INTEGER DEFAULT 1,
            fecha_registro TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS campanas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            nombre TEXT,
            mensaje TEXT,
            imagen_path TEXT DEFAULT NULL,
            activa INTEGER DEFAULT 0,
            enviados INTEGER DEFAULT 0,
            errores INTEGER DEFAULT 0,
            inicio TEXT DEFAULT NULL,
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS campana_sesiones (
            campana_id INTEGER,
            sesion_nombre TEXT,
            PRIMARY KEY(campana_id, sesion_nombre)
        );
        CREATE TABLE IF NOT EXISTS grupos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            link TEXT,
            nombre TEXT DEFAULT NULL,
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS campana_grupos (
            campana_id INTEGER,
            grupo_link TEXT,
            PRIMARY KEY(campana_id, grupo_link)
        );
        CREATE TABLE IF NOT EXISTS campana_config (
            campana_id INTEGER PRIMARY KEY,
            intervalo_min INTEGER DEFAULT 30,
            intervalo_max INTEGER DEFAULT 60,
            espera_cuenta INTEGER DEFAULT 300,
            espera_ciclo INTEGER DEFAULT 600,
            FOREIGN KEY(campana_id) REFERENCES campanas(id)
        );
        CREATE TABLE IF NOT EXISTS limites_usuario (
            user_id TEXT PRIMARY KEY,
            max_grupos INTEGER DEFAULT 25,
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS responder_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            contacto TEXT,
            activo INTEGER DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS responder_keywords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            palabra TEXT,
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS historial_envios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            campana_id INTEGER,
            grupo_link TEXT,
            resultado TEXT DEFAULT 'enviado',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS historial_respuestas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            grupo_link TEXT,
            keyword TEXT,
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            nombre TEXT,
            mensaje TEXT,
            imagen_path TEXT DEFAULT NULL,
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
        CREATE TABLE IF NOT EXISTS blacklist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            grupo_link TEXT,
            razon TEXT DEFAULT '',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id),
            UNIQUE(user_id, grupo_link)
        );
        CREATE TABLE IF NOT EXISTS grupo_stats (
            user_id TEXT,
            grupo_link TEXT,
            enviados INTEGER DEFAULT 0,
            fallidos INTEGER DEFAULT 0,
            pending INTEGER DEFAULT 0,
            ultima_fecha TEXT DEFAULT NULL,
            PRIMARY KEY(user_id, grupo_link)
        );
        CREATE TABLE IF NOT EXISTS campana_horario (
            campana_id INTEGER PRIMARY KEY,
            hora_inicio INTEGER DEFAULT 0,
            hora_fin INTEGER DEFAULT 24,
            FOREIGN KEY(campana_id) REFERENCES campanas(id)
        );
        CREATE TABLE IF NOT EXISTS envios_diarios (
            user_id TEXT,
            cuenta_nombre TEXT,
            fecha TEXT,
            total INTEGER DEFAULT 0,
            PRIMARY KEY(user_id, cuenta_nombre, fecha)
        );
        CREATE TABLE IF NOT EXISTS cuenta_estado (
            user_id TEXT,
            cuenta_nombre TEXT,
            baneada INTEGER DEFAULT 0,
            fecha_ban TEXT DEFAULT NULL,
            PRIMARY KEY(user_id, cuenta_nombre)
        );
        CREATE TABLE IF NOT EXISTS sinonimos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            palabra TEXT,
            alternativas TEXT,
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
    `);

    // Migraciones
    try {
        db.prepare("SELECT codigo FROM usuarios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE usuarios ADD COLUMN codigo TEXT DEFAULT NULL");
        console.log("   Columna 'codigo' agregada a usuarios");
    }
    try {
        db.prepare("SELECT nombre FROM grupos LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE grupos ADD COLUMN nombre TEXT DEFAULT NULL");
        console.log("   Columna 'nombre' agregada a grupos");
    }
    try {
        db.prepare("SELECT espera_cuenta FROM campana_config LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE campana_config ADD COLUMN espera_cuenta INTEGER DEFAULT 300");
        db.exec("ALTER TABLE campana_config ADD COLUMN espera_ciclo INTEGER DEFAULT 600");
        console.log("   Columnas 'espera_cuenta/espera_ciclo' agregadas");
    }
    console.log("\u2705 Base de datos WSP inicializada");
}

// --- USUARIOS ---
function getUsuario(wspId) {
    return db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(wspId);
}

function findUserByNumber(phoneNumber) {
    const withLid = phoneNumber + "@lid";
    const withWsp = phoneNumber + "@s.whatsapp.net";
    const userLid = db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(withLid);
    if (userLid) return userLid;
    const userWsp = db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(withWsp);
    if (userWsp) return userWsp;
    return null;
}

function getAllJidsForNumber(phoneNumber) {
    const jids = [];
    const withLid = phoneNumber + "@lid";
    const withWsp = phoneNumber + "@s.whatsapp.net";
    if (db.prepare("SELECT 1 FROM usuarios WHERE wsp_id = ?").get(withLid)) jids.push(withLid);
    if (db.prepare("SELECT 1 FROM usuarios WHERE wsp_id = ?").get(withWsp)) jids.push(withWsp);
    return jids;
}

function generarCodigo() {
    const max = db.prepare("SELECT MAX(CAST(codigo AS INTEGER)) as m FROM usuarios WHERE codigo IS NOT NULL").get();
    return String((max && max.m ? max.m : 1000) + 1);
}

function crearUsuario(wspId, nombre) {
    db.prepare("INSERT OR IGNORE INTO usuarios (wsp_id, nombre) VALUES (?, ?)").run(wspId, nombre);
    db.prepare("UPDATE usuarios SET nombre = ? WHERE wsp_id = ?").run(nombre, wspId);
    const user = db.prepare("SELECT codigo FROM usuarios WHERE wsp_id = ?").get(wspId);
    if (user && !user.codigo) {
        const codigo = generarCodigo();
        db.prepare("UPDATE usuarios SET codigo = ? WHERE wsp_id = ?").run(codigo, wspId);
    }
}

function getUsuarioByCodigo(codigo) {
    return db.prepare("SELECT * FROM usuarios WHERE codigo = ?").get(codigo);
}

function activarMembresiaByCodigo(codigo, dias) {
    const user = db.prepare("SELECT * FROM usuarios WHERE codigo = ?").get(codigo);
    if (!user) return null;
    const expira = expiraPeru(dias);
    const plan = dias === 1 ? "diario" : dias === 7 ? "semanal" : "mensual";
    db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(plan, expira, user.wsp_id);
    const num = user.wsp_id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
    let altJid = null;
    if (user.wsp_id.endsWith("@lid")) altJid = num + "@s.whatsapp.net";
    else if (user.wsp_id.endsWith("@s.whatsapp.net")) altJid = num + "@lid";
    if (altJid) {
        const altUser = db.prepare("SELECT 1 FROM usuarios WHERE wsp_id = ?").get(altJid);
        if (altUser) {
            db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(plan, expira, altJid);
        }
    }
    return { plan, wspId: user.wsp_id, nombre: user.nombre };
}

function desactivarByCodigo(codigo) {
    const user = db.prepare("SELECT * FROM usuarios WHERE codigo = ?").get(codigo);
    if (!user) return null;
    db.prepare("UPDATE usuarios SET activo = 0 WHERE wsp_id = ?").run(user.wsp_id);
    const num = user.wsp_id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
    let altJid = user.wsp_id.endsWith("@lid") ? num + "@s.whatsapp.net" : num + "@lid";
    db.prepare("UPDATE usuarios SET activo = 0 WHERE wsp_id = ?").run(altJid);
    return user;
}

function banByCodigo(codigo) {
    const user = db.prepare("SELECT * FROM usuarios WHERE codigo = ?").get(codigo);
    if (!user) return null;
    db.prepare("UPDATE usuarios SET activo = 0, plan = 'baneado' WHERE wsp_id = ?").run(user.wsp_id);
    const num = user.wsp_id.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
    let altJid = user.wsp_id.endsWith("@lid") ? num + "@s.whatsapp.net" : num + "@lid";
    db.prepare("UPDATE usuarios SET activo = 0, plan = 'baneado' WHERE wsp_id = ?").run(altJid);
    return user;
}

function activarMembresia(wspId, dias) {
    const expira = expiraPeru(dias);
    const plan = dias === 1 ? "diario" : dias === 7 ? "semanal" : "mensual";
    db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(plan, expira, wspId);
}

function activarMembresiaByNumber(phoneNumber, dias) {
    const expira = expiraPeru(dias);
    const plan = dias === 1 ? "diario" : dias === 7 ? "semanal" : "mensual";
    const withLid = phoneNumber + "@lid";
    const withWsp = phoneNumber + "@s.whatsapp.net";
    let activated = false;
    const userLid = db.prepare("SELECT 1 FROM usuarios WHERE wsp_id = ?").get(withLid);
    if (userLid) {
        db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(plan, expira, withLid);
        activated = true;
    }
    const userWsp = db.prepare("SELECT 1 FROM usuarios WHERE wsp_id = ?").get(withWsp);
    if (userWsp) {
        db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(plan, expira, withWsp);
        activated = true;
    }
    if (!activated) {
        db.prepare("INSERT OR IGNORE INTO usuarios (wsp_id, nombre) VALUES (?, '')").run(withWsp);
        db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(plan, expira, withWsp);
    }
    return plan;
}

function desactivarByNumber(phoneNumber) {
    const withLid = phoneNumber + "@lid";
    const withWsp = phoneNumber + "@s.whatsapp.net";
    db.prepare("UPDATE usuarios SET activo = 0 WHERE wsp_id IN (?, ?)").run(withLid, withWsp);
}

function banByNumber(phoneNumber) {
    const withLid = phoneNumber + "@lid";
    const withWsp = phoneNumber + "@s.whatsapp.net";
    db.prepare("UPDATE usuarios SET activo = 0, plan = 'baneado' WHERE wsp_id IN (?, ?)").run(withLid, withWsp);
}

let botRealJid = null;
function setBotJid(jid) {
    botRealJid = jid;
}

let externalAdminJids = null;
function setAdminJids(jidsSet) {
    externalAdminJids = jidsSet;
}

function tieneMembresia(wspId) {
    const num = wspId.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
    if (num === config.ADMIN_NUMBER) return true;
    if (config.BOT_NUMBER && num === config.BOT_NUMBER) return true;
    if (externalAdminJids && externalAdminJids.has(wspId)) return true;
    if (botRealJid) {
        const botNum = botRealJid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
        if (num === botNum) return true;
    }
    const user = getUsuario(wspId);
    if (user && user.activo) {
        if (user.fecha_expira) {
            const expira = new Date(user.fecha_expira);
            if (Date.now() > expira.getTime()) {
                db.prepare("UPDATE usuarios SET activo = 0, plan = 'expirado' WHERE wsp_id = ?").run(wspId);
                return false;
            }
        }
        return true;
    }
    let altJid = null;
    if (wspId.endsWith("@lid")) {
        altJid = num + "@s.whatsapp.net";
    } else if (wspId.endsWith("@s.whatsapp.net")) {
        altJid = num + "@lid";
    }
    if (altJid) {
        const altUser = getUsuario(altJid);
        if (altUser && altUser.activo) {
            if (altUser.fecha_expira) {
                const expira = new Date(altUser.fecha_expira);
                if (Date.now() > expira.getTime()) {
                    db.prepare("UPDATE usuarios SET activo = 0, plan = 'expirado' WHERE wsp_id = ?").run(altJid);
                    return false;
                }
            }
            crearUsuario(wspId, user ? user.nombre : "");
            db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(altUser.plan, altUser.fecha_expira, wspId);
            return true;
        }
    }
    return false;
}

function getTodosUsuarios() {
    return db.prepare("SELECT * FROM usuarios ORDER BY fecha_registro DESC").all();
}

// --- SESIONES / CUENTAS ---
function getSesiones(userId) {
    return db.prepare("SELECT * FROM sesiones WHERE user_id = ? AND activa = 1").all(userId);
}

function agregarSesion(userId, nombre, telefono) {
    const existente = db.prepare("SELECT id FROM sesiones WHERE user_id = ? AND nombre = ? AND activa = 1").get(userId, nombre);
    if (existente) {
        db.prepare("UPDATE sesiones SET telefono = ? WHERE user_id = ? AND nombre = ? AND activa = 1").run(telefono, userId, nombre);
    } else {
        db.prepare("INSERT INTO sesiones (user_id, nombre, telefono) VALUES (?, ?, ?)").run(userId, nombre, telefono);
    }
}

function eliminarSesion(userId, nombre) {
    db.prepare("DELETE FROM sesiones WHERE user_id = ? AND nombre = ?").run(userId, nombre);
    db.prepare("DELETE FROM campana_sesiones WHERE sesion_nombre = ?").run(nombre);
}

// --- GRUPOS ---
function getGrupos(userId) {
    return db.prepare("SELECT * FROM grupos WHERE user_id = ?").all(userId);
}

function agregarGrupo(userId, link, nombre = null) {
    const existente = db.prepare("SELECT id, nombre FROM grupos WHERE user_id = ? AND link = ?").get(userId, link);
    if (!existente) {
        db.prepare("INSERT INTO grupos (user_id, link, nombre) VALUES (?, ?, ?)").run(userId, link, nombre);
        return true;
    } else if (nombre && !existente.nombre) {
        db.prepare("UPDATE grupos SET nombre = ? WHERE id = ?").run(nombre, existente.id);
    }
    return false;
}

function eliminarGrupo(userId, grupoId) {
    const grupo = db.prepare("SELECT link FROM grupos WHERE id = ? AND user_id = ?").get(grupoId, userId);
    if (grupo) {
        db.prepare("DELETE FROM campana_grupos WHERE grupo_link = ?").run(grupo.link);
    }
    db.prepare("DELETE FROM grupos WHERE id = ? AND user_id = ?").run(grupoId, userId);
}

// Eliminar grupo por link (para auto-limpieza cuando falla el envio)
function eliminarGrupoPorLink(userId, link) {
    db.prepare("DELETE FROM campana_grupos WHERE grupo_link = ?").run(link);
    db.prepare("DELETE FROM grupos WHERE user_id = ? AND link = ?").run(userId, link);
}

function eliminarTodosGrupos(userId) {
    const grupos = getGrupos(userId);
    for (const g of grupos) {
        db.prepare("DELETE FROM campana_grupos WHERE grupo_link = ?").run(g.link);
    }
    db.prepare("DELETE FROM grupos WHERE user_id = ?").run(userId);
}

function actualizarGrupoLink(userId, grupoId, nuevoLink) {
    const grupo = db.prepare("SELECT link FROM grupos WHERE id = ? AND user_id = ?").get(grupoId, userId);
    if (grupo) {
        db.prepare("UPDATE campana_grupos SET grupo_link = ? WHERE grupo_link = ?").run(nuevoLink, grupo.link);
    }
    db.prepare("UPDATE grupos SET link = ? WHERE id = ? AND user_id = ?").run(nuevoLink, grupoId, userId);
}

// --- CAMPANAS ---
function getCampanas(userId) {
    return db.prepare("SELECT * FROM campanas WHERE user_id = ?").all(userId);
}

function crearCampana(userId, nombre, mensaje, imagenPath = null) {
    const result = db.prepare("INSERT INTO campanas (user_id, nombre, mensaje, imagen_path) VALUES (?, ?, ?, ?)").run(userId, nombre, mensaje, imagenPath);
    return result.lastInsertRowid;
}

function getCampanaById(campanaId) {
    return db.prepare("SELECT * FROM campanas WHERE id = ?").get(campanaId);
}

function actualizarStatsCampana(campanaId, enviados, errores) {
    db.prepare("UPDATE campanas SET enviados = enviados + ?, errores = errores + ? WHERE id = ?").run(enviados, errores, campanaId);
}

function setCampanaActiva(campanaId, activa) {
    if (activa) {
        const inicio = nowPeru();
        db.prepare("UPDATE campanas SET activa = 1, inicio = ? WHERE id = ?").run(inicio, campanaId);
    } else {
        db.prepare("UPDATE campanas SET activa = 0 WHERE id = ?").run(campanaId);
    }
}

function actualizarCampanaMensaje(campanaId, mensaje, imagenPath) {
    if (imagenPath) {
        db.prepare("UPDATE campanas SET mensaje = ?, imagen_path = ? WHERE id = ?").run(mensaje, imagenPath, campanaId);
    } else {
        db.prepare("UPDATE campanas SET mensaje = ? WHERE id = ?").run(mensaje, campanaId);
    }
}

function eliminarCampana(campanaId) {
    // Eliminar tablas hijas ANTES de la tabla padre (foreign keys)
    db.prepare("DELETE FROM campana_grupos WHERE campana_id = ?").run(campanaId);
    db.prepare("DELETE FROM campana_sesiones WHERE campana_id = ?").run(campanaId);
    db.prepare("DELETE FROM campana_config WHERE campana_id = ?").run(campanaId);
    db.prepare("DELETE FROM campana_horario WHERE campana_id = ?").run(campanaId);
    db.prepare("DELETE FROM campanas WHERE id = ?").run(campanaId);
}

function clonarCampana(userId, campanaId, nuevoNombre) {
    const original = getCampanaById(campanaId);
    if (!original) return null;
    const nuevoId = crearCampana(userId, nuevoNombre, original.mensaje, original.imagen_path);
    const sesiones = getSesionesCampana(campanaId);
    for (const s of sesiones) agregarSesionCampana(nuevoId, s);
    const grupos = getGruposCampana(campanaId);
    for (const g of grupos) agregarGrupoCampana(nuevoId, g);
    const conf = getCampanaConfig(campanaId);
    setCampanaConfig(nuevoId, conf.intervalo_min, conf.intervalo_max);
    return nuevoId;
}

function resetearStatsCampana(campanaId) {
    db.prepare("UPDATE campanas SET enviados = 0, errores = 0 WHERE id = ?").run(campanaId);
}

// --- CAMPANA <-> SESIONES ---
function getSesionesCampana(campanaId) {
    return db.prepare("SELECT sesion_nombre FROM campana_sesiones WHERE campana_id = ?").all(campanaId).map(r => r.sesion_nombre);
}

function agregarSesionCampana(campanaId, sesionNombre) {
    db.prepare("INSERT OR IGNORE INTO campana_sesiones (campana_id, sesion_nombre) VALUES (?, ?)").run(campanaId, sesionNombre);
}

// --- CAMPANA <-> GRUPOS ---
function getGruposCampana(campanaId) {
    return db.prepare("SELECT grupo_link FROM campana_grupos WHERE campana_id = ?").all(campanaId).map(r => r.grupo_link);
}

function agregarGrupoCampana(campanaId, grupoLink) {
    db.prepare("INSERT OR IGNORE INTO campana_grupos (campana_id, grupo_link) VALUES (?, ?)").run(campanaId, grupoLink);
}

// Eliminar grupo de campana (para auto-limpieza)
function eliminarGrupoCampana(campanaId, grupoLink) {
    db.prepare("DELETE FROM campana_grupos WHERE campana_id = ? AND grupo_link = ?").run(campanaId, grupoLink);
}

// --- CONFIG CAMPANA ---
function getCampanaConfig(campanaId) {
    const row = db.prepare("SELECT * FROM campana_config WHERE campana_id = ?").get(campanaId);
    return row || { intervalo_min: 30, intervalo_max: 60, espera_cuenta: 300, espera_ciclo: 600 };
}

function setCampanaConfig(campanaId, min, max, esperaCuenta, esperaCiclo) {
    const ec = esperaCuenta !== undefined ? esperaCuenta : 300;
    const eciclo = esperaCiclo !== undefined ? esperaCiclo : 600;
    db.prepare("INSERT OR REPLACE INTO campana_config (campana_id, intervalo_min, intervalo_max, espera_cuenta, espera_ciclo) VALUES (?, ?, ?, ?, ?)").run(campanaId, min, max, ec, eciclo);
}

// --- LIMITES ---
function getMaxGrupos(userId) {
    const row = db.prepare("SELECT max_grupos FROM limites_usuario WHERE user_id = ?").get(userId);
    return row ? row.max_grupos : config.MAX_GRUPOS_POR_USUARIO;
}

function setMaxGrupos(userId, limite) {
    db.prepare("INSERT OR REPLACE INTO limites_usuario (user_id, max_grupos) VALUES (?, ?)").run(userId, limite);
}

// --- RESPONDER ---
function getResponderConfig(userId) {
    return db.prepare("SELECT * FROM responder_config WHERE user_id = ?").get(userId);
}

function setResponderConfig(userId, contacto, activo = 1) {
    const existing = getResponderConfig(userId);
    if (existing) {
        db.prepare("UPDATE responder_config SET contacto = ?, activo = ? WHERE user_id = ?").run(contacto, activo, userId);
    } else {
        db.prepare("INSERT INTO responder_config (user_id, contacto, activo) VALUES (?, ?, ?)").run(userId, contacto, activo);
    }
}

function toggleResponder(userId, activo) {
    db.prepare("UPDATE responder_config SET activo = ? WHERE user_id = ?").run(activo, userId);
}

function getKeywords(userId) {
    return db.prepare("SELECT palabra FROM responder_keywords WHERE user_id = ?").all(userId).map(r => r.palabra);
}

function agregarKeywords(userId, palabras) {
    const stmt = db.prepare("INSERT OR IGNORE INTO responder_keywords (user_id, palabra) VALUES (?, ?)");
    for (const p of palabras) {
        const word = p.trim().toLowerCase();
        if (word) stmt.run(userId, word);
    }
}

function limpiarKeywords(userId) {
    db.prepare("DELETE FROM responder_keywords WHERE user_id = ?").run(userId);
}

// --- HISTORIAL ---
function registrarEnvio(userId, campanaId, grupoLink, resultado = "enviado") {
    db.prepare("INSERT INTO historial_envios (user_id, campana_id, grupo_link, resultado) VALUES (?, ?, ?, ?)").run(userId, campanaId, grupoLink, resultado);
}

function registrarRespuesta(userId, grupoLink, keyword) {
    db.prepare("INSERT INTO historial_respuestas (user_id, grupo_link, keyword) VALUES (?, ?, ?)").run(userId, grupoLink, keyword);
}

function getHistorialEnvios(userId, limite = 50) {
    return db.prepare("SELECT grupo_link, resultado, fecha FROM historial_envios WHERE user_id = ? ORDER BY fecha DESC LIMIT ?").all(userId, limite);
}

function getStatsPorGrupo(userId) {
    return db.prepare(`
        SELECT grupo_link,
        SUM(CASE WHEN resultado='enviado' THEN 1 ELSE 0 END) as enviados,
        SUM(CASE WHEN resultado!='enviado' THEN 1 ELSE 0 END) as errores,
        MAX(fecha) as ultimo_envio
        FROM historial_envios WHERE user_id = ?
        GROUP BY grupo_link ORDER BY enviados DESC
    `).all(userId);
}

function getStatsRespuestas(userId) {
    return db.prepare(`
        SELECT keyword, COUNT(*) as total, MAX(fecha) as ultima
        FROM historial_respuestas WHERE user_id = ?
        GROUP BY keyword ORDER BY total DESC
    `).all(userId);
}

function getStatsRespuestasPorGrupo(userId) {
    return db.prepare(`
        SELECT grupo_link, COUNT(*) as total, MAX(fecha) as ultima
        FROM historial_respuestas WHERE user_id = ?
        GROUP BY grupo_link ORDER BY total DESC
    `).all(userId);
}

function limpiarHistorial(userId) {
    db.prepare("DELETE FROM historial_envios WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM historial_respuestas WHERE user_id = ?").run(userId);
}

function getDashboard(userId) {
    const sesiones = getSesiones(userId);
    const grupos = getGrupos(userId);
    const campanas = getCampanas(userId);
    const conf = getResponderConfig(userId);
    const keywords = getKeywords(userId);
    let totalEnviados = 0, totalErrores = 0, activas = 0;
    for (const c of campanas) {
        totalEnviados += c.enviados;
        totalErrores += c.errores;
        if (c.activa) activas++;
    }
    return {
        cuentas: sesiones.length,
        grupos: grupos.length,
        campanas: campanas.length,
        campanasActivas: activas,
        totalEnviados,
        totalErrores,
        responderActivo: !!(conf && conf.activo),
        keywords: keywords.length,
    };
}

// --- TEMPLATES ---
function getTemplates(userId) {
    return db.prepare("SELECT * FROM templates WHERE user_id = ?").all(userId);
}

function agregarTemplate(userId, nombre, mensaje, imagenPath = null) {
    return db.prepare("INSERT INTO templates (user_id, nombre, mensaje, imagen_path) VALUES (?, ?, ?, ?)").run(userId, nombre, mensaje, imagenPath).lastInsertRowid;
}

function getTemplateById(templateId) {
    return db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId);
}

function eliminarTemplate(templateId) {
    db.prepare("DELETE FROM templates WHERE id = ?").run(templateId);
}

// --- BLACKLIST ---
function getBlacklist(userId) {
    return db.prepare("SELECT * FROM blacklist WHERE user_id = ?").all(userId);
}

function agregarBlacklist(userId, grupoLink, razon = "") {
    db.prepare("INSERT OR IGNORE INTO blacklist (user_id, grupo_link, razon) VALUES (?, ?, ?)").run(userId, grupoLink, razon);
}

function eliminarBlacklist(userId, grupoLink) {
    db.prepare("DELETE FROM blacklist WHERE user_id = ? AND grupo_link = ?").run(userId, grupoLink);
}

function eliminarBlacklistById(blId) {
    db.prepare("DELETE FROM blacklist WHERE id = ?").run(blId);
}

function estaEnBlacklist(userId, grupoLink) {
    return !!db.prepare("SELECT 1 FROM blacklist WHERE user_id = ? AND grupo_link = ?").get(userId, grupoLink);
}

function limpiarBlacklist(userId) {
    db.prepare("DELETE FROM blacklist WHERE user_id = ?").run(userId);
}

// --- GRUPO STATS ---
function actualizarGrupoStats(userId, grupoLink, tipo) {
    const existing = db.prepare("SELECT * FROM grupo_stats WHERE user_id = ? AND grupo_link = ?").get(userId, grupoLink);
    const now = nowPeru();
    if (!existing) {
        const env = tipo === "enviado" ? 1 : 0;
        const fal = tipo === "fallido" ? 1 : 0;
        const pen = tipo === "pending" ? 1 : 0;
        db.prepare("INSERT INTO grupo_stats (user_id, grupo_link, enviados, fallidos, pending, ultima_fecha) VALUES (?, ?, ?, ?, ?, ?)").run(userId, grupoLink, env, fal, pen, now);
    } else {
        if (tipo === "enviado") {
            db.prepare("UPDATE grupo_stats SET enviados = enviados + 1, ultima_fecha = ? WHERE user_id = ? AND grupo_link = ?").run(now, userId, grupoLink);
        } else if (tipo === "fallido") {
            db.prepare("UPDATE grupo_stats SET fallidos = fallidos + 1, ultima_fecha = ? WHERE user_id = ? AND grupo_link = ?").run(now, userId, grupoLink);
        } else if (tipo === "pending") {
            db.prepare("UPDATE grupo_stats SET pending = pending + 1, ultima_fecha = ? WHERE user_id = ? AND grupo_link = ?").run(now, userId, grupoLink);
        }
    }
}

function getGrupoStats(userId) {
    return db.prepare("SELECT * FROM grupo_stats WHERE user_id = ? ORDER BY enviados DESC").all(userId);
}

function getGrupoStatsTop(userId, limit = 10) {
    return db.prepare("SELECT *, CASE WHEN (enviados + fallidos + pending) > 0 THEN ROUND(enviados * 100.0 / (enviados + fallidos + pending), 1) ELSE 0 END as tasa_exito FROM grupo_stats WHERE user_id = ? ORDER BY tasa_exito DESC LIMIT ?").all(userId, limit);
}

function getGrupoStatsWorst(userId, limit = 10) {
    return db.prepare("SELECT *, CASE WHEN (enviados + fallidos + pending) > 0 THEN ROUND(enviados * 100.0 / (enviados + fallidos + pending), 1) ELSE 0 END as tasa_exito FROM grupo_stats WHERE user_id = ? AND (fallidos + pending) > 0 ORDER BY tasa_exito ASC LIMIT ?").all(userId, limit);
}

// --- CAMPANA HORARIO ---
function getCampanaHorario(campanaId) {
    const row = db.prepare("SELECT * FROM campana_horario WHERE campana_id = ?").get(campanaId);
    return row || { hora_inicio: 0, hora_fin: 24 };
}

function setCampanaHorario(campanaId, horaInicio, horaFin) {
    db.prepare("INSERT OR REPLACE INTO campana_horario (campana_id, hora_inicio, hora_fin) VALUES (?, ?, ?)").run(campanaId, horaInicio, horaFin);
}

// --- ENVIOS DIARIOS ---
function getEnviosDiarios(userId, cuentaNombre) {
    const hoy = hoyPeru();
    const row = db.prepare("SELECT total FROM envios_diarios WHERE user_id = ? AND cuenta_nombre = ? AND fecha = ?").get(userId, cuentaNombre, hoy);
    return row ? row.total : 0;
}

function incrementarEnvioDiario(userId, cuentaNombre) {
    const hoy = hoyPeru();
    const existing = db.prepare("SELECT total FROM envios_diarios WHERE user_id = ? AND cuenta_nombre = ? AND fecha = ?").get(userId, cuentaNombre, hoy);
    if (existing) {
        db.prepare("UPDATE envios_diarios SET total = total + 1 WHERE user_id = ? AND cuenta_nombre = ? AND fecha = ?").run(userId, cuentaNombre, hoy);
    } else {
        db.prepare("INSERT INTO envios_diarios (user_id, cuenta_nombre, fecha, total) VALUES (?, ?, ?, 1)").run(userId, cuentaNombre, hoy);
    }
}

function getEnviosDiariosTotal(userId) {
    const hoy = hoyPeru();
    const rows = db.prepare("SELECT cuenta_nombre, total FROM envios_diarios WHERE user_id = ? AND fecha = ?").all(userId, hoy);
    return rows;
}

// --- CUENTA ESTADO (ban detection) ---
function getCuentaEstado(userId, cuentaNombre) {
    return db.prepare("SELECT * FROM cuenta_estado WHERE user_id = ? AND cuenta_nombre = ?").get(userId, cuentaNombre);
}

function marcarCuentaBaneada(userId, cuentaNombre) {
    const now = nowPeru();
    db.prepare("INSERT OR REPLACE INTO cuenta_estado (user_id, cuenta_nombre, baneada, fecha_ban) VALUES (?, ?, 1, ?)").run(userId, cuentaNombre, now);
}

function desmarcarCuentaBaneada(userId, cuentaNombre) {
    db.prepare("DELETE FROM cuenta_estado WHERE user_id = ? AND cuenta_nombre = ?").run(userId, cuentaNombre);
}

function getCuentasBaneadas(userId) {
    return db.prepare("SELECT * FROM cuenta_estado WHERE user_id = ? AND baneada = 1").all(userId);
}

// --- SINONIMOS (variacion de mensajes) ---
function getSinonimos(userId) {
    return db.prepare("SELECT * FROM sinonimos WHERE user_id = ?").all(userId);
}

function agregarSinonimo(userId, palabra, alternativas) {
    db.prepare("INSERT INTO sinonimos (user_id, palabra, alternativas) VALUES (?, ?, ?)").run(userId, palabra, alternativas);
}

function eliminarSinonimo(sinonimoId) {
    db.prepare("DELETE FROM sinonimos WHERE id = ?").run(sinonimoId);
}

function limpiarSinonimos(userId) {
    db.prepare("DELETE FROM sinonimos WHERE user_id = ?").run(userId);
}

// --- REPORTE DIARIO ---
function getReporteDiario(userId) {
    const hoy = hoyPeru();
    const envios = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN resultado='enviado' THEN 1 ELSE 0 END) as exitosos FROM historial_envios WHERE user_id = ? AND fecha LIKE ?").get(userId, hoy + "%");
    const respuestas = db.prepare("SELECT COUNT(*) as total FROM historial_respuestas WHERE user_id = ? AND fecha LIKE ?").get(userId, hoy + "%");
    const cuentasEnvios = db.prepare("SELECT cuenta_nombre, total FROM envios_diarios WHERE user_id = ? AND fecha = ?").all(userId, hoy);
    return {
        totalEnvios: envios?.total || 0,
        exitosos: envios?.exitosos || 0,
        fallidos: (envios?.total || 0) - (envios?.exitosos || 0),
        respuestas: respuestas?.total || 0,
        porCuenta: cuentasEnvios,
    };
}

// --- EXPORTAR/IMPORTAR ---
function exportarGrupos(userId) {
    return db.prepare("SELECT link, nombre FROM grupos WHERE user_id = ?").all(userId);
}

function importarGrupos(userId, grupos) {
    let added = 0;
    for (const g of grupos) {
        if (agregarGrupo(userId, g.link, g.nombre || null)) added++;
    }
    return added;
}

function exportarCampanas(userId) {
    const campanas = getCampanas(userId);
    const result = [];
    for (const c of campanas) {
        const sesiones = getSesionesCampana(c.id);
        const grupos = getGruposCampana(c.id);
        const conf = getCampanaConfig(c.id);
        const horario = getCampanaHorario(c.id);
        result.push({ ...c, sesiones, grupos, config: conf, horario });
    }
    return result;
}

function getDb() { return db; }

module.exports = {
    init, getDb, setBotJid, setAdminJids, getUsuario, getUsuarioByCodigo, findUserByNumber, getAllJidsForNumber,
    crearUsuario, generarCodigo, activarMembresia, activarMembresiaByNumber,
    activarMembresiaByCodigo, desactivarByCodigo, banByCodigo,
    desactivarByNumber, banByNumber,
    tieneMembresia, getTodosUsuarios,
    getSesiones, agregarSesion, eliminarSesion,
    getGrupos, agregarGrupo, eliminarGrupo, eliminarGrupoPorLink, eliminarTodosGrupos, actualizarGrupoLink,
    getCampanas, crearCampana, getCampanaById, actualizarStatsCampana,
    setCampanaActiva, actualizarCampanaMensaje, eliminarCampana, clonarCampana, resetearStatsCampana,
    getSesionesCampana, agregarSesionCampana, getGruposCampana, agregarGrupoCampana, eliminarGrupoCampana,
    getCampanaConfig, setCampanaConfig,
    getMaxGrupos, setMaxGrupos,
    getResponderConfig, setResponderConfig, toggleResponder, getKeywords, agregarKeywords, limpiarKeywords,
    registrarEnvio, registrarRespuesta, getHistorialEnvios,
    getStatsPorGrupo, getStatsRespuestas, getStatsRespuestasPorGrupo,
    limpiarHistorial, getDashboard,
    // Nuevas funciones
    getTemplates, agregarTemplate, getTemplateById, eliminarTemplate,
    getBlacklist, agregarBlacklist, eliminarBlacklist, eliminarBlacklistById, estaEnBlacklist, limpiarBlacklist,
    actualizarGrupoStats, getGrupoStats, getGrupoStatsTop, getGrupoStatsWorst,
    getCampanaHorario, setCampanaHorario,
    getEnviosDiarios, incrementarEnvioDiario, getEnviosDiariosTotal,
    getCuentaEstado, marcarCuentaBaneada, desmarcarCuentaBaneada, getCuentasBaneadas,
    getSinonimos, agregarSinonimo, eliminarSinonimo, limpiarSinonimos,
    getReporteDiario,
    exportarGrupos, importarGrupos, exportarCampanas,
};
