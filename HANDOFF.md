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
| `panel.html` | Frontend completo (HTML+CSS+JS en un solo archivo) | ~5000 |
| `index_wsp.js` | API HTTP del bot WSP (todos los endpoints) | ~5100 |
| `db_wsp.js` | Base de datos SQLite WSP (tablas + CRUD) | ~2375 |
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

### PR #23 — Sistema de Sellers

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
| 32 | **Canjear Codigo** | sec-canjear | Ambas | Canjear codigo de membresia (visible para todos) |
| 33 | **Panel Seller** | sec-sellerpanel | seller-only | Generar codigos + activar membresias |
| 34 | Admin Panel | sec-admin | admin-only | Gestion de usuarios |
| 35 | **Sellers** | sec-sellers | admin-only | Crear/editar/eliminar sellers |
| 36 | Logs Global | sec-adminlogs | admin-only | Logs de todos los usuarios |
| 37 | **Pagar Membresia** | sec-pagos | Ambas | Pagar con Binance Pay o comprobante manual |
| 38 | **Gestion de Pagos** | sec-adminpagos | admin-only | Ver/aprobar comprobantes, stats, config metodos de pago |

## Endpoints API Completos
### Sellers
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

### Pagos
| Endpoint | Metodo | Descripcion |
|---|---|---|
| `/api/pagos/planes` | GET | Lista planes con precios USDT + info si Binance esta habilitado |
| `/api/pagos/crear` | POST | Crea orden de pago en Binance Pay `{plan, u}` |
| `/api/pagos/webhook` | POST | Webhook de Binance Pay (publico, sin auth) |
| `/api/pagos/estado` | GET | Estado de un pago `?order=MERCHANT_TRADE_NO` |
| `/api/pagos/historial` | GET | Historial de pagos del usuario `?u=USER_ID` |
| `/api/pagos/consultar` | POST | Consulta estado en Binance API `{merchant_trade_no}` |
| `/api/admin/pagos` | GET | Admin: todos los pagos crypto + stats `?u=ADMIN_ID` |
| `/api/metodos_pago` | GET | Lista metodos de pago activos (publico) |
| `/api/comprobante/subir` | POST | Cliente sube comprobante `{plan, metodo_pago, monto, imagen_base64, nota, u}` |
| `/api/comprobante/historial` | GET | Historial de comprobantes del usuario `?u=USER_ID` |
| `/api/comprobante/imagen` | GET | Servir imagen del comprobante `?id=ID&admin=ADMIN_ID` |
| `/api/admin/comprobantes` | GET | Admin: todos los comprobantes + stats `?u=ADMIN_ID&filter=pendientes` |
| `/api/admin/comprobante/aprobar` | POST | Admin aprueba comprobante `{admin_id, id}` |
| `/api/admin/comprobante/rechazar` | POST | Admin rechaza comprobante `{admin_id, id, nota}` |
| `/api/admin/metodos_pago` | GET | Admin: lista todos los metodos `?u=ADMIN_ID` |
| `/api/admin/metodos_pago/crear` | POST | Crear metodo `{admin_id, tipo, nombre, valor, instrucciones}` |
| `/api/admin/metodos_pago/editar` | POST | Editar metodo `{admin_id, id, nombre, valor, instrucciones, activo}` |
| `/api/admin/metodos_pago/eliminar` | POST | Eliminar metodo `{admin_id, id}` |
| `/api/admin/metodos_pago/qr` | POST | Subir QR `{admin_id, id, imagen_base64}` |
| `/api/metodos_pago/qr` | GET | Servir QR `?id=X` |
| `/api/admin/planes` | GET | Lista planes editables `?u=ADMIN_ID` |
| `/api/admin/planes/editar` | POST | Editar planes `{admin_id, planes}` |

