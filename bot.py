import asyncio
import os
import re
import logging
from datetime import datetime, timezone, timedelta

# Zona horaria de Peru (UTC-5)
PERU_TZ = timezone(timedelta(hours=-5))
def ahora_peru():
    return datetime.now(PERU_TZ)
from aiogram import Bot, Dispatcher, types, F
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (InlineKeyboardMarkup, InlineKeyboardButton,
                           ReplyKeyboardMarkup, KeyboardButton, ReplyKeyboardRemove)
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

import aiohttp
import db
import wsp_bridge
from motor import (iniciar_campana, detener_campana, tareas_activas, get_session_path,
                   iniciar_responder, detener_responder, responder_activos,
                   detectar_grupos_telegram, detectar_carpetas_telegram,
                   detectar_grupos_carpeta, verificar_grupos_estado)
import web_panel

# ─────────────────────────────────────────
#   CONFIGURACIÓN CENTRAL
# ─────────────────────────────────────────
BOT_TOKEN = "8779002740:AAEGu8ML62y0uFAqpbpSwStm7FJBn3d-KMo"
ADMIN_ID  = 8001675901
API_ID    = 35451933
API_HASH  = "2070761744260118720b34e6bf20f2eb"
YAPE_NUM  = "9776680776"

MAX_CUENTAS_POR_USUARIO = 5
MAX_GRUPOS_POR_USUARIO  = 25

PLANES = {
    "diario":  {"dias": 1,  "precio": "S/ 2.00",  "emoji": "🥉"},
    "semanal": {"dias": 7,  "precio": "S/ 10.00", "emoji": "🥈"},
    "mensual": {"dias": 30, "precio": "S/ 25.00", "emoji": "🥇"},
}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("JDSpamBot")

async def sync_membresia_wsp(telegram_id, dias, plan="", username=""):
    """Sync membership change to WSP database via WSP API."""
    try:
        async with aiohttp.ClientSession() as session:
            await session.post(
                "http://127.0.0.1:3000/api/admin/membresia",
                json={"admin_id": str(ADMIN_ID), "telegram_id": str(telegram_id), "dias": dias, "plan": plan, "username": username},
                headers={"x-internal-service": "telegram-bot"},
                timeout=aiohttp.ClientTimeout(total=5)
            )
    except Exception:
        pass
bot = Bot(token=BOT_TOKEN)
dp  = Dispatcher(storage=MemoryStorage())

# ─────────────────────────────────────────
#   ESTADOS FSM
# ─────────────────────────────────────────
class CuentaState(StatesGroup):
    esperando_codigo   = State()
    esperando_2fa      = State()

class CampanaState(StatesGroup):
    esperando_nombre    = State()
    esperando_contenido = State()
    eligiendo_sesiones  = State()
    eligiendo_grupos    = State()

class GrupoState(StatesGroup):
    esperando_link = State()

class EditarState(StatesGroup):
    eligiendo_campana   = State()
    esperando_contenido = State()

class EditarGrupoState(StatesGroup):
    esperando_nuevo_link = State()

class IntervaloState(StatesGroup):
    esperando_intervalo = State()

class ResponderState(StatesGroup):
    esperando_contacto = State()
    esperando_keywords = State()

class ClonarState(StatesGroup):
    esperando_nombre = State()

class PagoState(StatesGroup):
    esperando_captura = State()
    esperando_nombre_yape = State()
    esperando_codigo_verificacion = State()


class RecuperarState(StatesGroup):
    esperando_nueva_password = State()

class GrupoDetectState(StatesGroup):
    esperando_seleccion_grupos = State()
    esperando_seleccion_grupos_carpeta = State()

# Sesiones Telethon temporales
login_sessions = {}
sesiones_seleccionadas = {}
grupos_seleccionados   = {}

# ─────────────────────────────────────────
#   HELPERS
# ─────────────────────────────────────────
def es_admin(user_id: int) -> bool:
    return user_id == ADMIN_ID

def validar_telefono(telefono: str) -> bool:
    return bool(re.match(r'^\+\d{7,15}$', telefono))

def validar_link_grupo(link: str) -> str | None:
    link = link.strip()
    if link.startswith("t.me/"):
        link = "https://" + link
    if (link.startswith("https://t.me/") or link.startswith("@")
            or link.startswith("http://t.me/")):
        return link
    return None

async def verificar_membresia(msg: types.Message) -> bool:
    if es_admin(msg.from_user.id):
        return True
    activa = await db.tiene_membresia_activa(msg.from_user.id)
    if not activa:
        await msg.answer(
            "⛔ No tienes membresia activa.\n\n"
            "Usa /planes para ver los precios\n"
            "y /pagar para adquirir una."
        )
    return activa

async def verificar_membresia_cb(call: types.CallbackQuery) -> bool:
    if es_admin(call.from_user.id):
        return True
    activa = await db.tiene_membresia_activa(call.from_user.id)
    if not activa:
        await safe_answer(call, "⛔ No tienes membresia activa.", show_alert=True)
    return activa

async def limpiar_sesion_login(user_id: int):
    if user_id in login_sessions:
        try:
            await login_sessions[user_id].disconnect()
        except Exception:
            pass
        del login_sessions[user_id]

async def safe_edit(message: types.Message, text: str, reply_markup=None):
    """Edita un mensaje de forma segura. Si falla, envia uno nuevo."""
    try:
        await message.edit_text(text, reply_markup=reply_markup)
    except Exception:
        await message.answer(text, reply_markup=reply_markup)

async def safe_answer(call: types.CallbackQuery, text: str = None, show_alert: bool = False):
    """Responde un callback query de forma segura. Ignora si ya expiro o falla."""
    try:
        await call.answer(text, show_alert=show_alert)
    except Exception:
        pass

# ─────────────────────────────────────────
#   TECLADOS REUTILIZABLES
# ─────────────────────────────────────────
def kb_volver(callback_data="main_menu"):
    """Boton unico de volver."""
    return [InlineKeyboardButton(text="🔙 Volver al menu", callback_data=callback_data)]

def kb_menu_principal(user_id: int = 0):
    """Teclado reply (inferior) con botones rapidos."""
    botones = [
        [KeyboardButton(text="📋 Mis Campanas"), KeyboardButton(text="👤 Mis Cuentas")],
        [KeyboardButton(text="🌐 Mis Grupos"),   KeyboardButton(text="🚀 Iniciar")],
        [KeyboardButton(text="🤖 Responder"),    KeyboardButton(text="📊 Historial")],
        [KeyboardButton(text="⏰ Membresia"),    KeyboardButton(text="📖 Comandos")],
    ]
    return ReplyKeyboardMarkup(keyboard=botones, resize_keyboard=True)

def kb_inline_menu(user_id: int = 0):
    """Teclado inline del menu principal."""
    kb = [
        [InlineKeyboardButton(text="👤 Cuentas", callback_data="sec_cuentas"),
         InlineKeyboardButton(text="🌐 Grupos", callback_data="sec_grupos")],
        [InlineKeyboardButton(text="📋 Campanas", callback_data="sec_campanas"),
         InlineKeyboardButton(text="🚀 Iniciar", callback_data="sec_iniciar")],
        [InlineKeyboardButton(text="🤖 Responder", callback_data="sec_responder"),
         InlineKeyboardButton(text="⏱ Intervalo", callback_data="sec_intervalo")],
        [InlineKeyboardButton(text="📊 Historial", callback_data="sec_historial"),
         InlineKeyboardButton(text="🛑 Detener", callback_data="sec_detener")],
        [InlineKeyboardButton(text="⏰ Membresia", callback_data="sec_membresia"),
         InlineKeyboardButton(text="💳 Planes", callback_data="sec_planes")],
        [InlineKeyboardButton(text="🗑 Eliminar", callback_data="sec_eliminar"),
         InlineKeyboardButton(text="📖 Comandos", callback_data="sec_cmds")],
        [InlineKeyboardButton(text="📊 Dashboard", callback_data="sec_dashboard")],
    ]
    if es_admin(user_id):
        kb.append([InlineKeyboardButton(text="👑 Admin Panel", callback_data="sec_admin")])
    return InlineKeyboardMarkup(inline_keyboard=kb)

async def build_menu_text(user_id):
    """Construye el texto del menu principal."""
    if es_admin(user_id):
        membresia_msg = "👑 Administrador — Acceso total"
    else:
        activa = await db.tiene_membresia_activa(user_id)
        if activa:
            user = await db.get_usuario(user_id)
            membresia_msg = f"Plan {user['plan'].capitalize()} — Expira: {user['fecha_expira']}"
        else:
            membresia_msg = "Sin membresia activa — /planes"
    return (
        "🛡 BOT DE SPAM J&D 🛡\n"
        "Sistema Pro de Difusion\n\n"
        f"{membresia_msg}\n\n"
        "👇 Selecciona una opcion:"
    )

# ╔══════════════════════════════════════╗
# ║    /registro — CODIGO PARA PANEL    ║
# ╚══════════════════════════════════════╝
@dp.message(Command("registro"))
async def cmd_registro(msg: types.Message):
    """Genera un codigo unico para que el usuario se registre en el panel web."""
    uid = msg.from_user.id
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "http://127.0.0.1:3000/api/registro/generar_codigo",
                json={"telegram_id": str(uid)},
                headers={"x-internal-service": "telegram-bot"}
            ) as resp:
                data = await resp.json()
                if data.get("ok"):
                    code = data["code"]
                    await msg.answer(
                        f"✅ *Tu codigo de registro:*\n\n"
                        f"`{code}`\n\n"
                        f"📋 Copia el codigo y ve al panel web para crear tu cuenta.\n"
                        f"⏰ El codigo expira en *30 minutos*.\n"
                        f"⚠️ Solo puedes tener 1 cuenta por ID de Telegram.\n\n"
                        f"Tu ID: `{uid}`",
                        parse_mode="Markdown"
                    )
                elif data.get("error") == "ya_registrado":
                    await msg.answer(
                        "⚠️ Ya tienes una cuenta registrada en el panel.\n"
                        "Usa tu ID y contraseña para iniciar sesion.\n\n"
                        f"Tu ID: `{uid}`",
                        parse_mode="Markdown"
                    )
                else:
                    await msg.answer(f"❌ Error: {data.get('error', 'desconocido')}")
    except Exception as e:
        logger.error(f"Error generando codigo registro: {e}")
        await msg.answer("❌ Error conectando con el servidor. Intenta en unos minutos.")

@dp.message(Command("miid"))
async def cmd_miid(msg: types.Message):
    """Muestra el ID de Telegram del usuario."""
    await msg.answer(
        f"🆔 *Tu ID de Telegram:*\n\n`{msg.from_user.id}`\n\n"
        f"Usa /registro para obtener tu codigo de registro para el panel web.",
        parse_mode="Markdown"
    )

