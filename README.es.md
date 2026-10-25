# Tu sesión Pi necesita un equipo

Tu única sesión Pi hace de todo: programa, revisa e investiga. Se llena el contexto, se pierden los relevos y quien escribe termina revisando su propio trabajo. **pi-oficinas convierte esa sesión sobrecargada en un equipo persistente.**

- **Memoria de trabajo y bandejas separadas:** cada oficina conserva identidad, credenciales e historial propios; un rol no tiene que cargar el contexto de todos los demás.
- **Un revisor que no es el autor:** asigná implementación y revisión a oficinas distintas y usá un flujo explícito de aprobación humana antes de ejecutar lo aceptado.
- **Reiniciar sin empezar de cero:** conservá los historiales en cuerpos separados y reabrí o retomá sesiones propias mediante los flujos verificados de oficina.

MIT · **0.1.0** · [English](README.md)

## Empezá con un comando

Desde un checkout local revisado, instalá el paquete de equipo y después configurá tus oficinas:

```sh
pi install ./packages/pi-oficinas
```

![Una sesión sobrecargada se convierte en un equipo persistente](packages/pi-oficinas/media/preview.png)

## ¿Para quién es?

- Para quien corre agentes largos y necesita separar roles, historiales y trabajo pendiente.
- Para quien quiere separar autor y revisor, en vez de pedirle al mismo agente que apruebe su implementación.
- Para quien paga demasiado en tokens por cambios de schemas y busca un prefijo de prompt-cache más estable.

## Elegí el dolor que querés resolver

Empezá con un paquete o combiná módulos compatibles. Cada uno tiene README bilingüe, configuración propia y una vista de su flujo. AMA reemplaza puente Cerebro/activador: no lo cargues junto a otra copia de esas extensiones.

| Paquete | Qué mejora | Configuración |
| --- | --- | --- |
| [`@otixe/pi-oficinas`](packages/pi-oficinas/README.es.md) | Separá una sesión sobrecargada en oficinas persistentes con relevos verificados y pendientes visibles | `equipo.json` explícito, perfiles propios, entorno e integración compatible con el backend |
| [`@otixe/pi-cache-estable`](packages/pi-cache-estable/README.es.md) | Mantené el orden de tools y solicitá retención larga para que el churn evitable no rompa el prefijo | `PI_CACHE_RETENTION`, `.pi/tools-order.json` opcional |
| [`@otixe/pi-renovacion`](packages/pi-renovacion/README.es.md) | Detectá presión de contexto y diferí nuevas tareas mientras termina el trabajo actual | `CONTEXT_ALERT`, `CONTEXT_WINDOW`, `CONTEXT_ALERT_PCT`; dependencias de relanzamiento inyectadas |
| [`@otixe/pi-plan-gate`](packages/pi-plan-gate/README.es.md) | Convertí “primero planificá” en un plan confirmado y una revisión humana trazable | Variables `PLAN_GATE_*` y endpoints de checkpoint/tareas compatibles |
| [`@otixe/pi-herramientas`](packages/pi-herramientas/README.es.md) | Empezá con un catálogo compacto y activá tools registradas cuando la tarea las necesita | `.pi/herramientas.json` |
| [`@otixe/pi-cerebro-ama`](packages/pi-cerebro-ama/README.es.md) | Conservá ocho tools cotidianas de memoria directas para subagentes o hasta catorce para líderes; llamá las opcionales permitidas por codemode | Equipo/key propia explícitos, `.pi/herramientas.json`, `.pi/cerebro-surface.json` |

## Instalación

Probado con Pi **1.4.0**. Los cinco paquetes originales declaran las cinco bibliotecas del host como `peerDependencies: "*"`; AMA declara solo sus dos peers necesarios, también wildcard. No se incluyen copias del host ni dependencias ordinarias. La CLI de oficinas necesita Python 3.10+ y Herdr. Instalá la integración oficial de Pi en el HOME de prueba/usuario revisado (`herdr integration install pi`): el gate necesita el reporte nativo de sesión/status y falla si falta. Los contratos con TypeScript nativo requieren Node 24+; Pi carga TypeScript mediante su loader de extensiones.

Sumá los paquetes que necesita tu flujo:

```sh
pi install ./packages/pi-cache-estable
pi install ./packages/pi-herramientas
```

