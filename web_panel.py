"""
Panel Web para gestionar el Bot de Spam J&D (Telegram).
Servidor aiohttp con API REST y frontend HTML embebido.
"""
import asyncio
import os
import re
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta

import aiosqlite
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
WEB_PORT = int(os.environ.get("WEB_PORT", 8080))
ADMIN_ID = 8001675901
YAPE_NUM = "9776680776"
PLANES = {
    "diario":  {"dias": 1,  "precio": "S/ 2.00",  "emoji": "🥉"},
    "semanal": {"dias": 7,  "precio": "S/ 10.00", "emoji": "🥈"},
    "mensual": {"dias": 30, "precio": "S/ 25.00", "emoji": "🥇"},
}

web_login_sessions = {}
aiogram_bot = None


def set_bot_reference(bot_instance):
    global aiogram_bot
    aiogram_bot = bot_instance


def es_admin(user_id):
    return int(user_id) == ADMIN_ID


# ─────────────────────────────────────────
#   API ENDPOINTS
# ─────────────────────────────────────────

async def api_dashboard(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    dashboard = await db.get_dashboard(user_id)
    return web.json_response({"ok": True, **dashboard})


# --- CUENTAS ---

async def api_cuentas(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    sesiones = await db.get_sesiones(user_id)
    return web.json_response({
        "ok": True,
        "cuentas": [{"nombre": s["nombre"], "telefono": s["telefono"]} for s in sesiones]
    })


async def api_cuenta_enviar_codigo(request):
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

    session_key = f"{user_id}_{nombre}"
    if session_key in web_login_sessions:
        try:
            await web_login_sessions[session_key]["client"].disconnect()
        except Exception:
            pass

    path = get_session_path(user_id, nombre)
    try:
        client = TelegramClient(path, API_ID, API_HASH)
        await client.connect()

        if await client.is_user_authorized():
            await db.agregar_sesion(user_id, nombre, telefono)
            await client.disconnect()
            return web.json_response({
                "ok": True,
                "step": "done",
                "msg": f"Cuenta '{nombre}' ya estaba autorizada. Registrada."
            })

        result = await client.send_code_request(telefono)
        web_login_sessions[session_key] = {
            "client": client,
            "telefono": telefono,
            "nombre": nombre,
            "phone_code_hash": result.phone_code_hash,
            "user_id": user_id,
        }
        return web.json_response({
            "ok": True,
            "step": "code",
            "msg": "Codigo enviado a tu APP de Telegram (no por SMS). Revisa tus mensajes en Telegram."
        })
    except Exception as e:
        error_msg = str(e).lower()
        if "flood" in error_msg:
            msg = "Demasiados intentos. Espera unos minutos."
        elif "phone" in error_msg and "invalid" in error_msg:
            msg = "Numero invalido. Verifica el codigo de pais."
        else:
            msg = str(e)
        return web.json_response({"ok": False, "error": msg})


async def api_cuenta_verificar_codigo(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    codigo = body.get("codigo", "").strip()

    session_key = f"{user_id}_{nombre}"
    session = web_login_sessions.get(session_key)
    if not session:
        return web.json_response({"ok": False, "error": "Sesion expirada. Intenta de nuevo."})

    client = session["client"]
    try:
        await client.sign_in(
            session["telefono"], codigo,
            phone_code_hash=session["phone_code_hash"]
        )
        await db.agregar_sesion(user_id, nombre, session["telefono"])
        await client.disconnect()
        del web_login_sessions[session_key]
        return web.json_response({
            "ok": True,
            "step": "done",
            "msg": f"Cuenta '{nombre}' vinculada correctamente!"
        })
    except SessionPasswordNeededError:
        return web.json_response({
            "ok": True,
            "step": "2fa",
            "msg": "Esta cuenta tiene verificacion en 2 pasos. Ingresa tu contrasena de Telegram."
        })
    except Exception as e:
        try:
            await client.disconnect()
        except Exception:
            pass
        web_login_sessions.pop(session_key, None)
        return web.json_response({"ok": False, "error": f"Codigo incorrecto o expirado: {e}"})


async def api_cuenta_verificar_2fa(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    password = body.get("password", "").strip()

    session_key = f"{user_id}_{nombre}"
    session = web_login_sessions.get(session_key)
    if not session:
        return web.json_response({"ok": False, "error": "Sesion expirada."})

    client = session["client"]
    try:
        await client.sign_in(password=password)
        await db.agregar_sesion(user_id, nombre, session["telefono"])
        await client.disconnect()
        del web_login_sessions[session_key]
        return web.json_response({
            "ok": True,
            "step": "done",
            "msg": f"Cuenta '{nombre}' vinculada con 2FA!"
        })
    except Exception as e:
        try:
            await client.disconnect()
        except Exception:
            pass
        web_login_sessions.pop(session_key, None)
        return web.json_response({"ok": False, "error": f"Contrasena incorrecta: {e}"})


async def api_cuenta_eliminar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    if not user_id or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)

    try:
        await db.eliminar_sesion(user_id, nombre)
        path = get_session_path(user_id, nombre)
        for ext in ["", ".session"]:
            try:
                os.remove(path + ext)
            except FileNotFoundError:
                pass
        return web.json_response({"ok": True, "msg": f"Cuenta '{nombre}' eliminada."})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# --- GRUPOS ---

async def api_grupos(request):
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


async def api_grupo_agregar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    links_raw = body.get("links", "")
    if not user_id or not links_raw:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)

    lines = [l.strip() for l in links_raw.strip().split("\n") if l.strip()]
    agregados = 0
    duplicados = 0
    invalidos = 0
    for link in lines:
        link = link.strip()
        if link.startswith("t.me/"):
            link = "https://" + link
        if link.startswith("https://t.me/") or link.startswith("http://t.me/") or link.startswith("@"):
            try:
                await db.agregar_grupo(user_id, link)
                agregados += 1
            except Exception:
                duplicados += 1
        else:
            invalidos += 1
    return web.json_response({
        "ok": True,
        "agregados": agregados,
        "duplicados": duplicados,
        "invalidos": invalidos,
    })


async def api_grupo_eliminar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    grupo_id = int(body.get("id", 0))
    if not user_id or not grupo_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    await db.eliminar_grupo(user_id, grupo_id)
    return web.json_response({"ok": True})


async def api_grupo_eliminar_todos(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.eliminar_todos_grupos(user_id)
    return web.json_response({"ok": True})


async def api_grupo_editar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    grupo_id = int(body.get("id", 0))
    nuevo_link = body.get("link", "").strip()
    if not user_id or not grupo_id or not nuevo_link:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    if nuevo_link.startswith("t.me/"):
        nuevo_link = "https://" + nuevo_link
    if not (nuevo_link.startswith("https://t.me/") or nuevo_link.startswith("http://t.me/") or nuevo_link.startswith("@")):
        return web.json_response({"ok": False, "error": "Link invalido"})
    await db.actualizar_grupo_link(user_id, grupo_id, nuevo_link)
    return web.json_response({"ok": True, "msg": "Grupo actualizado."})


async def api_grupo_exportar(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    grupos = await db.get_grupos(user_id)
    links = [g["link"] for g in grupos]
    return web.json_response({"ok": True, "links": links, "total": len(links)})


# --- DETECTAR GRUPOS ---

async def api_detectar_todos(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    grupos, info = await detectar_grupos_telegram(user_id)
    if grupos is None:
        return web.json_response({"ok": False, "error": str(info)})
    return web.json_response({
        "ok": True,
        "cuenta": info,
        "grupos": grupos,
        "total": len(grupos),
        "con_link": sum(1 for g in grupos if g.get("link")),
        "baneados": sum(1 for g in grupos if g.get("banned")),
        "restringidos": sum(1 for g in grupos if g.get("restricted")),
    })


async def api_detectar_carpetas(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    carpetas, info = await detectar_carpetas_telegram(user_id)
    if carpetas is None:
        return web.json_response({"ok": False, "error": str(info)})
    return web.json_response({"ok": True, "carpetas": carpetas})


async def api_detectar_carpeta_grupos(request):
    user_id = int(request.query.get("u", 0))
    folder_id = int(request.query.get("folder", 0))
    if not user_id or not folder_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    grupos, info = await detectar_grupos_carpeta(user_id, folder_id)
    if grupos is None:
        return web.json_response({"ok": False, "error": str(info)})
    return web.json_response({
        "ok": True,
        "grupos": grupos,
        "total": len(grupos),
        "con_link": sum(1 for g in grupos if g.get("link")),
    })


async def api_detectar_estado(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    resultados, info = await verificar_grupos_estado(user_id)
    if resultados is None:
        return web.json_response({"ok": False, "error": str(info)})
    ok_count = sum(1 for r in resultados if r["estado"] == "ok")
    problemas = len(resultados) - ok_count
    return web.json_response({
        "ok": True,
        "cuenta": info,
        "resultados": resultados,
        "total": len(resultados),
        "ok_count": ok_count,
        "problemas": problemas,
    })


async def api_detectar_agregar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    links = body.get("links", [])
    if not user_id or not links:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    agregados = 0
    for link in links:
        if link:
            try:
                await db.agregar_grupo(user_id, link)
                agregados += 1
            except Exception:
                pass
    return web.json_response({"ok": True, "agregados": agregados})


async def api_detectar_limpiar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    resultados, info = await verificar_grupos_estado(user_id)
    if resultados is None:
        return web.json_response({"ok": False, "error": str(info)})
    eliminados = 0
    for r in resultados:
        if r["estado"] != "ok":
            await db.eliminar_grupo(user_id, r["grupo_id"])
            eliminados += 1
    return web.json_response({"ok": True, "eliminados": eliminados, "restantes": len(resultados) - eliminados})


# --- CAMPANAS ---

async def api_campanas(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    campanas = await db.get_campanas(user_id)
    result = []
    for c in campanas:
        config = await db.get_campana_config(c["id"])
        sesiones = await db.get_sesiones_campana(c["id"])
        grupos = await db.get_grupos_campana(c["id"])
        result.append({
            "id": c["id"],
            "nombre": c["nombre"],
            "mensaje": c["mensaje"],
            "foto_path": c["foto_path"],
            "activa": bool(c["activa"]),
            "enviados": c["enviados"],
            "errores": c["errores"],
            "inicio": c["inicio"],
            "intervalo_min": config["intervalo_min"],
            "intervalo_max": config["intervalo_max"],
            "sesiones": sesiones,
            "grupos": grupos,
        })
    return web.json_response({"ok": True, "campanas": result})


async def api_campana_crear(request):
    reader = await request.multipart()
    fields = {}
    foto_path = None

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "foto":
            if part.filename:
                os.makedirs("media", exist_ok=True)
                foto_name = f"media/{uuid.uuid4().hex}.jpg"
                with open(foto_name, "wb") as f:
                    while True:
                        chunk = await part.read_chunk()
                        if not chunk:
                            break
                        f.write(chunk)
                foto_path = foto_name
        else:
            fields[part.name] = (await part.read()).decode("utf-8")

    user_id = int(fields.get("u", 0))
    nombre = fields.get("nombre", "").strip()
    mensaje = fields.get("mensaje", "").strip()

    if not user_id or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)

    if not mensaje and not foto_path:
        return web.json_response({"ok": False, "error": "Debes enviar un mensaje o una foto"}, status=400)

    campana_id = await db.crear_campana(user_id, nombre, mensaje, foto_path)

    sesiones = await db.get_sesiones(user_id)
    for s in sesiones:
        await db.agregar_sesion_campana(campana_id, s["nombre"])

    grupos = await db.get_grupos(user_id)
    for g in grupos:
        await db.agregar_grupo_campana(campana_id, g["link"])

    return web.json_response({
        "ok": True,
        "id": campana_id,
        "msg": f"Campana '{nombre}' creada con {len(sesiones)} cuentas y {len(grupos)} grupos."
    })


async def api_campana_editar(request):
    reader = await request.multipart()
    fields = {}
    foto_path = None

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "foto":
            if part.filename:
                os.makedirs("media", exist_ok=True)
                foto_name = f"media/{uuid.uuid4().hex}.jpg"
                with open(foto_name, "wb") as f:
                    while True:
                        chunk = await part.read_chunk()
                        if not chunk:
                            break
                        f.write(chunk)
                foto_path = foto_name
        else:
            fields[part.name] = (await part.read()).decode("utf-8")

    campana_id = int(fields.get("id", 0))
    mensaje = fields.get("mensaje", "").strip()

    if not campana_id:
        return web.json_response({"ok": False, "error": "Falta id"}, status=400)

    await db.actualizar_campana_mensaje(campana_id, mensaje, foto_path)
    return web.json_response({"ok": True, "msg": "Campana actualizada."})


async def api_campana_eliminar(request):
    body = await request.json()
    campana_id = int(body.get("id", 0))
    if not campana_id:
        return web.json_response({"ok": False, "error": "Falta id"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if campana and campana["activa"]:
        detener_campana(campana_id)
    await db.eliminar_campana(campana_id)
    return web.json_response({"ok": True})


async def api_campana_config(request):
    body = await request.json()
    campana_id = int(body.get("id", 0))
    intervalo_min = int(body.get("min", 30))
    intervalo_max = int(body.get("max", 60))
    if not campana_id:
        return web.json_response({"ok": False, "error": "Falta id"}, status=400)
    if intervalo_min < 3:
        return web.json_response({"ok": False, "error": "Minimo 3 segundos"})
    if intervalo_max < intervalo_min:
        intervalo_max = intervalo_min
    if intervalo_max > 3600:
        return web.json_response({"ok": False, "error": "Maximo 3600 segundos"})
    await db.set_campana_config(campana_id, intervalo_min, intervalo_max)
    return web.json_response({"ok": True, "msg": f"Intervalo actualizado: {intervalo_min}-{intervalo_max}s"})


async def api_campana_clonar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    nuevo_nombre = body.get("nombre", "").strip()
    if not user_id or not campana_id or not nuevo_nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    new_id = await db.clonar_campana(user_id, campana_id, nuevo_nombre)
    if new_id:
        return web.json_response({"ok": True, "id": new_id, "msg": f"Campana clonada como '{nuevo_nombre}'."})
    return web.json_response({"ok": False, "error": "Error al clonar campana."})


async def api_campana_resetear(request):
    body = await request.json()
    campana_id = int(body.get("id", 0))
    if not campana_id:
        return web.json_response({"ok": False, "error": "Falta id"}, status=400)
    await db.resetear_stats_campana(campana_id)
    return web.json_response({"ok": True, "msg": "Estadisticas reseteadas."})


# --- CONTROL ---

async def api_iniciar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)

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
    campana = await db.get_campana_by_id(campana_id)
    nombre = campana["nombre"] if campana else "?"
    if resultado:
        return web.json_response({"ok": True, "msg": f"Campana '{nombre}' INICIADA!"})
    else:
        return web.json_response({"ok": False, "error": "La campana ya esta en ejecucion."})


async def api_detener(request):
    body = await request.json()
    campana_id = int(body.get("id", 0))
    if not campana_id:
        return web.json_response({"ok": False, "error": "Falta id"}, status=400)
    detener_campana(campana_id)
    await db.set_campana_activa(campana_id, False)
    return web.json_response({"ok": True, "msg": "Campana detenida."})


async def api_detener_todas(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    campanas = await db.get_campanas(user_id)
    detenidas = 0
    for c in campanas:
        if c["activa"]:
            detener_campana(c["id"])
            await db.set_campana_activa(c["id"], False)
            detenidas += 1
    return web.json_response({"ok": True, "detenidas": detenidas})


# --- RESPONDER ---

async def api_responder(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    config = await db.get_responder_config(user_id)
    keywords = await db.get_keywords(user_id)
    return web.json_response({
        "ok": True,
        "contacto": config["contacto"] if config else "",
        "activo": bool(config["activo"]) if config else False,
        "keywords": keywords
    })


async def api_responder_config(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    contacto = body.get("contacto", "").strip()
    keywords = body.get("keywords", [])
    if not user_id or not contacto:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    if not contacto.startswith("@"):
        contacto = "@" + contacto
    await db.limpiar_keywords(user_id)
    await db.agregar_keywords(user_id, keywords)
    await db.set_responder_config(user_id, contacto, 1)
    detener_responder(user_id)
    loop = asyncio.get_event_loop()
    iniciar_responder(user_id, contacto, keywords, loop, aiogram_bot)
    return web.json_response({"ok": True, "msg": "Responder activado."})


async def api_responder_toggle(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    activo = body.get("activo", False)
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    if activo:
        config = await db.get_responder_config(user_id)
        keywords = await db.get_keywords(user_id)
        if not config or not config["contacto"]:
            return web.json_response({"ok": False, "error": "Configura el contacto primero."})
        if not keywords:
            return web.json_response({"ok": False, "error": "Agrega keywords primero."})
        detener_responder(user_id)
        await db.toggle_responder(user_id, 1)
        loop = asyncio.get_event_loop()
        iniciar_responder(user_id, config["contacto"], keywords, loop, aiogram_bot)
    else:
        detener_responder(user_id)
        await db.toggle_responder(user_id, 0)
    return web.json_response({"ok": True})


# --- HISTORIAL ---

async def api_historial(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    hist = await db.get_historial_envios(user_id, 50)
    stats_grupo = await db.get_stats_por_grupo(user_id)
    stats_kw = await db.get_stats_respuestas(user_id)
    stats_resp_gr = await db.get_stats_respuestas_por_grupo(user_id)
    return web.json_response({
        "ok": True,
        "envios": [{"grupo": h["grupo_link"], "resultado": h["resultado"], "fecha": h["fecha"]} for h in hist],
        "stats_grupo": [{"grupo": s["grupo_link"], "enviados": s["enviados"], "errores": s["errores"]} for s in stats_grupo],
        "stats_keywords": [{"keyword": s["keyword"], "total": s["total"]} for s in stats_kw],
        "stats_resp_grupo": [{"grupo": s["grupo_link"], "total": s["total"]} for s in stats_resp_gr],
    })


async def api_historial_limpiar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.limpiar_historial(user_id)
    return web.json_response({"ok": True})


# --- PERFIL / MEMBRESIA ---

async def api_perfil(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    user = await db.get_usuario(user_id)
    dashboard = await db.get_dashboard(user_id)

    if es_admin(user_id):
        plan_txt = "Admin"
        estado = "activa"
        resta = "ilimitado"
        expira = "Nunca"
    elif user and user.get("activo"):
        plan_txt = (user.get("plan") or "—").capitalize()
        expira = user.get("fecha_expira") or "—"
        resta = "—"
        if expira and expira != "—":
            try:
                exp_dt = datetime.strptime(expira, "%Y-%m-%d %H:%M:%S")
                diff = exp_dt - ahora_peru().replace(tzinfo=None)
                if diff.total_seconds() > 0:
                    resta = f"{diff.days}d {diff.seconds // 3600}h"
                else:
                    resta = "EXPIRADA"
            except ValueError:
                pass
        estado = "activa"
    else:
        plan_txt = "Sin plan"
        estado = "inactiva"
        resta = "—"
        expira = "—"

    return web.json_response({
        "ok": True,
        "user_id": user_id,
        "is_admin": es_admin(user_id),
        "plan": plan_txt,
        "estado": estado,
        "expira": expira,
        "resta": resta,
        "fecha_registro": user.get("fecha_registro", "—") if user else "—",
        **dashboard,
    })


async def api_planes(request):
    planes_list = []
    for key, val in PLANES.items():
        planes_list.append({
            "id": key,
            "nombre": key.capitalize(),
            "dias": val["dias"],
            "precio": val["precio"],
            "emoji": val["emoji"],
        })
    return web.json_response({"ok": True, "planes": planes_list, "yape": YAPE_NUM})


# --- ADMIN ---

async def api_admin_stats(request):
    user_id = int(request.query.get("u", 0))
    if not es_admin(user_id):
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    usuarios = await db.get_todos_usuarios()
    total = len(usuarios)
    activos = sum(1 for u in usuarios if u["activo"])
    camp_act = len(tareas_activas)
    resp_act = len(responder_activos)
    return web.json_response({
        "ok": True,
        "total_usuarios": total,
        "activos": activos,
        "inactivos": total - activos,
        "campanas_corriendo": camp_act,
        "responders_activos": resp_act,
    })


async def api_admin_usuarios(request):
    user_id = int(request.query.get("u", 0))
    if not es_admin(user_id):
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    usuarios = await db.get_todos_usuarios()
    return web.json_response({
        "ok": True,
        "usuarios": [
            {
                "telegram_id": u["telegram_id"],
                "username": u["username"],
                "activo": bool(u["activo"]),
                "plan": u["plan"],
                "fecha_registro": u.get("fecha_registro", ""),
                "fecha_expira": u.get("fecha_expira", ""),
            }
            for u in usuarios
        ]
    })


async def api_admin_activar(request):
    body = await request.json()
    admin_id = int(body.get("u", 0))
    if not es_admin(admin_id):
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    target_id = int(body.get("target", 0))
    dias = int(body.get("dias", 0))
    if not target_id or not dias:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    await db.activar_membresia(target_id, dias)
    plan_nombre = "Diario" if dias == 1 else "Semanal" if dias == 7 else "Mensual"
    try:
        if aiogram_bot:
            await aiogram_bot.send_message(target_id,
                f"🎉 Tu membresia fue activada!\n📦 Plan: {plan_nombre}\n⏳ {dias} dia(s)")
    except Exception:
        pass
    return web.json_response({"ok": True, "msg": f"Membresia activada: {target_id} — {plan_nombre} ({dias}d)"})


async def api_admin_desactivar(request):
    body = await request.json()
    admin_id = int(body.get("u", 0))
    if not es_admin(admin_id):
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)
    target_id = int(body.get("target", 0))
    if not target_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    async with aiosqlite.connect("titan.db") as d:
        await d.execute("UPDATE usuarios SET activo=0 WHERE telegram_id=?", (target_id,))
        await d.commit()
    return web.json_response({"ok": True, "msg": f"Membresia de {target_id} desactivada."})


# ─────────────────────────────────────────
#   FRONTEND HTML
# ─────────────────────────────────────────

async def serve_panel(request):
    return web.Response(text=PANEL_HTML, content_type="text/html", charset="utf-8")


PANEL_HTML = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>J&D Spam Bot - Panel Web</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f0f23;--surface:#1a1a2e;--surface2:#16213e;--primary:#0f3460;--accent:#e94560;--accent2:#533483;--text:#e0e0e0;--text2:#a0a0b0;--success:#00c853;--warning:#ff9100;--danger:#ff1744;--border:#2a2a4a}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex}
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);padding:15px 0;position:fixed;height:100vh;overflow-y:auto}
.sidebar h1{text-align:center;font-size:1.1rem;padding:12px;color:var(--accent);border-bottom:1px solid var(--border);margin-bottom:8px}
.sidebar .nav-item{display:flex;align-items:center;padding:10px 16px;cursor:pointer;transition:.2s;color:var(--text2);border-left:3px solid transparent;font-size:.85rem}
.sidebar .nav-item:hover{background:var(--surface2);color:var(--text)}
.sidebar .nav-item.active{background:var(--surface2);color:var(--accent);border-left-color:var(--accent)}
.sidebar .nav-item span{margin-left:8px}
.sidebar .nav-sep{height:1px;background:var(--border);margin:6px 12px}
.main{margin-left:220px;flex:1;padding:25px;max-width:950px}
.section{display:none}
.section.active{display:block}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:16px}
.card h2{font-size:1.05rem;margin-bottom:12px;color:var(--accent)}
.card h3{font-size:.95rem;margin-bottom:8px;color:var(--text)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--surface2);border-radius:10px;padding:14px;text-align:center}
.stat .n{font-size:1.6rem;font-weight:700;color:var(--accent)}
.stat .l{font-size:.72rem;color:var(--text2);margin-top:3px}
input,textarea,select{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface2);color:var(--text);font-size:.88rem;margin-bottom:8px}
textarea{min-height:70px;resize:vertical}
input:focus,textarea:focus{outline:none;border-color:var(--accent)}
button,.btn{padding:9px 18px;border:none;border-radius:8px;cursor:pointer;font-size:.83rem;font-weight:600;transition:.2s;display:inline-flex;align-items:center;gap:5px}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#c73a52}
.btn-success{background:var(--success);color:#000}
.btn-success:hover{background:#00a844}
.btn-danger{background:var(--danger);color:#fff}
.btn-danger:hover{background:#d50000}
.btn-warning{background:var(--warning);color:#000}
.btn-warning:hover{background:#e68200}
.btn-secondary{background:var(--primary);color:var(--text)}
.btn-secondary:hover{background:#0a2645}
.btn-sm{padding:5px 10px;font-size:.78rem}
.item-list{list-style:none}
.item-list li{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);transition:.15s;gap:8px}
.item-list li:hover{background:var(--surface2)}
.item-list li:last-child{border-bottom:none}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:.72rem;font-weight:600}
.badge-active{background:var(--success);color:#000}
.badge-stopped{background:var(--danger);color:#fff}
.badge-ok{background:var(--success);color:#000}
.badge-warn{background:var(--warning);color:#000}
.badge-error{background:var(--danger);color:#fff}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:10px;color:#fff;font-weight:600;z-index:9999;animation:slideIn .3s ease;max-width:380px;font-size:.88rem}
.toast.success{background:var(--success);color:#000}
.toast.error{background:var(--danger)}
.toast.info{background:var(--primary)}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.login-bar{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.login-bar input{margin-bottom:0;width:auto;flex:1;min-width:160px}
.login-bar label{color:var(--text2);font-size:.83rem;white-space:nowrap}
.mt10{margin-top:10px}.mb10{margin-bottom:10px}.mb20{margin-bottom:20px}
.flex-gap{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.campaign-msg{background:var(--surface2);border-radius:8px;padding:10px;margin:6px 0;white-space:pre-wrap;font-size:.85rem;color:var(--text2);max-height:120px;overflow-y:auto}
.campaign-photo{max-width:180px;max-height:120px;border-radius:8px;margin:6px 0}
.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;width:90%;max-width:500px;max-height:80vh;overflow-y:auto}
.modal h2{margin-bottom:14px;color:var(--accent)}
.hidden{display:none!important}
.detect-item{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--border);font-size:.85rem}
.detect-item:hover{background:var(--surface2)}
.detect-item label{display:flex;align-items:center;gap:6px;cursor:pointer;flex:1}
.info-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:.88rem}
.info-grid .lbl{color:var(--text2)}
table.admin-tbl{width:100%;border-collapse:collapse;font-size:.82rem}
table.admin-tbl th,table.admin-tbl td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}
table.admin-tbl th{color:var(--accent);font-weight:600}
@media(max-width:768px){
.sidebar{width:100%;height:auto;position:relative;display:flex;flex-wrap:wrap;padding:8px;gap:2px}
.sidebar h1{width:100%;padding:6px}
.sidebar .nav-item{padding:6px 10px;border-left:none;border-bottom:2px solid transparent;font-size:.75rem}
.sidebar .nav-item.active{border-bottom-color:var(--accent)}
.sidebar .nav-item span{margin-left:3px}
.sidebar .nav-sep{display:none}
.main{margin-left:0;padding:12px}
body{flex-direction:column}
}
</style>
</head>
<body>

<div class="sidebar" id="sidebarEl">
  <h1>J&D Spam Bot</h1>
  <div class="nav-item active" data-sec="dashboard"><span>Dashboard</span></div>
  <div class="nav-item" data-sec="perfil"><span>Mi Perfil</span></div>
  <div class="nav-sep"></div>
  <div class="nav-item" data-sec="cuentas"><span>Cuentas</span></div>
  <div class="nav-item" data-sec="grupos"><span>Grupos</span></div>
  <div class="nav-item" data-sec="detectar"><span>Detectar Grupos</span></div>
  <div class="nav-sep"></div>
  <div class="nav-item" data-sec="campanas"><span>Campanas</span></div>
  <div class="nav-item" data-sec="control"><span>Control</span></div>
  <div class="nav-item" data-sec="intervalo"><span>Intervalo</span></div>
  <div class="nav-sep"></div>
  <div class="nav-item" data-sec="responder"><span>Responder</span></div>
  <div class="nav-item" data-sec="historial"><span>Historial</span></div>
  <div class="nav-sep"></div>
  <div class="nav-item" data-sec="membresia"><span>Membresia</span></div>
  <div class="nav-item hidden" data-sec="admin" id="navAdmin"><span>Admin</span></div>
</div>

<div class="main">

<!-- LOGIN BAR -->
<div class="login-bar">
  <label>Tu ID de Telegram:</label>
  <input type="number" id="userId" placeholder="Ej: 123456789" style="max-width:200px">
  <button class="btn btn-primary" onclick="conectar()">Conectar</button>
  <span id="connStatus" style="color:var(--text2);font-size:.83rem"></span>
</div>

<!-- DASHBOARD -->
<div id="sec-dashboard" class="section active">
  <div class="card">
    <h2>Dashboard</h2>
    <div class="stats" id="dashStats"></div>
  </div>
</div>

<!-- PERFIL -->
<div id="sec-perfil" class="section">
  <div class="card">
    <h2>Mi Perfil</h2>
    <div id="perfilContent"></div>
  </div>
</div>

<!-- CUENTAS -->
<div id="sec-cuentas" class="section">
  <div class="card">
    <h2>Cuentas de Telegram</h2>
    <p style="color:var(--text2);margin-bottom:12px;font-size:.83rem">
      Al agregar una cuenta, el codigo de verificacion llega a tu <b>app de Telegram</b> (no por SMS).
    </p>
    <div class="flex-gap mb10">
      <input id="accTel" placeholder="+51987654321" style="max-width:170px">
      <input id="accNombre" placeholder="Nombre" style="max-width:150px">
      <button class="btn btn-primary" onclick="agregarCuenta()">Agregar</button>
    </div>
    <div id="accCodeBox" class="hidden card" style="border-color:var(--accent)">
      <p id="accCodeMsg" style="margin-bottom:8px"></p>
      <div id="accCodeInput" class="flex-gap">
        <input id="accCode" placeholder="Codigo de Telegram" style="max-width:180px">
        <button class="btn btn-success" onclick="verificarCodigo()">Verificar</button>
      </div>
      <div id="acc2faInput" class="hidden flex-gap">
        <input id="acc2fa" placeholder="Contrasena 2FA" type="password" style="max-width:180px">
        <button class="btn btn-success" onclick="verificar2FA()">Verificar</button>
      </div>
    </div>
    <ul class="item-list" id="accList"></ul>
  </div>
</div>

<!-- GRUPOS -->
<div id="sec-grupos" class="section">
  <div class="card">
    <h2>Grupos</h2>
    <textarea id="grpLinks" placeholder="Pega los links de grupos (uno por linea)&#10;Ej: https://t.me/grupo1&#10;@otrogrupo" rows="3"></textarea>
    <div class="flex-gap mb10">
      <button class="btn btn-primary" onclick="agregarGrupos()">Agregar</button>
      <button class="btn btn-secondary btn-sm" onclick="exportarGrupos()">Exportar</button>
      <button class="btn btn-danger btn-sm" onclick="eliminarTodosGrupos()">Eliminar Todos</button>
    </div>
    <p id="grpCount" style="color:var(--text2);font-size:.83rem;margin-bottom:6px"></p>
    <ul class="item-list" id="grpList"></ul>
  </div>
</div>

<!-- DETECTAR GRUPOS -->
<div id="sec-detectar" class="section">
  <div class="card">
    <h2>Detectar Grupos de Telegram</h2>
    <p style="color:var(--text2);font-size:.83rem;margin-bottom:12px">
      Escanea tu cuenta de Telegram para encontrar grupos automaticamente.
    </p>
    <div class="flex-gap mb10">
      <button class="btn btn-primary" onclick="detectarTodos()">Todos mis grupos</button>
      <button class="btn btn-secondary" onclick="detectarCarpetas()">Por carpeta</button>
      <button class="btn btn-warning" onclick="verificarEstado()">Verificar estado</button>
    </div>
    <div id="detectResult"></div>
  </div>
</div>

<!-- CAMPANAS -->
<div id="sec-campanas" class="section">
  <div class="card">
    <h2>Campanas</h2>
    <button class="btn btn-primary mb10" onclick="mostrarModalCampana()">+ Nueva Campana</button>
    <div id="campList"></div>
  </div>
</div>

<!-- CONTROL -->
<div id="sec-control" class="section">
  <div class="card">
    <h2>Control de Campanas</h2>
    <p style="color:var(--text2);font-size:.83rem;margin-bottom:12px">Inicia o detiene tus campanas desde aqui.</p>
    <div id="ctrlList"></div>
    <button class="btn btn-danger mt10" onclick="detenerTodas()">Detener TODAS</button>
  </div>
</div>

<!-- INTERVALO -->
<div id="sec-intervalo" class="section">
  <div class="card">
    <h2>Intervalo de Envio</h2>
    <p style="color:var(--text2);font-size:.83rem;margin-bottom:12px">
      Configura el tiempo entre envios para cada campana.<br>
      Recomendado: 1 cuenta: 30-60s | 2 cuentas: 15-30s | 3+ cuentas: 10-20s
    </p>
    <div id="intervaloList"></div>
  </div>
</div>

<!-- RESPONDER -->
<div id="sec-responder" class="section">
  <div class="card">
    <h2>Auto-Responder</h2>
    <div class="flex-gap mb10">
      <input id="respContacto" placeholder="@MiContacto" style="max-width:180px">
    </div>
    <textarea id="respKeywords" placeholder="Palabras clave (una por linea)&#10;Ej: disney&#10;netflix&#10;iptv" rows="4"></textarea>
    <div class="flex-gap mb10">
      <button class="btn btn-success" onclick="activarResponder()">Activar</button>
      <button class="btn btn-danger" onclick="desactivarResponder()">Desactivar</button>
    </div>
    <div id="respStatus" style="color:var(--text2);font-size:.83rem"></div>
  </div>
</div>

<!-- HISTORIAL -->
<div id="sec-historial" class="section">
  <div class="card">
    <h2>Historial</h2>
    <button class="btn btn-danger btn-sm mb10" onclick="limpiarHistorial()">Limpiar Historial</button>
    <div id="histContent"></div>
  </div>
</div>

<!-- MEMBRESIA -->
<div id="sec-membresia" class="section">
  <div class="card">
    <h2>Membresia / Planes</h2>
    <div id="membresiaContent"></div>
  </div>
</div>

<!-- ADMIN -->
<div id="sec-admin" class="section">
  <div class="card">
    <h2>Panel Admin</h2>
    <div id="adminContent"></div>
  </div>
</div>

</div><!-- /main -->

<!-- MODAL NUEVA CAMPANA -->
<div id="modalCampana" class="modal-overlay hidden">
  <div class="modal">
    <h2 id="modalCampTitle">Nueva Campana</h2>
    <input id="campNombre" placeholder="Nombre de la campana">
    <textarea id="campMensaje" placeholder="Mensaje que se enviara a los grupos" rows="4"></textarea>
    <label style="color:var(--text2);font-size:.83rem">Foto (opcional):</label>
    <input type="file" id="campFoto" accept="image/*" style="margin-bottom:12px">
    <div class="flex-gap">
      <button class="btn btn-primary" onclick="crearCampana()">Crear Campana</button>
      <button class="btn btn-secondary" onclick="cerrarModal('modalCampana')">Cancelar</button>
    </div>
  </div>
</div>

<!-- MODAL EDITAR CAMPANA -->
<div id="modalEditCamp" class="modal-overlay hidden">
  <div class="modal">
    <h2>Editar Campana</h2>
    <input id="editCampId" type="hidden">
    <textarea id="editCampMensaje" placeholder="Nuevo mensaje" rows="4"></textarea>
    <label style="color:var(--text2);font-size:.83rem">Nueva foto (opcional):</label>
    <input type="file" id="editCampFoto" accept="image/*" style="margin-bottom:12px">
    <div class="flex-gap">
      <button class="btn btn-primary" onclick="editarCampana()">Guardar</button>
      <button class="btn btn-secondary" onclick="cerrarModal('modalEditCamp')">Cancelar</button>
    </div>
  </div>
</div>

<!-- MODAL CLONAR CAMPANA -->
<div id="modalClonar" class="modal-overlay hidden">
  <div class="modal">
    <h2>Clonar Campana</h2>
    <input id="clonarCampId" type="hidden">
    <input id="clonarNombre" placeholder="Nombre de la copia">
    <div class="flex-gap">
      <button class="btn btn-primary" onclick="clonarCampana()">Clonar</button>
      <button class="btn btn-secondary" onclick="cerrarModal('modalClonar')">Cancelar</button>
    </div>
  </div>
</div>

<!-- MODAL EDITAR GRUPO -->
<div id="modalEditGrp" class="modal-overlay hidden">
  <div class="modal">
    <h2>Editar Grupo</h2>
    <input id="editGrpId" type="hidden">
    <input id="editGrpLink" placeholder="Nuevo link del grupo">
    <div class="flex-gap">
      <button class="btn btn-primary" onclick="guardarGrupoEdit()">Guardar</button>
      <button class="btn btn-secondary" onclick="cerrarModal('modalEditGrp')">Cancelar</button>
    </div>
  </div>
</div>

<!-- MODAL ADMIN ACTIVAR -->
<div id="modalAdminActivar" class="modal-overlay hidden">
  <div class="modal">
    <h2>Activar Membresia</h2>
    <input id="admActId" placeholder="User ID de Telegram" type="number">
    <select id="admActPlan">
      <option value="1">Diario (1 dia)</option>
      <option value="7">Semanal (7 dias)</option>
      <option value="30" selected>Mensual (30 dias)</option>
    </select>
    <div class="flex-gap">
      <button class="btn btn-success" onclick="adminActivar()">Activar</button>
      <button class="btn btn-secondary" onclick="cerrarModal('modalAdminActivar')">Cancelar</button>
    </div>
  </div>
</div>

<script>
let UID = localStorage.getItem('jd_uid') || '';
const $ = id => document.getElementById(id);

const SECTIONS = ['dashboard','perfil','cuentas','grupos','detectar','campanas','control','intervalo','responder','historial','membresia','admin'];

if(UID) { $('userId').value = UID; setTimeout(conectar, 300); }

function toast(msg, type='info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function api(path, opts) {
  try {
    const r = await fetch('/api/' + path, opts);
    return await r.json();
  } catch(e) {
    toast('Error de conexion: ' + e.message, 'error');
    return { ok: false, error: e.message };
  }
}

function conectar() {
  UID = $('userId').value.trim();
  if(!UID) return toast('Ingresa tu ID de Telegram', 'error');
  localStorage.setItem('jd_uid', UID);
  $('connStatus').textContent = 'Conectado: ' + UID;
  // show admin nav if admin
  checkAdmin();
  loadAll();
}

async function checkAdmin() {
  const r = await api('perfil?u='+UID);
  if(r.ok && r.is_admin) $('navAdmin').classList.remove('hidden');
  else $('navAdmin').classList.add('hidden');
}

// Nav click handlers
document.querySelectorAll('.nav-item[data-sec]').forEach(el => {
  el.addEventListener('click', () => showSection(el.dataset.sec));
});

function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = $('sec-'+name);
  if(sec) sec.classList.add('active');
  const nav = document.querySelector(`.nav-item[data-sec="${name}"]`);
  if(nav) nav.classList.add('active');
  const loaders = {
    dashboard: loadDashboard, perfil: loadPerfil, cuentas: loadCuentas,
    grupos: loadGrupos, campanas: loadCampanas, control: loadControl,
    intervalo: loadIntervalo, responder: loadResponder, historial: loadHistorial,
    membresia: loadMembresia, admin: loadAdmin,
  };
  if(loaders[name]) loaders[name]();
}

function loadAll() { loadDashboard(); }

function cerrarModal(id) { $(id).classList.add('hidden'); }

function escapeHtml(t){if(!t)return '';return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function escapeJs(t){if(!t)return '';return t.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n')}

// ─── DASHBOARD ───
async function loadDashboard() {
  if(!UID) return;
  const r = await api('dashboard?u='+UID);
  if(!r.ok) return;
  $('dashStats').innerHTML = `
    <div class="stat"><div class="n">${r.cuentas}</div><div class="l">Cuentas</div></div>
    <div class="stat"><div class="n">${r.grupos}</div><div class="l">Grupos</div></div>
    <div class="stat"><div class="n">${r.campanas}</div><div class="l">Campanas</div></div>
    <div class="stat"><div class="n">${r.campanas_activas}</div><div class="l">Activas</div></div>
    <div class="stat"><div class="n">${r.total_enviados}</div><div class="l">Enviados</div></div>
    <div class="stat"><div class="n">${r.total_errores}</div><div class="l">Errores</div></div>
    <div class="stat"><div class="n">${r.keywords}</div><div class="l">Keywords</div></div>
    <div class="stat"><div class="n">${r.responder_activo ? 'ON' : 'OFF'}</div><div class="l">Responder</div></div>
  `;
}

// ─── PERFIL ───
async function loadPerfil() {
  if(!UID) return;
  const r = await api('perfil?u='+UID);
  if(!r.ok) return;
  $('perfilContent').innerHTML = `
    <div class="info-grid">
      <span class="lbl">ID:</span><span>${r.user_id}</span>
      <span class="lbl">Plan:</span><span>${r.plan}</span>
      <span class="lbl">Estado:</span><span>${r.estado === 'activa' ? '<span style="color:var(--success)">Activa</span>' : '<span style="color:var(--danger)">Inactiva</span>'}</span>
      <span class="lbl">Expira:</span><span>${r.expira}</span>
      <span class="lbl">Resta:</span><span>${r.resta}</span>
      <span class="lbl">Registro:</span><span>${r.fecha_registro}</span>
    </div>
    <hr style="border-color:var(--border);margin:14px 0">
    <h3 style="margin-bottom:8px">Recursos</h3>
    <div class="stats">
      <div class="stat"><div class="n">${r.cuentas}</div><div class="l">Cuentas</div></div>
      <div class="stat"><div class="n">${r.grupos}</div><div class="l">Grupos</div></div>
      <div class="stat"><div class="n">${r.campanas}</div><div class="l">Campanas</div></div>
      <div class="stat"><div class="n">${r.total_enviados}</div><div class="l">Enviados</div></div>
      <div class="stat"><div class="n">${r.total_errores}</div><div class="l">Errores</div></div>
    </div>
  `;
}

// ─── CUENTAS ───
let loginNombre = '';

async function loadCuentas() {
  if(!UID) return;
  const r = await api('cuentas?u='+UID);
  if(!r.ok) return;
  const list = $('accList');
  if(!r.cuentas.length) {
    list.innerHTML = '<li style="color:var(--text2)">(sin cuentas registradas)</li>';
    return;
  }
  list.innerHTML = r.cuentas.map(c => `
    <li>
      <span><b>${escapeHtml(c.nombre)}</b> — ${escapeHtml(c.telefono)}</span>
      <button class="btn btn-danger btn-sm" onclick="eliminarCuenta('${escapeJs(c.nombre)}')">Eliminar</button>
    </li>
  `).join('');
}

async function agregarCuenta() {
  if(!UID) return toast('Conecta primero', 'error');
  const tel = $('accTel').value.trim();
  const nombre = $('accNombre').value.trim();
  if(!tel || !nombre) return toast('Completa telefono y nombre', 'error');
  loginNombre = nombre;

  const r = await api('cuenta/enviar_codigo', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, telefono: tel, nombre })
  });

  if(!r.ok) return toast(r.error, 'error');

  if(r.step === 'done') {
    toast(r.msg, 'success');
    $('accCodeBox').classList.add('hidden');
    loadCuentas();
    return;
  }
  $('accCodeBox').classList.remove('hidden');
  $('accCodeMsg').textContent = r.msg;
  $('accCodeInput').classList.remove('hidden');
  $('acc2faInput').classList.add('hidden');
}

async function verificarCodigo() {
  const codigo = $('accCode').value.trim();
  if(!codigo) return toast('Ingresa el codigo', 'error');
  const r = await api('cuenta/verificar_codigo', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, nombre: loginNombre, codigo })
  });
  if(!r.ok) { toast(r.error, 'error'); $('accCodeBox').classList.add('hidden'); return; }
  if(r.step === 'done') {
    toast(r.msg, 'success');
    $('accCodeBox').classList.add('hidden');
    $('accCode').value = '';
    loadCuentas();
  } else if(r.step === '2fa') {
    $('accCodeMsg').textContent = r.msg;
    $('accCodeInput').classList.add('hidden');
    $('acc2faInput').classList.remove('hidden');
  }
}

async function verificar2FA() {
  const pw = $('acc2fa').value.trim();
  if(!pw) return toast('Ingresa la contrasena', 'error');
  const r = await api('cuenta/verificar_2fa', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, nombre: loginNombre, password: pw })
  });
  if(!r.ok) { toast(r.error, 'error'); $('accCodeBox').classList.add('hidden'); return; }
  toast(r.msg, 'success');
  $('accCodeBox').classList.add('hidden');
  $('acc2fa').value = '';
  loadCuentas();
}

async function eliminarCuenta(nombre) {
  if(!confirm('Eliminar cuenta "' + nombre + '"?')) return;
  const r = await api('cuenta/eliminar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, nombre })
  });
  if(r.ok) { toast(r.msg, 'success'); loadCuentas(); }
  else toast(r.error, 'error');
}

// ─── GRUPOS ───
async function loadGrupos() {
  if(!UID) return;
  const r = await api('grupos?u='+UID);
  if(!r.ok) return;
  $('grpCount').textContent = `Total: ${r.grupos.length}/${r.max} grupos`;
  const list = $('grpList');
  if(!r.grupos.length) {
    list.innerHTML = '<li style="color:var(--text2)">(sin grupos)</li>';
    return;
  }
  list.innerHTML = r.grupos.map(g => `
    <li>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${escapeHtml(g.link)}</span>
      <div class="flex-gap">
        <button class="btn btn-secondary btn-sm" onclick="abrirEditGrupo(${g.id},'${escapeJs(g.link)}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="eliminarGrupo(${g.id})">Eliminar</button>
      </div>
    </li>
  `).join('');
}

async function agregarGrupos() {
  if(!UID) return toast('Conecta primero', 'error');
  const links = $('grpLinks').value.trim();
  if(!links) return toast('Pega al menos un link', 'error');
  const r = await api('grupo/agregar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, links })
  });
  if(r.ok) {
    let msg = `${r.agregados} agregado(s)`;
    if(r.duplicados) msg += `, ${r.duplicados} duplicado(s)`;
    if(r.invalidos) msg += `, ${r.invalidos} invalido(s)`;
    toast(msg, r.agregados > 0 ? 'success' : 'info');
    $('grpLinks').value = '';
    loadGrupos();
  } else toast(r.error, 'error');
}

async function eliminarGrupo(id) {
  if(!confirm('Eliminar este grupo?')) return;
  const r = await api('grupo/eliminar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, id })
  });
  if(r.ok) { toast('Grupo eliminado', 'success'); loadGrupos(); }
  else toast(r.error, 'error');
}

async function eliminarTodosGrupos() {
  if(!confirm('Eliminar TODOS tus grupos?')) return;
  const r = await api('grupo/eliminar_todos', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID })
  });
  if(r.ok) { toast('Todos eliminados', 'success'); loadGrupos(); }
  else toast(r.error, 'error');
}

function abrirEditGrupo(id, link) {
  $('editGrpId').value = id;
  $('editGrpLink').value = link;
  $('modalEditGrp').classList.remove('hidden');
}

async function guardarGrupoEdit() {
  const id = $('editGrpId').value;
  const link = $('editGrpLink').value.trim();
  if(!link) return toast('Ingresa un link', 'error');
  const r = await api('grupo/editar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, id: parseInt(id), link })
  });
  if(r.ok) { toast(r.msg, 'success'); cerrarModal('modalEditGrp'); loadGrupos(); }
  else toast(r.error, 'error');
}

async function exportarGrupos() {
  if(!UID) return toast('Conecta primero', 'error');
  const r = await api('grupo/exportar?u='+UID);
  if(!r.ok) return toast(r.error, 'error');
  if(!r.links.length) return toast('Sin grupos para exportar', 'info');
  const text = r.links.join('\n');
  navigator.clipboard.writeText(text).then(() => {
    toast(`${r.total} link(s) copiados al portapapeles`, 'success');
  }).catch(() => {
    $('grpLinks').value = text;
    toast(`${r.total} link(s) cargados en el textarea`, 'info');
  });
}

// ─── DETECTAR GRUPOS ───
async function detectarTodos() {
  if(!UID) return toast('Conecta primero', 'error');
  $('detectResult').innerHTML = '<p style="color:var(--text2)">Escaneando grupos de Telegram... (esto puede tardar)</p>';
  const r = await api('detectar/todos?u='+UID);
  if(!r.ok) return $('detectResult').innerHTML = `<p style="color:var(--danger)">${r.error}</p>`;
  if(!r.grupos.length) return $('detectResult').innerHTML = '<p style="color:var(--text2)">No se encontraron grupos.</p>';

  let html = `<p style="margin-bottom:8px">Cuenta: <b>${escapeHtml(r.cuenta)}</b> | Total: ${r.total} | Con link: ${r.con_link} | Baneados: ${r.baneados}</p>`;
  html += '<div style="margin-bottom:8px"><button class="btn btn-success btn-sm" onclick="detectAgregarSel()">Agregar seleccionados</button> <button class="btn btn-secondary btn-sm" onclick="detectSelTodos()">Seleccionar todos</button></div>';
  html += '<div id="detectItems">';
  r.grupos.forEach((g, i) => {
    const banned = g.banned ? ' <span class="badge badge-error">BANEADO</span>' : '';
    const restricted = g.restricted ? ' <span class="badge badge-warn">RESTRINGIDO</span>' : '';
    const link = g.link ? ' <span style="color:var(--success)">🔗</span>' : ' <span style="color:var(--text2)">🔒</span>';
    const members = g.participants ? ` (${g.participants})` : '';
    const disabled = g.link ? '' : 'disabled';
    html += `<div class="detect-item">
      <label><input type="checkbox" value="${escapeHtml(g.link||'')}" ${disabled} ${g.link?'':'title="Sin link publico"'}> ${i+1}. ${escapeHtml(g.title)}${members}${link}${banned}${restricted}</label>
    </div>`;
  });
  html += '</div>';
  $('detectResult').innerHTML = html;
}

function detectSelTodos() {
  document.querySelectorAll('#detectItems input[type=checkbox]:not(:disabled)').forEach(c => c.checked = true);
}

async function detectAgregarSel() {
  const checks = document.querySelectorAll('#detectItems input[type=checkbox]:checked');
  const links = [];
  checks.forEach(c => { if(c.value) links.push(c.value); });
  if(!links.length) return toast('Selecciona al menos un grupo', 'error');
  const r = await api('detectar/agregar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, links })
  });
  if(r.ok) { toast(`${r.agregados} grupo(s) agregados`, 'success'); loadGrupos(); }
  else toast(r.error, 'error');
}

async function detectarCarpetas() {
  if(!UID) return toast('Conecta primero', 'error');
  $('detectResult').innerHTML = '<p style="color:var(--text2)">Leyendo carpetas...</p>';
  const r = await api('detectar/carpetas?u='+UID);
  if(!r.ok) return $('detectResult').innerHTML = `<p style="color:var(--danger)">${r.error}</p>`;
  if(!r.carpetas.length) return $('detectResult').innerHTML = '<p style="color:var(--text2)">No tienes carpetas en Telegram.</p>';

  let html = '<h3 style="margin-bottom:8px">Tus Carpetas</h3>';
  r.carpetas.forEach(c => {
    html += `<div class="detect-item"><span>${escapeHtml(c.title)}</span><button class="btn btn-secondary btn-sm" onclick="detectarCarpetaGrupos(${c.id})">Ver grupos</button></div>`;
  });
  $('detectResult').innerHTML = html;
}

async function detectarCarpetaGrupos(folderId) {
  $('detectResult').innerHTML = '<p style="color:var(--text2)">Leyendo grupos de la carpeta...</p>';
  const r = await api('detectar/carpeta_grupos?u='+UID+'&folder='+folderId);
  if(!r.ok) return $('detectResult').innerHTML = `<p style="color:var(--danger)">${r.error}</p>`;
  if(!r.grupos.length) return $('detectResult').innerHTML = '<p style="color:var(--text2)">No hay grupos en esta carpeta.</p>';

  let html = `<p style="margin-bottom:8px">Total: ${r.total} | Con link: ${r.con_link}</p>`;
  html += '<div style="margin-bottom:8px"><button class="btn btn-success btn-sm" onclick="detectAgregarSel()">Agregar seleccionados</button> <button class="btn btn-secondary btn-sm" onclick="detectSelTodos()">Seleccionar todos</button> <button class="btn btn-secondary btn-sm" onclick="detectarCarpetas()">Volver</button></div>';
  html += '<div id="detectItems">';
  r.grupos.forEach((g, i) => {
    const link = g.link ? ' <span style="color:var(--success)">🔗</span>' : ' <span style="color:var(--text2)">🔒</span>';
    const disabled = g.link ? '' : 'disabled';
    html += `<div class="detect-item">
      <label><input type="checkbox" value="${escapeHtml(g.link||'')}" ${disabled}> ${i+1}. ${escapeHtml(g.title)}${link}</label>
    </div>`;
  });
  html += '</div>';
  $('detectResult').innerHTML = html;
}

async function verificarEstado() {
  if(!UID) return toast('Conecta primero', 'error');
  $('detectResult').innerHTML = '<p style="color:var(--text2)">Verificando estado de tus grupos... (esto puede tardar)</p>';
  const r = await api('detectar/estado?u='+UID);
  if(!r.ok) return $('detectResult').innerHTML = `<p style="color:var(--danger)">${r.error}</p>`;
  if(!r.resultados.length) return $('detectResult').innerHTML = '<p style="color:var(--text2)">No tienes grupos guardados.</p>';

  const ICONS = {ok:'badge-ok',baneado:'badge-error',sin_permiso:'badge-error',solo_lectura:'badge-warn',privado:'badge-warn',no_miembro:'badge-warn',no_encontrado:'badge-error',link_expirado:'badge-error',restringido:'badge-warn',error:'badge-error',desconocido:'badge-warn'};

  let html = `<p style="margin-bottom:8px">Cuenta: <b>${escapeHtml(r.cuenta)}</b> | OK: ${r.ok_count} | Problemas: ${r.problemas}</p>`;
  if(r.problemas > 0) html += '<button class="btn btn-danger btn-sm mb10" onclick="limpiarProblematicos()">Eliminar problematicos</button>';
  r.resultados.forEach((res, i) => {
    const badge = ICONS[res.estado] || 'badge-warn';
    const titulo = typeof res.titulo === 'string' ? res.titulo : res.link;
    html += `<div class="detect-item"><span>${i+1}. ${escapeHtml(titulo)}</span><span class="badge ${badge}">${res.estado.replace(/_/g,' ').toUpperCase()}</span></div>`;
  });
  $('detectResult').innerHTML = html;
}

async function limpiarProblematicos() {
  if(!confirm('Eliminar todos los grupos con problemas?')) return;
  const r = await api('detectar/limpiar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID })
  });
  if(r.ok) { toast(`${r.eliminados} grupo(s) eliminados`, 'success'); loadGrupos(); verificarEstado(); }
  else toast(r.error, 'error');
}

