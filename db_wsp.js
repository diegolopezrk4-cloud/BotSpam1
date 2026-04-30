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
        CREATE TABLE IF NOT EXISTS panel_users (
            telegram_id TEXT PRIMARY KEY,
            username TEXT DEFAULT '',
            password TEXT,
            fecha_registro TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS recovery_codes (
            telegram_id TEXT NOT NULL,
            code TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS user_envio_config (
            user_id TEXT PRIMARY KEY,
            delay_seg INTEGER DEFAULT 10,
            lote_tamano INTEGER DEFAULT 0,
            lote_pausa_seg INTEGER DEFAULT 30,
            hora_inicio INTEGER DEFAULT 0,
            hora_fin INTEGER DEFAULT 24
        );
        CREATE TABLE IF NOT EXISTS programados_wsp (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            mensaje_id INTEGER,
            hora TEXT,
            repetir INTEGER DEFAULT 0,
            activo INTEGER DEFAULT 1,
            fecha TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS auto_respuestas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            palabra TEXT,
            respuesta TEXT,
            fecha TEXT DEFAULT (datetime('now'))
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
    // Migración: es_admin, tipo_membresia, username
    try {
        db.prepare("SELECT es_admin FROM usuarios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE usuarios ADD COLUMN es_admin INTEGER DEFAULT 0");
        console.log("   Columna 'es_admin' agregada a usuarios");
    }
    try {
        db.prepare("SELECT tipo_membresia FROM usuarios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE usuarios ADD COLUMN tipo_membresia TEXT DEFAULT 'wsp+tg'");
        console.log("   Columna 'tipo_membresia' agregada a usuarios");
    }
    try {
        db.prepare("SELECT username FROM usuarios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE usuarios ADD COLUMN username TEXT DEFAULT ''");
        console.log("   Columna 'username' agregada a usuarios");
    }
    // Migración: recrear recovery_codes sin columna 'used'
    try {
        db.prepare("SELECT used FROM recovery_codes LIMIT 1").get();
        db.exec("DROP TABLE recovery_codes");
        db.exec("CREATE TABLE IF NOT EXISTS recovery_codes (telegram_id TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))");
        console.log("   Tabla 'recovery_codes' recreada (sin columna 'used')");
    } catch (e) {}
    // Migración: seccion y size en grupos
    try {
        db.prepare("SELECT seccion FROM grupos LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE grupos ADD COLUMN seccion TEXT DEFAULT ''");
        console.log("   Columna 'seccion' agregada a grupos");
    }
    try {
        db.prepare("SELECT size FROM grupos LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE grupos ADD COLUMN size INTEGER DEFAULT 0");
        console.log("   Columna 'size' agregada a grupos");
    }
    // Migración: grupo_nombre en historial_envios
    try {
        db.prepare("SELECT grupo_nombre FROM historial_envios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE historial_envios ADD COLUMN grupo_nombre TEXT DEFAULT NULL");
        console.log("   Columna 'grupo_nombre' agregada a historial_envios");
    }
    // Tabla para progreso de envíos (resume)
    db.exec(`
        CREATE TABLE IF NOT EXISTS envio_progreso (
            user_id TEXT,
            grupo_jid TEXT,
            ultimo_indice INTEGER DEFAULT 0,
            total INTEGER DEFAULT 0,
            mensaje TEXT,
            jids_json TEXT,
            grupo_nombre TEXT,
            fecha TEXT DEFAULT (datetime('now')),
            PRIMARY KEY(user_id, grupo_jid)
        );
    `);
    // Table for tracking campaign sends per group (anti-duplicate across restarts)
    db.exec(`
        CREATE TABLE IF NOT EXISTS campana_grupo_envio (
            campana_id INTEGER,
            grupo_jid TEXT,
            ultimo_envio TEXT DEFAULT (datetime('now')),
            PRIMARY KEY(campana_id, grupo_jid)
        );
    `);
    // Blacklist for individual numbers (not just groups)
    db.exec(`
        CREATE TABLE IF NOT EXISTS blacklist_numeros (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            numero TEXT,
            razon TEXT DEFAULT '',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id),
            UNIQUE(user_id, numero)
        );
    `);
    // Scheduled member sends
    db.exec(`
        CREATE TABLE IF NOT EXISTS programado_miembros (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            grupo_jid TEXT,
            grupo_nombre TEXT,
            mensaje TEXT,
            imagen_path TEXT DEFAULT NULL,
            cuenta TEXT,
            country_code TEXT DEFAULT NULL,
            admin_filter TEXT DEFAULT NULL,
            batch_size INTEGER DEFAULT 0,
            delay_minutes INTEGER DEFAULT 5,
            hora_envio TEXT,
            dias_semana TEXT DEFAULT '0,1,2,3,4,5,6',
            activo INTEGER DEFAULT 1,
            ultimo_envio TEXT DEFAULT NULL,
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
    `);
    // Migration: tipo_envio column in historial_envios
    try {
        db.prepare("SELECT tipo_envio FROM historial_envios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE historial_envios ADD COLUMN tipo_envio TEXT DEFAULT 'grupo'");
        db.exec("UPDATE historial_envios SET tipo_envio = 'personal' WHERE resultado IN ('enviado_personal', 'error_personal')");
        console.log("   Columna 'tipo_envio' agregada a historial_envios");
    }
    // Migration: estado_entrega column for delivery tracking
    try {
        db.prepare("SELECT estado_entrega FROM historial_envios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE historial_envios ADD COLUMN estado_entrega TEXT DEFAULT NULL");
        console.log("   Columna 'estado_entrega' agregada a historial_envios");
    }
    // Migration: mensaje_preview column
    try {
        db.prepare("SELECT mensaje_preview FROM historial_envios LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE historial_envios ADD COLUMN mensaje_preview TEXT DEFAULT NULL");
        console.log("   Columna 'mensaje_preview' agregada a historial_envios");
    }
    // Add qr_imagen column to metodos_pago if it doesn't exist
    try {
        db.prepare("SELECT qr_imagen FROM metodos_pago LIMIT 1").get();
    } catch (e) {
        db.exec("ALTER TABLE metodos_pago ADD COLUMN qr_imagen TEXT DEFAULT ''");
        console.log("   Columna 'qr_imagen' agregada a metodos_pago");
    }
    // Table for manually added personal numbers
    db.exec(`
        CREATE TABLE IF NOT EXISTS numeros_manuales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            cuenta TEXT,
            numero TEXT,
            jid TEXT,
            nombre TEXT DEFAULT '',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id),
            UNIQUE(user_id, cuenta, numero)
        );
    `);
    // Table for promo/interactive listening
    db.exec(`
        CREATE TABLE IF NOT EXISTS promo_escucha (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            palabra_aceptar TEXT DEFAULT 'si',
            palabra_rechazar TEXT DEFAULT 'no',
            respuesta_aceptar TEXT DEFAULT '',
            respuesta_rechazar TEXT DEFAULT '',
            activo INTEGER DEFAULT 1,
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id),
            UNIQUE(user_id)
        );
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS promo_respuestas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            jid TEXT,
            numero TEXT,
            nombre TEXT DEFAULT '',
            tipo TEXT DEFAULT 'aceptado',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
    `);
    // Table for promo templates (plantillas de promocion)
    db.exec(`
        CREATE TABLE IF NOT EXISTS promo_plantillas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            nombre TEXT,
            palabra_aceptar TEXT DEFAULT 'si',
            palabra_rechazar TEXT DEFAULT 'no',
            respuesta_aceptar TEXT DEFAULT '',
            respuesta_rechazar TEXT DEFAULT '',
            respuesta_aceptar_img TEXT DEFAULT '',
            respuesta_rechazar_img TEXT DEFAULT '',
            timeout_horas INTEGER DEFAULT 24,
            recordatorio INTEGER DEFAULT 0,
            msg_recordatorio TEXT DEFAULT '',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
    `);
    // Table for retry queue (Mejora 4)
    db.exec(`
        CREATE TABLE IF NOT EXISTS retry_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            jid TEXT,
            mensaje TEXT,
            imagen_path TEXT DEFAULT NULL,
            intentos INTEGER DEFAULT 0,
            max_intentos INTEGER DEFAULT 3,
            proximo_intento TEXT DEFAULT (datetime('now', '+5 minutes')),
            estado TEXT DEFAULT 'pendiente',
            error TEXT DEFAULT '',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
    `);
    // Table for promo timeout config (Mejora 3)
    db.exec(`
        CREATE TABLE IF NOT EXISTS promo_timeout (
            user_id TEXT PRIMARY KEY,
            timeout_horas INTEGER DEFAULT 24,
            recordatorio_activo INTEGER DEFAULT 0,
            mensaje_recordatorio TEXT DEFAULT '',
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
    `);
    // Table for multi-keyword promo responses (Mejora 7)
    db.exec(`
        CREATE TABLE IF NOT EXISTS promo_keywords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            palabra TEXT,
            respuesta_texto TEXT DEFAULT '',
            respuesta_imagen TEXT DEFAULT NULL,
            tipo TEXT DEFAULT 'aceptar',
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES usuarios(wsp_id)
        );
    `);
    // Table for activity logs (Mejora 6)
    db.exec(`
        CREATE TABLE IF NOT EXISTS bot_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            tipo TEXT DEFAULT 'info',
            mensaje TEXT,
            fecha TEXT DEFAULT (datetime('now'))
        );
    `);
    // Cache of groups per session
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_grupos_cache (
            user_id TEXT,
            sesion_nombre TEXT,
            grupo_jid TEXT,
            subject TEXT,
            size INTEGER DEFAULT 0,
            es_admin INTEGER DEFAULT 0,
            can_post INTEGER DEFAULT 1,
            announce INTEGER DEFAULT 0,
            fecha_cache TEXT DEFAULT (datetime('now')),
            PRIMARY KEY(user_id, sesion_nombre, grupo_jid)
        );
    `);
    // --- 2FA ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_2fa (
            telegram_id TEXT PRIMARY KEY,
            secret TEXT NOT NULL,
            enabled INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);
    // --- ACTIVE SESSIONS ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS active_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id TEXT NOT NULL,
            token TEXT NOT NULL,
            ip TEXT,
            user_agent TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            last_active TEXT DEFAULT (datetime('now'))
        );
    `);
    // --- ENVIOS SEMANALES (weekly stats cache) ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS envios_semanales (
            user_id TEXT,
            semana TEXT,
            total INTEGER DEFAULT 0,
            exitosos INTEGER DEFAULT 0,
            fallidos INTEGER DEFAULT 0,
            PRIMARY KEY(user_id, semana)
        );
    `);
    // --- SELLERS (Revendedores) ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS sellers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id TEXT NOT NULL UNIQUE,
            nombre TEXT DEFAULT '',
            max_invites INTEGER DEFAULT 10,
            periodo TEXT DEFAULT 'semanal',
            plan_dias INTEGER DEFAULT 7,
            plan_tipo TEXT DEFAULT 'semanal',
            activo INTEGER DEFAULT 1,
            fecha_creado TEXT DEFAULT (datetime('now'))
        );
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS seller_invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seller_id INTEGER NOT NULL,
            invitado_telegram_id TEXT NOT NULL,
            plan_dias INTEGER DEFAULT 7,
            plan_tipo TEXT DEFAULT 'semanal',
            fecha_invitacion TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(seller_id) REFERENCES sellers(id)
        );
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS seller_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seller_id INTEGER NOT NULL,
            codigo TEXT NOT NULL UNIQUE,
            plan_dias INTEGER DEFAULT 7,
            plan_tipo TEXT DEFAULT 'semanal',
            usado INTEGER DEFAULT 0,
            usado_por TEXT DEFAULT NULL,
            fecha_creado TEXT DEFAULT (datetime('now')),
            fecha_usado TEXT DEFAULT NULL,
            FOREIGN KEY(seller_id) REFERENCES sellers(id)
        );
    `);
    // --- LOGIN ATTEMPTS (rate limiting) ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS login_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT NOT NULL,
            telegram_id TEXT DEFAULT '',
            success INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);
    // --- AUDIT LOG ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            accion TEXT NOT NULL,
            detalle TEXT DEFAULT '',
            ip TEXT DEFAULT '',
            fecha TEXT DEFAULT (datetime('now'))
        );
    `);
    // --- GRUPO ACTIVIDAD (persistencia anti-duplicado) ---
    db.exec(`
        CREATE TABLE IF NOT EXISTS grupo_actividad (
            grupo_jid TEXT PRIMARY KEY,
            ultima_actividad TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS pagos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            merchant_trade_no TEXT UNIQUE NOT NULL,
            prepay_id TEXT DEFAULT NULL,
            plan_key TEXT NOT NULL,
            plan_dias INTEGER NOT NULL,
            monto_usdt REAL NOT NULL,
            currency TEXT DEFAULT 'USDT',
            estado TEXT DEFAULT 'pending',
            binance_transaction_id TEXT DEFAULT NULL,
            checkout_url TEXT DEFAULT NULL,
            qrcode_url TEXT DEFAULT NULL,
            universal_url TEXT DEFAULT NULL,
            deep_link TEXT DEFAULT NULL,
            pass_through_info TEXT DEFAULT NULL,
            fecha_creado TEXT DEFAULT (datetime('now')),
            fecha_pagado TEXT DEFAULT NULL,
            fecha_expirado TEXT DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pagos_user ON pagos(user_id);
        CREATE INDEX IF NOT EXISTS idx_pagos_merchant ON pagos(merchant_trade_no);
        CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos(estado);

        CREATE TABLE IF NOT EXISTS comprobantes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            plan_key TEXT NOT NULL,
            plan_dias INTEGER NOT NULL,
            metodo_pago TEXT NOT NULL DEFAULT 'yape',
            monto TEXT DEFAULT '',
            imagen_path TEXT DEFAULT NULL,
            nota_cliente TEXT DEFAULT '',
            estado TEXT DEFAULT 'pendiente',
            admin_nota TEXT DEFAULT '',
            revisado_por TEXT DEFAULT NULL,
            fecha_creado TEXT DEFAULT (datetime('now')),
            fecha_revisado TEXT DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_comprobantes_user ON comprobantes(user_id);
        CREATE INDEX IF NOT EXISTS idx_comprobantes_estado ON comprobantes(estado);

        CREATE TABLE IF NOT EXISTS metodos_pago (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT NOT NULL,
            nombre TEXT NOT NULL,
            valor TEXT NOT NULL,
            instrucciones TEXT DEFAULT '',
            activo INTEGER DEFAULT 1,
            orden INTEGER DEFAULT 0,
            qr_imagen TEXT DEFAULT ''
        );

        -- Push subscriptions (Web Push)
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

        -- Tickets de soporte
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            asunto TEXT NOT NULL,
            estado TEXT DEFAULT 'abierto',
            prioridad TEXT DEFAULT 'normal',
            fecha_creado TEXT DEFAULT (datetime('now')),
            fecha_cerrado TEXT DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_estado ON tickets(estado);

        CREATE TABLE IF NOT EXISTS ticket_mensajes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER NOT NULL,
            autor_id TEXT NOT NULL,
            es_admin INTEGER DEFAULT 0,
            mensaje TEXT NOT NULL,
            fecha TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(ticket_id) REFERENCES tickets(id)
        );

        -- Webhooks de eventos
        CREATE TABLE IF NOT EXISTS user_webhooks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            url TEXT NOT NULL,
            eventos TEXT DEFAULT 'all',
            activo INTEGER DEFAULT 1,
            secret TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- Backups automaticos
        CREATE TABLE IF NOT EXISTS backup_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            size_bytes INTEGER DEFAULT 0,
            fecha TEXT DEFAULT (datetime('now'))
        );
    `);
    console.log("\u2705 Base de datos WSP inicializada");
}

// --- CAMPANA GRUPO ENVIO (anti-duplicate) ---
function registrarEnvioCampanaDB(campanaId, grupoJid) {
    db.prepare("INSERT OR REPLACE INTO campana_grupo_envio (campana_id, grupo_jid, ultimo_envio) VALUES (?, ?, datetime('now'))").run(campanaId, grupoJid);
}

function getUltimoEnvioCampana(campanaId, grupoJid) {
    return db.prepare("SELECT ultimo_envio FROM campana_grupo_envio WHERE campana_id = ? AND grupo_jid = ?").get(campanaId, grupoJid);
}

// --- USUARIOS ---
function normalizeId(wspId) {
    if (!wspId) return wspId;
    let id = String(wspId);
    id = id.replace(/@s\.whatsapp\.net$/i, "").replace(/@lid$/i, "").replace(/:.*$/, "");
    return id;
}

function getUsuario(wspId) {
    const id = normalizeId(wspId);
    let user = db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(id);
    if (!user) user = db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(String(wspId));
    return user;
}

function findUserByNumber(phoneNumber) {
    const norm = normalizeId(phoneNumber);
    const user = db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(norm);
    if (user) return user;
    const withWsp = phoneNumber + "@s.whatsapp.net";
    const userWsp = db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(withWsp);
    if (userWsp) return userWsp;
    const withLid = phoneNumber + "@lid";
    const userLid = db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(withLid);
    if (userLid) return userLid;
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
    const id = normalizeId(wspId);
    db.prepare("INSERT OR IGNORE INTO usuarios (wsp_id, nombre) VALUES (?, ?)").run(id, nombre);
    db.prepare("UPDATE usuarios SET nombre = ? WHERE wsp_id = ?").run(nombre, id);
    const user = db.prepare("SELECT codigo FROM usuarios WHERE wsp_id = ?").get(id);
    if (user && !user.codigo) {
        const codigo = generarCodigo();
        db.prepare("UPDATE usuarios SET codigo = ? WHERE wsp_id = ?").run(codigo, id);
    }
    return db.prepare("SELECT * FROM usuarios WHERE wsp_id = ?").get(id);
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
                db.prepare("UPDATE usuarios SET activo = 0, plan = 'expirado' WHERE wsp_id = ?").run(user.wsp_id);
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
                    db.prepare("UPDATE usuarios SET activo = 0, plan = 'expirado' WHERE wsp_id = ?").run(altUser.wsp_id);
                    return false;
                }
            }
            const newUser = crearUsuario(wspId, user ? user.nombre : "");
            const storedId = newUser ? newUser.wsp_id : normalizeId(wspId);
            db.prepare("UPDATE usuarios SET plan = ?, fecha_expira = ?, activo = 1 WHERE wsp_id = ?").run(altUser.plan, altUser.fecha_expira, storedId);
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
    db.prepare("DELETE FROM session_grupos_cache WHERE user_id = ? AND sesion_nombre = ?").run(userId, nombre);
}

// --- GRUPOS ---
function getGrupos(userId) {
    return db.prepare("SELECT * FROM grupos WHERE user_id = ?").all(userId);
}

function agregarGrupo(userId, link, nombre = null, size = 0) {
    const existente = db.prepare("SELECT id, nombre FROM grupos WHERE user_id = ? AND link = ?").get(userId, link);
    if (!existente) {
        db.prepare("INSERT INTO grupos (user_id, link, nombre, size) VALUES (?, ?, ?, ?)").run(userId, link, nombre, size || 0);
        return true;
    } else {
        if (nombre && !existente.nombre) {
            db.prepare("UPDATE grupos SET nombre = ? WHERE id = ?").run(nombre, existente.id);
        }
        if (size) {
            db.prepare("UPDATE grupos SET size = ? WHERE id = ?").run(size, existente.id);
        }
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

function setGrupoSeccion(userId, grupoId, seccion) {
    db.prepare("UPDATE grupos SET seccion = ? WHERE id = ? AND user_id = ?").run(seccion || '', grupoId, userId);
}

function setGrupoSeccionBulk(userId, grupoIds, seccion) {
    const stmt = db.prepare("UPDATE grupos SET seccion = ? WHERE id = ? AND user_id = ?");
    for (const id of grupoIds) {
        stmt.run(seccion || '', id, userId);
    }
}

function getSecciones(userId) {
    return db.prepare("SELECT DISTINCT seccion FROM grupos WHERE user_id = ? AND seccion != ''").all(userId).map(r => r.seccion);
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
    db.prepare("DELETE FROM campana_grupo_envio WHERE campana_id = ?").run(campanaId);
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
function registrarEnvio(userId, campanaId, grupoLink, resultado = "enviado", grupoNombre = null, tipoEnvio = null, estadoEntrega = null, mensajePreview = null) {
    const tipo = tipoEnvio || (resultado.includes('personal') ? 'personal' : 'grupo');
    db.prepare("INSERT INTO historial_envios (user_id, campana_id, grupo_link, resultado, grupo_nombre, tipo_envio, estado_entrega, mensaje_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(userId, campanaId, grupoLink, resultado, grupoNombre, tipo, estadoEntrega, mensajePreview);
}

function registrarRespuesta(userId, grupoLink, keyword) {
    db.prepare("INSERT INTO historial_respuestas (user_id, grupo_link, keyword) VALUES (?, ?, ?)").run(userId, grupoLink, keyword);
}

function getHistorialEnvios(userId, limite = 50, tipoFiltro = null, resultadoFiltro = null, desde = null, hasta = null) {
    let sql = "SELECT grupo_link, resultado, fecha, grupo_nombre, tipo_envio, estado_entrega, mensaje_preview FROM historial_envios WHERE user_id = ?";
    const params = [userId];
    if (tipoFiltro) {
        if (tipoFiltro === 'personal' || tipoFiltro === 'miembros') {
            sql += " AND tipo_envio = 'personal'";
        } else if (tipoFiltro === 'grupo' || tipoFiltro === 'campana') {
            sql += " AND tipo_envio = 'grupo'";
        }
    }
    if (resultadoFiltro) {
        if (resultadoFiltro === 'exitoso' || resultadoFiltro === 'enviado') {
            sql += " AND resultado IN ('enviado','enviado_pending','enviado_personal')";
        } else if (resultadoFiltro === 'fallido') {
            sql += " AND resultado NOT IN ('enviado','enviado_pending','enviado_personal')";
        }
    }
    if (desde) { sql += " AND fecha >= ?"; params.push(desde); }
    if (hasta) { sql += " AND fecha <= ? || ' 23:59:59'"; params.push(hasta); }
    sql += " ORDER BY fecha DESC LIMIT ?";
    params.push(limite);
    return db.prepare(sql).all(...params);
}

function getHistorialStats(userId) {
    const total = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ?").get(userId);
    const grupos = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND tipo_envio = 'grupo'").get(userId);
    const personales = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal'").get(userId);
    const exitosos = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND resultado IN ('enviado','enviado_pending','enviado_personal')").get(userId);
    const fallidos = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND resultado NOT IN ('enviado','enviado_pending','enviado_personal')").get(userId);
    const entregados = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND estado_entrega = 'entregado'").get(userId);
    const leidos = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND estado_entrega = 'leido'").get(userId);
    return {
        total: total?.c || 0,
        grupos: grupos?.c || 0,
        personales: personales?.c || 0,
        exitosos: exitosos?.c || 0,
        fallidos: fallidos?.c || 0,
        entregados: entregados?.c || 0,
        leidos: leidos?.c || 0,
    };
}

function actualizarEstadoEntrega(userId, grupoLink, estado) {
    db.prepare("UPDATE historial_envios SET estado_entrega = ? WHERE user_id = ? AND grupo_link = ? AND id = (SELECT MAX(id) FROM historial_envios WHERE user_id = ? AND grupo_link = ?)").run(estado, userId, grupoLink, userId, grupoLink);
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
    const envios = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN resultado IN ('enviado','enviado_pending','enviado_personal') THEN 1 ELSE 0 END) as exitosos FROM historial_envios WHERE user_id = ? AND fecha LIKE ?").get(userId, hoy + "%");
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

// --- PANEL AUTH ---
function panelLogin(telegramId, password) {
    const bcrypt = require("bcryptjs");
    const user = db.prepare("SELECT * FROM panel_users WHERE telegram_id = ?").get(String(telegramId));
    if (!user) return { ok: false, error: "no_registrado" };
    // Support both hashed and plain text passwords (backward compat)
    let passOk = false;
    if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
        passOk = bcrypt.compareSync(password, user.password);
    } else {
        passOk = (user.password === password);
        // Migrate plain password to bcrypt on successful login
        if (passOk) {
            const hashed = bcrypt.hashSync(password, 10);
            db.prepare("UPDATE panel_users SET password = ? WHERE telegram_id = ?").run(hashed, String(telegramId));
        }
    }
    if (!passOk) return { ok: false, error: "password_incorrecta" };
    const usu = getUsuario(String(telegramId));
    let esAdmin = usu ? (usu.es_admin === 1) : false;
    if (!esAdmin) {
        try {
            const cfg = require("./config_wsp");
            if (cfg.ADMIN_TELEGRAM_IDS && cfg.ADMIN_TELEGRAM_IDS.includes(String(telegramId))) esAdmin = true;
        } catch (e) {}
    }
    return { ok: true, telegram_id: user.telegram_id, username: user.username, es_admin: esAdmin };
}

function panelRegistro(telegramId, password, username) {
    const bcrypt = require("bcryptjs");
    const existing = db.prepare("SELECT 1 FROM panel_users WHERE telegram_id = ?").get(String(telegramId));
    if (existing) return { ok: false, error: "ya_registrado" };
    const hashed = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO panel_users (telegram_id, username, password) VALUES (?, ?, ?)").run(String(telegramId), username || '', hashed);
    // Crear usuario principal si no existe y darle 1 dia demo
    const user = db.prepare("SELECT 1 FROM usuarios WHERE wsp_id = ?").get(String(telegramId));
    if (!user) {
        crearUsuario(String(telegramId), username || '');
        activarMembresia(String(telegramId), 1);
    }
    return { ok: true };
}

function panelCambiarPassword(telegramId, oldPass, newPass) {
    const bcrypt = require("bcryptjs");
    const user = db.prepare("SELECT * FROM panel_users WHERE telegram_id = ?").get(String(telegramId));
    if (!user) return { ok: false, error: "Usuario no encontrado" };
    let passOk = false;
    if (user.password.startsWith("$2a$") || user.password.startsWith("$2b$")) {
        passOk = bcrypt.compareSync(oldPass, user.password);
    } else {
        passOk = (user.password === oldPass);
    }
    if (!passOk) return { ok: false, error: "Contraseña actual incorrecta" };
    const hashed = bcrypt.hashSync(newPass, 10);
    db.prepare("UPDATE panel_users SET password = ? WHERE telegram_id = ?").run(hashed, String(telegramId));
    return { ok: true };
}

function getPanelUser(telegramId) {
    return db.prepare("SELECT * FROM panel_users WHERE telegram_id = ?").get(String(telegramId));
}

function crearRecoveryCode(telegramId) {
    const crypto = require("crypto");
    db.prepare("DELETE FROM recovery_codes WHERE telegram_id = ?").run(String(telegramId));
    const code = crypto.randomInt(100000, 1000000).toString();
    db.prepare("INSERT INTO recovery_codes (telegram_id, code) VALUES (?, ?)").run(String(telegramId), code);
    return code;
}

function verificarRecoveryCode(telegramId, code) {
    const row = db.prepare(
        "SELECT * FROM recovery_codes WHERE telegram_id = ? AND code = ?"
    ).get(String(telegramId), String(code));
    if (!row) return { ok: false, error: "Codigo invalido o expirado" };
    const created = new Date(row.created_at + "Z");
    if (Date.now() - created.getTime() > 10 * 60 * 1000) {
        db.prepare("DELETE FROM recovery_codes WHERE telegram_id = ? AND code = ?").run(String(telegramId), String(code));
        return { ok: false, error: "Codigo expirado (max 10 min)" };
    }
    return { ok: true };
}

function panelResetPassword(telegramId, code, newPass) {
    const bcrypt = require("bcryptjs");
    const v = verificarRecoveryCode(telegramId, code);
    if (!v.ok) return v;
    const user = db.prepare("SELECT 1 FROM panel_users WHERE telegram_id = ?").get(String(telegramId));
    if (!user) return { ok: false, error: "Usuario no registrado" };
    const hashed = bcrypt.hashSync(newPass, 10);
    db.prepare("UPDATE panel_users SET password = ? WHERE telegram_id = ?").run(hashed, String(telegramId));
    db.prepare("DELETE FROM recovery_codes WHERE telegram_id = ?").run(String(telegramId));
    return { ok: true };
}

function checkMembresia(userId) {
    const user = getUsuario(userId);
    const usu = user;
    let esAdmin = usu ? (usu.es_admin === 1) : false;
    if (!esAdmin) {
        try {
            const cfg = require("./config_wsp");
            if (cfg.ADMIN_TELEGRAM_IDS && cfg.ADMIN_TELEGRAM_IDS.includes(String(userId))) esAdmin = true;
        } catch (e) {}
    }
    if (!user) return { ok: true, activa: false, es_admin: esAdmin, membresia: null };
    const activo = user.activo && (user.plan === 'permanente' || !user.fecha_expira || new Date(user.fecha_expira) > new Date());
    return {
        ok: true,
        activa: activo || esAdmin,
        es_admin: esAdmin,
        membresia: {
            plan: user.plan,
            fecha_expira: user.fecha_expira,
            activo: activo || esAdmin,
            tipo_membresia: user.tipo_membresia || 'wsp+tg',
        }
    };
}

// --- TEMPLATE (mensajes) EXTRAS ---
function editarTemplate(templateId, nombre, mensaje) {
    const existing = db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId);
    if (!existing) return false;
    if (nombre !== undefined && nombre !== null) db.prepare("UPDATE templates SET nombre = ? WHERE id = ?").run(nombre, templateId);
    if (mensaje !== undefined && mensaje !== null) db.prepare("UPDATE templates SET mensaje = ? WHERE id = ?").run(mensaje, templateId);
    return true;
}

function duplicarTemplate(templateId) {
    const orig = db.prepare("SELECT * FROM templates WHERE id = ?").get(templateId);
    if (!orig) return null;
    return db.prepare("INSERT INTO templates (user_id, nombre, mensaje, imagen_path) VALUES (?, ?, ?, ?)").run(orig.user_id, orig.nombre + " (copia)", orig.mensaje, orig.imagen_path).lastInsertRowid;
}

// --- USER ENVIO CONFIG ---
function getUserEnvioConfig(userId) {
    const row = db.prepare("SELECT * FROM user_envio_config WHERE user_id = ?").get(userId);
    return row || { delay_seg: 10, lote_tamano: 0, lote_pausa_seg: 30, hora_inicio: 0, hora_fin: 24 };
}

function setUserEnvioConfig(userId, config) {
    db.prepare("INSERT OR REPLACE INTO user_envio_config (user_id, delay_seg, lote_tamano, lote_pausa_seg, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?, ?)").run(
        userId, config.delay_seg ?? 10, config.lote_tamano ?? 0, config.lote_pausa_seg ?? 30, config.hora_inicio ?? 0, config.hora_fin ?? 24
    );
}

// --- PROGRAMADOS WSP ---
function getProgramados(userId) {
    return db.prepare("SELECT p.*, t.nombre as mensaje_nombre, t.mensaje as mensaje_texto FROM programados_wsp p LEFT JOIN templates t ON p.mensaje_id = t.id WHERE p.user_id = ?").all(userId);
}

function crearProgramado(userId, mensajeId, hora, repetir) {
    return db.prepare("INSERT INTO programados_wsp (user_id, mensaje_id, hora, repetir) VALUES (?, ?, ?, ?)").run(userId, mensajeId, hora, repetir ? 1 : 0).lastInsertRowid;
}

function toggleProgramado(progId) {
    const p = db.prepare("SELECT activo FROM programados_wsp WHERE id = ?").get(progId);
    if (!p) return false;
    db.prepare("UPDATE programados_wsp SET activo = ? WHERE id = ?").run(p.activo ? 0 : 1, progId);
    return true;
}

function eliminarProgramado(progId) {
    db.prepare("DELETE FROM programados_wsp WHERE id = ?").run(progId);
}

// --- AUTO RESPUESTAS WSP ---
function getAutoRespuestas(userId) {
    return db.prepare("SELECT * FROM auto_respuestas WHERE user_id = ?").all(userId);
}

function agregarAutoRespuesta(userId, palabra, respuesta) {
    return db.prepare("INSERT INTO auto_respuestas (user_id, palabra, respuesta) VALUES (?, ?, ?)").run(userId, palabra, respuesta).lastInsertRowid;
}

function eliminarAutoRespuesta(arId) {
    db.prepare("DELETE FROM auto_respuestas WHERE id = ?").run(arId);
}

function limpiarAutoRespuestas(userId) {
    db.prepare("DELETE FROM auto_respuestas WHERE user_id = ?").run(userId);
}

// --- TASA ENTREGA ---
function getTasaEntrega(userId) {
    const rows = db.prepare("SELECT resultado, COUNT(*) as total FROM historial_envios WHERE user_id = ? GROUP BY resultado").all(userId);
    let enviados = 0, fallidos = 0;
    for (const r of rows) {
        if (r.resultado === "enviado") enviados = r.total;
        else fallidos += r.total;
    }
    const total = enviados + fallidos;
    return { total, enviados, fallidos, tasa: total > 0 ? Math.round(enviados * 100 / total) : 0 };
}

function getDb() { return db; }

// --- ADMIN ---
function setAdmin(wspId, esAdmin) {
    const id = normalizeId(wspId);
    db.prepare("UPDATE usuarios SET es_admin = ? WHERE wsp_id = ?").run(esAdmin ? 1 : 0, id);
}

function setTipoMembresia(wspId, tipo) {
    const id = normalizeId(wspId);
    db.prepare("UPDATE usuarios SET tipo_membresia = ? WHERE wsp_id = ?").run(tipo || "wsp+tg", id);
}

function getTodosUsuariosAdmin() {
    const users = db.prepare("SELECT * FROM usuarios ORDER BY fecha_registro DESC").all();
    return users.map(u => ({
        telegram_id: u.wsp_id,
        username: u.username || u.nombre || "",
        plan: u.plan || "sin_plan",
        fecha_expira: u.fecha_expira || null,
        activo: u.activo,
        fecha_registro: u.fecha_registro,
        es_admin: u.es_admin || 0,
        tipo_membresia: u.tipo_membresia || "wsp+tg",
        origen: "bot",
    }));
}

// --- PROGRESO ENVIO (RESUME) ---
function guardarProgresoEnvio(userId, grupoJid, ultimoIndice, total, mensaje, jids, grupoNombre) {
    db.prepare(`INSERT OR REPLACE INTO envio_progreso (user_id, grupo_jid, ultimo_indice, total, mensaje, jids_json, grupo_nombre, fecha)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(userId, grupoJid, ultimoIndice, total, mensaje, JSON.stringify(jids), grupoNombre);
}

