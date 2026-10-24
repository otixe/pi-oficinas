# @otixe/pi-plan-gate

“Primero planificá” se olvida en cuanto empieza la implementación. Dale al plan un checkpoint durable y un aprobador humano definido: proponé el trabajo, esperá la revisión y ejecutá lo aceptado.

[English](README.md) · MIT

## Dolores que resuelve

- Planes perdidos tras reload → restauración con ACK remoto.
- Implementación antes de revisar → bloqueo de edit/write y delegación en planning/awaiting.
- Aprobación de origen incierto → ACK de owner coincidente y actividad del humano configurado.

![De pedir un plan a tener revisión humana trazable](media/preview.png)

## Instalación en un comando

Desde un checkout local revisado:

```sh
pi install ./packages/pi-plan-gate
```

### Configuración y backend

Configurá `PLAN_GATE_BASE_URL`, `PLAN_GATE_AGENT`, `PLAN_GATE_KEY_ENV` (default `PLAN_GATE_KEY`) y exportá esa credencial. Opcionales: `PLAN_GATE_AUTH_HEADER=X-API-Key`, `PLAN_GATE_APPROVER=human`, `PLAN_GATE_ROOT`, `PLAN_GATE_READONLY_AGENTS` (array JSON, default `[]`). Keys sólo desde entorno; principales oficina/delegados fallan cerrados.

Backend compatible: checkpoints agent save/latest y `/task/create`, `/task/claim`, `/task/update`, `/task/submit`, `/task/get`, `/task/activity`, `/task/comment`, con atribución owner y actividad review preservadas. Estado bajo `session_ref=plan-gate`; sólo cuentan reviews humanos configurados `pass`/`needs_changes`. ACK fallido mantiene fase anterior.

Tools: `plan_mode`, `plan_submit`, `plan_check`; comando `/plan`. Sin URL queda idle/inactivo: no entra a planning sin ACK durable. `/plan off` es un override de flujo con confirmación remota, no bypass de permisos.

Planning/awaiting bloquean `edit`/`write` y subagentes no aprobados. Leé los límites de shell y restore en **Seguridad y límites** antes de confiar en este flujo.

## Verificación y rollback

Para quitarlo, `pi remove SOURCE` y reiniciá/recargá tu sesión de prueba; preservá logs, snapshots y sesiones.

Configuración del monorepo y validación reproducible: [README](https://github.com/otixe/pi-oficinas/blob/main/README.es.md), [VALIDATION](https://github.com/otixe/pi-oficinas/blob/main/VALIDATION.md).

## Seguridad y límites

**`bash` y `bg_run` siguen disponibles y registrados; otras tools no son detección completa de escritura.** Shell puede escribir. Es un gate de trabajo, **no sandbox de seguridad/read-only**. Logs pueden incluir paths/secrets: revisalos antes de compartir. Restore fallido es visible pero deja idle: **no establece protección**.

Validado en Pi 1.4.0; los cinco paquetes host son peerDependencies `"*"`, nunca copias incluidas. Peers wildcard no prometen todas las versiones del host. Revisá fuente/trust antes de instalar: las extensiones corren con permisos del proceso. Las pruebas usan modelo/backend simulados y no certifican autenticación productiva.

Para archivos locales, extraé el tarball e instalá su directorio `package`: Pi 1.4.0 no carga sources de extensión `.tgz` aunque `pi install` tenga éxito. La instalación literal devuelve 0; la carga/print falla con exit 1. El README raíz muestra la extracción soportada.

La instalación desde registry usa `pi install npm:@otixe/pi-plan-gate@0.1.0` una vez liberada esa versión por el publicador. Los sources npm y URLs de repositorio/galería requieren publicación autorizada por separado; un checkout local no los vuelve disponibles.
