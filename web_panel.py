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

API_ID = int(os.environ.get("API_ID", "35451933"))
API_HASH = os.environ.get("API_HASH", "2070761744260118720b34e6bf20f2eb")
WEB_PORT = int(os.environ.get("TG_API_PORT", 3002))
ADMIN_ID = int(os.environ.get("ADMIN_ID", "8001675901"))

web_login_sessions = {}
aiogram_bot = None

# Cleanup stale login sessions every 10 minutes (BUG-H01 fix)
async def _cleanup_stale_sessions():
    while True:
        await asyncio.sleep(600)  # 10 minutes
        now = datetime.now(PERU_TZ).timestamp()
        stale = [t for t, s in web_login_sessions.items()
                 if now - s.get("created_at", now) > 900]  # 15 min timeout
        for token in stale:
            try:
                await web_login_sessions[token]["client"].disconnect()
            except Exception:
                pass
            del web_login_sessions[token]
        if stale:
            logger.info(f"Limpieza: {len(stale)} sesiones de login abandonadas")


def set_bot_reference(bot_instance):
    global aiogram_bot
    aiogram_bot = bot_instance


def es_admin(user_id):
    return int(user_id) == ADMIN_ID


# Middleware: Only allow requests from localhost (panel proxy) or check valid user_id
@web.middleware
async def auth_middleware(request, handler):
    # Allow requests from localhost (panel_server.js proxy)
    peername = request.transport.get_extra_info('peername')
    remote_ip = peername[0] if peername else None
    forwarded = request.headers.get('x-forwarded-for', '')
    is_local = remote_ip in ('127.0.0.1', '::1', '::ffff:127.0.0.1')
    if not is_local:
        return web.json_response({"ok": False, "error": "Acceso no autorizado"}, status=403)
    return await handler(request)


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
            "created_at": datetime.now(PERU_TZ).timestamp(),
        }
        return web.json_response({"ok": True, "status": "code_sent", "token": token})
    except Exception as e:
        try:
            await client.disconnect()
        except Exception:
            pass
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
        try:
            await client.disconnect()
        except Exception:
            pass
        del web_login_sessions[token]
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
        try:
            await client.disconnect()
        except Exception:
            pass
        del web_login_sessions[token]
        return web.json_response({"ok": False, "error": str(e)})


# ─────────────────────────────────────────
#   AUTH QR: /api/tg-auth/qr-*
# ─────────────────────────────────────────

web_qr_sessions = {}

