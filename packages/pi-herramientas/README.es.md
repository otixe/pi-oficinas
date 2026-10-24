# @otixe/pi-herramientas

Todos los schemas viajan en el prompt aunque la tarea sólo necesite dos tools. Empezá con un catálogo compacto y activá herramientas registradas cuando hagan falta: un prompt inicial más liviano sin tirar capacidades.

[English](README.md) · MIT

## Dolores que resuelve

- Todos los schemas en cada request → catálogo compacto por grupos.
- Nombres adivinados o fuera del catálogo → intersección registradas/catálogo.
- Cambios de tools a mitad de request → activación en el siguiente request al modelo.

![De una pared de schemas a capacidades bajo demanda](media/preview.png)

## Instalación en un comando

Desde un checkout local revisado:

```sh
pi install ./packages/pi-herramientas
```

### Configuración

Creá `.pi/herramientas.json` en el cuerpo revisado:

```json
{"base":["read","bash"],"grupos":{"editing":{"linea":"Enable editing tools","tools":["edit","write"]}}}
```

Con config válida registra `herramientas_activar`; config ausente/inválida deja el arranque transparente. Pedí `grupo="editing"` o `nombres=["edit"]`. Sólo se activan tools registradas y catalogadas, en el próximo request al modelo.

`"base":"*"` deriva el universo directo registrado del cuerpo menos grupos. Perfil/runtime siguen definiendo ese universo; usá base explícita para una superficie inicial pequeña. Con membresía equivalente conserva el orden del host.

## Verificación y rollback

Para quitarlo, `pi remove SOURCE` y reiniciá/recargá tu sesión de prueba; preservá logs, snapshots y sesiones.

Configuración del monorepo y validación reproducible: [README](https://github.com/otixe/pi-oficinas/blob/main/README.es.md), [VALIDATION](https://github.com/otixe/pi-oficinas/blob/main/VALIDATION.md).

## Seguridad y límites

Es selección, **no sandbox de seguridad**. No descarga/registra nuevas tools ni concede permisos de backend. Sólo activa la intersección registradas/catálogo; perfil y runtime siguen definiendo las capacidades del cuerpo.

Validado en Pi 1.4.0; los cinco paquetes host son peerDependencies `"*"`, nunca copias incluidas. Peers wildcard no prometen todas las versiones del host. Revisá fuente/trust antes de instalar: las extensiones corren con permisos del proceso. Las pruebas usan modelo/backend simulados y no certifican autenticación productiva.

Para archivos locales, extraé el tarball e instalá su directorio `package`: Pi 1.4.0 no carga sources de extensión `.tgz` aunque `pi install` tenga éxito. La instalación literal devuelve 0; la carga/print falla con exit 1. El README raíz muestra la extracción soportada.

La instalación desde registry usa `pi install npm:@otixe/pi-herramientas@0.1.0` una vez liberada esa versión por el publicador. Los sources npm y URLs de repositorio/galería requieren publicación autorizada por separado; un checkout local no los vuelve disponibles.
