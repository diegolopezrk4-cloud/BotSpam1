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
- **Bot Token**: 8779002740:AAEGu8ML62y0uFAqpbpSwStm7FJBn3d-KMo
- **Admin ID**: 8001675901

## Archivos Principales
| Archivo | Descripcion | Lineas aprox |
|---|---|---|
| `panel.html` | Frontend completo (HTML+CSS+JS en un solo archivo) | ~4580 |
| `index_wsp.js` | API HTTP del bot WSP (todos los endpoints) | ~4620 |
| `db_wsp.js` | Base de datos SQLite WSP (tablas + CRUD) | ~2070 |
| `motor_wsp.js` | Motor de envio WhatsApp | ~74000 |
| `panel_server.js` | Servidor web que sirve panel.html y proxea APIs | ~100 |
| `bot.py` | Bot de Telegram (comandos + API) | ~178000 |
| `motor.py` | Motor de envio Telegram | ~48000 |
| `db.py` | Base de datos SQLite Telegram | ~27000 |
| `manifest.json` | Manifiesto de PWA | ~46 |
| `sw.js` | Service Worker para PWA | ~51 |
| `start.sh` | Script de inicio de todos los servicios | ~50 |

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

#### Fixes de Seguridad y Bugs del REPORTE_BUGS_COMPLETO (28 bugs)

**CRITICOS (Security):**
26. **BUG-C01: API TG sin autenticacion** — web_panel.py tenia 30+ endpoints sin ningun auth check. Fix: middleware `auth_middleware` que bloquea requests que no vienen de localhost (solo acepta requests del proxy panel_server.js).
27. **BUG-C02: Credenciales hardcodeadas** — BOT_TOKEN, API_ID, API_HASH, ADMIN_ID estaban en texto plano en bot.py, motor.py, web_panel.py. Fix: ahora usan `os.environ.get()` con fallback al valor actual.
28. **BUG-C03: Path traversal en sesiones TG** — `get_session_path()` permitia nombres como `../../etc/passwd`. Fix: sanitiza nombre removiendo `/\..`, valida que la ruta resultante este dentro de `sessions/`.
29. **BUG-C04: Upload sin limite de tamaño** — Multipart upload de fotos de campana no tenia limite. Fix: max 10MB con respuesta 413 si se excede.
30. **BUG-C05: Race condition en pago** — Double-click en boton "Activar" duplicaba la membresia. Fix: set `_processed_payments` que previene doble procesamiento del mismo callback.

**ALTOS (Auth/Memory):**
31. **BUG-H01: Memory leak web_login_sessions** — Sesiones de login TG nunca se limpiaban. Fix: tarea de fondo cada 10 min que elimina sesiones > 15 min de antiguedad.
32. **BUG-H03: /api/usuarios/todos sin admin** — Cualquier usuario veia todos los usuarios. Fix: requiere checkAdmin() o ser request local.
33. **BUG-H04: /api/activar y /api/desactivar sin admin** — Cualquier usuario podia activar/desactivar membresias. Fix: checkAdmin() + localhost check.
34. **BUG-H05: /api/activas exponia todas las campanas** — Sin filtro por usuario. Fix: no-admin solo ve sus propias campanas.
35. **BUG-H06: Debug endpoints expuestos** — `/api/debug_miembros` y `/api/debug_test_send` sin auth. Fix: requiere checkAdmin().
36. **BUG-H07: Lista negra TG era stub** — Los endpoints retornaban siempre vacio. Fix: tabla `lista_negra_tg` en db.py + CRUD real implementado.
37. **BUG-H08: Campana TG sin verificar membresia** — Usuarios expirados podian lanzar campanas. Fix: verifica `activo` y `fecha_expira` antes de iniciar.

