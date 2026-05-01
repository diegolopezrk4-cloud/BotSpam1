import asyncio
import random
import re
import os
import logging
from datetime import datetime, timezone, timedelta
from telethon import TelegramClient, errors, events

# Zona horaria de Peru (UTC-5)
PERU_TZ = timezone(timedelta(hours=-5))
def ahora_peru():
    return datetime.now(PERU_TZ)
from db import (get_campana_by_id, get_grupos_campana, get_sesiones_campana,
                actualizar_stats_campana, set_campana_activa, get_campana_config,
                get_all_responder_activos, get_keywords, get_keywords_full, get_sesiones,
                registrar_envio, registrar_respuesta, get_grupos,
                eliminar_grupo_por_link)

# Caracteres invisibles para variar el mensaje y evitar detección
CHARS_INVISIBLES = [
    "\u200b",  # zero-width space
    "\u200c",  # zero-width non-joiner
    "\u200d",  # zero-width joiner
    "\ufeff",  # zero-width no-break space
]

# Máximo de caracteres para considerar un mensaje como "pregunta corta"
MAX_CHARS_RESPONDER = 120

logger = logging.getLogger("JDSpamMotor")

API_ID   = int(os.environ.get("API_ID", "35451933"))
API_HASH = os.environ.get("API_HASH", "2070761744260118720b34e6bf20f2eb")

# Diccionario global: campana_id -> Task asyncio
tareas_activas = {}

# Diccionario global: user_id -> Task del auto-responder
responder_activos = {}

# ─────────────────────────────────────────
#   UTILIDADES
# ─────────────────────────────────────────
def get_session_path(user_id, nombre):
    """Devuelve la ruta del archivo de sesión Telethon. Sanitiza nombre para prevenir path traversal."""
    # Sanitize: remove path separators and parent directory references
    safe_nombre = re.sub(r'[/\\]', '', nombre).replace('..', '')
    if not safe_nombre:
        raise ValueError("Nombre de sesion invalido")
    folder = os.path.abspath(f"sessions/{user_id}")
    os.makedirs(folder, exist_ok=True)
    full_path = os.path.join(folder, safe_nombre)
    # Verify the resolved path is within the sessions directory
    if not os.path.abspath(full_path).startswith(folder):
        raise ValueError("Path traversal detectado")
    return full_path

def variar_mensaje(msg_original):
    """Agrega caracteres invisibles aleatorios al mensaje para evitar detección de spam."""
    palabras = msg_original.split(" ")
    resultado = []
    for palabra in palabras:
        resultado.append(palabra)
        # 30% de probabilidad de agregar un char invisible entre palabras
        if random.random() < 0.3:
            resultado.append(random.choice(CHARS_INVISIBLES))
    # Agregar char invisible al inicio o final
    texto = " ".join(resultado)
    if random.random() < 0.5:
        texto = random.choice(CHARS_INVISIBLES) + texto
    else:
        texto = texto + random.choice(CHARS_INVISIBLES)
    return texto

def es_mensaje_spam(texto):
    """Detecta si un mensaje es de otro spammer/bot (mensaje largo, muchos links, etc.)."""
    if len(texto) > MAX_CHARS_RESPONDER:
        return True
    # Contar links
    links = len(re.findall(r'https?://|t\.me/|@\w{5,}', texto))
    if links >= 2:
        return True
    # Contar emojis (patrón aproximado para emojis comunes)
    emojis = len(re.findall(r'[🔴🟢🟡⚡💰💳🎁🎉✅❌⭐🔥💎🏆🎯📱📲💻🖥️🎬🎮📺🔑💡🚀🛡️👑💯🆓🏷️💲💵]', texto))
    if emojis >= 4:
        return True
    # Detectar formato de precio (S/, $, USD)
    if re.search(r'[sS]/\s*\d|USD\s*\d|\$\s*\d', texto):
        return True
    # Detectar múltiples líneas (los spammers escriben párrafos)
    lineas = texto.strip().split("\n")
    if len(lineas) >= 4:
        return True
    return False