# ╔══════════════════════════════════════╗
# ║    /start  &  MENU PRINCIPAL        ║
# ╚══════════════════════════════════════╝
@dp.message(Command("start"))
async def cmd_start(msg: types.Message, state: FSMContext):
    uid = msg.from_user.id
    if not await verificar_membresia(msg):
        return
    texto = (
        "🛡 *BOT J&D* 🛡\n\n"
        f"Bienvenido {msg.from_user.first_name}!\n\n"
        "Selecciona la plataforma que quieres controlar:"
    )
    botones = [
        [InlineKeyboardButton(text="📱 Telegram", callback_data="sec_cmdtlg")],
        [InlineKeyboardButton(text="📱 WhatsApp", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer(texto, reply_markup=kb, parse_mode="Markdown")

@dp.callback_query(F.data == "main_menu")
async def cb_main_menu(call: types.CallbackQuery, state: FSMContext):
    await state.clear()
    texto = await build_menu_text(call.from_user.id)
    await safe_edit(call.message, texto, reply_markup=kb_inline_menu(call.from_user.id))
    await safe_answer(call)

# ╔══════════════════════════════════════╗
# ║    SECCION: CUENTAS                 ║
# ╚══════════════════════════════════════╝
async def build_cuentas_view(user_id):
    """Construye texto + teclado de la seccion Cuentas."""
    sesiones = await db.get_sesiones(user_id)
    texto = "👤 GESTION DE CUENTAS\n\n"
    if sesiones:
        for i, s in enumerate(sesiones, 1):
            texto += f"  {i}. {s['nombre']} — {s['telefono']}\n"
        texto += f"\nTotal: {len(sesiones)}/{MAX_CUENTAS_POR_USUARIO} cuenta(s)\n"
    else:
        texto += "  (sin cuentas registradas)\n"
    texto += (
        "\n━━━━━━━━━━━━━━━━━━\n"
        "Para agregar:\n"
        "/cuentas +51999999999 Nombre"
    )
    botones = []
    if sesiones:
        botones.append([InlineKeyboardButton(text="🗑 Eliminar cuenta", callback_data="acc_del")])
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    return texto, kb

@dp.callback_query(F.data == "sec_cuentas")
async def cb_sec_cuentas(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto, kb = await build_cuentas_view(call.from_user.id)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "acc_del")
async def cb_acc_del(call: types.CallbackQuery):
    sesiones = await db.get_sesiones(call.from_user.id)
    if not sesiones:
        await call.answer("No tienes cuentas.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(
            text=f"🗑 {s['nombre']} — {s['telefono']}",
            callback_data=f"accdel_{s['nombre']}"
        )] for s in sesiones
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Cuentas", callback_data="sec_cuentas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "🗑 Selecciona la cuenta a eliminar:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("accdel_"))
async def cb_acc_del_confirm(call: types.CallbackQuery):
    nombre = call.data.replace("accdel_", "")
    try:
        await db.eliminar_sesion(call.from_user.id, nombre)
        path = get_session_path(call.from_user.id, nombre)
        for ext in ["", ".session"]:
            try:
                os.remove(path + ext)
            except FileNotFoundError:
                pass
    except Exception as e:
        logger.error(f"Error al eliminar cuenta {nombre}: {e}")
        await call.answer(f"Error: {e}", show_alert=True)
        return
    # Volver a la vista de cuentas
    texto, kb = await build_cuentas_view(call.from_user.id)
    texto = f"✅ Cuenta '{nombre}' eliminada.\n\n{texto}"
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

# Comando /cuentas (con o sin argumentos)
@dp.message(Command("cuentas"))
async def cmd_cuentas(msg: types.Message, state: FSMContext, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    if command.args:
        partes = command.args.strip().split()
        if len(partes) >= 2 and partes[0].startswith("+"):
            telefono = partes[0]
            nombre   = partes[1]
            if not validar_telefono(telefono):
                return await msg.answer(
                    "❌ Numero invalido.\n\n"
                    "Formato: +XXXXXXXXXXX\n"
                    "Ejemplo: +51987654321"
                )
            if not re.match(r'^[a-zA-Z0-9_áéíóúÁÉÍÓÚñÑ]{1,30}$', nombre):
                return await msg.answer(
                    "❌ Nombre invalido.\n\n"
                    "Solo letras, numeros y guion bajo\n"
                    "Maximo 30 caracteres"
                )
            sesiones_actuales = await db.get_sesiones(msg.from_user.id)
            if len(sesiones_actuales) >= MAX_CUENTAS_POR_USUARIO:
                return await msg.answer(
                    f"⚠ Limite de {MAX_CUENTAS_POR_USUARIO} cuentas alcanzado.\n"
                    f"Elimina una con /eliminar_cuenta"
                )
            for s in sesiones_actuales:
                if s['nombre'].lower() == nombre.lower():
                    return await msg.answer(f"⚠ Ya tienes una cuenta llamada '{nombre}'.")
            await state.clear()
            await procesar_login_cuenta(msg, state, telefono, nombre)
            return
        elif len(partes) == 1 and partes[0].startswith("+"):
            return await msg.answer("⚠ Falta el nombre.\nUso: /cuentas +51999999999 Nombre")
        else:
            return await msg.answer("⚠ Formato incorrecto.\nUso: /cuentas +51999999999 Nombre")
    # Sin argumentos: mostrar vista de cuentas
    texto, kb = await build_cuentas_view(msg.from_user.id)
    await msg.answer(texto, reply_markup=kb)

@dp.message(F.text == "👤 Mis Cuentas")
async def btn_mis_cuentas(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    texto, kb = await build_cuentas_view(msg.from_user.id)
    await msg.answer(texto, reply_markup=kb)

# ─── Login Telethon ───
async def procesar_login_cuenta(msg: types.Message, state: FSMContext, telefono: str, nombre: str):
    await msg.answer(
        f"🔄 Conectando cuenta '{nombre}'\n"
        f"📱 Numero: {telefono}\n\n"
        f"⏳ Espera..."
    )
    logger.info(f"Login: user {msg.from_user.id}, cuenta: {nombre}, tel: {telefono}")
    path = get_session_path(msg.from_user.id, nombre)
    try:
        client = TelegramClient(path, API_ID, API_HASH)
        await client.connect()
        login_sessions[msg.from_user.id] = client
        if await client.is_user_authorized():
            await db.agregar_sesion(msg.from_user.id, nombre, telefono)
            await msg.answer(
                f"✅ Cuenta '{nombre}' registrada!\n"
                f"📱 {telefono}\n"
                f"Ya estaba autorizada.",
                reply_markup=kb_menu_principal(msg.from_user.id)
            )
            await limpiar_sesion_login(msg.from_user.id)
            return
        result = await client.send_code_request(telefono)
        await state.update_data(
            telefono=telefono, nombre=nombre,
            user_id=msg.from_user.id,
            phone_code_hash=result.phone_code_hash
        )
        await state.set_state(CuentaState.esperando_codigo)
        await msg.answer(
            f"📨 Codigo enviado a tu APP de Telegram (no por SMS)\n\n"
            f"📱 Revisa los mensajes en tu Telegram ({telefono})\n"
            f"🔑 Ingresa el codigo que recibiste:\n"
            f"(Ej: 12345)\n\n"
            f"⚠ Tienes 5 minutos.",
            reply_markup=ReplyKeyboardRemove()
        )
    except Exception as e:
        logger.error(f"Error login {nombre}: {e}")
        await limpiar_sesion_login(msg.from_user.id)
        await state.clear()
        error_msg = str(e).lower()
        if "flood" in error_msg:
            await msg.answer("⚠ Demasiados intentos. Espera unos minutos.", reply_markup=kb_menu_principal(msg.from_user.id))
        elif "phone" in error_msg and "invalid" in error_msg:
            await msg.answer("❌ Numero invalido. Verifica el codigo de pais.", reply_markup=kb_menu_principal(msg.from_user.id))
        else:
            await msg.answer(f"❌ Error: {e}", reply_markup=kb_menu_principal(msg.from_user.id))

@dp.message(CuentaState.esperando_codigo)
async def recibir_codigo(msg: types.Message, state: FSMContext):
    codigo = msg.text.strip()
    data   = await state.get_data()
    client = login_sessions.get(msg.from_user.id)
    if not client:
        await state.clear()
        return await msg.answer("❌ Sesion expirada. Intenta de nuevo.", reply_markup=kb_menu_principal(msg.from_user.id))
    try:
        await client.sign_in(data["telefono"], codigo, phone_code_hash=data.get("phone_code_hash"))
        await db.agregar_sesion(msg.from_user.id, data["nombre"], data["telefono"])
        await state.clear()
        await limpiar_sesion_login(msg.from_user.id)
        await msg.answer(
            f"✅ Cuenta '{data['nombre']}' vinculada!\n📱 {data['telefono']}",
            reply_markup=kb_menu_principal(msg.from_user.id)
        )
    except SessionPasswordNeededError:
        await state.set_state(CuentaState.esperando_2fa)
        await msg.answer("🔐 Esta cuenta tiene 2FA.\nIngresa tu contraseña de Telegram:")
    except Exception as e:
        logger.error(f"Error codigo {data.get('nombre')}: {e}")
        await state.clear()
        await limpiar_sesion_login(msg.from_user.id)
        await msg.answer(f"❌ Codigo incorrecto o expirado:\n{e}", reply_markup=kb_menu_principal(msg.from_user.id))

@dp.message(CuentaState.esperando_2fa)
async def recibir_2fa(msg: types.Message, state: FSMContext):
    password = msg.text.strip()
    data     = await state.get_data()
    client   = login_sessions.get(msg.from_user.id)
    if not client:
        await state.clear()
        return await msg.answer("❌ Sesion expirada.", reply_markup=kb_menu_principal(msg.from_user.id))
    try:
        await client.sign_in(password=password)
        await db.agregar_sesion(msg.from_user.id, data["nombre"], data["telefono"])
        await state.clear()
        await limpiar_sesion_login(msg.from_user.id)
        await msg.answer(f"✅ Cuenta '{data['nombre']}' vinculada con 2FA!", reply_markup=kb_menu_principal(msg.from_user.id))
    except Exception as e:
        logger.error(f"Error 2FA {data.get('nombre')}: {e}")
        await state.clear()
        await limpiar_sesion_login(msg.from_user.id)
        await msg.answer(f"❌ Contraseña incorrecta:\n{e}", reply_markup=kb_menu_principal(msg.from_user.id))

@dp.message(Command("eliminar_cuenta"))
async def cmd_eliminar_cuenta(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    sesiones = await db.get_sesiones(msg.from_user.id)
    if not sesiones:
        return await msg.answer("❌ No tienes cuentas.\nAgrega una con /cuentas +51999999999 Nombre")
    botones = [
        [InlineKeyboardButton(text=f"🗑 {s['nombre']} — {s['telefono']}", callback_data=f"accdel_{s['nombre']}")]
        for s in sesiones
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="sec_cuentas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("🗑 Selecciona la cuenta a eliminar:", reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: GRUPOS                  ║
# ╚══════════════════════════════════════╝
async def build_grupos_view(user_id):
    """Construye texto + teclado de la seccion Grupos."""
    grupos = await db.get_grupos(user_id)
    max_g = await db.get_max_grupos(user_id)
    texto = "🌐 GESTION DE GRUPOS\n\n"
    if grupos:
        for i, g in enumerate(grupos, 1):
            texto += f"  {i}. {g['link']}\n"
        texto += f"\nTotal: {len(grupos)}/{max_g} grupo(s)\n"
    else:
        texto += "  (sin grupos registrados)\n"
    texto += (
        "\n━━━━━━━━━━━━━━━━━━\n"
        "Envia links con /grupos para agregar."
    )
    botones = [
        [InlineKeyboardButton(text="🔍 Detectar de Telegram", callback_data="grp_detectar_tg")],
        [InlineKeyboardButton(text="➕ Agregar grupos", callback_data="grp_add")],
    ]
    if grupos:
        botones.append([
            InlineKeyboardButton(text="🗑 Eliminar", callback_data="grp_del"),
            InlineKeyboardButton(text="✏ Editar", callback_data="grp_edit"),
        ])
        botones.append([
            InlineKeyboardButton(text="📤 Exportar .txt", callback_data="grp_export"),
            InlineKeyboardButton(text="🗑 Eliminar todos", callback_data="grp_delall"),
        ])
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    return texto, kb

@dp.callback_query(F.data == "sec_grupos")
async def cb_sec_grupos(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto, kb = await build_grupos_view(call.from_user.id)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "grp_add")
async def cb_grp_add(call: types.CallbackQuery, state: FSMContext):
    await call.message.answer(
        "➕ AGREGAR GRUPOS\n\n"
        "Envia los links (uno por linea):\n\n"
        "Ejemplo:\n"
        "https://t.me/grupo1\n"
        "https://t.me/grupo2\n"
        "@otrogrupo\n\n"
        "📁 Tambien puedes enviar un .txt\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(GrupoState.esperando_link)
    await safe_answer(call)

@dp.callback_query(F.data == "grp_del")
async def cb_grp_del(call: types.CallbackQuery):
    grupos = await db.get_grupos(call.from_user.id)
    if not grupos:
        await call.answer("No tienes grupos.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(
            text=f"🗑 {i}. {g['link'][:35]}",
            callback_data=f"grpdel_{g['id']}"
        )] for i, g in enumerate(grupos, 1)
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Grupos", callback_data="sec_grupos")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "🗑 Selecciona el grupo a eliminar:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("grpdel_"))
async def cb_grp_del_confirm(call: types.CallbackQuery):
    grupo_id = int(call.data.replace("grpdel_", ""))
    try:
        await db.eliminar_grupo(call.from_user.id, grupo_id)
    except Exception as e:
        await call.answer(f"Error: {e}", show_alert=True)
        return
    texto, kb = await build_grupos_view(call.from_user.id)
    texto = f"✅ Grupo eliminado.\n\n{texto}"
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "grp_edit")
async def cb_grp_edit(call: types.CallbackQuery):
    grupos = await db.get_grupos(call.from_user.id)
    if not grupos:
        await call.answer("No tienes grupos.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(
            text=f"✏ {i}. {g['link'][:35]}",
            callback_data=f"grpedit_{g['id']}"
        )] for i, g in enumerate(grupos, 1)
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Grupos", callback_data="sec_grupos")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "✏ Selecciona el grupo a editar:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("grpedit_"))
async def cb_grp_edit_start(call: types.CallbackQuery, state: FSMContext):
    grupo_id = int(call.data.replace("grpedit_", ""))
    await state.update_data(grupo_id_editar=grupo_id)
    await call.message.answer(
        "✏ Envia el nuevo link:\n\n"
        "Ejemplo: https://t.me/nuevogrupo\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(EditarGrupoState.esperando_nuevo_link)
    await safe_answer(call)

@dp.callback_query(F.data == "grp_export")
async def cb_grp_export(call: types.CallbackQuery):
    grupos = await db.get_grupos(call.from_user.id)
    if not grupos:
        await call.answer("No tienes grupos.", show_alert=True)
        return
    contenido = "\n".join(g['link'] for g in grupos)
    filename = f"grupos_{call.from_user.id}.txt"
    filepath = f"/tmp/{filename}"
    with open(filepath, "w") as f:
        f.write(contenido)
    doc = types.input_file.FSInputFile(filepath, filename=filename)
    await call.message.answer_document(doc, caption=f"📤 {len(grupos)} grupos exportados.")
    await safe_answer(call)

@dp.callback_query(F.data == "grp_delall")
async def cb_grp_delall(call: types.CallbackQuery):
    botones = [
        [InlineKeyboardButton(text="⚠ SI, eliminar todos", callback_data="grp_delall_ok")],
        [InlineKeyboardButton(text="❌ No, cancelar", callback_data="sec_grupos")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "⚠ Estas seguro de eliminar TODOS tus grupos?", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "grp_delall_ok")
async def cb_grp_delall_ok(call: types.CallbackQuery):
    await db.eliminar_todos_grupos(call.from_user.id)
    texto, kb = await build_grupos_view(call.from_user.id)
    texto = f"✅ Todos los grupos eliminados.\n\n{texto}"
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

# /grupos command
@dp.message(Command("grupos"))
@dp.message(F.text == "🌐 Mis Grupos")
async def cmd_grupos(msg: types.Message, state: FSMContext):
    if not await verificar_membresia(msg):
        return
    texto, kb = await build_grupos_view(msg.from_user.id)
    await msg.answer(texto, reply_markup=kb)

# FSM: recibir links de grupos
async def procesar_links_grupos(msg: types.Message, state: FSMContext, lineas: list[str]):
    grupos_actuales = await db.get_grupos(msg.from_user.id)
    links_existentes = {g['link'].lower() for g in grupos_actuales}
    total_actual = len(grupos_actuales)
    max_grupos = await db.get_max_grupos(msg.from_user.id)

    agregados = []
    duplicados = []
    invalidos = []
    limite_alcanzado = False

    for linea in lineas:
        link = validar_link_grupo(linea)
        if not link:
            invalidos.append(linea)
            continue
        if total_actual + len(agregados) >= max_grupos:
            limite_alcanzado = True
            break
        if link.lower() in links_existentes:
            duplicados.append(link)
            continue
        await db.agregar_grupo(msg.from_user.id, link)
        links_existentes.add(link.lower())
        agregados.append(link)

    await state.clear()

    resp = ""
    if agregados:
        resp += f"✅ {len(agregados)} grupo(s) agregado(s):\n"
        for i, l in enumerate(agregados, 1):
            resp += f"  {i}. {l}\n"
        resp += "\n"
    if duplicados:
        resp += f"⚠ {len(duplicados)} duplicado(s)\n"
    if invalidos:
        resp += f"❌ {len(invalidos)} link(s) invalido(s)\n"
    if limite_alcanzado:
        resp += f"⚠ Limite de {max_grupos} grupos alcanzado.\n"
    if not agregados and not duplicados and not limite_alcanzado:
        resp = "❌ Link invalido.\nDebe ser: https://t.me/grupo o @grupo"

    if len(resp) > 4000:
        resp = resp[:4000] + "\n... (truncado)"

    # Mostrar vista de grupos actualizada
    texto, kb = await build_grupos_view(msg.from_user.id)
    await msg.answer(f"{resp}\n\n{texto}", reply_markup=kb)

@dp.message(GrupoState.esperando_link, F.document)
async def recibir_archivo_grupos(msg: types.Message, state: FSMContext):
    doc = msg.document
    if not doc.file_name.lower().endswith(".txt"):
        return await msg.answer("❌ Solo archivos .txt")
    if doc.file_size > 1_000_000:
        return await msg.answer("❌ Archivo muy grande. Maximo 1 MB.")
    try:
        file = await bot.get_file(doc.file_id)
        contenido_bytes = await bot.download_file(file.file_path)
        contenido = contenido_bytes.read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.error(f"Error archivo grupos: {e}")
        return await msg.answer("❌ Error al leer el archivo.")
    lineas = [l.strip() for l in contenido.splitlines() if l.strip()]
    if not lineas:
        return await msg.answer("❌ Archivo vacio.")
    await msg.answer(f"📁 Procesando {len(lineas)} linea(s)...")
    await procesar_links_grupos(msg, state, lineas)

@dp.message(GrupoState.esperando_link)
async def recibir_link_grupo(msg: types.Message, state: FSMContext):
    texto_raw = msg.text.strip()
    if texto_raw.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    lineas = [l.strip() for l in texto_raw.replace(" ", "\n").split("\n") if l.strip()]
    await procesar_links_grupos(msg, state, lineas)

@dp.message(EditarGrupoState.esperando_nuevo_link)
async def recibir_nuevo_link_grupo(msg: types.Message, state: FSMContext):
    if msg.text.strip().startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    nuevo_link = validar_link_grupo(msg.text.strip())
    if not nuevo_link:
        return await msg.answer("❌ Link invalido. Debe ser: https://t.me/grupo o @grupo")
    data = await state.get_data()
    grupo_id = data.get("grupo_id_editar")
    if not grupo_id:
        await state.clear()
        return await msg.answer("❌ Error interno.")
    await db.actualizar_grupo_link(msg.from_user.id, grupo_id, nuevo_link)
    await state.clear()
    texto, kb = await build_grupos_view(msg.from_user.id)
    await msg.answer(f"✅ Grupo actualizado a: {nuevo_link}\n\n{texto}", reply_markup=kb)

@dp.message(Command("eliminar_grupo"))
async def cmd_eliminar_grupo(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    grupos = await db.get_grupos(msg.from_user.id)
    if not grupos:
        return await msg.answer("❌ No tienes grupos.\nAgrega con /grupos")
    botones = [
        [InlineKeyboardButton(text=f"🗑 {i}. {g['link'][:35]}", callback_data=f"grpdel_{g['id']}")]
        for i, g in enumerate(grupos, 1)
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="sec_grupos")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("🗑 Selecciona el grupo a eliminar:", reply_markup=kb)

@dp.message(Command("editar_grupo"))
async def cmd_editar_grupo(msg: types.Message, state: FSMContext):
    if not await verificar_membresia(msg):
        return
    grupos = await db.get_grupos(msg.from_user.id)
    if not grupos:
        return await msg.answer("❌ No tienes grupos.\nAgrega con /grupos")
    botones = [
        [InlineKeyboardButton(text=f"✏ {i}. {g['link'][:35]}", callback_data=f"grpedit_{g['id']}")]
        for i, g in enumerate(grupos, 1)
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="sec_grupos")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("✏ Selecciona el grupo a editar:", reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: CAMPAÑAS                ║
# ╚══════════════════════════════════════╝
async def build_campanas_view(user_id):
    """Construye texto + teclado de la seccion Campañas."""
    campanas = await db.get_campanas(user_id)
    texto = "📋 GESTION DE CAMPANAS\n\n"
    if campanas:
        for c in campanas:
            estado = "🟢 Activa" if c["activa"] else "🔴 Detenida"
            texto += (
                f"• {c['nombre']} | {estado}\n"
                f"  ✅ {c['enviados']} enviados | ❌ {c['errores']} errores\n\n"
            )
    else:
        texto += "  (sin campanas creadas)\n"
    botones = [
        [InlineKeyboardButton(text="➕ Nueva Campana", callback_data="camp_nueva")],
    ]
    if campanas:
        botones.append([
            InlineKeyboardButton(text="✏ Editar", callback_data="camp_editar"),
            InlineKeyboardButton(text="🗑 Eliminar", callback_data="camp_eliminar"),
        ])
        botones.append([
            InlineKeyboardButton(text="📊 Ver detalle", callback_data="camp_detalle"),
            InlineKeyboardButton(text="📋 Clonar", callback_data="camp_clonar"),
        ])
        botones.append([
            InlineKeyboardButton(text="🔄 Resetear stats", callback_data="camp_reset"),
        ])
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    return texto, kb

@dp.callback_query(F.data == "sec_campanas")
async def cb_sec_campanas(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto, kb = await build_campanas_view(call.from_user.id)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "camp_nueva")
async def cb_camp_nueva(call: types.CallbackQuery, state: FSMContext):
    await call.message.answer(
        "📋 NUEVA CAMPANA\n\n"
        "Cual sera el nombre?\n"
        "(Ej: Campaña Ropa, Promo Enero)\n\n"
        "Envia /cancelar para cancelar.",
        reply_markup=ReplyKeyboardRemove()
    )
    await state.set_state(CampanaState.esperando_nombre)
    await state.update_data(user_id=call.from_user.id)
    await safe_answer(call)

@dp.message(CampanaState.esperando_nombre)
async def recibir_nombre_campana(msg: types.Message, state: FSMContext):
    if msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    nombre = msg.text.strip()
    if len(nombre) > 50:
        return await msg.answer("⚠ Nombre muy largo. Maximo 50 caracteres.")
    await state.update_data(nombre=nombre)
    await msg.answer(
        f"✅ Nombre: {nombre}\n\n"
        "Ahora envia el contenido:\n\n"
        "• Solo texto: escribe el mensaje\n"
        "• Foto + texto: envia foto con descripcion\n\n"
        "⏳ Tienes 1 minuto."
    )
    await state.set_state(CampanaState.esperando_contenido)

@dp.message(CampanaState.esperando_contenido)
async def recibir_contenido_campana(msg: types.Message, state: FSMContext):
    data      = await state.get_data()
    mensaje   = ""
    foto_path = None

    if msg.photo:
        foto      = msg.photo[-1]
        foto_path = f"media/{data['user_id']}_{foto.file_id}.jpg"
        os.makedirs("media", exist_ok=True)
        await bot.download(foto, destination=foto_path)
        mensaje = msg.caption or ""
    elif msg.text:
        if msg.text.startswith("/"):
            await state.clear()
            return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
        mensaje = msg.text.strip()
    else:
        return await msg.answer("❌ Solo texto o foto con texto.")

    campana_id = await db.crear_campana(data["user_id"], data["nombre"], mensaje, foto_path)
    await state.update_data(campana_id=campana_id)

    sesiones = await db.get_sesiones(data["user_id"])
    if not sesiones:
        await state.clear()
        return await msg.answer(
            "⚠ No tienes cuentas. Agrega con /cuentas primero.",
            reply_markup=kb_menu_principal(msg.from_user.id)
        )

    teclado = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text=f"👤 {s['nombre']}",
            callback_data=f"ses_{campana_id}_{s['nombre']}"
        )] for s in sesiones
    ] + [[InlineKeyboardButton(text="✅ Confirmar cuentas →", callback_data=f"ok_ses_{campana_id}")]])

    await msg.answer(
        "👤 Selecciona las cuentas:\n(Puedes elegir varias, luego confirma)",
        reply_markup=teclado
    )
    await state.set_state(CampanaState.eligiendo_sesiones)

@dp.callback_query(F.data.startswith("ses_"))
async def cb_sel_sesion(call: types.CallbackQuery):
    partes     = call.data.split("_")
    campana_id = int(partes[1])
    nombre_ses = "_".join(partes[2:])

    if campana_id not in sesiones_seleccionadas:
        sesiones_seleccionadas[campana_id] = set()

    if nombre_ses in sesiones_seleccionadas[campana_id]:
        sesiones_seleccionadas[campana_id].remove(nombre_ses)
        await call.answer(f"❌ {nombre_ses} deseleccionada")
    else:
        sesiones_seleccionadas[campana_id].add(nombre_ses)
        await call.answer(f"✅ {nombre_ses} seleccionada")

@dp.callback_query(F.data.startswith("ok_ses_"))
async def cb_ok_sesiones(call: types.CallbackQuery, state: FSMContext):
    campana_id    = int(call.data.split("_")[2])
    seleccionadas = sesiones_seleccionadas.get(campana_id, set())

    if not seleccionadas:
        return await call.answer("⚠ Selecciona al menos una cuenta.", show_alert=True)

    for nombre in seleccionadas:
        await db.agregar_sesion_campana(campana_id, nombre)

    data   = await state.get_data()
    grupos = await db.get_grupos(data["user_id"])

    if not grupos:
        await state.clear()
        return await call.message.answer(
            "⚠ No tienes grupos. Agrega con /grupos primero.",
            reply_markup=kb_menu_principal(call.from_user.id)
        )

    teclado = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text=f"🌐 {g['link'][:35]}",
            callback_data=f"grpsel_{campana_id}_{g['id']}"
        )] for g in grupos
    ] + [[InlineKeyboardButton(text="✅ Confirmar grupos y guardar →", callback_data=f"ok_grp_{campana_id}")]])

    await call.message.answer(
        "🌐 Selecciona los grupos para esta campana:",
        reply_markup=teclado
    )
    await state.set_state(CampanaState.eligiendo_grupos)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("grpsel_"))
async def cb_sel_grupo(call: types.CallbackQuery):
    partes     = call.data.split("_")
    campana_id = int(partes[1])
    grupo_id   = int(partes[2])

    if campana_id not in grupos_seleccionados:
        grupos_seleccionados[campana_id] = set()

    if grupo_id in grupos_seleccionados[campana_id]:
        grupos_seleccionados[campana_id].remove(grupo_id)
        await call.answer("❌ Grupo deseleccionado")
    else:
        grupos_seleccionados[campana_id].add(grupo_id)
        await call.answer("✅ Grupo seleccionado")

@dp.callback_query(F.data.startswith("ok_grp_"))
async def cb_ok_grupos(call: types.CallbackQuery, state: FSMContext):
    campana_id    = int(call.data.split("_")[2])
    data          = await state.get_data()
    user_id       = data.get("user_id", call.from_user.id)
    seleccionados = grupos_seleccionados.get(campana_id, set())

    grupos = await db.get_grupos(user_id)

    if not seleccionados:
        for g in grupos:
            await db.agregar_grupo_campana(campana_id, g["link"])
    else:
        for g in grupos:
            if g["id"] in seleccionados:
                await db.agregar_grupo_campana(campana_id, g["link"])

    campana = await db.get_campana_by_id(campana_id)
    await state.clear()

    sesiones_seleccionadas.pop(campana_id, None)
    grupos_seleccionados.pop(campana_id, None)

    texto, kb = await build_campanas_view(call.from_user.id)
    await call.message.answer(
        f"🎉 Campana '{campana['nombre']}' creada!\n\n"
        f"Usa 🚀 Iniciar para lanzarla.\n\n{texto}",
        reply_markup=kb
    )
    await safe_answer(call)

