# BotSpam1 - Handoff Actualizado

## Resumen del Sistema
Bot de WhatsApp + Telegram para envio masivo, gestion de grupos, campanas automaticas, y panel web de control.

## Arquitectura
- **WSP API** (port 3000) - `index_wsp.js` + `motor_wsp.js` + `db_wsp.js`
- **Web Panel** (port 3001) - `web_panel.py` sirve `panel.html`
- **TG API** (port 3002) - `index_tg.js` + `bot.py`
- **Base de datos**: SQLite (`wsp_titan.db` para WSP, `titan.db` para TG)
- **Bot Token**: 8779002740:AAEGu8ML62y0uFAqpbpSwStm7FJBn3d-KMo
- **Admin ID**: 8001675901

## Mejoras Implementadas en este PR (#19)

### 1. Recuperacion de Contrasena
- **Web**: Login > "Olvide mi contrasena" > ingresa Telegram ID > recibe codigo por bot > ingresa codigo + nueva contrasena
- **Bot**: Comando `/recuperpass` genera codigo y permite cambiar contrasena directo desde Telegram
- **Tablas**: `recovery_codes` (telegram_id, code, created_at)

### 2. Envio Personal - Numeros Manuales
- **Fix**: `enviarAPersonales()` ahora incluye numeros subidos manualmente (`numeros_manuales` tabla)
- Se pasa parametro `cuenta` para cargar numeros correctos
- Aplicado tanto en envio directo como en promo

### 3. Extraer y Agregar Miembros de Grupos
- **Exportar TXT**: Boton "Exportar TXT" en Envio a Miembros descarga numeros uno por linea
- **Agregar desde archivo**: Seccion "Agregar Miembros desde Lista" permite subir .txt con numeros
- **Lotes configurables**: 30 personas por lote, 5 min entre lotes (por defecto, ajustable)
- `/api/agregar_miembros` ahora acepta `numeros` array ademas de `origen` grupo

### 4. Grupos - Busqueda, Orden, Secciones
- **Buscar**: Campo de busqueda por nombre de grupo
- **Ordenar**: Por nombre (A-Z, Z-A), por cantidad de miembros (mas/menos)
- **Secciones/Categorias**: Asignar categorias a grupos (ej: "Ventas", "Tecnologia")
  - Seleccionar grupos con checkbox > "Asignar Seccion" > nombrar seccion
  - Filtrar grupos por seccion
- **Eliminar Todos**: Boton para eliminar todos los grupos de una vez
- **Tablas modificadas**: `grupos` ahora tiene columnas `seccion TEXT` y `size INTEGER`

### 5. Campanas - Filtro por Seccion
- Al editar campana, los grupos se pueden filtrar por seccion
- Dropdown de secciones para ver solo grupos de una categoria
- Botones "Todos/Ninguno" respetan el filtro de seccion activo

### 6. Envio Interactivo - Plantillas de Promocion
- **Guardar**: Boton "Guardar Actual" guarda la config actual como plantilla con nombre
- **Cargar**: Dropdown para seleccionar y cargar plantilla guardada
- **Eliminar**: Boton para eliminar plantillas
- **Datos guardados**: palabra aceptar/rechazar, respuestas automaticas, timeout, recordatorio
- **Tabla**: `promo_plantillas`

## Endpoints API Nuevos
| Endpoint | Metodo | Descripcion |
|---|---|---|
| `/api/grupos/seccion` | POST | Asignar seccion a grupos `{u, ids, seccion}` |
| `/api/grupos/secciones` | GET | Lista de secciones del usuario |
| `/api/promo/plantillas` | GET | Lista de plantillas de promo |
| `/api/promo/plantillas/crear` | POST | Crear plantilla `{u, nombre, ...config}` |
| `/api/promo/plantillas/editar` | POST | Editar plantilla `{id, nombre, ...config}` |
| `/api/promo/plantillas/eliminar` | POST | Eliminar plantilla `{id}` |

## Analisis de Secciones

### Secciones actuales del panel WSP:
1. **Dashboard** - Vista general, estadisticas
2. **Cuentas WSP** - Vincular/desvincular cuentas WhatsApp
3. **Grupos** - Gestion de grupos (MEJORADO: busqueda, orden, secciones, eliminar todos)
4. **Mensajes** - Crear/editar mensajes para envios
5. **Envio Unico** - Enviar una vez a grupos
6. **Envio Personal** - Enviar a contactos/chats personales
7. **Envio a Miembros** - DM a miembros de grupo (MEJORADO: exportar TXT, agregar desde archivo)
8. **Envio Interactivo** - Promo con escucha de respuestas (MEJORADO: plantillas de promocion)
9. **Programados** - Envios programados a hora especifica
10. **Campanas** - Envios ciclicos automaticos (MEJORADO: filtro por seccion en editar)
11. **Config** - Configuracion general (intervalos, delays)
12. **Lista Negra (grupos)** - Grupos excluidos de envios
13. **Lista Negra (numeros)** - Numeros excluidos
14. **Auto Respuestas** - Respuestas automaticas a keywords
15. **Estadisticas** - Stats de envios
16. **Plantillas** - Plantillas de mensajes reutilizables
17. **Historial WSP** - Historial de envios
18. **Dashboard DMs** - Estadisticas de DMs a miembros

### Secciones que podrian consolidarse:
- **Mensajes + Plantillas**: Ambas gestionan mensajes reutilizables. Podrian unificarse en una sola seccion "Mensajes y Plantillas" para evitar confusion.
- **Lista Negra (grupos) + Lista Negra (numeros)**: Podrian ser tabs dentro de una sola seccion "Lista Negra".
- **Estadisticas + Dashboard DMs**: Las estadisticas generales y las de DMs podrian consolidarse en un unico "Dashboard de Estadisticas".
- **Historial WSP**: Podria integrarse como tab dentro de Estadisticas.

### Secciones que siguen siendo necesarias:
- Todas las secciones de envio (Unico, Personal, Miembros, Interactivo) tienen flujos distintos y no se pueden fusionar.
- Campanas y Programados son conceptos diferentes (ciclico vs hora fija).
- Config y Cuentas son esenciales para la gestion.

## Comando de Actualizacion
```bash
cd /root/BotSpam1 && fuser -k 3000/tcp 3001/tcp 3002/tcp 2>/dev/null; sleep 2 && git fetch origin && git reset --hard origin/devin/1777500002-recuperar-password && npm install && bash start.sh
```

## Archivos Principales Modificados
- `db_wsp.js` - Nuevas tablas, migraciones, funciones CRUD
- `index_wsp.js` - Nuevos endpoints API
- `motor_wsp.js` - Fix envio personal con numeros manuales
- `panel.html` - UI: busqueda, secciones, plantillas promo, agregar miembros desde archivo
- `bot.py` - Comando /recuperpass, fix null check
- `web_panel.py` - Servir pagina de recuperacion