function getProgresoEnvio(userId, grupoJid) {
    const row = db.prepare("SELECT * FROM envio_progreso WHERE user_id = ? AND grupo_jid = ?").get(userId, grupoJid);
    if (row && row.jids_json) {
        row.jids = JSON.parse(row.jids_json);
    }
    return row || null;
}

function getProgresoEnvioPendiente(userId) {
    const row = db.prepare("SELECT * FROM envio_progreso WHERE user_id = ? ORDER BY fecha DESC LIMIT 1").get(userId);
    if (row && row.jids_json) {
        row.jids = JSON.parse(row.jids_json);
    }
    return row || null;
}

function eliminarProgresoEnvio(userId, grupoJid) {
    db.prepare("DELETE FROM envio_progreso WHERE user_id = ? AND grupo_jid = ?").run(userId, grupoJid);
}

// --- BLACKLIST NUMEROS (individual numbers) ---
function getBlacklistNumeros(userId) {
    return db.prepare("SELECT * FROM blacklist_numeros WHERE user_id = ? ORDER BY fecha DESC").all(userId);
}

function agregarBlacklistNumero(userId, numero, razon = "") {
    const num = numero.replace(/[^0-9]/g, "");
    db.prepare("INSERT OR IGNORE INTO blacklist_numeros (user_id, numero, razon) VALUES (?, ?, ?)").run(userId, num, razon);
}