# Editar campana
@dp.callback_query(F.data == "camp_editar")
@dp.message(Command("campanaeditar"))
async def cb_camp_editar(event, state: FSMContext = None):
    if isinstance(event, types.CallbackQuery):
        uid = event.from_user.id
        message = event.message
        await event.answer()
    else:
        uid = event.from_user.id
        message = event
        if not await verificar_membresia(event):
            return
    campanas = await db.get_campanas(uid)
    if not campanas:
        await message.answer("❌ No tienes campanas para editar.")
        return
    botones = [
        [InlineKeyboardButton(text=f"✏ {c['nombre']}", callback_data=f"campedit_{c['id']}")]
        for c in campanas
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Campanas", callback_data="sec_campanas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    if isinstance(event, types.CallbackQuery):
        await safe_edit(message, "✏ Selecciona la campana a editar:", reply_markup=kb)
    else:
        await message.answer("✏ Selecciona la campana a editar:", reply_markup=kb)

@dp.callback_query(F.data.startswith("campedit_"))
async def cb_camp_edit_start(call: types.CallbackQuery, state: FSMContext):
    campana_id = int(call.data.replace("campedit_", ""))
    await state.update_data(campana_id=campana_id, user_id=call.from_user.id)
    await call.message.answer(
        "📸 Envia el nuevo contenido:\n\n"
        "• Solo texto\n"
        "• Foto con texto como descripcion\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(EditarState.esperando_contenido)
    await safe_answer(call)

@dp.message(EditarState.esperando_contenido)
async def recibir_edicion(msg: types.Message, state: FSMContext):
    data      = await state.get_data()
    mensaje   = ""
    foto_path = None

    if msg.photo:
        foto      = msg.photo[-1]
        foto_path = f"media/{data['user_id']}_{foto.file_id}.jpg"
        os.makedirs("media", exist_ok=True)
        await bot.download(foto, destination=foto_path)
        mensaje = msg.caption or ""
    elif msg.text:
        if msg.text.startswith("/"):
            await state.clear()
            return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
        mensaje = msg.text.strip()
    else:
        return await msg.answer("❌ Solo texto o foto con texto.")

    await db.actualizar_campana_mensaje(data["campana_id"], mensaje, foto_path)
    await state.clear()
    campana = await db.get_campana_by_id(data["campana_id"])
    texto, kb = await build_campanas_view(msg.from_user.id)
    await msg.answer(
        f"✅ Campana '{campana['nombre']}' actualizada.\n\n{texto}",
        reply_markup=kb
    )

# Eliminar campana
@dp.callback_query(F.data == "camp_eliminar")
async def cb_camp_eliminar(call: types.CallbackQuery):
    campanas = await db.get_campanas(call.from_user.id)
    if not campanas:
        await call.answer("No tienes campanas.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(text=f"🗑 {c['nombre']}", callback_data=f"campdel_{c['id']}")]
        for c in campanas
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Campanas", callback_data="sec_campanas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "🗑 Selecciona la campana a eliminar:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("campdel_"))
async def cb_camp_del_confirm(call: types.CallbackQuery):
    campana_id = int(call.data.replace("campdel_", ""))
    campana    = await db.get_campana_by_id(campana_id)
    if campana and campana['activa']:
        detener_campana(campana_id)
    await db.eliminar_campana(campana_id)
    texto, kb = await build_campanas_view(call.from_user.id)
    nombre = campana['nombre'] if campana else '?'
    await safe_edit(call.message, f"✅ Campana '{nombre}' eliminada.\n\n{texto}", reply_markup=kb)
    await safe_answer(call)

# Ver detalle de campana
@dp.callback_query(F.data == "camp_detalle")
async def cb_camp_detalle(call: types.CallbackQuery):
    campanas = await db.get_campanas(call.from_user.id)
    if not campanas:
        await call.answer("No tienes campanas.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(text=f"📊 {c['nombre']}", callback_data=f"campdet_{c['id']}")]
        for c in campanas
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Campanas", callback_data="sec_campanas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "📊 Selecciona campana para ver detalle:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("campdet_"))
async def cb_camp_detalle_ver(call: types.CallbackQuery):
    campana_id = int(call.data.replace("campdet_", ""))
    campana = await db.get_campana_by_id(campana_id)
    if not campana:
        await call.answer("Campana no encontrada.", show_alert=True)
        return
    sesiones = await db.get_sesiones_campana(campana_id)
    grupos = await db.get_grupos_campana(campana_id)
    config = await db.get_campana_config(campana_id)
    estado = "🟢 ACTIVA" if campana['activa'] else "🔴 DETENIDA"
    texto = (
        f"📊 DETALLE: {campana['nombre']}\n\n"
        f"Estado: {estado}\n"
        f"✅ Enviados: {campana['enviados']}\n"
        f"❌ Errores: {campana['errores']}\n"
        f"⏱ Intervalo: {config['intervalo_min']}-{config['intervalo_max']}s\n"
        f"🕐 Inicio: {campana['inicio'] or '—'}\n\n"
        f"👤 Cuentas ({len(sesiones)}):\n"
    )
    for s in sesiones[:10]:
        texto += f"  • {s}\n"
    if len(sesiones) > 10:
        texto += f"  ... y {len(sesiones) - 10} mas\n"
    texto += f"\n🌐 Grupos ({len(grupos)}):\n"
    for g in grupos[:10]:
        texto += f"  • {g[:35]}\n"
    if len(grupos) > 10:
        texto += f"  ... y {len(grupos) - 10} mas\n"
    texto += f"\n📝 Mensaje:\n{campana['mensaje'][:200]}"
    if len(campana['mensaje']) > 200:
        texto += "..."

    botones = [[InlineKeyboardButton(text="🔙 Volver a Campanas", callback_data="sec_campanas")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

# Clonar campana
@dp.callback_query(F.data == "camp_clonar")
async def cb_camp_clonar(call: types.CallbackQuery):
    campanas = await db.get_campanas(call.from_user.id)
    if not campanas:
        await call.answer("No tienes campanas.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(text=f"📋 {c['nombre']}", callback_data=f"campclone_{c['id']}")]
        for c in campanas
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Campanas", callback_data="sec_campanas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "📋 Selecciona la campana a clonar:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("campclone_"))
async def cb_camp_clone_start(call: types.CallbackQuery, state: FSMContext):
    campana_id = int(call.data.replace("campclone_", ""))
    await state.update_data(clonar_id=campana_id, user_id=call.from_user.id)
    await call.message.answer(
        "📋 Escribe el nombre para la campana clonada:\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(ClonarState.esperando_nombre)
    await safe_answer(call)

@dp.message(ClonarState.esperando_nombre)
async def recibir_nombre_clon(msg: types.Message, state: FSMContext):
    if msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    nombre = msg.text.strip()
    if len(nombre) > 50:
        return await msg.answer("⚠ Nombre muy largo. Maximo 50 caracteres.")
    data = await state.get_data()
    nuevo_id = await db.clonar_campana(data['user_id'], data['clonar_id'], nombre)
    await state.clear()
    if nuevo_id:
        texto, kb = await build_campanas_view(msg.from_user.id)
        await msg.answer(f"✅ Campana clonada como '{nombre}'!\n\n{texto}", reply_markup=kb)
    else:
        await msg.answer("❌ Error al clonar.", reply_markup=kb_menu_principal(msg.from_user.id))

# Resetear stats
@dp.callback_query(F.data == "camp_reset")
async def cb_camp_reset(call: types.CallbackQuery):
    campanas = await db.get_campanas(call.from_user.id)
    if not campanas:
        await call.answer("No tienes campanas.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(text=f"🔄 {c['nombre']} ({c['enviados']}✅ {c['errores']}❌)", callback_data=f"campreset_{c['id']}")]
        for c in campanas
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver a Campanas", callback_data="sec_campanas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "🔄 Selecciona campana para resetear stats:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("campreset_"))
async def cb_camp_reset_confirm(call: types.CallbackQuery):
    campana_id = int(call.data.replace("campreset_", ""))
    await db.resetear_stats_campana(campana_id)
    texto, kb = await build_campanas_view(call.from_user.id)
    await safe_edit(call.message, f"✅ Stats reseteados.\n\n{texto}", reply_markup=kb)
    await safe_answer(call)

# Comando /campanas
@dp.message(Command("campanas"))
@dp.message(F.text == "📋 Mis Campanas")
@dp.message(F.text == "📋 Mis Campañas")
async def cmd_campanas(msg: types.Message, state: FSMContext):
    if not await verificar_membresia(msg):
        return
    texto, kb = await build_campanas_view(msg.from_user.id)
    await msg.answer(texto, reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: INICIAR / DETENER       ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_iniciar")
async def cb_sec_iniciar(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    campanas = await db.get_campanas(call.from_user.id)
    inactivas = [c for c in campanas if not c["activa"]]
    if not campanas:
        texto = "🚀 INICIAR CAMPANA\n\nNo tienes campanas. Crea una primero."
        botones = [[InlineKeyboardButton(text="➕ Crear campana", callback_data="camp_nueva")]]
    elif not inactivas:
        texto = "🚀 INICIAR CAMPANA\n\nTodas tus campanas ya estan activas."
        botones = []
    else:
        texto = "🚀 INICIAR CAMPANA\n\nSelecciona cual iniciar:"
        botones = [
            [InlineKeyboardButton(text=f"🚀 {c['nombre']}", callback_data=f"start_{c['id']}")]
            for c in inactivas
        ]
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("start_"))
async def cb_iniciar(call: types.CallbackQuery):
    campana_id = int(call.data.split("_")[1])

    # Auto-asignar grupos si la campaña no tiene
    grupos_campana = await db.get_grupos_campana(campana_id)
    if not grupos_campana:
        grupos_user = await db.get_grupos(call.from_user.id)
        if not grupos_user:
            await call.answer("⚠ Sin grupos. Agrega con /grupos", show_alert=True)
            return
        for g in grupos_user:
            await db.agregar_grupo_campana(campana_id, g["link"])

    # Auto-asignar cuentas si la campaña no tiene
    sesiones_campana = await db.get_sesiones_campana(campana_id)
    if not sesiones_campana:
        sesiones_user = await db.get_sesiones(call.from_user.id)
        if not sesiones_user:
            await call.answer("⚠ Sin cuentas. Agrega con /cuentas", show_alert=True)
            return
        for s in sesiones_user:
            await db.agregar_sesion_campana(campana_id, s["nombre"])

    loop       = asyncio.get_event_loop()
    resultado  = iniciar_campana(campana_id, call.from_user.id, loop, bot)
    campana    = await db.get_campana_by_id(campana_id)
    if resultado:
        texto = f"🟢 Campana '{campana['nombre']}' INICIADA!\n\nEl motor esta enviando. 🚀"
    else:
        texto = "⚠ Esta campana ya esta en ejecucion."
    botones = [kb_volver()]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "sec_detener")
async def cb_sec_detener(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    campanas = await db.get_campanas(call.from_user.id)
    activas  = [c for c in campanas if c["activa"]]
    resp_activo = call.from_user.id in responder_activos

    if not activas and not resp_activo:
        texto = "🛑 DETENER\n\nNo hay nada activo para detener."
        botones = []
    else:
        texto = "🛑 DETENER\n\nSelecciona que detener:"
        botones = [
            [InlineKeyboardButton(text=f"🛑 {c['nombre']}", callback_data=f"stop_{c['id']}")]
            for c in activas
        ]
        if resp_activo:
            botones.append([InlineKeyboardButton(text="🛑 Auto-responder", callback_data="stop_resp")])
        if len(activas) > 1:
            botones.append([InlineKeyboardButton(text="⛔ Detener TODAS", callback_data="stop_all")])
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("stop_"))
async def cb_detener(call: types.CallbackQuery):
    valor = call.data.replace("stop_", "")
    if valor == "resp":
        detener_responder(call.from_user.id)
        await db.toggle_responder(call.from_user.id, 0)
        texto = "🔴 Auto-responder detenido."
    elif valor == "all":
        campanas = await db.get_campanas(call.from_user.id)
        detenidas = 0
        for c in campanas:
            if c['activa']:
                detener_campana(c['id'])
                await db.set_campana_activa(c['id'], False)
                detenidas += 1
        detener_responder(call.from_user.id)
        await db.toggle_responder(call.from_user.id, 0)
        texto = f"🔴 {detenidas} campana(s) + auto-responder detenidos."
    else:
        campana_id = int(valor)
        resultado  = detener_campana(campana_id)
        campana    = await db.get_campana_by_id(campana_id)
        nombre = campana['nombre'] if campana else '?'
        # Siempre marcar como inactiva en la DB (por si el bot reinició y la tarea se perdió)
        await db.set_campana_activa(campana_id, False)
        if resultado:
            texto = f"🔴 Campana '{nombre}' detenida."
        else:
            texto = f"🔴 Campana '{nombre}' marcada como detenida."
    botones = [kb_volver()]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

# Comandos directos /iniciar y /detener
@dp.message(Command("iniciar"))
@dp.message(F.text == "🚀 Iniciar")
async def cmd_iniciar(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    campanas = await db.get_campanas(msg.from_user.id)
    inactivas = [c for c in campanas if not c["activa"]]
    if not inactivas:
        return await msg.answer("❌ No hay campanas detenidas.\nCrea una con /campanas")
    botones = [
        [InlineKeyboardButton(text=f"🚀 {c['nombre']}", callback_data=f"start_{c['id']}")]
        for c in inactivas
    ]
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("🚀 Selecciona campana a iniciar:", reply_markup=kb)

@dp.message(Command("detener"))
async def cmd_detener(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    campanas = await db.get_campanas(msg.from_user.id)
    activas  = [c for c in campanas if c["activa"]]
    if not activas:
        return await msg.answer("❌ No hay campanas activas.")
    botones = [
        [InlineKeyboardButton(text=f"🛑 {c['nombre']}", callback_data=f"stop_{c['id']}")]
        for c in activas
    ]
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("🛑 Selecciona campana a detener:", reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: INTERVALO               ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_intervalo")
async def cb_sec_intervalo(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    campanas = await db.get_campanas(call.from_user.id)
    if not campanas:
        texto = "⏱ INTERVALO\n\nNo tienes campanas. Crea una primero."
        botones = []
    else:
        texto = "⏱ INTERVALO DE ENVIO\n\n"
        for c in campanas:
            config = await db.get_campana_config(c['id'])
            texto += f"  • {c['nombre']}: {config['intervalo_min']}-{config['intervalo_max']}s\n"
        texto += (
            "\n━━━━━━━━━━━━━━━━━━\n"
            "Selecciona campana para cambiar:\n\n"
            "Recomendado:\n"
            "  1 cuenta: 30-60s\n"
            "  2 cuentas: 15-30s\n"
            "  3+ cuentas: 10-20s"
        )
        botones = [
            [InlineKeyboardButton(text=f"⏱ {c['nombre']}", callback_data=f"intv_{c['id']}")]
            for c in campanas
        ]
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("intv_"))
async def cb_intervalo_campana(call: types.CallbackQuery, state: FSMContext):
    campana_id = int(call.data.split("_")[1])
    config = await db.get_campana_config(campana_id)
    await state.update_data(campana_id=campana_id)
    await call.message.answer(
        f"⏱ Actual: {config['intervalo_min']}-{config['intervalo_max']}s\n\n"
        f"Envia nuevo intervalo:\nminimo maximo\n\n"
        f"Ej: 10 30\n\n"
        f"Envia /cancelar para cancelar."
    )
    await state.set_state(IntervaloState.esperando_intervalo)
    await safe_answer(call)

@dp.message(IntervaloState.esperando_intervalo)
async def recibir_intervalo(msg: types.Message, state: FSMContext):
    if msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    partes = msg.text.strip().split()
    if len(partes) != 2:
        return await msg.answer("❌ Formato: minimo maximo\nEj: 10 30")
    try:
        min_val = int(partes[0])
        max_val = int(partes[1])
    except ValueError:
        return await msg.answer("❌ Deben ser numeros.\nEj: 10 30")
    if min_val < 3:
        return await msg.answer("❌ Minimo 3 segundos.")
    if max_val < min_val:
        max_val = min_val
    if max_val > 3600:
        return await msg.answer("❌ Maximo 3600 segundos.")
    data = await state.get_data()
    await db.set_campana_config(data["campana_id"], min_val, max_val)
    await state.clear()
    await msg.answer(
        f"✅ Intervalo actualizado: {min_val}-{max_val}s\n\n"
        f"Los cambios se aplican en el proximo envio.",
        reply_markup=kb_menu_principal(msg.from_user.id)
    )

@dp.message(Command("intervalo"))
async def cmd_intervalo(msg: types.Message, state: FSMContext):
    if not await verificar_membresia(msg):
        return
    campanas = await db.get_campanas(msg.from_user.id)
    if not campanas:
        return await msg.answer("❌ No tienes campanas.\nCrea una con /campanas")
    botones = [
        [InlineKeyboardButton(text=f"⏱ {c['nombre']}", callback_data=f"intv_{c['id']}")]
        for c in campanas
    ]
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("⏱ Selecciona campana para configurar intervalo:", reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: RESPONDER               ║
# ╚══════════════════════════════════════╝
async def build_responder_view(user_id):
    """Construye vista del auto-responder."""
    config = await db.get_responder_config(user_id)
    keywords = await db.get_keywords(user_id)
    activo_en_motor = user_id in responder_activos

    if config and config["activo"]:
        texto = (
            "🤖 AUTO-RESPONDER\n\n"
            f"Estado: {'🟢 ACTIVO' if activo_en_motor else '🔴 Configurado pero parado'}\n"
            f"📱 Contacto: {config['contacto']}\n"
            f"📝 Keywords: {len(keywords)}\n\n"
            "Cuando alguien en un grupo escriba una\n"
            "keyword, tu cuenta responde automatico."
        )
        botones = [
            [InlineKeyboardButton(text="🔴 Desactivar", callback_data="resp_off"),
             InlineKeyboardButton(text="🟢 Reactivar", callback_data="resp_on")],
            [InlineKeyboardButton(text="✏ Cambiar contacto", callback_data="resp_contacto"),
             InlineKeyboardButton(text="📝 Cambiar keywords", callback_data="resp_keywords")],
            [InlineKeyboardButton(text="📋 Ver keywords", callback_data="resp_ver")],
        ]
    else:
        texto = (
            "🤖 AUTO-RESPONDER\n\n"
            "Estado: 🔴 INACTIVO\n\n"
            "Este modo responde automaticamente\n"
            "cuando alguien en un grupo escribe\n"
            "palabras clave (disney, netflix, etc)."
        )
        botones = [
            [InlineKeyboardButton(text="🟢 Configurar y activar", callback_data="resp_contacto")],
        ]
    botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    return texto, kb

@dp.callback_query(F.data == "sec_responder")
async def cb_sec_responder(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto, kb = await build_responder_view(call.from_user.id)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "resp_off")
async def cb_resp_off(call: types.CallbackQuery):
    detener_responder(call.from_user.id)
    await db.toggle_responder(call.from_user.id, 0)
    texto, kb = await build_responder_view(call.from_user.id)
    await safe_edit(call.message, f"🔴 Desactivado.\n\n{texto}", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "resp_on")
async def cb_resp_on(call: types.CallbackQuery):
    config = await db.get_responder_config(call.from_user.id)
    keywords = await db.get_keywords(call.from_user.id)
    if not config or not config['contacto']:
        await call.answer("⚠ Configura el contacto primero.", show_alert=True)
        return
    if not keywords:
        await call.answer("⚠ Agrega keywords primero.", show_alert=True)
        return
    detener_responder(call.from_user.id)
    await db.toggle_responder(call.from_user.id, 1)
    loop = asyncio.get_event_loop()
    iniciar_responder(call.from_user.id, config['contacto'], keywords, loop, bot)
    texto, kb = await build_responder_view(call.from_user.id)
    await safe_edit(call.message, f"🟢 Reactivado!\n\n{texto}", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "resp_contacto")
async def cb_resp_contacto(call: types.CallbackQuery, state: FSMContext):
    await call.message.answer(
        "📱 Envia el @contacto:\n\n"
        "Ejemplo: @MiNegocio o @JuanVentas\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(ResponderState.esperando_contacto)
    await safe_answer(call)

@dp.message(ResponderState.esperando_contacto)
async def recibir_contacto_responder(msg: types.Message, state: FSMContext):
    if msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    contacto = msg.text.strip()
    if not contacto.startswith("@"):
        contacto = "@" + contacto
    await state.update_data(contacto=contacto)
    await msg.answer(
        f"✅ Contacto: {contacto}\n\n"
        f"Ahora envia las PALABRAS CLAVE\n"
        f"(una por linea o archivo .txt):\n\n"
        f"Ejemplo:\n"
        f"disney\nnetflix\niptv\ncuentas\nstreaming"
    )
    await state.set_state(ResponderState.esperando_keywords)

@dp.message(ResponderState.esperando_keywords, F.document)
async def recibir_keywords_archivo(msg: types.Message, state: FSMContext):
    doc = msg.document
    if not doc.file_name.lower().endswith(".txt"):
        return await msg.answer("❌ Solo archivos .txt")
    try:
        file = await bot.get_file(doc.file_id)
        contenido_bytes = await bot.download_file(file.file_path)
        contenido = contenido_bytes.read().decode("utf-8", errors="ignore")
    except Exception:
        return await msg.answer("❌ Error al leer el archivo.")
    palabras = [p.strip() for p in contenido.splitlines() if p.strip()]
    if not palabras:
        return await msg.answer("❌ Archivo vacio.")
    await activar_responder_final(msg, state, palabras)

@dp.message(ResponderState.esperando_keywords)
async def recibir_keywords_texto(msg: types.Message, state: FSMContext):
    if msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    palabras = [p.strip() for p in msg.text.split("\n") if p.strip()]
    if not palabras:
        return await msg.answer("❌ Envia al menos una palabra.")
    await activar_responder_final(msg, state, palabras)

async def activar_responder_final(msg: types.Message, state: FSMContext, palabras):
    data = await state.get_data()
    contacto = data.get("contacto", "")
    await db.limpiar_keywords(msg.from_user.id)
    await db.agregar_keywords(msg.from_user.id, palabras)
    await db.set_responder_config(msg.from_user.id, contacto, 1)
    detener_responder(msg.from_user.id)
    loop = asyncio.get_event_loop()
    iniciar_responder(msg.from_user.id, contacto, palabras, loop, bot)
    await state.clear()
    texto, kb = await build_responder_view(msg.from_user.id)
    await msg.answer(
        f"🟢 Auto-responder ACTIVADO\n"
        f"📱 Contacto: {contacto}\n"
        f"📝 Keywords: {len(palabras)}\n\n{texto}",
        reply_markup=kb
    )

@dp.callback_query(F.data == "resp_keywords")
async def cb_resp_keywords(call: types.CallbackQuery, state: FSMContext):
    config = await db.get_responder_config(call.from_user.id)
    if config:
        await state.update_data(contacto=config["contacto"])
    await call.message.answer(
        "📝 Envia las nuevas PALABRAS CLAVE\n"
        "(una por linea o archivo .txt).\n\n"
        "Las anteriores seran reemplazadas.\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(ResponderState.esperando_keywords)
    await safe_answer(call)

@dp.callback_query(F.data == "resp_ver")
async def cb_resp_ver(call: types.CallbackQuery):
    keywords = await db.get_keywords(call.from_user.id)
    if not keywords:
        texto = "❌ No tienes keywords configuradas."
    else:
        texto = "📝 TUS KEYWORDS:\n\n"
        for i, kw in enumerate(keywords[:50], 1):
            texto += f"  {i}. {kw}\n"
        if len(keywords) > 50:
            texto += f"\n... y {len(keywords) - 50} mas"
    botones = [[InlineKeyboardButton(text="🔙 Volver a Responder", callback_data="sec_responder")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.message(Command("responder"))
@dp.message(F.text == "🤖 Responder")
async def cmd_responder(msg: types.Message, state: FSMContext):
    if not await verificar_membresia(msg):
        return
    texto, kb = await build_responder_view(msg.from_user.id)
    await msg.answer(texto, reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: HISTORIAL               ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_historial")
async def cb_sec_historial(call: types.CallbackQuery):
    texto = "📊 HISTORIAL\n\nSelecciona que ver:"
    botones = [
        [InlineKeyboardButton(text="📤 Envios por grupo", callback_data="hist_envios")],
        [InlineKeyboardButton(text="💬 Respuestas por keyword", callback_data="hist_resp_kw")],
        [InlineKeyboardButton(text="🌐 Respuestas por grupo", callback_data="hist_resp_gr")],
        [InlineKeyboardButton(text="📋 Ultimos 20 envios", callback_data="hist_ultimos")],
        [InlineKeyboardButton(text="🧹 Limpiar historial", callback_data="hist_limpiar")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "hist_envios")
async def cb_hist_envios(call: types.CallbackQuery):
    stats = await db.get_stats_por_grupo(call.from_user.id)
    if not stats:
        texto = "📭 No hay historial de envios."
    else:
        texto = "📤 ENVIOS POR GRUPO:\n\n"
        for i, s in enumerate(stats[:20], 1):
            grupo = s['grupo_link']
            if len(grupo) > 25:
                grupo = grupo[:25] + "..."
            texto += f"{i}. {grupo}\n   ✅{s['enviados']} ❌{s['errores']} | {s['ultimo_envio']}\n\n"
        if len(stats) > 20:
            texto += f"... y {len(stats) - 20} mas"
    botones = [[InlineKeyboardButton(text="🔙 Volver a Historial", callback_data="sec_historial")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "hist_resp_kw")
async def cb_hist_resp_kw(call: types.CallbackQuery):
    stats = await db.get_stats_respuestas(call.from_user.id)
    if not stats:
        texto = "📭 No hay respuestas registradas."
    else:
        texto = "💬 RESPUESTAS POR KEYWORD:\n\n"
        for i, s in enumerate(stats[:20], 1):
            texto += f"{i}. \"{s['keyword']}\" — {s['total']} resp.\n"
        if len(stats) > 20:
            texto += f"\n... y {len(stats) - 20} mas"
    botones = [[InlineKeyboardButton(text="🔙 Volver a Historial", callback_data="sec_historial")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "hist_resp_gr")
async def cb_hist_resp_gr(call: types.CallbackQuery):
    stats = await db.get_stats_respuestas_por_grupo(call.from_user.id)
    if not stats:
        texto = "📭 No hay respuestas registradas."
    else:
        texto = "🌐 RESPUESTAS POR GRUPO:\n\n"
        for i, s in enumerate(stats[:20], 1):
            grupo = s['grupo_link']
            if len(grupo) > 25:
                grupo = grupo[:25] + "..."
            texto += f"{i}. {grupo} — {s['total']} resp.\n"
        if len(stats) > 20:
            texto += f"\n... y {len(stats) - 20} mas"
    botones = [[InlineKeyboardButton(text="🔙 Volver a Historial", callback_data="sec_historial")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "hist_ultimos")
async def cb_hist_ultimos(call: types.CallbackQuery):
    hist = await db.get_historial_envios(call.from_user.id, 20)
    if not hist:
        texto = "📭 No hay envios registrados."
    else:
        texto = "📋 ULTIMOS 20 ENVIOS:\n\n"
        for i, h in enumerate(hist, 1):
            grupo = h['grupo_link']
            if len(grupo) > 25:
                grupo = grupo[:25] + "..."
            icono = "📤" if h['resultado'] == "enviado" else "❌"
            texto += f"{i}. {icono} {grupo} — {h['resultado']}\n"
    botones = [[InlineKeyboardButton(text="🔙 Volver a Historial", callback_data="sec_historial")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "hist_limpiar")
async def cb_hist_limpiar(call: types.CallbackQuery):
    botones = [
        [InlineKeyboardButton(text="⚠ SI, limpiar todo", callback_data="hist_limpiar_ok")],
        [InlineKeyboardButton(text="❌ No, cancelar", callback_data="sec_historial")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "⚠ Eliminar TODO el historial?", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "hist_limpiar_ok")
async def cb_hist_limpiar_ok(call: types.CallbackQuery):
    await db.limpiar_historial(call.from_user.id)
    texto = "✅ Historial limpiado.\n\n📊 HISTORIAL\n\nSelecciona que ver:"
    botones = [
        [InlineKeyboardButton(text="📤 Envios por grupo", callback_data="hist_envios")],
        [InlineKeyboardButton(text="💬 Respuestas por keyword", callback_data="hist_resp_kw")],
        [InlineKeyboardButton(text="🌐 Respuestas por grupo", callback_data="hist_resp_gr")],
        [InlineKeyboardButton(text="📋 Ultimos 20 envios", callback_data="hist_ultimos")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.message(Command("historial"))
@dp.message(F.text == "📊 Historial")
async def cmd_historial(msg: types.Message):
    botones = [
        [InlineKeyboardButton(text="📤 Envios por grupo", callback_data="hist_envios")],
        [InlineKeyboardButton(text="💬 Respuestas por keyword", callback_data="hist_resp_kw")],
        [InlineKeyboardButton(text="🌐 Respuestas por grupo", callback_data="hist_resp_gr")],
        [InlineKeyboardButton(text="📋 Ultimos 20 envios", callback_data="hist_ultimos")],
        [InlineKeyboardButton(text="🧹 Limpiar historial", callback_data="hist_limpiar")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("📊 HISTORIAL\n\nSelecciona que ver:", reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: MEMBRESIA / PLANES      ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_membresia")
async def cb_sec_membresia(call: types.CallbackQuery):
    uid = call.from_user.id
    if es_admin(uid):
        texto = "👑 MEMBRESIA\n\nEres admin. Acceso ilimitado."
    else:
        user = await db.get_usuario(uid)
        if user and user.get('activo'):
            expira   = user["fecha_expira"]
            plan     = user["plan"].capitalize()
            restante = "—"
            if expira:
                try:
                    exp_dt = datetime.strptime(expira, "%Y-%m-%d %H:%M:%S")
                    diff   = exp_dt - ahora_peru().replace(tzinfo=None)
                    if diff.total_seconds() > 0:
                        dias  = diff.days
                        horas = diff.seconds // 3600
                        restante = f"{dias}d {horas}h"
                    else:
                        restante = "⚠ EXPIRADA"
                except ValueError:
                    pass
            texto = (
                f"⏰ TU MEMBRESIA\n\n"
                f"📦 Plan: {plan}\n"
                f"📅 Expira: {expira}\n"
                f"⏳ Resta: {restante}\n\n"
                f"Para renovar: /planes"
            )
        else:
            texto = "⛔ No tienes membresia activa.\n\nUsa /planes para adquirir una."
    botones = [
        [InlineKeyboardButton(text="💳 Ver planes", callback_data="sec_planes")],
        [InlineKeyboardButton(text="💰 Pagar", callback_data="sec_pagar")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "sec_planes")
async def cb_sec_planes(call: types.CallbackQuery):
    texto = (
        "💳 PLANES J&D SPAM\n\n"
        "🥉 Plan Diario\n"
        "   Duracion: 1 dia\n"
        "   Precio: S/ 2.00\n\n"
        "🥈 Plan Semanal\n"
        "   Duracion: 7 dias\n"
        "   Precio: S/ 10.00\n\n"
        "🥇 Plan Mensual\n"
        "   Duracion: 30 dias\n"
        "   Precio: S/ 25.00\n\n"
        "━━━━━━━━━━━━━━━━━━\n"
        "💰 Pago por YAPE:\n"
        f"   📱 {YAPE_NUM}"
    )
    botones = [
        [InlineKeyboardButton(text="🥉 Diario S/2", callback_data="pagar_diario"),
         InlineKeyboardButton(text="🥈 Semanal S/10", callback_data="pagar_semanal")],
        [InlineKeyboardButton(text="🥇 Mensual S/25", callback_data="pagar_mensual")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "sec_pagar")
async def cb_sec_pagar(call: types.CallbackQuery):
    botones = [
        [InlineKeyboardButton(text="🥉 Diario S/2", callback_data="pagar_diario")],
        [InlineKeyboardButton(text="🥈 Semanal S/10", callback_data="pagar_semanal")],
        [InlineKeyboardButton(text="🥇 Mensual S/25", callback_data="pagar_mensual")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "💳 Que plan deseas pagar?", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("pagar_"))
async def cb_pagar(call: types.CallbackQuery, state: FSMContext):
    plan = call.data.replace("pagar_", "")
    if plan not in PLANES:
        return await call.answer("❌ Plan no valido.", show_alert=True)
    info = PLANES[plan]
    await state.update_data(
        pago_plan=plan,
        pago_dias=info['dias'],
        pago_precio=info['precio'],
        pago_emoji=info['emoji'],
        pago_user_id=call.from_user.id,
        pago_username=call.from_user.username or "",
        pago_nombre=call.from_user.first_name or "",
    )
    texto = (
        f"💳 PROCESO DE PAGO\n\n"
        f"Plan: {info['emoji']} {plan.capitalize()} — {info['precio']}\n\n"
        f"📱 Envia tu pago por YAPE a:\n"
        f"   {YAPE_NUM}\n\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"📸 PASO 1/3:\n"
        f"Envia la CAPTURA de pantalla del pago.\n\n"
        f"Envia /cancelar para cancelar."
    )
    await call.message.answer(texto, reply_markup=ReplyKeyboardRemove())
    await state.set_state(PagoState.esperando_captura)
    await safe_answer(call)

@dp.message(PagoState.esperando_captura)
async def recibir_captura_pago(msg: types.Message, state: FSMContext):
    if msg.text and msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Pago cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    if not msg.photo:
        return await msg.answer("❌ Debes enviar una FOTO (captura del pago).")
    foto = msg.photo[-1]
    await state.update_data(pago_foto_id=foto.file_id)
    await msg.answer(
        "✅ Captura recibida!\n\n"
        "📝 PASO 2/3:\n"
        "Escribe el NOMBRE del Yape\n"
        "desde donde hiciste el pago.\n\n"
        "Ejemplo: Juan Perez\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(PagoState.esperando_nombre_yape)

@dp.message(PagoState.esperando_nombre_yape)
async def recibir_nombre_yape(msg: types.Message, state: FSMContext):
    if msg.text and msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Pago cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    if not msg.text or len(msg.text.strip()) < 2:
        return await msg.answer("❌ Escribe el nombre del Yape (minimo 2 caracteres).")
    nombre_yape = msg.text.strip()
    await state.update_data(pago_nombre_yape=nombre_yape)
    await msg.answer(
        f"✅ Nombre: {nombre_yape}\n\n"
        f"🔢 PASO 3/3:\n"
        f"Escribe el CODIGO DE VERIFICACION\n"
        f"que aparece en el comprobante de Yape.\n\n"
        f"Envia /cancelar para cancelar."
    )
    await state.set_state(PagoState.esperando_codigo_verificacion)

@dp.message(PagoState.esperando_codigo_verificacion)
async def recibir_codigo_verificacion(msg: types.Message, state: FSMContext):
    if msg.text and msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Pago cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    if not msg.text or len(msg.text.strip()) < 2:
        return await msg.answer("❌ Escribe el codigo de verificacion.")
    codigo = msg.text.strip()
    data = await state.get_data()
    await state.clear()

    plan = data.get('pago_plan', '?')
    dias = data.get('pago_dias', 0)
    precio = data.get('pago_precio', '?')
    emoji = data.get('pago_emoji', '')
    user_id = data.get('pago_user_id', msg.from_user.id)
    username = data.get('pago_username', '')
    nombre_user = data.get('pago_nombre', '')
    foto_id = data.get('pago_foto_id')
    nombre_yape = data.get('pago_nombre_yape', '')

    # Confirmar al usuario
    await msg.answer(
        f"✅ PAGO ENVIADO PARA VERIFICACION\n\n"
        f"📦 Plan: {emoji} {plan.capitalize()} — {precio}\n"
        f"👤 Yape de: {nombre_yape}\n"
        f"🔢 Codigo: {codigo}\n\n"
        f"⏳ El administrador revisara tu pago\n"
        f"y activara tu membresia.\n"
        f"Te notificaremos cuando este listo!",
        reply_markup=kb_menu_principal(msg.from_user.id)
    )

    # Enviar al admin con boton de activar
    try:
        admin_texto = (
            f"💰 SOLICITUD DE PAGO\n\n"
            f"👤 Usuario: {nombre_user} (@{username})\n"
            f"🆔 ID: {user_id}\n\n"
            f"📦 Plan: {emoji} {plan.capitalize()} — {precio}\n"
            f"📱 Nombre Yape: {nombre_yape}\n"
            f"🔢 Codigo verificacion: {codigo}\n\n"
            f"📸 Captura adjunta arriba ⬆"
        )
        admin_kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(
                text=f"✅ Activar {plan.capitalize()} ({dias}d)",
                callback_data=f"admactivar_{user_id}_{dias}"
            )],
            [InlineKeyboardButton(
                text="❌ Rechazar pago",
                callback_data=f"admrechazar_{user_id}"
            )],
        ])
        # Enviar foto primero
        await bot.send_photo(ADMIN_ID, foto_id)
        # Luego el detalle con botones
        await bot.send_message(ADMIN_ID, admin_texto, reply_markup=admin_kb)
    except Exception as e:
        logger.error(f"No se pudo notificar al admin del pago: {e}")

@dp.callback_query(F.data.startswith("admactivar_"))
async def cb_admin_activar_pago(call: types.CallbackQuery):
    if not es_admin(call.from_user.id):
        return await call.answer("⛔ Solo admin.", show_alert=True)
    partes = call.data.split("_")
    uid = int(partes[1])
    dias = int(partes[2])
    await db.activar_membresia(uid, dias)
    plan_nombre = "Diario" if dias == 1 else "Semanal" if dias == 7 else "Mensual"
    asyncio.create_task(sync_membresia_wsp(uid, dias, plan_nombre.lower()))
    await safe_edit(
        call.message,
        call.message.text + f"\n\n✅ ACTIVADO por {call.from_user.first_name}",
        reply_markup=None
    )
    try:
        await bot.send_message(
            uid,
            f"🎉 MEMBRESIA ACTIVADA!\n\n"
            f"📦 Plan: {plan_nombre}\n"
            f"⏳ Duracion: {dias} dia(s)\n\n"
            f"Ya puedes usar todas las funciones.\n"
            f"Usa /cmds para ver la guia."
        )
    except Exception:
        await call.message.answer("⚠ No se pudo notificar al usuario.")
    await call.answer(f"✅ Activado {plan_nombre} para {uid}")

@dp.callback_query(F.data.startswith("admrechazar_"))
async def cb_admin_rechazar_pago(call: types.CallbackQuery):
    if not es_admin(call.from_user.id):
        return await call.answer("⛔ Solo admin.", show_alert=True)
    uid = int(call.data.split("_")[1])
    await safe_edit(
        call.message,
        call.message.text + f"\n\n❌ RECHAZADO por {call.from_user.first_name}",
        reply_markup=None
    )
    try:
        await bot.send_message(
            uid,
            "❌ Tu pago fue rechazado.\n\n"
            "Posibles razones:\n"
            "• Captura no valida\n"
            "• Monto incorrecto\n"
            "• Datos no coinciden\n\n"
            "Contacta al admin si crees que es un error."
        )
    except Exception:
        pass
    await call.answer("❌ Pago rechazado")

@dp.message(Command("planes"))
@dp.message(F.text == "💳 Planes")
async def cmd_planes(msg: types.Message):
    texto = (
        "💳 PLANES J&D SPAM\n\n"
        "🥉 Plan Diario — S/ 2.00 (1 dia)\n"
        "🥈 Plan Semanal — S/ 10.00 (7 dias)\n"
        "🥇 Plan Mensual — S/ 25.00 (30 dias)\n\n"
        f"💰 Yape a: {YAPE_NUM}\n\n"
        "Selecciona un plan para pagar:"
    )
    botones = [
        [InlineKeyboardButton(text="🥉 Diario S/2", callback_data="pagar_diario"),
         InlineKeyboardButton(text="🥈 Semanal S/10", callback_data="pagar_semanal")],
        [InlineKeyboardButton(text="🥇 Mensual S/25", callback_data="pagar_mensual")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer(texto, reply_markup=kb)

@dp.message(Command("pagar"))
async def cmd_pagar(msg: types.Message):
    botones = [
        [InlineKeyboardButton(text="🥉 Diario S/2", callback_data="pagar_diario")],
        [InlineKeyboardButton(text="🥈 Semanal S/10", callback_data="pagar_semanal")],
        [InlineKeyboardButton(text="🥇 Mensual S/25", callback_data="pagar_mensual")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("💳 Que plan deseas pagar?", reply_markup=kb)

@dp.message(Command("expira"))
@dp.message(F.text == "⏰ Membresia")
async def cmd_expira(msg: types.Message):
    await db.crear_usuario(msg.from_user.id, msg.from_user.username or "")
    if es_admin(msg.from_user.id):
        return await msg.answer("👑 Eres admin. Acceso ilimitado.")
    user = await db.get_usuario(msg.from_user.id)
    if not user or not user["activo"]:
        return await msg.answer("⛔ Sin membresia activa.\nUsa /planes")
    expira   = user["fecha_expira"]
    plan     = user["plan"].capitalize()
    restante = "—"
    if expira:
        try:
            exp_dt = datetime.strptime(expira, "%Y-%m-%d %H:%M:%S")
            diff   = exp_dt - ahora_peru().replace(tzinfo=None)
            if diff.total_seconds() > 0:
                restante = f"{diff.days}d {diff.seconds // 3600}h"
            else:
                restante = "⚠ EXPIRADA"
        except ValueError:
            pass
    await msg.answer(f"⏰ Tu membresia:\n📦 Plan: {plan}\n📅 Expira: {expira}\n⏳ Resta: {restante}")

# ╔══════════════════════════════════════╗
# ║    SECCION: ELIMINAR                ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_eliminar")
async def cb_sec_eliminar(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto = "🗑 ELIMINAR\n\nQue deseas eliminar?"
    botones = [
        [InlineKeyboardButton(text="👤 Eliminar cuenta", callback_data="acc_del")],
        [InlineKeyboardButton(text="🌐 Eliminar grupo", callback_data="grp_del")],
        [InlineKeyboardButton(text="📋 Eliminar campana", callback_data="camp_eliminar")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.message(Command("eliminar"))
async def cmd_eliminar(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    botones = [
        [InlineKeyboardButton(text="👤 Eliminar cuenta", callback_data="acc_del")],
        [InlineKeyboardButton(text="🌐 Eliminar grupo", callback_data="grp_del")],
        [InlineKeyboardButton(text="📋 Eliminar campana", callback_data="camp_eliminar")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer("🗑 Que deseas eliminar?", reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: ESTADO / DASHBOARD      ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_dashboard")
async def cb_sec_dashboard(call: types.CallbackQuery):
    dashboard = await db.get_dashboard(call.from_user.id)
    texto = (
        "📊 DASHBOARD\n\n"
        f"👤 Cuentas: {dashboard['cuentas']}\n"
        f"🌐 Grupos: {dashboard['grupos']}\n"
        f"📋 Campanas: {dashboard['campanas']} ({dashboard['campanas_activas']} activas)\n"
        f"✅ Total enviados: {dashboard['total_enviados']}\n"
        f"❌ Total errores: {dashboard['total_errores']}\n"
        f"🤖 Responder: {'🟢 Activo' if dashboard['responder_activo'] else '🔴'}\n"
        f"📝 Keywords: {dashboard['keywords']}\n\n"
        f"🕐 {ahora_peru().strftime('%d/%m/%Y %H:%M')}"
    )
    botones = [kb_volver()]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.message(Command("me"))
@dp.message(Command("perfil"))
async def cmd_me(msg: types.Message):
    await db.crear_usuario(msg.from_user.id, msg.from_user.username or "")
    user = await db.get_usuario(msg.from_user.id)
    dashboard = await db.get_dashboard(msg.from_user.id)

    uid = msg.from_user.id
    username = f"@{msg.from_user.username}" if msg.from_user.username else "Sin username"
    nombre = msg.from_user.full_name or "—"

    # Membresia
    if es_admin(uid):
        plan_txt = "👑 Admin — Acceso ilimitado"
        estado_mem = "🟢 Activa (sin limite)"
        resta_txt = "∞"
        expira_txt = "Nunca"
    elif user and user["activo"]:
        plan = user["plan"] or "—"
        expira = user["fecha_expira"]
        expira_txt = expira or "—"
        resta_txt = "—"
        if expira:
            try:
                exp_dt = datetime.strptime(expira, "%Y-%m-%d %H:%M:%S")
                diff = exp_dt - ahora_peru().replace(tzinfo=None)
                if diff.total_seconds() > 0:
                    resta_txt = f"{diff.days}d {diff.seconds // 3600}h {(diff.seconds % 3600) // 60}m"
                else:
                    resta_txt = "EXPIRADA"
            except ValueError:
                pass
        plan_txt = f"📦 {plan.capitalize()}"
        estado_mem = "🟢 Activa"
    else:
        plan_txt = "Sin plan"
        estado_mem = "🔴 Inactiva"
        resta_txt = "—"
        expira_txt = "—"

    fecha_reg = user["fecha_registro"] if user else "—"

    texto = (
        f"👤 MI PERFIL\n\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"🆔 ID: {uid}\n"
        f"📛 Nombre: {nombre}\n"
        f"🔖 Username: {username}\n"
        f"📅 Registrado: {fecha_reg}\n"
        f"━━━━━━━━━━━━━━━━━━\n\n"
        f"💳 MEMBRESIA\n"
        f"  Estado: {estado_mem}\n"
        f"  Plan: {plan_txt}\n"
        f"  Expira: {expira_txt}\n"
        f"  Tiempo restante: {resta_txt}\n\n"
        f"📊 RECURSOS\n"
        f"  👤 Cuentas: {dashboard['cuentas']}\n"
        f"  🌐 Grupos: {dashboard['grupos']}\n"
        f"  📋 Campanas: {dashboard['campanas']} ({dashboard['campanas_activas']} activas)\n"
        f"  🤖 Responder: {'🟢 Activo' if dashboard['responder_activo'] else '🔴 Inactivo'}\n"
        f"  📝 Keywords: {dashboard['keywords']}\n\n"
        f"📈 ESTADISTICAS\n"
        f"  ✅ Enviados: {dashboard['total_enviados']}\n"
        f"  ❌ Errores: {dashboard['total_errores']}\n"
    )
    botones = [kb_volver()]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer(texto, reply_markup=kb)

@dp.message(Command("estado"))
@dp.message(F.text == "📊 Mi Estado")
async def cmd_estado(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    dashboard = await db.get_dashboard(msg.from_user.id)
    campanas = await db.get_campanas(msg.from_user.id)
    texto = "📊 ESTADO\n\n"
    if campanas:
        for c in campanas:
            estado = "🟢" if c["activa"] else "🔴"
            texto += f"  {estado} {c['nombre']} — ✅{c['enviados']} ❌{c['errores']}\n"
    texto += (
        f"\n━━━━━━━━━━━━━━━━━━\n"
        f"Total: ✅{dashboard['total_enviados']} ❌{dashboard['total_errores']}\n"
        f"🤖 Responder: {'🟢' if dashboard['responder_activo'] else '🔴'}"
    )
    botones = [kb_volver()]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer(texto, reply_markup=kb)

# ╔══════════════════════════════════════╗
# ║    SECCION: COMANDOS / AYUDA        ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_cmds")
async def cb_sec_cmds(call: types.CallbackQuery):
    texto = await build_menu_text(call.from_user.id)
    await safe_edit(call.message, texto, reply_markup=kb_inline_menu(call.from_user.id))
    await safe_answer(call)

@dp.message(Command("cmds"))
@dp.message(Command("ayuda"))
@dp.message(Command("help"))
@dp.message(F.text == "📖 Comandos")
async def cmd_cmds(msg: types.Message):
    texto = await build_menu_text(msg.from_user.id)
    await msg.answer(texto, reply_markup=kb_inline_menu(msg.from_user.id))


# ╔══════════════════════════════════════╗
# ║    SECCION: DETECTAR GRUPOS TELEGRAM║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "grp_detectar_tg")
async def cb_detectar_grupos_tg(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    sesiones = await db.get_sesiones(call.from_user.id)
    if not sesiones:
        botones = [[InlineKeyboardButton(text="🔙 Volver a Grupos", callback_data="sec_grupos")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "❌ No tienes cuentas TG vinculadas.\nVincula una cuenta primero.", reply_markup=kb)
        await safe_answer(call)
        return
    if len(sesiones) == 1:
        # Solo una cuenta, ir directo al menu de opciones
        await cb_grp_detect_menu(call, cuenta_override=sesiones[0]['nombre'])
        return
    texto = "🔍 DETECTAR GRUPOS DE TELEGRAM\n\nElige la cuenta para detectar grupos:\n"
    botones = []
    for s in sesiones:
        botones.append([InlineKeyboardButton(text=f"📱 {s['nombre']} — {s.get('telefono', '?')}", callback_data=f"grp_detect_menu:{s['nombre']}")])
    botones.append([InlineKeyboardButton(text="🔙 Volver a Grupos", callback_data="sec_grupos")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("grp_detect_menu:"))
async def cb_grp_detect_menu(call: types.CallbackQuery, cuenta_override=None):
    if not await verificar_membresia_cb(call):
        return
    cuenta = cuenta_override or call.data.split(":", 1)[1]
    texto = (
        f"🔍 DETECTAR GRUPOS DE TELEGRAM\n"
        f"📱 Cuenta: {cuenta}\n\n"
        "Opciones:\n\n"
        "1️⃣ Ver TODOS los grupos de tu cuenta\n"
        "2️⃣ Ver grupos por CARPETA\n"
        "3️⃣ Verificar estado de grupos guardados\n"
        "   (baneados, sin permiso, etc.)"
    )
    botones = [
        [InlineKeyboardButton(text="📋 Todos mis grupos", callback_data=f"grp_detect_todos:{cuenta}")],
        [InlineKeyboardButton(text="📂 Por carpeta", callback_data=f"grp_detect_carpetas:{cuenta}")],
        [InlineKeyboardButton(text="🔎 Verificar estado", callback_data="grp_detect_estado")],
        [InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data.startswith("grp_detect_todos:"))
async def cb_detect_todos(call: types.CallbackQuery, state: FSMContext):
    if not await verificar_membresia_cb(call):
        return
    cuenta = call.data.split(":", 1)[1]
    await safe_edit(call.message, f"⏳ Escaneando grupos de '{cuenta}'...\nEsto puede tardar unos segundos.")
    await safe_answer(call)

    grupos, info = await detectar_grupos_telegram(call.from_user.id, cuenta)

    if grupos is None:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ {info}", reply_markup=kb)
        return

    if not grupos:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "📭 No se encontraron grupos.", reply_markup=kb)
        return

    texto = f"🌐 GRUPOS ENCONTRADOS ({len(grupos)}):\n"
    texto += f"👤 Cuenta: {info}\n\n"

    for i, g in enumerate(grupos[:50], 1):
        estado = ""
        if g.get("banned"):
            estado = " ⛔BANEADO"
        elif g.get("restricted"):
            estado = " ⚠RESTRINGIDO"
        miembros = f" ({g['participants']}👥)" if g.get('participants') else ""
        link_txt = " 🔗" if g.get('link') else " 🔒"
        texto += f"{i}. {g['title'][:30]}{miembros}{link_txt}{estado}\n"

    if len(grupos) > 50:
        texto += f"\n... y {len(grupos) - 50} más"

    con_link = [g for g in grupos if g.get('link')]
    sin_link = len(grupos) - len(con_link)

    texto += f"\n\n📊 Total: {len(grupos)}"
    texto += f"\n🔗 Con link público: {len(con_link)}"
    texto += f"\n🔒 Sin link (privados): {sin_link}"
    texto += f"\n⛔ Baneados: {sum(1 for g in grupos if g.get('banned'))}"
    texto += f"\n⚠ Restringidos: {sum(1 for g in grupos if g.get('restricted'))}"

    if con_link:
        texto += "\n\n✅ Escribe los numeros para agregar (ej: 1,3,5)\no T para agregar todos los que tienen link"

    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"

    await state.update_data(grupos_detectados=grupos)
    await state.set_state(GrupoDetectState.esperando_seleccion_grupos)

    botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)


@dp.message(GrupoDetectState.esperando_seleccion_grupos)
async def recibir_seleccion_grupos_detect(msg: types.Message, state: FSMContext):
    if msg.text and msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))

    data = await state.get_data()
    grupos = data.get("grupos_detectados", [])
    if not grupos:
        await state.clear()
        return await msg.answer("❌ No hay grupos.", reply_markup=kb_menu_principal(msg.from_user.id))

    texto_in = msg.text.strip().lower()
    if texto_in in ("t", "todos"):
        seleccionados = [g for g in grupos if g.get('link')]
    else:
        seleccionados = []
        seen = set()
        for n in msg.text.split(","):
            n = n.strip()
            if n.isdigit():
                idx = int(n) - 1
                if 0 <= idx < len(grupos) and grupos[idx].get('link') and idx not in seen:
                    seen.add(idx)
                    seleccionados.append(grupos[idx])

    if not seleccionados:
        return await msg.answer("❌ Selección inválida o sin link público.")

    agregados = 0
    for g in seleccionados:
        if g.get('link'):
            await db.agregar_grupo(msg.from_user.id, g['link'])
            agregados += 1

    await state.clear()
    await msg.answer(
        f"✅ {agregados} grupo(s) agregados a tu lista.\n\n"
        f"Usa /grupos para verlos.",
        reply_markup=kb_menu_principal(msg.from_user.id)
    )


@dp.callback_query(F.data.startswith("grp_detect_carpetas"))
async def cb_detect_carpetas(call: types.CallbackQuery, state: FSMContext):
    if not await verificar_membresia_cb(call):
        return
    cuenta = None
    if ":" in call.data:
        cuenta = call.data.split(":", 1)[1]
    await state.update_data(tg_detect_cuenta=cuenta)
    await safe_edit(call.message, "⏳ Leyendo carpetas de Telegram...")
    await safe_answer(call)

    carpetas, info = await detectar_carpetas_telegram(call.from_user.id, cuenta)

    if carpetas is None:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ {info}", reply_markup=kb)
        return

    if not carpetas:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "📭 No tienes carpetas en Telegram.", reply_markup=kb)
        return

    texto = f"📂 TUS CARPETAS ({len(carpetas)}):\n\n"
    botones = []
    for i, c in enumerate(carpetas, 1):
        texto += f"{i}. 📁 {c['title']}\n"
        cb_data = f"grp_folder_{c['id']}"
        if cuenta:
            cb_data += f":{cuenta}"
        botones.append([InlineKeyboardButton(
            text=f"📁 {c['title']}",
            callback_data=cb_data
        )])

    texto += "\n👇 Selecciona una carpeta para ver sus grupos:"

    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)


@dp.callback_query(F.data.startswith("grp_folder_"))
async def cb_detect_carpeta_grupos(call: types.CallbackQuery, state: FSMContext):
    if not await verificar_membresia_cb(call):
        return
    parts = call.data.replace("grp_folder_", "")
    if ":" in parts:
        folder_id_str, cuenta = parts.split(":", 1)
    else:
        folder_id_str = parts
        data = await state.get_data()
        cuenta = data.get("tg_detect_cuenta")
    folder_id = int(folder_id_str)
    await safe_edit(call.message, "⏳ Leyendo grupos de la carpeta...")
    await safe_answer(call)

    grupos, info = await detectar_grupos_carpeta(call.from_user.id, folder_id, cuenta)

    if grupos is None:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detect_carpetas")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ {info}", reply_markup=kb)
        return

    if not grupos:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detect_carpetas")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "📭 No hay grupos en esta carpeta.", reply_markup=kb)
        return

    texto = f"📂 GRUPOS EN CARPETA ({len(grupos)}):\n\n"

    for i, g in enumerate(grupos[:50], 1):
        estado = ""
        if g.get("banned"):
            estado = " ⛔"
        elif g.get("restricted"):
            estado = " ⚠"
        link_txt = " 🔗" if g.get('link') else " 🔒"
        texto += f"{i}. {g['title'][:30]}{link_txt}{estado}\n"

    con_link = [g for g in grupos if g.get('link')]
    texto += f"\n📊 Total: {len(grupos)} | Con link: {len(con_link)}"

    if con_link:
        texto += "\n\n✅ Escribe los numeros para agregar (ej: 1,3,5)\no T para todos con link"

    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"

    await state.update_data(grupos_detectados=grupos)
    await state.set_state(GrupoDetectState.esperando_seleccion_grupos_carpeta)

    botones = [[InlineKeyboardButton(text="🔙 Volver a Carpetas", callback_data="grp_detect_carpetas")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)


@dp.message(GrupoDetectState.esperando_seleccion_grupos_carpeta)
async def recibir_seleccion_grupos_carpeta(msg: types.Message, state: FSMContext):
    if msg.text and msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))

    data = await state.get_data()
    grupos = data.get("grupos_detectados", [])
    if not grupos:
        await state.clear()
        return await msg.answer("❌ No hay grupos.", reply_markup=kb_menu_principal(msg.from_user.id))

    texto_in = msg.text.strip().lower()
    if texto_in in ("t", "todos"):
        seleccionados = [g for g in grupos if g.get('link')]
    else:
        seleccionados = []
        seen = set()
        for n in msg.text.split(","):
            n = n.strip()
            if n.isdigit():
                idx = int(n) - 1
                if 0 <= idx < len(grupos) and grupos[idx].get('link') and idx not in seen:
                    seen.add(idx)
                    seleccionados.append(grupos[idx])

    if not seleccionados:
        return await msg.answer("❌ Selección inválida o sin link público.")

    agregados = 0
    for g in seleccionados:
        if g.get('link'):
            await db.agregar_grupo(msg.from_user.id, g['link'])
            agregados += 1

    await state.clear()
    await msg.answer(
        f"✅ {agregados} grupo(s) agregados de la carpeta.\n\n"
        f"Usa /grupos para verlos.",
        reply_markup=kb_menu_principal(msg.from_user.id)
    )


@dp.callback_query(F.data == "grp_detect_estado")
async def cb_detect_estado(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    await safe_edit(call.message, "⏳ Verificando estado de tus grupos...\nEsto puede tardar varios segundos.")
    await safe_answer(call)

    resultados, info = await verificar_grupos_estado(call.from_user.id)

    if resultados is None:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ {info}", reply_markup=kb)
        return

    if not resultados:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "📭 No tienes grupos guardados.", reply_markup=kb)
        return

    ICONOS = {
        "ok": "✅", "baneado": "⛔", "sin_permiso": "🚫",
        "solo_lectura": "🔇", "privado": "🔒", "no_miembro": "👋",
        "no_encontrado": "❓", "link_expirado": "⏰",
        "restringido": "⚠", "error": "❗", "desconocido": "❓",
    }

    texto = f"🔎 ESTADO DE TUS GRUPOS ({len(resultados)}):\n"
    texto += f"👤 Cuenta: {info}\n\n"

    ok_count = 0
    problemas = 0
    for i, r in enumerate(resultados[:40], 1):
        icono = ICONOS.get(r['estado'], "❓")
        titulo = r['titulo'] if isinstance(r['titulo'], str) else r['link']
        if len(titulo) > 30:
            titulo = titulo[:30] + "..."
        estado_txt = r['estado'].replace("_", " ").upper()
        texto += f"{i}. {icono} {titulo}\n   Estado: {estado_txt}\n"
        if r['estado'] == 'ok':
            ok_count += 1
        else:
            problemas += 1

    if len(resultados) > 40:
        texto += f"\n... y {len(resultados) - 40} más"

    texto += f"\n\n📊 RESUMEN:"
    texto += f"\n✅ OK: {ok_count}"
    texto += f"\n❌ Con problemas: {problemas}"

    estados_count = {}
    for r in resultados:
        e = r['estado']
        estados_count[e] = estados_count.get(e, 0) + 1

    for estado, count in sorted(estados_count.items()):
        if estado != "ok":
            icono = ICONOS.get(estado, "❓")
            texto += f"\n   {icono} {estado.replace('_', ' ')}: {count}"

    problematicos = [r for r in resultados if r['estado'] != 'ok']
    if problematicos:
        texto += "\n\n🗑 ¿Eliminar grupos con problemas?"

    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"

    botones = []
    if problematicos:
        botones.append([InlineKeyboardButton(text="🗑 Eliminar problemáticos", callback_data="grp_detect_limpiar")])
    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)


@dp.callback_query(F.data == "grp_detect_limpiar")
async def cb_detect_limpiar(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    await safe_edit(call.message, "⏳ Verificando y limpiando...")
    await safe_answer(call)

    resultados, info = await verificar_grupos_estado(call.from_user.id)

    if resultados is None:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="grp_detectar_tg")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ {info}", reply_markup=kb)
        return

    eliminados = 0
    for r in resultados:
        if r['estado'] != 'ok':
            await db.eliminar_grupo(call.from_user.id, r['grupo_id'])
            eliminados += 1

    botones = [[InlineKeyboardButton(text="🔙 Volver a Grupos", callback_data="sec_grupos")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message,
        f"🗑 {eliminados} grupo(s) eliminados.\n"
        f"✅ {len(resultados) - eliminados} grupo(s) OK.",
        reply_markup=kb)


@dp.message(Command("detectar"))
async def cmd_detectar(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    sesiones = await db.get_sesiones(msg.from_user.id)
    if not sesiones:
        await msg.answer("❌ No tienes cuentas TG vinculadas.\nVincula una cuenta primero.")
        return
    if len(sesiones) == 1:
        cuenta = sesiones[0]['nombre']
        texto = (
            f"🔍 DETECTAR GRUPOS DE TELEGRAM\n"
            f"📱 Cuenta: {cuenta}\n\nOpciones:"
        )
        botones = [
            [InlineKeyboardButton(text="📋 Todos mis grupos", callback_data=f"grp_detect_todos:{cuenta}")],
            [InlineKeyboardButton(text="📂 Por carpeta", callback_data=f"grp_detect_carpetas:{cuenta}")],
            [InlineKeyboardButton(text="🔎 Verificar estado", callback_data="grp_detect_estado")],
            kb_volver(),
        ]
    else:
        texto = "🔍 DETECTAR GRUPOS DE TELEGRAM\n\nElige la cuenta:"
        botones = []
        for s in sesiones:
            botones.append([InlineKeyboardButton(text=f"📱 {s['nombre']} — {s.get('telefono', '?')}", callback_data=f"grp_detect_menu:{s['nombre']}")])
        botones.append(kb_volver())
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer(texto, reply_markup=kb)



# ╔══════════════════════════════════════╗
# ║    SELECCION TG / WSP               ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_cmdtlg")
async def cb_sec_cmdtlg(call: types.CallbackQuery):
    """Redirige al menú principal completo."""
    texto = await build_menu_text(call.from_user.id)
    await safe_edit(call.message, texto, reply_markup=kb_inline_menu(call.from_user.id))
    await safe_answer(call)


@dp.callback_query(F.data == "sec_cmdwsp")
async def cb_sec_cmdwsp(call: types.CallbackQuery):
    """Redirige a la sección WhatsApp."""
    # Simular click en sec_wsp
    await cb_sec_wsp(call)


@dp.callback_query(F.data == "menu_principal")
async def cb_menu_principal(call: types.CallbackQuery):
    """Menú principal con selección TG/WSP."""
    texto = (
        "🛡 *BOT J&D* 🛡\n\n"
        "Bienvenido! Selecciona la plataforma:\n"
    )
    botones = [
        [InlineKeyboardButton(text="📱 Telegram", callback_data="sec_cmdtlg")],
        [InlineKeyboardButton(text="📱 WhatsApp", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# ╔══════════════════════════════════════╗
# ║    TELEGRAM: SECCIONES EXTRA        ║
# ╚══════════════════════════════════════╝

@dp.callback_query(F.data == "tg_programados")
async def cb_tg_programados(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_programados(call.from_user.id)
    progs = r.get("programados", []) if r.get("ok") else []
    texto = f"⏰ PROGRAMADOS TG ({len(progs)}):\n\n"
    if progs:
        for i, p in enumerate(progs, 1):
            estado = "✅" if p.get("activo") else "⏸"
            texto += f"{i}. {estado} Hora: {p.get('hora','?')} — Msg ID: {p.get('mensaje_id','?')}\n"
    else:
        texto += "(sin envíos programados)\n"
    texto += "\nUsa el panel web para crear programados."
    botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_cmdtlg")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "tg_listanegra")
async def cb_tg_listanegra(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_lista_negra(call.from_user.id)
    items = r.get("lista", []) if r.get("ok") else []
    texto = f"🚫 LISTA NEGRA TG ({len(items)}):\n\n"
    if items:
        for i, n in enumerate(items[:20], 1):
            texto += f"{i}. {n.get('numero','?')}\n"
        if len(items) > 20:
            texto += f"\n...y {len(items)-20} más"
    else:
        texto += "(vacía)\n"
    texto += "\nUsa el panel web para agregar/quitar."
    botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_cmdtlg")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "tg_config")
async def cb_tg_config(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_envio_config(call.from_user.id)
    if r.get("ok"):
        c = r.get("config", {})
        texto = (
            "⚙ CONFIG ENVÍO TG:\n\n"
            f"⏱ Delay: {c.get('delay_seg', 10)}s\n"
            f"📦 Lote: {c.get('lote_tamano', 0)}\n"
            f"⏸ Pausa lote: {c.get('lote_pausa_seg', 30)}s\n"
            f"🕐 Horario: {c.get('hora_inicio', 0)}h - {c.get('hora_fin', 24)}h\n"
        )
    else:
        texto = "⚙ Config no disponible\n"
    texto += "\nModifica desde el panel web."
    botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_cmdtlg")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "tg_stats")
async def cb_tg_stats(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_dashboard(call.from_user.id)
    if r.get("ok"):
        d = r.get("dashboard", r)
        texto = (
            "📈 STATS TG:\n\n"
            f"📤 Enviados: {d.get('enviados', 0)}\n"
            f"❌ Errores: {d.get('errores', 0)}\n"
            f"🌐 Grupos: {d.get('grupos', 0)}\n"
            f"👤 Cuentas: {d.get('sesiones', 0)}\n"
            f"📋 Campañas: {d.get('campanas', 0)}\n"
        )
    else:
        texto = "📈 Stats no disponible\n"
    botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_cmdtlg")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "tg_membresia")
async def cb_tg_membresia(call: types.CallbackQuery):
    user = await db.get_usuario(call.from_user.id)
    if user:
        plan = user["plan"] if user["plan"] else "sin_plan"
        exp = user["fecha_expira"] if user["fecha_expira"] else "N/A"
        activo = plan == "permanente" or (exp != "N/A" and datetime.fromisoformat(exp) > ahora_peru().replace(tzinfo=None))
        texto = (
            "👑 TU MEMBRESÍA:\n\n"
            f"📋 Plan: {plan}\n"
            f"📅 Expira: {exp}\n"
            f"✅ Estado: {'Activa' if activo else '⛔ Expirada'}\n"
        )
    else:
        texto = "👑 No tienes membresía activa.\nContacta al admin para activar."
    botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_cmdtlg")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "tg_panelweb")
async def cb_tg_panelweb(call: types.CallbackQuery):
    texto = (
        "🌐 PANEL WEB\n\n"
        "Accede al panel desde tu navegador:\n"
        "https://jdbotspam.duckdns.org\n\n"
        "Desde el panel puedes controlar todo:\n"
        "• Cuentas WSP y Telegram\n"
        "• Grupos, Mensajes, Campañas\n"
        "• Config de envío, Programados\n"
        "• Lista negra, Auto-responder\n"
        "• Estadísticas y Historial\n"
        "• Admin y Membresías"
    )
    botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_cmdtlg")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# ╔══════════════════════════════════════╗
# ║    SECCION: WHATSAPP (CONTROL)      ║
# ╚══════════════════════════════════════╝

WSP_API_URL = "http://localhost:3000"
WSP_IP = "64.23.201.243"  # IP del DigitalOcean

@dp.callback_query(F.data == "sec_wsp")
async def cb_sec_wsp(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_status()
    if r.get("ok"):
        estado = "🟢 Conectado" if r["status"] == "conectado" else "🔴 Desconectado"
        numero = r.get("bot_number", "---")
    else:
        estado = "⚠ Sin conexión al bot WSP"
        numero = "---"

    texto = (
        f"📱 CONTROL WHATSAPP\n\n"
        f"Estado: {estado}\n"
        f"Número bot: {numero}\n\n"
        f"Controla tu bot de WhatsApp desde aquí:"
    )
    botones = [
        [InlineKeyboardButton(text="👤 Cuentas WSP", callback_data="wsp_cuentas")],
        [InlineKeyboardButton(text="🌐 Grupos WSP", callback_data="wsp_grupos"),
         InlineKeyboardButton(text="🔍 Detectar Grupos", callback_data="wsp_detectar")],
        [InlineKeyboardButton(text="📝 Mensajes", callback_data="wsp_mensajes")],
        [InlineKeyboardButton(text="📤 Enviar Único", callback_data="wsp_envio_unico"),
         InlineKeyboardButton(text="⏰ Programados", callback_data="wsp_programados")],
        [InlineKeyboardButton(text="📋 Campañas WSP", callback_data="wsp_campanas")],
        [InlineKeyboardButton(text="🚀 Iniciar campaña", callback_data="wsp_iniciar"),
         InlineKeyboardButton(text="🛑 Detener", callback_data="wsp_detener")],
        [InlineKeyboardButton(text="📨 Envío Personal", callback_data="wsp_personal"),
         InlineKeyboardButton(text="👥 Envío a Miembros", callback_data="wsp_envio_miembros")],
        [InlineKeyboardButton(text="⚙ Config Envío", callback_data="wsp_config"),
         InlineKeyboardButton(text="🚫 Lista Negra", callback_data="wsp_listanegra")],
        [InlineKeyboardButton(text="🤖 Auto-Responder", callback_data="wsp_autoresponder")],
        [InlineKeyboardButton(text="💬 Envío Interactivo", callback_data="wsp_interactivo")],
        [InlineKeyboardButton(text="📊 Historial WSP", callback_data="wsp_historial"),
         InlineKeyboardButton(text="📈 Stats Grupos", callback_data="wsp_stats")],
        [InlineKeyboardButton(text="📈 Dashboard WSP", callback_data="wsp_dashboard")],
        [InlineKeyboardButton(text="💾 Backup WSP", callback_data="wsp_backup"),
         InlineKeyboardButton(text="🔐 Sesiones WSP", callback_data="wsp_sesiones")],
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="👑 Membresía WSP", callback_data="wsp_membresia")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- BACKUP WSP ---
@dp.callback_query(F.data == "wsp_backup")
async def cb_wsp_backup(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto = (
        "💾 BACKUP WHATSAPP\n\n"
        "Exporta o importa tu configuracion completa\n"
        "(grupos, campanas, plantillas, lista negra, auto-resp, config)."
    )
    botones = [
        [InlineKeyboardButton(text="📤 Exportar config", callback_data="wsp_backup_export")],
        [InlineKeyboardButton(text="📥 Importar config", callback_data="wsp_backup_import")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "wsp_backup_export")
async def cb_wsp_backup_export(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    import json as _json
    r = await wsp.wsp_config_exportar(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="wsp_backup")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error', 'sin conexion')}", reply_markup=kb)
        await safe_answer(call)
        return
    data = r.get("data", {})
    export_text = _json.dumps(data, ensure_ascii=False, indent=2)
    if len(export_text) > 4000:
        # Send as file
        import tempfile
        tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False, prefix='backup_wsp_')
        tmp.write(export_text)
        tmp.close()
        from aiogram.types import FSInputFile
        doc = FSInputFile(tmp.name, filename=f"backup_wsp_{call.from_user.id}.json")
        await call.message.answer_document(doc, caption="💾 Backup WSP exportado correctamente.")
        os.unlink(tmp.name)
    else:
        await call.message.answer(f"💾 BACKUP EXPORTADO:\n\n<pre>{export_text[:3900]}</pre>", parse_mode="HTML")
    botones = [[InlineKeyboardButton(text="🔙 Volver a Backup", callback_data="wsp_backup")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "✅ Backup exportado. Revisa el mensaje anterior.", reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "wsp_backup_import")
async def cb_wsp_backup_import(call: types.CallbackQuery, state: FSMContext):
    if not await verificar_membresia_cb(call):
        return
    await call.message.answer(
        "📥 IMPORTAR BACKUP WSP\n\n"
        "Envia el archivo JSON de backup.\n"
        "Puedes obtenerlo con la opcion de exportar.\n\n"
        "Envia /cancelar para cancelar."
    )
    await state.set_state(BackupImportState.esperando_archivo)
    await safe_answer(call)


class BackupImportState(StatesGroup):
    esperando_archivo = State()


@dp.message(BackupImportState.esperando_archivo)
async def recibir_backup_import(msg: types.Message, state: FSMContext):
    if msg.text and msg.text.startswith("/"):
        await state.clear()
        return await msg.answer("❌ Cancelado.", reply_markup=kb_menu_principal(msg.from_user.id))
    if msg.document:
        try:
            file = await bot.get_file(msg.document.file_id)
            contenido_bytes = await bot.download_file(file.file_path)
            contenido = contenido_bytes.read().decode("utf-8", errors="ignore")
            import json as _json
            data = _json.loads(contenido)
        except Exception:
            return await msg.answer("❌ Archivo no valido. Debe ser un JSON de backup.")
    elif msg.text:
        try:
            import json as _json
            data = _json.loads(msg.text)
        except Exception:
            return await msg.answer("❌ JSON no valido. Pega el JSON del backup o envia el archivo.")
    else:
        return await msg.answer("❌ Envia el archivo JSON o pega el contenido.")

    import wsp_bridge as wsp
    r = await wsp.wsp_config_importar(msg.from_user.id, data)
    await state.clear()
    if r.get("ok"):
        imported = r.get("imported", {})
        texto = "✅ BACKUP IMPORTADO:\n\n"
        for key, val in imported.items():
            texto += f"  • {key}: {val}\n"
        await msg.answer(texto, reply_markup=kb_menu_principal(msg.from_user.id))
    else:
        await msg.answer(f"❌ Error: {r.get('error', 'error desconocido')}", reply_markup=kb_menu_principal(msg.from_user.id))


# --- SESIONES WSP ---
@dp.callback_query(F.data == "wsp_sesiones")
async def cb_wsp_sesiones(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_panel_sessions(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error', 'sin conexion')}", reply_markup=kb)
        await safe_answer(call)
        return
    sessions = r.get("sessions", [])
    texto = f"🔐 SESIONES ACTIVAS WSP ({len(sessions)}):\n\n"
    if sessions:
        for i, s in enumerate(sessions, 1):
            ip = s.get("ip", "?")
            ua = s.get("user_agent", "?")
            if len(ua) > 40:
                ua = ua[:40] + "..."
            fecha = s.get("created_at", "?")
            texto += f"{i}. {ip}\n   {ua}\n   Desde: {fecha}\n\n"
    else:
        texto += "(sin sesiones activas)\n"
    texto += "Gestiona sesiones desde el Panel Web."
    botones = [
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- CUENTAS WSP ---
@dp.callback_query(F.data == "wsp_cuentas")
async def cb_wsp_cuentas(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_sesiones(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error', 'sin conexión')}", reply_markup=kb)
        await safe_answer(call)
        return

    sesiones = r.get("sesiones", [])
    baneadas = r.get("baneadas", [])
    ban_nombres = [b["nombre"] for b in baneadas] if baneadas else []

    texto = f"👤 CUENTAS WHATSAPP ({len(sesiones)}):\n\n"
    if sesiones:
        for i, s in enumerate(sesiones, 1):
            estado = "⛔ BANEADA" if s.get("nombre") in ban_nombres else "✅ Activa"
            texto += f"{i}. {s.get('nombre', '?')} — {s.get('telefono', '?')} {estado}\n"
    else:
        texto += "(sin cuentas vinculadas)\n"

    texto += f"\nPara vincular una cuenta WSP, envía:\n/vincularwsp nombre_cuenta"

    botones = []
    if sesiones:
        botones.append([InlineKeyboardButton(text="🗑 Eliminar cuenta WSP", callback_data="wsp_acc_del")])
    botones.append([InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "wsp_acc_del")
async def cb_wsp_acc_del(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_sesiones(call.from_user.id)
    if not r.get("ok") or not r.get("sesiones"):
        await call.answer("No tienes cuentas WSP.", show_alert=True)
        return
    botones = [
        [InlineKeyboardButton(
            text=f"🗑 {s.get('nombre', '?')} — {s.get('telefono', '?')}",
            callback_data=f"wsp_accdel_{s.get('nombre', '')}"
        )] for s in r["sesiones"]
    ]
    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="wsp_cuentas")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "🗑 Selecciona la cuenta WSP a eliminar:", reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data.startswith("wsp_accdel_"))
async def cb_wsp_acc_del_confirm(call: types.CallbackQuery):
    nombre = call.data.replace("wsp_accdel_", "")
    import wsp_bridge as wsp
    r = await wsp.wsp_desvincular(call.from_user.id, nombre)
    if r.get("ok"):
        await call.answer(f"✅ Cuenta WSP '{nombre}' eliminada.", show_alert=True)
    else:
        await call.answer(f"❌ Error: {r.get('error', 'desconocido')}", show_alert=True)
    # Refresh the WSP accounts view
    await cb_wsp_cuentas(call)


@dp.message(Command("vincularwsp"))
async def cmd_vincular_wsp(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    nombre = command.args
    if not nombre:
        return await msg.answer("Uso: /vincularwsp nombre_cuenta\nEjemplo: /vincularwsp micuenta1")

    import wsp_bridge as wsp
    r = await wsp.wsp_vincular(msg.from_user.id, nombre.strip())
    if r.get("ok"):
        link = f"http://{WSP_IP}:3000{r['link_url']}"
        botones_v = [
            [InlineKeyboardButton(text="🔄 Verificar vinculación", callback_data=f"wsp_check_link_{nombre.strip()}")],
            [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
        ]
        kb_v = InlineKeyboardMarkup(inline_keyboard=botones_v)
        await msg.answer(
            f"📱 Vincular cuenta WSP: *{nombre}*\n\n"
            f"Abre este link en tu navegador:\n{link}\n\n"
            f"Escanea el QR con WhatsApp del celular que quieres vincular.\n\n"
            f"Después presiona 🔄 Verificar para confirmar.",
            reply_markup=kb_v,
            parse_mode="Markdown"
        )
    else:
        await msg.answer(f"❌ Error: {r.get('error', 'sin conexión')}")


# --- GRUPOS WSP ---
@dp.callback_query(F.data == "wsp_grupos")
async def cb_wsp_grupos(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_grupos(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error', 'sin conexión')}", reply_markup=kb)
        await safe_answer(call)
        return

    grupos = r.get("grupos", [])
    max_g = r.get("max", 25)

    texto = f"🌐 GRUPOS WHATSAPP\n\n"
    if grupos:
        for i, g in enumerate(grupos[:30], 1):
            link = g.get("link", "?")
            if len(link) > 35:
                link = link[:35] + "..."
            texto += f"{i}. {link}\n"
        texto += f"\nTotal: {len(grupos)}/{max_g}\n"
    else:
        texto += "(sin grupos)\n"

    texto += "\nPara agregar grupos WSP:\n/wspgrupo link1 link2 ..."

    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"

    botones = [
        [InlineKeyboardButton(text="🗑 Eliminar todos", callback_data="wsp_grupos_delall")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.message(Command("wspgrupo"))
async def cmd_wsp_grupo(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    args = command.args
    if not args:
        return await msg.answer("Uso: /wspgrupo link1 link2 ...\nEjemplo: /wspgrupo https://chat.whatsapp.com/abc123")

    import wsp_bridge as wsp
    links = [l.strip() for l in args.split() if l.strip()]
    agregados = 0
    for link in links:
        r = await wsp.wsp_agregar_grupo(msg.from_user.id, link)
        if r.get("ok"):
            agregados += 1
    await msg.answer(f"✅ {agregados}/{len(links)} grupo(s) WSP agregados.")


@dp.callback_query(F.data == "wsp_grupos_delall")
async def cb_wsp_grupos_delall(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_eliminar_todos_grupos(call.from_user.id)
    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    if r.get("ok"):
        await safe_edit(call.message, "🗑 Todos los grupos WSP eliminados.", reply_markup=kb)
    else:
        await safe_edit(call.message, f"❌ Error: {r.get('error')}", reply_markup=kb)
    await safe_answer(call)


# --- ENVIO PERSONAL WSP ---
@dp.callback_query(F.data == "wsp_personal")
async def cb_wsp_personal(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_chats_personales(call.from_user.id)
    botones_back = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb_back = InlineKeyboardMarkup(inline_keyboard=botones_back)
    if not r.get("ok"):
        await safe_edit(call.message, f"Error: {r.get('error')}", reply_markup=kb_back)
        await safe_answer(call)
        return

    total = r.get("total", 0)
    chats = r.get("chats", [])
    texto = f"Chats personales encontrados: {total}\n\n"
    for i, c in enumerate(chats[:30], 1):
        texto += f"  {i}. {c.get('nombre', '?')} ({c.get('numero', '?')})\n"
    if total > 30:
        texto += f"  ... y {total - 30} mas\n"

    texto += f"\nPara enviar a todos:\n/wsppersonal Tu mensaje aqui\n\nDelay: 10 seg entre cada envio (anti-ban)"
    botones = [
        [InlineKeyboardButton(text="Cancelar envio activo", callback_data="wsp_cancelar_personal")],
        [InlineKeyboardButton(text="Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.message(Command("wsppersonal"))
async def cmd_wsp_personal(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    args = command.args
    if not args:
        return await msg.answer(
            "Uso: /wsppersonal Tu mensaje aqui\n\n"
            "Envia un mensaje a todos tus chats personales con 10 seg de delay entre cada uno."
        )
    import wsp_bridge as wsp
    r = await wsp.wsp_enviar_personal(msg.from_user.id, args)
    if r.get("ok"):
        await msg.answer("Envio personal iniciado! Recibiras progreso en WhatsApp.\n\nUsa /wspcancelarpersonal para detener.")
    else:
        await msg.answer(f"Error: {r.get('error', r.get('message', 'error desconocido'))}")


@dp.message(Command("wspcancelarpersonal"))
async def cmd_wsp_cancelar_personal(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_cancelar_envio_personal(msg.from_user.id)
    if r.get("ok"):
        await msg.answer("Envio personal cancelado.")
    else:
        await msg.answer("No hay envio personal activo.")


@dp.callback_query(F.data == "wsp_cancelar_personal")
async def cb_wsp_cancelar_personal(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_cancelar_envio_personal(call.from_user.id)
    botones = [[InlineKeyboardButton(text="Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    if r.get("ok"):
        await safe_edit(call.message, "Envio personal cancelado.", reply_markup=kb)
    else:
        await safe_edit(call.message, "No hay envio personal activo.", reply_markup=kb)
    await safe_answer(call)


# --- CAMPAÑAS WSP ---
@dp.callback_query(F.data == "wsp_campanas")
async def cb_wsp_campanas(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_campanas(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error', 'sin conexión')}", reply_markup=kb)
        await safe_answer(call)
        return

    campanas = r.get("campanas", [])
    texto = f"📋 CAMPAÑAS WHATSAPP ({len(campanas)}):\n\n"
    if campanas:
        for i, c in enumerate(campanas, 1):
            estado = "🟢" if c.get("activa") else "🔴"
            texto += f"{i}. {estado} {c.get('nombre', '?')}\n"
            texto += f"   Enviados: {c.get('enviados', 0)} | Errores: {c.get('errores', 0)}\n"
    else:
        texto += "(sin campañas)\n"

    texto += "\nCrear campaña WSP:\n/wspcampana nombre | mensaje"

    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.message(Command("wspcampana"))
async def cmd_wsp_campana(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    args = command.args
    if not args or "|" not in args:
        return await msg.answer("Uso: /wspcampana nombre | mensaje\nEjemplo: /wspcampana Promo1 | Hola! Tenemos ofertas...")

    parts = args.split("|", 1)
    nombre = parts[0].strip()
    mensaje = parts[1].strip()
    if not nombre or not mensaje:
        return await msg.answer("❌ Nombre y mensaje son requeridos.\nUso: /wspcampana nombre | mensaje")

    import wsp_bridge as wsp
    r = await wsp.wsp_crear_campana(msg.from_user.id, nombre, mensaje)
    if r.get("ok"):
        await msg.answer(f"✅ Campaña WSP '{nombre}' creada (ID: {r['id']}).\n\nPara iniciar: /wspstart {r['id']}")
    else:
        await msg.answer(f"❌ Error: {r.get('error')}")


# --- INICIAR / DETENER ---
@dp.callback_query(F.data == "wsp_iniciar")
async def cb_wsp_iniciar(call: types.CallbackQuery, state: FSMContext):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_campanas(call.from_user.id)
    if not r.get("ok") or not r.get("campanas"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "📭 No tienes campañas WSP.\nCrea una con /wspcampana nombre | mensaje", reply_markup=kb)
        await safe_answer(call)
        return

    campanas = r["campanas"]
    botones = []
    for c in campanas[:10]:
        estado = "🟢" if c.get("activa") else "🔴"
        botones.append([InlineKeyboardButton(
            text=f"{estado} {c['nombre']}",
            callback_data=f"wsp_start_{c['id']}"
        )])
    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "🚀 Selecciona campaña WSP para iniciar:", reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data.startswith("wsp_start_"))
async def cb_wsp_start(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    camp_id = int(call.data.replace("wsp_start_", ""))
    import wsp_bridge as wsp
    r = await wsp.wsp_iniciar(call.from_user.id, camp_id)
    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    if r.get("ok"):
        await safe_edit(call.message, f"🚀 Campaña WSP '{r.get('campana', '')}' iniciada!", reply_markup=kb)
    else:
        await safe_edit(call.message, f"❌ Error: {r.get('error')}", reply_markup=kb)
    await safe_answer(call)


@dp.message(Command("wspstart"))
async def cmd_wsp_start(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    args = command.args
    if not args or not args.strip().isdigit():
        return await msg.answer("Uso: /wspstart ID_CAMPANA")
    import wsp_bridge as wsp
    r = await wsp.wsp_iniciar(msg.from_user.id, int(args.strip()))
    if r.get("ok"):
        await msg.answer(f"🚀 Campaña WSP '{r.get('campana', '')}' iniciada!")
    else:
        await msg.answer(f"❌ Error: {r.get('error')}")


@dp.callback_query(F.data == "wsp_detener")
async def cb_wsp_detener(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_activas()
    activas = r.get("activas", [])
    if not activas:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "📭 No hay campañas WSP activas.", reply_markup=kb)
        await safe_answer(call)
        return

    botones = []
    for camp_id in activas:
        botones.append([InlineKeyboardButton(
            text=f"🛑 Detener campaña #{camp_id}",
            callback_data=f"wsp_stop_{camp_id}"
        )])
    botones.append([InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, "🛑 Selecciona campaña WSP para detener:", reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data.startswith("wsp_stop_"))
async def cb_wsp_stop(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    camp_id = int(call.data.replace("wsp_stop_", ""))
    import wsp_bridge as wsp
    r = await wsp.wsp_detener(camp_id)
    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    if r.get("ok"):
        await safe_edit(call.message, f"🛑 Campaña WSP #{camp_id} detenida.", reply_markup=kb)
    else:
        await safe_edit(call.message, f"❌ Error: {r.get('error')}", reply_markup=kb)
    await safe_answer(call)


@dp.message(Command("wspstop"))
async def cmd_wsp_stop(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    args = command.args
    if not args or not args.strip().isdigit():
        return await msg.answer("Uso: /wspstop ID_CAMPANA")
    import wsp_bridge as wsp
    r = await wsp.wsp_detener(int(args.strip()))
    if r.get("ok"):
        await msg.answer("🛑 Campaña WSP detenida.")
    else:
        await msg.answer(f"❌ Error: {r.get('error')}")


# --- HISTORIAL / DASHBOARD ---
@dp.callback_query(F.data == "wsp_historial")
async def cb_wsp_historial(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_historial(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error')}", reply_markup=kb)
        await safe_answer(call)
        return

    envios = r.get("envios", [])
    texto = f"📊 HISTORIAL WSP (últimos {len(envios)}):\n\n"
    if envios:
        for e in envios[:20]:
            icono = "✅" if e.get("resultado") == "enviado" else "❌"
            grupo = e.get("grupo_link", "?")
            if len(grupo) > 25:
                grupo = grupo[:25] + "..."
            texto += f"{icono} {grupo} | {e.get('fecha', '?')}\n"
    else:
        texto += "(sin envíos)\n"

    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"

    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.callback_query(F.data == "wsp_dashboard")
async def cb_wsp_dashboard(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_dashboard(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error')}", reply_markup=kb)
        await safe_answer(call)
        return

    d = r.get("dashboard", {})
    texto = (
        f"📈 DASHBOARD WHATSAPP\n\n"
        f"📨 Total enviados: {d.get('total_enviados', 0)}\n"
        f"✅ Exitosos: {d.get('exitosos', 0)}\n"
        f"❌ Fallidos: {d.get('fallidos', 0)}\n"
        f"📊 Tasa exito: {d.get('tasa_exito', 0)}%\n"
        f"🌐 Grupos: {d.get('total_grupos', 0)}\n"
        f"📋 Campanas: {d.get('total_campanas', 0)}\n"
        f"👤 Cuentas: {d.get('total_sesiones', 0)}\n"
    )
    # Add extended dashboard data (weekly/monthly)
    ext = await wsp.wsp_dashboard_extended(call.from_user.id)
    if ext.get("ok"):
        ed = ext.get("extended", ext)
        semanal = ed.get("semanal", {})
        mensual = ed.get("mensual", {})
        if semanal:
            texto += (
                f"\n📅 SEMANAL:\n"
                f"  Enviados: {semanal.get('enviados', 0)}\n"
                f"  Errores: {semanal.get('errores', 0)}\n"
            )
        if mensual:
            texto += (
                f"\n📆 MENSUAL:\n"
                f"  Enviados: {mensual.get('enviados', 0)}\n"
                f"  Errores: {mensual.get('errores', 0)}\n"
            )
        top_grupos = ed.get("top_grupos", [])
        if top_grupos:
            texto += "\n🏆 TOP GRUPOS:\n"
            for i, tg in enumerate(top_grupos[:5], 1):
                nombre = tg.get("grupo_link", "?")
                if len(nombre) > 25:
                    nombre = nombre[:25] + "..."
                texto += f"  {i}. {nombre} ({tg.get('total', 0)})\n"

    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- COMANDO PRINCIPAL WSP ---
@dp.message(Command("wsp"))
@dp.message(Command("whatsapp"))
async def cmd_wsp(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_status()
    if r.get("ok"):
        estado = "🟢 Conectado" if r["status"] == "conectado" else "🔴 Desconectado"
        numero = r.get("bot_number", "---")
    else:
        estado = "⚠ Sin conexión al bot WSP"
        numero = "---"

    texto = (
        f"📱 CONTROL WHATSAPP\n\n"
        f"Estado: {estado}\n"
        f"Número bot: {numero}\n\n"
        f"Controla tu bot de WhatsApp desde aquí:"
    )
    botones = [
        [InlineKeyboardButton(text="👤 Cuentas WSP", callback_data="wsp_cuentas")],
        [InlineKeyboardButton(text="🌐 Grupos WSP", callback_data="wsp_grupos"),
         InlineKeyboardButton(text="🔍 Detectar Grupos", callback_data="wsp_detectar")],
        [InlineKeyboardButton(text="📝 Mensajes", callback_data="wsp_mensajes")],
        [InlineKeyboardButton(text="📤 Enviar Único", callback_data="wsp_envio_unico"),
         InlineKeyboardButton(text="⏰ Programados", callback_data="wsp_programados")],
        [InlineKeyboardButton(text="📋 Campañas WSP", callback_data="wsp_campanas")],
        [InlineKeyboardButton(text="🚀 Iniciar campaña", callback_data="wsp_iniciar"),
         InlineKeyboardButton(text="🛑 Detener", callback_data="wsp_detener")],
        [InlineKeyboardButton(text="📨 Envío Personal", callback_data="wsp_personal"),
         InlineKeyboardButton(text="👥 Envío a Miembros", callback_data="wsp_envio_miembros")],
        [InlineKeyboardButton(text="⚙ Config Envío", callback_data="wsp_config"),
         InlineKeyboardButton(text="🚫 Lista Negra", callback_data="wsp_listanegra")],
        [InlineKeyboardButton(text="🤖 Auto-Responder", callback_data="wsp_autoresponder")],
        [InlineKeyboardButton(text="💬 Envío Interactivo", callback_data="wsp_interactivo")],
        [InlineKeyboardButton(text="📊 Historial WSP", callback_data="wsp_historial"),
         InlineKeyboardButton(text="📈 Stats Grupos", callback_data="wsp_stats")],
        [InlineKeyboardButton(text="📈 Dashboard WSP", callback_data="wsp_dashboard")],
        [InlineKeyboardButton(text="💾 Backup WSP", callback_data="wsp_backup"),
         InlineKeyboardButton(text="🔐 Sesiones WSP", callback_data="wsp_sesiones")],
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="👑 Membresía WSP", callback_data="wsp_membresia")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await msg.answer(texto, reply_markup=kb)


# --- MEMBRESIA WSP ---
@dp.callback_query(F.data == "wsp_membresia")
async def cb_wsp_membresia(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    if not es_admin(call.from_user.id):
        await call.answer("Solo admin", show_alert=True)
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_usuarios_todos()
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error')}", reply_markup=kb)
        await safe_answer(call)
        return

    usuarios = r.get("usuarios", [])
    texto = f"👑 MEMBRESÍAS WHATSAPP ({len(usuarios)}):\n\n"
    if usuarios:
        for i, u in enumerate(usuarios[:20], 1):
            estado = "✅" if u.get("activo") else "❌"
            plan = u.get("plan", "sin_plan")
            nombre = u.get("nombre", "?")
            wsp_id = u.get("wsp_id", "?")
            if len(wsp_id) > 20:
                wsp_id = wsp_id[:20] + "..."
            texto += f"{i}. {estado} {nombre} | {plan} | {wsp_id}\n"
            if u.get("fecha_expira"):
                texto += f"   Expira: {u['fecha_expira']}\n"
    else:
        texto += "(sin usuarios)\n"

    texto += "\n/wspactivar ID dias — Activar membresía\n/wspdesactivar ID — Desactivar"

    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"

    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


@dp.message(Command("wspactivar"))
async def cmd_wsp_activar(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    if not es_admin(msg.from_user.id):
        return await msg.answer("❌ Solo admin puede activar membresías WSP.")
    args = command.args
    if not args:
        return await msg.answer(
            "Uso: /wspactivar ID dias\n\n"
            "Ejemplo: /wspactivar 51987654321 30\n"
            "Ejemplo: /wspactivar 51987654321@s.whatsapp.net 7\n\n"
            "Usa /wspmembresia para ver los IDs."
        )
    parts = args.strip().split()
    if len(parts) < 2:
        return await msg.answer("❌ Faltan parámetros.\nUso: /wspactivar ID dias")
    wsp_id = parts[0]
    try:
        dias = int(parts[1])
    except ValueError:
        return await msg.answer("❌ Los días deben ser un número.\nUso: /wspactivar ID 30")

    import wsp_bridge as wsp
    r = await wsp.wsp_activar(wsp_id, dias)
    if r.get("ok"):
        plan = r.get("plan", "?")
        nombre = r.get("nombre", "?")
        await msg.answer(
            f"✅ Membresía WSP activada!\n\n"
            f"👤 {nombre}\n"
            f"📋 Plan: {plan}\n"
            f"📅 Días: {dias}"
        )
    else:
        await msg.answer(f"❌ Error: {r.get('error')}")


@dp.message(Command("wspdesactivar"))
async def cmd_wsp_desactivar(msg: types.Message, command: CommandObject):
    if not await verificar_membresia(msg):
        return
    if not es_admin(msg.from_user.id):
        return await msg.answer("❌ Solo admin puede desactivar membresías WSP.")
    args = command.args
    if not args:
        return await msg.answer("Uso: /wspdesactivar ID\nEjemplo: /wspdesactivar 51987654321")

    import wsp_bridge as wsp
    r = await wsp.wsp_desactivar(args.strip())
    if r.get("ok"):
        await msg.answer(f"🚫 Membresía WSP desactivada: {args.strip()}")
    else:
        await msg.answer(f"❌ Error: {r.get('error')}")


@dp.message(Command("wspmembresia"))
async def cmd_wsp_membresia(msg: types.Message):
    if not await verificar_membresia(msg):
        return
    if not es_admin(msg.from_user.id):
        return await msg.answer("❌ Solo admin.")

    import wsp_bridge as wsp
    r = await wsp.wsp_usuarios_todos()
    if not r.get("ok"):
        return await msg.answer(f"❌ Error: {r.get('error')}")

    usuarios = r.get("usuarios", [])
    texto = f"👑 MEMBRESÍAS WHATSAPP ({len(usuarios)}):\n\n"
    if usuarios:
        for i, u in enumerate(usuarios[:20], 1):
            estado = "✅" if u.get("activo") else "❌"
            plan = u.get("plan", "sin_plan")
            nombre = u.get("nombre", "?")
            wsp_id = u.get("wsp_id", "?")
            texto += f"{i}. {estado} {nombre} | {plan}\n"
            texto += f"   ID: {wsp_id}\n"
            if u.get("fecha_expira"):
                texto += f"   Expira: {u['fecha_expira']}\n"
    else:
        texto += "(sin usuarios)\n"

    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"
    await msg.answer(texto)


# --- DETECTAR GRUPOS WSP ---
@dp.callback_query(F.data == "wsp_detectar")
async def cb_wsp_detectar(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    await safe_answer(call)
    import wsp_bridge as wsp
    r = await wsp.wsp_sesiones(call.from_user.id)
    if not r.get("ok") or not r.get("sesiones"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, "❌ No tienes cuentas WSP vinculadas.\nVincula una cuenta primero desde 👤 Cuentas WSP.", reply_markup=kb)
        return
    sesiones = r["sesiones"]
    if len(sesiones) == 1:
        # Solo una cuenta, detectar directo
        await cb_wsp_detectar_cuenta(call, cuenta_override=sesiones[0]['nombre'])
        return
    texto = "🔍 DETECTAR GRUPOS WSP\n\nElige la cuenta para detectar grupos:\n"
    botones = []
    for s in sesiones:
        botones.append([InlineKeyboardButton(text=f"📱 {s['nombre']} — {s.get('telefono', '?')}", callback_data=f"wsp_detectar_cuenta:{s['nombre']}")])
    botones.append([InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")])
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)

@dp.callback_query(F.data.startswith("wsp_detectar_cuenta:"))
async def cb_wsp_detectar_cuenta(call: types.CallbackQuery, cuenta_override=None):
    if not await verificar_membresia_cb(call):
        return
    await safe_answer(call)
    cuenta = cuenta_override or call.data.split(":", 1)[1]
    import wsp_bridge as wsp
    await safe_edit(call.message, f"🔍 Detectando grupos de la cuenta '{cuenta}'...\nEsto puede tardar unos segundos.")
    r = await wsp.wsp_detectar_grupos(call.from_user.id, cuenta)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error', 'sin conexión')}", reply_markup=kb)
        return
    grupos = r.get("grupos", [])
    texto = f"🔍 GRUPOS WSP de '{cuenta}' ({len(grupos)}):\n\n"
    if grupos:
        for i, g in enumerate(grupos[:30], 1):
            nombre = g.get("subject", g.get("name", "Sin nombre"))
            miembros = g.get("size", "?")
            texto += f"{i}. {nombre} ({miembros} miembros)\n"
    else:
        texto += "(no se detectaron grupos)\n"
    texto += "\nUsa /wspgrupo link para agregar un grupo."
    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"
    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)


# --- MENSAJES WSP ---
@dp.callback_query(F.data == "wsp_mensajes")
async def cb_wsp_mensajes(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_mensajes(call.from_user.id)
    if not r.get("ok"):
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error', 'sin conexión')}", reply_markup=kb)
        await safe_answer(call)
        return
    mensajes = r.get("mensajes", [])
    texto = f"📝 MENSAJES/PLANTILLAS WSP ({len(mensajes)}):\n\n"
    if mensajes:
        for m in mensajes[:15]:
            nombre = m.get("nombre", "?")
            msg_prev = (m.get("mensaje", "") or "")[:50]
            texto += f"• [{m.get('id','')}] {nombre}: {msg_prev}...\n"
    else:
        texto += "(sin mensajes/plantillas)\n"
    texto += "\nGestiona desde el Panel Web o con comandos."
    botones = [
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- ENVIO UNICO WSP ---
@dp.callback_query(F.data == "wsp_envio_unico")
async def cb_wsp_envio_unico(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto = (
        "📤 ENVÍO ÚNICO WSP\n\n"
        "Envía un mensaje a un grupo específico.\n\n"
        "Usa: /wspenvio ID_CAMPANA\n"
        "Esto enviará la campaña a sus grupos asignados una sola vez."
    )
    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- PROGRAMADOS WSP ---
@dp.callback_query(F.data == "wsp_programados")
async def cb_wsp_programados(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_programados(call.from_user.id)
    if r.get("ok"):
        progs = r.get("programados", [])
        texto = f"⏰ PROGRAMADOS WSP ({len(progs)}):\n\n"
        if progs:
            for p in progs[:10]:
                nombre = p.get("mensaje_nombre", f"msg#{p.get('mensaje_id','?')}")
                hora = p.get("hora", "?")
                activo = "✅" if p.get("activo") else "⏸"
                rep = "🔄" if p.get("repetir") else "1x"
                texto += f"{activo} {nombre} — {hora} {rep}\n"
        else:
            texto += "(sin envíos programados)\n"
        texto += "\nGestiona desde el Panel Web."
    else:
        texto = "⏰ PROGRAMADOS WSP\n\nGestiona desde el Panel Web."
    botones = [
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- ENVIO A MIEMBROS WSP ---
@dp.callback_query(F.data == "wsp_envio_miembros")
async def cb_wsp_envio_miembros(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto = (
        "👥 ENVÍO A MIEMBROS WSP\n\n"
        "Envía mensajes directos a los miembros de un grupo.\n\n"
        "Usa: /wsppersonal mensaje\n"
        "Esto enviará el mensaje a todos tus chats personales."
    )
    botones = [
        [InlineKeyboardButton(text="📨 Envío Personal", callback_data="wsp_personal")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- CONFIG ENVIO WSP ---
@dp.callback_query(F.data == "wsp_config")
async def cb_wsp_config(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_envio_config(call.from_user.id)
    if r.get("ok"):
        cfg = r.get("config", {})
        hr = r.get("horario", {})
        texto = (
            "⚙ CONFIG ENVÍO WSP\n\n"
            f"⏱ Delay: {cfg.get('delay_seg', 10)} seg\n"
            f"📦 Lote: {cfg.get('lote_tamano', 0)} msgs\n"
            f"⏸ Pausa lotes: {cfg.get('lote_pausa_seg', 30)} seg\n"
            f"🕐 Horario: {hr.get('hora_inicio', 0)}:00 - {hr.get('hora_fin', 24)}:00\n\n"
            "Modifica desde el Panel Web."
        )
    else:
        texto = "⚙ CONFIG ENVÍO WSP\n\nConfigura desde el Panel Web."
    botones = [
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- LISTA NEGRA WSP ---
@dp.callback_query(F.data == "wsp_listanegra")
async def cb_wsp_listanegra(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_lista_negra(call.from_user.id)
    if r.get("ok"):
        lista = r.get("lista", [])
        texto = f"🚫 LISTA NEGRA WSP ({len(lista)}):\n\n"
        if lista:
            for i, x in enumerate(lista[:20], 1):
                texto += f"{i}. {x.get('numero', x.get('grupo_link', '?'))}\n"
        else:
            texto += "(lista vacía)\n"
        texto += "\nGestiona desde el Panel Web."
    else:
        texto = "🚫 LISTA NEGRA WSP\n\nGestiona desde el Panel Web."
    botones = [
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- AUTO-RESPONDER WSP ---
@dp.callback_query(F.data == "wsp_autoresponder")
async def cb_wsp_autoresponder(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r = await wsp.wsp_auto_respuestas(call.from_user.id)
    if r.get("ok"):
        reglas = r.get("reglas", [])
        texto = f"🤖 AUTO-RESPONDER WSP ({len(reglas)} reglas):\n\n"
        if reglas:
            for i, x in enumerate(reglas[:15], 1):
                palabra = x.get("palabra", "?")
                resp = (x.get("respuesta", "") or "")[:40]
                texto += f"{i}. '{palabra}' → {resp}...\n"
        else:
            texto += "(sin reglas configuradas)\n"
        texto += "\nGestiona desde el Panel Web."
    else:
        texto = "🤖 AUTO-RESPONDER WSP\n\nConfigura desde el Panel Web."
    botones = [
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- ENVIO INTERACTIVO WSP ---
@dp.callback_query(F.data == "wsp_interactivo")
async def cb_wsp_interactivo(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    texto = (
        "💬 ENVÍO INTERACTIVO WSP\n\n"
        "Envía mensajes y recibe respuestas en tiempo real.\n\n"
        "Funcionalidad disponible desde el Panel Web."
    )
    botones = [
        [InlineKeyboardButton(text="🌐 Ir al Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- STATS GRUPOS WSP ---
@dp.callback_query(F.data == "wsp_stats")
async def cb_wsp_stats(call: types.CallbackQuery):
    if not await verificar_membresia_cb(call):
        return
    import wsp_bridge as wsp
    r_dash = await wsp.wsp_dashboard(call.from_user.id)
    r_stats = await wsp.wsp_grupo_stats(call.from_user.id)
    d = r_dash.get("dashboard", r_dash) if r_dash.get("ok") else {}
    texto = (
        f"📈 STATS WSP\n\n"
        f"🌐 Grupos: {d.get('grupos', 0)}\n"
        f"👤 Cuentas: {d.get('cuentas', d.get('sesiones', 0))}\n"
        f"📋 Campañas: {d.get('campanas', 0)}\n"
        f"📤 Enviados: {d.get('enviados', d.get('totalEnviados', 0))}\n"
        f"❌ Errores: {d.get('errores', d.get('totalErrores', 0))}\n"
    )
    if r_stats.get("ok"):
        stats = r_stats.get("stats", [])
        if stats:
            texto += "\n📊 Top Grupos:\n"
            for s in stats[:5]:
                grupo = (s.get("grupo_link", "?"))[:30]
                tasa = s.get("tasa_exito", 0)
                texto += f"  • {grupo} ({tasa}%)\n"
    botones = [
        [InlineKeyboardButton(text="🌐 Panel Web", callback_data="wsp_panelweb")],
        [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- PANEL WEB ---
@dp.callback_query(F.data == "wsp_panelweb")
async def cb_wsp_panelweb(call: types.CallbackQuery):
    texto = (
        "🌐 PANEL WEB\n\n"
        "Accede al panel web completo en:\n"
        "https://jdbotspam.duckdns.org\n\n"
        f"Tu ID: {call.from_user.id}\n\n"
        "Desde el panel puedes gestionar todo:\n"
        "• Cuentas, Grupos, Campañas\n"
        "• Iniciar/Detener spam\n"
        "• Config, Lista Negra, Auto-Responder\n"
        "• Historial y Estadísticas"
    )
    botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)


# --- COMANDOS WSP RAPIDOS ---
@dp.message(Command("cmdwsp"))
async def cmd_cmdwsp(msg: types.Message):
    texto = (
        "📱 COMANDOS WHATSAPP\n\n"
        "/wsp — Panel de control WSP\n"
        "/vincularwsp nombre — Vincular cuenta WSP\n"
        "/wspgrupo link1 link2 — Agregar grupos WSP\n"
        "/wspcampana nombre | mensaje — Crear campaña\n"
        "/wspstart ID — Iniciar campaña\n"
        "/wspstop ID — Detener campaña\n"
        "/wsppersonal mensaje — Envio a chats personales\n"
        "/wspcancelarpersonal — Cancelar envio personal\n"
        "/wspactivar ID dias — Activar membresía WSP\n"
        "/wspdesactivar ID — Desactivar membresía WSP\n"
        "/wspmembresia — Ver membresías WSP\n"
        "/cmdwsp — Esta lista\n"
    )
    await msg.answer(texto)




@dp.callback_query(F.data.startswith("wsp_check_link_"))
async def cb_wsp_check_link(call: types.CallbackQuery):
    """Verifica si la cuenta WSP ya se vinculó."""
    if not await verificar_membresia_cb(call):
        return
    nombre = call.data.replace("wsp_check_link_", "")
    import wsp_bridge as wsp
    r = await wsp.wsp_sesiones(call.from_user.id)
    if r.get("ok"):
        sesiones = r.get("sesiones", [])
        encontrada = any(s.get("nombre") == nombre for s in sesiones)
        if encontrada:
            botones = [[InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")]]
            kb = InlineKeyboardMarkup(inline_keyboard=botones)
            await safe_edit(call.message, f"✅ Cuenta WSP '{nombre}' vinculada exitosamente!", reply_markup=kb)
        else:
            botones = [
                [InlineKeyboardButton(text="🔄 Verificar de nuevo", callback_data=f"wsp_check_link_{nombre}")],
                [InlineKeyboardButton(text="🔙 Volver a WSP", callback_data="sec_wsp")],
            ]
            kb = InlineKeyboardMarkup(inline_keyboard=botones)
            await safe_edit(call.message, f"⏳ Cuenta '{nombre}' aún no vinculada.\nEscanea el QR y luego presiona verificar.", reply_markup=kb)
    else:
        botones = [[InlineKeyboardButton(text="🔙 Volver", callback_data="sec_wsp")]]
        kb = InlineKeyboardMarkup(inline_keyboard=botones)
        await safe_edit(call.message, f"❌ Error: {r.get('error')}", reply_markup=kb)
    await safe_answer(call)


# ╔══════════════════════════════════════╗
# ║    SECCION: ADMIN                   ║
# ╚══════════════════════════════════════╝
@dp.callback_query(F.data == "sec_admin")
async def cb_sec_admin(call: types.CallbackQuery):
    if not es_admin(call.from_user.id):
        await call.answer("⛔ Sin permiso.", show_alert=True)
        return
    usuarios = await db.get_todos_usuarios()
    total   = len(usuarios)
    activos = sum(1 for u in usuarios if u["activo"])
    camp_act = len(tareas_activas)
    texto = (
        "👑 PANEL ADMIN\n\n"
        f"👥 Usuarios: {total} ({activos} activos)\n"
        f"🚀 Campanas activas: {camp_act}\n\n"
        "Comandos admin:\n"
        "/activar [id] [dias]\n"
        "/desactivar [id]\n"
        "/ban [id]\n"
        "/usuarios\n"
        "/stats\n"
        "/grupo [id] [limite]"
    )
    botones = [
        [InlineKeyboardButton(text="👥 Ver usuarios", callback_data="adm_usuarios")],
        [InlineKeyboardButton(text="📊 Stats globales", callback_data="adm_stats")],
        kb_volver(),
    ]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "adm_usuarios")
async def cb_adm_usuarios(call: types.CallbackQuery):
    if not es_admin(call.from_user.id):
        return
    usuarios = await db.get_todos_usuarios()
    if not usuarios:
        texto = "No hay usuarios."
    else:
        texto = "👥 USUARIOS:\n\n"
        for u in usuarios[:30]:
            estado = "✅" if u["activo"] else "❌"
            texto += f"{estado} {u['telegram_id']} @{u['username']} | {u['plan']}\n"
        if len(usuarios) > 30:
            texto += f"\n... y {len(usuarios) - 30} mas"
    if len(texto) > 4000:
        texto = texto[:4000] + "\n(truncado)"
    botones = [[InlineKeyboardButton(text="🔙 Volver a Admin", callback_data="sec_admin")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

@dp.callback_query(F.data == "adm_stats")
async def cb_adm_stats(call: types.CallbackQuery):
    if not es_admin(call.from_user.id):
        return
    usuarios = await db.get_todos_usuarios()
    total     = len(usuarios)
    activos   = sum(1 for u in usuarios if u["activo"])
    camp_act  = len(tareas_activas)
    resp_act  = len(responder_activos)
    texto = (
        f"📊 STATS GLOBALES\n\n"
        f"👥 Usuarios: {total}\n"
        f"✅ Activos: {activos}\n"
        f"❌ Inactivos: {total - activos}\n"
        f"🚀 Campanas corriendo: {camp_act}\n"
        f"🤖 Responders activos: {resp_act}\n\n"
        f"🕐 {ahora_peru().strftime('%d/%m/%Y %H:%M')}"
    )
    botones = [[InlineKeyboardButton(text="🔙 Volver a Admin", callback_data="sec_admin")]]
    kb = InlineKeyboardMarkup(inline_keyboard=botones)
    await safe_edit(call.message, texto, reply_markup=kb)
    await safe_answer(call)

# Admin commands (text)
@dp.message(Command("activar"))
async def cmd_activar(msg: types.Message):
    if not es_admin(msg.from_user.id):
        return await msg.answer("⛔ Sin permiso.")
    partes = msg.text.split()
    if len(partes) != 3:
        return await msg.answer("Uso: /activar <user_id> <dias>")
    try:
        uid  = int(partes[1])
        dias = int(partes[2])
        await db.activar_membresia(uid, dias)
        plan_nombre = "Diario" if dias == 1 else "Semanal" if dias == 7 else "Mensual"
        asyncio.create_task(sync_membresia_wsp(uid, dias, plan_nombre.lower()))
        await msg.answer(f"✅ Membresia activada.\n👤 {uid}\n📦 {plan_nombre}\n⏳ {dias} dias")
        try:
            await bot.send_message(uid,
                f"🎉 Tu membresia fue activada!\n📦 Plan: {plan_nombre}\n⏳ {dias} dia(s)\n\nUsa /cmds para ver la guia.")
        except Exception:
            await msg.answer("⚠ No se pudo notificar al usuario.")
    except ValueError:
        await msg.answer("❌ user_id y dias deben ser numeros.")
    except Exception as e:
        await msg.answer(f"❌ Error: {e}")

@dp.message(Command("desactivar"))
async def cmd_desactivar(msg: types.Message):
    if not es_admin(msg.from_user.id):
        return
    partes = msg.text.split()
    if len(partes) != 2:
        return await msg.answer("Uso: /desactivar <user_id>")
    try:
        uid = int(partes[1])
    except ValueError:
        return await msg.answer("❌ El user_id debe ser un numero.")
    await db.desactivar_membresia(uid)
    # Sync deactivation to WSP
    asyncio.create_task(sync_membresia_wsp(uid, 0, "desactivado"))
    await msg.answer(f"✅ Membresia de {uid} desactivada.")

@dp.message(Command("ban"))
async def cmd_ban(msg: types.Message):
    if not es_admin(msg.from_user.id):
        return
    partes = msg.text.split()
    if len(partes) != 2:
        return await msg.answer("Uso: /ban <user_id>")
    try:
        uid = int(partes[1])
    except ValueError:
        return await msg.answer("❌ El user_id debe ser un numero.")
    await db.ban_usuario(uid)
    # Sync ban to WSP
    asyncio.create_task(sync_membresia_wsp(uid, 0, "desactivado"))
    await msg.answer(f"🔨 Usuario {uid} baneado.")
    try:
        await bot.send_message(uid, "⛔ Tu acceso al bot ha sido suspendido.")
    except Exception:
        pass

@dp.message(Command("usuarios"))
async def cmd_usuarios(msg: types.Message):
    if not es_admin(msg.from_user.id):
        return
    usuarios = await db.get_todos_usuarios()
    if not usuarios:
        return await msg.answer("No hay usuarios registrados.")
    texto = "👥 USUARIOS:\n\n"
    for u in usuarios:
        estado = "✅" if u["activo"] else "❌"
        texto += f"{estado} {u['telegram_id']} @{u['username']} | {u['plan']} | exp: {u['fecha_expira'] or 'N/A'}\n"
    if len(texto) > 4000:
        for i in range(0, len(texto), 4000):
            await msg.answer(texto[i:i+4000])
    else:
        await msg.answer(texto)

@dp.message(Command("stats"))
async def cmd_stats_admin(msg: types.Message):
    if not es_admin(msg.from_user.id):
        return
    usuarios  = await db.get_todos_usuarios()
    total     = len(usuarios)
    activos   = sum(1 for u in usuarios if u["activo"])
    camp_act  = len(tareas_activas)
    await msg.answer(
        f"📊 STATS GLOBALES\n\n"
        f"👥 Usuarios: {total}\n"
        f"✅ Activos: {activos}\n"
        f"❌ Inactivos: {total - activos}\n"
        f"🚀 Campanas activas: {camp_act}\n\n"
        f"🕐 {ahora_peru().strftime('%d/%m/%Y %H:%M')}"
    )

@dp.message(Command("grupo"))
async def cmd_grupo_admin(msg: types.Message, command: CommandObject):
    if not es_admin(msg.from_user.id):
        return await msg.answer("⛔ Solo admin.")
    if not command.args:
        return await msg.answer("Uso: /grupo <user_id> <limite>\nEj: /grupo 123456789 30")
    partes = command.args.split()
    if len(partes) != 2:
        return await msg.answer("Formato: /grupo <user_id> <limite>")
    try:
        target_id = int(partes[0])
        limite = int(partes[1])
    except ValueError:
        return await msg.answer("❌ Deben ser numeros.")
    if limite < 1 or limite > 500:
        return await msg.answer("❌ Limite entre 1 y 500.")
    await db.set_max_grupos(target_id, limite)
    await msg.answer(f"✅ Limite actualizado:\n👤 {target_id}\n🌐 Max grupos: {limite}")

# ╔══════════════════════════════════════╗
# ║    RECUPERAR CONTRASENA             ║
# ╚══════════════════════════════════════╝
@dp.message(Command("recuperpass"))
async def cmd_recuperpass(msg: types.Message, state: FSMContext):
    tid = str(msg.from_user.id)
    try:
        async with aiohttp.ClientSession() as session:
            r = await session.post(
                "http://127.0.0.1:3000/api/panel_recuperar_solicitar",
                json={"telegram_id": tid},
                timeout=aiohttp.ClientTimeout(total=10)
            )
            data = await r.json()
    except Exception:
        return await msg.answer("❌ No se pudo conectar al servidor. Intenta de nuevo.")
    if not data.get("ok"):
        error = data.get("error", "Error desconocido")
        return await msg.answer(f"❌ {error}")
    await msg.answer(
        "🔐 <b>Recuperar Contrasena</b>\n\n"
        "Se ha enviado un codigo a este chat.\n"
        "Tienes <b>2 opciones</b>:\n\n"
        "1️⃣ <b>Via Web:</b> Ingresa el codigo en la pagina web de recuperacion.\n\n"
        "2️⃣ <b>Via Bot:</b> Escribe tu nueva contrasena aqui y se cambiara directamente.\n\n"
        "Escribe tu <b>nueva contrasena</b> ahora o usa el codigo en la web:",
        parse_mode="HTML"
    )
    await state.set_state(RecuperarState.esperando_nueva_password)
    await state.update_data(telegram_id=tid)

@dp.message(RecuperarState.esperando_nueva_password)
async def recibir_nueva_password(msg: types.Message, state: FSMContext):
    if not msg.text:
        return await msg.answer("❌ Por favor envia tu nueva contrasena como texto.")
    new_pass = msg.text.strip()
    if len(new_pass) < 4:
        return await msg.answer("❌ La contrasena debe tener minimo 4 caracteres. Intenta de nuevo:")
    data = await state.get_data()
    tid = data.get("telegram_id", str(msg.from_user.id))
    try:
        import aiosqlite as _aiosqlite
        async with _aiosqlite.connect("wsp_titan.db", timeout=10) as wdb:
            wdb.row_factory = _aiosqlite.Row
            async with wdb.execute(
                "SELECT code FROM recovery_codes WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 1",
                (tid,)
            ) as cur:
                row = await cur.fetchone()
            if not row:
                await state.clear()
                return await msg.answer("❌ No hay codigo de recuperacion activo. Usa /recuperpass de nuevo.")
            code = row["code"]
        async with aiohttp.ClientSession() as session:
            r = await session.post(
                "http://127.0.0.1:3000/api/panel_recuperar_reset",
                json={"telegram_id": tid, "code": code, "new_password": new_pass},
                timeout=aiohttp.ClientTimeout(total=10)
            )
            result = await r.json()
    except Exception as e:
        await state.clear()
        return await msg.answer(f"❌ Error al cambiar contrasena: {e}")
    await state.clear()
    if result.get("ok"):
        await msg.answer(
            "✅ <b>Contrasena cambiada exitosamente!</b>\n\n"
            "Ya puedes iniciar sesion en el panel web con tu nueva contrasena.",
            parse_mode="HTML",
            reply_markup=kb_menu_principal(msg.from_user.id)
        )
    else:
        await msg.answer(f"❌ {result.get('error', 'Error al cambiar contrasena')}")

# ╔══════════════════════════════════════╗
# ║    MAIN                             ║
# ╚══════════════════════════════════════╝
async def main():
    await db.init_db()
    os.makedirs("sessions", exist_ok=True)
    os.makedirs("media", exist_ok=True)
    os.makedirs("logs", exist_ok=True)
    # Resetear campañas que quedaron como "activas" en DB por un crash anterior
    try:
        all_users = await db.get_all_users_with_active_campaigns()
        for uid, cid in all_users:
            await db.set_campana_activa(cid, False)
            logger.info(f"Reset campaña {cid} (user {uid}) que quedó activa por crash.")
    except Exception:
        pass
    # Iniciar panel web
    web_panel.set_bot_reference(bot)
    await web_panel.start_web_panel()
    logger.info("🚀 Bot de Spam J&D v2.0 iniciado correctamente.")
    logger.info(f"🌐 TG API backend en puerto {web_panel.WEB_PORT} (panel_server.js lo proxea)")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
