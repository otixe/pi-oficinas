# Your Pi session needs a team

Your single Pi session is doing everything: coding, reviewing, researching. Context fills up, handoffs disappear, and the author ends up checking its own work. **pi-oficinas turns that overloaded session into a persistent team.**

- **Separate working memory and inboxes:** each office keeps its own identity, credentials and session history, so one role does not have to carry everyone else's context.
- **A reviewer who isn't the author:** give implementation and review different offices, and use an explicit human approval workflow before accepted execution.
- **Restart without starting from scratch:** keep session histories in separate bodies and reopen or resume owned sessions through checked office flows.

MIT · **0.1.0** · [Español](README.es.md)

## Start with one command

From a reviewed local checkout, install the team package, then configure your offices:

```sh
pi install ./packages/pi-oficinas
```

![One overloaded session becomes a persistent team](packages/pi-oficinas/media/preview.png)

## Who is this for?

- You run long-lived agents and want separate roles, session histories and visible pending work.
- You want an author and a reviewer, rather than one agent approving its own implementation.
- You pay too much in tokens when tool schemas churn and want a steadier prompt-cache prefix.

## Pick the pain you want to solve

Start with one package or combine them. Each has its own bilingual README, configuration and workflow preview.

| Package | What gets better | Configuration |
| --- | --- | --- |
| [`@otixe/pi-oficinas`](packages/pi-oficinas/README.md) | Split overloaded sessions into persistent offices with checked handoffs and visible pending work | Explicit `equipo.json`, owned body profiles, environment and a compatible backend/tool integration |
| [`@otixe/pi-cache-estable`](packages/pi-cache-estable/README.md) | Keep tool order steady and request longer retention so avoidable schema churn stops breaking the prefix | `PI_CACHE_RETENTION`, optional `.pi/tools-order.json` |
| [`@otixe/pi-renovacion`](packages/pi-renovacion/README.md) | Spot context pressure early and keep new tasks away from saturated offices while current work finishes | `CONTEXT_ALERT`, `CONTEXT_WINDOW`, `CONTEXT_ALERT_PCT`; injected relaunch dependencies |
| [`@otixe/pi-plan-gate`](packages/pi-plan-gate/README.md) | Turn “plan first” into an acknowledged plan and a traceable human review | `PLAN_GATE_*` variables and compatible checkpoint/task endpoints |
| [`@otixe/pi-herramientas`](packages/pi-herramientas/README.md) | Start with a compact tool catalog and bring in registered tools when the task needs them | `.pi/herramientas.json` |

## Requirements and installation

Test target: Pi **1.4.0**. The packages declare the five host libraries as `peerDependencies: "*"`, with no bundled host copies. Python 3.10+ and Herdr are needed for the office CLI. Install Herdr's official Pi integration in your reviewed test/user HOME (`herdr integration install pi`) so native session/status reporting is available; the opening gate fails without it. Node's direct TypeScript test runner requires Node 24+; Pi itself loads TypeScript through its extension loader.

Add the packages that fit your workflow:

```sh
pi install ./packages/pi-cache-estable
pi install ./packages/pi-herramientas
```

The CLI can be called directly with Python, or through the `oficina` bin link when installed by npm. Pi's local package installation does not create an npm bin link.

## Configuration

### Offices

See [`packages/pi-oficinas/examples`](packages/pi-oficinas/examples). Configuration schema remains version 2; team names, roles, vault paths and credential **variable names** come from this explicit file. Set `PI_OFICINAS_EQUIPO` to an absolute, owned, nonsymlink file, or use `oficina --equipo FILE ...`. No installed-package/canonical-team fallback exists. A local body's `.env` pointer must be unique, exact and private (`0600`). The leader and offices must be descendants of `base`; profile, marker, session and pane ownership checks remain fail-closed. The CLI supports distribution schema **2 only**.

