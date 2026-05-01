# Handoff para la Siguiente IA

## IMPORTANTE — Antes de Hacer Cualquier Cambio
1. Lee este handoff completo y confirma que entiendes la arquitectura
2. Si vas a modificar `panel.html`, di en que linea/seccion vas a trabajar
3. Si necesitas agregar un endpoint API, agregalo ANTES de la linea `// Endpoint no encontrado` en `index_wsp.js`
4. Despues de cada mejora/fix, **actualiza este HANDOFF.md** con los cambios realizados

---

## Pregunta para la Siguiente IA (Random/Graciosa)
> Si fueras un bug en este codigo, en que archivo te esconderias y por que? 🐛 Ahora en serio: lee este handoff completo, confirma que entiendes la arquitectura, y dime un chiste de programacion antes de empezar a trabajar. Si vas a modificar panel.html, di en que linea/seccion vas a trabajar. Si necesitas agregar un endpoint, ANTES de "Endpoint no encontrado" en index_wsp.js.

### Mas preguntas random para la IA (elige una diferente cada vez):
1. "Si este bot fuera una pizza, que ingrediente le faltaria? 🍕 Ahora lee el handoff y confirma la arquitectura."
2. "Cuantos programadores se necesitan para cambiar un foco? Ninguno, eso es problema de hardware. Ahora confirma que entiendes el sistema."
3. "Que le dijo JavaScript a Python? 'Yo soy mas rapido!' Python: 'Pero yo soy mas legible'. Ahora lee el handoff completo."
4. "Si pudieras eliminar un bug de la historia de la informatica, cual seria? Lee el handoff y confirma la arquitectura."
5. "Por que los programadores prefieren el modo oscuro? Porque la luz atrae bugs 🪲 Lee el handoff y di donde vas a trabajar."

---

## Resumen del Sistema
Bot de WhatsApp + Telegram para envio masivo, gestion de grupos, campanas automaticas y panel de control web con soporte PWA.

## Arquitectura
- **WSP API** (puerto 3000) — `index_wsp.js` + `motor_wsp.js` + `db_wsp.js`
- **Panel Web** (puerto 3001) — `panel_server.js` sirve `panel.html` y proxea API
- **TG API** (puerto 3002) — `bot.py` + `motor.py` + `db.py`
- **Base de datos**: SQLite (`wsp_titan.db` para WSP, `titan.db` para TG)
- **Bot Token**: (ver bot.py linea 34 — NO commitear tokens en documentacion)
- **Admin ID**: 8001675901

## Archivos Principales
| Archivo | Descripcion | Lineas aprox |
|---|---|---|
| `panel.html` | Frontend completo (HTML+CSS+JS en un solo archivo) | ~5600 |
| `index_wsp.js` | API HTTP del bot WSP (todos los endpoints) | ~6099 |
| `db_wsp.js` | Base de datos SQLite WSP (tablas + CRUD) | ~2821 |
| `motor_wsp.js` | Motor de envio WhatsApp | ~1780 |
| `panel_server.js` | Servidor web que sirve panel.html y proxea APIs | ~131 |
| `bot.py` | Bot de Telegram (comandos + API) | ~4467 |
| `motor.py` | Motor de envio Telegram | ~1122 |
| `db.py` | Base de datos SQLite Telegram | ~743 |
| `manifest.json` | Manifiesto de PWA | ~45 |
| `sw.js` | Service Worker para PWA | ~62 |
| `start.sh` | Script de inicio de todos los servicios | ~52 |
| `wsp_bridge.py` | Bridge WSP<->TG (funciones de comunicacion) | ~226 |
| `web_panel.py` | Panel web de Telegram | ~1133 |

## Mejoras Implementadas

### PRs Anteriores (ya mergeados)

#### 1. Recuperacion de Contrasena
- Web: Login > "Olvide mi contrasena" > ingresa Telegram ID > recibe codigo por bot > ingresa codigo + nueva contrasena
- Bot: Comando `/recuperpass` genera codigo y permite cambiar contrasena desde Telegram
- Tablas: `recovery_codes` (telegram_id, code, created_at)

#### 2. Envio Personal — Numeros Manuales
- `enviarAPersonales()` incluye numeros subidos manualmente (`numeros_manuales` tabla)
- Se pasa parametro `cuenta` para cargar numeros correctos

#### 3. Extraer y Agregar Miembros de Grupos
- Exportar TXT de miembros
- Agregar desde archivo .txt con lotes configurables
- `/api/agregar_miembros` acepta `numeros` array

#### 4. Grupos WSP — Busqueda, Orden, Secciones
- Campo de busqueda por nombre de grupo
- Ordenar: AZ, ZA, por cantidad de miembros
- Secciones/Categorias: Asignar categorias, filtrar por seccion
- Eliminar todos los grupos

#### 5. Campanas — Filtro por Seccion
- Al editar campana, dropdown de secciones
- Botones Todos/Ninguno respetan filtro de seccion

#### 6. Envio Interactivo — Plantillas de Promocion
- Guardar/Cargar/Eliminar plantillas de promo
- Datos guardados: palabra aceptar/rechazar, respuestas, timeout, recordatorio

#### 7. PWA (Progressive Web App)
- `manifest.json` mejorado: iconos PNG, accesos directos
- `sw.js` mejorado: cache de activos estaticos, estrategia network-first
- Install Prompt: Banner en Dashboard "Instalar como App"

#### 8. Dashboard Mejorado
- Grafico Donut: Tasa de exito visual (exitosos vs fallidos) — semanal
- Grafico Linea: Actividad por hora (ultimos 7 dias)
- Top 10 Grupos: Ranking de grupos mas activos del mes
- Resumen Semanal y Mensual con tasas de exito

#### 9. Autenticacion 2FA (TOTP)
- Genera clave TOTP compatible con Google Authenticator
- Endpoints: `/api/2fa/setup`, `/api/2fa/verify`, `/api/2fa/enable`, `/api/2fa/disable`, `/api/2fa/status`
- Tabla: `user_2fa`

#### 10. Sesiones Activas
- Ver, cerrar individual, cerrar todas las sesiones
- Tabla: `active_sessions`
- Endpoints: `/api/panel_sessions`, `/api/panel_sessions/close`

#### 11. Export/Import Configuracion
- Exportar JSON completo, importar sin borrar existente
- Endpoints: `/api/config/exportar`, `/api/config/importar`

#### 12. Multi-idioma (ES/EN/PT)
- Toggle ES/EN en esquina superior derecha
- Portugues basico

#### 13. Modo Oscuro/Claro
- Toggle luna/sol, CSS variables para todos los componentes

#### 14. Grupos TG Mejorado
- Busqueda, filtro por seccion, ordenar AZ/ZA

#### 15. Cache Local (localStorage)
- `getCached(key)`, `setCache(key, data)` con TTL de 5 minutos

#### 16. Paginacion
- `paginateArray()`, `renderPagination()` con 50 elementos por pagina

#### 17. Selector de Mensajes Guardados en Promo
- Al enviar promo, se puede seleccionar un mensaje guardado previamente

#### 18. Filtro por Pais en Envio Interactivo
- Dropdown de paises detectados por codigo de telefono
- Filtra miembros por pais al enviar promo/DMs

### Este PR — Mejoras Nuevas

#### 19. Sistema de Sellers (Revendedores) con Codigos
- **Admin**: Crear/editar/eliminar sellers desde "Admin > Sellers"
- **Seller Config**: Telegram ID, nombre, max invitaciones, periodo (semanal/mensual), plan que otorga (semanal/mensual/permanente)
- **Panel Seller**: Los sellers ven su seccion donde pueden:
  - **Generar codigos** (ej: `VIP-A3X9K2`) — codigos unicos que le dan al cliente
  - **Activar directo** por Telegram ID si ya lo tienen
  - Ver tabla de codigos (pendientes/usados) con click para copiar
  - Ver historial de membresias activadas
- **Canjear Codigo**: Seccion visible para TODOS los usuarios donde pueden ingresar un codigo y se activa su membresia automaticamente
- **Limite por periodo**: El contador de invitaciones se resetea cada semana/mes
- **Barra de progreso**: Visualizacion de invitaciones usadas/disponibles
- **Sync TG**: Al activar membresia (por codigo o directo), se sincroniza a Telegram
- **Tablas**:
  - `sellers` (telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo, activo)
  - `seller_invites` (seller_id, invitado_telegram_id, plan_dias, plan_tipo, fecha_invitacion)
  - `seller_codes` (seller_id, codigo, plan_dias, plan_tipo, usado, usado_por, fecha_creado, fecha_usado)
- **Endpoints Admin**:
  - `GET /api/admin/sellers` — Lista sellers `?u=ADMIN_ID`
  - `POST /api/admin/sellers/crear` — Crear seller `{admin_id, telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo}`
  - `POST /api/admin/sellers/editar` — Editar seller `{admin_id, id, max_invites, periodo, plan_dias, plan_tipo, activo}`
  - `POST /api/admin/sellers/eliminar` — Eliminar seller `{admin_id, id}`
- **Endpoints Seller**:
  - `GET /api/seller/info` — Info del seller `?u=USER_ID`
  - `POST /api/seller/invitar` — Activar membresia directo `{u, invitado_id, invitado_nombre}`
  - `POST /api/seller/generar_codigo` — Generar codigos `{u, cantidad}`
  - `GET /api/seller/codigos` — Lista codigos del seller `?u=USER_ID`
  - `POST /api/seller/eliminar_codigo` — Eliminar codigo no usado `{u, code_id}`