function eliminarBlacklistNumero(userId, numero) {
    db.prepare("DELETE FROM blacklist_numeros WHERE user_id = ? AND numero = ?").run(userId, numero);
}

function eliminarBlacklistNumeroById(blId) {
    db.prepare("DELETE FROM blacklist_numeros WHERE id = ?").run(blId);
}

function estaEnBlacklistNumero(userId, numero) {
    const num = numero.replace(/[^0-9]/g, "");
    return !!db.prepare("SELECT 1 FROM blacklist_numeros WHERE user_id = ? AND numero = ?").get(userId, num);
}

function limpiarBlacklistNumeros(userId) {
    db.prepare("DELETE FROM blacklist_numeros WHERE user_id = ?").run(userId);
}

// --- PROGRAMADO MIEMBROS ---
function getProgramadosMiembros(userId) {
    return db.prepare("SELECT * FROM programado_miembros WHERE user_id = ? ORDER BY fecha DESC").all(userId);
}

function crearProgramadoMiembros(userId, grupoJid, grupoNombre, mensaje, cuenta, horaEnvio, diasSemana, countryCode, adminFilter, batchSize, delayMinutes) {
    return db.prepare(`INSERT INTO programado_miembros (user_id, grupo_jid, grupo_nombre, mensaje, cuenta, hora_envio, dias_semana, country_code, admin_filter, batch_size, delay_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, grupoJid, grupoNombre, mensaje, cuenta, horaEnvio, diasSemana || "0,1,2,3,4,5,6", countryCode, adminFilter, batchSize || 0, delayMinutes || 5);
}

function toggleProgramadoMiembros(id) {
    const row = db.prepare("SELECT activo FROM programado_miembros WHERE id = ?").get(id);
    if (!row) return;
    db.prepare("UPDATE programado_miembros SET activo = ? WHERE id = ?").run(row.activo ? 0 : 1, id);
}

function eliminarProgramadoMiembros(id) {
    db.prepare("DELETE FROM programado_miembros WHERE id = ?").run(id);
}

function actualizarUltimoEnvioProgramado(id) {
    db.prepare("UPDATE programado_miembros SET ultimo_envio = datetime('now') WHERE id = ?").run(id);
}

// --- DM DASHBOARD STATS ---
function getDmStats(userId) {
    const total = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal'").get(userId);
    const exitosos = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal' AND resultado IN ('enviado_personal','enviado')").get(userId);
    const fallidos = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal' AND resultado NOT IN ('enviado_personal','enviado')").get(userId);
    const entregados = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal' AND estado_entrega = 'entregado'").get(userId);
    const leidos = db.prepare("SELECT COUNT(*) as c FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal' AND estado_entrega = 'leido'").get(userId);
    const porGrupo = db.prepare(`SELECT grupo_nombre, COUNT(*) as total,
        SUM(CASE WHEN resultado IN ('enviado_personal','enviado') THEN 1 ELSE 0 END) as ok,
        SUM(CASE WHEN resultado NOT IN ('enviado_personal','enviado') THEN 1 ELSE 0 END) as err
        FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal' AND grupo_nombre IS NOT NULL
        GROUP BY grupo_nombre ORDER BY total DESC LIMIT 20`).all(userId);
    const ultimosDias = db.prepare(`SELECT DATE(fecha) as dia, COUNT(*) as total,
        SUM(CASE WHEN resultado IN ('enviado_personal','enviado') THEN 1 ELSE 0 END) as ok
        FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal' AND fecha >= datetime('now', '-7 days')
        GROUP BY DATE(fecha) ORDER BY dia`).all(userId);
    return {
        total: total?.c || 0,
        exitosos: exitosos?.c || 0,
        fallidos: fallidos?.c || 0,
        entregados: entregados?.c || 0,
        leidos: leidos?.c || 0,
        porGrupo,
        ultimosDias,
    };
}

// --- NUMEROS MANUALES (Envio Personal) ---
function getNumerosManuales(userId, cuenta) {
    return db.prepare("SELECT * FROM numeros_manuales WHERE user_id = ? AND cuenta = ? ORDER BY fecha DESC").all(userId, cuenta);
}
function agregarNumeroManual(userId, cuenta, numero) {
    const jid = numero.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    try {
        db.prepare("INSERT OR IGNORE INTO numeros_manuales (user_id, cuenta, numero, jid) VALUES (?, ?, ?, ?)").run(userId, cuenta, numero.replace(/[^0-9]/g, ""), jid);
    } catch (e) {}
}
function agregarNumerosManualesBulk(userId, cuenta, numeros) {
    const stmt = db.prepare("INSERT OR IGNORE INTO numeros_manuales (user_id, cuenta, numero, jid) VALUES (?, ?, ?, ?)");
    const tx = db.transaction((nums) => {
        for (const n of nums) {
            const clean = n.replace(/[^0-9]/g, "");
            if (clean.length >= 7) {
                stmt.run(userId, cuenta, clean, clean + "@s.whatsapp.net");
            }
        }
    });
    tx(numeros);
}
function eliminarNumeroManual(userId, cuenta, numero) {
    db.prepare("DELETE FROM numeros_manuales WHERE user_id = ? AND cuenta = ? AND numero = ?").run(userId, cuenta, numero.replace(/[^0-9]/g, ""));
}
function limpiarNumerosManuales(userId, cuenta) {
    db.prepare("DELETE FROM numeros_manuales WHERE user_id = ? AND cuenta = ?").run(userId, cuenta);
}

// --- PROMO ESCUCHA (Envio Interactivo) ---
function getPromoEscucha(userId) {
    return db.prepare("SELECT * FROM promo_escucha WHERE user_id = ? AND activo = 1").get(userId);
}
function registrarPromoEscucha(userId, palabraAceptar, palabraRechazar, respAceptar, respRechazar) {
    db.prepare("INSERT OR REPLACE INTO promo_escucha (user_id, palabra_aceptar, palabra_rechazar, respuesta_aceptar, respuesta_rechazar, activo, fecha) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))").run(userId, palabraAceptar || 'si', palabraRechazar || 'no', respAceptar || '', respRechazar || '');
}
function detenerPromoEscucha(userId) {
    db.prepare("UPDATE promo_escucha SET activo = 0 WHERE user_id = ?").run(userId);
}
function registrarPromoRespuesta(userId, jid, numero, nombre, tipo) {
    db.prepare("INSERT INTO promo_respuestas (user_id, jid, numero, nombre, tipo) VALUES (?, ?, ?, ?, ?)").run(userId, jid, numero, nombre || '', tipo);
}
function getPromoRespuestas(userId) {
    return db.prepare("SELECT * FROM promo_respuestas WHERE user_id = ? ORDER BY fecha DESC").all(userId);
}
function limpiarPromoRespuestas(userId) {
    db.prepare("DELETE FROM promo_respuestas WHERE user_id = ?").run(userId);
}

// --- PROMO PLANTILLAS ---
function getPromoPlantillas(userId) {
    return db.prepare("SELECT * FROM promo_plantillas WHERE user_id = ? ORDER BY fecha DESC").all(userId);
}
function getPromoPlantilla(id) {
    return db.prepare("SELECT * FROM promo_plantillas WHERE id = ?").get(id);
}
function crearPromoPlantilla(userId, nombre, config) {
    return db.prepare("INSERT INTO promo_plantillas (user_id, nombre, palabra_aceptar, palabra_rechazar, respuesta_aceptar, respuesta_rechazar, respuesta_aceptar_img, respuesta_rechazar_img, timeout_horas, recordatorio, msg_recordatorio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        userId, nombre,
        config.palabra_aceptar || 'si', config.palabra_rechazar || 'no',
        config.respuesta_aceptar || '', config.respuesta_rechazar || '',
        config.respuesta_aceptar_img || '', config.respuesta_rechazar_img || '',
        config.timeout_horas || 24, config.recordatorio ? 1 : 0,
        config.msg_recordatorio || ''
    ).lastInsertRowid;
}
function editarPromoPlantilla(id, nombre, config) {
    db.prepare("UPDATE promo_plantillas SET nombre = ?, palabra_aceptar = ?, palabra_rechazar = ?, respuesta_aceptar = ?, respuesta_rechazar = ?, respuesta_aceptar_img = ?, respuesta_rechazar_img = ?, timeout_horas = ?, recordatorio = ?, msg_recordatorio = ? WHERE id = ?").run(
        nombre,
        config.palabra_aceptar || 'si', config.palabra_rechazar || 'no',
        config.respuesta_aceptar || '', config.respuesta_rechazar || '',
        config.respuesta_aceptar_img || '', config.respuesta_rechazar_img || '',
        config.timeout_horas || 24, config.recordatorio ? 1 : 0,
        config.msg_recordatorio || '', id
    );
}
function eliminarPromoPlantilla(id) {
    db.prepare("DELETE FROM promo_plantillas WHERE id = ?").run(id);
}

// --- RETRY QUEUE (Mejora 4) ---
function agregarRetryQueue(userId, jid, mensaje, imagenPath) {
    db.prepare("INSERT INTO retry_queue (user_id, jid, mensaje, imagen_path) VALUES (?, ?, ?, ?)").run(userId, jid, mensaje, imagenPath || null);
}
function getRetryPendientes(userId) {
    return db.prepare("SELECT * FROM retry_queue WHERE user_id = ? AND estado = 'pendiente' AND intentos < max_intentos AND proximo_intento <= datetime('now') ORDER BY fecha ASC LIMIT 50").all(userId);
}
function getRetryPendientesGlobal() {
    return db.prepare("SELECT * FROM retry_queue WHERE estado = 'pendiente' AND intentos < max_intentos AND proximo_intento <= datetime('now') ORDER BY fecha ASC LIMIT 100").all();
}
function actualizarRetry(id, intentos, estado, error) {
    const proximoIntento = estado === 'pendiente' ? `datetime('now', '+${5 * intentos} minutes')` : null;
    if (estado === 'pendiente') {
        db.prepare("UPDATE retry_queue SET intentos = ?, estado = ?, error = ?, proximo_intento = datetime('now', '+' || (5 * ?) || ' minutes') WHERE id = ?").run(intentos, estado, error || '', intentos, id);
    } else {
        db.prepare("UPDATE retry_queue SET intentos = ?, estado = ?, error = ? WHERE id = ?").run(intentos, estado, error || '', id);
    }
}
function limpiarRetryCompletados(userId) {
    db.prepare("DELETE FROM retry_queue WHERE user_id = ? AND (estado = 'enviado' OR estado = 'fallido')").run(userId);
}
function getRetryStats(userId) {
    const pendientes = db.prepare("SELECT COUNT(*) as total FROM retry_queue WHERE user_id = ? AND estado = 'pendiente'").get(userId);
    const enviados = db.prepare("SELECT COUNT(*) as total FROM retry_queue WHERE user_id = ? AND estado = 'enviado'").get(userId);
    const fallidos = db.prepare("SELECT COUNT(*) as total FROM retry_queue WHERE user_id = ? AND estado = 'fallido'").get(userId);
    return { pendientes: pendientes.total, enviados: enviados.total, fallidos: fallidos.total };
}

// --- PROMO TIMEOUT (Mejora 3) ---
function getPromoTimeout(userId) {
    return db.prepare("SELECT * FROM promo_timeout WHERE user_id = ?").get(userId);
}
function setPromoTimeout(userId, timeoutHoras, recordatorioActivo, mensajeRecordatorio) {
    db.prepare("INSERT OR REPLACE INTO promo_timeout (user_id, timeout_horas, recordatorio_activo, mensaje_recordatorio) VALUES (?, ?, ?, ?)").run(userId, timeoutHoras || 24, recordatorioActivo ? 1 : 0, mensajeRecordatorio || '');
}

// --- PROMO KEYWORDS (Mejora 7) ---
function getPromoKeywords(userId) {
    return db.prepare("SELECT * FROM promo_keywords WHERE user_id = ? ORDER BY id ASC").all(userId);
}
function agregarPromoKeyword(userId, palabra, respuestaTexto, respuestaImagen, tipo) {
    db.prepare("INSERT INTO promo_keywords (user_id, palabra, respuesta_texto, respuesta_imagen, tipo) VALUES (?, ?, ?, ?, ?)").run(userId, palabra, respuestaTexto || '', respuestaImagen || null, tipo || 'aceptar');
}
function eliminarPromoKeyword(id) {
    db.prepare("DELETE FROM promo_keywords WHERE id = ?").run(id);
}
function limpiarPromoKeywords(userId) {
    db.prepare("DELETE FROM promo_keywords WHERE user_id = ?").run(userId);
}

// --- BOT LOGS (Mejora 6) ---
function agregarLog(userId, tipo, mensaje) {
    try {
        db.prepare("INSERT INTO bot_logs (user_id, tipo, mensaje) VALUES (?, ?, ?)").run(userId || 'system', tipo || 'info', mensaje);
        // Keep only last 500 logs per user
        db.prepare("DELETE FROM bot_logs WHERE id NOT IN (SELECT id FROM bot_logs WHERE user_id = ? ORDER BY id DESC LIMIT 500) AND user_id = ?").run(userId || 'system', userId || 'system');
    } catch (e) {}
}
function getLogs(userId, limite) {
    if (userId) {
        return db.prepare("SELECT * FROM bot_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limite || 100);
    }
    return db.prepare("SELECT * FROM bot_logs ORDER BY id DESC LIMIT ?").all(limite || 100);
}
function limpiarLogs(userId) {
    if (userId) {
        db.prepare("DELETE FROM bot_logs WHERE user_id = ?").run(userId);
    } else {
        db.prepare("DELETE FROM bot_logs").run();
    }
}

// --- SESSION GRUPOS CACHE ---
function cacheGruposSesion(userId, sesionNombre, grupos) {
    db.prepare("DELETE FROM session_grupos_cache WHERE user_id = ? AND sesion_nombre = ?").run(userId, sesionNombre);
    const stmt = db.prepare("INSERT INTO session_grupos_cache (user_id, sesion_nombre, grupo_jid, subject, size, es_admin, can_post, announce) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const g of grupos) {
        stmt.run(userId, sesionNombre, g.jid, g.subject || '', g.size || 0, g.esAdmin ? 1 : 0, g.canPost !== false ? 1 : 0, g.announce ? 1 : 0);
    }
}
function getGruposCacheSesion(userId, sesionNombre) {
    return db.prepare("SELECT grupo_jid AS jid, subject, size, es_admin AS esAdmin, can_post AS canPost, announce, fecha_cache FROM session_grupos_cache WHERE user_id = ? AND sesion_nombre = ?").all(userId, sesionNombre).map(r => ({
        jid: r.jid, subject: r.subject, size: r.size, esAdmin: !!r.esAdmin, canPost: !!r.canPost, announce: !!r.announce, cached: true, fecha_cache: r.fecha_cache
    }));
}
function limpiarGruposCacheSesion(userId, sesionNombre) {
    db.prepare("DELETE FROM session_grupos_cache WHERE user_id = ? AND sesion_nombre = ?").run(userId, sesionNombre);
}
function limpiarTodosGruposCacheUsuario(userId) {
    db.prepare("DELETE FROM session_grupos_cache WHERE user_id = ?").run(userId);
}

function getPromoSentJids(userId) {
    return db.prepare(
        "SELECT DISTINCT grupo_link FROM historial_envios WHERE user_id = ? AND tipo_envio = 'personal' AND resultado IN ('enviado_personal', 'enviado_pending')"
    ).all(userId).map(r => r.grupo_link);
}

// --- 2FA FUNCTIONS ---
function setup2FA(telegramId) {
    const existing = db.prepare("SELECT * FROM user_2fa WHERE telegram_id = ?").get(telegramId);
    if (existing && existing.enabled) return null;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let secret = '';
    for (let i = 0; i < 16; i++) secret += chars[require('crypto').randomInt(chars.length)];
    db.prepare("INSERT OR REPLACE INTO user_2fa (telegram_id, secret, enabled) VALUES (?, ?, 0)").run(telegramId, secret);
    return secret;
}
function get2FA(telegramId) {
    return db.prepare("SELECT * FROM user_2fa WHERE telegram_id = ?").get(telegramId);
}
function enable2FA(telegramId) {
    db.prepare("UPDATE user_2fa SET enabled = 1 WHERE telegram_id = ?").run(telegramId);
}
function disable2FA(telegramId) {
    db.prepare("DELETE FROM user_2fa WHERE telegram_id = ?").run(telegramId);
}
function verify2FACode(secret, code) {
    const crypto = require("crypto");
    const time = Math.floor(Date.now() / 1000 / 30);
    for (let offset = -1; offset <= 1; offset++) {
        const t = time + offset;
        const buf = Buffer.alloc(8);
        buf.writeUInt32BE(0, 0);
        buf.writeUInt32BE(t, 4);
        const base32decode = (s) => {
            const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
            let bits = '', bytes = [];
            for (const c of s.toUpperCase()) { const v = a.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
            for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
            return Buffer.from(bytes);
        };
        const key = base32decode(secret);
        const hmac = crypto.createHmac("sha1", key).update(buf).digest();
        const off2 = hmac[hmac.length - 1] & 0xf;
        const otp = ((hmac[off2] & 0x7f) << 24 | hmac[off2 + 1] << 16 | hmac[off2 + 2] << 8 | hmac[off2 + 3]) % 1000000;
        if (String(otp).padStart(6, '0') === String(code).padStart(6, '0')) return true;
    }
    return false;
}

// --- ACTIVE SESSIONS FUNCTIONS ---
function createSession(telegramId, token, ip, userAgent) {
    db.prepare("INSERT INTO active_sessions (telegram_id, token, ip, user_agent) VALUES (?, ?, ?, ?)").run(telegramId, token, ip || '', userAgent || '');
}
function getSessions(telegramId) {
    return db.prepare("SELECT id, ip, user_agent, created_at, last_active FROM active_sessions WHERE telegram_id = ? ORDER BY last_active DESC").all(telegramId);
}
function deleteSession(telegramId, sessionId) {
    db.prepare("DELETE FROM active_sessions WHERE telegram_id = ? AND id = ?").run(telegramId, sessionId);
}
function deleteAllSessions(telegramId, exceptToken) {
    if (exceptToken) {
        db.prepare("DELETE FROM active_sessions WHERE telegram_id = ? AND token != ?").run(telegramId, exceptToken);
    } else {
        db.prepare("DELETE FROM active_sessions WHERE telegram_id = ?").run(telegramId);
    }
}
function touchSession(token) {
    db.prepare("UPDATE active_sessions SET last_active = datetime('now') WHERE token = ?").run(token);
}

function validateSession(token) {
    if (!token) return null;
    const session = db.prepare("SELECT * FROM active_sessions WHERE token = ?").get(token);
    if (!session) return null;
    // Sessions expire after 7 days of inactivity
    const lastActive = new Date(session.last_active + "Z");
    if (Date.now() - lastActive.getTime() > 7 * 86400000) {
        db.prepare("DELETE FROM active_sessions WHERE id = ?").run(session.id);
        return null;
    }
    db.prepare("UPDATE active_sessions SET last_active = datetime('now') WHERE id = ?").run(session.id);
    return session;
}

// --- RATE LIMITING ---
function getLoginAttempts(ip) {
    const since = new Date(Date.now() - 15 * 60000).toISOString().replace('T', ' ').slice(0, 19);
    const row = db.prepare("SELECT COUNT(*) as total FROM login_attempts WHERE ip = ? AND created_at >= ?").get(ip, since);
    return row ? row.total : 0;
}

function registrarLoginAttempt(ip, telegramId, success) {
    db.prepare("INSERT INTO login_attempts (ip, telegram_id, success) VALUES (?, ?, ?)").run(ip, telegramId || '', success ? 1 : 0);
}

function limpiarLoginAttempts() {
    const cutoff = new Date(Date.now() - 60 * 60000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(cutoff);
}

// --- AUDIT LOG ---
function registrarAuditoria(userId, accion, detalle, ip) {
    db.prepare("INSERT INTO audit_log (user_id, accion, detalle, ip) VALUES (?, ?, ?, ?)").run(userId || '', accion, detalle || '', ip || '');
}

function getAuditLog(limit) {
    return db.prepare("SELECT * FROM audit_log ORDER BY fecha DESC LIMIT ?").all(limit || 100);
}

function getAuditLogByUser(userId, limit) {
    return db.prepare("SELECT * FROM audit_log WHERE user_id = ? ORDER BY fecha DESC LIMIT ?").all(userId, limit || 50);
}

// --- CLEANUP ---
function limpiarRecoveryCodes() {
    db.prepare("DELETE FROM recovery_codes WHERE created_at < datetime('now', '-1 hour')").run();
}

function limpiarSessionsExpiradas() {
    db.prepare("DELETE FROM active_sessions WHERE last_active < datetime('now', '-7 days')").run();
}

// --- GRUPO ACTIVIDAD PERSISTENCIA ---
function registrarActividadGrupoDB(grupoJid) {
    db.prepare("INSERT OR REPLACE INTO grupo_actividad (grupo_jid, ultima_actividad) VALUES (?, datetime('now'))").run(grupoJid);
}

function getUltimaActividadGrupo(grupoJid) {
    const row = db.prepare("SELECT ultima_actividad FROM grupo_actividad WHERE grupo_jid = ?").get(grupoJid);
    return row ? new Date(row.ultima_actividad + "Z").getTime() : undefined;
}

// --- EXPORT/IMPORT CONFIG ---
function exportFullConfig(userId) {
    const grupos = db.prepare("SELECT * FROM grupos WHERE user_id = ?").all(userId);
    const campanas = db.prepare("SELECT * FROM campanas WHERE user_id = ?").all(userId);
    const templates = db.prepare("SELECT * FROM templates WHERE user_id = ?").all(userId);
    const blacklist = db.prepare("SELECT * FROM blacklist WHERE user_id = ?").all(userId);
    const blacklistNum = db.prepare("SELECT * FROM blacklist_numeros WHERE user_id = ?").all(userId);
    const autoResp = db.prepare("SELECT * FROM auto_respuestas WHERE user_id = ?").all(userId);
    const config = db.prepare("SELECT * FROM user_envio_config WHERE user_id = ?").get(userId);
    const promo = db.prepare("SELECT * FROM promo_plantillas WHERE user_id = ?").all(userId);
    return { grupos, campanas, templates, blacklist, blacklist_numeros: blacklistNum, auto_respuestas: autoResp, config, promo_plantillas: promo };
}
function importFullConfig(userId, data) {
    let imported = { grupos: 0, campanas: 0, templates: 0, blacklist: 0, auto_respuestas: 0 };
    if (data.grupos && Array.isArray(data.grupos)) {
        data.grupos.forEach(g => {
            try { db.prepare("INSERT OR IGNORE INTO grupos (user_id, link, nombre, seccion, size) VALUES (?, ?, ?, ?, ?)").run(userId, g.link, g.nombre || null, g.seccion || '', g.size || 0); imported.grupos++; } catch(_) {}
        });
    }
    if (data.templates && Array.isArray(data.templates)) {
        data.templates.forEach(t => {
            try { db.prepare("INSERT INTO templates (user_id, nombre, mensaje, imagen_path) VALUES (?, ?, ?, ?)").run(userId, t.nombre, t.mensaje, t.imagen_path || null); imported.templates++; } catch(_) {}
        });
    }
    if (data.blacklist && Array.isArray(data.blacklist)) {
        data.blacklist.forEach(b => {
            try { db.prepare("INSERT OR IGNORE INTO blacklist (user_id, grupo_link, razon) VALUES (?, ?, ?)").run(userId, b.grupo_link, b.razon || ''); imported.blacklist++; } catch(_) {}
        });
    }
    if (data.auto_respuestas && Array.isArray(data.auto_respuestas)) {
        data.auto_respuestas.forEach(a => {
            try { db.prepare("INSERT INTO auto_respuestas (user_id, palabra, respuesta) VALUES (?, ?, ?)").run(userId, a.palabra, a.respuesta); imported.auto_respuestas++; } catch(_) {}
        });
    }
    if (data.config) {
        try { db.prepare("INSERT OR REPLACE INTO user_envio_config (user_id, delay_seg, lote_tamano, lote_pausa_seg, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?, ?)").run(userId, data.config.delay_seg || 10, data.config.lote_tamano || 0, data.config.lote_pausa_seg || 30, data.config.hora_inicio || 0, data.config.hora_fin || 24); } catch(_) {}
    }
    return imported;
}

// --- DASHBOARD EXTENDED ---
function getDashboardExtended(userId) {
    const hoy = new Date().toISOString().slice(0, 10);
    const hace7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const hace30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const semana = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN resultado IN ('enviado','enviado_pending') THEN 1 ELSE 0 END) as ok, SUM(CASE WHEN resultado NOT IN ('enviado','enviado_pending') THEN 1 ELSE 0 END) as err FROM historial_envios WHERE user_id = ? AND fecha >= ?").get(userId, hace7);
    const mes = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN resultado IN ('enviado','enviado_pending') THEN 1 ELSE 0 END) as ok, SUM(CASE WHEN resultado NOT IN ('enviado','enviado_pending') THEN 1 ELSE 0 END) as err FROM historial_envios WHERE user_id = ? AND fecha >= ?").get(userId, hace30);
    const porHora = db.prepare("SELECT strftime('%H', fecha) as hora, COUNT(*) as total FROM historial_envios WHERE user_id = ? AND fecha >= ? GROUP BY hora ORDER BY hora").all(userId, hace7);
    const topGrupos = db.prepare("SELECT grupo_nombre, COUNT(*) as total, SUM(CASE WHEN resultado IN ('enviado','enviado_pending') THEN 1 ELSE 0 END) as ok FROM historial_envios WHERE user_id = ? AND fecha >= ? GROUP BY grupo_nombre ORDER BY total DESC LIMIT 10").all(userId, hace30);
    return { semana: semana || {}, mes: mes || {}, porHora, topGrupos };
}

// --- SELLERS (Revendedores) ---
function crearSeller(telegramId, nombre, maxInvites, periodo, planDias, planTipo) {
    db.prepare(`INSERT OR REPLACE INTO sellers (telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo, activo, fecha_creado)
        VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))`).run(String(telegramId), nombre || '', maxInvites || 10, periodo || 'semanal', planDias || 7, planTipo || 'semanal');
}

function getSeller(telegramId) {
    return db.prepare("SELECT * FROM sellers WHERE telegram_id = ?").get(String(telegramId));
}

function getSellerById(id) {
    return db.prepare("SELECT * FROM sellers WHERE id = ?").get(id);
}

function getTodosSellers() {
    return db.prepare("SELECT * FROM sellers ORDER BY fecha_creado DESC").all();
}

function editarSeller(id, maxInvites, periodo, planDias, planTipo, activo) {
    db.prepare("UPDATE sellers SET max_invites = ?, periodo = ?, plan_dias = ?, plan_tipo = ?, activo = ? WHERE id = ?")
        .run(maxInvites, periodo, planDias, planTipo, activo ? 1 : 0, id);
}

function eliminarSeller(id) {
    db.prepare("DELETE FROM seller_codes WHERE seller_id = ?").run(id);
    db.prepare("DELETE FROM seller_invites WHERE seller_id = ?").run(id);
    db.prepare("DELETE FROM sellers WHERE id = ?").run(id);
}

function getSellerInvitesCount(sellerId, periodo) {
    let desde;
    const now = new Date();
    if (periodo === 'semanal') {
        // Start of current week (Monday)
        const day = now.getDay();
        const diff = day === 0 ? 6 : day - 1; // Monday = 0
        const monday = new Date(now);
        monday.setDate(monday.getDate() - diff);
        monday.setHours(0, 0, 0, 0);
        desde = monday.toLocaleString("sv-SE", { timeZone: config.TIMEZONE }).replace("T", " ");
    } else {
        // Start of current month
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        desde = firstDay.toLocaleString("sv-SE", { timeZone: config.TIMEZONE }).replace("T", " ");
    }
    const row = db.prepare("SELECT COUNT(*) as total FROM seller_invites WHERE seller_id = ? AND fecha_invitacion >= ?").get(sellerId, desde);
    return row ? row.total : 0;
}

function getSellerInvites(sellerId) {
    return db.prepare("SELECT * FROM seller_invites WHERE seller_id = ? ORDER BY fecha_invitacion DESC").all(sellerId);
}

function registrarSellerInvite(sellerId, invitadoTelegramId, planDias, planTipo) {
    db.prepare("INSERT INTO seller_invites (seller_id, invitado_telegram_id, plan_dias, plan_tipo) VALUES (?, ?, ?, ?)")
        .run(sellerId, String(invitadoTelegramId), planDias || 7, planTipo || 'semanal');
}

function isSellerUser(telegramId) {
    const s = db.prepare("SELECT * FROM sellers WHERE telegram_id = ? AND activo = 1").get(String(telegramId));
    return s || null;
}

function generarSellerCode(sellerId, planDias, planTipo) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let codigo = null;
    for (let attempts = 0; attempts < 50; attempts++) {
        let candidate = 'VIP-';
        for (let i = 0; i < 6; i++) candidate += chars.charAt(Math.floor(Math.random() * chars.length));
        const exists = db.prepare("SELECT 1 FROM seller_codes WHERE codigo = ?").get(candidate);
        if (!exists) { codigo = candidate; break; }
    }
    if (!codigo) throw new Error('No se pudo generar un codigo unico');
    db.prepare("INSERT INTO seller_codes (seller_id, codigo, plan_dias, plan_tipo) VALUES (?, ?, ?, ?)")
        .run(sellerId, codigo, planDias || 7, planTipo || 'semanal');
    return codigo;
}

function getSellerCodes(sellerId) {
    return db.prepare("SELECT * FROM seller_codes WHERE seller_id = ? ORDER BY fecha_creado DESC").all(sellerId);
}

function getSellerCodesPendientes(sellerId) {
    return db.prepare("SELECT * FROM seller_codes WHERE seller_id = ? AND usado = 0 ORDER BY fecha_creado DESC").all(sellerId);
}

function canjearSellerCode(codigo, telegramId) {
    const code = db.prepare("SELECT sc.*, s.activo as seller_activo, s.telegram_id as seller_tid, s.nombre as seller_nombre FROM seller_codes sc JOIN sellers s ON sc.seller_id = s.id WHERE sc.codigo = ?").get(String(codigo).toUpperCase().trim());
    if (!code) return { ok: false, error: 'codigo_invalido' };
    if (code.usado) return { ok: false, error: 'codigo_usado' };
    if (!code.seller_activo) return { ok: false, error: 'seller_inactivo' };
    db.prepare("UPDATE seller_codes SET usado = 1, usado_por = ?, fecha_usado = datetime('now') WHERE id = ?").run(String(telegramId), code.id);
    registrarSellerInvite(code.seller_id, telegramId, code.plan_dias, code.plan_tipo);
    return { ok: true, plan_dias: code.plan_dias, plan_tipo: code.plan_tipo, seller_nombre: code.seller_nombre };
}

function eliminarSellerCode(codeId, sellerId) {
    db.prepare("DELETE FROM seller_codes WHERE id = ? AND seller_id = ? AND usado = 0").run(codeId, sellerId);
}

// ─────────────────────────────────────────
//   PAGOS (Binance Pay)
// ─────────────────────────────────────────

function crearPago(userId, merchantTradeNo, planKey, planDias, montoUsdt) {
    db.prepare(`INSERT INTO pagos (user_id, merchant_trade_no, plan_key, plan_dias, monto_usdt) VALUES (?, ?, ?, ?, ?)`).run(
        String(userId), merchantTradeNo, planKey, planDias, montoUsdt
    );
    return db.prepare("SELECT * FROM pagos WHERE merchant_trade_no = ?").get(merchantTradeNo);
}

function getPago(merchantTradeNo) {
    return db.prepare("SELECT * FROM pagos WHERE merchant_trade_no = ?").get(merchantTradeNo);
}

function getPagoPorPrepayId(prepayId) {
    return db.prepare("SELECT * FROM pagos WHERE prepay_id = ?").get(prepayId);
}

function actualizarPagoPrepay(merchantTradeNo, prepayId, checkoutUrl, qrcodeUrl, universalUrl, deepLink) {
    db.prepare(`UPDATE pagos SET prepay_id = ?, checkout_url = ?, qrcode_url = ?, universal_url = ?, deep_link = ? WHERE merchant_trade_no = ?`).run(
        prepayId, checkoutUrl || null, qrcodeUrl || null, universalUrl || null, deepLink || null, merchantTradeNo
    );
}

function marcarPagoPagado(merchantTradeNo, transactionId) {
    db.prepare(`UPDATE pagos SET estado = 'paid', binance_transaction_id = ?, fecha_pagado = datetime('now') WHERE merchant_trade_no = ?`).run(
        transactionId || null, merchantTradeNo
    );
    return db.prepare("SELECT * FROM pagos WHERE merchant_trade_no = ?").get(merchantTradeNo);
}

function marcarPagoExpirado(merchantTradeNo) {
    db.prepare(`UPDATE pagos SET estado = 'expired', fecha_expirado = datetime('now') WHERE merchant_trade_no = ? AND estado = 'pending'`).run(merchantTradeNo);
}

function marcarPagoCancelado(merchantTradeNo) {
    db.prepare(`UPDATE pagos SET estado = 'cancelled' WHERE merchant_trade_no = ? AND estado = 'pending'`).run(merchantTradeNo);
}

function getPagosUsuario(userId) {
    return db.prepare("SELECT * FROM pagos WHERE user_id = ? ORDER BY fecha_creado DESC LIMIT 50").all(String(userId));
}

function getPagosPendientes(userId) {
    return db.prepare("SELECT * FROM pagos WHERE user_id = ? AND estado = 'pending' ORDER BY fecha_creado DESC").all(String(userId));
}

function getTodosPagosAdmin(limit = 100) {
    return db.prepare("SELECT * FROM pagos ORDER BY fecha_creado DESC LIMIT ?").all(limit);
}

function getPagosStats() {
    const total = db.prepare("SELECT COUNT(*) as count, SUM(monto_usdt) as total_usdt FROM pagos WHERE estado = 'paid'").get();
    const hoy = db.prepare("SELECT COUNT(*) as count, SUM(monto_usdt) as total_usdt FROM pagos WHERE estado = 'paid' AND fecha_pagado >= date('now')").get();
    const pendientes = db.prepare("SELECT COUNT(*) as count FROM pagos WHERE estado = 'pending'").get();
    return { total_pagos: total.count || 0, total_usdt: total.total_usdt || 0, hoy_pagos: hoy.count || 0, hoy_usdt: hoy.total_usdt || 0, pendientes: pendientes.count || 0 };
}

// ─────────────────────────────────────────
//   COMPROBANTES (Pago manual)
// ─────────────────────────────────────────

function crearComprobante(userId, planKey, planDias, metodoPago, monto, imagenPath, notaCliente) {
    db.prepare(`INSERT INTO comprobantes (user_id, plan_key, plan_dias, metodo_pago, monto, imagen_path, nota_cliente) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        String(userId), planKey, planDias, metodoPago, monto || '', imagenPath || null, notaCliente || ''
    );
    return db.prepare("SELECT * FROM comprobantes WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(String(userId));
}