Un paquete local no crea un enlace npm al binario; podés usar `python3 packages/pi-oficinas/bin/oficina --equipo FILE ...`.

Para AMA, usá `pi install ./packages/pi-cerebro-ama` **en reemplazo del activador de herramientas y del puente Cerebro previo**, no además de ellos. Seguí su migración/rollback. Su script JSONL offline compara entrada/costo de sesiones nuevas baseline/AMA por casa y rol sin llamar al proveedor.

## Configurar

### Oficina

Tomá `packages/pi-oficinas/examples/equipo.json` y el SOUL neutro como **ejemplos inactivos**, no como configuración desplegable. Cambiá nombres, rutas absolutas, prefijos de variables de credencial y rutas de vault. `PI_OFICINAS_EQUIPO` apunta a un archivo propio, no symlink, sin escritura de grupo/otros. La `.env` local debe ser privada (0600), con un único puntero exacto. No existe fallback al equipo de una instalación particular. Un paquete sin configurar permanece inerte; una configuración explícita inválida falla.

El esquema de equipo es versión 2; distribución también **sólo v2**. Líder y oficinas pertenecen a `base`. El pin opcional `pi_bin` es `<base>/runtime/node_modules/.bin/pi`; `pi_coding_agent_dir=.pi-agent`, `pi_coding_session_dir=sessions` y `relanzar_modo=fresco|retomar` son opciones existentes. La CLI no genera cuerpos ni provisiona claves.

Definí `CEREBRO_BASE`, opcionalmente `CEREBRO_AUTH_HEADER` (default `X-API-Key`), y `PI_OFICINAS_HUMAN` (default `human`). Provisioná claves distintas por rol en un entorno/archivo privado, nunca en Git. La apertura necesita herramientas auténticas `cb_whoami` y `cb_vault_read`, SOUL con `agent` correcto, resultados nuevos atados al nonce, modelo/thinking/perfil coincidentes y ninguna herramienta Telegram. El marker no autoriza nada. Una practicante sólo puede compartir la key de su propia dueña mediante opt-in local y ficha canónica; `PI_OFICINAS_MINI_MODEL` puede reforzar el pin del modelo.

### Caché

Instalar selecciona retención `long` salvo que `PI_CACHE_RETENTION` ya esté definido. Podés fijar `PI_CACHE_RETENTION=short` o `PI_CACHE_ESTABLE_RETENTION`. `.pi/tools-order.json` admite `{"version":1,"priority":["read","bash","edit","write"],"unlisted":"alphabetical"}`. Un host incompatible falla con `TOOLS_ORDER_UNSUPPORTED_HOST`.

### Renovación

`CONTEXT_ALERT=0` apaga avisos; por defecto `[80]`, o `CONTEXT_ALERT_PCT=50,80`. `CONTEXT_WINDOW` sobreescribe la ventana declarada por el modelo; si ambas faltan se usa 1.000.000. Configurala explícitamente si el modelo no declara metadata. Los avisos notifican UI y registran `state/context-budget-alert.jsonl`. Telegram es opcional, sólo para prompts de ese origen mediante una integración ya instalada.

`context70` difiere tareas nuevas con contexto alto/desconocido y permite continuar la tarea actual. La coordinación exige callbacks autenticados de tareas/panes/gate y sesión coincidente. En el adaptador de este paquete, configurá `officeCli` o `PI_OFICINAS_CLI` absoluto, o inyectá `runRelaunch`; no se adivina una ruta a otro paquete.

### Plan humano

Definí `PLAN_GATE_BASE_URL`, `PLAN_GATE_AGENT`, `PLAN_GATE_KEY_ENV` (default `PLAN_GATE_KEY`) y exportá esa credencial. Opcionales: `PLAN_GATE_AUTH_HEADER`, `PLAN_GATE_APPROVER` (default `human`), `PLAN_GATE_ROOT`, `PLAN_GATE_READONLY_AGENTS` (array JSON, vacío por defecto). Requiere endpoints compatibles de checkpoint/tareas y atribución de propietario; no hay aprobación local implícita. Sin URL permanece inactivo; entrar al plan sigue requiriendo ACK. Fallos de arranque dejan `idle` visible: **no prueban protección de planificación**.

