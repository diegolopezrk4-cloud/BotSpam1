"""
API backend de Telegram para el panel web J&D.
Sirve las rutas /api/tg-auth/*, /api/sesiones_tg*, /api/tg/* que panel.html consume.
Puerto: 3002 (panel_server.js las proxea aqui).
"""
import asyncio
import os
import re
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta

from aiohttp import web
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

import db
from motor import (iniciar_campana, detener_campana, tareas_activas,
                   get_session_path, iniciar_responder, detener_responder,
                   responder_activos, detectar_grupos_telegram,
                   detectar_carpetas_telegram, detectar_grupos_carpeta,
                   verificar_grupos_estado)

PERU_TZ = timezone(timedelta(hours=-5))

def ahora_peru():
    return datetime.now(PERU_TZ)

logger = logging.getLogger("JDWebPanel")

API_ID = 35451933
API_HASH = "2070761744260118720b34e6bf20f2eb"
WEB_PORT = int(os.environ.get("TG_API_PORT", 3002))
ADMIN_ID = 8001675901

web_login_sessions = {}
aiogram_bot = None


def set_bot_reference(bot_instance):
    global aiogram_bot
    aiogram_bot = bot_instance


def es_admin(user_id):
    return int(user_id) == ADMIN_ID


# ─────────────────────────────────────────
#   AUTH: /api/tg-auth/*
# ─────────────────────────────────────────

async def api_tg_auth_send_code(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    telefono = body.get("telefono", "").strip()
    nombre = body.get("nombre", "").strip()

    if not user_id or not telefono or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)

    if not re.match(r'^\+\d{7,15}$', telefono):
        return web.json_response({"ok": False, "error": "Numero invalido. Formato: +XXXXXXXXXXX"})

    if not re.match(r'^[a-zA-Z0-9_]{1,30}$', nombre):
        return web.json_response({"ok": False, "error": "Nombre invalido (solo letras, numeros, guion bajo, max 30)"})

    sesiones = await db.get_sesiones(user_id)
    if len(sesiones) >= 5:
        return web.json_response({"ok": False, "error": "Limite de 5 cuentas alcanzado"})

    for s in sesiones:
        if s["nombre"].lower() == nombre.lower():
            return web.json_response({"ok": False, "error": f"Ya tienes una cuenta llamada '{nombre}'"})

    token = uuid.uuid4().hex
    if token in web_login_sessions:
        try:
            await web_login_sessions[token]["client"].disconnect()
        except Exception:
            pass

    path = get_session_path(user_id, nombre)
    try:
        client = TelegramClient(path, API_ID, API_HASH)
        await client.connect()

        if await client.is_user_authorized():
            await db.agregar_sesion(user_id, nombre, telefono)
            await client.disconnect()
            return web.json_response({"ok": True, "status": "already_authorized"})

        result = await client.send_code_request(telefono)
        web_login_sessions[token] = {
            "client": client,
            "telefono": telefono,
            "nombre": nombre,
            "phone_code_hash": result.phone_code_hash,
            "user_id": user_id,
        }
        return web.json_response({"ok": True, "status": "code_sent", "token": token})
    except Exception as e:
        error_msg = str(e).lower()
        if "flood" in error_msg:
            msg = "Demasiados intentos. Espera unos minutos."
        elif "phone" in error_msg and "invalid" in error_msg:
            msg = "Numero invalido. Verifica el codigo de pais."
        else:
            msg = str(e)
        return web.json_response({"ok": False, "error": msg})


