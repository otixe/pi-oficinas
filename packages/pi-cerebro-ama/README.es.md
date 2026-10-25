# @otixe/pi-cerebro-ama

## Tu agente necesita memoria, no una pared de schemas de memoria

Si declarás cada herramienta de memoria, tareas y coordinación en cada request, la superficie crece antes de que el agente haga trabajo útil. Quitarlas tampoco sirve: las sesiones largas siguen necesitando leer, registrar y coordinar.

**AMA — Agent Memory Access deja ocho herramientas cotidianas directas para subagentes o hasta catorce para líderes, y permite llamar las opcionales autorizadas por `codemode`.** Un solo paquete admite ambos perfiles; el modelo no necesita todas sus schemas en el catálogo directo.

- **Demasiadas schemas de memoria → un núcleo pequeño y estable.** Identidad, entrega de tareas, notas y recuperación siguen a mano.
- **Ocultar capacidades las vuelve inutilizables → opcionales invocables.** Usá `tools.cb_…` desde codemode sin ampliar la lista directa.
- **Cada agente necesita permisos distintos → la identidad sigue siendo propia.** Se conservan las allowlists, las keys individuales y la autorización del servidor.

```text
Antes: todas las schemas de memoria registradas son directas
AMA:   8 directas subagente / hasta 14 líder + codemode → cb_* opcionales permitidas
```

## ¿Para quién es?

Equipos con muchas herramientas de memoria/coordinación, agentes con sesiones largas y autores/revisores que comparten un servicio sin compartir credenciales. AMA adapta la superficie de un Cerebro MCP existente; no instala un servidor de memoria.

## Instalación local

Desde la raíz del repositorio, después de revisar el paquete:

```bash
pi install ./packages/pi-cerebro-ama
```

Abrí un proceso nuevo después de instalar/configurar. Este paquete reemplaza el **puente Cerebro y el activador de herramientas**: no cargues un segundo `cerebro-mcp.ts` ni el activador de `@otixe/pi-herramientas` a la vez. Guardá los archivos/settings anteriores antes de deshabilitar entradas duplicadas. No reemplaza tu proveedor, servicio de memoria ni configuración de equipo.

## Configuración

1. Conservá una configuración de equipo explícita y validada en `PI_OFICINAS_EQUIPO`, y la key propia del agente. El resolvedor incluido usa la misma configuración versión 2 que `@otixe/pi-oficinas`; tenés un ejemplo en `examples/equipo.example.json`. Reemplazá rutas/nombres por los tuyos, provisioná credenciales por otro canal y dejá la configuración bajo control de su dueña, sin escritura de grupo/otros. No guardes keys reales en el paquete.
2. Configurá `CEREBRO_MCP_URL` si tu endpoint no es `http://127.0.0.1:8766/mcp`.
3. Creá un catálogo válido `.pi/herramientas.json`. Partí de `examples/herramientas.json` y conservá tus herramientas/grupos no-Cerebro. Incluí las opcionales permitidas por rol: un catálogo **no** salta el registro/allowlist de launch de Pi ni el RBAC del servidor.
4. Creá `.pi/cerebro-surface.json`:

```json
{"mode":"ama"}
```

5. Para una líder, usá `{"mode":"ama","perfil":"lider"}`. Sin perfil, el default es `subagente`; `{"mode":"ama","perfil":"subagente"}` es equivalente. Abrí un proceso Pi nuevo con codemode disponible. Llamá `cb_whoami` y verificá `superficie_cb : ama`, `perfil_cb` y las tools activas. Una key aceptada no demuestra atribución: comprobala por separado con escritura/lectura autorizada si tu rol lo permite.

Flag ausente/inválido o catálogo ausente/inválido conserva el modo tradicional. `{"mode":"code"}` sigue como alias legado. Sin codemode registrado, el activador no reduce el set activo: eso no es una aceptación AMA exitosa.

### Dos perfiles, un solo paquete

El perfil `subagente` conserva las ocho herramientas directas del núcleo:

`cb_whoami`, `cb_correspondencia_resumen`, `cb_task_get`, `cb_task_comment`, `cb_task_submit`, `cb_vault_read`, `cb_memory_add`, `cb_memory_search`.

El perfil `lider` suma seis de coordinación frecuente: `cb_task_activity`, `cb_correspondencia_leer`, `cb_task_create`, `cb_correspondencia_ok`, `cb_task_update`, `cb_task_review`. Son hasta 14 directas, solo si ya están registradas/allowlisted. Las seis salen de registros de llamadas directas/anidadas completadas en los JSONL de siete líderes durante siete días, no de strings en código generado. Las llamadas fallidas también cuentan; esto no mide costos ni ahorro.