async def api_tg_auth_qr_start(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    if not user_id or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    if not re.match(r'^[a-zA-Z0-9_]{1,30}$', nombre):
        return web.json_response({"ok": False, "error": "Nombre invalido"})
    sesiones = await db.get_sesiones(user_id)
    if len(sesiones) >= 5:
        return web.json_response({"ok": False, "error": "Limite de 5 cuentas"})
    for s in sesiones:
        if s["nombre"].lower() == nombre.lower():
            return web.json_response({"ok": False, "error": f"Ya tienes cuenta '{nombre}'"})
    token = uuid.uuid4().hex
    path = get_session_path(user_id, nombre)
    try:
        client = TelegramClient(path, API_ID, API_HASH)
        await client.connect()
        if await client.is_user_authorized():
            await db.agregar_sesion(user_id, nombre, "autorizado")
            await client.disconnect()
            return web.json_response({"ok": True, "status": "already_authorized"})
        qr_login = await client.qr_login()
        import qrcode, io, base64
        qr_img = qrcode.make(qr_login.url)
        buf = io.BytesIO()
        qr_img.save(buf, format="PNG")
        qr_b64 = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        web_qr_sessions[token] = {
            "client": client, "qr_login": qr_login, "user_id": user_id,
            "nombre": nombre, "status": "waiting_scan", "qr": qr_b64
        }
        async def wait_for_scan():
            try:
                await qr_login.wait(timeout=120)
                web_qr_sessions[token]["status"] = "connected"
                me = await client.get_me()
                phone = me.phone or "desconocido"
                await db.agregar_sesion(user_id, nombre, phone)
                await client.disconnect()
            except asyncio.TimeoutError:
                web_qr_sessions[token]["status"] = "timeout"
                web_qr_sessions[token]["error"] = "Timeout: no escaneaste a tiempo"
                try: await client.disconnect()
                except: pass
            except Exception as e:
                web_qr_sessions[token]["status"] = "error"
                web_qr_sessions[token]["error"] = str(e)
                try: await client.disconnect()
                except: pass
        asyncio.ensure_future(wait_for_scan())
        return web.json_response({"ok": True, "status": "qr_ready", "token": token, "qr": qr_b64})
    except ImportError:
        return web.json_response({"ok": False, "error": "qrcode no instalado. pip install qrcode[pil]"})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def api_tg_auth_qr_status(request):
    token = request.query.get("token", "")
    if not token or token not in web_qr_sessions:
        return web.json_response({"ok": False, "error": "Token invalido o expirado"})
    session = web_qr_sessions[token]
    result = {"ok": True, "status": session["status"]}
    if session.get("qr"):
        result["qr"] = session["qr"]
    if session.get("error"):
        result["error"] = session["error"]
    if session["status"] in ("connected", "timeout", "error"):
        del web_qr_sessions[token]
    return web.json_response(result)


# ─────────────────────────────────────────
#   SESIONES TG: /api/sesiones_tg*
# ─────────────────────────────────────────

async def api_sesiones_tg(request):
    user_id = int(request.query.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    sesiones = await db.get_sesiones(user_id)
    result = []
    for s in sesiones:
        try:
            fecha = s["fecha_registro"]
        except (KeyError, IndexError):
            fecha = ""
        result.append({
            "nombre": s["nombre"],
            "telefono": s["telefono"],
            "origen": "panel",
            "fecha": fecha or "",
        })
    return web.json_response({"ok": True, "sesiones": result})


async def api_sesiones_tg_eliminar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    nombre = body.get("nombre", "").strip()
    if not user_id or not nombre:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    await db.eliminar_sesion(user_id, nombre)
    path = get_session_path(user_id, nombre)
    for ext in ["", ".session"]:
        try:
            os.remove(path + ext)
        except FileNotFoundError:
            pass
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
        c_dict = dict(c)
        mensajes.append({
            "id": c_dict["id"],
            "nombre": c_dict["nombre"],
            "texto": c_dict.get("mensaje") or "",
            "foto": c_dict.get("foto_path") or None,
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
        c_dict = dict(c)
        config = await db.get_campana_config(c_dict["id"])
        grupos = await db.get_grupos_campana(c_dict["id"])
        sesiones = await db.get_sesiones_campana(c_dict["id"])
        result.append({
            "id": c_dict["id"],
            "nombre": c_dict["nombre"],
            "mensaje": c_dict.get("mensaje") or "",
            "foto": c_dict.get("foto_path") or None,
            "activa": bool(c_dict.get("activa", 0)),
            "enviados": c_dict.get("enviados", 0),
            "errores": c_dict.get("errores", 0),
            "intervalo_min": config["intervalo_min"] if config else 30,
            "intervalo_max": config["intervalo_max"] if config else 60,
            "grupos": len(grupos),
            "sesiones": len(sesiones),
            "camp_sesiones": sesiones,
            "camp_grupos": grupos,
            "en_ejecucion": c_dict["id"] in tareas_activas,
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


async def api_tg_campanas_editar(request):
    try:
        reader = await request.multipart()
        fields = {}
        foto_path = None
        foto_data = None
        foto_filename = None
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "foto" and part.filename:
                foto_filename = part.filename
                chunks = []
                total_size = 0
                max_upload_size = 10 * 1024 * 1024  # 10MB limit
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    total_size += len(chunk)
                    if total_size > max_upload_size:
                        return web.json_response({"ok": False, "error": "Archivo muy grande (max 10MB)"}, status=413)
                    chunks.append(chunk)
                foto_data = b"".join(chunks)
            else:
                data = await part.read(decode=True)
                fields[part.name] = data.decode("utf-8", errors="replace")
        if foto_data and foto_filename:
            fotos_dir = os.path.join(os.path.dirname(__file__), "fotos_campanas")
            os.makedirs(fotos_dir, exist_ok=True)
            foto_path = os.path.join(fotos_dir, f"campana_{fields.get('id', 'tmp')}_{foto_filename}")
            with open(foto_path, "wb") as f:
                f.write(foto_data)
    except Exception:
        body = await request.json()
        fields = body
        foto_path = None

    user_id = int(fields.get("u", 0))
    campana_id = int(fields.get("id", 0))
    if not user_id or not campana_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    campana = await db.get_campana_by_id(campana_id)
    if not campana or int(campana["user_id"]) != user_id:
        return web.json_response({"ok": False, "error": "Sin permiso"}, status=403)

    texto = fields.get("texto", "").strip()
    if texto:
        await db.actualizar_campana_mensaje(campana_id, texto, foto_path)
    elif foto_path:
        await db.actualizar_campana_mensaje(campana_id, dict(campana).get("mensaje", ""), foto_path)

    intervalo_min = fields.get("intervalo_min")
    intervalo_max = fields.get("intervalo_max")
    if intervalo_min is not None or intervalo_max is not None:
        config = await db.get_campana_config(campana_id)
        imin = int(intervalo_min) if intervalo_min else (config["intervalo_min"] if config else 30)
        imax = int(intervalo_max) if intervalo_max else (config["intervalo_max"] if config else 60)
        if imax < imin:
            imax = imin
        await db.set_campana_config(campana_id, imin, imax)

    # Update campaign accounts if provided
    sesiones_raw = fields.get("sesiones")
    if sesiones_raw is not None:
        import json as _json
        sesiones_list = _json.loads(sesiones_raw) if isinstance(sesiones_raw, str) else sesiones_raw
        if isinstance(sesiones_list, list):
            await db.limpiar_sesiones_campana(campana_id)
            for s in sesiones_list:
                await db.agregar_sesion_campana(campana_id, s)

    # Update campaign groups if provided
    grupos_raw = fields.get("grupos")
    if grupos_raw is not None:
        import json as _json
        grupos_list = _json.loads(grupos_raw) if isinstance(grupos_raw, str) else grupos_raw
        if isinstance(grupos_list, list):
            await db.limpiar_grupos_campana(campana_id)
            for g in grupos_list:
                await db.agregar_grupo_campana(campana_id, g)

    return web.json_response({"ok": True})


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

    # Verify membership before allowing campaign launch
    if not es_admin(user_id):
        usuario = await db.get_usuario(user_id)
        if not usuario or not usuario.get("activo"):
            return web.json_response({"ok": False, "error": "Membresia inactiva o expirada. Renueva tu plan."}, status=403)
        fecha_exp = usuario.get("fecha_expira")
        if fecha_exp:
            from datetime import datetime as dt
            try:
                exp = dt.fromisoformat(fecha_exp.replace("Z", "+00:00")) if "Z" in str(fecha_exp) else dt.strptime(str(fecha_exp), "%Y-%m-%d %H:%M:%S")
                if exp < dt.utcnow():
                    return web.json_response({"ok": False, "error": "Membresia expirada. Renueva tu plan."}, status=403)
            except Exception:
                pass

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
    grupos = await db.get_grupos(user_id)
    link_to_name = {}
    for g in grupos:
        link = g["link"]
        name = link.replace("https://t.me/", "").replace("http://t.me/", "").replace("@", "")
        link_to_name[link] = name
    return web.json_response({
        "ok": True,
        "historial": [
            {
                "grupo": link_to_name.get(h["grupo_link"], h["grupo_link"]),
                "grupo_link": h["grupo_link"],
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
    keywords = await db.get_keywords_full(user_id)
    activo = bool(config["activo"]) if config else False
    contacto = config["contacto"] if config else ""
    return web.json_response({
        "ok": True,
        "activo": activo,
        "contacto": contacto,
        "keywords": [{"id": k["id"], "keyword": k["palabra"], "palabra": k["palabra"], "respuesta": k["respuesta"] or ""} for k in keywords]
    })


async def api_tg_autoresponder_toggle(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    activo = body.get("activo", False)
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.toggle_responder(user_id, 1 if activo else 0)
    if activo:
        config = await db.get_responder_config(user_id)
        keywords = await db.get_keywords(user_id)
        contacto = config["contacto"] if config else ""
        loop = asyncio.get_event_loop()
        iniciar_responder(user_id, contacto, keywords, loop, aiogram_bot)
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
    await db.agregar_keywords(user_id, [keyword], respuesta)
    return web.json_response({"ok": True})


async def api_tg_autoresponder_keyword_del(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    kw_id = int(body.get("id", 0))
    if not user_id or not kw_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    await db.eliminar_keyword(kw_id, user_id)
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
    grupos = await db.get_lista_negra_tg(user_id)
    return web.json_response({"ok": True, "grupos": grupos})


async def api_tg_listanegra_add(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    grupo = body.get("grupo", "").strip()
    if not user_id or not grupo:
        return web.json_response({"ok": False, "error": "falta u o grupo"}, status=400)
    await db.agregar_lista_negra_tg(user_id, grupo)
    return web.json_response({"ok": True})


async def api_tg_listanegra_del(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    grupo = body.get("grupo", "").strip()
    if not user_id or not grupo:
        return web.json_response({"ok": False, "error": "falta u o grupo"}, status=400)
    await db.eliminar_lista_negra_tg(user_id, grupo)
    return web.json_response({"ok": True})


async def api_tg_listanegra_limpiar(request):
    body = await request.json()
    user_id = int(body.get("u", 0))
    if not user_id:
        return web.json_response({"ok": False, "error": "falta u"}, status=400)
    await db.limpiar_lista_negra_tg(user_id)
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
    sesiones = await db.get_sesiones(user_id)
    return web.json_response({
        "ok": True,
        "stats": {
            "total_envios": total_env + total_err,
            "exitosos": total_env,
            "fallidos": total_err,
            "grupos": dashboard.get("grupos", 0),
            "cuentas": len(sesiones),
            "campanas": len(campanas),
            "campanas_activas": activas,
        },
        "campanas_total": len(campanas),
        "campanas_activas": activas,
        "enviados_total": total_env,
        "errores_total": total_err,
        "cuentas": len(sesiones),
        "grupos": dashboard.get("grupos", 0),
    })


# ─────────────────────────────────────────
#   SYNC MEMBRESIA TG <-> WSP
# ─────────────────────────────────────────

async def api_tg_sync_membresia(request):
    body = await request.json()
    user_id = body.get("telegram_id") or body.get("user_id")
    dias = int(body.get("dias", 0))
    plan = body.get("plan", "")
    if not user_id:
        return web.json_response({"ok": False, "error": "falta telegram_id"}, status=400)
    try:
        tid = int(user_id)
    except (ValueError, TypeError):
        return web.json_response({"ok": False, "error": "telegram_id invalido"}, status=400)
    user = await db.get_usuario(tid)
    if not user:
        await db.crear_usuario(tid, body.get("username", ""))
    if plan == "desactivado" or (dias == 0 and plan != "permanente"):
        async with db._connect() as conn:
            await conn.execute(
                "UPDATE usuarios SET plan='desactivado', activo=0, fecha_expira=NULL WHERE telegram_id=?",
                (tid,)
            )
            await conn.commit()
    elif plan == "permanente":
        async with db._connect() as conn:
            await conn.execute(
                "UPDATE usuarios SET plan='permanente', activo=1, fecha_expira=NULL WHERE telegram_id=?",
                (tid,)
            )
            await conn.commit()
    elif dias > 0:
        await db.activar_membresia(tid, dias)
    logger.info(f"[sync_membresia] TG updated: tid={tid}, dias={dias}, plan={plan}")
    return web.json_response({"ok": True})


# ─────────────────────────────────────────
#   DETECTAR GRUPOS
# ─────────────────────────────────────────

async def api_tg_detectar(request):
    user_id = int(request.query.get("u", 0))
    cuenta = request.query.get("cuenta", "")
    if not user_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    try:
        grupos, info = await detectar_grupos_telegram(user_id, cuenta if cuenta else None)
        if grupos is None:
            return web.json_response({"ok": False, "error": info})
        return web.json_response({
            "ok": True,
            "cuenta": info,
            "grupos": [{"title": g.get("title", ""), "link": g.get("link", ""), "id": g.get("id", 0), "participants": g.get("participants", 0)} for g in grupos]
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def api_tg_detectar_carpetas(request):
    user_id = int(request.query.get("u", 0))
    cuenta = request.query.get("cuenta", "")
    if not user_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    try:
        carpetas, info = await detectar_carpetas_telegram(user_id, cuenta if cuenta else None)
        if carpetas is None:
            return web.json_response({"ok": False, "error": info})
        return web.json_response({"ok": True, "cuenta": info, "carpetas": carpetas})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


async def api_tg_detectar_carpeta_grupos(request):
    user_id = int(request.query.get("u", 0))
    cuenta = request.query.get("cuenta", "")
    folder_id = int(request.query.get("folder", 0))
    if not user_id or not folder_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    try:
        grupos, info = await detectar_grupos_carpeta(user_id, folder_id, cuenta if cuenta else None)
        if grupos is None:
            return web.json_response({"ok": False, "error": info})
        return web.json_response({
            "ok": True,
            "cuenta": info,
            "grupos": [{"title": g.get("title", ""), "link": g.get("link", ""), "id": g.get("id", 0), "participants": g.get("participants", 0), "tipo": g.get("tipo", "")} for g in grupos]
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ─────────────────────────────────────────
#   RECOVERY: enviar codigo al usuario via bot
# ─────────────────────────────────────────

async def api_tg_send_recovery(request):
    body = await request.json()
    telegram_id = body.get("telegram_id")
    code = body.get("code")
    if not telegram_id or not code:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    if not aiogram_bot:
        return web.json_response({"ok": False, "error": "Bot no disponible"}, status=503)
    try:
        from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
        await aiogram_bot.send_message(
            int(telegram_id),
            f"🔐 <b>Recuperacion de Contrasena</b>\n\n"
            f"Tu codigo de recuperacion es:\n\n"
            f"<code>{code}</code>\n\n"
            f"⏰ Este codigo expira en <b>10 minutos</b>.\n"
            f"No compartas este codigo con nadie.",
            parse_mode="HTML"
        )
        return web.json_response({"ok": True})
    except Exception as e:
        logger.error(f"Error enviando codigo de recuperacion a {telegram_id}: {e}")
        return web.json_response({"ok": False, "error": f"No se pudo enviar el mensaje. Asegurate de haber iniciado el bot (@BotSpamJM_bot) primero."})


# ─────────────────────────────────────────
#   ENVIAR CODIGO DE VERIFICACION VIA BOT
# ─────────────────────────────────────────

async def api_tg_enviar_codigo_verificacion(request):
    body = await request.json()
    telegram_id = body.get("telegram_id", "")
    code = body.get("code", "")
    if not telegram_id or not code:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    if not aiogram_bot:
        return web.json_response({"ok": False, "error": "Bot no disponible"}, status=503)
    try:
        await aiogram_bot.send_message(
            int(telegram_id),
            f"🔐 <b>Codigo de Verificacion</b>\n\n"
            f"Tu codigo es: <code>{code}</code>\n\n"
            f"⏰ Expira en <b>5 minutos</b>\n"
            f"📋 Ingresalo en el panel web para completar tu registro/verificacion.\n\n"
            f"⚠️ No compartas este codigo con nadie.",
            parse_mode="HTML"
        )
        return web.json_response({"ok": True})
    except Exception as e:
        logger.error(f"Error enviando codigo de verificacion a {telegram_id}: {e}")
        return web.json_response({"ok": False, "error": f"No se pudo enviar el codigo. Asegurate de haber iniciado el bot (@BotSpamJM_bot) primero."})


# ─────────────────────────────────────────
#   NOTIFICAR REGISTRO NUEVO AL ADMIN
# ─────────────────────────────────────────

async def api_tg_notificar_registro(request):
    body = await request.json()
    telegram_id = body.get("telegram_id", "")
    username = body.get("username", "")
    if not telegram_id:
        return web.json_response({"ok": False, "error": "Faltan parametros"}, status=400)
    if not aiogram_bot:
        return web.json_response({"ok": False, "error": "Bot no disponible"}, status=503)
    try:
        from datetime import datetime, timezone, timedelta
        peru_tz = timezone(timedelta(hours=-5))
        ahora = datetime.now(peru_tz).strftime("%d/%m/%Y %H:%M")
        await aiogram_bot.send_message(
            ADMIN_ID,
            f"🆕 <b>Nuevo registro en el panel</b>\n\n"
            f"🆔 ID: <code>{telegram_id}</code>\n"
            f"👤 Usuario: {username or '(sin nombre)'}\n"
            f"📅 Fecha: {ahora}\n"
            f"📋 Plan: Demo 1 dia",
            parse_mode="HTML"
        )
        return web.json_response({"ok": True})
    except Exception as e:
        logger.error(f"Error notificando registro al admin: {e}")
        return web.json_response({"ok": False, "error": str(e)})


# ─────────────────────────────────────────
#   SERVIDOR WEB
# ─────────────────────────────────────────

def create_app():
    app = web.Application(client_max_size=10 * 1024 * 1024, middlewares=[auth_middleware])

    # Start background cleanup task for stale login sessions
    async def on_startup(app):
        app['cleanup_task'] = asyncio.create_task(_cleanup_stale_sessions())
    async def on_cleanup(app):
        if 'cleanup_task' in app:
            app['cleanup_task'].cancel()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    # Auth
    app.router.add_post("/api/tg-auth/send-code", api_tg_auth_send_code)
    app.router.add_post("/api/tg-auth/verify-code", api_tg_auth_verify_code)
    app.router.add_post("/api/tg-auth/verify-2fa", api_tg_auth_verify_2fa)
    # Auth QR
    app.router.add_post("/api/tg-auth/qr-start", api_tg_auth_qr_start)
    app.router.add_get("/api/tg-auth/qr-status", api_tg_auth_qr_status)

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
    app.router.add_post("/api/tg/campanas/editar", api_tg_campanas_editar)

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

    # Sync membresia
    app.router.add_post("/api/tg/sync_membresia", api_tg_sync_membresia)

    # Recovery
    app.router.add_post("/api/tg/send_recovery", api_tg_send_recovery)

    # Verificacion de registro
    app.router.add_post("/api/tg/enviar_codigo_verificacion", api_tg_enviar_codigo_verificacion)

    # Notificar registro
    app.router.add_post("/api/tg/notificar_registro", api_tg_notificar_registro)

    # Detectar
    app.router.add_get("/api/tg/detectar", api_tg_detectar)
    app.router.add_get("/api/tg/detectar_carpetas", api_tg_detectar_carpetas)
    app.router.add_get("/api/tg/detectar_carpeta_grupos", api_tg_detectar_carpeta_grupos)

    return app


async def start_web_panel():
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()
    logger.info(f"TG API backend corriendo en puerto {WEB_PORT}")
