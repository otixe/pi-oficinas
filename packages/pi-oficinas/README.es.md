# @otixe/pi-oficinas

Una sola sesión Pi programa, revisa e investiga a la vez. Convertí esa sobrecarga en un equipo persistente: cada oficina conserva historial, identidad, credenciales y bandeja propios, con relevos verificados antes de empezar el trabajo.

[English](README.md) · MIT

## Dolores que resuelve

- Una sesión haciendo todos los roles → coordinación persistente líder/oficinas.
- Confusión de credenciales o sesiones → roles explícitos, key propia y gate de apertura con nonce fresco.
- Trabajo pendiente invisible → timbres, correspondencia y turnos locales de VM.

![Una sesión sobrecargada se convierte en un equipo persistente](media/preview.png)

## Instalación en un comando

Desde un checkout local revisado:

```sh
pi install ./packages/pi-oficinas
```

### Requisitos y configuración

Pi 1.4.0, Python 3.10+, Herdr y su integración oficial (`herdr integration install pi`).

1. Adaptá `examples/equipo.json` y `examples/distribucion.json` (sólo schema 2), con rutas absolutas dentro de tu base. Pinneá `pi_bin` o instalá `<base>/runtime/node_modules/.bin/pi`: nunca se adivina el runtime global.
2. Configurá `PI_OFICINAS_EQUIPO` como archivo propio sin symlink. El pointer `.env` de cada cuerpo debe ser único y privado (`0600`). Declarará `AGENT_NAME`, `BODY_ROLE`, `AGENT_ENABLED`, variable de credencial propia y `SOUL_PATH`; `examples/.env.example` no trae credenciales.
3. Prepará/revisá cuerpos, fichas líder/oficina idénticas, `.pi/APPEND_SYSTEM.md` y `.pi/oficina-body`. El SOUL y la ficha de ejemplo están **inactivos**: no autorizan identidades de producción. La CLI no crea cuerpos automáticamente.
4. Proveé una integración confiable con `cb_whoami` y `cb_vault_read`. Configurá `CEREBRO_BASE`, `CEREBRO_AUTH_HEADER` (default `X-API-Key`) y `PI_OFICINAS_HUMAN` (default `human`).
5. Desde el package, ejecutá `python3 bin/oficina --equipo /absolute/path/equipo.json abrir worker` en el pane líder revisado. El gate verifica resultados frescos de identidad/SOUL propio, modelo/thinking, tools, sesión y propiedad del pane. El marker solo no autoriza nada.

Sin equipo/cuerpo explícito coincidente, secretaría queda inactiva. Siguen los campos opcionales `pi_coding_agent_dir`, `pi_coding_session_dir`, `relanzar_modo`. Mini puede compartir sólo la identidad de su padre por opt-in local; `PI_OFICINAS_MINI_MODEL` permite pin de modelo canónico. Nunca heredar keys de otro rol.

## Verificación y rollback

Para quitarlo, `pi remove SOURCE` y reiniciá/recargá tu sesión de prueba; preservá logs, snapshots y sesiones.

Configuración del monorepo y validación reproducible: [README](https://github.com/otixe/pi-oficinas/blob/main/README.es.md), [VALIDATION](https://github.com/otixe/pi-oficinas/blob/main/VALIDATION.md).

## Seguridad y límites

Revisá el código antes de instalar: las extensiones ejecutan con permisos del proceso, **no en un sandbox**. El gate no reemplaza autorización del backend o aislamiento del sistema operativo. La CLI no crea cuerpos automáticamente; los perfiles neutros están inactivos y el marker solo no autoriza nada. Nunca heredar keys de otro rol. No se incluye cliente Cerebro, credenciales ni almas reales.

Validado en Pi 1.4.0; los cinco paquetes host son peerDependencies `"*"`, nunca copias incluidas. Peers wildcard no prometen compatibilidad con todas las versiones del host. Las pruebas usan Pi/Herdr reales y modelo/backend simulados: **no certifican autenticación productiva**. La instalación requiere revisar fuente/trust.

Para archivos locales, extraé el tarball e instalá su directorio `package`: Pi 1.4.0 no carga sources de extensión `.tgz` aunque `pi install` tenga éxito. La instalación literal devuelve 0; la carga/print falla con exit 1. El README raíz muestra el comando de extracción soportado.

La instalación desde registry usa `pi install npm:@otixe/pi-oficinas@0.1.0` una vez liberada esa versión por el publicador. Los sources npm y URLs de repositorio/galería requieren publicación autorizada por separado; un checkout local no los vuelve disponibles.
