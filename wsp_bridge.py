"""Puente para controlar el bot de WhatsApp desde el bot de Telegram via API REST."""
import aiohttp
import logging

logger = logging.getLogger(__name__)

WSP_API_URL = "http://localhost:3000"

async def _get(path, params=None):
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{WSP_API_URL}{path}", params=params, timeout=aiohttp.ClientTimeout(total=15)) as r:
                return await r.json()
    except Exception as e:
        logger.error(f"WSP API GET {path} error: {e}")
        return {"ok": False, "error": str(e)}

async def _post(path, data=None):
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{WSP_API_URL}{path}", json=data, timeout=aiohttp.ClientTimeout(total=15)) as r:
                return await r.json()
    except Exception as e:
        logger.error(f"WSP API POST {path} error: {e}")
        return {"ok": False, "error": str(e)}

# --- STATUS ---
async def wsp_status():
    return await _get("/api/status")

# --- GRUPOS ---
async def wsp_grupos(user_id):
    return await _get("/api/grupos", {"u": str(user_id)})

async def wsp_agregar_grupo(user_id, link):
    return await _post("/api/grupos/add", {"u": str(user_id), "link": link})

async def wsp_eliminar_grupo(user_id, grupo_id):
    return await _post("/api/grupos/del", {"u": str(user_id), "id": grupo_id})

async def wsp_eliminar_todos_grupos(user_id):
    return await _post("/api/grupos/delall", {"u": str(user_id)})

# --- SESIONES / CUENTAS ---
async def wsp_sesiones(user_id):
    return await _get("/api/sesiones", {"u": str(user_id)})

async def wsp_vincular(user_id, nombre):
    return await _post("/api/vincular", {"u": str(user_id), "nombre": nombre})

# --- CAMPANAS ---
async def wsp_campanas(user_id):
    return await _get("/api/campanas", {"u": str(user_id)})

async def wsp_crear_campana(user_id, nombre, mensaje):
    return await _post("/api/campanas/crear", {"u": str(user_id), "nombre": nombre, "mensaje": mensaje})

async def wsp_eliminar_campana(campana_id):
    return await _post("/api/campanas/del", {"id": campana_id})

async def wsp_editar_campana(campana_id, mensaje, imagen=None):
    return await _post("/api/campanas/editar", {"id": campana_id, "mensaje": mensaje, "imagen": imagen})

async def wsp_detalle_campana(campana_id):
    return await _get("/api/campanas/detalle", {"id": str(campana_id)})

async def wsp_clonar_campana(campana_id, user_id):
    return await _post("/api/campanas/clonar", {"id": campana_id, "u": str(user_id)})

async def wsp_reset_campana(campana_id):
    return await _post("/api/campanas/reset", {"id": campana_id})

# --- SESIONES ---
async def wsp_eliminar_sesion(user_id, nombre):
    return await _post("/api/sesiones/del", {"u": str(user_id), "nombre": nombre})

# --- GRUPOS EXTRA ---
async def wsp_editar_grupo(user_id, grupo_id, link):
    return await _post("/api/grupos/edit", {"u": str(user_id), "id": grupo_id, "link": link})

# --- CONTROL ---
async def wsp_iniciar(user_id, campana_id):
    return await _post("/api/iniciar", {"u": str(user_id), "id": campana_id})

async def wsp_detener(campana_id):
    return await _post("/api/detener", {"id": campana_id})

async def wsp_activas():
    return await _get("/api/activas")

# --- INFO ---
async def wsp_historial(user_id):
    return await _get("/api/historial", {"u": str(user_id)})

async def wsp_dashboard(user_id):
    return await _get("/api/dashboard", {"u": str(user_id)})

async def wsp_detectar_grupos(user_id):
    return await _get("/api/detectar", {"u": str(user_id)})

# --- MEMBRESIA ---
async def wsp_usuarios_todos():
    return await _get("/api/usuarios/todos")

async def wsp_usuario(wsp_id):
    return await _get("/api/usuarios", {"u": str(wsp_id)})

async def wsp_activar(wsp_id, dias):
    return await _post("/api/activar", {"wsp_id": str(wsp_id), "dias": int(dias)})

async def wsp_desactivar(wsp_id):
    return await _post("/api/desactivar", {"wsp_id": str(wsp_id)})