**MEDIOS:**
38. **BUG-M01: parseInt sin validacion** — NaN podia romper SQL. Fix: fallbacks `|| defaultValue` en todos los parseInt criticos.
39. **BUG-M02: Reconexion sin backoff** — Inundaba Telegram con reconexiones. Fix: backoff exponencial (2s, 4s, 8s, 16s) con max 4 intentos.
40. **BUG-M03: mensajes_respondidos crecia infinitamente** — Set que nunca se limpiaba. Fix: al llegar a 5000, elimina los 3000 mas antiguos (mantiene los 2000 mas recientes).
41. **BUG-M04: delete campana_sesiones sin filtro** — `eliminar_sesion` borraba sesiones de TODOS los usuarios. Fix: subquery filtra por user_id.
42. **BUG-M07: Recovery codes sin expiracion** — Codigos viejos nunca se limpiaban. Fix: cleanup de codigos > 10 min al crear nuevos.
43. **BUG-M08: Fotos de campana no se eliminan** — Al borrar campana, la imagen quedaba en disco. Fix: `fs.unlinkSync()` de la imagen antes de borrar de DB.

**BAJOS:**
44. **BUG-L04: Stack traces expuestos** — panel_server.js enviaba `e.message` al cliente. Fix: log a console, mensaje generico al cliente.
45. **BUG-L05: ReporteDiario sin cleanup** — Al banear usuario, el setInterval seguia corriendo. Fix: `detenerReporteDiario()` al desactivar usuario.

**EXTRAS:**
46. **enviarAPersonales sin guardar progreso** — El for-of no guardaba progreso al cancelar. Fix: convertido a for indexado con `guardarProgresoEnvio()` antes del break.
47. **readBody sin limite** — El parser JSON del API no tenia limite de tamaño. Fix: max 10MB.
48. **Proxy sin X-Forwarded-For** — panel_server.js no pasaba IP del cliente a los backends. Fix: header `x-forwarded-for` en ambos proxies.

#### Fixes de Campañas y Panel (Session 4 — 5 bugs)

49. **Campañas zombie tras reinicio** — Cuando el bot se reinicia (update/crash), las campañas activas en la BD quedaban con `activa=1` pero sin tarea en memoria (`tareasActivas` vacio). El usuario veia "Activa" pero la campana no enviaba nada. Fix: al conectar el bot (`connection === "open"`), `db.resetZombieCampanas()` detecta campanas con `activa=1`, las resetea a `activa=0`, y notifica a cada usuario via WhatsApp con la lista de campanas detenidas. (`index_wsp.js:2467-2495`, `db_wsp.js:870-880`)

50. **botSock null crasheaba campañas silenciosamente** — `iniciarCampana()` usaba `botSock.sendMessage(userId, ...)` directamente. Si botSock era null (bot no conectado), el error era atrapado por el catch generico y la campana terminaba sin feedback al usuario. Fix: nuevo helper `notificarUsuario(botSock, userId, text)` que: (a) si botSock es null, no hace nada (no crashea), (b) resuelve userId a JID automaticamente, (c) envuelve en try-catch. Reemplazados los 12 `botSock.sendMessage` dentro de la campana. (`motor_wsp.js:494-512`)

51. **Iniciar campaña sin validación previa** — `/api/iniciar` no verificaba si la campana tenia cuentas o grupos asignados antes de llamar a `motor.iniciarCampana()`. La campana se marcaba como iniciada pero fallaba silenciosamente adentro. Fix: endpoint ahora valida `sesiones.length` y `grupos.length` antes de iniciar, devuelve error descriptivo ("Campana sin cuentas asignadas. Edita la campana y asigna al menos una cuenta."). Tambien detecta si la campana ya esta corriendo (HTTP 409). Panel muestra warning visual si una campana tiene 0 cuentas o 0 grupos. (`index_wsp.js:421-431`, `panel.html:2558`)

52. **Botón Detener siempre mostraba "Detenida"** — `detenerCamp()` en el frontend ignoraba la respuesta del API y siempre mostraba toast("Detenida", "success"). Si habia un error de red o del servidor, el usuario no lo sabia. Fix: ahora verifica `r.ok` y muestra el error si falla. (`panel.html:2570`)