# ─────────────────────────────────────────
#   WORKER DE CAMPAÑA (MOTOR DE ENVÍO)
# ─────────────────────────────────────────
async def worker_campana(campana_id, user_id, bot_notificar=None):
    """Worker principal que envía mensajes en bucle a los grupos con rotación de cuentas."""
    campana = await get_campana_by_id(campana_id)
    if not campana:
        logger.error(f"Campaña {campana_id} no encontrada.")
        return

    nombres_sesiones = await get_sesiones_campana(campana_id)
    grupos = await get_grupos_campana(campana_id)
    config = await get_campana_config(campana_id)
    intervalo_min = config.get("intervalo_min", 30)
    intervalo_max = config.get("intervalo_max", 60)

    if not nombres_sesiones:
        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id,
                    "⚠ La campaña no tiene cuentas asignadas.\n"
                    "Agrega cuentas con /cuentas y crea una nueva campaña.")
            except Exception:
                pass
        return

    if not grupos:
        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id,
                    "⚠ La campaña no tiene grupos asignados.\n"
                    "Agrega grupos con /grupos y crea una nueva campaña.")
            except Exception:
                pass
        return

    # Conectar las cuentas de Telethon
    clientes = {}
    cuentas_fallidas = []
    for nombre in nombres_sesiones:
        path = get_session_path(user_id, nombre)
        try:
            c = TelegramClient(path, API_ID, API_HASH)
            await c.connect()
            if await c.is_user_authorized():
                clientes[nombre] = c
                logger.info(f"Cuenta '{nombre}' conectada OK.")
            else:
                logger.warning(f"Cuenta '{nombre}' no autorizada.")
                cuentas_fallidas.append(nombre)
                await c.disconnect()
        except Exception as e:
            logger.error(f"Error conectando '{nombre}': {e}")
            cuentas_fallidas.append(nombre)

    if not clientes:
        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id,
                    "❌ No se pudo conectar ninguna cuenta.\n\n"
                    "Verifica que las cuentas estén vinculadas\n"
                    "correctamente con /cuentas")
            except Exception:
                pass
        return

    # Marcar campaña como activa
    await set_campana_activa(campana_id, True)

    # Lista de nombres para rotación
    nombres_rotacion = list(clientes.keys())

    info_msg = (
        f"🚀 Campaña '{campana['nombre']}' iniciada\n\n"
        f"👤 Cuentas: {len(clientes)} (rotación activa)\n"
        f"🌐 Grupos: {len(grupos)}\n"
        f"⏱ Intervalo: {intervalo_min}-{intervalo_max}s\n"
    )
    if cuentas_fallidas:
        info_msg += f"⚠ Fallidas: {', '.join(cuentas_fallidas)}\n"
    info_msg += f"\n🕐 Inicio: {ahora_peru().strftime('%d/%m/%Y %H:%M')}"

    if bot_notificar:
        try:
            await bot_notificar.send_message(user_id, info_msg)
        except Exception:
            pass

    enviados = 0
    errores = 0
    ronda = 0
    idx_cuenta = 0  # Índice para rotación

    # Cooldown por grupo: {grupo_link: timestamp_cuando_se_desbloquea}
    grupos_cooldown = {}
    # Grupos permanentemente bloqueados (sin permiso, baneado, privado)
    grupos_bloqueados = set()

    try:
        while True:
            ronda += 1
            logger.info(f"Campaña {campana_id} — Ronda #{ronda}")

            ahora = datetime.now().timestamp()
            grupos_saltados = 0

            for grupo in grupos:
                # Saltar grupos permanentemente bloqueados
                if grupo in grupos_bloqueados:
                    continue

                # Verificar cooldown del grupo
                if grupo in grupos_cooldown:
                    desbloqueo = grupos_cooldown[grupo]
                    if ahora < desbloqueo:
                        restante = int(desbloqueo - ahora)
                        logger.info(f"Grupo {grupo} en cooldown, faltan {restante}s. Saltando.")
                        grupos_saltados += 1
                        continue
                    else:
                        # Ya pasó el cooldown, remover
                        del grupos_cooldown[grupo]

                # Rotación de cuentas
                if not nombres_rotacion:
                    break

                nombre = nombres_rotacion[idx_cuenta % len(nombres_rotacion)]
                client = clientes.get(nombre)

                if not client:
                    nombres_rotacion = [n for n in nombres_rotacion if n in clientes]
                    if not nombres_rotacion:
                        break
                    nombre = nombres_rotacion[0]
                    client = clientes[nombre]

                # Verificar conexión y reconectar si es necesario (con backoff exponencial)
                try:
                    if not client.is_connected():
                        reconn_delay = 2
                        reconn_ok = False
                        for reconn_attempt in range(4):  # max 4 attempts: 2s, 4s, 8s, 16s
                            try:
                                logger.info(f"Cuenta '{nombre}' desconectada, reconectando (intento {reconn_attempt+1})...")
                                await client.connect()
                                if not await client.is_user_authorized():
                                    raise Exception("No autorizada tras reconectar")
                                logger.info(f"Cuenta '{nombre}' reconectada OK.")
                                reconn_ok = True
                                break
                            except Exception:
                                await asyncio.sleep(reconn_delay)
                                reconn_delay *= 2
                        if not reconn_ok:
                            raise Exception("Falló reconexión tras 4 intentos")
                except Exception as reconn_err:
                    logger.warning(f"Cuenta '{nombre}' no se pudo reconectar: {reconn_err}")
                    # Intentar recrear la sesion completa
                    try:
                        path = get_session_path(user_id, nombre)
                        new_client = TelegramClient(path, API_ID, API_HASH)
                        await new_client.connect()
                        if await new_client.is_user_authorized():
                            clientes[nombre] = new_client
                            client = new_client
                            logger.info(f"Cuenta '{nombre}' reconectada con nueva sesion.")
                        else:
                            raise Exception("No autorizada")
                    except Exception:
                        logger.warning(f"Cuenta '{nombre}' removida definitivamente.")
                        clientes.pop(nombre, None)
                        nombres_rotacion = [n for n in nombres_rotacion if n in clientes]
                        continue

                try:
                    ent = await client.get_entity(grupo)

                    # Recargar campaña para obtener mensaje actualizado
                    campana_actual = await get_campana_by_id(campana_id)
                    if not campana_actual:
                        logger.error(f"Campaña {campana_id} eliminada durante ejecución.")
                        return

                    msg_original = campana_actual['mensaje']
                    foto = campana_actual['foto_path']

                    # Anti-detección: variar el mensaje ligeramente
                    msg = variar_mensaje(msg_original)

                    if foto and os.path.exists(foto):
                        if len(msg) <= 1024:
                            await client.send_file(ent, foto, caption=msg)
                        else:
                            await client.send_file(ent, foto)
                            await client.send_message(ent, msg)
                    else:
                        await client.send_message(ent, msg)

                    enviados += 1
                    await actualizar_stats_campana(campana_id, 1, 0)
                    await registrar_envio(user_id, campana_id, grupo, "enviado")
                    logger.info(f"[{nombre}] Enviado a {grupo} (total: {enviados})")

                    # Avanzar rotación
                    idx_cuenta += 1

                    # Recargar config por si el usuario cambió el intervalo
                    config = await get_campana_config(campana_id)
                    intervalo_min = config.get("intervalo_min", 30)
                    intervalo_max = config.get("intervalo_max", 60)
                    espera = random.randint(intervalo_min, max(intervalo_min, intervalo_max))
                    await asyncio.sleep(espera)

                except errors.SlowModeWaitError as e:
                    # Grupo tiene restricción de envío (slowmode)
                    segundos = e.seconds
                    grupos_cooldown[grupo] = datetime.now().timestamp() + segundos
                    await registrar_envio(user_id, campana_id, grupo, f"slowmode_{segundos}s")
                    logger.info(f"[{nombre}] Grupo {grupo} tiene slowmode: {segundos}s.")
                    if bot_notificar:
                        try:
                            if segundos >= 60:
                                tiempo = f"{segundos // 60} minuto(s)"
                            else:
                                tiempo = f"{segundos} segundo(s)"
                            await bot_notificar.send_message(user_id,
                                f"⏱ SLOWMODE en {grupo}\n"
                                f"Restriccion: {tiempo}\n"
                                f"Se reintentara automaticamente.")
                        except Exception:
                            pass
                    idx_cuenta += 1

                except errors.FloodWaitError as e:
                    logger.warning(f"[{nombre}] FloodWait: {e.seconds}s en {grupo}")
                    # Poner cooldown en el grupo también
                    grupos_cooldown[grupo] = datetime.now().timestamp() + e.seconds
                    if bot_notificar:
                        try:
                            await bot_notificar.send_message(user_id,
                                f"⏳ Cuenta '{nombre}' en cooldown "
                                f"por {e.seconds}s (FloodWait).\n"
                                f"Se reanudará automáticamente.")
                        except Exception:
                            pass
                    idx_cuenta += 1
                    await asyncio.sleep(min(e.seconds + 5, 300))

                except errors.ChatWriteForbiddenError:
                    errores += 1
                    await actualizar_stats_campana(campana_id, 0, 1)
                    await registrar_envio(user_id, campana_id, grupo, "sin_permiso")
                    logger.warning(f"[{nombre}] Sin permiso en {grupo}")
                    grupos_bloqueados.add(grupo)
                    await eliminar_grupo_por_link(user_id, grupo)
                    if bot_notificar:
                        try:
                            await bot_notificar.send_message(user_id,
                                f"🚫 SIN PERMISO: {grupo}\n"
                                f"No se puede escribir ahi.\n"
                                f"🗑 Eliminado automaticamente de tu lista.")
                        except Exception:
                            pass
                    idx_cuenta += 1

                except errors.UserBannedInChannelError:
                    errores += 1
                    await actualizar_stats_campana(campana_id, 0, 1)
                    await registrar_envio(user_id, campana_id, grupo, "baneado")
                    logger.warning(f"[{nombre}] Baneado en {grupo}")
                    grupos_bloqueados.add(grupo)
                    await eliminar_grupo_por_link(user_id, grupo)
                    if bot_notificar:
                        try:
                            await bot_notificar.send_message(user_id,
                                f"⛔ BANEADO: {grupo}\n"
                                f"Cuenta baneada en este grupo.\n"
                                f"🗑 Eliminado automaticamente de tu lista.")
                        except Exception:
                            pass
                    idx_cuenta += 1

                except errors.ChannelPrivateError:
                    errores += 1
                    await actualizar_stats_campana(campana_id, 0, 1)
                    await registrar_envio(user_id, campana_id, grupo, "privado")
                    logger.warning(f"[{nombre}] Grupo privado: {grupo}")
                    grupos_bloqueados.add(grupo)
                    await eliminar_grupo_por_link(user_id, grupo)
                    if bot_notificar:
                        try:
                            await bot_notificar.send_message(user_id,
                                f"🔒 PRIVADO/INACCESIBLE: {grupo}\n"
                                f"🗑 Eliminado automaticamente de tu lista.")
                        except Exception:
                            pass

                except errors.AuthKeyUnregisteredError:
                    logger.warning(f"[{nombre}] AuthKey invalida, removiendo cuenta.")
                    clientes.pop(nombre, None)
                    nombres_rotacion = [n for n in nombres_rotacion if n in clientes]
                    if bot_notificar:
                        try:
                            await bot_notificar.send_message(user_id,
                                f"⚠ Cuenta '{nombre}' desautorizada.\n"
                                f"Necesita re-vincularse con /cuentas")
                        except Exception:
                            pass

                except (ConnectionError, OSError) as e:
                    logger.warning(f"[{nombre}] Error de conexion en {grupo}: {e}")
                    # No remover la cuenta, intentar reconectar en la siguiente ronda
                    await asyncio.sleep(5)
                    idx_cuenta += 1

                except Exception as e:
                    err_str = str(e).lower()
                    # Detectar slowmode u otras restricciones en el error genérico
                    if "slowmode" in err_str or "slow_mode" in err_str:
                        grupos_cooldown[grupo] = datetime.now().timestamp() + 60
                        logger.info(f"[{nombre}] Slowmode detectado en {grupo}, saltando 60s.")
                    elif "seconds" in err_str and "wait" in err_str:
                        grupos_cooldown[grupo] = datetime.now().timestamp() + 120
                        logger.info(f"[{nombre}] Restricción en {grupo}, saltando 120s.")
                    elif "disconnect" in err_str or "connection" in err_str:
                        logger.warning(f"[{nombre}] Desconexion en {grupo}, reintentando...")
                        await asyncio.sleep(5)
                    else:
                        errores += 1
                        await actualizar_stats_campana(campana_id, 0, 1)
                        logger.error(f"[{nombre}] Error en {grupo}: {e}")
                    idx_cuenta += 1

            # Verificar si quedan cuentas activas
            if not clientes:
                logger.warning(f"Campaña {campana_id}: sin cuentas activas, deteniendo.")
                if bot_notificar:
                    try:
                        await bot_notificar.send_message(user_id,
                            f"⚠ Campaña '{campana['nombre']}' detenida.\n"
                            f"No quedan cuentas activas.\n\n"
                            f"📊 Enviados: {enviados} | Errores: {errores}")
                    except Exception:
                        pass
                break

            # Verificar si todos los grupos están bloqueados o en cooldown
            grupos_disponibles = len(grupos) - len(grupos_bloqueados) - len(grupos_cooldown)
            if grupos_disponibles <= 0 and grupos_cooldown:
                # Todos en cooldown, esperar al que se desbloquee primero
                proximo = min(grupos_cooldown.values())
                espera_cd = max(int(proximo - datetime.now().timestamp()), 5)
                logger.info(f"Todos los grupos en cooldown, esperando {espera_cd}s.")
                await asyncio.sleep(espera_cd)
            elif grupos_disponibles <= 0 and not grupos_cooldown:
                # Todos bloqueados permanentemente
                logger.warning(f"Campaña {campana_id}: todos los grupos bloqueados.")
                if bot_notificar:
                    try:
                        await bot_notificar.send_message(user_id,
                            f"⚠ Campaña '{campana['nombre']}' detenida.\n"
                            f"Todos los grupos están bloqueados.\n"
                            f"Revisa tus grupos con /grupos\n\n"
                            f"📊 Enviados: {enviados} | Errores: {errores}")
                    except Exception:
                        pass
                break
            else:
                # Pausa entre rondas (reposo)
                espera_ciclo = config.get("espera_ciclo", 600)
                espera_min = round(espera_ciclo / 60)
                if bot_notificar:
                    try:
                        await bot_notificar.send_message(user_id,
                            f"📊 *{campana['nombre']}* ronda #{ronda}\n"
                            f"✅ {enviados} env | ❌ {errores} err\n"
                            f"⏳ Reposo: {espera_min} min")
                    except Exception:
                        pass
                await asyncio.sleep(espera_ciclo)

    except asyncio.CancelledError:
        logger.info(f"Campaña {campana_id} cancelada por el usuario.")
    except Exception as e:
        logger.error(f"Error fatal en campaña {campana_id}: {e}")
        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id,
                    f"❌ Error en campaña '{campana['nombre']}':\n{e}\n\n"
                    f"📊 Enviados: {enviados} | Errores: {errores}")
            except Exception:
                pass
    finally:
        for nombre, c in clientes.items():
            try:
                await c.disconnect()
                logger.info(f"Cuenta '{nombre}' desconectada.")
            except Exception:
                pass
        await set_campana_activa(campana_id, False)
        tareas_activas.pop(campana_id, None)
        logger.info(f"Campaña {campana_id} finalizada. Enviados: {enviados}, Errores: {errores}")