Durante planning/awaiting se bloquean `edit`, `write` y delegación ejecutora; sólo se habilitan subagentes explícitamente declarados de lectura. Leé los límites de shell y restore en **Seguridad y límites** antes de confiar en este flujo. Sólo reviews humanos `pass`/`needs_changes` del aprobador configurado cuentan.

### Herramientas a demanda

`.pi/herramientas.json`: `{"base":["read","bash"],"grupos":{"editing":{"linea":"Activar edición","tools":["edit","write"]}}}`. `herramientas_activar` acepta `grupo` o `nombres`. El catálogo siempre se intersecta con lo registrado. Configuración ausente/inválida es transparente; `base:"*"` deriva el universo inicial menos grupos y nunca supera el perfil.

## Validar y revertir

Ver `VALIDATION.md`, `SOURCES.md` y los tests enfocados. Empaquetá cada paquete y ejecutá `gitleaks dir .`. Repo Git nuevo, sin historial heredado. Tarballs y evidencia fuera del árbol público. No hagas push ni publish antes de QA.

Para desinstalar: `pi remove FUENTE` y recargar/reiniciar la sesión de prueba. Conservá bitácoras, snapshots, markers y sesiones; no los borres como rollback. No cierres ni sobreescribas un pane cuya propiedad sea incierta. Para revertir el checkout local, archivarlo después de conservar su evidencia; no hubo despliegue vivo.

## Seguridad y límites

### Permisos y alcance

Las extensiones ejecutan código con tus permisos: revisalas antes de instalar. Estos gates **no son un sandbox** ni reemplazan autorización del backend o aislamiento del sistema operativo.

No se incluye el paquete público de cliente Cerebro, claves, almas reales, cuerpos activos, historias privadas ni el controlador experimental separado de renovación automática del líder. La extracción no instala ni habilita nada en cuerpos vivos. La CLI no crea cuerpos ni provisiona claves. El relanzamiento usa la CLI verificada de oficina, nunca una sesión adivinada.

### Caché y renovación

Soporte, precios y aciertos de caché dependen del proveedor: no se garantizan TTL, tasa de hit ni ahorro de tokens/dinero. El orden nunca amplía el conjunto de herramientas ni concede permisos; el diagnóstico no autentica identidades.

Renovación no cambia compactación ni prompts, no corta la sesión del líder ni ejecuta automáticamente su `/new`, y no afirma cosecha durable. Costos faltantes aparecen como cero: no es prueba de gratuidad. Telegram requiere un bridge y credenciales externos; un fallo se registra y no tumba el turno ni acredita entrega.

### Planificar no es aislar

La memoria del plan sólo cambia tras ACK y atribución correcta. **`bash` y `bg_run` siguen disponibles y registrados; otras herramientas no constituyen una detección completa de escritura.** Shell puede escribir: es un gate de trabajo, no aislamiento read-only. Revisá bitácoras antes de compartirlas porque contienen comandos/rutas. Restore fallido deja `idle` visible: **no prueba protección de planificación**.

### Archivos locales y distribución

Para un tarball local, extraerlo en una carpeta nueva e instalar la carpeta `package`. Pi 1.4 interpreta archivos locales como fuentes de extensión; **el éxito de `pi install ./paquete.tgz` no demuestra que cargó su contenido**. La instalación literal devuelve 0, pero la carga probada falla con extensión `.tgz` desconocida (exit 1).

```sh
mkdir -p ./artifacts
npm pack ./packages/pi-herramientas --pack-destination ./artifacts
mkdir ./extraido
tar -xzf ./artifacts/otixe-pi-herramientas-0.1.0.tgz -C ./extraido
pi install ./extraido/package
```

La instalación desde registry usa `pi install npm:@otixe/pi-herramientas@0.1.0` (o el paquete elegido) una vez que el publicador libera esa versión. Los sources npm y URLs de repositorio/galería requieren publicación autorizada por separado; un checkout local no los vuelve disponibles. Esta extracción no hace push ni publicación.

### Qué prueba la validación

El target observado es Pi 1.4.0, no todas las versiones admitidas por peers wildcard. La apertura probada usa Pi/Herdr reales y modelo/backend simulados: verifica el mecanismo del gate, **no autenticación/autorización productiva**. No se afirma uso de modelo de nube, oficina viva, VM o entrega Telegram, ahorro de caché, correspondencia completa, renovación automática del líder, cosecha durable ni despliegue productivo. Todos los límites de prueba están en `VALIDATION.md`.
