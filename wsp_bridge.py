"""Puente para controlar el bot de WhatsApp desde el bot de Telegram via API REST."""
import asyncio
import aiohttp
import logging

logger = logging.getLogger(__name__)

WSP_API_URL = "http://localhost:3000"

INTERNAL_HEADERS = {"x-internal-service": "telegram-bot"}

async def _get(path, params=None, timeout=15):
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{WSP_API_URL}{path}", params=params, headers=INTERNAL_HEADERS, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                return await r.json()
    except asyncio.TimeoutError:
        logger.error(f"WSP API GET {path} timeout ({timeout}s)")
        return {"ok": False, "error": f"API WSP no responde (timeout {timeout}s)"}
    except aiohttp.ClientConnectorError:
        logger.error(f"WSP API GET {path} connection refused")
        return {"ok": False, "error": "API WSP no disponible (puerto 3000 no responde)"}
    except Exception as e:
        logger.error(f"WSP API GET {path} error: {e}")
        return {"ok": False, "error": str(e) or type(e).__name__}

async def _post(path, data=None, timeout=15):
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{WSP_API_URL}{path}", json=data, headers=INTERNAL_HEADERS, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                return await r.json()
    except asyncio.TimeoutError:
        logger.error(f"WSP API POST {path} timeout ({timeout}s)")
        return {"ok": False, "error": f"API WSP no responde (timeout {timeout}s)"}
    except aiohttp.ClientConnectorError:
        logger.error(f"WSP API POST {path} connection refused")
        return {"ok": False, "error": "API WSP no disponible (puerto 3000 no responde)"}
    except Exception as e:
        logger.error(f"WSP API POST {path} error: {e}")
        return {"ok": False, "error": str(e) or type(e).__name__}

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

async def wsp_desvincular(user_id, nombre):
    return await _post("/api/desvincular", {"u": str(user_id), "nombre": nombre})

# --- MEMBRESIA SYNC ---
async def wsp_admin_desactivar(telegram_id):
    return await _post("/api/admin/desactivar", {"admin_id": str(8001675901), "telegram_id": str(telegram_id)})

async def wsp_admin_ban(telegram_id):
    return await _post("/api/admin/ban", {"admin_id": str(8001675901), "telegram_id": str(telegram_id)})

# --- CAMPANAS ---
async def wsp_campanas(user_id):
    return await _get("/api/campanas", {"u": str(user_id)})

async def wsp_crear_campana(user_id, nombre, mensaje):
    return await _post("/api/campanas/crear", {"u": str(user_id), "nombre": nombre, "mensaje": mensaje})

async def wsp_eliminar_campana(campana_id):
    return await _post("/api/campanas/del", {"id": campana_id})

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

async def wsp_detectar_grupos(user_id, cuenta=None):
    params = {"u": str(user_id)}
    if cuenta:
        params["cuenta"] = cuenta
    return await _get("/api/detectar", params, timeout=90)

# --- MEMBRESIA ---
async def wsp_usuarios_todos():
    return await _get("/api/usuarios/todos")

async def wsp_usuario(wsp_id):
    return await _get("/api/usuarios", {"u": str(wsp_id)})

async def wsp_activar(wsp_id, dias):
    return await _post("/api/activar", {"wsp_id": str(wsp_id), "dias": int(dias)})

async def wsp_desactivar(wsp_id):
    return await _post("/api/desactivar", {"wsp_id": str(wsp_id)})

# --- ENVIO PERSONAL ---
async def wsp_enviar_personal(user_id, mensaje):
    return await _post("/api/enviar_personal", {"u": str(user_id), "mensaje": mensaje})

async def wsp_cancelar_envio_personal(user_id):
    return await _post("/api/cancelar_envio_personal", {"u": str(user_id)})

# --- MENSAJES / TEMPLATES ---
async def wsp_mensajes(user_id):
    return await _get("/api/mensajes", {"u": str(user_id)})

async def wsp_crear_mensaje(user_id, nombre, texto):
    return await _post("/api/mensajes/crear", {"u": str(user_id), "nombre": nombre, "texto": texto})

async def wsp_editar_mensaje(user_id, msg_id, nombre=None, texto=None):
    data = {"u": str(user_id), "id": msg_id}
    if nombre: data["nombre"] = nombre
    if texto: data["texto"] = texto
    return await _post("/api/mensajes/editar", data)

async def wsp_eliminar_mensaje(user_id, msg_id):
    return await _post("/api/mensajes/del", {"u": str(user_id), "id": msg_id})

# --- LISTA NEGRA ---
async def wsp_lista_negra(user_id):
    return await _get("/api/lista_negra", {"u": str(user_id)})

async def wsp_agregar_blacklist(user_id, numero):
    return await _post("/api/lista_negra", {"u": str(user_id), "accion": "agregar", "numero": numero})

async def wsp_eliminar_blacklist(user_id, numero):
    return await _post("/api/lista_negra", {"u": str(user_id), "accion": "eliminar", "numero": numero})

async def wsp_limpiar_blacklist(user_id):
    return await _post("/api/lista_negra", {"u": str(user_id), "accion": "limpiar"})

# --- AUTO RESPUESTAS ---
async def wsp_auto_respuestas(user_id):
    return await _get("/api/auto_respuestas", {"u": str(user_id)})

async def wsp_agregar_auto_respuesta(user_id, palabra, respuesta):
    return await _post("/api/auto_respuestas", {"u": str(user_id), "accion": "agregar", "palabra": palabra, "respuesta": respuesta})

async def wsp_eliminar_auto_respuesta(user_id, ar_id):
    return await _post("/api/auto_respuestas", {"u": str(user_id), "accion": "eliminar", "id": ar_id})

# --- CONFIG ENVIO ---
async def wsp_envio_config(user_id):
    return await _get("/api/envio_config", {"u": str(user_id)})

async def wsp_set_envio_config(user_id, config):
    data = {"u": str(user_id)}
    data.update(config)
    return await _post("/api/envio_config", data)

# --- STATS ---
async def wsp_grupo_stats(user_id):
    return await _get("/api/grupo_stats", {"u": str(user_id)})

# --- REPORTE ---
async def wsp_reporte_diario(user_id):
    return await _get("/api/reporte_diario", {"u": str(user_id)})

# --- PROGRAMADOS ---
async def wsp_programados(user_id):
    return await _get("/api/programados", {"u": str(user_id)})

# --- ENVIAR A MIEMBROS ---
async def wsp_enviar_miembros(user_id, grupo, mensaje):
    return await _post("/api/enviar_miembros", {"u": str(user_id), "grupo": grupo, "mensaje": mensaje})

# --- DETECTAR GRUPOS CLIENTE ---
async def wsp_detectar_cliente(user_id):
    return await _get("/api/detectar_cliente", {"u": str(user_id)})

# --- DASHBOARD EXTENDED ---
async def wsp_dashboard_extended(user_id):
    return await _get("/api/dashboard/extended", {"u": str(user_id)})

# --- BACKUP / RESTORE ---
async def wsp_config_exportar(user_id):
    return await _get("/api/config/exportar", {"u": str(user_id)})

async def wsp_config_importar(user_id, data):
    return await _post("/api/config/importar", {"u": str(user_id), "data": data})

# --- 2FA STATUS ---
async def wsp_2fa_status(user_id):
    return await _get("/api/2fa/status", {"u": str(user_id)})

# --- SESSIONS ---
async def wsp_panel_sessions(user_id):
    return await _get("/api/panel_sessions", {"u": str(user_id)})