# ─────────────────────────────────────────
#   AUTO-RESPONDER WORKER (SOLO ESCANEO ACTIVO)
# ─────────────────────────────────────────
async def worker_responder(user_id, contacto, keywords, bot_notificar=None):
    """Escanea activamente los grupos cada 90 segundos buscando mensajes
    con palabras clave y responde automaticamente. No depende de event handlers."""
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.tl.functions.messages import ImportChatInviteRequest

    sesiones = await get_sesiones(user_id)
    if not sesiones:
        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id,
                    "❌ No tienes cuentas registradas. Agrega una con /cuentas")
            except Exception:
                pass
        return

    nombre = sesiones[0]['nombre']
    path = get_session_path(user_id, nombre)
    client = TelegramClient(path, API_ID, API_HASH)

    try:
        await client.connect()
        if not await client.is_user_authorized():
            if bot_notificar:
                try:
                    await bot_notificar.send_message(user_id,
                        f"❌ Cuenta '{nombre}' no autorizada.\n"
                        f"Vuelve a registrarla con /cuentas")
                except Exception:
                    pass
            return

        me = await client.get_me()
        mi_id = me.id
        logger.info(f"Auto-responder activo: usuario {user_id}, cuenta '{nombre}' ({me.phone})")

        keywords_lower = [k.lower() for k in keywords if k.strip()]
        if not keywords_lower:
            if bot_notificar:
                try:
                    await bot_notificar.send_message(user_id,
                        "❌ No tienes palabras clave configuradas.\n"
                        "Usa /responder para agregar palabras clave.")
                except Exception:
                    pass
            return

        respuestas_variadas = [
            f"Hola! Yo te puedo ayudar con eso.\nContacta a {contacto} para mas info.",
            f"Hey! Tengo lo que buscas.\nEscribe a {contacto}",
            f"Yo manejo eso! Contacta a {contacto}",
            f"Te puedo ayudar! Habla con {contacto}",
            f"Hola, yo tengo disponible.\nContactame en {contacto}",
        ]

        # Load keyword-specific responses from DB
        keyword_responses = {}
        keyword_counters = {}
        try:
            kw_full = await get_keywords_full(user_id)
            for kw_row in kw_full:
                kw_text = (kw_row["palabra"] or "").lower().strip()
                kw_resp = kw_row["respuesta"] or ""
                if kw_text and kw_resp:
                    responses = [r.strip() for r in kw_resp.split("|") if r.strip()]
                    if responses:
                        keyword_responses[kw_text] = responses
                        keyword_counters[kw_text] = 0
        except Exception:
            pass

        mensajes_respondidos = set()
        grupos_activos = []
        total_respondidos = 0
        ciclo = 0

        # --- CONECTAR A GRUPOS ---
        grupos_usuario = await get_grupos(user_id)
        if not grupos_usuario:
            if bot_notificar:
                try:
                    await bot_notificar.send_message(user_id,
                        "❌ No tienes grupos. Agrega con /grupos")
                except Exception:
                    pass
            return

        informe = "📋 AUTO-RESPONDER - CONECTANDO GRUPOS:\n\n"
        for g in grupos_usuario:
            link = g['link']
            try:
                ent = await client.get_entity(link)
                grupos_activos.append((link, ent))
                informe += f"  ✅ {link}\n"
            except errors.InviteHashExpiredError:
                informe += f"  ❌ {link} — Link expirado\n"
            except errors.ChannelPrivateError:
                informe += f"  🔒 {link} — Privado\n"
            except ValueError:
                try:
                    if "+" in link or "joinchat" in link:
                        h = link.split("+")[-1].split("/")[-1]
                        await client(ImportChatInviteRequest(h))
                    else:
                        u = link.replace("https://t.me/", "").replace("@", "").strip("/")
                        await client(JoinChannelRequest(u))
                    ent = await client.get_entity(link)
                    grupos_activos.append((link, ent))
                    informe += f"  ✅ {link} (unido auto)\n"
                except Exception as e:
                    informe += f"  ❌ {link} — {str(e)[:40]}\n"
            except Exception as e:
                informe += f"  ❌ {link} — {str(e)[:40]}\n"
            await asyncio.sleep(2)

        informe += (
            f"\n📊 Grupos: {len(grupos_activos)}/{len(grupos_usuario)}\n"
            f"🔑 Keywords: {', '.join(keywords_lower[:10])}\n"
            f"👤 Cuenta: {nombre}"
        )

        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id, informe)
            except Exception:
                pass

        if not grupos_activos:
            if bot_notificar:
                try:
                    await bot_notificar.send_message(user_id,
                        "❌ No se pudo acceder a ningun grupo.\n"
                        "Verifica que la cuenta este unida a los grupos.")
                except Exception:
                    pass
            return

        # --- FUNCION PRINCIPAL: ESCANEAR Y RESPONDER ---
        async def escanear_y_responder():
            nonlocal total_respondidos
            encontrados = 0
            for grupo_link, ent in grupos_activos:
                try:
                    mensajes = await client.get_messages(ent, limit=30)
                    for msg in mensajes:
                        if not msg or not msg.text:
                            continue
                        if msg.id in mensajes_respondidos:
                            continue
                        # Ignorar mensajes propios
                        if msg.sender_id == mi_id:
                            mensajes_respondidos.add(msg.id)
                            continue
                        # Ignorar mensajes de bots
                        try:
                            sender = msg.sender
                            if sender and getattr(sender, 'bot', False):
                                mensajes_respondidos.add(msg.id)
                                continue
                        except Exception:
                            pass
                        # Filtrar spam
                        if es_mensaje_spam(msg.text):
                            mensajes_respondidos.add(msg.id)
                            continue

                        texto_lower = msg.text.lower()
                        sender_name = ""
                        try:
                            sender = msg.sender
                            if sender:
                                sender_name = getattr(sender, 'first_name', '') or getattr(sender, 'username', '') or ''
                        except Exception:
                            pass
                        for kw in keywords_lower:
                            if kw in texto_lower:
                                try:
                                    if kw in keyword_responses:
                                        idx = keyword_counters.get(kw, 0) % len(keyword_responses[kw])
                                        keyword_counters[kw] = idx + 1
                                        resp = keyword_responses[kw][idx]
                                        resp = resp.replace("{usuario}", sender_name or contacto)
                                        resp = resp.replace("{contacto}", contacto)
                                    else:
                                        resp = random.choice(respuestas_variadas)
                                    await msg.reply(resp)
                                    await registrar_respuesta(user_id, grupo_link, kw)
                                    total_respondidos += 1
                                    encontrados += 1
                                    logger.info(
                                        f"Responder [{nombre}]: RESPONDIDO '{kw}' en {grupo_link} "
                                        f"msg: '{msg.text[:40]}' (total: {total_respondidos})"
                                    )
                                    if bot_notificar and total_respondidos <= 20:
                                        try:
                                            await bot_notificar.send_message(user_id,
                                                f"💬 RESPONDIDO en {grupo_link}\n"
                                                f"Mensaje: \"{msg.text[:60]}\"\n"
                                                f"Keyword: \"{kw}\"\n"
                                                f"Total: {total_respondidos}")
                                        except Exception:
                                            pass
                                    await asyncio.sleep(random.randint(5, 15))
                                except errors.SlowModeWaitError as e:
                                    logger.info(f"Responder [{nombre}]: slowmode {e.seconds}s en {grupo_link}")
                                except errors.ChatWriteForbiddenError:
                                    logger.warning(f"Responder [{nombre}]: sin permiso en {grupo_link}")
                                    if bot_notificar:
                                        try:
                                            await bot_notificar.send_message(user_id,
                                                f"🚫 Sin permiso escribir en {grupo_link}")
                                        except Exception:
                                            pass
                                except errors.UserBannedInChannelError:
                                    logger.warning(f"Responder [{nombre}]: baneado en {grupo_link}")
                                    if bot_notificar:
                                        try:
                                            await bot_notificar.send_message(user_id,
                                                f"⛔ Baneado en {grupo_link}")
                                        except Exception:
                                            pass
                                except Exception as e:
                                    logger.error(f"Responder [{nombre}]: error: {e}")
                                break  # Solo responder 1 keyword por mensaje
                        mensajes_respondidos.add(msg.id)

                except Exception as e:
                    logger.warning(f"Responder [{nombre}]: error en {grupo_link}: {e}")

                await asyncio.sleep(random.randint(2, 5))
            return encontrados

        # --- ESCANEO INICIAL ---
        logger.info(f"Responder [{nombre}]: escaneo inicial de {len(grupos_activos)} grupos...")
        encontrados = await escanear_y_responder()

        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id,
                    f"✅ Escaneo inicial completado.\n"
                    f"Respuestas: {encontrados}\n"
                    f"Re-escaneo cada 90 segundos.\n"
                    f"Total grupos: {len(grupos_activos)}")
            except Exception:
                pass

        # --- LOOP PRINCIPAL: RE-ESCANEAR CADA 90 SEGUNDOS ---
        while True:
            await asyncio.sleep(90)
            ciclo += 1
            logger.info(f"Responder [{nombre}]: ciclo {ciclo} - escaneando...")
            encontrados_re = await escanear_y_responder()
            if encontrados_re > 0:
                logger.info(f"Responder [{nombre}]: ciclo {ciclo} - {encontrados_re} respuestas nuevas")
            # Limpiar mensajes respondidos antiguos
            if len(mensajes_respondidos) > 5000:
                # Keep only the newest 2000 IDs to prevent memory leak while avoiding re-responses
                sorted_ids = sorted(mensajes_respondidos)
                mensajes_respondidos.difference_update(sorted_ids[:3000])

    except asyncio.CancelledError:
        logger.info(f"Auto-responder para usuario {user_id} cancelado.")
    except Exception as e:
        logger.error(f"Error en auto-responder usuario {user_id}: {e}")
        if bot_notificar:
            try:
                await bot_notificar.send_message(user_id,
                    f"❌ Error en auto-responder: {str(e)[:200]}\n"
                    f"Se detuvo automaticamente.")
            except Exception:
                pass
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass
        responder_activos.pop(user_id, None)