// ─── CAMPANAS ───
async function loadCampanas() {
  if(!UID) return;
  const r = await api('campanas?u='+UID);
  if(!r.ok) return;
  if(!r.campanas.length) {
    $('campList').innerHTML = '<p style="color:var(--text2)">(sin campanas creadas)</p>';
    return;
  }
  $('campList').innerHTML = r.campanas.map(c => `
    <div class="card" style="border-color:${c.activa?'var(--success)':'var(--border)'}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <h3>${escapeHtml(c.nombre)}</h3>
        <span class="badge ${c.activa?'badge-active':'badge-stopped'}">${c.activa?'ACTIVA':'DETENIDA'}</span>
      </div>
      <div style="font-size:.82rem;color:var(--text2);margin-bottom:6px">
        Env: ${c.enviados} | Err: ${c.errores} | Intervalo: ${c.intervalo_min}-${c.intervalo_max}s | Cuentas: ${c.sesiones.length} | Grupos: ${c.grupos.length}
      </div>
      ${c.mensaje ? '<div class="campaign-msg">'+escapeHtml(c.mensaje)+'</div>' : ''}
      ${c.foto_path ? '<img class="campaign-photo" src="/media/'+c.foto_path.replace('media/','')+'">' : ''}
      <div class="flex-gap mt10">
        <button class="btn btn-secondary btn-sm" onclick="abrirEditCampana(${c.id},'${escapeJs(c.mensaje)}')">Editar</button>
        <button class="btn btn-secondary btn-sm" onclick="abrirClonar(${c.id})">Clonar</button>
        <button class="btn btn-warning btn-sm" onclick="resetearStats(${c.id})">Reset Stats</button>
        <button class="btn btn-danger btn-sm" onclick="eliminarCampana(${c.id})">Eliminar</button>
        ${!c.activa?'<button class="btn btn-success btn-sm" onclick="iniciarCampana('+c.id+')">Iniciar</button>':''}
        ${c.activa?'<button class="btn btn-danger btn-sm" onclick="detenerCampana('+c.id+')">Detener</button>':''}
      </div>
    </div>
  `).join('');
}