`CEREBRO_BASE` and optional `CEREBRO_AUTH_HEADER` configure the compatible backend; no private hostname/default server exists. `PI_OFICINAS_HUMAN` configures the human account name (default `human`). Provision distinct actual keys through your private environment/body files, never the example or Git. The secretary registers only in an explicitly configured, matching body. An unconfigured installation is inert. A malformed explicit configuration fails visibly.

Opening requires real `cb_whoami`/`cb_vault_read` tools from your trusted backend integration, authenticated owner attribution, a matching neutral-or-personal SOUL, fresh nonce-bound tool results, model/thinking/profile agreement and no Telegram tools. A marker alone authorizes nothing. The gate is designed for Pi's 1.4 transcript structure. Optional mini-helper identity sharing is body-local opt-in, limited to its own parent; its canonical profile is checked. `PI_OFICINAS_MINI_MODEL` may further pin the helper model. Do not reuse another role's credentials.

The office runtime is selected by the team `pi_bin` pin, when present (`<base>/runtime/node_modules/.bin/pi`), or the existing documented body/runtime policy. `pi_coding_agent_dir=.pi-agent`, `pi_coding_session_dir=sessions` and `relanzar_modo` are optional existing schema fields. No automatic body creation or credential provisioning is implemented by the CLI. Create/review the bodies first.

### Cache stability

Installing selects `PI_CACHE_RETENTION=long` unless already set. Set `PI_CACHE_RETENTION=short` or `PI_CACHE_ESTABLE_RETENTION` as desired before loading. Ordering uses a checked host `AgentSession` adapter; an unsupported host fails with `TOOLS_ORDER_UNSUPPORTED_HOST`.

Example `.pi/tools-order.json`:

```json
{"version":1,"priority":["read","bash","edit","write","plan_*"],"unlisted":"alphabetical"}
```

### Renewal alerts

`CONTEXT_ALERT=0` disables alerts. Otherwise enabled; default thresholds `[80]`, configurable as `CONTEXT_ALERT_PCT=50,80`. `CONTEXT_WINDOW` overrides model metadata; fallback is 1,000,000 if neither is available. **Set it for models with unknown metadata.**

Alerts notify the UI and append `state/context-budget-alert.jsonl`. Telegram is optional and only used for Telegram-origin prompts through an existing `@llblab/pi-telegram/delivery`. The anchored optional lookup uses the body's `.pi/npm/node_modules`, not a private machine path.

`lib/context70.ts` defers new office tasks at 70% or unknown usage but allows the current working task to continue. Snapshots require matching session identity and regular owned files; stale high-context remains high until the session changes. Coordination libraries require injected authenticated task/pane/gate callbacks. `context-leader-adapter.ts` needs an explicit absolute `officeCli`/`PI_OFICINAS_CLI` unless `runRelaunch` is injected; no cross-package filesystem guess is made.

### Plan gate

Set `PLAN_GATE_BASE_URL`, `PLAN_GATE_AGENT`, `PLAN_GATE_KEY_ENV` (default `PLAN_GATE_KEY`), and export that credential variable. Optional `PLAN_GATE_AUTH_HEADER` (default `X-API-Key`), `PLAN_GATE_APPROVER` (default `human`), `PLAN_GATE_ROOT`, `PLAN_GATE_READONLY_AGENTS` (JSON array; default `[]`). Without a backend URL the package loads idle/inactive; commands still cannot enter a plan without durable ACK. No implicit local approval exists.

Backend contract: agent checkpoint save/latest endpoints, `/task/create`, `/task/claim`, `/task/update`, `/task/submit`, `/task/get`, `/task/activity`, and `/task/comment`; preserve returned owner attribution and task review activity. State is restored under `session_ref=plan-gate`. A failed transition stays in the previous phase. Startup failure leaves visible `idle` (it does **not** establish planning protection). Only `pass`/`needs_changes` reviews by the configured human approver count. Agent principal credentials are environment-only; explicit office/delegate markers are rejected.

In planning/awaiting, `edit` and `write` are blocked; subagents are blocked unless explicitly declared read-only. Read the shell and restore-failure boundaries in **Security & limits** before relying on this workflow. `/plan off` is a human workflow override requiring remote confirmation, not an authorization bypass.

### Tools on demand

Example `.pi/herramientas.json`:

```json
{"base":["read","bash"],"grupos":{"editing":{"linea":"Enable editing tools","tools":["edit","write"]}}}
```

`herramientas_activar` accepts `grupo` or `nombres`. Only tools that are both registered and in the catalog can become active. Absent/invalid configuration is transparent. `"base":"*"` derives the body universe minus group tools; it does not override the profile's tool universe or add permissions.

## Development and rollback

`npm pack` each package; scan with `gitleaks dir .`; run the focused tests and isolated Pi smoke described in `VALIDATION.md`. Tarballs/evidence belong outside the source tree. The public repository is new, with no inherited Git history; upstream provenance is recorded in `SOURCES.md`. Packages can be inspected independently and have no filesystem imports into sibling packages.

Remove an installed source with `pi remove SOURCE`, then reload/restart your test session. Keep audit/snapshot/session evidence; do not delete it as an installation rollback. An office gate failure does not grant permission to close or overwrite an unverified pane/session. Follow the CLI's ownership checks and inspect ambiguous residue manually. To roll back the local checkout, archive/remove it after preserving its evidence; no live body has been installed, enabled or patched by this extraction.

## Security & limits

### Permissions and scope

Review source first: installed extensions run with your process permissions. They are **not a security sandbox**. A plan gate or tool catalog is not a substitute for backend authorization or OS isolation.

**Not included:** a public Cerebro client package, account credentials, real souls, live team configuration, private histories, automatic deployment, or the separate experimental automatic-leader-renewal controller. Renewal here is the current template/body alert and office coordination protocol; it does not run `/new` in the leader. Office relaunch uses the validated office CLI, never a guessed session.

### Cache and renewal boundaries

Provider support, prices and actual cache hits vary; stable order does not guarantee caching, a fixed TTL or token/cost savings. No permissions or tool membership are expanded. Diagnostics use declared names only and never authenticate an agent.

The renewal observer never disables compaction, cuts a session, changes prompts, or assumes work was durably harvested. Missing provider costs appear as zero (not proof of a free request). Missing/denied Telegram delivery is recorded and caught; no Telegram bridge or credentials are bundled.

### Planning is a workflow, not isolation

**`bash` and `bg_run` remain available and are logged; other tools are not a complete write detector.** Shell writes are possible: this is a workflow gate, not a read-only sandbox. Audit logs may contain commands/paths; review them for secrets before sharing. Startup/restore failure leaves visible `idle`; it does **not** establish planning protection.

### Local archives and distribution

For a locally packed archive, extract it to a new directory and install the extracted `package` directory. Pi 1.4.0 treats local file paths as extension sources; do **not** assume a successful `pi install ./name.tgz` means the archive's extensions loaded. The literal install returns 0 but the tested print/load fails with unknown extension `.tgz` (exit 1).

```sh
mkdir -p ./artifacts
npm pack ./packages/pi-herramientas --pack-destination ./artifacts
mkdir ./extracted-tools
tar -xzf ./artifacts/otixe-pi-herramientas-0.1.0.tgz -C ./extracted-tools
pi install ./extracted-tools/package
```

Registry installation uses `pi install npm:@otixe/pi-herramientas@0.1.0` (or the chosen package name) once the publisher releases that version. npm sources and repository/gallery URLs require separately authorized publication; a local checkout does not make them available. No push or publication is performed by this extraction.

### What validation proves

The observed target is Pi 1.4.0, not every version allowed by wildcard peers. Office-opening tests use real Pi/Herdr with explicit model/backend doubles: they prove gate mechanics, **not production authentication/authorization**. No cloud model, live office, VM or Telegram delivery, cache savings, complete mail delivery, automatic leader renewal, durable harvest or production deployment is claimed. See `VALIDATION.md` for all test limits.