53. **Dropdown "Cargar mensaje guardado" vacio + mensajes sin texto** — `refreshPlantillasSelect()` usaba `m.texto` para acceder al contenido del mensaje, pero la columna en la BD es `mensaje` (no `texto`). Resultado: el dropdown mostraba nombres pero al seleccionar uno, el textarea quedaba vacio. Mismo bug en: tabla de mensajes (`loadMensajes`), modal de editar mensaje, y cards de Envio Unico. Tambien eliminada duplicacion (antes cargaba `/api/mensajes` + `/api/plantillas` que retornan los mismos datos). Fix: cambiado `m.texto` a `m.mensaje` en todas las instancias. (`panel.html:2504,2509,2520,2759-2768`)

54. **Campana iniciaba pero no mostraba errores** — Si la campana fallaba internamente (error conectando cuentas, error de red, error inesperado), el catch generico solo hacia `console.error()` sin notificar al usuario. El usuario veia "Iniciada" pero nada pasaba y no sabia por que. Fix: (a) Error fatal del catch generico ahora envia notificacion WhatsApp al usuario con el error. (b) Cada paso critico ahora escribe a `bot_logs` via `db.agregarLog()` para que sea visible en el panel "Registros del Bot". (c) Errores de conexion de cuenta ahora notifican al usuario via WhatsApp. (`motor_wsp.js:526-571,815-817`)

55. **Notificacion zombie: delay de 5s para estabilidad** — El codigo de deteccion zombie se ejecutaba inmediatamente al abrir conexion, pero el socket podia no estar 100% listo para enviar mensajes. Fix: se agrego `await delay(5000)` antes de detectar zombies + log de cuantas campanas zombie se encontraron. (`index_wsp.js:2479-2482`)

---

## ERRORES PENDIENTES POR CORREGIR (PRIORIDAD ALTA)

### ERROR 1: Campana conecta cuentas pero NO envia mensajes a grupos
- **Estado**: Las campanas inician correctamente, las cuentas se conectan OK (visible en Logs del Bot), pero los mensajes NO se envian a los grupos
- **Evidencia**: Los logs muestran `Cuenta '907' conectada OK` pero despues NO aparecen logs de envio a grupos. La Cola de Reintentos muestra 84 mensajes pendientes
- **Donde investigar**:
  - `motor_wsp.js` lineas 598-770 — El bucle de envio (`while (!cancelled)`) que itera sobre grupos
  - `motor_wsp.js` linea 654 — `grupoTieneActividadNueva()` puede estar bloqueando TODOS los grupos (anti-duplicado). Si el bot reinicio y no hay actividad registrada en memoria, podria saltar todos los grupos
  - `motor_wsp.js` linea 665 — `sendToGroup()` puede estar fallando silenciosamente
  - `motor_wsp.js` linea 641 — `resolveGroupJid()` puede retornar null si los links de grupos son invalidos
- **Solucion sugerida**: Agregar `db.agregarLog()` dentro del bucle de envio (al intentar cada grupo, al resolver JID, al enviar) para ver EXACTAMENTE donde se corta. Posible fix: revisar si `grupoTieneActividadNueva` esta saltando todos los grupos despues de un reinicio
- **Archivos**: `motor_wsp.js` (lineas 598-770)

### ERROR 2: Cola de Reintentos tiene 84 mensajes pendientes sin procesarse
- **Estado**: La cola muestra 84 Pendientes, 0 Reenviados, 0 Fallidos
- **Donde investigar**:
  - `motor_wsp.js` funcion `iniciarRetryProcessor()` — Verifica que este corriendo
  - `db_wsp.js` funcion `getRetryPendientesGlobal()` — Puede que `proximo_intento <= datetime('now')` este mal (timezone?)
  - Los reintentos solo se agregan en `enviarAPersonales` y `enviarAMiembros` (lineas 1117, 1317 de motor_wsp.js), NO en campanas. Los 84 pendientes podrian ser de envios personales fallidos
- **Archivos**: `motor_wsp.js`, `db_wsp.js`