function mostrarModalCampana(){$('modalCampana').classList.remove('hidden');$('campNombre').value='';$('campMensaje').value='';$('campFoto').value=''}

function abrirEditCampana(id, msg) {
  $('editCampId').value = id;
  $('editCampMensaje').value = msg;
  $('editCampFoto').value = '';
  $('modalEditCamp').classList.remove('hidden');
}

function abrirClonar(id) {
  $('clonarCampId').value = id;
  $('clonarNombre').value = '';
  $('modalClonar').classList.remove('hidden');
}

async function crearCampana() {
  if(!UID) return toast('Conecta primero', 'error');
  const nombre = $('campNombre').value.trim();
  const mensaje = $('campMensaje').value.trim();
  const fotoInput = $('campFoto');
  if(!nombre) return toast('Ingresa un nombre', 'error');
  if(!mensaje && !fotoInput.files.length) return toast('Ingresa un mensaje o una foto', 'error');

  const fd = new FormData();
  fd.append('u', UID);
  fd.append('nombre', nombre);
  fd.append('mensaje', mensaje);
  if(fotoInput.files.length) fd.append('foto', fotoInput.files[0]);

  const r = await api('campana/crear', { method: 'POST', body: fd });
  if(r.ok) { toast(r.msg, 'success'); cerrarModal('modalCampana'); loadCampanas(); }
  else toast(r.error, 'error');
}