# ─────────────────────────────────────────
#   FUNCIONES DE CONTROL
# ─────────────────────────────────────────
async def _campana_supervisor(campana_id, user_id, bot=None, max_reinicios=5):
    """Supervisor que reinicia la campaña si muere inesperadamente."""
    reinicios = 0
    while reinicios < max_reinicios:
        try:
            await worker_campana(campana_id, user_id, bot)
            break  # Terminó normalmente
        except asyncio.CancelledError:
            break  # Cancelada por el usuario
        except Exception as e:
            reinicios += 1
            logger.error(f"Campaña {campana_id} crash #{reinicios}: {e}")
            if bot:
                try:
                    await bot.send_message(user_id,
                        f"⚠ Campaña se detuvo por error: {e}\n"
                        f"🔄 Reiniciando automáticamente ({reinicios}/{max_reinicios})...")
                except Exception:
                    pass
            await asyncio.sleep(10)
    if reinicios >= max_reinicios and bot:
        try:
            await bot.send_message(user_id,
                f"❌ Campaña detenida tras {max_reinicios} reinicios.\n"
                f"Revisa tus cuentas y grupos.")
        except Exception:
            pass
    tareas_activas.pop(campana_id, None)

def iniciar_campana(campana_id, user_id, loop, bot=None):
    """Inicia una campaña creando un task asyncio con supervisor."""
    if campana_id in tareas_activas:
        # Si ya existe pero la tarea terminó, reiniciar
        task = tareas_activas[campana_id]
        if task.done():
            del tareas_activas[campana_id]
        else:
            return False
    task = loop.create_task(_campana_supervisor(campana_id, user_id, bot))
    tareas_activas[campana_id] = task
    return True

