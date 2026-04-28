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

# --- ENVIO PERSONAL ---
async def wsp_chats_personales(user_id):
    return await _get("/api/chats_personales", {"u": str(user_id)})

async def wsp_enviar_personal(user_id, mensaje):
    return await _post("/api/enviar_personal", {"u": str(user_id), "mensaje": mensaje})

async def wsp_cancelar_envio_personal(user_id):
    return await _post("/api/cancelar_envio_personal", {"u": str(user_id)})

# --- ENVIO A MIEMBROS DE GRUPO ---
async def wsp_miembros_grupo(user_id, grupo_jid):
    return await _get("/api/miembros_grupo", {"u": str(user_id), "grupo": grupo_jid})

async def wsp_enviar_miembros(user_id, grupo_jid, mensaje):
    return await _post("/api/enviar_miembros", {"u": str(user_id), "grupo": grupo_jid, "mensaje": mensaje})

async def wsp_agregar_miembros(user_id, grupo_origen, grupo_destino):
    return await _post("/api/agregar_miembros", {"u": str(user_id), "origen": grupo_origen, "destino": grupo_destino})

# --- CONFIG DE ENVIO ---
async def wsp_get_envio_config(user_id):
    return await _get("/api/envio_config", {"u": str(user_id)})

async def wsp_set_envio_config(user_id, **kwargs):
    data = {"u": str(user_id)}
    data.update(kwargs)
    return await _post("/api/envio_config", data)

# --- LISTA NEGRA ---
async def wsp_get_lista_negra(user_id):
    return await _get("/api/lista_negra", {"u": str(user_id)})

async def wsp_lista_negra_accion(user_id, accion, numero=None, razon=None):
    data = {"u": str(user_id), "accion": accion}
    if numero: data["numero"] = numero
    if razon: data["razon"] = razon
    return await _post("/api/lista_negra", data)

# --- ENVIAR A LISTA DE NUMEROS ---
async def wsp_enviar_a_lista(user_id, numeros, mensaje, media_path=None):
    data = {"u": str(user_id), "numeros": numeros, "mensaje": mensaje}
    if media_path: data["media_path"] = media_path
    return await _post("/api/enviar_a_lista", data)

# --- REPORTE DIARIO ---
async def wsp_reporte_diario(user_id):
    return await _get("/api/reporte_diario", {"u": str(user_id)})

# --- DETECTAR GRUPOS (VIA CUENTA CLIENTE) ---
async def wsp_detectar_cliente(user_id, cuenta=None):
    params = {"u": str(user_id)}
    if cuenta:
        params["cuenta"] = cuenta
    return await _get("/api/detectar_cliente", params)

# --- MENSAJES ---
async def wsp_mensajes(user_id):
    return await _get("/api/mensajes", {"u": str(user_id)})

async def wsp_crear_mensaje(user_id, nombre, texto, imagen_path=None):
    data = {"u": str(user_id), "nombre": nombre, "texto": texto}
    if imagen_path:
        data["imagen_path"] = imagen_path
    return await _post("/api/mensajes/crear", data)

async def wsp_editar_mensaje(mensaje_id, texto, imagen_path=None):
    data = {"id": mensaje_id, "texto": texto}
    if imagen_path is not None:
        data["imagen_path"] = imagen_path
    return await _post("/api/mensajes/editar", data)

async def wsp_eliminar_mensaje(mensaje_id):
    return await _post("/api/mensajes/del", {"id": mensaje_id})

# --- ENVIO UNICO ---
async def wsp_enviar_unico(user_id, mensaje_id, grupos_seleccionados=None):
    data = {"u": str(user_id), "mensaje_id": mensaje_id}
    if grupos_seleccionados:
        data["grupos_seleccionados"] = grupos_seleccionados
    return await _post("/api/enviar_unico", data)

async def wsp_envios_unicos(user_id):
    return await _get("/api/envios_unicos", {"u": str(user_id)})

# --- DUPLICAR MENSAJE ---
async def wsp_duplicar_mensaje(mensaje_id):
    return await _post("/api/mensajes/duplicar", {"id": mensaje_id})

# --- ENVIOS PROGRAMADOS ---
async def wsp_programados(user_id):
    return await _get("/api/programados", {"u": str(user_id)})

async def wsp_crear_programado(user_id, mensaje_id, hora, minuto, repetir=False):
    return await _post("/api/programados/crear", {
        "u": str(user_id), "mensaje_id": mensaje_id,
        "hora": hora, "minuto": minuto, "repetir": repetir
    })

async def wsp_toggle_programado(prog_id, activo):
    return await _post("/api/programados/toggle", {"id": prog_id, "activo": activo})

async def wsp_eliminar_programado(prog_id):
    return await _post("/api/programados/del", {"id": prog_id})

# --- STATS POR GRUPO ---
async def wsp_grupo_stats(user_id):
    return await _get("/api/grupo_stats", {"u": str(user_id)})

# --- AUTO-UNIRSE A GRUPOS ---
async def wsp_autojoin(user_id, links, cuenta=None):
    data = {"u": str(user_id), "links": links}
    if cuenta:
        data["cuenta"] = cuenta
    return await _post("/api/autojoin", data)