async function editarCampana() {
  const id = $('editCampId').value;
  const mensaje = $('editCampMensaje').value.trim();
  const fotoInput = $('editCampFoto');

  const fd = new FormData();
  fd.append('id', id);
  fd.append('mensaje', mensaje);
  if(fotoInput.files.length) fd.append('foto', fotoInput.files[0]);

  const r = await api('campana/editar', { method: 'POST', body: fd });
  if(r.ok) { toast(r.msg, 'success'); cerrarModal('modalEditCamp'); loadCampanas(); }
  else toast(r.error, 'error');
}

async function clonarCampana() {
  const id = $('clonarCampId').value;
  const nombre = $('clonarNombre').value.trim();
  if(!nombre) return toast('Ingresa un nombre', 'error');
  const r = await api('campana/clonar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, id: parseInt(id), nombre })
  });
  if(r.ok) { toast(r.msg, 'success'); cerrarModal('modalClonar'); loadCampanas(); }
  else toast(r.error, 'error');
}

async function resetearStats(id) {
  if(!confirm('Resetear estadisticas de esta campana?')) return;
  const r = await api('campana/resetear', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ id })
  });
  if(r.ok) { toast(r.msg, 'success'); loadCampanas(); }
  else toast(r.error, 'error');
}

async function eliminarCampana(id) {
  if(!confirm('Eliminar esta campana?')) return;
  const r = await api('campana/eliminar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ id })
  });
  if(r.ok) { toast('Campana eliminada', 'success'); loadCampanas(); }
  else toast(r.error, 'error');
}