def detener_campana(campana_id):
    """Detiene una campaña cancelando su task."""
    if campana_id in tareas_activas:
        tareas_activas[campana_id].cancel()
        del tareas_activas[campana_id]
        return True
    return False

def iniciar_responder(user_id, contacto, keywords, loop, bot=None):
    """Inicia el auto-responder para un usuario."""
    if user_id in responder_activos:
        return False
    task = loop.create_task(worker_responder(user_id, contacto, keywords, bot))
    responder_activos[user_id] = task
    return True

def detener_responder(user_id):
    """Detiene el auto-responder de un usuario."""
    if user_id in responder_activos:
        responder_activos[user_id].cancel()
        del responder_activos[user_id]
        return True
    return False

# ─────────────────────────────────────────
#   DETECTAR GRUPOS Y CARPETAS DE TELEGRAM
# ─────────────────────────────────────────
async def detectar_grupos_telegram(user_id, nombre=None):
    """Lee todos los grupos/supergrupos del Telegram del usuario.
    Retorna lista de dicts con info de cada grupo."""
    from telethon.tl.types import Channel, Chat
    sesiones = await get_sesiones(user_id)
    if not sesiones:
        return None, "No tienes cuentas registradas."

    if nombre is None:
        nombre = sesiones[0]['nombre']
    else:
        if not any(s['nombre'] == nombre for s in sesiones):
            return None, f"Cuenta '{nombre}' no encontrada."
    path = get_session_path(user_id, nombre)
    client = TelegramClient(path, API_ID, API_HASH)

    try:
        await client.connect()
        if not await client.is_user_authorized():
            return None, f"Cuenta '{nombre}' no autorizada. Vincúlala de nuevo."

        dialogs = await client.get_dialogs(limit=500)
        grupos = []
        for d in dialogs:
            ent = d.entity
            # Solo grupos y supergrupos (no canales de broadcast, no chats privados)
            if isinstance(ent, Channel):
                if ent.megagroup or ent.gigagroup:
                    link = None
                    if ent.username:
                        link = f"https://t.me/{ent.username}"
                    grupos.append({
                        "id": ent.id,
                        "title": ent.title or "Sin nombre",
                        "username": ent.username,
                        "link": link,
                        "participants": getattr(ent, 'participants_count', None),
                        "banned": getattr(ent, 'left', False),
                        "restricted": getattr(ent, 'restricted', False),
                        "tipo": "supergrupo",
                    })
                # Si es canal broadcast (no megagroup), lo ignoramos
            elif isinstance(ent, Chat):
                grupos.append({
                    "id": ent.id,
                    "title": ent.title or "Sin nombre",
                    "username": None,
                    "link": None,
                    "participants": getattr(ent, 'participants_count', None),
                    "banned": getattr(ent, 'left', False) or getattr(ent, 'kicked', False),
                    "restricted": False,
                    "tipo": "grupo",
                })

        return grupos, nombre
    except Exception as e:
        return None, f"Error: {str(e)[:100]}"
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


