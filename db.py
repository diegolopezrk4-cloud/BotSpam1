import aiosqlite
import os
from datetime import datetime, timedelta, timezone

# Zona horaria de Peru (UTC-5)
PERU_TZ = timezone(timedelta(hours=-5))
def ahora_peru():
    return datetime.now(PERU_TZ)

DB_PATH = "titan.db"
DB_TIMEOUT = 30

def _connect():
    return aiosqlite.connect(DB_PATH, timeout=DB_TIMEOUT)

# ─────────────────────────────────────────
#   INICIALIZACIÓN DE LA BASE DE DATOS
# ─────────────────────────────────────────
async def init_db():
    async with _connect() as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA busy_timeout=30000")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS usuarios (
                telegram_id INTEGER PRIMARY KEY,
                username TEXT,
                plan TEXT DEFAULT 'sin_plan',
                fecha_expira TEXT DEFAULT NULL,
                activo INTEGER DEFAULT 0,
                fecha_registro TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sesiones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                nombre TEXT,
                telefono TEXT,
                activa INTEGER DEFAULT 1,
                fecha_registro TEXT DEFAULT (datetime('now')),
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS campanas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                nombre TEXT,
                mensaje TEXT,
                foto_path TEXT DEFAULT NULL,
                activa INTEGER DEFAULT 0,
                enviados INTEGER DEFAULT 0,
                errores INTEGER DEFAULT 0,
                inicio TEXT DEFAULT NULL,
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS campana_sesiones (
                campana_id INTEGER,
                sesion_nombre TEXT,
                PRIMARY KEY(campana_id, sesion_nombre)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS grupos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                link TEXT,
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS campana_grupos (
                campana_id INTEGER,
                grupo_link TEXT,
                PRIMARY KEY(campana_id, grupo_link)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS campana_config (
                campana_id INTEGER PRIMARY KEY,
                intervalo_min INTEGER DEFAULT 30,
                intervalo_max INTEGER DEFAULT 60,
                FOREIGN KEY(campana_id) REFERENCES campanas(id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS limites_usuario (
                user_id INTEGER PRIMARY KEY,
                max_grupos INTEGER DEFAULT 25,
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS responder_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                contacto TEXT,
                activo INTEGER DEFAULT 0,
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS responder_keywords (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                palabra TEXT,
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS historial_envios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                campana_id INTEGER,
                grupo_link TEXT,
                resultado TEXT DEFAULT 'enviado',
                fecha TEXT DEFAULT (datetime('now')),
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS historial_respuestas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                grupo_link TEXT,
                keyword TEXT,
                fecha TEXT DEFAULT (datetime('now')),
                FOREIGN KEY(user_id) REFERENCES usuarios(telegram_id)
            )
        """)
        await db.commit()

# ─────────────────────────────────────────
#   USUARIOS
# ─────────────────────────────────────────
async def get_usuario(telegram_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM usuarios WHERE telegram_id=?", (telegram_id,)) as cur:
            return await cur.fetchone()

async def crear_usuario(telegram_id, username):
    async with _connect() as db:
        await db.execute(
            "INSERT OR IGNORE INTO usuarios (telegram_id, username) VALUES (?,?)",
            (telegram_id, username)
        )
        await db.execute(
            "UPDATE usuarios SET username=? WHERE telegram_id=?",
            (username, telegram_id)
        )
        await db.commit()

async def activar_membresia(telegram_id, dias):
    expira = (ahora_peru() + timedelta(days=dias)).strftime("%Y-%m-%d %H:%M:%S")
    plan = "diario" if dias == 1 else ("semanal" if dias == 7 else "mensual")
    async with _connect() as db:
        await db.execute(
            "UPDATE usuarios SET plan=?, fecha_expira=?, activo=1 WHERE telegram_id=?",
            (plan, expira, telegram_id)
        )
        await db.commit()

async def tiene_membresia_activa(telegram_id):
    user = await get_usuario(telegram_id)
    if not user or not user["activo"]:
        return False
    if user["fecha_expira"]:
        try:
            expira = datetime.strptime(user["fecha_expira"], "%Y-%m-%d %H:%M:%S")
            if ahora_peru().replace(tzinfo=None) > expira:
                async with _connect() as db:
                    await db.execute(
                        "UPDATE usuarios SET activo=0, plan='expirado' WHERE telegram_id=?",
                        (telegram_id,)
                    )
                    await db.commit()
                return False
        except ValueError:
            return False
    return True

async def get_todos_usuarios():
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM usuarios ORDER BY fecha_registro DESC") as cur:
            return await cur.fetchall()

# ─────────────────────────────────────────
#   SESIONES / CUENTAS
# ─────────────────────────────────────────
async def get_sesiones(user_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM sesiones WHERE user_id=? AND activa=1", (user_id,)) as cur:
            return await cur.fetchall()

async def agregar_sesion(user_id, nombre, telefono):
    async with _connect() as db:
        async with db.execute(
            "SELECT id FROM sesiones WHERE user_id=? AND nombre=? AND activa=1",
            (user_id, nombre)
        ) as cur:
            existente = await cur.fetchone()
        if existente:
            await db.execute(
                "UPDATE sesiones SET telefono=? WHERE user_id=? AND nombre=? AND activa=1",
                (telefono, user_id, nombre)
            )
        else:
            await db.execute(
                "INSERT INTO sesiones (user_id, nombre, telefono) VALUES (?,?,?)",
                (user_id, nombre, telefono)
            )
        await db.commit()

async def eliminar_sesion(user_id, nombre):
    async with _connect() as db:
        await db.execute(
            "DELETE FROM sesiones WHERE user_id=? AND nombre=?",
            (user_id, nombre)
        )
        await db.execute(
            "DELETE FROM campana_sesiones WHERE sesion_nombre=?",
            (nombre,)
        )
        await db.commit()

# ─────────────────────────────────────────
#   GRUPOS
# ─────────────────────────────────────────
async def get_grupos(user_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM grupos WHERE user_id=?", (user_id,)) as cur:
            return await cur.fetchall()

async def agregar_grupo(user_id, link):
    async with _connect() as db:
        async with db.execute(
            "SELECT id FROM grupos WHERE user_id=? AND link=?",
            (user_id, link)
        ) as cur:
            existente = await cur.fetchone()
        if not existente:
            await db.execute(
                "INSERT INTO grupos (user_id, link) VALUES (?,?)",
                (user_id, link)
            )
            await db.commit()

async def eliminar_grupo(user_id, grupo_id):
    async with _connect() as db:
        async with db.execute(
            "SELECT link FROM grupos WHERE id=? AND user_id=?",
            (grupo_id, user_id)
        ) as cur:
            grupo = await cur.fetchone()
        if grupo:
            await db.execute(
                "DELETE FROM campana_grupos WHERE grupo_link=?",
                (grupo[0],)
            )
        await db.execute(
            "DELETE FROM grupos WHERE id=? AND user_id=?",
            (grupo_id, user_id)
        )
        await db.commit()

async def eliminar_grupo_por_link(user_id, link):
    """Elimina un grupo por su link (usado cuando se detecta ban/sin permiso)."""
    async with _connect() as db:
        await db.execute(
            "DELETE FROM campana_grupos WHERE grupo_link=?",
            (link,)
        )
        await db.execute(
            "DELETE FROM grupos WHERE user_id=? AND link=?",
            (user_id, link)
        )
        await db.commit()

async def actualizar_grupo_link(user_id, grupo_id, nuevo_link):
    async with _connect() as db:
        async with db.execute(
            "SELECT link FROM grupos WHERE id=? AND user_id=?",
            (grupo_id, user_id)
        ) as cur:
            grupo = await cur.fetchone()
        if grupo:
            viejo_link = grupo[0]
            await db.execute(
                "UPDATE campana_grupos SET grupo_link=? WHERE grupo_link=?",
                (nuevo_link, viejo_link)
            )
        await db.execute(
            "UPDATE grupos SET link=? WHERE id=? AND user_id=?",
            (nuevo_link, grupo_id, user_id)
        )
        await db.commit()

async def eliminar_todos_grupos(user_id):
    """Elimina todos los grupos de un usuario."""
    async with _connect() as db:
        grupos = await get_grupos(user_id)
        for g in grupos:
            await db.execute("DELETE FROM campana_grupos WHERE grupo_link=?", (g['link'],))
        await db.execute("DELETE FROM grupos WHERE user_id=?", (user_id,))
        await db.commit()

# ─────────────────────────────────────────
#   CAMPAÑAS
# ─────────────────────────────────────────
async def get_campanas(user_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM campanas WHERE user_id=?", (user_id,)) as cur:
            return await cur.fetchall()

async def crear_campana(user_id, nombre, mensaje, foto_path=None):
    async with _connect() as db:
        cur = await db.execute(
            "INSERT INTO campanas (user_id, nombre, mensaje, foto_path) VALUES (?,?,?,?)",
            (user_id, nombre, mensaje, foto_path)
        )
        await db.commit()
        return cur.lastrowid

async def get_campana_by_id(campana_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM campanas WHERE id=?", (campana_id,)) as cur:
            return await cur.fetchone()

async def actualizar_stats_campana(campana_id, enviados, errores):
    async with _connect() as db:
        await db.execute(
            "UPDATE campanas SET enviados=enviados+?, errores=errores+? WHERE id=?",
            (enviados, errores, campana_id)
        )
        await db.commit()

async def set_campana_activa(campana_id, activa):
    async with _connect() as db:
        if activa:
            await db.execute(
                "UPDATE campanas SET activa=1, inicio=? WHERE id=?",
                (ahora_peru().strftime("%Y-%m-%d %H:%M:%S"), campana_id)
            )
        else:
            await db.execute("UPDATE campanas SET activa=0 WHERE id=?", (campana_id,))
        await db.commit()

async def actualizar_campana_mensaje(campana_id, mensaje, foto_path):
    async with _connect() as db:
        if foto_path:
            await db.execute(
                "UPDATE campanas SET mensaje=?, foto_path=? WHERE id=?",
                (mensaje, foto_path, campana_id)
            )
        else:
            await db.execute(
                "UPDATE campanas SET mensaje=? WHERE id=?",
                (mensaje, campana_id)
            )
        await db.commit()

async def eliminar_campana(campana_id):
    async with _connect() as db:
        await db.execute("DELETE FROM campanas WHERE id=?", (campana_id,))
        await db.execute("DELETE FROM campana_grupos WHERE campana_id=?", (campana_id,))
        await db.execute("DELETE FROM campana_sesiones WHERE campana_id=?", (campana_id,))
        await db.execute("DELETE FROM campana_config WHERE campana_id=?", (campana_id,))
        await db.commit()

async def clonar_campana(user_id, campana_id, nuevo_nombre):
    """Clona una campaña existente con un nuevo nombre."""
    original = await get_campana_by_id(campana_id)
    if not original:
        return None
    nuevo_id = await crear_campana(user_id, nuevo_nombre, original['mensaje'], original['foto_path'])
    # Copiar sesiones asignadas
    sesiones = await get_sesiones_campana(campana_id)
    for s in sesiones:
        await agregar_sesion_campana(nuevo_id, s)
    # Copiar grupos asignados
    grupos = await get_grupos_campana(campana_id)
    for g in grupos:
        await agregar_grupo_campana(nuevo_id, g)
    # Copiar config
    config = await get_campana_config(campana_id)
    await set_campana_config(nuevo_id, config['intervalo_min'], config['intervalo_max'])
    return nuevo_id

async def resetear_stats_campana(campana_id):
    """Resetea los contadores de enviados y errores de una campaña."""
    async with _connect() as db:
        await db.execute(
            "UPDATE campanas SET enviados=0, errores=0 WHERE id=?",
            (campana_id,)
        )
        await db.commit()

# ─────────────────────────────────────────
#   CAMPAÑAS ↔ SESIONES
# ─────────────────────────────────────────
async def get_sesiones_campana(campana_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT sesion_nombre FROM campana_sesiones WHERE campana_id=?",
            (campana_id,)
        ) as cur:
            return [r["sesion_nombre"] for r in await cur.fetchall()]

async def agregar_sesion_campana(campana_id, sesion_nombre):
    async with _connect() as db:
        await db.execute(
            "INSERT OR IGNORE INTO campana_sesiones (campana_id, sesion_nombre) VALUES (?,?)",
            (campana_id, sesion_nombre)
        )
        await db.commit()

# ─────────────────────────────────────────
#   CAMPAÑAS ↔ GRUPOS
# ─────────────────────────────────────────
async def get_grupos_campana(campana_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT grupo_link FROM campana_grupos WHERE campana_id=?",
            (campana_id,)
        ) as cur:
            return [r["grupo_link"] for r in await cur.fetchall()]

async def agregar_grupo_campana(campana_id, grupo_link):
    async with _connect() as db:
        await db.execute(
            "INSERT OR IGNORE INTO campana_grupos (campana_id, grupo_link) VALUES (?,?)",
            (campana_id, grupo_link)
        )
        await db.commit()

# ─────────────────────────────────────────
#   CONFIGURACIÓN DE CAMPAÑA (INTERVALO)
# ─────────────────────────────────────────
async def get_campana_config(campana_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM campana_config WHERE campana_id=?", (campana_id,)
        ) as cur:
            row = await cur.fetchone()
            if row:
                return dict(row)
            return {"intervalo_min": 30, "intervalo_max": 60}

async def set_campana_config(campana_id, intervalo_min, intervalo_max):
    async with _connect() as db:
        await db.execute(
            "INSERT OR REPLACE INTO campana_config (campana_id, intervalo_min, intervalo_max) VALUES (?,?,?)",
            (campana_id, intervalo_min, intervalo_max)
        )
        await db.commit()

# ─────────────────────────────────────────
#   LÍMITES DE GRUPOS POR USUARIO
# ─────────────────────────────────────────
async def get_max_grupos(user_id):
    async with _connect() as db:
        async with db.execute(
            "SELECT max_grupos FROM limites_usuario WHERE user_id=?", (user_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else 25

async def set_max_grupos(user_id, limite):
    async with _connect() as db:
        await db.execute(
            "INSERT OR REPLACE INTO limites_usuario (user_id, max_grupos) VALUES (?,?)",
            (user_id, limite)
        )
        await db.commit()

# ─────────────────────────────────────────
#   AUTO-RESPONDER
# ─────────────────────────────────────────
async def get_responder_config(user_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM responder_config WHERE user_id=?", (user_id,)
        ) as cur:
            return await cur.fetchone()

async def set_responder_config(user_id, contacto, activo=1):
    async with _connect() as db:
        existing = await get_responder_config(user_id)
        if existing:
            await db.execute(
                "UPDATE responder_config SET contacto=?, activo=? WHERE user_id=?",
                (contacto, activo, user_id)
            )
        else:
            await db.execute(
                "INSERT INTO responder_config (user_id, contacto, activo) VALUES (?,?,?)",
                (user_id, contacto, activo)
            )
        await db.commit()

async def toggle_responder(user_id, activo):
    async with _connect() as db:
        await db.execute(
            "UPDATE responder_config SET activo=? WHERE user_id=?",
            (activo, user_id)
        )
        await db.commit()

async def get_keywords(user_id):
    async with _connect() as db:
        async with db.execute(
            "SELECT palabra FROM responder_keywords WHERE user_id=?", (user_id,)
        ) as cur:
            return [r[0] for r in await cur.fetchall()]

async def agregar_keywords(user_id, palabras):
    async with _connect() as db:
        for p in palabras:
            p = p.strip().lower()
            if p:
                await db.execute(
                    "INSERT OR IGNORE INTO responder_keywords (user_id, palabra) VALUES (?,?)",
                    (user_id, p)
                )
        await db.commit()

async def limpiar_keywords(user_id):
    async with _connect() as db:
        await db.execute(
            "DELETE FROM responder_keywords WHERE user_id=?", (user_id,)
        )
        await db.commit()

async def get_all_responder_activos():
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM responder_config WHERE activo=1"
        ) as cur:
            return await cur.fetchall()

# ─────────────────────────────────────────
#   HISTORIAL
# ─────────────────────────────────────────
async def registrar_envio(user_id, campana_id, grupo_link, resultado="enviado"):
    async with _connect() as db:
        await db.execute(
            "INSERT INTO historial_envios (user_id, campana_id, grupo_link, resultado) VALUES (?,?,?,?)",
            (user_id, campana_id, grupo_link, resultado)
        )
        await db.commit()

async def registrar_respuesta(user_id, grupo_link, keyword):
    async with _connect() as db:
        await db.execute(
            "INSERT INTO historial_respuestas (user_id, grupo_link, keyword) VALUES (?,?,?)",
            (user_id, grupo_link, keyword)
        )
        await db.commit()

async def get_historial_envios(user_id, limite=50):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT grupo_link, resultado, datetime(fecha, '-5 hours') as fecha FROM historial_envios "
            "WHERE user_id=? ORDER BY fecha DESC LIMIT ?",
            (user_id, limite)
        ) as cur:
            return await cur.fetchall()

async def get_stats_por_grupo(user_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT grupo_link, "
            "SUM(CASE WHEN resultado='enviado' THEN 1 ELSE 0 END) as enviados, "
            "SUM(CASE WHEN resultado!='enviado' THEN 1 ELSE 0 END) as errores, "
            "datetime(MAX(fecha), '-5 hours') as ultimo_envio "
            "FROM historial_envios WHERE user_id=? "
            "GROUP BY grupo_link ORDER BY enviados DESC",
            (user_id,)
        ) as cur:
            return await cur.fetchall()

async def get_stats_respuestas(user_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT keyword, COUNT(*) as total, "
            "datetime(MAX(fecha), '-5 hours') as ultima "
            "FROM historial_respuestas WHERE user_id=? "
            "GROUP BY keyword ORDER BY total DESC",
            (user_id,)
        ) as cur:
            return await cur.fetchall()

async def get_stats_respuestas_por_grupo(user_id):
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT grupo_link, COUNT(*) as total, "
            "datetime(MAX(fecha), '-5 hours') as ultima "
            "FROM historial_respuestas WHERE user_id=? "
            "GROUP BY grupo_link ORDER BY total DESC",
            (user_id,)
        ) as cur:
            return await cur.fetchall()

async def limpiar_historial(user_id):
    """Elimina todo el historial de envios y respuestas de un usuario."""
    async with _connect() as db:
        await db.execute("DELETE FROM historial_envios WHERE user_id=?", (user_id,))
        await db.execute("DELETE FROM historial_respuestas WHERE user_id=?", (user_id,))
        await db.commit()

async def get_dashboard(user_id):
    """Retorna un resumen rapido del usuario."""
    sesiones = await get_sesiones(user_id)
    grupos = await get_grupos(user_id)
    campanas = await get_campanas(user_id)
    config = await get_responder_config(user_id)
    keywords = await get_keywords(user_id)

    total_enviados = sum(c['enviados'] for c in campanas)
    total_errores = sum(c['errores'] for c in campanas)
    activas = sum(1 for c in campanas if c['activa'])

    return {
        "cuentas": len(sesiones),
        "grupos": len(grupos),
        "campanas": len(campanas),
        "campanas_activas": activas,
        "total_enviados": total_enviados,
        "total_errores": total_errores,
        "responder_activo": bool(config and config['activo']),
        "keywords": len(keywords),
    }


async def get_all_users_with_active_campaigns():
    """Retorna lista de (user_id, campana_id) de campanas activas."""
    async with _connect() as db:
        async with db.execute(
            "SELECT user_id, id FROM campanas WHERE activa=1"
        ) as cur:
            return await cur.fetchall()

