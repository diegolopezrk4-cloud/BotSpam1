# Handoff para la Siguiente IA

## IMPORTANTE — Antes de Hacer Cualquier Cambio
1. Lee este handoff completo y confirma que entiendes la arquitectura
2. Si vas a modificar `panel.html`, di en que linea/seccion vas a trabajar
3. Si necesitas agregar un endpoint API, agregalo ANTES de la linea `// Endpoint no encontrado` en `index_wsp.js`
4. Despues de cada mejora/fix, **actualiza este HANDOFF.md** con los cambios realizados

---

## Resumen del Sistema
Bot de WhatsApp + Telegram para envio masivo, gestion de grupos, campanas automaticas y panel de control web con soporte PWA.

## Arquitectura
- **WSP API** (puerto 3000) — `index_wsp.js` + `motor_wsp.js` + `db_wsp.js`
- **Panel Web** (puerto 3001) — `panel_server.js` sirve `panel.html` y proxea API
- **TG API** (puerto 3002) — `bot.py` + `motor.py` + `db.py`
- **Base de datos**: SQLite (`wsp_titan.db` para WSP, `titan.db` para TG)

## Archivos Principales
| Archivo | Descripcion | Lineas aprox |
|---|---|---|
| `panel.html` | Frontend completo (HTML+CSS+JS en un solo archivo) | ~4480 |
| `index_wsp.js` | API HTTP del bot WSP (todos los endpoints) | ~4540 |
| `db_wsp.js` | Base de datos SQLite WSP (tablas + CRUD) | ~2015 |
| `motor_wsp.js` | Motor de envio WhatsApp | ~74000 |
| `panel_server.js` | Servidor web que sirve panel.html y proxea APIs | ~100 |
| `bot.py` | Bot de Telegram (comandos + API) | ~178000 |
| `motor.py` | Motor de envio Telegram | ~48000 |
| `db.py` | Base de datos SQLite Telegram | ~27000 |
| `manifest.json` | Manifiesto de PWA | ~46 |
| `sw.js` | Service Worker para PWA | ~51 |
| `start.sh` | Script de inicio de todos los servicios | ~50 |

## Mejoras Implementadas

### PRs Anteriores (ya mergeados al branch principal de desarrollo)

#### 1. Recuperacion de Contrasena
- Web: Login > "Olvide mi contrasena" > ingresa Telegram ID > recibe codigo por bot > ingresa codigo + nueva contrasena
- Bot: Comando `/recuperpass` genera codigo y permite cambiar contrasena directo desde Telegram
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

#### 19. Sistema de Sellers (Revendedores)
- **Admin**: Crear/editar/eliminar sellers desde "Admin > Sellers"
- **Seller Config**: Telegram ID, nombre, max invitaciones, periodo (semanal/mensual), plan que otorga (semanal/mensual/permanente)
- **Panel Seller**: Los sellers ven su seccion "Panel Seller" donde pueden activar membresias a clientes
- **Limite por periodo**: El contador de invitaciones se resetea automaticamente cada semana o mes segun configuracion
- **Barra de progreso**: Visualizacion de invitaciones usadas/disponibles
- **Historial**: Registro de todas las invitaciones con fecha, cliente ID y plan otorgado
- **Sync TG**: Al activar membresia via seller, se sincroniza automaticamente con la base de datos de Telegram
- **Tablas**: `sellers` (telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo, activo), `seller_invites` (seller_id, invitado_telegram_id, plan_dias, plan_tipo, fecha_invitacion)
- **Endpoints Admin**: `/api/admin/sellers` (GET), `/api/admin/sellers/crear` (POST), `/api/admin/sellers/editar` (POST), `/api/admin/sellers/eliminar` (POST)
- **Endpoints Seller**: `/api/seller/info` (GET), `/api/seller/invitar` (POST)
- **Login/CheckMembresia**: Ahora devuelven `es_seller` para mostrar/ocultar seccion seller en el panel

---