async def detectar_carpetas_telegram(user_id, nombre=None):
    """Lee las carpetas (folders) del Telegram del usuario.
    Retorna lista de carpetas con id y nombre."""
    from telethon.tl.functions.messages import GetDialogFiltersRequest
    sesiones = await get_sesiones(user_id)
    if not sesiones:
        return None, "No tienes cuentas registradas."

    if nombre is None:
        nombre = sesiones[0]['nombre']
    else:
        if not any(s['nombre'] == nombre for s in sesiones):
            return None, f"Cuenta '{nombre}' no encontrada."
    path = get_session_path(user_id, nombre)
    client = TelegramClient(path, API_ID, API_HASH)

    try:
        await client.connect()
        if not await client.is_user_authorized():
            return None, f"Cuenta '{nombre}' no autorizada."

        result = await client(GetDialogFiltersRequest())
        carpetas = []
        # result puede ser un objeto con .filters o directamente una lista
        filters_list = getattr(result, 'filters', result)
        for f in filters_list:
            # DialogFilter tiene id y title
            fid = getattr(f, 'id', None)
            title = getattr(f, 'title', None)
            if fid is not None and title is not None:
                # title puede ser str o TextWithEntities
                if hasattr(title, 'text'):
                    title = title.text
                carpetas.append({"id": fid, "title": str(title)})

        return carpetas, nombre
    except Exception as e:
        return None, f"Error: {str(e)[:100]}"
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


