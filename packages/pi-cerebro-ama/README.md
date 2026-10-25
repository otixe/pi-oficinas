# @otixe/pi-cerebro-ama

## Your agent needs memory, not a wall of memory-tool schemas

When every memory, task and coordination capability is declared on every request, the tool surface grows before the agent does any useful work. Removing those capabilities is not the answer either: long-running agents still need to read, record and coordinate.

**AMA — Agent Memory Access keeps eight everyday tools direct for subagents, or up to fourteen for leaders, and makes permitted optional tools callable through `codemode`.** One package supports both profiles; the model does not need every optional schema in its direct tool list.

- **Too many memory schemas → a small, stable core.** Keep identity, task handoff, notes and retrieval within reach.
- **Hidden capabilities become unusable → callable optional tools.** Use `tools.cb_…` inside codemode without expanding the direct tool list.
- **Different agents need different permissions → identity stays local.** Existing allowlists, per-agent keys and server-side authorization still govern every call.

```text
Before: every registered memory schema is direct
AMA:    8 subagent / up to 14 leader direct tools + codemode → permitted optional cb_*
```

## Who is this for?

Teams with many memory/coordination tools, agents with long sessions, and authors/reviewers who need the same memory service without sharing credentials. AMA is a surface adapter for an existing Cerebro MCP deployment, not a new memory server.

## Install locally

From the repository root, after reviewing this package:

```bash
pi install ./packages/pi-cerebro-ama
```

Use a fresh process after installation/configuration. This package replaces the existing **Cerebro bridge and herramientas activator**; do not load a second `cerebro-mcp.ts` or install `@otixe/pi-herramientas` alongside its activator. Preserve the old files/settings as a backup before disabling duplicate entries. It does not replace your provider, memory service or team configuration.

## Configure

1. Keep an explicit, validated `PI_OFICINAS_EQUIPO` team configuration and your agent's own key. The included identity resolver uses the same version-2 team configuration as `@otixe/pi-oficinas`; see `examples/equipo.example.json`. Replace example paths/names with your own, provision credentials out of band, and make the configuration owner-controlled, not group/world-writable. Do not put real keys in the package.
2. Point `CEREBRO_MCP_URL` at your MCP endpoint if it is not `http://127.0.0.1:8766/mcp`.
3. Create a valid `.pi/herramientas.json` catalog. Copy `examples/herramientas.json` as a starting point and preserve your existing non-memory tools/groups. Include the optional tools permitted for your role; a catalog does **not** override Pi's registration/launch allowlist or server RBAC.
4. Create `.pi/cerebro-surface.json`:

```json
{"mode":"ama"}
```

5. For a leader, use `{"mode":"ama","perfil":"lider"}`; an omitted profile defaults to `subagente`, and `{"mode":"ama","perfil":"subagente"}` is equivalent. Start a new Pi process with built-in codemode available. Call `cb_whoami` and inspect `superficie_cb : ama`, `perfil_cb` and the active tools. Authentication acceptance alone does not establish server attribution; verify attribution separately with an authorized write/read if your role permits it.

Missing/invalid flag or missing/invalid catalog keeps traditional mode. `{"mode":"code"}` remains a legacy alias for AMA. Without registered codemode the activator does not shrink the active set; treat that as a failed AMA acceptance, not success.

### Two profiles, one package

The `subagente` profile keeps the eight direct core tools:

`cb_whoami`, `cb_correspondencia_resumen`, `cb_task_get`, `cb_task_comment`, `cb_task_submit`, `cb_vault_read`, `cb_memory_add`, `cb_memory_search`.

The `lider` profile adds six frequent coordination tools: `cb_task_activity`, `cb_correspondencia_leer`, `cb_task_create`, `cb_correspondencia_ok`, `cb_task_update`, `cb_task_review`—at most 14 direct, and only when already registered/allowlisted. The six were selected from completed direct/nested call records in seven leaders' seven-day session census, not strings in generated code. Failed attempts count as calls; this is not a cost/savings measurement.