- **Endpoint Publico**:
  - `POST /api/canjear_codigo` — Cualquier usuario canjea un codigo `{codigo, telegram_id}`
- **Login/CheckMembresia**: Devuelven `es_seller` para mostrar/ocultar seccion seller

---

## Secciones del Panel
| # | Seccion | ID HTML | Plataforma | Descripcion |
|---|---|---|---|---|
| 1 | Dashboard | sec-dashboard | Ambas | Vista general, graficos |
| 2 | Cuentas WSP | sec-cuentas | WSP | Vincular cuentas WhatsApp |
| 3 | Cuentas TG | sec-cuentastg | TG | Vincular cuentas Telegram |
| ~~3b~~ | ~~Ver Chats WSP~~ | ~~sec-chatswsp~~ | ~~WSP~~ | **ELIMINADO en v11** — Inbox WSP eliminado completamente (sidebar, HTML, JS, endpoints) |
| ~~3c~~ | ~~Ver Chats TG~~ | ~~sec-chatstg~~ | ~~TG~~ | **ELIMINADO en v11** — Inbox TG eliminado completamente (sidebar, HTML, JS, handlers bot.py) |
| 4 | Grupos WSP | sec-grupos | WSP | Gestion de grupos |
| 5 | Grupos TG | sec-tggrupos | TG | Gestion de grupos TG |
| 6 | Mensajes y Plantillas | sec-mensajes | WSP | Mensajes reutilizables |
| 7 | Envio Unico | sec-envios | WSP | Enviar a grupos |
| 8 | Envio Personal | sec-enviopersonal | WSP | Enviar a numeros |
| 9 | Envio a Miembros | sec-enviomiembros | WSP | DM a miembros + filtro pais |
| 10 | Envio Interactivo | sec-enviointeractivo | WSP | Promo + filtro pais |
| 11 | Programados WSP | sec-programados | WSP | Envios programados |
| 12 | Campanas WSP | sec-campanas | WSP | Envios ciclicos |
| 13 | Mensajes TG | sec-tgmensajes | TG | Mensajes TG |
| 14 | Campanas TG | sec-tgcampanas | TG | Envios ciclicos TG |
| 15 | Programados TG | sec-tgprogramados | TG | Envios programados TG |
| 16 | Historial TG | sec-tghistorial | TG | Historial TG |
| 17 | Detectar Grupos TG | sec-tgdetectar | TG | Detectar grupos TG |
| 18 | Stats TG | sec-tgstats | TG | Estadisticas TG |
| 19 | Historial WSP | sec-historial | WSP | Historial WSP |
| 20 | Logs del Bot | sec-logs | WSP | Logs en tiempo real |
| 21 | Cola de Reintentos | sec-retry | WSP | Mensajes pendientes |
| 22 | Config Envio WSP | sec-config | WSP | Intervalos, retrasos |
| 23 | Lista Negra | sec-listanegra | WSP | Grupos excluidos |
| 24 | Auto-Responder WSP | sec-autoresp | WSP | Respuestas automaticas |
| 25 | Auto-Responder TG | sec-tgautoresp | TG | Respuestas TG |
| 26 | Config Envio TG | sec-tgconfig | TG | Config envio TG |
| 27 | Lista Negra TG | sec-tglistanegra | TG | Exclusiones TG |
| 28 | 2FA y Sesiones | sec-seguridad | Ambas | 2FA + sesiones activas |
| 29 | Backup / Restaurar | sec-backup | Ambas | Export/Import config |
| 30 | Estadisticas y DMs | sec-stats | Ambas | Estadisticas + DMs |
| 31 | Actividad | sec-actividad | Ambas | Registro actividad |
| 32 | **Canjear Codigo** | sec-canjear | Ambas | **NUEVO**: Canjear codigo de membresia (visible para todos) |
| 33 | **Panel Seller** | sec-sellerpanel | seller-only | **NUEVO**: Generar codigos + activar membresias |
| 34 | Admin Panel | sec-admin | admin-only | Gestion de usuarios |
| 35 | **Sellers** | sec-sellers | admin-only | **NUEVO**: Crear/editar/eliminar sellers |
| 36 | Logs Global | sec-adminlogs | admin-only | Logs de todos los usuarios |
| 37 | **Pagar Membresia** | sec-pagos | Ambas | **NUEVO**: Pagar con Binance Pay o comprobante manual |
| 38 | **Gestion de Pagos** | sec-adminpagos | admin-only | **NUEVO**: Ver/aprobar comprobantes, stats, config metodos de pago |
| 39 | **Tickets/Soporte** | sec-tickets | Ambas | Crear tickets de soporte |
| 40 | **Analytics Avanzado** | sec-analytics | Ambas | Graficos envios/dia, horas activas, tasa por cuenta |
| 41 | **Webhooks** | sec-webhooks | Ambas | Configurar URLs para recibir eventos HTTP |
| 42 | **Admin Tickets** | sec-admintickets | admin-only | Bandeja de tickets + historial conversacion |
| 43 | **Admin Backups** | sec-adminbackups | admin-only | Respaldo automatico diario + manual |
| 44 | **Auditoria** | sec-auditoria | admin-only | Registro de auditoria de acciones |

### Bugs corregidos en este update
- **Historial Binance Pay** no se mostraba en seccion Pagos (endpoint `/api/pagos/historial` existia pero no se llamaba)
- **Plantillas de promocion** no tenian boton "Editar" (endpoint `/api/promo/plantillas/editar` existia pero no tenia UI)
- **`/api/dashboard_extended`** (con underscore) en NO_MEMBRESIA_ENDPOINTS — corregido a `/api/dashboard/extended` (con slash)

### ~~Ver Chats WSP/TG~~ — ELIMINADO EN v11

> **NOTA**: Esta funcionalidad fue **ELIMINADA COMPLETAMENTE** en la sesion de v11 por solicitud del usuario.
> NO re-implementar. NO crear endpoints, secciones HTML, ni funciones JS para chats.
> El endpoint `/api/chat/enviar` permanece porque es usado por Envio Personal — **NO TOCAR**.
> El endpoint `/api/chats_personales` y la funcion `wsp_chats_personales` tambien permanecen — son de Envio Personal, **NO TOCAR**.

**Lo que se elimino:**
- Panel sidebar: Links "Ver Chats WSP" y "Ver Chats TG"
- Panel HTML: Secciones sec-chatswsp y sec-chatstg con todo su contenido
- Panel JS: Funciones loadChatsWsp, renderChatsWspList, filtrarChatsWsp, iniciarChatWsp, selectChatWsp, enviarMsgChatWsp
- Panel JS: Funciones loadChatsTg y relacionadas
- Panel JS: Entradas `chatswsp:loadChatsWsp,chatstg:loadChatsTg` del objeto `loaders`
- index_wsp.js: Endpoints `/api/chat/contactos`, `/api/chat/synced`, `/api/chat/mensajes`
- bot.py: Boton "Ver Chats TG" del menu principal
- bot.py: Clase ChatTGState y handlers cb_tg_ver_chats, cb_tg_chats_cuenta, cb_tg_chat_seleccionado, recibir_respuesta_chat_tg

**Lo que NO se elimino (pertenece a Envio Personal):**
- `/api/chat/enviar` — Usado por Envio Personal para enviar mensajes individuales
- `/api/chats_personales` — Bridge function de Envio Personal
- `wsp_chats_personales()` — Bridge function en wsp_bridge.py
- Tablas `synced_chats`, `chat_history`, `chat_contacts` — Permanecen en DB pero ya no se usan desde el panel
- Eventos `chats.upsert`, `messaging-history.set` en motor_wsp.js — Permanecen para sincronizacion automatica

## Endpoints API Completos
### Sellers (NUEVOS)
| Endpoint | Metodo | Descripcion |
|---|---|---|
| `/api/admin/sellers` | GET | Lista sellers (admin) `?u=ADMIN_ID` |
| `/api/admin/sellers/crear` | POST | Crear seller `{admin_id, telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo}` |
| `/api/admin/sellers/editar` | POST | Editar seller `{admin_id, id, max_invites, periodo, plan_dias, plan_tipo, activo}` |
| `/api/admin/sellers/eliminar` | POST | Eliminar seller `{admin_id, id}` |
| `/api/seller/info` | GET | Info del seller `?u=USER_ID` |
| `/api/seller/invitar` | POST | Activar membresia directo `{u, invitado_id, invitado_nombre}` |
| `/api/seller/generar_codigo` | POST | Generar codigos `{u, cantidad}` |
| `/api/seller/codigos` | GET | Lista codigos `?u=USER_ID` |
| `/api/seller/eliminar_codigo` | POST | Eliminar codigo no usado `{u, code_id}` |
| `/api/canjear_codigo` | POST | Canjear codigo `{codigo, telegram_id}` |