async def api_tg_auth_verify_code(request):
    body = await request.json()
    token = body.get("token", "")
    codigo = body.get("codigo", "").strip()

    if not token or token not in web_login_sessions:
        return web.json_response({"ok": False, "error": "Sesion expirada. Intenta de nuevo."})

    session = web_login_sessions[token]
    client = session["client"]

    try:
        await client.sign_in(
            session["telefono"],
            codigo,
            phone_code_hash=session["phone_code_hash"]
        )
        await db.agregar_sesion(session["user_id"], session["nombre"], session["telefono"])
        await client.disconnect()
        del web_login_sessions[token]
        return web.json_response({"ok": True, "status": "success"})
    except SessionPasswordNeededError:
        return web.json_response({"ok": True, "status": "need_2fa"})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def api_tg_auth_verify_2fa(request):
    body = await request.json()
    token = body.get("token", "")
    password = body.get("password", "").strip()

    if not token or token not in web_login_sessions:
        return web.json_response({"ok": False, "error": "Sesion expirada. Intenta de nuevo."})

    session = web_login_sessions[token]
    client = session["client"]

    try:
        await client.sign_in(password=password)
        await db.agregar_sesion(session["user_id"], session["nombre"], session["telefono"])
        await client.disconnect()
        del web_login_sessions[token]
        return web.json_response({"ok": True, "status": "success"})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ─────────────────────────────────────────
#   SESIONES TG: /api/sesiones_tg*
# ─────────────────────────────────────────