function getComprobante(id) {
    return db.prepare("SELECT * FROM comprobantes WHERE id = ?").get(id);
}

function getComprobantesUsuario(userId) {
    return db.prepare("SELECT * FROM comprobantes WHERE user_id = ? ORDER BY fecha_creado DESC LIMIT 50").all(String(userId));
}

function getComprobantesPendientes() {
    return db.prepare("SELECT * FROM comprobantes WHERE estado = 'pendiente' ORDER BY fecha_creado ASC").all();
}

function getTodosComprobantes(limit = 100) {
    return db.prepare("SELECT * FROM comprobantes ORDER BY fecha_creado DESC LIMIT ?").all(limit);
}

function aprobarComprobante(id, adminId) {
    db.prepare(`UPDATE comprobantes SET estado = 'aprobado', revisado_por = ?, fecha_revisado = datetime('now') WHERE id = ? AND estado = 'pendiente'`).run(String(adminId), id);
    return db.prepare("SELECT * FROM comprobantes WHERE id = ?").get(id);
}

function rechazarComprobante(id, adminId, adminNota) {
    db.prepare(`UPDATE comprobantes SET estado = 'rechazado', revisado_por = ?, admin_nota = ?, fecha_revisado = datetime('now') WHERE id = ? AND estado = 'pendiente'`).run(String(adminId), adminNota || '', id);
    return db.prepare("SELECT * FROM comprobantes WHERE id = ?").get(id);
}