Las demás capacidades registradas y permitidas usan `exposure: "codemode"`, no `hidden` ni desregistro. Las rutas conocidas exclusivas de líder/admin (listar/provisionar/revocar agentes y líderes, analizar consolidación, evaluar retrieval, minar skills y administrar aprobaciones) quedan `hidden` y fuera del catálogo opcional en perfil subagente. Elegir `lider` **no** concede esos permisos: siguen vigentes allowlists por rol y RBAC del servidor; la revisión de tareas sigue opcional para subagentes auditores autorizados.

Por ejemplo, desde codemode:

```js
const resultado = await tools.cb_task_activity({ task_id: "id-de-tu-tarea" });
console.log(resultado);
```

**No actives opcionales a mitad de sesión solo para llamarlas.** Cambiar el set directo puede invalidar la caché del prompt. Usá `herramientas_activar` únicamente si codemode no alcanza, y registrá el motivo. El activador se conserva por compatibilidad; AMA no lo convierte en una frontera de seguridad.

## Medí sesiones reales offline

Con Python 3.10+, pasá un manifiesto con globs JSONL explícitos por cuerpo, casa y rol `leader`/`office`. Indicá timestamps con zona horaria del inicio del despliegue y su fin (`cutoff`), o etiquetá corridas controladas con `phase: "baseline"` / `"ama"`. Tenés `examples/measurement.json`.

```bash
python3 packages/pi-cerebro-ama/bin/measure-jsonl.py measurement.json --output comparison.json
```

El script lee sesiones sin modificarlas ni llamar al proveedor. Exporta metadatos numéricos de uso/fecha/modelo, no prompts ni contenido de resultados. La entrada es `input + cacheRead + cacheWrite`, no `totalTokens`; tampoco vuelve a sumar el subconjunto `cacheWrite1h`. Reporta tokens del primer request, mediana de entrada, costo registrado medio/mediano por request y cambios baseline→AMA con igual modelo, agrupados por casa/rol/perfil. Indicá `perfil: "lider" | "subagente"` por entrada del manifiesto; omitirlo conserva `subagente`. Los campos opcionales `perfil_cutoff` (con zona) y `perfil_before` conservan el perfil anterior de ocho tools para sesiones previas al rollout de líder. Para resumes en proceso viejo o `/new`, declaralos por sesión sin corte automático: los perfiles son etiquetas declaradas/inferidas, no prueba de exposición real. Las comparaciones nunca mezclan perfiles. Los requests con cacheWrite alto quedan separados: por defecto, al menos 10.000 tokens **y** 20% de la entrada, ambos configurables.

Clasifica por **inicio de sesión**: un pane viejo sigue siendo baseline después del rollout; los inicios durante el despliegue son transición. Excluye historial heredado de forks y requests duplicados. Empezar después del corte solo permite inferir AMA: comprobá la superficie con whoami. CacheWrite alto puede tener otras causas y los costos registrados pueden ser estimaciones o cero.

## Tests y rollback

```bash
cd packages/pi-cerebro-ama
npm test
python3 tests/measure.test.py
npm pack --dry-run
```

Los tests requieren Node 22.18+ (borrado nativo de tipos TypeScript) y cubren opt-in estricto, las ocho core, equivalencia del alias, fallback sin codemode, proyección de allowlist, conservación de grupos no-Cerebro, arranque y reconciliación. Conservan los 11 contratos originales y agregan pruebas de perfiles, tope del núcleo, exclusión líder/admin y activador. La medición offline prueba partición y cortes de perfil. No llaman a proveedores ni autentican un servicio productivo.

Para volver a la superficie tradicional, borrá `.pi/cerebro-surface.json` y abrí un **proceso nuevo**. Para desinstalar/revertir la integración, restaurá también puente/activador/settings respaldados. Borrar el flag no revierte catálogos ni allowlists de launch.

## Seguridad y límites

- Las extensiones corren dentro de Pi con tus permisos del sistema. Codemode permite ejecutar; **no es un sandbox** ni reemplaza la autorización del servicio.
- Menos tools directas no significa menos permisos. Deben seguir vigentes las allowlists, las credenciales propias, la identidad fail-closed y el ACL/RBAC del servidor. No prestes keys de líderes ni de otras oficinas.
- Se necesita un Cerebro compatible ya existente, configuración explícita de equipo y un runtime Pi con exposición/codemode. Los peers los aporta el host; no se incluyen servidor, credenciales ni proveedor.
- El catálogo por rol depende del despliegue. Siguen aplicando condiciones de propiedad/alcance; algunas core pueden estar denegadas a agentes read-only.
- Los cambios observados en tokens de schemas fueron aproximadamente **−50% con catálogo completo y −3% con ficha de oficina acotada**. Son observaciones anteriores al perfil líder, no promesas universales; aquí no hay una medición nueva de ahorro para líderes de catorce tools. Caché, modelos y facturación pueden alterar los costos. Medí tus sesiones offline.
- El paquete apunta a la API exposición/codemode usada en Pi 1.4.0. Instalar con exit 0 no prueba carga. Si el runtime no carga un `.tgz` local, extraelo e instalá el directorio; verificá un proceso nuevo.
