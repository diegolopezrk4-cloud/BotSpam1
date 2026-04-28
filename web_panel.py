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

from aiohttp import web
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

import db
from motor import (iniciar_campana, detener_campana, tareas_activas,
                   get_session_path, iniciar_responder, detener_responder,
                   responder_activos)

PERU_TZ = timezone(timedelta(hours=-5))

def ahora_peru():
    return datetime.now(PERU_TZ)

logger = logging.getLogger("JDWebPanel")

API_ID = 35451933
API_HASH = "2070761744260118720b34e6bf20f2eb"
WEB_PORT = int(os.environ.get("WEB_PORT", 8080))

# Sesiones de login temporales para la web
web_login_sessions = {}

# Referencia al bot de aiogram (se asigna desde bot.py)
aiogram_bot = None


def set_bot_reference(bot_instance):
    global aiogram_bot
    aiogram_bot = bot_instance


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
    """Paso 1: enviar codigo de verificacion a la cuenta de Telegram."""
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
    """Paso 2: verificar el codigo recibido."""
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
    """Paso 3: verificar 2FA si es necesario."""
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

    lineas = [l.strip() for l in links_raw.replace(" ", "\n").split("\n") if l.strip()]
    grupos_actuales = await db.get_grupos(user_id)
    links_existentes = {g["link"].lower() for g in grupos_actuales}
    max_g = await db.get_max_grupos(user_id)
    total = len(grupos_actuales)

    agregados = 0
    duplicados = 0
    invalidos = 0
    for linea in lineas:
        link = linea.strip()
        if link.startswith("t.me/"):
            link = "https://" + link
        if not (link.startswith("https://t.me/") or link.startswith("@") or link.startswith("http://t.me/")):
            invalidos += 1
            continue
        if total + agregados >= max_g:
            break
        if link.lower() in links_existentes:
            duplicados += 1
            continue
        await db.agregar_grupo(user_id, link)
        links_existentes.add(link.lower())
        agregados += 1

    return web.json_response({
        "ok": True,
        "agregados": agregados,
        "duplicados": duplicados,
        "invalidos": invalidos
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

    # Auto-asignar todas las cuentas y grupos del usuario
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
    await db.set_campana_config(campana_id, intervalo_min, intervalo_max)
    return web.json_response({"ok": True})


# --- CONTROL ---

async def api_iniciar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    campana_id = int(body.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)

    # Auto-asignar grupos si no tiene
    grupos_campana = await db.get_grupos_campana(campana_id)
    if not grupos_campana:
        grupos_user = await db.get_grupos(user_id)
        if not grupos_user:
            return web.json_response({"ok": False, "error": "Sin grupos. Agrega grupos primero."})
        for g in grupos_user:
            await db.agregar_grupo_campana(campana_id, g["link"])

    # Auto-asignar cuentas si no tiene
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
    resultado = detener_campana(campana_id)
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
    return web.json_response({
        "ok": True,
        "envios": [{"grupo": h["grupo_link"], "resultado": h["resultado"], "fecha": h["fecha"]} for h in hist],
        "stats_grupo": [{"grupo": s["grupo_link"], "enviados": s["enviados"], "errores": s["errores"]} for s in stats_grupo],
        "stats_keywords": [{"keyword": s["keyword"], "total": s["total"]} for s in stats_kw],
    })


async def api_historial_limpiar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.limpiar_historial(user_id)
    return web.json_response({"ok": True})


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
.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;position:fixed;height:100vh;overflow-y:auto}
.sidebar h1{text-align:center;font-size:1.2rem;padding:15px;color:var(--accent);border-bottom:1px solid var(--border);margin-bottom:10px}
.sidebar .nav-item{display:flex;align-items:center;padding:12px 20px;cursor:pointer;transition:.2s;color:var(--text2);border-left:3px solid transparent}
.sidebar .nav-item:hover{background:var(--surface2);color:var(--text)}
.sidebar .nav-item.active{background:var(--surface2);color:var(--accent);border-left-color:var(--accent)}
.sidebar .nav-item span{margin-left:10px}
.main{margin-left:240px;flex:1;padding:30px;max-width:900px}
.section{display:none}
.section.active{display:block}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}
.card h2{font-size:1.1rem;margin-bottom:15px;color:var(--accent)}
.card h3{font-size:1rem;margin-bottom:10px;color:var(--text)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.stat{background:var(--surface2);border-radius:10px;padding:15px;text-align:center}
.stat .n{font-size:1.8rem;font-weight:700;color:var(--accent)}
.stat .l{font-size:.75rem;color:var(--text2);margin-top:4px}
input,textarea,select{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface2);color:var(--text);font-size:.9rem;margin-bottom:10px}
textarea{min-height:80px;resize:vertical}
input:focus,textarea:focus{outline:none;border-color:var(--accent)}
button,.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:.85rem;font-weight:600;transition:.2s;display:inline-flex;align-items:center;gap:6px}
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
.btn-sm{padding:6px 12px;font-size:.8rem}
.item-list{list-style:none}
.item-list li{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);transition:.15s}
.item-list li:hover{background:var(--surface2)}
.item-list li:last-child{border-bottom:none}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:600}
.badge-active{background:var(--success);color:#000}
.badge-stopped{background:var(--danger);color:#fff}
.toast{position:fixed;top:20px;right:20px;padding:14px 24px;border-radius:10px;color:#fff;font-weight:600;z-index:9999;animation:slideIn .3s ease;max-width:400px}
.toast.success{background:var(--success);color:#000}
.toast.error{background:var(--danger)}
.toast.info{background:var(--primary)}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.login-bar{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.login-bar input{margin-bottom:0;width:auto;flex:1;min-width:180px}
.login-bar label{color:var(--text2);font-size:.85rem;white-space:nowrap}
.mt10{margin-top:10px}.mb10{margin-bottom:10px}.mb20{margin-bottom:20px}
.flex-gap{display:flex;gap:8px;flex-wrap:wrap}
.campaign-msg{background:var(--surface2);border-radius:8px;padding:12px;margin:8px 0;white-space:pre-wrap;font-size:.9rem;color:var(--text2);max-height:150px;overflow-y:auto}
.campaign-photo{max-width:200px;max-height:150px;border-radius:8px;margin:8px 0}
.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;width:90%;max-width:500px;max-height:80vh;overflow-y:auto}
.modal h2{margin-bottom:15px;color:var(--accent)}
.hidden{display:none!important}
@media(max-width:768px){
.sidebar{width:100%;height:auto;position:relative;display:flex;flex-wrap:wrap;padding:10px;gap:4px}
.sidebar h1{width:100%;padding:8px}
.sidebar .nav-item{padding:8px 12px;border-left:none;border-bottom:2px solid transparent;font-size:.8rem}
.sidebar .nav-item.active{border-bottom-color:var(--accent)}
.sidebar .nav-item span{margin-left:4px}
.main{margin-left:0;padding:15px}
body{flex-direction:column}
}
</style>
</head>
<body>

<div class="sidebar">
  <h1>J&D Spam Bot</h1>
  <div class="nav-item active" onclick="showSection('dashboard')"><span>Dashboard</span></div>
  <div class="nav-item" onclick="showSection('cuentas')"><span>Cuentas</span></div>
  <div class="nav-item" onclick="showSection('grupos')"><span>Grupos</span></div>
  <div class="nav-item" onclick="showSection('campanas')"><span>Campanas</span></div>
  <div class="nav-item" onclick="showSection('control')"><span>Control</span></div>
  <div class="nav-item" onclick="showSection('responder')"><span>Responder</span></div>
  <div class="nav-item" onclick="showSection('historial')"><span>Historial</span></div>
</div>

<div class="main">

<!-- LOGIN BAR -->
<div class="login-bar">
  <label>Tu ID de Telegram:</label>
  <input type="number" id="userId" placeholder="Ej: 123456789" style="max-width:220px">
  <button class="btn btn-primary" onclick="conectar()">Conectar</button>
  <span id="connStatus" style="color:var(--text2);font-size:.85rem"></span>
</div>

<!-- DASHBOARD -->
<div id="sec-dashboard" class="section active">
  <div class="card">
    <h2>Dashboard</h2>
    <div class="stats" id="dashStats"></div>
  </div>
</div>

<!-- CUENTAS -->
<div id="sec-cuentas" class="section">
  <div class="card">
    <h2>Gestion de Cuentas de Telegram</h2>
    <p style="color:var(--text2);margin-bottom:15px;font-size:.85rem">
      Al agregar una cuenta, el codigo de verificacion llega a tu <b>app de Telegram</b> (no por SMS).
    </p>
    <div class="flex-gap mb10">
      <input id="accTel" placeholder="+51987654321" style="max-width:180px">
      <input id="accNombre" placeholder="Nombre" style="max-width:160px">
      <button class="btn btn-primary" onclick="agregarCuenta()">Agregar</button>
    </div>
    <div id="accCodeBox" class="hidden card" style="border-color:var(--accent)">
      <p id="accCodeMsg" style="margin-bottom:10px"></p>
      <div id="accCodeInput" class="flex-gap">
        <input id="accCode" placeholder="Codigo de Telegram" style="max-width:200px">
        <button class="btn btn-success" onclick="verificarCodigo()">Verificar</button>
      </div>
      <div id="acc2faInput" class="hidden flex-gap">
        <input id="acc2fa" placeholder="Contrasena 2FA" type="password" style="max-width:200px">
        <button class="btn btn-success" onclick="verificar2FA()">Verificar</button>
      </div>
    </div>
    <ul class="item-list" id="accList"></ul>
  </div>
</div>

<!-- GRUPOS -->
<div id="sec-grupos" class="section">
  <div class="card">
    <h2>Gestion de Grupos</h2>
    <textarea id="grpLinks" placeholder="Pega los links de grupos (uno por linea)&#10;Ej: https://t.me/grupo1&#10;@otrogrupo" rows="3"></textarea>
    <div class="flex-gap mb10">
      <button class="btn btn-primary" onclick="agregarGrupos()">Agregar Grupos</button>
      <button class="btn btn-danger btn-sm" onclick="eliminarTodosGrupos()">Eliminar Todos</button>
    </div>
    <p id="grpCount" style="color:var(--text2);font-size:.85rem;margin-bottom:8px"></p>
    <ul class="item-list" id="grpList"></ul>
  </div>
</div>

<!-- CAMPANAS -->
<div id="sec-campanas" class="section">
  <div class="card">
    <h2>Gestion de Campanas</h2>
    <button class="btn btn-primary mb10" onclick="mostrarModalCampana()">+ Nueva Campana</button>
    <div id="campList"></div>
  </div>
</div>

<!-- CONTROL -->
<div id="sec-control" class="section">
  <div class="card">
    <h2>Control de Campanas</h2>
    <p style="color:var(--text2);font-size:.85rem;margin-bottom:15px">Inicia o detiene tus campanas desde aqui.</p>
    <div id="ctrlList"></div>
    <button class="btn btn-danger mt10" onclick="detenerTodas()">Detener TODAS</button>
  </div>
</div>

<!-- RESPONDER -->
<div id="sec-responder" class="section">
  <div class="card">
    <h2>Auto-Responder</h2>
    <div class="flex-gap mb10">
      <input id="respContacto" placeholder="@MiContacto" style="max-width:200px">
    </div>
    <textarea id="respKeywords" placeholder="Palabras clave (una por linea)&#10;Ej: disney&#10;netflix&#10;iptv" rows="4"></textarea>
    <div class="flex-gap mb10">
      <button class="btn btn-success" onclick="activarResponder()">Activar</button>
      <button class="btn btn-danger" onclick="desactivarResponder()">Desactivar</button>
    </div>
    <div id="respStatus" style="color:var(--text2);font-size:.85rem"></div>
  </div>
</div>

<!-- HISTORIAL -->
<div id="sec-historial" class="section">
  <div class="card">
    <h2>Historial de Envios</h2>
    <button class="btn btn-danger btn-sm mb10" onclick="limpiarHistorial()">Limpiar Historial</button>
    <div id="histContent"></div>
  </div>
</div>

</div><!-- /main -->

<!-- MODAL NUEVA CAMPANA -->
<div id="modalCampana" class="modal-overlay hidden">
  <div class="modal">
    <h2 id="modalCampTitle">Nueva Campana</h2>
    <input id="campNombre" placeholder="Nombre de la campana">
    <textarea id="campMensaje" placeholder="Mensaje que se enviara a los grupos" rows="4"></textarea>
    <label style="color:var(--text2);font-size:.85rem">Foto (opcional):</label>
    <input type="file" id="campFoto" accept="image/*" style="margin-bottom:15px">
    <div class="flex-gap">
      <button class="btn btn-primary" onclick="crearCampana()">Crear Campana</button>
      <button class="btn btn-secondary" onclick="cerrarModal()">Cancelar</button>
    </div>
  </div>
</div>

<!-- MODAL EDITAR CAMPANA -->
<div id="modalEditCamp" class="modal-overlay hidden">
  <div class="modal">
    <h2>Editar Campana</h2>
    <input id="editCampId" type="hidden">
    <textarea id="editCampMensaje" placeholder="Nuevo mensaje" rows="4"></textarea>
    <label style="color:var(--text2);font-size:.85rem">Nueva foto (opcional):</label>
    <input type="file" id="editCampFoto" accept="image/*" style="margin-bottom:15px">
    <div class="flex-gap">
      <button class="btn btn-primary" onclick="editarCampana()">Guardar</button>
      <button class="btn btn-secondary" onclick="cerrarModalEdit()">Cancelar</button>
    </div>
  </div>
</div>

<script>
let UID = localStorage.getItem('jd_uid') || '';
const $ = id => document.getElementById(id);

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
  loadAll();
}

function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = $('sec-'+name);
  if(sec) sec.classList.add('active');
  const navs = document.querySelectorAll('.nav-item');
  const idx = ['dashboard','cuentas','grupos','campanas','control','responder','historial'].indexOf(name);
  if(idx >= 0 && navs[idx]) navs[idx].classList.add('active');
  if(name === 'dashboard') loadDashboard();
  else if(name === 'cuentas') loadCuentas();
  else if(name === 'grupos') loadGrupos();
  else if(name === 'campanas') loadCampanas();
  else if(name === 'control') loadControl();
  else if(name === 'responder') loadResponder();
  else if(name === 'historial') loadHistorial();
}

function loadAll() {
  loadDashboard();
}

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
    <div class="stat"><div class="n">${r.responder_activo ? '🟢' : '🔴'}</div><div class="l">Responder</div></div>
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
      <span><b>${c.nombre}</b> — ${c.telefono}</span>
      <button class="btn btn-danger btn-sm" onclick="eliminarCuenta('${c.nombre}')">Eliminar</button>
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
      <span>${g.link}</span>
      <button class="btn btn-danger btn-sm" onclick="eliminarGrupo(${g.id})">Eliminar</button>
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
  if(r.ok) { toast('Todos los grupos eliminados', 'success'); loadGrupos(); }
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
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3>${c.nombre}</h3>
        <span class="badge ${c.activa?'badge-active':'badge-stopped'}">${c.activa?'ACTIVA':'DETENIDA'}</span>
      </div>
      <div style="font-size:.85rem;color:var(--text2);margin-bottom:8px">
        Enviados: ${c.enviados} | Errores: ${c.errores} | Intervalo: ${c.intervalo_min}-${c.intervalo_max}s
      </div>
      <div style="font-size:.85rem;color:var(--text2);margin-bottom:8px">
        Cuentas: ${c.sesiones.length} | Grupos: ${c.grupos.length}
      </div>
      ${c.mensaje ? '<div class="campaign-msg">'+escapeHtml(c.mensaje)+'</div>' : ''}
      ${c.foto_path ? '<img class="campaign-photo" src="/media/'+c.foto_path.replace('media/','')+'"> ' : ''}
      <div class="flex-gap mt10">
        <button class="btn btn-secondary btn-sm" onclick="abrirEditCampana(${c.id},'${escapeJs(c.mensaje)}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="eliminarCampana(${c.id})">Eliminar</button>
        ${!c.activa?'<button class="btn btn-success btn-sm" onclick="iniciarCampana('+c.id+')">Iniciar</button>':''}
        ${c.activa?'<button class="btn btn-warning btn-sm" onclick="detenerCampana('+c.id+')">Detener</button>':''}
      </div>
    </div>
  `).join('');
}

function escapeHtml(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function escapeJs(t){return t.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n')}

function mostrarModalCampana(){$('modalCampana').classList.remove('hidden');$('campNombre').value='';$('campMensaje').value='';$('campFoto').value=''}
function cerrarModal(){$('modalCampana').classList.add('hidden')}
function cerrarModalEdit(){$('modalEditCamp').classList.add('hidden')}

function abrirEditCampana(id, msg) {
  $('editCampId').value = id;
  $('editCampMensaje').value = msg;
  $('editCampFoto').value = '';
  $('modalEditCamp').classList.remove('hidden');
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
  if(r.ok) { toast(r.msg, 'success'); cerrarModal(); loadCampanas(); }
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
  if(r.ok) { toast(r.msg, 'success'); cerrarModalEdit(); loadCampanas(); }
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
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--border)">
      <div>
        <b>${c.nombre}</b>
        <span class="badge ${c.activa?'badge-active':'badge-stopped'}" style="margin-left:8px">${c.activa?'ACTIVA':'DETENIDA'}</span>
        <span style="color:var(--text2);font-size:.8rem;margin-left:8px">Env: ${c.enviados} | Err: ${c.errores}</span>
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
  if(r.stats_grupo.length) {
    html += '<h3 style="margin-bottom:8px">Envios por Grupo</h3><ul class="item-list">';
    r.stats_grupo.slice(0,20).forEach(s => {
      html += `<li><span>${s.grupo}</span><span style="color:var(--text2)">Env: ${s.enviados} | Err: ${s.errores}</span></li>`;
    });
    html += '</ul>';
  }
  if(r.stats_keywords.length) {
    html += '<h3 style="margin:15px 0 8px">Respuestas por Keyword</h3><ul class="item-list">';
    r.stats_keywords.slice(0,20).forEach(s => {
      html += `<li><span>"${escapeHtml(s.keyword)}"</span><span style="color:var(--text2)">${s.total} resp.</span></li>`;
    });
    html += '</ul>';
  }
  if(r.envios.length) {
    html += '<h3 style="margin:15px 0 8px">Ultimos Envios</h3><ul class="item-list">';
    r.envios.slice(0,20).forEach(e => {
      const icon = e.resultado === 'enviado' ? '📤' : '❌';
      html += `<li><span>${icon} ${e.grupo}</span><span style="color:var(--text2)">${e.fecha || ''}</span></li>`;
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
</script>
</body>
</html>"""


# ─────────────────────────────────────────
#   SERVIDOR WEB
# ─────────────────────────────────────────

def create_app():
    app = web.Application(client_max_size=10 * 1024 * 1024)  # 10MB max upload
    app.router.add_get("/", serve_panel)

    # API routes
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

    app.router.add_get("/api/campanas", api_campanas)
    app.router.add_post("/api/campana/crear", api_campana_crear)
    app.router.add_post("/api/campana/editar", api_campana_editar)
    app.router.add_post("/api/campana/eliminar", api_campana_eliminar)
    app.router.add_post("/api/campana/config", api_campana_config)

    app.router.add_post("/api/iniciar", api_iniciar)
    app.router.add_post("/api/detener", api_detener)
    app.router.add_post("/api/detener_todas", api_detener_todas)

    app.router.add_get("/api/responder", api_responder)
    app.router.add_post("/api/responder/config", api_responder_config)
    app.router.add_post("/api/responder/toggle", api_responder_toggle)

    app.router.add_get("/api/historial", api_historial)
    app.router.add_post("/api/historial/limpiar", api_historial_limpiar)

    # Servir archivos de media (fotos de campanas)
    os.makedirs("media", exist_ok=True)
    app.router.add_static("/media/", path="media", name="media")

    return app


async def start_web_panel():
    """Inicia el servidor web en background."""
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()
    logger.info(f"Panel web iniciado en http://0.0.0.0:{WEB_PORT}")