### ERROR 3: Bot no notifica al usuario cuando se detiene por actualizacion
- **Estado**: El codigo de deteccion zombie existe (index_wsp.js:2477-2504) y tiene delay de 5s, pero el usuario reporta que no recibe la notificacion WhatsApp
- **Posibles causas**:
  - Las campanas ya estaban en `activa=0` al momento del reinicio (el usuario las detuvo antes de actualizar)
  - `botSock.onWhatsApp(uid + "@s.whatsapp.net")` falla para el ID del usuario
  - El `resetZombieCampanas()` se ejecuta pero no encuentra campanas activas
- **Donde investigar**: `index_wsp.js` lineas 2477-2504, verificar que la deteccion zombie este corriendo revisando los logs de consola al inicio del bot
- **Archivos**: `index_wsp.js`

---

## QUE NO TOCAR (NO CAMBIAR NADA DE ESTO)

### Funcionalidades que YA funcionan correctamente:
1. **Sistema de Sellers/Revendedores** — Crear sellers, generar codigos, canjear codigos, activar membresias. NO tocar endpoints `/api/admin/sellers/*`, `/api/seller/*`, `/api/canjear_codigo`
2. **Login/Registro/2FA** — Autenticacion completa con TOTP. NO tocar `/api/panel_login`, `/api/2fa/*`
3. **Sesiones activas** — Ver/cerrar sesiones. NO tocar `/api/panel_sessions`
4. **PWA** — manifest.json, sw.js, install prompt. NO tocar
5. **Dashboard** — Graficos, estadisticas. NO tocar sec-dashboard ni `/api/dashboard`
6. **Grupos WSP/TG** — Busqueda, orden, secciones. NO tocar
7. **Mensajes y Plantillas** — CRUD de mensajes. NO tocar (ya corregido `m.texto` → `m.mensaje`)
8. **Envio Unico** — NO tocar
9. **Envio Personal** — Ya soporta lotes. NO tocar
10. **Envio a Miembros** — Pausa/reanudar, lotes. NO tocar
11. **Envio Interactivo/Promo** — Plantillas, filtro pais, Todo en Uno. NO tocar
12. **Programados** — NO tocar
13. **Auto-Responder** — NO tocar
14. **Backup/Restaurar** — Ya corregido importFullConfig. NO tocar
15. **Lista Negra** — NO tocar
16. **Logs del Bot** — Funciona, muestra logs de campana. NO tocar
17. **Multi-idioma** — ES/EN/PT. NO tocar
18. **Modo Oscuro/Claro** — NO tocar

### Archivos que NO se deben modificar (a menos que sea para corregir los errores de arriba):
- `panel_server.js` — Funciona perfecto, NO tocar
- `sw.js` — Service Worker OK
- `manifest.json` — PWA OK
- `start.sh` — Script de inicio OK
- `config_wsp.js` — Config OK
- `bot.py` — Bot TG (solo modificar si hay bug TG)
- `motor.py` — Motor TG (solo modificar si hay bug TG)
- `db.py` — DB TG (solo modificar si hay bug TG)

### Reglas estrictas:
- **NO refactorizar** — Solo corregir los 3 errores de arriba
- **NO separar panel.html** — Es monolitico y asi se queda
- **NO cambiar nombres de funciones** existentes
- **NO eliminar** ningun endpoint existente
- **NO cambiar** la estructura de tablas existentes
- **Si agregas un endpoint**, va ANTES de `// Endpoint no encontrado` en index_wsp.js
- **Despues de CADA fix**, actualizar este HANDOFF.md

---

## Notas Importantes para la Siguiente IA
1. **panel.html** es monolitico (~4580 lineas). Todo HTML, CSS y JS en un archivo. No separar.
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

## Historial de Comandos de Actualizacion

### PR #23 — Sistema de Sellers + Mejoras
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777514912-country-filter-mejoras && npm install && bash start.sh
```

### PR #30 — Fix Campanas + Bugs #49-55 (ACTUAL)
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777583803-fix-campaign-bugs && npm install && bash start.sh
```

### Comando general para volver a main (si algo se rompe)
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/main && npm install && bash start.sh
```
