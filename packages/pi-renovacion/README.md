# @otixe/pi-renovacion

A long-running agent should not discover a full context window halfway through its next assignment. See pressure early, finish current work and defer new office tasks with session-aware budget alerts and guarded relaunch coordination.

[Español](README.es.md) · MIT

## Problems it removes

- Unexpected context exhaustion → configurable usage/cost alerts.
- New work assigned to a saturated office → session-bound deferral at high or unknown usage.
- Relaunch racing with unfinished work → reusable guarded coordination with explicit CLI dependencies.

![Context pressure becomes an early handoff signal](media/preview.png)

## Install in one command

From a reviewed local checkout:

```sh
pi install ./packages/pi-renovacion
```

### Configuration

`CONTEXT_ALERT=0` disables alerts. Otherwise defaults to threshold `[80]`; set `CONTEXT_ALERT_PCT=50,80` as needed. `CONTEXT_WINDOW` overrides model metadata; fallback is 1,000,000 tokens when metadata is absent. Set it explicitly for an unknown model.

Alerts notify the UI and append `state/context-budget-alert.jsonl`. Optional Telegram delivery uses an already installed body-local bridge for Telegram-origin turns.

`lib/context70.ts` defers new tasks at 70% or unknown usage, never cancels current working tasks. Snapshots require owned regular files and the same session. Stale high-context stays high until a session change. The relaunch libraries require injected authenticated task/pane/gate callbacks and absolute `officeCli`/`PI_OFICINAS_CLI` unless `runRelaunch` is injected. No sibling-package path is guessed.

## Validation and rollback

To remove, `pi remove SOURCE`, then reload/restart your test session; preserve logs, snapshots and sessions.

Full monorepo configuration and reproducible validation: [README](https://github.com/otixe/pi-oficinas/blob/main/README.md), [VALIDATION](https://github.com/otixe/pi-oficinas/blob/main/VALIDATION.md).

## Security & limits

This is **not** the experimental automatic leader-renewal controller. It never runs leader `/new`, changes compaction settings, changes prompts or claims a durable harvest. Office relaunch is an explicitly validated integration. Missing cost data is shown as zero, **not** verified free usage. Telegram failures are caught, not claimed as delivery; no bridge or credentials are included.

Validated on Pi 1.4.0; the five host packages are peerDependencies `"*"`, never bundled copies. Wildcard peers do not promise every host version. Review source/trust before installation: extensions run with process permissions, not in a sandbox. Tests use model/backend doubles and do not certify production authentication.

For local archives, extract the tarball and install its `package` directory: Pi 1.4.0 does not load `.tgz` extension sources even when `pi install` succeeds. The literal install exits 0; print/load exits 1. The monorepo README shows the supported extraction command.

Registry installation uses `pi install npm:@otixe/pi-renovacion@0.1.0` once the publisher releases that version. npm sources and repository/gallery URLs require separately authorized publication; a local checkout does not make them available.