### Endpoints Anteriores (sin cambios)
- Auth: `/api/panel_login`, `/api/panel_registro`, `/api/check_membresia`, `/api/panel_cambiar_password`, `/api/panel_recuperar_solicitar`, `/api/panel_recuperar_reset`, `/api/panel_logout`
- Grupos: `/api/grupos`, `/api/grupos/add`, `/api/grupos/del`, `/api/grupos/delall`, `/api/grupos/seccion`, `/api/grupos/secciones`
- Campanas: `/api/campanas`, `/api/campanas/crear`, `/api/campanas/del`, `/api/campanas/editar`, `/api/iniciar`, `/api/detener`
- Envios: `/api/historial`, `/api/dashboard`, `/api/dashboard/extended`, `/api/reporte_diario`, `/api/tasa_entrega`, `/api/envios_chart`, `/api/limites`
- 2FA: `/api/2fa/setup`, `/api/2fa/verify`, `/api/2fa/enable`, `/api/2fa/disable`, `/api/2fa/status`
- Sesiones: `/api/panel_sessions`, `/api/panel_sessions/close`
- Backup: `/api/config/exportar`, `/api/config/importar`
- Admin: `/api/admin/usuarios`, `/api/admin/membresia`, `/api/admin/desactivar`, `/api/admin/set_admin`, `/api/admin/auditoria`
- Promo: `/api/promo/plantillas`, `/api/promo/plantillas/crear`, `/api/promo/plantillas/editar`, `/api/promo/plantillas/eliminar`
- Analytics: `/api/analytics/envios_dia`, `/api/analytics/horas_activas`, `/api/analytics/tasa_cuenta`, `/api/analytics/clientes_activos`
- Tickets: `/api/tickets/crear`, `/api/tickets`, `/api/tickets/mensajes`, `/api/tickets/responder`, `/api/tickets/cerrar`, `/api/admin/tickets`
- Push: `/api/push/vapid_key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/test`
- Templates: `/api/templates/preview`
- Seller Dashboard: `/api/seller/dashboard`
- Vacaciones: `/api/vacaciones/activar`, `/api/vacaciones/desactivar`
- Programados Recurrente: `/api/programados/recurrente`
- A/B Testing: `/api/ab_test/crear`
- Grupos Muertos: `/api/grupos/muertos`, `/api/grupos/limpiar_muertos`
- Backups Admin: `/api/admin/backups`, `/api/admin/backup_ahora`
- Rate Limit: `/api/rate_limit/status`
- Webhooks: `/api/webhooks`, `/api/webhooks/crear`, `/api/webhooks/editar`, `/api/webhooks/eliminar`
- Health: `/api/health`
- Verificacion: `/api/generar_codigo_registro`, `/api/verificar_cuenta`

## Tablas de Base de Datos
### Tablas WSP (wsp_titan.db)
- `usuarios` — Usuarios WSP (plan, fecha_expira, activo, es_admin)
- `sesiones` — Cuentas WSP vinculadas
- `campanas` — Campanas de envio (con `estado_detalle`)
- `grupos` — Grupos (con seccion y tamano)
- `templates` — Plantillas de mensajes
- `blacklist` — Lista negra de grupos
- `blacklist_numeros` — Lista negra de numeros
- `historial_envios` — Historial de envios
- `panel_users` — Usuarios del panel web (con `verificado`)
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
- `sellers` — Revendedores
- `seller_invites` — Invitaciones de sellers
- `seller_codes` — Codigos de activacion
- `pagos` — Pagos con Binance Pay
- `comprobantes` — Comprobantes de pago manual
- `metodos_pago` — Metodos de pago configurables por admin
- `login_attempts` — Rate limiting (ip, telegram_id, success, created_at)
- `audit_log` — Registro de auditoria (user_id, accion, detalle, ip, fecha)
- `grupo_actividad` — Persistencia anti-duplicado (grupo_jid, ultima_actividad)
- `push_subscriptions` — Subscripciones push (user_id, endpoint, p256dh, auth)
- `tickets` — Tickets de soporte (user_id, asunto, estado, prioridad)
- `ticket_mensajes` — Mensajes de tickets (ticket_id, autor_id, es_admin, mensaje)
- `user_webhooks` — Webhooks de usuario (user_id, url, eventos, activo, secret)
- `backup_log` — Log de backups (filename, size_bytes, fecha)
- `admin_config` — Configuracion admin (clave, valor)
- `registration_codes` — Codigos de registro (telegram_id, code, created_at, used)