function getComprobantesStats() {
    const total = db.prepare("SELECT COUNT(*) as count FROM comprobantes WHERE estado = 'aprobado'").get();
    const pendientes = db.prepare("SELECT COUNT(*) as count FROM comprobantes WHERE estado = 'pendiente'").get();
    const hoy = db.prepare("SELECT COUNT(*) as count FROM comprobantes WHERE estado = 'aprobado' AND fecha_revisado >= date('now')").get();
    return { total_aprobados: total.count || 0, pendientes: pendientes.count || 0, hoy_aprobados: hoy.count || 0 };
}

// ─────────────────────────────────────────
//   METODOS DE PAGO (Admin configurable)
// ─────────────────────────────────────────

function getMetodosPago() {
    return db.prepare("SELECT * FROM metodos_pago ORDER BY orden ASC, id ASC").all();
}

function getMetodosPagoActivos() {
    return db.prepare("SELECT * FROM metodos_pago WHERE activo = 1 ORDER BY orden ASC, id ASC").all();
}

function crearMetodoPago(tipo, nombre, valor, instrucciones) {
    db.prepare("INSERT INTO metodos_pago (tipo, nombre, valor, instrucciones) VALUES (?, ?, ?, ?)").run(tipo, nombre, valor, instrucciones || '');
    return db.prepare("SELECT * FROM metodos_pago ORDER BY id DESC LIMIT 1").get();
}