### Endpoints Anteriores (sin cambios)
- Auth: `/api/panel_login`, `/api/panel_registro`, `/api/check_membresia`, `/api/panel_cambiar_password`, `/api/panel_recuperar_solicitar`, `/api/panel_recuperar_reset`
- Grupos: `/api/grupos`, `/api/grupos/add`, `/api/grupos/del`, `/api/grupos/delall`, `/api/grupos/seccion`, `/api/grupos/secciones`
- Campanas: `/api/campanas`, `/api/campanas/crear`, `/api/campanas/del`, `/api/campanas/editar`, `/api/iniciar`, `/api/detener`
- Envios: `/api/historial`, `/api/dashboard`, `/api/dashboard/extended`, `/api/reporte_diario`, `/api/tasa_entrega`, `/api/envios_chart`, `/api/limites`
- 2FA: `/api/2fa/setup`, `/api/2fa/verify`, `/api/2fa/enable`, `/api/2fa/disable`, `/api/2fa/status`
- Sesiones: `/api/panel_sessions`, `/api/panel_sessions/close`
- Backup: `/api/config/exportar`, `/api/config/importar`
- Admin: `/api/admin/usuarios`, `/api/admin/membresia`, `/api/admin/desactivar`, `/api/admin/set_admin`
- Promo: `/api/promo/plantillas`, `/api/promo/plantillas/crear`, `/api/promo/plantillas/editar`, `/api/promo/plantillas/eliminar`

## Tablas de Base de Datos
### Tablas WSP (wsp_titan.db)
- `usuarios` — Usuarios WSP (plan, fecha_expira, activo, es_admin)
- `sesiones` — Cuentas WSP vinculadas
- `campanas` — Campanas de envio
- `grupos` — Grupos (con seccion y tamano)
- `templates` — Plantillas de mensajes
- `blacklist` — Lista negra de grupos
- `blacklist_numeros` — Lista negra de numeros
- `historial_envios` — Historial de envios
- `panel_users` — Usuarios del panel web
- `recovery_codes` — Codigos de recuperacion
- `user_envio_config` — Config de envio por usuario
- `auto_respuestas` — Auto respuestas
- `promo_plantillas` — Plantillas de promo
- `numeros_manuales` — Numeros subidos manualmente
- `promo_escucha` — Escucha de respuestas promo
- `promo_respuestas` — Respuestas de promo
- `bot_logs` — Logs del bot
- `retry_queue` — Cola de reintentos
- `programados_wsp` — Envios programados
- `programado_miembros` — Programados a miembros
- `envio_progreso` — Progreso de envio
- `user_2fa` — 2FA TOTP
- `active_sessions` — Sesiones activas
- `envios_semanales` — Cache semanal
- **`sellers`** — Revendedores (telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo, activo)
- **`seller_invites`** — Invitaciones de sellers (seller_id, invitado_telegram_id, plan_dias, plan_tipo, fecha)
- **`seller_codes`** — Codigos de activacion (seller_id, codigo, plan_dias, plan_tipo, usado, usado_por, fecha_creado, fecha_usado)
- **`pagos`** — Pagos con Binance Pay (user_id, merchant_trade_no, prepay_id, plan_key, plan_dias, monto_usdt, estado, checkout_url, fecha_creado, fecha_pagado)
- **`comprobantes`** — Comprobantes de pago manual (user_id, plan_key, metodo_pago, monto, imagen_path, estado, revisado_por, fecha_creado, fecha_revisado)
- **`metodos_pago`** — Metodos de pago configurables por admin (tipo, nombre, valor, instrucciones, activo, orden)

## Flujo del Sistema de Sellers
1. **Admin** crea un seller en Admin > Sellers (Telegram ID, nombre, limite, periodo, plan)
2. **Seller** inicia sesion y ve "Panel Seller" en el sidebar
3. **Seller** tiene 2 opciones:
   - **Generar codigos**: Crea codigos como `VIP-A3X9K2`, se los da a sus clientes
   - **Activar directo**: Si tiene el Telegram ID, activa la membresia directamente
4. **Cliente** va a "Canjear Codigo" en su panel, ingresa el codigo y se activa su membresia
5. El limite se descuenta: codigos pendientes + usados en el periodo cuentan contra el limite
6. El contador se resetea automaticamente cada semana o mes segun configuracion del admin

## Bugs Corregidos (Escaneo Profundo)
1. **Code gen excedia limite**: Si seller pedia 5 codigos con 8/10 usados, generaba 5 (total 13). Fix: se capea `cantidad` a `disponibles = max - (usados + pendientes)`.
2. **Invitar directo no contaba codigos pendientes**: El endpoint `/api/seller/invitar` solo contaba invites directos, no codigos pendientes. Fix: ahora cuenta ambos.
3. **eliminarSeller no borraba codigos**: Al eliminar un seller, se borraban invites pero no seller_codes (quedaban huerfanos). Fix: se agrego `DELETE FROM seller_codes`.
4. **generarSellerCode podia fallar silenciosamente**: Si los 20 intentos de generar codigo unico fallaban, insertaba un duplicado y crasheaba. Fix: 50 intentos + throw Error explicito si falla.
5. **importFullConfig usaba columnas INCORRECTAS (backup import 100% roto)**: La funcion `importFullConfig()` en `db_wsp.js` tenia TODOS los INSERT con nombres de columnas que NO existian en las tablas reales. El `catch(_){}` ocultaba todos los errores, asi que al importar un backup parecia funcionar pero no se importaba NADA. Columnas corregidas:
   - `grupos`: `grupo_jid` → `link`, se quito `nombre` duplicado, se corrigio a `seccion, size`
   - `templates`: `imagen_b64` → `imagen_path`
   - `blacklist`: `grupo_jid, nombre` → `grupo_link, razon`
   - `auto_respuestas`: `keyword` → `palabra`
   - `user_envio_config`: `intervalo_min, intervalo_max, espera_ciclo, envio_imagen, caption_mode` → `delay_seg, lote_tamano, lote_pausa_seg, hora_inicio, hora_fin`
6. **getSellerInvitesCount formato de fecha incorrecto**: Usaba `toISOString()` que genera `2026-04-23T02:41:28.000Z` pero SQLite `datetime('now')` genera `2026-04-23 02:41:28`. La `T` vs espacio causaba que la comparación lexicográfica fallara y no contara invites recientes. Fix: se formatea a `YYYY-MM-DD HH:MM:SS`.
7. **invites_usados no incluia codigos pendientes en dashboard**: Los endpoints `/api/seller/info` y `/api/admin/sellers` solo mostraban invites directos en `invites_usados`, no codigos pendientes. El seller veia "2/10" pero el sistema enforceaba "7/10". Fix: ahora `invites_usados = usados + pendientes` en ambos endpoints.

#### Este PR — Bugfixes y Mejoras
8. **Mensajes guardados no cargaban en promo Todo en Uno**: Habia dos elementos con `id="promoPlantillaSelect"` — el segundo (en Todo en Uno) era ignorado por el DOM. Fix: renombrado a `promoMsgSelect`.
9. **Pregunta del handoff ahora es random/graciosa**: Cambiada la pregunta estatica del handoff por preguntas random de programacion.
10. **Preguntas random para promo**: Boton "Pregunta Random" en la seccion Todo en Uno que llena el textarea con preguntas graciosas aleatorias.
11. **not_member eliminaba grupos agresivamente**: `sendToGroup` trataba CUALQUIER error de metadata como "not_member" y eliminaba el grupo. Ahora: reintenta 1 vez, solo elimina si el error es explicitamente "not-authorized/forbidden/404", errores temporales se registran como "error_temporal" sin eliminar.
12. **Pausa/Reanudar en promo Todo en Uno**: Boton "Pausar" y barra de reanudacion en la seccion de promo. Usa la misma infraestructura de progreso que envio a miembros.
13. **Promo usa config de envio del usuario**: El envio de promo a miembros ahora respeta `lote_tamano` y `lote_pausa_seg` de la config del usuario en vez de enviar sin lotes.
14. **Fix scanning loop**: `linkAccount` ahora limpia sockets viejos (`.end()`) antes de reintentar, evitando multiples QR activos simultaneamente.
15. **enviarAPersonales ahora soporta lotes**: La funcion `enviarAPersonales` ahora lee `getUserEnvioConfig()` para batch/delay. Si el usuario tiene configurado "10 mensajes y 5 min pausa", se aplica tambien a envios personales. Guarda progreso durante pausas de lote.
16. **Fix promoResumeBar CSS duplicado**: El div tenia `display:none` dos veces en el style, la segunda pisaba `align-items:center`. Corregido.
17. **Anti-duplicado mejorado entre campanas**: `grupoTieneActividadNueva` ahora tiene ventana de 30 min — si la misma campana envio al grupo en los ultimos 30 min, no reenvia (incluso despues de restart). Campanas diferentes con mensajes distintos SI envian al mismo grupo sin problemas.

