# @otixe/pi-cache-estable

Las tools son las mismas, pero sus schemas cambian de lugar y rompen el prefijo del prompt. Mantené el orden estable y solicitá retención larga donde el proveedor la soporte, sin cambiar qué herramientas puede usar el agente.

[English](README.md) · MIT

## Dolores que resuelve

- Schemas reordenadas que rompen un prefijo estable → orden canónico verificado.
- Retención corta por defecto → preferencia de retención larga por instalación.
- Diferencias entre configuración y runtime → diagnóstico best-effort de coherencia.

![Del churn de schemas a un prefijo de prompt estable](media/preview.png)

## Instalación en un comando

Desde un checkout local revisado:

```sh
pi install ./packages/pi-cache-estable
```

### Configuración

Instalar selecciona `PI_CACHE_RETENTION=long` sólo si no existe. Conservá/configurá `PI_CACHE_RETENTION=short` para retención corta o `PI_CACHE_ESTABLE_RETENTION` como default del package.

`.pi/tools-order.json` opcional:

```json
{"version":1,"priority":["read","bash","edit","write","plan_*"],"unlisted":"alphabetical"}
```

El adaptador verificado de `AgentSession` apunta a Pi 1.4.0; host incompatible falla con `TOOLS_ORDER_UNSUPPORTED_HOST`. Configuración ausente/inválida es transparente. Aun con orden estable, evitá cambios innecesarios de membresía.

## Verificación y rollback

Para quitarlo, `pi remove SOURCE` y reiniciá/recargá tu sesión de prueba; preservá logs, snapshots y sesiones.

Configuración del monorepo y validación reproducible: [README](https://github.com/otixe/pi-oficinas/blob/main/README.es.md), [VALIDATION](https://github.com/otixe/pi-oficinas/blob/main/VALIDATION.md).

## Seguridad y límites

Soporte, precio y hits dependen del proveedor: **no se promete TTL fijo, ahorro ni tasa de hit**. Se preserva membresía: no concede permisos. El diagnóstico nunca autentica nombres declarados. Un orden estable no es un sandbox ni prueba de un acierto de caché.

Validado en Pi 1.4.0; los cinco paquetes host son peerDependencies `"*"`, nunca copias incluidas. Peers wildcard no prometen todas las versiones del host. Revisá fuente/trust antes de instalar: las extensiones corren con permisos del proceso. Las pruebas usan modelo/backend simulados y no certifican autenticación productiva.

Para archivos locales, extraé el tarball e instalá su directorio `package`: Pi 1.4.0 no carga sources de extensión `.tgz` aunque `pi install` tenga éxito. La instalación literal devuelve 0; la carga/print falla con exit 1. El README raíz muestra la extracción soportada.

La instalación desde registry usa `pi install npm:@otixe/pi-cache-estable@0.1.0` una vez liberada esa versión por el publicador. Los sources npm y URLs de repositorio/galería requieren publicación autorizada por separado; un checkout local no los vuelve disponibles.