Other permitted registered capabilities receive `exposure: "codemode"`, not `hidden` and not unregistered. Known leader/admin-only routes (agent/leader provisioning/list/revoke, consolidation analysis, retrieval evaluation, skill mining and approval admin actions) are `hidden` and omitted from the optional catalog in the subagent profile. A leader profile does **not** grant these permissions: deployment role allowlists and server RBAC still apply; ordinary task review remains optional for authorized subagent auditors.

Within codemode, for example:

```js
const result = await tools.cb_task_activity({ task_id: "your-task-id" });
console.log(result);
```

**Do not activate optional tools halfway through a session merely to call them.** Changing the direct tool set can invalidate prompt cache. Use `herramientas_activar` only when codemode cannot meet the need, and record why. The activator remains available for compatibility; AMA does not make it a security boundary.

## Measure real sessions offline

With Python 3.10+, supply a manifest listing explicit JSONL globs for each body, house and `leader`/`office` role. Set the deployment start and finish (`cutoff`) timestamps with timezones, or label controlled runs `phase: "baseline"` / `"ama"`. See `examples/measurement.json`.

```bash
python3 packages/pi-cerebro-ama/bin/measure-jsonl.py measurement.json --output comparison.json
```

The script reads session files without modifying them or calling a provider. It exports numeric usage/date/model metadata, not prompts or tool-result content. Input is `input + cacheRead + cacheWrite` (not `totalTokens`, and no second addition of the `cacheWrite1h` subset). It reports first-request tokens, median input tokens, mean/median recorded cost per request and like-model baseline→AMA deltas by house/role/profile. Declare `perfil: "lider" | "subagente"` in each manifest item (omitted means `subagente`). Optional zoned `perfil_cutoff` and `perfil_before` preserve the earlier eight-tool profile for sessions starting before a leader-profile rollout. To classify known old-process resumes or `/new`, supply explicit per-session profiles instead of a cutoff; profiles are declared/inferred labels, not observed runtime proof. Comparisons never mix profiles. Requests with high cacheWrite are a separate partition; defaults are at least 10,000 tokens **and** 20% of input, both configurable.

Classification is by **session start**, so an old pane remains baseline after rollout; starts during deployment are separated as transition. Copied fork history and duplicate request IDs are excluded. An after-cutoff start only infers AMA: confirm the actual surface with whoami. High cacheWrite can have causes other than tool activation, and recorded costs may be estimates or zero.

## Test and roll back

```bash
cd packages/pi-cerebro-ama
npm test
python3 tests/measure.test.py
npm pack --dry-run
```

Tests require Node 22.18+ (native TypeScript stripping) and cover strict opt-in, all eight core tools, legacy alias parity, missing-codemode fallback, allowlist projection, preservation of non-memory groups, startup and reconciliation. They retain the original 11 contracts and add profile/core-cap, leader/admin exclusion and activator tests. Offline measurement tests check profile partitions and cutoffs. They do not call a provider or authenticate a production service.

To restore the traditional surface, remove `.pi/cerebro-surface.json` and open a **new** process. To uninstall/revert the integration, also restore the saved bridge/activator/settings. Removing the flag does not undo catalogs or launch-allowlist changes.

## Security & limits

- Extensions execute in-process with your OS permissions. Codemode is an execution facility, **not a sandbox** or a replacement for service authorization.
- A smaller direct tool list is not a smaller permission set. Allowlists, own-agent credentials, fail-closed identity checks and server ACL/RBAC must remain enforced. Do not borrow a leader's or another office's key.
- The adapter requires an existing compatible Cerebro service, explicit team configuration and a Pi runtime with tool exposure/codemode support. Peer dependencies come from the host; no service, credentials or provider is bundled.
- The role catalog is deployment-specific. Conditional ownership/scope restrictions still apply, and some core tools may be denied to read-only agents.
- Observed schema-token changes were roughly **−50% with a full catalog and −3% with a restricted office profile**. These pre-leader-profile observations are not universal savings promises; fourteen-tool leaders have no new savings measurement here. Cache writes, models and billing can change costs. Measure your own sessions offline.
- This package targets Pi's exposure/codemode API used in 1.4.0. Successful installation alone is not proof of loading. If a runtime cannot load a local `.tgz` directly, extract it and install the directory; verify a fresh process.