async def api_sesiones_tg(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    sesiones = await db.get_sesiones(user_id)
    return web.json_response({
        "ok": True,
        "sesiones": [{"nombre": s["nombre"], "telefono": s["telefono"]} for s in sesiones]
    })


async def api_sesiones_tg_eliminar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    if not user_id or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    await db.eliminar_sesion(user_id, nombre)
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   GRUPOS TG: /api/tg/grupos*
# ─────────────────────────────────────────

async def api_tg_grupos(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    grupos = await db.get_grupos(user_id)
    max_g = await db.get_max_grupos(user_id)
    return web.json_response({
        "ok": True,
        "grupos": [{"id": g["id"], "link": g["link"]} for g in grupos],
        "max": max_g
    })


async def api_tg_grupos_add(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    link = body.get("link", "").strip()
    if not user_id or not link:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)

    max_g = await db.get_max_grupos(user_id)
    grupos_actuales = await db.get_grupos(user_id)
    if len(grupos_actuales) >= max_g:
        return web.json_response({"ok": False, "error": f"Limite de {max_g} grupos alcanzado"})

    if link.startswith("t.me/"):
        link = "https://" + link
    if not (link.startswith("https://t.me/") or link.startswith("http://t.me/") or link.startswith("@")):
        return web.json_response({"ok": False, "error": "Link invalido"})

    try:
        await db.agregar_grupo(user_id, link)
        return web.json_response({"ok": True})
    except Exception:
        return web.json_response({"ok": False, "error": "Grupo duplicado"})


async def api_tg_grupos_del(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    link = body.get("link", "").strip()
    if not user_id or not link:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    await db.eliminar_grupo_por_link(user_id, link)
    return web.json_response({"ok": True})


async def api_tg_grupos_delall(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.eliminar_todos_grupos(user_id)
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   MENSAJES TG: /api/tg/mensajes*
# ─────────────────────────────────────────

async def api_tg_mensajes(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    campanas = await db.get_campanas(user_id)
    mensajes = []
    for c in campanas:
        mensajes.append({
            "id": c["id"],
            "nombre": c["nombre"],
            "texto": c["mensaje"] or "",
            "foto": c.get("foto_path") or None,
        })
    return web.json_response({"ok": True, "mensajes": mensajes})


async def api_tg_mensajes_crear(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    texto = body.get("texto", "").strip()
    if not user_id or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana_id = await db.crear_campana(user_id, nombre, texto)
    return web.json_response({"ok": True, "id": campana_id})


async def api_tg_mensajes_editar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    nombre = body.get("nombre", "").strip()
    texto = body.get("texto", "").strip()
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if not campana or int(campana["user_id"]) != user_id:
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    await db.actualizar_campana_mensaje(campana_id, texto, None)
    return web.json_response({"ok": True})


async def api_tg_mensajes_del(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if not campana or int(campana["user_id"]) != user_id:
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    if campana["activa"]:
        detener_campana(campana_id)
    await db.eliminar_campana(campana_id)
    return web.json_response({"ok": True})


async def api_tg_mensajes_duplicar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if not campana or int(campana["user_id"]) != user_id:
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    new_name = campana["nombre"] + " (copia)"
    new_id = await db.clonar_campana(user_id, campana_id, new_name)
    if new_id:
        return web.json_response({"ok": True, "id": new_id})
    return web.json_response({"ok": False, "error": "Error al duplicar"})


# ─────────────────────────────────────────
#   CAMPANAS TG: /api/tg/campanas*
# ─────────────────────────────────────────

async def api_tg_campanas(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    campanas = await db.get_campanas(user_id)
    result = []
    for c in campanas:
        config = await db.get_campana_config(c["id"])
        grupos = await db.get_grupos_campana(c["id"])
        sesiones = await db.get_sesiones_campana(c["id"])
        result.append({
            "id": c["id"],
            "nombre": c["nombre"],
            "mensaje": c["mensaje"] or "",
            "foto": c.get("foto_path") or None,
            "activa": bool(c["activa"]),
            "enviados": c["enviados"],
            "errores": c["errores"],
            "intervalo_min": config["intervalo_min"] if config else 30,
            "intervalo_max": config["intervalo_max"] if config else 60,
            "grupos": len(grupos),
            "sesiones": len(sesiones),
            "en_ejecucion": c["id"] in tareas_activas,
        })
    return web.json_response({"ok": True, "campanas": result})


async def api_tg_campanas_crear(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    if not user_id or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana_id = await db.crear_campana(user_id, nombre, "")
    sesiones = await db.get_sesiones(user_id)
    for s in sesiones:
        await db.agregar_sesion_campana(campana_id, s["nombre"])
    grupos = await db.get_grupos(user_id)
    for g in grupos:
        await db.agregar_grupo_campana(campana_id, g["link"])
    return web.json_response({"ok": True, "id": campana_id})


async def api_tg_campanas_del(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if not campana or int(campana["user_id"]) != user_id:
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    if campana["activa"]:
        detener_campana(campana_id)
    await db.eliminar_campana(campana_id)
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   CONTROL: iniciar/detener
# ─────────────────────────────────────────

async def api_tg_iniciar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if not campana or int(campana["user_id"]) != user_id:
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)

    grupos_campana = await db.get_grupos_campana(campana_id)
    if not grupos_campana:
        grupos_user = await db.get_grupos(user_id)
        if not grupos_user:
            return web.json_response({"ok": False, "error": "Sin grupos. Agrega grupos primero."})
        for g in grupos_user:
            await db.agregar_grupo_campana(campana_id, g["link"])

    sesiones_campana = await db.get_sesiones_campana(campana_id)
    if not sesiones_campana:
        sesiones_user = await db.get_sesiones(user_id)
        if not sesiones_user:
            return web.json_response({"ok": False, "error": "Sin cuentas. Agrega cuentas primero."})
        for s in sesiones_user:
            await db.agregar_sesion_campana(campana_id, s["nombre"])

    loop = asyncio.get_event_loop()
    resultado = iniciar_campana(campana_id, user_id, loop, aiogram_bot)
    if resultado:
        return web.json_response({"ok": True, "msg": f"Campana '{campana['nombre']}' INICIADA!"})
    else:
        return web.json_response({"ok": False, "error": "La campana ya esta en ejecucion."})


async def api_tg_detener(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if not campana or int(campana["user_id"]) != user_id:
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    detener_campana(campana_id)
    await db.set_campana_activa(campana_id, False)
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   PROGRAMADOS TG: /api/tg/programados*
# ─────────────────────────────────────────

async def api_tg_programados(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    return web.json_response({"ok": True, "programados": []})


async def api_tg_programados_crear(request):
    body = await request.json()
    return web.json_response({"ok": True, "msg": "Programado creado"})


async def api_tg_programados_toggle(request):
    body = await request.json()
    return web.json_response({"ok": True})


async def api_tg_programados_del(request):
    body = await request.json()
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   HISTORIAL TG: /api/tg/historial
# ─────────────────────────────────────────

async def api_tg_historial(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    historial = await db.get_historial_envios(user_id, limite=100)
    return web.json_response({
        "ok": True,
        "historial": [
            {
                "grupo": h["grupo_link"],
                "resultado": h["resultado"],
                "fecha": h["fecha"],
            } for h in historial
        ]
    })


# ─────────────────────────────────────────
#   AUTO-RESPONDER TG: /api/tg/autoresponder*
# ─────────────────────────────────────────

async def api_tg_autoresponder(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    config = await db.get_responder_config(user_id)
    keywords = await db.get_keywords(user_id)
    activo = bool(config["activo"]) if config else False
    contacto = config["contacto"] if config else ""
    return web.json_response({
        "ok": True,
        "activo": activo,
        "contacto": contacto,
        "keywords": [{"id": k["id"], "keyword": k["palabra"], "respuesta": k.get("respuesta", "")} for k in keywords]
    })


async def api_tg_autoresponder_toggle(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    activo = body.get("activo", False)
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.toggle_responder(user_id, 1 if activo else 0)
    if activo:
        loop = asyncio.get_event_loop()
        iniciar_responder(user_id, loop, aiogram_bot)
    else:
        detener_responder(user_id)
    return web.json_response({"ok": True})


async def api_tg_autoresponder_keyword_add(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    keyword = body.get("keyword", "").strip()
    respuesta = body.get("respuesta", "").strip()
    if not user_id or not keyword:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    await db.agregar_keywords(user_id, keyword)
    return web.json_response({"ok": True})


async def api_tg_autoresponder_keyword_del(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    kw_id = int(body.get("id", 0))
    if not user_id or not kw_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    return web.json_response({"ok": True})


async def api_tg_autoresponder_keyword_delall(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.limpiar_keywords(user_id)
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   CONFIG TG: /api/tg/config
# ─────────────────────────────────────────

async def api_tg_config_get(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    campanas = await db.get_campanas(user_id)
    if campanas:
        config = await db.get_campana_config(campanas[0]["id"])
        return web.json_response({
            "ok": True,
            "delay_seg": config["intervalo_min"] if config else 30,
            "lote_tamano": 10,
            "lote_pausa_seg": config["intervalo_max"] if config else 60,
        })
    return web.json_response({"ok": True, "delay_seg": 30, "lote_tamano": 10, "lote_pausa_seg": 60})


async def api_tg_config_set(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    delay = int(body.get("delay_seg", 30))
    lote_pausa = int(body.get("lote_pausa_seg", 60))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    if delay < 3:
        return web.json_response({"ok": False, "error": "Minimo 3 segundos"})
    campanas = await db.get_campanas(user_id)
    for c in campanas:
        await db.set_campana_config(c["id"], delay, max(lote_pausa, delay))
    return web.json_response({"ok": True, "msg": "Config actualizada"})


# ─────────────────────────────────────────
#   LISTA NEGRA TG: /api/tg/listanegra*
# ─────────────────────────────────────────

async def api_tg_listanegra(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    return web.json_response({"ok": True, "grupos": []})


async def api_tg_listanegra_add(request):
    body = await request.json()
    return web.json_response({"ok": True})


async def api_tg_listanegra_del(request):
    body = await request.json()
    return web.json_response({"ok": True})


async def api_tg_listanegra_limpiar(request):
    body = await request.json()
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   STATS TG: /api/tg/stats
# ─────────────────────────────────────────

async def api_tg_stats(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    dashboard = await db.get_dashboard(user_id)
    campanas = await db.get_campanas(user_id)
    activas = sum(1 for c in campanas if c["activa"])
    total_env = sum(c["enviados"] for c in campanas)
    total_err = sum(c["errores"] for c in campanas)
    return web.json_response({
        "ok": True,
        "campanas_total": len(campanas),
        "campanas_activas": activas,
        "enviados_total": total_env,
        "errores_total": total_err,
        "grupos": dashboard.get("total_grupos", 0),
        "cuentas": dashboard.get("total_sesiones", 0),
    })


# ─────────────────────────────────────────
#   DETECTAR GRUPOS
# ─────────────────────────────────────────

async def api_tg_detectar(request):
    user_id = int(request.query.get("u", 0))
    cuenta = request.query.get("cuenta", "")
    if not user_id or not cuenta:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    try:
        grupos = await detectar_grupos_telegram(user_id, cuenta)
        return web.json_response({
            "ok": True,
            "grupos": [{"title": g.get("title", ""), "link": g.get("link", ""), "id": g.get("id", 0)} for g in grupos]
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ─────────────────────────────────────────
#   SERVIDOR WEB
# ─────────────────────────────────────────

def create_app():
    app = web.Application(client_max_size=10 * 1024 * 1024)

    # Auth
    app.router.add_post("/api/tg-auth/send-code", api_tg_auth_send_code)
    app.router.add_post("/api/tg-auth/verify-code", api_tg_auth_verify_code)
    app.router.add_post("/api/tg-auth/verify-2fa", api_tg_auth_verify_2fa)

    # Sesiones TG
    app.router.add_get("/api/sesiones_tg", api_sesiones_tg)
    app.router.add_post("/api/sesiones_tg/eliminar", api_sesiones_tg_eliminar)

    # Grupos TG
    app.router.add_get("/api/tg/grupos", api_tg_grupos)
    app.router.add_post("/api/tg/grupos/add", api_tg_grupos_add)
    app.router.add_post("/api/tg/grupos/del", api_tg_grupos_del)
    app.router.add_post("/api/tg/grupos/delall", api_tg_grupos_delall)

    # Mensajes TG
    app.router.add_get("/api/tg/mensajes", api_tg_mensajes)
    app.router.add_post("/api/tg/mensajes/crear", api_tg_mensajes_crear)
    app.router.add_post("/api/tg/mensajes/editar", api_tg_mensajes_editar)
    app.router.add_post("/api/tg/mensajes/del", api_tg_mensajes_del)
    app.router.add_post("/api/tg/mensajes/duplicar", api_tg_mensajes_duplicar)

    # Campanas TG
    app.router.add_get("/api/tg/campanas", api_tg_campanas)
    app.router.add_post("/api/tg/campanas/crear", api_tg_campanas_crear)
    app.router.add_post("/api/tg/campanas/del", api_tg_campanas_del)

    # Control
    app.router.add_post("/api/tg/iniciar", api_tg_iniciar)
    app.router.add_post("/api/tg/detener", api_tg_detener)

    # Programados TG
    app.router.add_get("/api/tg/programados", api_tg_programados)
    app.router.add_post("/api/tg/programados/crear", api_tg_programados_crear)
    app.router.add_post("/api/tg/programados/toggle", api_tg_programados_toggle)
    app.router.add_post("/api/tg/programados/del", api_tg_programados_del)

    # Historial TG
    app.router.add_get("/api/tg/historial", api_tg_historial)

    # Auto-responder TG
    app.router.add_get("/api/tg/autoresponder", api_tg_autoresponder)
    app.router.add_post("/api/tg/autoresponder/toggle", api_tg_autoresponder_toggle)
    app.router.add_post("/api/tg/autoresponder/keyword/add", api_tg_autoresponder_keyword_add)
    app.router.add_post("/api/tg/autoresponder/keyword/del", api_tg_autoresponder_keyword_del)
    app.router.add_post("/api/tg/autoresponder/keyword/delall", api_tg_autoresponder_keyword_delall)

    # Config TG
    app.router.add_get("/api/tg/config", api_tg_config_get)
    app.router.add_post("/api/tg/config", api_tg_config_set)

    # Lista negra TG
    app.router.add_get("/api/tg/listanegra", api_tg_listanegra)
    app.router.add_post("/api/tg/listanegra/add", api_tg_listanegra_add)
    app.router.add_post("/api/tg/listanegra/del", api_tg_listanegra_del)
    app.router.add_post("/api/tg/listanegra/limpiar", api_tg_listanegra_limpiar)

    # Stats TG
    app.router.add_get("/api/tg/stats", api_tg_stats)

    # Detectar
    app.router.add_get("/api/tg/detectar", api_tg_detectar)

    return app


async def start_web_panel():
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()
    logger.info(f"TG API backend corriendo en puerto {WEB_PORT}")