async function iniciarCampana(id) {
  const r = await api('iniciar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, id })
  });
  if(r.ok) { toast(r.msg, 'success'); loadCampanas(); loadControl(); }
  else toast(r.error, 'error');
}

async function detenerCampana(id) {
  const r = await api('detener', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ id })
  });
  if(r.ok) { toast(r.msg, 'success'); loadCampanas(); loadControl(); }
  else toast(r.error, 'error');
}

// ─── CONTROL ───
async function loadControl() {
  if(!UID) return;
  const r = await api('campanas?u='+UID);
  if(!r.ok) return;
  if(!r.campanas.length) {
    $('ctrlList').innerHTML = '<p style="color:var(--text2)">(sin campanas)</p>';
    return;
  }
  $('ctrlList').innerHTML = r.campanas.map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid var(--border)">
      <div>
        <b>${escapeHtml(c.nombre)}</b>
        <span class="badge ${c.activa?'badge-active':'badge-stopped'}" style="margin-left:6px">${c.activa?'ACTIVA':'DETENIDA'}</span>
        <span style="color:var(--text2);font-size:.78rem;margin-left:6px">Env: ${c.enviados} | Err: ${c.errores}</span>
      </div>
      <div class="flex-gap">
        ${!c.activa?'<button class="btn btn-success btn-sm" onclick="iniciarCampana('+c.id+')">Iniciar</button>':''}
        ${c.activa?'<button class="btn btn-danger btn-sm" onclick="detenerCampana('+c.id+')">Detener</button>':''}
      </div>
    </div>
  `).join('');
}

async function detenerTodas() {
  if(!confirm('Detener TODAS las campanas?')) return;
  const r = await api('detener_todas', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID })
  });
  if(r.ok) { toast(`${r.detenidas} campana(s) detenida(s)`, 'success'); loadControl(); loadCampanas(); }
  else toast(r.error, 'error');
}

// ─── INTERVALO ───
async function loadIntervalo() {
  if(!UID) return;
  const r = await api('campanas?u='+UID);
  if(!r.ok) return;
  if(!r.campanas.length) {
    $('intervaloList').innerHTML = '<p style="color:var(--text2)">No tienes campanas. Crea una primero.</p>';
    return;
  }
  $('intervaloList').innerHTML = r.campanas.map(c => `
    <div class="card">
      <h3>${escapeHtml(c.nombre)}</h3>
      <p style="color:var(--text2);font-size:.83rem;margin-bottom:8px">Actual: ${c.intervalo_min}-${c.intervalo_max}s</p>
      <div class="flex-gap">
        <input id="intv_min_${c.id}" type="number" value="${c.intervalo_min}" min="3" max="3600" style="max-width:80px" placeholder="Min">
        <span style="color:var(--text2)">-</span>
        <input id="intv_max_${c.id}" type="number" value="${c.intervalo_max}" min="3" max="3600" style="max-width:80px" placeholder="Max">
        <span style="color:var(--text2);font-size:.83rem">seg</span>
        <button class="btn btn-primary btn-sm" onclick="guardarIntervalo(${c.id})">Guardar</button>
      </div>
    </div>
  `).join('');
}

async function guardarIntervalo(id) {
  const min = parseInt($('intv_min_'+id).value) || 30;
  const max = parseInt($('intv_max_'+id).value) || 60;
  const r = await api('campana/config', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ id, min, max })
  });
  if(r.ok) { toast(r.msg, 'success'); loadIntervalo(); }
  else toast(r.error, 'error');
}

// ─── RESPONDER ───
async function loadResponder() {
  if(!UID) return;
  const r = await api('responder?u='+UID);
  if(!r.ok) return;
  $('respContacto').value = r.contacto || '';
  $('respKeywords').value = (r.keywords || []).join('\n');
  $('respStatus').textContent = r.activo ? 'Estado: ACTIVO' : 'Estado: INACTIVO';
  $('respStatus').style.color = r.activo ? 'var(--success)' : 'var(--danger)';
}

async function activarResponder() {
  if(!UID) return toast('Conecta primero', 'error');
  const contacto = $('respContacto').value.trim();
  const kw = $('respKeywords').value.trim().split('\n').filter(k => k.trim());
  if(!contacto) return toast('Ingresa un contacto', 'error');
  if(!kw.length) return toast('Ingresa al menos una keyword', 'error');

  const r = await api('responder/config', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, contacto, keywords: kw })
  });
  if(r.ok) { toast(r.msg, 'success'); loadResponder(); }
  else toast(r.error, 'error');
}

async function desactivarResponder() {
  const r = await api('responder/toggle', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, activo: false })
  });
  if(r.ok) { toast('Responder desactivado', 'success'); loadResponder(); }
  else toast(r.error, 'error');
}

// ─── HISTORIAL ───
async function loadHistorial() {
  if(!UID) return;
  const r = await api('historial?u='+UID);
  if(!r.ok) return;
  let html = '';
  if(r.stats_grupo && r.stats_grupo.length) {
    html += '<h3 style="margin-bottom:6px">Envios por Grupo</h3><ul class="item-list">';
    r.stats_grupo.slice(0,20).forEach(s => {
      html += `<li><span>${escapeHtml(s.grupo)}</span><span style="color:var(--text2)">Env: ${s.enviados} | Err: ${s.errores}</span></li>`;
    });
    html += '</ul>';
  }
  if(r.stats_keywords && r.stats_keywords.length) {
    html += '<h3 style="margin:12px 0 6px">Respuestas por Keyword</h3><ul class="item-list">';
    r.stats_keywords.slice(0,20).forEach(s => {
      html += `<li><span>"${escapeHtml(s.keyword)}"</span><span style="color:var(--text2)">${s.total} resp.</span></li>`;
    });
    html += '</ul>';
  }
  if(r.stats_resp_grupo && r.stats_resp_grupo.length) {
    html += '<h3 style="margin:12px 0 6px">Respuestas por Grupo</h3><ul class="item-list">';
    r.stats_resp_grupo.slice(0,20).forEach(s => {
      html += `<li><span>${escapeHtml(s.grupo)}</span><span style="color:var(--text2)">${s.total} resp.</span></li>`;
    });
    html += '</ul>';
  }
  if(r.envios && r.envios.length) {
    html += '<h3 style="margin:12px 0 6px">Ultimos Envios</h3><ul class="item-list">';
    r.envios.slice(0,20).forEach(e => {
      const icon = e.resultado === 'enviado' ? '📤' : '❌';
      html += `<li><span>${icon} ${escapeHtml(e.grupo)}</span><span style="color:var(--text2)">${e.fecha || ''}</span></li>`;
    });
    html += '</ul>';
  }
  if(!html) html = '<p style="color:var(--text2)">Sin historial.</p>';
  $('histContent').innerHTML = html;
}

async function limpiarHistorial() {
  if(!confirm('Eliminar todo el historial?')) return;
  const r = await api('historial/limpiar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID })
  });
  if(r.ok) { toast('Historial limpiado', 'success'); loadHistorial(); }
  else toast(r.error, 'error');
}

// ─── MEMBRESIA ───
async function loadMembresia() {
  if(!UID) return;
  const [perfil, planes] = await Promise.all([
    api('perfil?u='+UID),
    api('planes')
  ]);
  if(!perfil.ok) return;
  let html = `
    <div class="info-grid mb20">
      <span class="lbl">Plan:</span><span>${perfil.plan}</span>
      <span class="lbl">Estado:</span><span>${perfil.estado === 'activa' ? '<span style="color:var(--success)">Activa</span>' : '<span style="color:var(--danger)">Inactiva</span>'}</span>
      <span class="lbl">Expira:</span><span>${perfil.expira}</span>
      <span class="lbl">Resta:</span><span>${perfil.resta}</span>
    </div>
  `;
  if(planes.ok) {
    html += '<h3 style="margin-bottom:8px">Planes Disponibles</h3>';
    planes.planes.forEach(p => {
      html += `<div class="card" style="padding:12px"><b>${p.emoji} ${p.nombre}</b> — ${p.precio} (${p.dias} dia${p.dias>1?'s':''})</div>`;
    });
    html += `<p style="color:var(--text2);font-size:.83rem;margin-top:8px">Pago por YAPE: <b>${planes.yape}</b></p>`;
  }
  $('membresiaContent').innerHTML = html;
}

// ─── ADMIN ───
async function loadAdmin() {
  if(!UID) return;
  const [stats, users] = await Promise.all([
    api('admin/stats?u='+UID),
    api('admin/usuarios?u='+UID)
  ]);
  if(!stats.ok) {
    $('adminContent').innerHTML = '<p style="color:var(--danger)">Sin permiso de admin.</p>';
    return;
  }
  let html = `
    <div class="stats mb20">
      <div class="stat"><div class="n">${stats.total_usuarios}</div><div class="l">Usuarios</div></div>
      <div class="stat"><div class="n">${stats.activos}</div><div class="l">Activos</div></div>
      <div class="stat"><div class="n">${stats.inactivos}</div><div class="l">Inactivos</div></div>
      <div class="stat"><div class="n">${stats.campanas_corriendo}</div><div class="l">Camp. Corriendo</div></div>
      <div class="stat"><div class="n">${stats.responders_activos}</div><div class="l">Responders</div></div>
    </div>
    <div class="flex-gap mb10">
      <button class="btn btn-success btn-sm" onclick="$('modalAdminActivar').classList.remove('hidden')">Activar Membresia</button>
    </div>
  `;
  if(users.ok && users.usuarios.length) {
    html += '<table class="admin-tbl"><tr><th>ID</th><th>Username</th><th>Estado</th><th>Plan</th><th>Acciones</th></tr>';
    users.usuarios.forEach(u => {
      html += `<tr>
        <td>${u.telegram_id}</td>
        <td>@${escapeHtml(u.username)}</td>
        <td>${u.activo ? '<span style="color:var(--success)">Activo</span>' : '<span style="color:var(--danger)">Inactivo</span>'}</td>
        <td>${escapeHtml(u.plan||'—')}</td>
        <td>
          ${u.activo ? `<button class="btn btn-danger btn-sm" onclick="adminDesactivar(${u.telegram_id})">Desactivar</button>` : `<button class="btn btn-success btn-sm" onclick="adminActivarRapido(${u.telegram_id})">Activar</button>`}
        </td>
      </tr>`;
    });
    html += '</table>';
  }
  $('adminContent').innerHTML = html;
}

async function adminActivar() {
  const target = $('admActId').value.trim();
  const dias = parseInt($('admActPlan').value);
  if(!target) return toast('Ingresa el User ID', 'error');
  const r = await api('admin/activar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, target: parseInt(target), dias })
  });
  if(r.ok) { toast(r.msg, 'success'); cerrarModal('modalAdminActivar'); loadAdmin(); }
  else toast(r.error, 'error');
}

async function adminActivarRapido(targetId) {
  const dias = prompt('Dias de membresia:', '30');
  if(!dias) return;
  const r = await api('admin/activar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, target: targetId, dias: parseInt(dias) })
  });
  if(r.ok) { toast(r.msg, 'success'); loadAdmin(); }
  else toast(r.error, 'error');
}

async function adminDesactivar(targetId) {
  if(!confirm('Desactivar membresia de ' + targetId + '?')) return;
  const r = await api('admin/desactivar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ u: UID, target: targetId })
  });
  if(r.ok) { toast(r.msg, 'success'); loadAdmin(); }
  else toast(r.error, 'error');
}
</script>
</body>
</html>"""


# ─────────────────────────────────────────
#   SERVIDOR WEB
# ─────────────────────────────────────────

def create_app():
    app = web.Application(client_max_size=10 * 1024 * 1024)
    app.router.add_get("/", serve_panel)

    app.router.add_get("/api/dashboard", api_dashboard)

    app.router.add_get("/api/cuentas", api_cuentas)
    app.router.add_post("/api/cuenta/enviar_codigo", api_cuenta_enviar_codigo)
    app.router.add_post("/api/cuenta/verificar_codigo", api_cuenta_verificar_codigo)
    app.router.add_post("/api/cuenta/verificar_2fa", api_cuenta_verificar_2fa)
    app.router.add_post("/api/cuenta/eliminar", api_cuenta_eliminar)

    app.router.add_get("/api/grupos", api_grupos)
    app.router.add_post("/api/grupo/agregar", api_grupo_agregar)
    app.router.add_post("/api/grupo/eliminar", api_grupo_eliminar)
    app.router.add_post("/api/grupo/eliminar_todos", api_grupo_eliminar_todos)
    app.router.add_post("/api/grupo/editar", api_grupo_editar)
    app.router.add_get("/api/grupo/exportar", api_grupo_exportar)

    app.router.add_get("/api/detectar/todos", api_detectar_todos)
    app.router.add_get("/api/detectar/carpetas", api_detectar_carpetas)
    app.router.add_get("/api/detectar/carpeta_grupos", api_detectar_carpeta_grupos)
    app.router.add_get("/api/detectar/estado", api_detectar_estado)
    app.router.add_post("/api/detectar/agregar", api_detectar_agregar)
    app.router.add_post("/api/detectar/limpiar", api_detectar_limpiar)

    app.router.add_get("/api/campanas", api_campanas)
    app.router.add_post("/api/campana/crear", api_campana_crear)
    app.router.add_post("/api/campana/editar", api_campana_editar)
    app.router.add_post("/api/campana/eliminar", api_campana_eliminar)
    app.router.add_post("/api/campana/config", api_campana_config)
    app.router.add_post("/api/campana/clonar", api_campana_clonar)
    app.router.add_post("/api/campana/resetear", api_campana_resetear)

    app.router.add_post("/api/iniciar", api_iniciar)
    app.router.add_post("/api/detener", api_detener)
    app.router.add_post("/api/detener_todas", api_detener_todas)

    app.router.add_get("/api/responder", api_responder)
    app.router.add_post("/api/responder/config", api_responder_config)
    app.router.add_post("/api/responder/toggle", api_responder_toggle)

    app.router.add_get("/api/historial", api_historial)
    app.router.add_post("/api/historial/limpiar", api_historial_limpiar)

    app.router.add_get("/api/perfil", api_perfil)
    app.router.add_get("/api/planes", api_planes)

    app.router.add_get("/api/admin/stats", api_admin_stats)
    app.router.add_get("/api/admin/usuarios", api_admin_usuarios)
    app.router.add_post("/api/admin/activar", api_admin_activar)
    app.router.add_post("/api/admin/desactivar", api_admin_desactivar)

    os.makedirs("media", exist_ok=True)
    app.router.add_static("/media/", path="media", name="media")

    return app


async def start_web_panel():
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()
    logger.info(f"Panel web iniciado en http://0.0.0.0:{WEB_PORT}")
