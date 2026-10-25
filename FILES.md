# Package file inventory

Exact source files per package; archives contain these plus npm-normalized package metadata. Test fixtures and private evidence are not shipped. The six packages contain **99 files** in total.

## Repository-only resources (not shipped)

Root: `.gitignore`, `CHANGELOG.md`, `FILES.md`, `LICENSE`, `PACKAGES.md`, `README.es.md`, `README.md`, `SHA256SUMS`, `SOURCES.md`, `VALIDATION.md`, `package.json`.

Test harness: `tests/contracts.test.mjs`, `tests/fixture-server.py`, `tests/mock-cerebro.ts`, `tests/mock-provider.ts`, `tests/open-office.py`, `tests/smoke.py`.

`SHA256SUMS` covers every public checkout file except itself and `.git` (115 entries). Archive hashes and sizes are in `PACKAGES.md`. Tarballs, logs, fixture transcripts and clean test HOME directories remain outside this checkout.

## @otixe/pi-cache-estable (16 files)

```text
CHANGELOG.md
LICENSE
README.es.md
README.md
examples/herramientas.json
examples/tools-order.json
extensions/aa-cache-retention-1h.ts
extensions/aa-tools-order.ts
extensions/tools-runtime-coherence.ts
lib/config.ts
lib/herramientas-activar.ts
lib/tools-order-runtime.ts
lib/tools-order.ts
lib/tools-runtime-coherence.ts
media/preview.png
package.json
```

## @otixe/pi-cerebro-ama (19 files)

```text
CHANGELOG.md
LICENSE
README.es.md
README.md
bin/measure-jsonl.py
examples/cerebro-surface.json
examples/equipo.example.json
examples/herramientas.json
examples/measurement.json
extensions/cerebro-mcp.ts
extensions/herramientas-activar.ts
lib/cerebro-identity.ts
lib/cerebro-surface.ts
lib/herramientas-activar.ts
lib/team-config.ts
package.json
tests/cerebro-surface.test.mjs
tests/measure.test.py
tests/profiles.test.mjs
```

## @otixe/pi-herramientas (9 files)

```text
CHANGELOG.md
LICENSE
README.es.md
README.md
examples/herramientas.json
extensions/herramientas-activar.ts
lib/herramientas-activar.ts
media/preview.png
package.json
```

## @otixe/pi-oficinas (35 files)

```text
CHANGELOG.md
LICENSE
README.es.md
README.md
bin/equipo_config.py
bin/oficina
bin/oficina_distribucion.py
bin/oficina_layout.py
bin/oficina_ordenar.py
examples/.env.example
examples/SOUL.md
examples/distribucion.json
examples/equipo.json
examples/worker.md
extensions/context-leader-adapter.ts
extensions/context-pending.ts
extensions/context-relaunch.ts
extensions/context70.ts
extensions/secretaria-cerebro-client.ts
extensions/secretaria-core.ts
extensions/secretaria-correspondence-flow.ts
extensions/secretaria-correspondence-reservation.ts
extensions/secretaria-correspondence.ts
extensions/secretaria-cost.ts
extensions/secretaria-flow.ts
extensions/secretaria-leader-registry.ts
extensions/secretaria-monitor.ts
extensions/secretaria-state.ts
extensions/secretaria-vigilancia.ts
extensions/secretaria.ts
extensions/vm-turno.ts
lib/cerebro-identity.ts
lib/team-config.ts
media/preview.png
package.json
```

## @otixe/pi-plan-gate (8 files)

```text
CHANGELOG.md
LICENSE
README.es.md
README.md
extensions/plan-gate.ts
lib/backend.ts
media/preview.png
package.json
```

## @otixe/pi-renovacion (12 files)

```text
CHANGELOG.md
LICENSE
README.es.md
README.md
extensions/context-budget-alert.ts
lib/config.ts
lib/context-leader-adapter.ts
lib/context-pending.ts
lib/context-relaunch.ts
lib/context70.ts
media/preview.png
package.json
```