function editarMetodoPago(id, nombre, valor, instrucciones, activo, qrImagen) {
    if (qrImagen !== undefined) {
        db.prepare("UPDATE metodos_pago SET nombre = ?, valor = ?, instrucciones = ?, activo = ?, qr_imagen = ? WHERE id = ?").run(nombre, valor, instrucciones || '', activo ? 1 : 0, qrImagen, id);
    } else {
        db.prepare("UPDATE metodos_pago SET nombre = ?, valor = ?, instrucciones = ?, activo = ? WHERE id = ?").run(nombre, valor, instrucciones || '', activo ? 1 : 0, id);
    }
}

function setMetodoPagoQr(id, qrImagen) {
    db.prepare("UPDATE metodos_pago SET qr_imagen = ? WHERE id = ?").run(qrImagen || '', id);
}

function getMetodoPago(id) {
    return db.prepare("SELECT * FROM metodos_pago WHERE id = ?").get(id);
}

function eliminarMetodoPago(id) {
    db.prepare("DELETE FROM metodos_pago WHERE id = ?").run(id);
}

function initDefaultMetodosPago() {
    const count = db.prepare("SELECT COUNT(*) as c FROM metodos_pago").get();
    if (count.c === 0) {
        db.prepare("INSERT INTO metodos_pago (tipo, nombre, valor, instrucciones, orden) VALUES (?, ?, ?, ?, ?)").run(
            'yape', 'Yape', config.YAPE_NUM || '976680776', 'Enviar al numero y subir captura del comprobante', 1
        );
    }
}