async def detectar_grupos_carpeta(user_id, folder_id, nombre=None):
    """Lee los grupos de una carpeta específica de Telegram.
    Retorna lista de grupos filtrados por esa carpeta."""
    from telethon.tl.functions.messages import GetDialogFiltersRequest
    from telethon.tl.types import Channel, Chat, InputPeerChannel, InputPeerChat, InputPeerUser
    sesiones = await get_sesiones(user_id)
    if not sesiones:
        return None, "No tienes cuentas registradas."

    if nombre is None:
        nombre = sesiones[0]['nombre']
    else:
        if not any(s['nombre'] == nombre for s in sesiones):
            return None, f"Cuenta '{nombre}' no encontrada."
    path = get_session_path(user_id, nombre)
    client = TelegramClient(path, API_ID, API_HASH)

    try:
        await client.connect()
        if not await client.is_user_authorized():
            return None, f"Cuenta '{nombre}' no autorizada."

        result = await client(GetDialogFiltersRequest())
        filters_list = getattr(result, 'filters', result)
        target_filter = None
        for f in filters_list:
            fid = getattr(f, 'id', None)
            if fid == folder_id:
                target_filter = f
                break

        if not target_filter:
            return None, "Carpeta no encontrada."

        # Obtener los peers incluidos en esta carpeta
        include_peers = getattr(target_filter, 'include_peers', [])
        if not include_peers:
            return [], nombre

        # Resolver cada peer y filtrar solo grupos
        grupos = []
        for peer in include_peers:
            try:
                ent = await client.get_entity(peer)
                if isinstance(ent, Channel):
                    if ent.megagroup or ent.gigagroup:
                        link = None
                        if ent.username:
                            link = f"https://t.me/{ent.username}"
                        grupos.append({
                            "id": ent.id,
                            "title": ent.title or "Sin nombre",
                            "username": ent.username,
                            "link": link,
                            "participants": getattr(ent, 'participants_count', None),
                            "banned": getattr(ent, 'left', False),
                            "restricted": getattr(ent, 'restricted', False),
                            "tipo": "supergrupo",
                        })
                elif isinstance(ent, Chat):
                    grupos.append({
                        "id": ent.id,
                        "title": ent.title or "Sin nombre",
                        "username": None,
                        "link": None,
                        "participants": getattr(ent, 'participants_count', None),
                        "banned": getattr(ent, 'left', False) or getattr(ent, 'kicked', False),
                        "restricted": False,
                        "tipo": "grupo",
                    })
            except Exception as e:
                logger.warning(f"Error resolviendo peer en carpeta: {e}")
                continue

        return grupos, nombre
    except Exception as e:
        return None, f"Error: {str(e)[:100]}"
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