#### Escaneo Exhaustivo Linea por Linea (Bugfixes adicionales)
18. **Socket leak en connectClientAccount timeout**: El timeout de 60s en `connectClientAccount` disparaba reject sin cerrar el socket, dejando conexiones fantasma. Fix: se agrego `sock.end()` antes del reject. (`motor_wsp.js:121`)
19. **esGrupoReal filtraba announce groups**: Filtraba grupos de solo-admin (announce) impidiendo que admins los vean en la lista. Fix: se quito el filtro ya que `sendToGroup` verifica permisos al enviar. (`motor_wsp.js:466`)
20. **Scheduler hardcodeaba "America/Lima"**: Dos funciones en el scheduler usaban `"America/Lima"` en vez de `config.TIMEZONE`, rompiendo para usuarios con timezone diferente. Fix: se cambio a `config.TIMEZONE`. (`motor_wsp.js:1379,1396`)
21. **Delivery handler leak en sendToGroup**: El handler de `messages.update` no se removia del socket en la rama exitosa (solo en timeout). Fix: se reordeno para hacer `off()` en ambas ramas. (`motor_wsp.js:418-422`)
22. **enviar_miembros ignoraba config de lotes del usuario**: Endpoint usaba defaults hardcodeados (batch=0, delay=5min) en vez de leer `getUserEnvioConfig()`. Fix: ahora lee config del usuario. (`index_wsp.js:1213-1215`)
23. **enviar_miembros_reanudar ignoraba config de lotes**: Igual que #22 pero en el endpoint de reanudar. Fix: ahora lee `getUserEnvioConfig()`. (`index_wsp.js:1414-1416`)
24. **Promo enviar_y_escuchar no procesaba JIDs correctamente**: A diferencia de `enviar_miembros`, el endpoint promo no filtraba @lid, no quitaba sufijos de dispositivo, no deduplicaba, no checkeaba blacklist ni se saltaba el propio JID del sender. Fix: se agrego procesamiento completo de JIDs con blacklist, dedup, LID filter, self-skip. (`index_wsp.js:1838-1863`)
25. **XSS en 4 secciones de innerHTML sin esc()**: Nombres de sesion (`s.nombre`, `s.telefono`) se insertaban sin escapar en `<option>` tags, permitiendo XSS si un nombre contenia HTML. Fix: se agrego `esc()` en loadTgDetectar, loadEnvioPersonal, loadEnvioMiembros, loadPromoCuentas. (`panel.html:2273,2787,2881,3517`)

#### Escaneo de Seguridad Profundo — PR Security/Roles/Fixes
26. **SIN AUTENTICACION EN API (CRITICO)**: Todos los 199+ endpoints confiaban SOLO en el parametro `u` (telegram_id) sin validar ningun token. Cualquiera que supiera un telegram_id podia acceder a todo. Fix: Middleware de autenticacion que valida `Authorization: Bearer <token>` en cada request. Endpoints publicos excluidos: login, registro, recuperar password, canjear codigo, check membresia. Responde 401 si token invalido. (`index_wsp.js:797-809`)
27. **Rate limiting en login (CRITICO)**: Sin proteccion contra brute force. Fix: max 5 intentos por IP en 15 minutos (tabla `login_attempts`). Retorna 429 si excede limite. (`index_wsp.js:685-691`)
28. **readBody sin limite de tamano (DoS)**: Podia recibir body infinito y crashear servidor. Fix: limite de 10MB, destruye request si excede. (`index_wsp.js:240-256`)
29. **2FA se desactivaba sin codigo TOTP**: Solo pedia contrasena. Fix: ahora requiere contrasena + codigo 2FA valido para deshabilitar. (`index_wsp.js:2103-2115`, `panel.html:4511-4523`)
30. **Timezone inconsistente en seller invites**: `getSellerInvitesCount` usaba UTC con `toISOString()`. Fix: usa `config.TIMEZONE` con inicio de semana (lunes) o inicio de mes calendario. (`db_wsp.js:2023-2041`)
31. **Memory leak en messages.update handler**: Event listener solo se limpiaba en timeout, no cuando entrega confirmada. Fix: funcion `cleanup()` llamada en ambas ramas (exito y timeout). (`motor_wsp.js:423-442`)
32. **Race condition envioPersonalActivo silenciosa**: Si habia envio activo, retornaba `false` sin informar. Fix: retorna `{ blocked: true, error: "..." }` con mensaje descriptivo. (`motor_wsp.js:1056,1188`)
33. **grupoUltimaActividad se perdia al reiniciar**: Era solo in-memory. Fix: persiste a tabla `grupo_actividad` en DB. Al consultar, busca primero en memoria, luego en DB. (`motor_wsp.js:335-371`, `db_wsp.js:1905-1911`)
34. **Seller invites ventana deslizante vs calendario**: "Semanal" contaba 7 dias hacia atras. Fix: ahora cuenta desde inicio de semana (lunes) o inicio de mes. (`db_wsp.js:2023-2041`)
35. **Recursion infinita en reconexion de cuentas**: Si reconexion fallaba, podia crear N instancias paralelas. Fix: `reconnectLocks` previene reconexiones simultaneas para la misma cuenta. (`motor_wsp.js:38-47,108-121`)
36. **Recovery codes sin cleanup**: Se acumulaban infinitamente. Fix: limpieza automatica cada 30 min (codigos >1h, sesiones >7 dias, intentos >1h). (`index_wsp.js:2426-2433`, `db_wsp.js:1896-1902`)
37. **SW cacheaba panel.html indefinidamente**: Actualizaciones no se veian sin hard refresh. Fix: SW v3 nunca cachea navegacion (panel.html), solo manifest.json. (`sw.js`)
38. **XSS en canjear codigo y 2FA secret**: Datos del servidor se insertaban en innerHTML sin escapar. Fix: se agrego `esc()` en resultados de canjeo y display de 2FA secret. (`panel.html:3926,3930,4530`)

### Mejoras Nuevas
39. **Sistema de Roles**: Admin(acceso total) > Seller(todo excepto admin panel) > Cliente con membresia(todas funciones) > Cliente sin membresia(nada hasta pagar). Sellers tambien pasan `requireMembresia()`. (`panel.html:1654`)
40. **Registro de Auditoria**: Tabla `audit_log` registra logins, cambios de 2FA, acciones admin. Endpoint: `GET /api/admin/auditoria?u=ADMIN_ID&filter_user=X&limit=200`. Seccion nueva en panel: "Auditoria" (admin-only). (`db_wsp.js:558-567,1883-1893`, `index_wsp.js:2336-2345`, `panel.html:1544-1553,4411-4426`)
41. **Panel envia token en cada request**: La funcion `api()` ahora incluye `Authorization: Bearer <token>` en headers. Si recibe 401, hace logout automatico. (`panel.html:1616-1632`)

#### Escaneo Post-Mejoras (Bugs adicionales encontrados)
42. **panel_cambiar_password publico sin auth**: Endpoint era accesible sin token, permitia brute force del old_password. Fix: ahora valida token antes de procesar. (`index_wsp.js:740-751`)
43. **Sin validacion de membresia en servidor**: El panel bloqueaba UI pero el API no verificaba membresia. Clientes con demo expirado podian usar API directamente. Fix: middleware retorna 403 si membresia inactiva (admins/sellers excluidos). (`index_wsp.js:829-851`)
44. **Logout no invalidaba sesion en servidor**: Token seguia valido 7 dias post-logout. Fix: nuevo endpoint `/api/panel_logout` borra sesion del DB. (`index_wsp.js:802-814`, `panel.html:1838-1842`)
45. **Proxy no enviaba X-Forwarded-For**: Rate limiting veia TODAS las conexiones como 127.0.0.1. Un usuario bloqueado = todos bloqueados. Fix: proxy envia IP real del cliente. (`panel_server.js:22-23,32,61`)
46. **Bug double-read en api() con 403**: Cuerpo de response se leia dos veces causando error. Fix: siempre retorna despues del primer parse de 403. (`panel.html:1640-1646`)

---

## Mejoras Futuras (Ideas para Implementar)

### Prioridad Alta
1. ~~**Sistema de pagos automatico (Binance Pay)**~~ — **IMPLEMENTADO** (ver seccion "Sistema de Pagos" abajo)
2. ~~**Sistema de pagos manual (Yape/comprobantes)**~~ — **IMPLEMENTADO** (ver seccion "Sistema de Pagos" abajo)
3. ~~**Notificaciones push reales**~~ — **IMPLEMENTADO** (#52) Web Push API + VAPID keys. Auto-genera keys, push en pagos/tickets/comprobantes.
4. ~~**Panel de analytics avanzado**~~ — **IMPLEMENTADO** (#53) Graficos Chart.js: envios/dia, horas activas, tasa por cuenta.

### Prioridad Media
5. ~~**Sistema de tickets/soporte**~~ — **IMPLEMENTADO** (#54) Bandeja admin + historial conversacion + push notifications.
6. ~~**Rotacion inteligente de cuentas**~~ — **IMPLEMENTADO** (#55) Analisis de tasa por cuenta + recomendaciones automaticas.
7. ~~**Deteccion de ban preventiva**~~ — **IMPLEMENTADO** (#55) Integrado con rate_limit/status, detecta tasa <50%.
8. ~~**Templates con variables**~~ — **IMPLEMENTADO** (#56) {nombre}, {fecha}, {hora}, {random}, {numero}, {grupo} + preview.
9. **Exportar/Importar configuracion completa** — Pendiente. Un solo archivo JSON con toda la config para migrar entre cuentas.
10. ~~**Dashboard de sellers**~~ — **IMPLEMENTADO** (#57) Stats: codigos, clientes activos, tasa conversion, breakdown mensual.

### Prioridad Baja (Ideas Creativas)
11. ~~**Modo vacaciones**~~ — **IMPLEMENTADO** (#58) Pausar/reanudar todas las campanas con 1 click.
12. ~~**Programacion recurrente avanzada**~~ — **IMPLEMENTADO** (#59) Cron-like: dias de semana + hora.
13. ~~**A/B Testing de mensajes**~~ — **IMPLEMENTADO** (#60) Divide grupos 50/50 entre variante A y B.
14. ~~**Auto-limpieza de grupos muertos**~~ — **IMPLEMENTADO** (#61) Detectar + eliminar en batch.
15. ~~**Respaldo automatico diario**~~ — **IMPLEMENTADO** (#62) Copia DB cada 3am, mantiene 7 dias, admin puede forzar.
16. **Integracion con Google Sheets** — Pendiente. Requiere OAuth de Google + API de Sheets.
17. **Multi-idioma para el bot TG** — Pendiente. Detectar locale de Telegram y traducir respuestas.
18. ~~**Rate limiting adaptativo**~~ — **IMPLEMENTADO** (#63) Analiza tasa y recomienda ajustes.
19. ~~**Webhook de eventos**~~ — **IMPLEMENTADO** (#64) CRUD completo + firma HMAC-SHA256.
20. **Panel mobile nativo (React Native)** — Pendiente. PWA actual funciona bien en mobile.

### Mejoras de Infraestructura
21. **Separar panel.html en componentes** — Pendiente. Panel tiene 5500+ lineas, beneficiaria de modularizacion.
22. **Migrar SQLite a PostgreSQL** — Pendiente. Para alta concurrencia futura.
23. ~~**Docker compose**~~ — **IMPLEMENTADO** (#65) Dockerfile + docker-compose.yml con volumes y healthcheck.
24. ~~**CI/CD automatico**~~ — **IMPLEMENTADO** (#66) GitHub Actions: syntax check JS/Python + Docker build.
25. ~~**Monitoreo con alertas**~~ — **IMPLEMENTADO** (#67) GET /api/health publico, compatible con UptimeRobot.

---

## Respuesta a la Pregunta del Handoff

> Si fueras un bug en este codigo, en que archivo te esconderias y por que?

Me esconderia en `index_wsp.js` linea 241 (el `readBody` sin limite) — porque nadie pensaria que una funcion tan pequena de 4 lineas podria tumbar todo el servidor con un solo request de 10GB. Los bugs mas peligrosos se esconden en el codigo mas "simple". 🐛

Chiste: "Un QA entra a un bar y pide 1 cerveza, 0 cervezas, -1 cervezas, 99999 cervezas, NULL cervezas, y un lagarto. El programador no entiende por que pidio un lagarto, pero el QA dice: 'Para verificar que el mesero no se cae con inputs inesperados.'" 🍺

Confirmo que entiendo la arquitectura:
- WSP API (puerto 3000) maneja la logica del bot WhatsApp
- Panel Web (puerto 3001) sirve el frontend y proxea a las APIs
- TG API (puerto 3002) maneja el bot de Telegram
- Las 3 bases de datos SQLite: `wsp_titan.db` y `titan.db`
- Todo se inicia con `bash start.sh` desde `/root/BotSpam1`

## Notas Importantes para la Siguiente IA
1. **panel.html** es monolitico (~5592 lineas). Todo HTML, CSS y JS en un archivo. No separar.
2. Los endpoints API se agregan en `index_wsp.js` **ANTES** de la linea `// Endpoint no encontrado` (buscar esa cadena).
3. Las tablas y funciones de DB se agregan en `db_wsp.js` **ANTES** del `module.exports`.
4. Los nuevos exports se agregan al final del objeto `module.exports` en `db_wsp.js`.
5. `panel_server.js` proxea `/api/*` al puerto 3000 (WSP) y `/api/tg*` al puerto 3002 (TG). NO necesitas modificarlo.
6. Para agregar una nueva seccion al panel: (a) nav en sidebar, (b) `div.section` con `id="sec-NOMBRE"`, (c) funcion de carga JS, (d) agregar al objeto `loaders`.
7. El tema oscuro/claro usa CSS variables: `var(--bg)`, `var(--text)`, etc.
8. Multi-idioma usa `LANG` object. Agregar traducciones para ES, EN y PT.
9. Sellers usan clase CSS `seller-only`. Se muestran si `esSeller || esAdmin`.
10. "Canjear Codigo" es visible para TODOS los usuarios (no necesita ser seller ni admin).
11. **SIEMPRE** actualizar este HANDOFF.md despues de cada mejora o fix.
12. **AUTENTICACION**: Ahora todos los endpoints (excepto los publicos listados en `PUBLIC_ENDPOINTS`) requieren `Authorization: Bearer <token>` en headers. El panel lo envia automaticamente desde localStorage.
13. **AUDITORIA**: Registrar acciones importantes con `db.registrarAuditoria(userId, 'accion', 'detalle', ip)`. El admin puede ver todo en "Auditoria".
14. **RATE LIMIT**: Login tiene max 5 intentos/15min por IP. Para agregar rate limit a otros endpoints, usar el mismo patron con `getLoginAttempts`.
15. **Tablas nuevas**: `login_attempts`, `audit_log`, `grupo_actividad`. Se crean automaticamente al iniciar.

## Tablas de Base de Datos (Actualizadas)
### Tablas WSP (wsp_titan.db) — Nuevas
- `login_attempts` — Rate limiting (ip, telegram_id, success, created_at)
- `audit_log` — Registro de auditoria (user_id, accion, detalle, ip, fecha)
- `grupo_actividad` — Persistencia anti-duplicado (grupo_jid, ultima_actividad)

## Endpoints API Nuevos
| Endpoint | Metodo | Descripcion |
|---|---|---|
| `/api/admin/auditoria` | GET | Logs de auditoria `?u=ADMIN_ID&filter_user=X&limit=200` |

## Sistema de Roles
| Rol | Acceso | Detalles |
|---|---|---|
| Admin | TODO | Ve y usa todas las secciones incluido Admin Panel, Sellers, Auditoria |
| Seller | Todo excepto Admin | Ve todas las funciones + Panel Seller. NO ve Admin Panel ni Sellers ni Auditoria |
| Cliente con membresia | Funciones normales | Usa todas las funciones del bot (campanas, envios, grupos, etc.) |
| Cliente sin membresia | NADA | Ve el panel pero no puede usar ninguna funcion hasta pagar. Demo 1 dia al registrarse |

## Comando de Actualizacion
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777615385-fix-campaigns-chats-layout && npm install && bash start.sh
```

---

## Sistema de Pagos (PR #27 — Nuevo)

### Arquitectura de Pagos
Dos sistemas de pago integrados que comparten la misma UI y auto-activan membresia:

#### 1. Binance Pay (Crypto automatico)
- **Flujo**: Cliente selecciona plan → se crea orden en Binance Pay API → se abre checkout → Binance envia webhook cuando paga → se activa membresia automaticamente → se sincroniza a TG
- **Config**: `config_wsp.js` > `BINANCE_PAY` > `API_KEY` + `API_SECRET` (obtener en merchant.binance.com)
- **Precios USDT**: Cada plan tiene `precio_usdt` en `config_wsp.js` > `PLANES`
- **Firma**: HMAC-SHA512 segun spec de Binance Pay API v2

#### 2. Pago Manual (Yape, Plin, transferencia)
- **Flujo**: Cliente ve metodos de pago con numeros/cuentas → hace el pago → sube foto del comprobante desde el panel → admin ve notificacion → aprueba o rechaza → si aprueba, se activa membresia automaticamente → se sincroniza a TG
- **Imagenes**: Se guardan en carpeta `comprobantes/` con formato `{userId}_{timestamp}.{ext}`
- **Numero para comprobantes**: +51976680776 (configurable desde panel admin)

### Panel del Cliente ("Pagar Membresia")
- Cards con planes disponibles (diario/semanal/mensual) con precios en Soles y USDT
- Boton "Pagar con Crypto" (si Binance configurado) → abre checkout de Binance en nueva pestaña, polling cada 5s para detectar pago
- Boton "Pago Manual" → modal con seleccion de metodo, monto, subida de imagen de comprobante, nota
- Numeros/cuentas con click para copiar al portapapeles
- Historial de pagos del usuario con estado (pendiente/aprobado/rechazado)

### Panel Admin ("Gestion de Pagos")
- **Stats**: Pagos crypto totales (USDT), comprobantes aprobados, pendientes, aprobados hoy
- **Tab Pendientes**: Tabla con comprobantes esperando revision, botones aprobar/rechazar, ver imagen
- **Tab Todos**: Historial completo de comprobantes
- **Tab Crypto**: Historial de pagos Binance Pay con estado
- **Tab Metodos de Pago**: CRUD completo — crear, editar, eliminar, activar/desactivar metodos de pago
  - Tipos: Yape, Plin, Transferencia, Binance P2P, Otro
  - Cada metodo tiene: nombre, valor (numero/wallet), instrucciones, activo/inactivo
  - Se crea Yape por defecto al iniciar

### Endpoints de Pagos
| Endpoint | Metodo | Descripcion |
|---|---|---|
| `/api/pagos/planes` | GET | Lista planes con precios USDT + info si Binance esta habilitado |
| `/api/pagos/crear` | POST | Crea orden de pago en Binance Pay `{plan, u}` |
| `/api/pagos/webhook` | POST | Webhook de Binance Pay (publico, sin auth) — recibe notificacion de pago |
| `/api/pagos/estado` | GET | Estado de un pago `?order=MERCHANT_TRADE_NO` |
| `/api/pagos/historial` | GET | Historial de pagos del usuario `?u=USER_ID` |
| `/api/pagos/consultar` | POST | Consulta estado en Binance API + sync local `{merchant_trade_no}` |
| `/api/admin/pagos` | GET | Admin: todos los pagos crypto + stats `?u=ADMIN_ID` |
| `/api/metodos_pago` | GET | Lista metodos de pago activos (publico) |
| `/api/comprobante/subir` | POST | Cliente sube comprobante `{plan, metodo_pago, monto, imagen_base64, nota, u}` |
| `/api/comprobante/historial` | GET | Historial de comprobantes del usuario `?u=USER_ID` |
| `/api/comprobante/imagen` | GET | Servir imagen del comprobante `?id=ID&admin=ADMIN_ID` |
| `/api/admin/comprobantes` | GET | Admin: todos los comprobantes + stats `?u=ADMIN_ID&filter=pendientes` |
| `/api/admin/comprobante/aprobar` | POST | Admin aprueba comprobante (auto-activa membresia) `{admin_id, id}` |
| `/api/admin/comprobante/rechazar` | POST | Admin rechaza comprobante `{admin_id, id, nota}` |
| `/api/admin/metodos_pago` | GET | Admin: lista todos los metodos `?u=ADMIN_ID` |
| `/api/admin/metodos_pago/crear` | POST | Crear metodo `{admin_id, tipo, nombre, valor, instrucciones}` |
| `/api/admin/metodos_pago/editar` | POST | Editar metodo `{admin_id, id, nombre, valor, instrucciones, activo}` |
| `/api/admin/metodos_pago/eliminar` | POST | Eliminar metodo `{admin_id, id}` |

### Configuracion de Binance Pay
1. Registrarse como merchant en [merchant.binance.com](https://merchant.binance.com)
2. Crear API Key en Developer → API Keys
3. Editar `config_wsp.js`:
```javascript
BINANCE_PAY: {
    API_KEY: "tu-api-key-aqui",
    API_SECRET: "tu-secret-aqui",
    ...
}
```
4. Configurar webhook URL en Binance Merchant Admin: `https://tu-dominio.com/api/pagos/webhook`
5. Reiniciar el bot

### Sync de Pagos a Telegram
Cuando un pago es confirmado (automatico por Binance webhook o manual por admin), se sincroniza la activacion de membresia al bot de Telegram via `POST /api/tg/sync_membresia` en puerto 3002.

---

## Mejoras de PR #27 (Sync + Seguridad + Pagos)

### Sync TG <-> WSP
47. **Bot TG no podia eliminar cuentas WSP**: Faltaba boton y bridge function. Fix: agregado wsp_desvincular en wsp_bridge.py + handlers en bot.py
48. **/desactivar y /ban en TG no sincronizaban a WSP**: Comandos admin solo desactivaban en TG. Fix: agregado sync a WSP via wsp_admin_desactivar/wsp_admin_ban
49. **Llamadas del TG bot al WSP API fallaban 401**: El middleware de auth bloqueaba requests internas del bot TG. Fix: excepcion para requests localhost + header x-internal-service ("telegram-bot")
50. **POST endpoints no verificaban privilegios**: Solo GET validaba que el usuario pidiera sus propios datos. Fix: verifyPostUser() en POST endpoints

### Seguridad Adicional
51. **XSS en admin panel, sellers, codigos**: Datos de usuario insertados en innerHTML sin esc(). Fix: esc() aplicado sistematicamente en todas las generaciones de HTML con datos de usuario

### Mejoras Implementadas (Todas las del HANDOFF Futuras)

#### Prioridad Alta
52. **Notificaciones Push Reales (Web Push API + VAPID)**: Auto-genera VAPID keys, almacena subscripciones por usuario. Envia push en: pago confirmado, comprobante aprobado, nuevo ticket, respuesta a ticket. SW ya tenia handler de push. Panel auto-suscribe al login.
    - Endpoints: `GET /api/push/vapid_key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test`
    - Tabla: `push_subscriptions` (user_id, endpoint, p256dh, auth)
    - Dependencia: `web-push` (npm)

53. **Panel de Analytics Avanzado**: Graficos con Chart.js de: envios por dia (30 dias), horas mas activas (bar chart 0-23h), tabla de tasa de entrega por cuenta con colores (verde/amarillo/rojo).
    - Endpoints: `GET /api/analytics/envios_dia`, `GET /api/analytics/horas_activas`, `GET /api/analytics/tasa_cuenta`, `GET /api/analytics/clientes_activos`
    - Funciones DB: getAnalyticsEnviosPorDia, getAnalyticsHorasActivas, getAnalyticsTasaPorCuenta, getAnalyticsClientesActivos
    - Seccion: sec-analytics ("Analytics Avanzado")

#### Prioridad Media
54. **Sistema de Tickets/Soporte**: Clientes crean tickets con asunto + mensaje, admin ve bandeja de tickets abiertos/todos, historial de conversacion en cada ticket, cerrar tickets.
    - Endpoints: `POST /api/tickets/crear`, `GET /api/tickets`, `GET /api/tickets/mensajes`, `POST /api/tickets/responder`, `POST /api/tickets/cerrar`, `GET /api/admin/tickets`
    - Tablas: `tickets` (user_id, asunto, estado, prioridad, fecha_creado, fecha_cerrado), `ticket_mensajes` (ticket_id, autor_id, es_admin, mensaje, fecha)
    - Secciones: sec-tickets (usuario), sec-admintickets (admin)
    - Push: admin recibe push cuando se crea ticket, usuario recibe push cuando admin responde

55. **Rotacion Inteligente de Cuentas + Deteccion de Ban Preventiva**: El endpoint `/api/rate_limit/status` analiza la tasa de entrega por cuenta y genera recomendaciones. Si una cuenta tiene tasa <50% con >10 envios, recomienda reducir velocidad o cambiar de cuenta.
    - Endpoint: `GET /api/rate_limit/status`

56. **Templates con Variables**: Soporta {nombre}, {fecha}, {hora}, {random}, {numero}, {grupo} en mensajes. Preview endpoint que reemplaza variables. {random} acepta opciones separadas por |.
    - Endpoint: `POST /api/templates/preview`
    - Helper JS: `insertVariable(varName, textareaId)` para insertar variables en textarea

57. **Dashboard de Sellers Avanzado**: Stats con total codigos, usados, pendientes, clientes activos, tasa de conversion, breakdown mensual.
    - Endpoint: `GET /api/seller/dashboard`

#### Prioridad Baja
58. **Modo Vacaciones**: Pausar/reanudar TODAS las campanas del usuario con un solo click. Botones en seccion Analytics.
    - Endpoints: `POST /api/vacaciones/activar`, `POST /api/vacaciones/desactivar`

59. **Programacion Recurrente (cron-like)**: Crear envios recurrentes con patron de dias de semana + hora. Almacena recurrencia como JSON.
    - Endpoint: `POST /api/programados/recurrente`

60. **A/B Testing de Mensajes**: Crear test con variante A y B, divide grupos automaticamente 50/50.
    - Endpoint: `POST /api/ab_test/crear`

61. **Auto-limpieza de Grupos Muertos**: Detectar grupos sin actividad en N dias. Eliminar en batch.
    - Endpoints: `GET /api/grupos/muertos`, `POST /api/grupos/limpiar_muertos`

62. **Respaldo Automatico Diario**: Copia wsp_titan.db a /backups/ cada dia a las 3:00 AM. Mantiene ultimos 7 dias. Admin puede forzar backup manual. Log de backups en DB.
    - Endpoints: `GET /api/admin/backups`, `POST /api/admin/backup_ahora`
    - Tabla: `backup_log` (filename, size_bytes, fecha)
    - Seccion: sec-adminbackups (admin)

63. **Rate Limiting Adaptativo**: Analiza tasa de entrega por cuenta, genera recomendaciones automaticas. Integrado con analytics.

64. **Webhook de Eventos**: Usuarios configuran URLs para recibir notificaciones HTTP POST cuando ocurren eventos (pago confirmado, comprobante aprobado, etc.). Firma HMAC-SHA256 con secret. CRUD completo.
    - Endpoints: `GET /api/webhooks`, `POST /api/webhooks/crear`, `POST /api/webhooks/editar`, `POST /api/webhooks/eliminar`
    - Tabla: `user_webhooks` (user_id, url, eventos, activo, secret)
    - Seccion: sec-webhooks

#### Infraestructura
65. **Docker Compose**: Dockerfile + docker-compose.yml para empaquetar los 3 servicios. Volumes para persistencia. Health check integrado.
66. **CI/CD GitHub Actions**: Workflow en `.github/workflows/ci.yml` — syntax check JS (node -c), syntax check Python (py_compile), verifica archivos requeridos, build Docker image.
67. **Monitoreo/Health Check**: `GET /api/health` (publico) retorna uptime, memoria, estado del bot. Compatible con UptimeRobot y similares.

#### Pagos y Planes (PR #27 — ultimo commit)
68. **QR en Metodos de Pago**: Admin puede subir foto QR de Yape/Plin en cada metodo de pago. Cliente ve el QR al elegir metodo.
    - Endpoints: `POST /api/admin/metodos_pago/qr` (subir QR), `GET /api/metodos_pago/qr?id=X` (servir QR)
    - Columna: `metodos_pago.qr_imagen`
    - Funciones DB: `setMetodoPagoQr()`, `getMetodoPago()`
    - QR se guarda en: `comprobantes/qr_metodo_{id}_{timestamp}.{ext}`

69. **2 opciones de comprobante**: Cliente puede subir comprobante directo en el panel O enviar por WhatsApp (boton directo a wa.me/51976680776).
    - Radio buttons en modal de pago para elegir metodo de entrega

70. **Planes editables por admin**: Solo Semanal (S/15) y Mensual (S/30) por defecto. Admin puede editar precios, dias, agregar/eliminar planes desde panel.
    - Endpoints: `GET /api/admin/planes`, `POST /api/admin/planes/editar`
    - Tabla: `admin_config` (clave TEXT PRIMARY KEY, valor TEXT)
    - Funciones DB: `getPlanes()`, `setPlanes()`, `getAdminConfig()`, `setAdminConfig()`
    - Seccion: Gestion Pagos > tab "Editar Planes"

71. **Header precios dinamicos**: Los precios en el banner de membresia se actualizan automaticamente desde la API.

---

## Bugs Conocidos (Pendientes de Corregir)

### BUG-001: Comprobante/QR imagen no carga en panel — CORREGIDO
- **Donde**: Admin > Gestion Pagos > Pendientes > click "Ver" en comprobante (y QR de metodos de pago)
- **Sintoma**: Modal muestra "Error al cargar imagen" en vez de la foto
- **Causa**: 4 problemas combinados:
  1. **Auth en img tags**: Los tags `<img src="/api/...">` NO envian el header `Authorization`. El middleware devuelve 401 y la imagen nunca carga. Fix: agregar `?token=...` en la URL de cada `<img>` que apunta a endpoints protegidos.
  2. **Directorio no existia**: `comprobantes/` no se creaba automaticamente antes de escribir archivos. Fix: `fs.mkdirSync(compDir, { recursive: true })`.
  3. **Rutas relativas**: Se guardaban como `comprobantes/...` (relativo) pero el servidor podia leerlas desde otro CWD. Fix: usar `path.join(__dirname, "comprobantes")` para rutas absolutas.
  4. **Planes custom no consultados**: El endpoint de subir comprobante solo buscaba en `config.PLANES`, no en la DB de planes editables. Fix: helper `resolvePlan()` que consulta DB primero.
- **Archivos modificados**: `index_wsp.js` (endpoints subir/imagen comprobante + QR), `panel.html` (verComprobante, verQrMetodo, actualizarQrPago)
- **NOTA**: Los comprobantes subidos ANTES del fix tienen path relativo y pueden fallar. Nuevos comprobantes funcionan correctamente.

### BUG-002: Reconnect handler de WSP no reintenta conexion — CORREGIDO
- **Donde**: `motor_wsp.js` — `connectClientAccount()`
- **Sintoma**: Despues de una reconexion exitosa, si la cuenta se desconecta de nuevo, se pierde silenciosamente sin reintento
- **Causa**: El handler de `connection.update` para el socket reconectado (`newSock`) no tenia logica de reconexion, solo limpiaba `clientSessions`
- **Fix**: Refactorizado en funcion `attachConnectionHandler(currentSock)` que se llama recursivamente para cada nuevo socket

### BUG-003: detenerEnvioPersonal no libera slot — CORREGIDO
- **Donde**: `motor_wsp.js` — `detenerEnvioPersonal()`
- **Sintoma**: Despues de cancelar un envio, no se podia iniciar uno nuevo ("already active")
- **Causa**: `task.cancel()` se llamaba pero no se hacia `delete envioPersonalActivo[userId]`, dejando el slot ocupado hasta que el `finally` del task se ejecutara (podia tardar minutos si estaba en un `delay()`)
- **Fix**: Agregar `delete envioPersonalActivo[userId]` inmediatamente despues de `task.cancel()`

### BUG-004: enviarASeleccionados sin await — CORREGIDO
- **Donde**: `index_wsp.js` — endpoints promo send-and-listen (linea ~2091) y resume (linea ~1619)
- **Sintoma**: Si el envio estaba bloqueado, la API respondia `ok: true` en vez de reportar el error
- **Causa**: `motor.enviarASeleccionados()` es async y retorna `{ blocked: true }` cuando hay envio activo, pero se llamaba sin `await` — el resultado era un promise flotante que nunca se chequeaba
- **Fix**: Agregar `await` y chequear `.blocked` antes de responder

### BUG-005: Bot token en documentacion — CORREGIDO
- **Donde**: `HANDOFF.md` linea 31, `handoff_updated.md` linea 11
- **Sintoma**: Token del bot de Telegram commiteado en texto plano en archivos de documentacion
- **Fix**: Reemplazado con referencia a `bot.py` linea 34. Idealmente el token de bot.py tambien deberia moverse a variable de entorno en una futura iteracion.

### BUG-006: Registro aceptaba numeros de telefono en vez de Telegram ID — CORREGIDO
- **Donde**: `panel.html` (formulario registro), `index_wsp.js` (endpoint `/api/panel_registro`)
- **Sintoma**: Un usuario se registro con `+51 930 605 663` (numero de celular) en vez de su Telegram ID numerico. El sistema lo acepto y la cuenta quedaba inutilizable (el bot TG no puede enviar mensajes a un numero de telefono).
- **Fix**: Validacion front y backend — solo acepta digitos puros (sin +, espacios, guiones). Debe ser 5-15 digitos.

### BUG-007: Usuarios con sesion previa saltaban verificacion — CORREGIDO
- **Donde**: `panel.html` (auto-login en window.load)
- **Sintoma**: Usuarios que tenian sesion en localStorage de ANTES de la actualizacion no veian la alerta de verificacion. Podian usar todas las funciones sin verificar.
- **Causa**: `localStorage.getItem('panel_verificado')` retornaba `null` (no existia antes), y el check `!== '0'` evaluaba `null !== '0'` como `true` (verificado).
- **Fix**: Cambiado a `=== '1'` — solo pasa si es explicitamente `'1'`. Null, undefined, '0' = no verificado.

### BUG-008: API no verificaba cuenta en servidor — CORREGIDO
- **Donde**: `index_wsp.js` (middleware de auth)
- **Sintoma**: Aunque el panel mostrara alerta de verificacion, un usuario podia llamar la API directamente (curl/postman) y usar todas las funciones sin verificar.
- **Fix**: Middleware que retorna 403 `cuenta_no_verificada` para usuarios no verificados en TODOS los endpoints (excepto logout, verificar_cuenta, check_membresia, dashboard, notificaciones). Admins excluidos. Frontend `api()` detecta este error y muestra overlay de verificacion automaticamente.

---

## Sistema de Verificacion de Registro (Nuevo)

### Descripcion
Sistema que asegura que solo usuarios reales de Telegram puedan registrarse y usar el panel. Usa codigos unicos generados por el bot de TG.

### Flujo para Nuevos Usuarios
1. Usuario abre el bot de Telegram → envia `/registro`
2. Bot genera codigo unico (ej: `REG-A3K9X2`, expira en 30 min)
3. Usuario va al panel web → Registrarse → ingresa el codigo + contrasena
4. Sistema verifica codigo, extrae el Telegram ID automaticamente → crea la cuenta
5. Un Telegram ID solo puede tener 1 cuenta (enforced por unique constraint)

### Flujo para Usuarios Existentes (No Verificados)
1. Al hacer login, ven pantalla bloqueante "Verifica tu Cuenta" con instrucciones
2. Van al bot TG → `/registro` → obtienen codigo
3. Ingresan codigo en el panel → se marca como verificado
4. A partir de ahi pueden usar todas las funciones normalmente

### Reglas
- **Admin**: Siempre verificado automaticamente (no necesita codigo)
- **Codigo**: Formato `REG-XXXXXX`, expira en 30 minutos, 1 uso
- **1 cuenta por ID**: No se puede crear segunda cuenta con mismo Telegram ID
- **Server-side enforcement**: API retorna 403 si usuario no verificado intenta usar funciones

### Tablas
- `registration_codes` (telegram_id TEXT, code TEXT UNIQUE, created_at TEXT, used INTEGER DEFAULT 0)
- `panel_users.verificado` (INTEGER DEFAULT 0 — columna agregada por migracion)

### Endpoints
| Endpoint | Metodo | Descripcion |
|---|---|---|
| `/api/generar_codigo_registro` | POST | Genera codigo de registro `{telegram_id}` (llamado por bot TG) |
| `/api/verificar_cuenta` | POST | Verifica cuenta existente `{telegram_id, codigo}` |
| `/api/panel_registro` | POST | Registro con codigo `{codigo, password}` (extrae TG ID del codigo) |

### Comandos Bot TG
- `/registro` — Genera codigo unico para registro/verificacion
- `/miid` — Muestra el Telegram ID del usuario

---

## Sistema de Estado de Campanas (Nuevo)

### Descripcion
Las campanas ahora tienen un campo `estado_detalle` que indica su estado preciso, visible en el panel con badges de colores.

### Estados
| Valor | Badge | Color | Significado |
|---|---|---|---|
| `activa` | Activa | Verde | Enviando mensajes activamente |
| `en_reposo` | En reposo | Amarillo (#f39c12) | Termino un ciclo, esperando pausa entre rondas |
| `detenida_actualizacion` | Detenida (actualizacion) | Naranja (#e67e22) | Se detuvo porque el servidor se reinicio/actualizo |
| `detenida` / null | Detenida | Rojo | Detenida manualmente |

### Comportamiento
1. **Al iniciar servidor** (`startBot()`): `marcarCampanasDetenidaPorActualizacion()` marca todas las campanas que estaban activas como `detenida_actualizacion` (activa=0)
2. **Al iniciar campana**: `setCampanaActiva(id, true)` pone estado_detalle = `activa`
3. **Al terminar un ciclo** (pausa entre rondas en `motor_wsp.js`): `setCampanaEstadoDetalle(id, 'en_reposo')`
4. **Al terminar la pausa**: `setCampanaEstadoDetalle(id, 'activa')` (si no fue cancelada)
5. **Al detener manualmente**: `setCampanaActiva(id, false)` pone estado_detalle = `detenida`

### Columna DB
- `campanas.estado_detalle` (TEXT DEFAULT NULL — agregada por migracion automatica)

### Funciones DB
- `setCampanaActiva(campanaId, activa, estado_detalle)` — Ahora acepta 3er parametro opcional
- `setCampanaEstadoDetalle(campanaId, estado_detalle)` — Setter directo
- `marcarCampanasDetenidaPorActualizacion()` — Marca todas las activas como detenidas por actualizacion

### UI
- `getEstadoCampanaBadge(x)` en panel.html — Funcion que retorna el badge HTML correcto segun estado
- Aplica tanto a campanas WSP como TG

### Comportamiento de Auto-Restart (v11)
Cuando el servidor se reinicia/actualiza:
1. `marcarCampanasDetenidaPorActualizacion()` marca campanas activas como `detenida_actualizacion`
2. Despues de que el bot se conecta a WhatsApp, espera **30 segundos** para que WhatsApp sincronice datos de grupos
3. Reinicia las campanas **una por una con 10 segundos de delay** entre cada una (evita conflictos de conexion code 440)
4. El usuario recibe notificacion de cuales se reiniciaron y cuales fallaron
5. Si una campana no tiene cuentas/grupos, se marca como fallida pero las demas continuan

---

## Cambios v11 — Fixes de Campanas, Layout y Eliminacion de Chats (PR #33)

### Bugs Corregidos

#### BUG-009: Campanas quedaban en "Detenida (actualizacion)" permanentemente
- **Donde**: `index_wsp.js` — logica de inicio del bot (`startBot()`)
- **Sintoma**: Al reiniciar el servidor, las campanas activas se marcaban como `detenida_actualizacion` y el usuario tenia que reiniciarlas manualmente una por una
- **Causa**: El codigo solo notificaba al usuario pero NO reiniciaba las campanas automaticamente
- **Fix**: Auto-restart escalonado — espera 30s para sync de WhatsApp, luego reinicia cada campana con 10s de delay entre cada una. Envia notificacion con resultado (reiniciadas/fallidas)

#### BUG-010: Error de ciclo completado mataba la campana entera
- **Donde**: `motor_wsp.js` — reporte de ciclo completado (linea ~872)
- **Sintoma**: Si `getCampanaById()` retornaba null o `getEnviosDiariosTotal()` fallaba, la campana se moria con error no capturado
- **Causa**: No habia try-catch alrededor del bloque de reporte de ciclo ni null checks para datos de campana
- **Fix**: Envuelto en try-catch con null checks (`c ? c.enviados : '?'`). Si falla el reporte, la campana espera el delay de fallback y continua al siguiente ciclo

#### BUG-011: Conexiones WhatsApp paralelas causaban code 440
- **Donde**: `motor_wsp.js` — `getOrConnectClient()`
- **Sintoma**: Cuando multiples campanas usaban la misma cuenta (ej: 'Spam1'), todas intentaban conectar en paralelo. WhatsApp rechazaba las conexiones duplicadas con code 440
- **Causa**: `getOrConnectClient()` no tenia lock — si la primera campana estaba esperando que la conexion se abriera, las demas llamaban `connectClientAccount()` creando sockets duplicados
- **Fix**: Agregado `connectingPromises` (Map de key -> Promise). Si ya hay una conexion en progreso para una cuenta, las demas campanas esperan esa misma Promise en vez de crear conexiones nuevas. Soporta 20+ campanas sin conflictos

#### BUG-012: groupMetadata fallaba demasiado rapido (error_temporal)
- **Donde**: `motor_wsp.js` — `sendToGroup()`
- **Sintoma**: Grupos daban "error_temporal" porque `groupMetadata()` fallaba 2 veces con solo 2s de delay
- **Causa**: WhatsApp necesita mas tiempo para sincronizar datos de grupos despues de conectar. 2 intentos con 2s no era suficiente
- **Fix**: Ahora 3 intentos con delay creciente (3s, 6s, 9s)

### Mejoras de UI

#### Layout de Campanas — Grid Responsivo (4 por fila)
- **Donde**: `panel.html` — CSS + funcion `loadCampanas()`
- **Antes**: Tarjetas en flex-wrap se iban de costado sin limite
- **Despues**: CSS Grid con `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`
- **Media queries**:
  - `>= 1300px`: Exactamente 4 columnas (`repeat(4, 1fr) !important`)
  - `<= 600px`: 1 columna (`1fr !important`)
- **Clase CSS**: `.campanas-grid` (aplicada al contenedor de tarjetas)

### Eliminacion de Funcionalidades

#### Eliminado: Ver Chats WSP (panel completo)
- Sidebar link eliminado
- Seccion HTML `sec-chatswsp` eliminada
- Funciones JS eliminadas: loadChatsWsp, renderChatsWspList, filtrarChatsWsp, iniciarChatWsp, selectChatWsp, enviarMsgChatWsp
- Entradas del objeto `loaders` eliminadas: `chatswsp:loadChatsWsp`
- Endpoints eliminados: `/api/chat/contactos`, `/api/chat/synced`, `/api/chat/mensajes`
- **NO eliminado**: `/api/chat/enviar` (usado por Envio Personal), `/api/chats_personales`, `wsp_chats_personales()`

#### Eliminado: Ver Chats TG (panel + bot)
- Sidebar link eliminado
- Seccion HTML `sec-chatstg` eliminada
- Funciones JS eliminadas: loadChatsTg y relacionadas
- Entradas del objeto `loaders` eliminadas: `chatstg:loadChatsTg`
- Boton "Ver Chats TG" eliminado del menu principal del bot (bot.py)
- Clase ChatTGState eliminada
- Handlers eliminados: cb_tg_ver_chats, cb_tg_chats_cuenta, cb_tg_chat_seleccionado, recibir_respuesta_chat_tg

### Archivos Modificados en v11
| Archivo | Cambios |
|---|---|
| `index_wsp.js` | Auto-restart escalonado con 30s sync + 10s entre campanas; eliminados 3 endpoints de chat |
| `motor_wsp.js` | Connection lock `connectingPromises` en getOrConnectClient; try-catch en ciclo; 3 retries de metadata |
| `panel.html` | CSS grid campanas 4/fila; eliminado sidebar+HTML+JS de Ver Chats WSP y TG; limpieza loaders |
| `bot.py` | Eliminado boton Ver Chats TG del menu; eliminado ChatTGState + 4 handlers |

### Verificacion de Sintaxis v11
```bash
node -c index_wsp.js   # OK
node -c motor_wsp.js   # OK
node -c db_wsp.js      # OK
node -c panel_server.js # OK
python3 -c "import ast; ast.parse(open('bot.py').read())"  # OK
```

---

## REGLAS PARA LA SIGUIENTE IA

### REGLA #1 — NUNCA elimines ninguna mejora existente
Todo lo que esta en este HANDOFF fue implementado y verificado. No eliminar funcionalidades existentes a menos que el usuario lo pida explicitamente. En particular, NO eliminar:
- Sistema de sellers y codigos
- Sistema de pagos (Binance Pay + comprobantes manuales)
- Backup/Restaurar automatico
- Sesiones activas y 2FA
- Dashboard con graficos
- PWA (manifest.json + sw.js)
- Analytics avanzado
- Tickets/Soporte
- Webhooks
- Auto-respuestas
- Sistema de roles
- Auditoria
- Verificacion de registro
- Estados de campana (activa, en_reposo, detenida_actualizacion, detenida)
- Auto-restart escalonado de campanas
- Connection lock en getOrConnectClient
- Grid layout de campanas (4 por fila)

### REGLA #2 — Verifica sintaxis constantemente
```bash
node -c index_wsp.js && node -c motor_wsp.js && node -c db_wsp.js && node -c panel_server.js
python3 -c "import ast; ast.parse(open('bot.py').read())"
```
Ejecuta esto despues de CADA cambio, no solo al final.

### REGLA #3 — No dejes marcadores de conflicto en git
Antes de commitear, verifica: `grep -rn '<<<<<<< \|======= \|>>>>>>> ' *.js *.py *.html`

### REGLA #4 — No toques Envio Personal
El endpoint `/api/chats_personales` y la funcion `wsp_chats_personales` son de Envio Personal, NO de chats. No eliminar.

### REGLA #5 — No force push a main/master
Solo force push a tu propia rama feature.

### REGLA #6 — Actualiza este HANDOFF
Despues de cada mejora o fix, agrega una seccion documentando lo que hiciste SIN borrar nada del contenido anterior.

### REGLA #7 — Comando de actualizacion
Cuando termines de hacer cambios, envia al usuario el comando de actualizacion en este formato:
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/<TU-RAMA> && npm install && bash start.sh
```
Reemplaza `<TU-RAMA>` con el nombre de tu rama.

### REGLA #8 — Ver Chats WSP/TG esta ELIMINADO
No re-implementar la funcionalidad de Ver Chats WSP ni Ver Chats TG. Fue eliminada intencionalmente en v11.