// ─────────────────────────────────────────
//   PUSH NOTIFICATIONS
// ─────────────────────────────────────────

function addPushSubscription(userId, endpoint, p256dh, auth) {
    db.prepare("INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)").run(String(userId), endpoint, p256dh, auth);
}

function getPushSubscriptions(userId) {
    return db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(String(userId));
}

function removePushSubscription(endpoint) {
    db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

function getAllPushSubscriptions() {
    return db.prepare("SELECT * FROM push_subscriptions").all();
}

// ─────────────────────────────────────────
//   TICKETS DE SOPORTE
// ─────────────────────────────────────────

function crearTicket(userId, asunto, mensajeInicial) {
    const r = db.prepare("INSERT INTO tickets (user_id, asunto) VALUES (?, ?)").run(String(userId), asunto);
    if (mensajeInicial) {
        db.prepare("INSERT INTO ticket_mensajes (ticket_id, autor_id, es_admin, mensaje) VALUES (?, ?, 0, ?)").run(r.lastInsertRowid, String(userId), mensajeInicial);
    }
    return db.prepare("SELECT * FROM tickets WHERE id = ?").get(r.lastInsertRowid);
}

function getTicket(id) {
    return db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
}

function getTicketsUsuario(userId) {
    return db.prepare("SELECT * FROM tickets WHERE user_id = ? ORDER BY fecha_creado DESC").all(String(userId));
}

function getTicketsPendientes() {
    return db.prepare("SELECT * FROM tickets WHERE estado = 'abierto' ORDER BY fecha_creado ASC").all();
}

function getTodosTickets(limit = 100) {
    return db.prepare("SELECT * FROM tickets ORDER BY fecha_creado DESC LIMIT ?").all(limit);
}

function agregarMensajeTicket(ticketId, autorId, esAdmin, mensaje) {
    db.prepare("INSERT INTO ticket_mensajes (ticket_id, autor_id, es_admin, mensaje) VALUES (?, ?, ?, ?)").run(ticketId, String(autorId), esAdmin ? 1 : 0, mensaje);
    return db.prepare("SELECT * FROM ticket_mensajes WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(ticketId);
}

function getMensajesTicket(ticketId) {
    return db.prepare("SELECT * FROM ticket_mensajes WHERE ticket_id = ? ORDER BY fecha ASC").all(ticketId);
}

function cerrarTicket(id) {
    db.prepare("UPDATE tickets SET estado = 'cerrado', fecha_cerrado = datetime('now') WHERE id = ?").run(id);
}

function getTicketsStats() {
    const abiertos = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE estado = 'abierto'").get();
    const total = db.prepare("SELECT COUNT(*) as c FROM tickets").get();
    const hoy = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE fecha_creado >= date('now')").get();
    return { abiertos: abiertos.c || 0, total: total.c || 0, hoy: hoy.c || 0 };
}

// ─────────────────────────────────────────
//   WEBHOOKS DE EVENTOS
// ─────────────────────────────────────────

function crearWebhook(userId, url, eventos, secret) {
    db.prepare("INSERT INTO user_webhooks (user_id, url, eventos, secret) VALUES (?, ?, ?, ?)").run(String(userId), url, eventos || 'all', secret || '');
    return db.prepare("SELECT * FROM user_webhooks WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(String(userId));
}

function getWebhooks(userId) {
    return db.prepare("SELECT * FROM user_webhooks WHERE user_id = ? ORDER BY id ASC").all(String(userId));
}

function editarWebhook(id, url, eventos, activo) {
    db.prepare("UPDATE user_webhooks SET url = ?, eventos = ?, activo = ? WHERE id = ?").run(url, eventos || 'all', activo ? 1 : 0, id);
}

function eliminarWebhook(id) {
    db.prepare("DELETE FROM user_webhooks WHERE id = ?").run(id);
}

function getWebhooksActivos(userId) {
    return db.prepare("SELECT * FROM user_webhooks WHERE user_id = ? AND activo = 1").all(String(userId));
}

// ─────────────────────────────────────────
//   BACKUP LOG
// ─────────────────────────────────────────

function registrarBackup(filename, sizeBytes) {
    db.prepare("INSERT INTO backup_log (filename, size_bytes) VALUES (?, ?)").run(filename, sizeBytes || 0);
}

function getBackupLog(limit = 20) {
    return db.prepare("SELECT * FROM backup_log ORDER BY fecha DESC LIMIT ?").all(limit);
}

function limpiarBackupsViejos(keepDays = 7) {
    return db.prepare("DELETE FROM backup_log WHERE fecha < datetime('now', '-' || ? || ' days')").run(keepDays);
}

// ─────────────────────────────────────────
//   ANALYTICS AVANZADO
// ─────────────────────────────────────────

function getAnalyticsEnviosPorDia(userId, dias = 30) {
    return db.prepare(`
        SELECT date(fecha) as dia, COUNT(*) as total,
        SUM(CASE WHEN estado = 'exitoso' OR estado = 'ok' THEN 1 ELSE 0 END) as exitosos,
        SUM(CASE WHEN estado != 'exitoso' AND estado != 'ok' THEN 1 ELSE 0 END) as fallidos
        FROM historial_envios WHERE user_id = ? AND fecha >= date('now', '-' || ? || ' days')
        GROUP BY dia ORDER BY dia ASC
    `).all(String(userId), dias);
}

function getAnalyticsHorasActivas(userId, dias = 7) {
    return db.prepare(`
        SELECT CAST(strftime('%H', fecha) AS INTEGER) as hora, COUNT(*) as total
        FROM historial_envios WHERE user_id = ? AND fecha >= date('now', '-' || ? || ' days')
        GROUP BY hora ORDER BY hora ASC
    `).all(String(userId), dias);
}

function getAnalyticsTasaPorCuenta(userId) {
    return db.prepare(`
        SELECT cuenta, COUNT(*) as total,
        SUM(CASE WHEN estado = 'exitoso' OR estado = 'ok' THEN 1 ELSE 0 END) as exitosos,
        ROUND(SUM(CASE WHEN estado = 'exitoso' OR estado = 'ok' THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) as tasa
        FROM historial_envios WHERE user_id = ? GROUP BY cuenta ORDER BY tasa DESC
    `).all(String(userId));
}

function getAnalyticsClientesActivos(dias = 7) {
    return db.prepare(`
        SELECT user_id, COUNT(*) as envios,
        SUM(CASE WHEN estado = 'exitoso' OR estado = 'ok' THEN 1 ELSE 0 END) as exitosos
        FROM historial_envios WHERE fecha >= date('now', '-' || ? || ' days')
        GROUP BY user_id ORDER BY envios DESC LIMIT 20
    `).all(dias);
}

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
    registrarEnvio, registrarRespuesta, getHistorialEnvios, getHistorialStats, actualizarEstadoEntrega,
    getStatsPorGrupo, getStatsRespuestas, getStatsRespuestasPorGrupo,
    limpiarHistorial, getDashboard,
    getTemplates, agregarTemplate, getTemplateById, eliminarTemplate,
    getBlacklist, agregarBlacklist, eliminarBlacklist, eliminarBlacklistById, estaEnBlacklist, limpiarBlacklist,
    // Blacklist numeros individuales
    getBlacklistNumeros, agregarBlacklistNumero, eliminarBlacklistNumero, eliminarBlacklistNumeroById, estaEnBlacklistNumero, limpiarBlacklistNumeros,
    actualizarGrupoStats, getGrupoStats, getGrupoStatsTop, getGrupoStatsWorst,
    getCampanaHorario, setCampanaHorario,
    getEnviosDiarios, incrementarEnvioDiario, getEnviosDiariosTotal,
    getCuentaEstado, marcarCuentaBaneada, desmarcarCuentaBaneada, getCuentasBaneadas,
    getSinonimos, agregarSinonimo, eliminarSinonimo, limpiarSinonimos,
    getReporteDiario,
    exportarGrupos, importarGrupos, exportarCampanas,
    panelLogin, panelRegistro, panelCambiarPassword, checkMembresia,
    getPanelUser, crearRecoveryCode, verificarRecoveryCode, panelResetPassword,
    editarTemplate, duplicarTemplate,
    getUserEnvioConfig, setUserEnvioConfig,
    getProgramados, crearProgramado, toggleProgramado, eliminarProgramado,
    getAutoRespuestas, agregarAutoRespuesta, eliminarAutoRespuesta, limpiarAutoRespuestas,
    getTasaEntrega,
    setAdmin, setTipoMembresia, getTodosUsuariosAdmin, normalizeId,
    guardarProgresoEnvio, getProgresoEnvio, getProgresoEnvioPendiente, eliminarProgresoEnvio,
    registrarEnvioCampanaDB, getUltimoEnvioCampana,
    // Programados miembros
    getProgramadosMiembros, crearProgramadoMiembros, toggleProgramadoMiembros, eliminarProgramadoMiembros, actualizarUltimoEnvioProgramado,
    // DM Stats
    getDmStats,
    // Numeros manuales
    getNumerosManuales, agregarNumeroManual, agregarNumerosManualesBulk, eliminarNumeroManual, limpiarNumerosManuales,
    // Promo escucha
    getPromoEscucha, registrarPromoEscucha, detenerPromoEscucha, registrarPromoRespuesta, getPromoRespuestas, limpiarPromoRespuestas,
    // Retry queue (Mejora 4)
    agregarRetryQueue, getRetryPendientes, getRetryPendientesGlobal, actualizarRetry, limpiarRetryCompletados, getRetryStats,
    // Promo timeout (Mejora 3)
    getPromoTimeout, setPromoTimeout,
    // Promo keywords (Mejora 7)
    getPromoKeywords, agregarPromoKeyword, eliminarPromoKeyword, limpiarPromoKeywords,
    // Promo sent tracking
    getPromoSentJids,
    // Session grupos cache
    cacheGruposSesion, getGruposCacheSesion, limpiarGruposCacheSesion, limpiarTodosGruposCacheUsuario,
    // Bot logs (Mejora 6)
    agregarLog, getLogs, limpiarLogs,
    // Grupo secciones
    setGrupoSeccion, setGrupoSeccionBulk, getSecciones,
    // Promo plantillas
    getPromoPlantillas, getPromoPlantilla, crearPromoPlantilla, editarPromoPlantilla, eliminarPromoPlantilla,
    // 2FA
    setup2FA, get2FA, enable2FA, disable2FA, verify2FACode,
    // Active sessions
    createSession, getSessions, deleteSession, deleteAllSessions, touchSession, validateSession,
    // Rate limiting
    getLoginAttempts, registrarLoginAttempt, limpiarLoginAttempts,
    // Audit log
    registrarAuditoria, getAuditLog, getAuditLogByUser,
    // Cleanup
    limpiarRecoveryCodes, limpiarSessionsExpiradas,
    // Grupo actividad persistencia
    registrarActividadGrupoDB, getUltimaActividadGrupo,
    // Export/Import config
    exportFullConfig, importFullConfig,
    // Dashboard extended
    getDashboardExtended,
    // Sellers (Revendedores)
    crearSeller, getSeller, getSellerById, getTodosSellers, editarSeller, eliminarSeller,
    getSellerInvitesCount, getSellerInvites, registrarSellerInvite, isSellerUser,
    // Seller codes
    generarSellerCode, getSellerCodes, getSellerCodesPendientes, canjearSellerCode, eliminarSellerCode,
    // Pagos (Binance Pay)
    crearPago, getPago, getPagoPorPrepayId, actualizarPagoPrepay,
    marcarPagoPagado, marcarPagoExpirado, marcarPagoCancelado,
    getPagosUsuario, getPagosPendientes, getTodosPagosAdmin, getPagosStats,
    // Comprobantes (pago manual)
    crearComprobante, getComprobante, getComprobantesUsuario, getComprobantesPendientes,
    getTodosComprobantes, aprobarComprobante, rechazarComprobante, getComprobantesStats,
    // Metodos de pago (admin configurable)
    getMetodosPago, getMetodosPagoActivos, crearMetodoPago, editarMetodoPago, eliminarMetodoPago, initDefaultMetodosPago, setMetodoPagoQr, getMetodoPago,
    // Push notifications
    addPushSubscription, getPushSubscriptions, removePushSubscription, getAllPushSubscriptions,
    // Tickets
    crearTicket, getTicket, getTicketsUsuario, getTicketsPendientes, getTodosTickets,
    agregarMensajeTicket, getMensajesTicket, cerrarTicket, getTicketsStats,
    // Webhooks
    crearWebhook, getWebhooks, editarWebhook, eliminarWebhook, getWebhooksActivos,
    // Backup log
    registrarBackup, getBackupLog, limpiarBackupsViejos,
    // Analytics
    getAnalyticsEnviosPorDia, getAnalyticsHorasActivas, getAnalyticsTasaPorCuenta, getAnalyticsClientesActivos,
};