## Secciones del Panel
| # | Seccion | Plataforma | Descripcion |
|---|---|---|---|
| 1 | Dashboard | Ambas | Vista general, estadisticas, graficos |
| 2 | Cuentas WSP | WSP | Vincular/desvincular cuentas WhatsApp via QR |
| 3 | Cuentas TG | TG | Vincular cuentas TG via codigo o QR |
| 4 | Grupos WSP | WSP | Gestion de grupos (busqueda, secciones, ordenar) |
| 5 | Grupos TG | TG | Gestion de grupos TG |
| 6 | Mensajes y Plantillas | WSP | Crear/editar mensajes reutilizables |
| 7 | Envio Unico | WSP | Enviar una vez a grupos seleccionados |
| 8 | Envio Personal | WSP | Enviar a chats personales/numeros manuales |
| 9 | Envio a Miembros | WSP | DM a miembros de grupo con filtro por pais |
| 10 | Envio Interactivo | WSP | Promo con escucha de respuestas + filtro pais |
| 11 | Programados WSP | WSP | Envios programados |
| 12 | Campanas WSP | WSP | Envios ciclicos automaticos |
| 13 | Mensajes TG | TG | Mensajes para Telegram |
| 14 | Campanas TG | TG | Envios ciclicos TG |
| 15 | Programados TG | TG | Envios programados TG |
| 16 | Historial TG | TG | Historial de envios TG |
| 17 | Detectar Grupos TG | TG | Detectar grupos TG |
| 18 | Stats TG | TG | Estadisticas TG |
| 19 | Historial WSP | WSP | Historial de envios WSP |
| 20 | Logs del Bot | WSP | Logs en tiempo real |
| 21 | Cola de Reintentos | WSP | Mensajes pendientes de reenvio |
| 22 | Config Envio WSP | WSP | Intervalos, retrasos, imagen |
| 23 | Lista Negra | WSP | Grupos y numeros excluidos |
| 24 | Auto-Responder WSP | WSP | Respuestas automaticas |
| 25 | Auto-Responder TG | TG | Respuestas automaticas TG |
| 26 | Config Envio TG | TG | Configuracion envio TG |
| 27 | Lista Negra TG | TG | Exclusiones TG |
| 28 | 2FA y Sesiones | Ambas | Autenticacion 2FA + sesiones activas |
| 29 | Backup / Restaurar | Ambas | Exportar/Importar configuracion |
| 30 | Estadisticas y DMs | Ambas | Estadisticas detalladas + DMs |
| 31 | Actividad | Ambas | Registro de actividad |
| 32 | **Panel Seller** | Ambas | **NUEVO**: Panel para sellers — activar membresias a clientes |
| 33 | Admin Panel | Admin | Gestion de usuarios |
| 34 | **Sellers** | Admin | **NUEVO**: Crear/editar/eliminar sellers |
| 35 | Logs Global | Admin | Logs de todos los usuarios |

## Endpoints API
### Sellers (NUEVOS)
| Endpoint | Metodo | Descripcion |
|---|---|---|
| `/api/admin/sellers` | GET | Lista sellers (admin) `?u=ADMIN_ID` |
| `/api/admin/sellers/crear` | POST | Crear seller `{admin_id, telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo}` |
| `/api/admin/sellers/editar` | POST | Editar seller `{admin_id, id, max_invites, periodo, plan_dias, plan_tipo, activo}` |
| `/api/admin/sellers/eliminar` | POST | Eliminar seller `{admin_id, id}` |
| `/api/seller/info` | GET | Info del seller actual `?u=USER_ID` |
| `/api/seller/invitar` | POST | Seller activa membresia `{u, invitado_id, invitado_nombre}` |

### Endpoints Anteriores (sin cambios)
Ver listado completo en el handoff anterior. Endpoints principales:
- `/api/panel_login`, `/api/panel_registro`, `/api/check_membresia`
- `/api/grupos`, `/api/campanas`, `/api/historial`, `/api/dashboard`
- `/api/2fa/*`, `/api/panel_sessions/*`, `/api/config/*`
- `/api/admin/usuarios`, `/api/admin/membresia`, `/api/admin/desactivar`

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
- **`sellers`** — **NUEVO**: Revendedores (telegram_id, nombre, max_invites, periodo, plan_dias, plan_tipo, activo)
- **`seller_invites`** — **NUEVO**: Invitaciones de sellers (seller_id, invitado_telegram_id, plan_dias, plan_tipo, fecha)

## Notas Importantes
1. **panel.html** es monolitico (~4480 lineas). Todo HTML, CSS y JS en un archivo. No separar.
2. Los endpoints API se agregan en `index_wsp.js` **ANTES** de la linea `// Endpoint no encontrado` (buscar esa cadena).
3. Las tablas y funciones de DB se agregan en `db_wsp.js` **ANTES** del `module.exports`.
4. Los nuevos exports se agregan al final del objeto `module.exports` en `db_wsp.js`.
5. `panel_server.js` proxea `/api/*` al puerto 3000 (WSP) y `/api/tg*` al puerto 3002 (TG). NO necesitas modificarlo para nuevos endpoints.
6. Para agregar una nueva seccion al panel: (a) nav en sidebar, (b) `div.section` con `id="sec-NOMBRE"`, (c) funcion de carga, (d) agregar al objeto `loaders`.
7. El tema oscuro/claro usa CSS variables: `var(--bg)`, `var(--text)`, etc.
8. Multi-idioma usa `LANG` object. Agregar traducciones para ES, EN y PT.
9. Sellers usan clase CSS `seller-only` (similar a `admin-only`). Se muestran si `esSeller || esAdmin`.
10. **SIEMPRE** actualizar este HANDOFF.md despues de cada mejora o fix.

## Comando de Actualizacion
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/<BRANCH_NAME> && npm install && bash start.sh
```