## Flujo del Sistema de Sellers
1. **Admin** crea un seller en Admin > Sellers (Telegram ID, nombre, limite, periodo, plan)
2. **Seller** inicia sesion y ve "Panel Seller" en el sidebar
3. **Seller** tiene 2 opciones:
   - **Generar codigos**: Crea codigos como `VIP-A3X9K2`, se los da a sus clientes
   - **Activar directo**: Si tiene el Telegram ID, activa la membresia directamente
4. **Cliente** va a "Canjear Codigo" en su panel, ingresa el codigo y se activa su membresia
5. El limite se descuenta: codigos pendientes + usados en el periodo cuentan contra el limite
6. El contador se resetea automaticamente cada semana o mes segun configuracion del admin

## Sistema de Roles
| Rol | Acceso | Detalles |
|---|---|---|
| Admin | TODO | Ve y usa todas las secciones incluido Admin Panel, Sellers, Auditoria |
| Seller | Todo excepto Admin | Ve todas las funciones + Panel Seller. NO ve Admin Panel ni Sellers ni Auditoria |
| Cliente con membresia | Funciones normales | Usa todas las funciones del bot (campanas, envios, grupos, etc.) |
| Cliente sin membresia | NADA | Ve el panel pero no puede usar ninguna funcion hasta pagar. Demo 1 dia al registrarse |

## Sistema de Pagos (PR #27)

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

## Sistema de Verificacion de Registro

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
- **Admin**: Siempre verificado automaticamente
- **Codigo**: Formato `REG-XXXXXX`, expira en 30 minutos, 1 uso
- **1 cuenta por ID**: No se puede crear segunda cuenta con mismo Telegram ID
- **Server-side enforcement**: API retorna 403 si usuario no verificado

## Sistema de Estado de Campanas

### Estados
| Valor | Badge | Color | Significado |
|---|---|---|---|
| `activa` | Activa | Verde | Enviando mensajes activamente |
| `en_reposo` | En reposo | Amarillo (#f39c12) | Termino un ciclo, esperando pausa entre rondas |
| `detenida_actualizacion` | Detenida (actualizacion) | Naranja (#e67e22) | Se detuvo porque el servidor se reinicio/actualizo |
| `detenida` / null | Detenida | Rojo | Detenida manualmente |

### Comportamiento
1. **Al iniciar servidor** (`startBot()`): `marcarCampanasDetenidaPorActualizacion()` marca todas las campanas activas como `detenida_actualizacion` (activa=0)
2. **Al iniciar campana**: `setCampanaActiva(id, true)` pone estado_detalle = `activa`
3. **Al terminar un ciclo**: `setCampanaEstadoDetalle(id, 'en_reposo')`
4. **Al terminar la pausa**: `setCampanaEstadoDetalle(id, 'activa')` (si no fue cancelada)
5. **Al detener manualmente**: `setCampanaActiva(id, false)` pone estado_detalle = `detenida`

### Columna DB
- `campanas.estado_detalle` (TEXT DEFAULT NULL — agregada por migracion automatica)

### Funciones DB
- `setCampanaActiva(campanaId, activa, estado_detalle)` — Acepta 3er parametro opcional
- `setCampanaEstadoDetalle(campanaId, estado_detalle)` — Setter directo
- `marcarCampanasDetenidaPorActualizacion()` — Marca todas las activas como detenidas por actualizacion

### UI
- `getEstadoCampanaBadge(x)` en panel.html — Retorna badge HTML correcto segun estado

---

## Bugs Corregidos (Escaneo Profundo)
1. **Code gen excedia limite**: Si seller pedia 5 codigos con 8/10 usados, generaba 5 (total 13). Fix: se capea `cantidad` a `disponibles = max - (usados + pendientes)`.
2. **Invitar directo no contaba codigos pendientes**: El endpoint `/api/seller/invitar` solo contaba invites directos, no codigos pendientes. Fix: ahora cuenta ambos.
3. **eliminarSeller no borraba codigos**: Al eliminar un seller, se borraban invites pero no seller_codes (quedaban huerfanos). Fix: se agrego `DELETE FROM seller_codes`.
4. **generarSellerCode podia fallar silenciosamente**: Si los 20 intentos de generar codigo unico fallaban, insertaba un duplicado y crasheaba. Fix: 50 intentos + throw Error explicito si falla.
5. **importFullConfig usaba columnas INCORRECTAS (backup import 100% roto)**: La funcion `importFullConfig()` en `db_wsp.js` tenia TODOS los INSERT con nombres de columnas que NO existian en las tablas reales. El `catch(_){}` ocultaba todos los errores. Columnas corregidas: grupos, templates, blacklist, auto_respuestas, user_envio_config.
6. **getSellerInvitesCount formato de fecha incorrecto**: Usaba `toISOString()` que genera `2026-04-23T02:41:28.000Z` pero SQLite `datetime('now')` genera `2026-04-23 02:41:28`. Fix: se formatea a `YYYY-MM-DD HH:MM:SS`.
7. **invites_usados no incluia codigos pendientes en dashboard**: Los endpoints `/api/seller/info` y `/api/admin/sellers` solo mostraban invites directos en `invites_usados`. Fix: ahora `invites_usados = usados + pendientes`.

#### Bugfixes y Mejoras
8. **Mensajes guardados no cargaban en promo Todo en Uno**: Habia dos elementos con `id="promoPlantillaSelect"`. Fix: renombrado a `promoMsgSelect`.
9. **Pregunta del handoff ahora es random/graciosa**
10. **Preguntas random para promo**: Boton "Pregunta Random" en seccion Todo en Uno.
11. **not_member eliminaba grupos agresivamente**: `sendToGroup` trataba CUALQUIER error de metadata como "not_member". Ahora: reintenta 1 vez, solo elimina si error es "not-authorized/forbidden/404".
12. **Pausa/Reanudar en promo Todo en Uno**: Boton "Pausar" y barra de reanudacion.
13. **Promo usa config de envio del usuario**: Respeta `lote_tamano` y `lote_pausa_seg`.
14. **Fix scanning loop**: `linkAccount` limpia sockets viejos antes de reintentar.
15. **enviarAPersonales ahora soporta lotes**: Lee `getUserEnvioConfig()` para batch/delay.
16. **Fix promoResumeBar CSS duplicado**: `display:none` duplicado pisaba `align-items:center`.
17. **Anti-duplicado mejorado entre campanas**: Ventana de 30 min. Campanas diferentes con mensajes distintos SI envian al mismo grupo.

#### Escaneo Exhaustivo Linea por Linea
18. **Socket leak en connectClientAccount timeout**: Fix: `sock.end()` antes del reject. (`motor_wsp.js:121`)
19. **esGrupoReal filtraba announce groups**: Fix: se quito el filtro. (`motor_wsp.js:466`)
20. **Scheduler hardcodeaba "America/Lima"**: Fix: `config.TIMEZONE`. (`motor_wsp.js:1379,1396`)
21. **Delivery handler leak en sendToGroup**: Fix: `off()` en ambas ramas. (`motor_wsp.js:418-422`)
22. **enviar_miembros ignoraba config de lotes**: Fix: lee `getUserEnvioConfig()`. (`index_wsp.js:1213-1215`)
23. **enviar_miembros_reanudar ignoraba config de lotes**: Fix: lee `getUserEnvioConfig()`. (`index_wsp.js:1414-1416`)
24. **Promo enviar_y_escuchar no procesaba JIDs correctamente**: Fix: procesamiento completo con blacklist, dedup, LID filter. (`index_wsp.js:1838-1863`)
25. **XSS en 4 secciones de innerHTML sin esc()**: Fix: `esc()` en loadTgDetectar, loadEnvioPersonal, loadEnvioMiembros, loadPromoCuentas. (`panel.html:2273,2787,2881,3517`)

#### Escaneo de Seguridad Profundo
26. **SIN AUTENTICACION EN API (CRITICO)**: Fix: Middleware `Authorization: Bearer <token>`. (`index_wsp.js:797-809`)
27. **Rate limiting en login (CRITICO)**: Fix: max 5 intentos por IP en 15min. (`index_wsp.js:685-691`)
28. **readBody sin limite de tamano (DoS)**: Fix: limite 10MB. (`index_wsp.js:240-256`)
29. **2FA se desactivaba sin codigo TOTP**: Fix: requiere contrasena + codigo 2FA. (`index_wsp.js:2103-2115`)
30. **Timezone inconsistente en seller invites**: Fix: usa `config.TIMEZONE`. (`db_wsp.js:2023-2041`)
31. **Memory leak en messages.update handler**: Fix: `cleanup()` en ambas ramas. (`motor_wsp.js:423-442`)
32. **Race condition envioPersonalActivo silenciosa**: Fix: retorna `{ blocked: true, error }`. (`motor_wsp.js:1056,1188`)
33. **grupoUltimaActividad se perdia al reiniciar**: Fix: persiste a tabla `grupo_actividad`. (`motor_wsp.js:335-371`, `db_wsp.js:1905-1911`)
34. **Seller invites ventana deslizante vs calendario**: Fix: cuenta desde inicio de semana/mes. (`db_wsp.js:2023-2041`)
35. **Recursion infinita en reconexion**: Fix: `reconnectLocks`. (`motor_wsp.js:38-47,108-121`)
36. **Recovery codes sin cleanup**: Fix: limpieza automatica cada 30 min. (`index_wsp.js:2426-2433`)
37. **SW cacheaba panel.html indefinidamente**: Fix: SW v3 nunca cachea navegacion. (`sw.js`)
38. **XSS en canjear codigo y 2FA secret**: Fix: `esc()` en resultados. (`panel.html:3926,3930,4530`)

### Mejoras de Seguridad y Roles
39. **Sistema de Roles**: Admin > Seller > Cliente con membresia > Cliente sin membresia. (`panel.html:1654`)
40. **Registro de Auditoria**: Tabla `audit_log`. Endpoint `GET /api/admin/auditoria`. (`db_wsp.js:558-567`, `index_wsp.js:2336-2345`)
41. **Panel envia token en cada request**: `api()` incluye `Authorization: Bearer <token>`. (`panel.html:1616-1632`)
42. **panel_cambiar_password publico sin auth**: Fix: valida token antes de procesar.
43. **Sin validacion de membresia en servidor**: Fix: middleware retorna 403. (`index_wsp.js:829-851`)
44. **Logout no invalidaba sesion**: Fix: endpoint `/api/panel_logout`. (`index_wsp.js:802-814`)
45. **Proxy no enviaba X-Forwarded-For**: Fix: proxy envia IP real. (`panel_server.js:22-23,32,61`)
46. **Bug double-read en api() con 403**: Fix: retorna despues del primer parse. (`panel.html:1640-1646`)

### Sync TG <-> WSP (PR #27)
47. **Bot TG no podia eliminar cuentas WSP**: Fix: wsp_desvincular en wsp_bridge.py
48. **/desactivar y /ban en TG no sincronizaban a WSP**: Fix: sync via wsp_admin_desactivar/wsp_admin_ban
49. **Llamadas del TG bot al WSP API fallaban 401**: Fix: excepcion para requests localhost
50. **POST endpoints no verificaban privilegios**: Fix: verifyPostUser() en POST endpoints
51. **XSS en admin panel, sellers, codigos**: Fix: esc() aplicado sistematicamente

### Mejoras Implementadas (Todas las futuras completadas)
52. **Notificaciones Push Reales (Web Push API + VAPID)**: Endpoints push, tabla push_subscriptions, dependencia web-push
53. **Panel de Analytics Avanzado**: Chart.js envios/dia, horas activas, tasa por cuenta. Seccion sec-analytics
54. **Sistema de Tickets/Soporte**: Bandeja admin + historial conversacion + push. Secciones sec-tickets, sec-admintickets
55. **Rotacion Inteligente de Cuentas + Deteccion Ban**: `/api/rate_limit/status` analiza tasa por cuenta
56. **Templates con Variables**: {nombre}, {fecha}, {hora}, {random}, {numero}, {grupo} + preview
57. **Dashboard de Sellers Avanzado**: Stats codigos, clientes activos, tasa conversion. `/api/seller/dashboard`
58. **Modo Vacaciones**: Pausar/reanudar TODAS las campanas con 1 click
59. **Programacion Recurrente (cron-like)**: Dias de semana + hora
60. **A/B Testing de Mensajes**: Divide grupos 50/50 entre variante A y B
61. **Auto-limpieza de Grupos Muertos**: Detectar + eliminar en batch
62. **Respaldo Automatico Diario**: Copia DB cada 3am, mantiene 7 dias
63. **Rate Limiting Adaptativo**: Analiza tasa y recomienda ajustes
64. **Webhook de Eventos**: CRUD completo + firma HMAC-SHA256
65. **Docker Compose**: Dockerfile + docker-compose.yml con volumes y healthcheck
66. **CI/CD GitHub Actions**: Syntax check JS/Python + Docker build
67. **Monitoreo/Health Check**: `GET /api/health` publico, compatible con UptimeRobot
68. **QR en Metodos de Pago**: Admin sube foto QR de Yape/Plin
69. **2 opciones de comprobante**: Subir directo en panel O enviar por WhatsApp
70. **Planes editables por admin**: Solo Semanal y Mensual por defecto, admin edita desde panel
71. **Header precios dinamicos**: Precios en banner se actualizan desde API

### Bugs Conocidos Corregidos (BUG-001 a BUG-008)
- **BUG-001**: Comprobante/QR imagen no carga — Corregido (auth en img tags, directorio, rutas, planes custom)
- **BUG-002**: Reconnect handler no reintenta — Corregido (attachConnectionHandler recursivo)
- **BUG-003**: detenerEnvioPersonal no libera slot — Corregido (delete envioPersonalActivo inmediato)
- **BUG-004**: enviarASeleccionados sin await — Corregido (await + check .blocked)
- **BUG-005**: Bot token en documentacion — Corregido (referencia a bot.py)
- **BUG-006**: Registro aceptaba numeros de telefono — Corregido (validacion front y backend)
- **BUG-007**: Usuarios con sesion previa saltaban verificacion — Corregido (check === '1')
- **BUG-008**: API no verificaba cuenta en servidor — Corregido (middleware 403)

### PR #30 — Fixes de Campanas (Session 4-5)

72. **Campanas zombie tras reinicio** — Cuando el bot se reinicia, las campanas activas en BD quedaban con `activa=1` pero sin tarea en memoria. Fix: `db.resetZombieCampanas()` detecta y resetea + notifica al usuario via WhatsApp. (`index_wsp.js:2467-2495`, `db_wsp.js:870-880`)

73. **botSock null crasheaba campanas silenciosamente** — `iniciarCampana()` usaba `botSock.sendMessage()` directamente. Si botSock era null, crasheaba silenciosamente. Fix: helper `notificarUsuario()` que maneja null gracefully. (`motor_wsp.js:494-512`)

74. **Iniciar campana sin validacion previa** — `/api/iniciar` no verificaba si la campana tenia cuentas o grupos antes de iniciar. Fix: valida `sesiones.length` y `grupos.length`, devuelve error descriptivo. (`index_wsp.js:421-431`, `panel.html:2558`)

75. **Boton Detener siempre mostraba "Detenida"** — `detenerCamp()` ignoraba la respuesta del API. Fix: verifica `r.ok` y muestra error si falla. (`panel.html:2570`)

76. **Dropdown "Cargar mensaje guardado" vacio + mensajes sin texto** — Usaba `m.texto` pero la columna en BD es `mensaje`. Fix: cambiado `m.texto` a `m.mensaje` en todas las instancias. (`panel.html:2504,2509,2520,2759-2768`)

77. **Campana iniciaba pero no mostraba errores** — Si la campana fallaba internamente, el catch solo hacia `console.error()`. Fix: (a) Error fatal envia notificacion WhatsApp. (b) Cada paso critico escribe a `bot_logs` via `db.agregarLog()`. (c) Errores de conexion notifican via WhatsApp. (`motor_wsp.js:526-571,815-817`)

78. **Notificacion zombie: delay de 5s** — Deteccion zombie se ejecutaba inmediatamente al abrir conexion. Fix: `await delay(5000)` antes de detectar zombies. (`index_wsp.js:2479-2482`)

---

## ERRORES PENDIENTES POR CORREGIR (PRIORIDAD ALTA)

### ERROR 1: Campana conecta cuentas pero NO envia mensajes a grupos
- **Estado**: Las campanas inician correctamente, las cuentas se conectan OK (visible en Logs del Bot), pero los mensajes NO se envian a los grupos
- **Evidencia**: Los logs muestran `Cuenta '907' conectada OK` pero despues NO aparecen logs de envio a grupos. La Cola de Reintentos muestra 84 mensajes pendientes
- **Donde investigar**:
  - `motor_wsp.js` lineas 598-770 — El bucle de envio (`while (!cancelled)`) que itera sobre grupos
  - `motor_wsp.js` linea 654 — `grupoTieneActividadNueva()` puede estar bloqueando TODOS los grupos (anti-duplicado demasiado agresivo)
  - `motor_wsp.js` linea 665 — `sendToGroup()` puede estar fallando silenciosamente
  - `motor_wsp.js` linea 641 — `resolveGroupJid()` puede retornar null si los links de grupos son invalidos
- **Solucion sugerida**: Agregar `db.agregarLog()` dentro del bucle de envio para ver donde se corta. Revisar si `grupoTieneActividadNueva` salta todos los grupos despues de un reinicio
- **Archivos**: `motor_wsp.js` (lineas 598-770)

### ERROR 2: Cola de Reintentos tiene 84 mensajes pendientes sin procesarse
- **Estado**: La cola muestra 84 Pendientes, 0 Reenviados, 0 Fallidos
- **Donde investigar**:
  - `motor_wsp.js` funcion `iniciarRetryProcessor()` — Verificar que este corriendo
  - `db_wsp.js` funcion `getRetryPendientesGlobal()` — `proximo_intento <= datetime('now')` puede tener problema de timezone
  - Los reintentos solo se agregan en `enviarAPersonales` y `enviarAMiembros`, NO en campanas
- **Archivos**: `motor_wsp.js`, `db_wsp.js`

### ERROR 3: Bot no notifica al usuario cuando se detiene por actualizacion
- **Estado**: El codigo de deteccion zombie existe (index_wsp.js:2477-2504) con delay de 5s, pero el usuario no recibe la notificacion WhatsApp
- **Posibles causas**:
  - Las campanas ya estaban en `activa=0` al momento del reinicio
  - `botSock.onWhatsApp()` o `botSock.sendMessage()` falla silenciosamente
  - El `resetZombieCampanas()` no encuentra campanas activas
- **Archivos**: `index_wsp.js`

---

## QUE NO TOCAR (NO CAMBIAR NADA DE ESTO)

### Funcionalidades que YA funcionan correctamente:
1. **Sistema de Sellers/Revendedores** — NO tocar endpoints `/api/admin/sellers/*`, `/api/seller/*`, `/api/canjear_codigo`
2. **Login/Registro/2FA/Verificacion** — NO tocar `/api/panel_login`, `/api/2fa/*`, `/api/verificar_cuenta`
3. **Sesiones activas** — NO tocar `/api/panel_sessions`
4. **PWA** — manifest.json, sw.js, install prompt. NO tocar
5. **Dashboard** — Graficos, estadisticas. NO tocar
6. **Grupos WSP/TG** — Busqueda, orden, secciones. NO tocar
7. **Mensajes y Plantillas** — CRUD de mensajes (ya corregido `m.texto` → `m.mensaje`). NO tocar
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
19. **Sistema de Pagos** — Binance Pay + manual. NO tocar
20. **Analytics Avanzado** — NO tocar
21. **Tickets/Soporte** — NO tocar
22. **Push Notifications** — NO tocar
23. **Templates con Variables** — NO tocar
24. **A/B Testing** — NO tocar
25. **Webhooks** — NO tocar
26. **Docker/CI-CD/Health** — NO tocar

### Archivos que NO se deben modificar (a menos que sea para corregir los errores de arriba):
- `panel_server.js` — Funciona perfecto
- `sw.js` — Service Worker OK
- `manifest.json` — PWA OK
- `start.sh` — Script de inicio OK
- `config_wsp.js` — Config OK
- `bot.py` — Bot TG (solo si hay bug TG)
- `motor.py` — Motor TG (solo si hay bug TG)
- `db.py` — DB TG (solo si hay bug TG)

### Reglas estrictas:
- **NO refactorizar** — Solo corregir los 3 errores pendientes
- **NO separar panel.html** — Es monolitico y asi se queda
- **NO cambiar nombres de funciones** existentes
- **NO eliminar** ningun endpoint existente
- **NO cambiar** la estructura de tablas existentes
- **Si agregas un endpoint**, va ANTES de `// Endpoint no encontrado` en index_wsp.js
- **Despues de CADA fix**, actualizar este HANDOFF.md

---

## Mejoras Futuras (Pendientes)
1. **Exportar/Importar configuracion completa** — Un solo archivo JSON con toda la config
2. **Integracion con Google Sheets** — Requiere OAuth de Google + API de Sheets
3. **Multi-idioma para el bot TG** — Detectar locale de Telegram y traducir respuestas
4. **Panel mobile nativo (React Native)** — PWA actual funciona bien en mobile
5. **Separar panel.html en componentes** — Panel tiene 5300+ lineas
6. **Migrar SQLite a PostgreSQL** — Para alta concurrencia futura

---

## Notas Importantes para la Siguiente IA
1. **panel.html** es monolitico (~5000 lineas). Todo HTML, CSS y JS en un archivo. No separar.
2. Los endpoints API se agregan en `index_wsp.js` **ANTES** de la linea `// Endpoint no encontrado`.
3. Las tablas y funciones de DB se agregan en `db_wsp.js` **ANTES** del `module.exports`.
4. Los nuevos exports se agregan al final del objeto `module.exports` en `db_wsp.js`.
5. `panel_server.js` proxea `/api/*` al puerto 3000 (WSP) y `/api/tg*` al puerto 3002 (TG). NO modificar.
6. Para agregar nueva seccion: (a) nav en sidebar, (b) `div.section` con `id="sec-NOMBRE"`, (c) funcion de carga JS, (d) agregar al objeto `loaders`.
7. El tema oscuro/claro usa CSS variables: `var(--bg)`, `var(--text)`, etc.
8. Multi-idioma usa `LANG` object. Agregar traducciones para ES, EN y PT.
9. Sellers usan clase CSS `seller-only`. Se muestran si `esSeller || esAdmin`.
10. "Canjear Codigo" es visible para TODOS los usuarios.
11. **SIEMPRE** actualizar este HANDOFF.md despues de cada mejora o fix.
12. **AUTENTICACION**: Todos los endpoints (excepto publicos) requieren `Authorization: Bearer <token>`.
13. **AUDITORIA**: Usar `db.registrarAuditoria(userId, 'accion', 'detalle', ip)`.
14. **RATE LIMIT**: Login tiene max 5 intentos/15min por IP.
15. **Tablas nuevas**: `login_attempts`, `audit_log`, `grupo_actividad`. Se crean automaticamente.

## Historial de Comandos de Actualizacion

### PR #23 — Sistema de Sellers
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777514912-country-filter-mejoras && npm install && bash start.sh
```

### PR #27 — Sync + Seguridad + Pagos + Mejoras Completas
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777531999-all-improvements-sync && npm install && bash start.sh
```

### PR #30 — Fix Campanas + Bugs #72-78 (ACTUAL)
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777583803-fix-campaign-bugs && npm install && bash start.sh
```

### Comando general para volver a main (si algo se rompe)
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/main && npm install && bash start.sh
```
