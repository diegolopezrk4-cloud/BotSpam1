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
1. **panel.html** es monolitico (~4700 lineas). Todo HTML, CSS y JS en un archivo. No separar.
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
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777527661-security-roles-fixes && npm install && bash start.sh
```