async def verificar_grupos_estado(user_id):
    """Verifica el estado de todos los grupos guardados del usuario.
    Detecta cuáles están baneados, sin permiso, privados, etc.
    Retorna lista de dicts con estado de cada grupo."""
    sesiones = await get_sesiones(user_id)
    if not sesiones:
        return None, "No tienes cuentas registradas."

    nombre = sesiones[0]['nombre']
    path = get_session_path(user_id, nombre)
    client = TelegramClient(path, API_ID, API_HASH)

    try:
        await client.connect()
        if not await client.is_user_authorized():
            return None, f"Cuenta '{nombre}' no autorizada."

        grupos_guardados = await get_grupos(user_id)
        if not grupos_guardados:
            return [], nombre

        resultados = []
        for g in grupos_guardados:
            link = g['link']
            estado = "desconocido"
            titulo = link
            try:
                ent = await client.get_entity(link)
                titulo = getattr(ent, 'title', link)
                # Intentar obtener permisos
                from telethon.tl.types import Channel
                if isinstance(ent, Channel):
                    if getattr(ent, 'left', False):
                        estado = "no_miembro"
                    elif getattr(ent, 'restricted', False):
                        estado = "restringido"
                    elif getattr(ent, 'default_banned_rights', None):
                        rights = ent.default_banned_rights
                        if getattr(rights, 'send_messages', False):
                            estado = "solo_lectura"
                        else:
                            estado = "ok"
                    else:
                        estado = "ok"
                else:
                    if getattr(ent, 'left', False) or getattr(ent, 'kicked', False):
                        estado = "no_miembro"
                    else:
                        estado = "ok"
            except errors.ChannelPrivateError:
                estado = "privado"
            except errors.InviteHashExpiredError:
                estado = "link_expirado"
            except errors.UserBannedInChannelError:
                estado = "baneado"
            except errors.ChatWriteForbiddenError:
                estado = "sin_permiso"
            except ValueError:
                estado = "no_encontrado"
            except Exception as e:
                err = str(e).lower()
                if "banned" in err:
                    estado = "baneado"
                elif "private" in err:
                    estado = "privado"
                elif "forbidden" in err:
                    estado = "sin_permiso"
                else:
                    estado = f"error"

            resultados.append({
                "link": link,
                "titulo": titulo,
                "estado": estado,
                "grupo_id": g['id'],
            })
            await asyncio.sleep(1)

        return resultados, nombre
    except Exception as e:
        return None, f"Error: {str(e)[:100]}"
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass

