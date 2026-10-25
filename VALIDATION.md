# Validation and its limits

Target: **Pi 1.4.0**, Python 3.14.7, Node 26.12.1 (contracts) / 26.10.0 (isolated Pi runners), npm 12.2.0, Gitleaks 8.30.1. These are observed test versions, not guarantees for every wildcard peer version. All workspaces, clean HOME directories and retained evidence are under `~/work`, never the live team bodies.

## Observed final outcome

| Check | Result |
| --- | --- |
| Focused contracts | 20/20 PASS, none skipped |
| Test-harness boundaries | 3/3 refusals: live HOME for either driver; unmanaged Herdr caller |
| Python shipping scripts | 5/5 AST PASS |
| New archives | 5/5 packed and inspected; fixtures/private files excluded |
| Independent extracted-package Pi prompts | 5/5 PASS |
| Combined unconfigured/configured Pi prompts | PASS; configured tools visible in model request |
| Packaged-CLI office opening | PASS with real Pi/Herdr, explicit model/backend doubles |
| Isolated cleanup | Named session stop exit 0; server and model fixture exited |
| Gitleaks directory / fresh Git history scans | 0 findings, no suppressions |
| Git | Sanitized history; two existing local commits and a public origin configured. AMA remains an uncommitted candidate; this delivery performed no commit, push or publication |

Package/archive inventories and hashes are in [FILES.md](FILES.md), [PACKAGES.md](PACKAGES.md) and `SHA256SUMS` (all public files except the checksum file itself and `.git`; verify with `sha256sum -c SHA256SUMS`). The final clean-HOME rerun reproduced all five recorded archive hashes. Raw logs, failed attempts, five archives and fixture transcripts are retained externally for review; they are not public package resources. Final drivers force `TMPDIR` beneath the test HOME and reject HOME outside the OS user’s `work` directory before writes/installation.

## What is exercised

- **20 focused contracts:** manifests/host peers, ordering without membership expansion, registered/catalog intersections, invalid configuration, high/unknown context deferral, session-bound snapshots, bounded relaunch grammar, explicit team configuration and credential-variable collision rejection, own office credentials, ambiguous delegation, safe prompt reads, durable plan ACK/attribution, failed ACK, restore failure and human review.
- **Real Pi installation and prompts:** five archives from `npm pack`; literal tarball installation; each extracted package alone; all five together; configured leader tools shown in the actual model request. No extension-load errors in the supported route. All configuration and credentials for these tests are explicit test fixtures, not inherited cloud/backend credentials.
- **Real office opening:** packaged Python CLI, real Pi and real Herdr in a unique named headless test session. The fresh gate checks tool results, own role/key-variable attribution, SOUL, active tools, session/model/thinking and pane ownership. The real registry and gate marker are inspected. Herdr’s official Pi integration is installed only in the test HOME; the test session/server is then stopped, without touching the caller’s session.
- **Sanitation:** forbidden-reference/path scans, nonzero 12-digit account-format scan, resource/import/manifest/license checks and `gitleaks dir` (no rule suppression/baseline). The all-zero UUID in the authorization probe is a deliberately nonexistent task sentinel, not an AWS account.
- **Sanitized Git repository:** no inherited upstream source history. The existing public origin is left unchanged; this AMA delivery makes no commit, push or publication. `SOURCES.md` retains original hashes and source classes. `FILES.md` inventories the package files.

### Known literal-tarball limitation

Pi 1.4.0 accepts `pi install ./archive.tgz` and writes a local source with exit 0, but the ensuing `pi -p` rejects it as **unknown extension `.tgz`** (observed exit 1). Success of the install command is **not** a successful load.

The test records this failure, removes those declarations, extracts each archive into a new directory and runs the supported `pi install /path/to/extracted/package`. Independently loaded packages and combined/configured prompts must then succeed. No host patch or alternate tarball disguise is used. The READMEs document this supported route; future registry installation uses `npm:@otixe/<package>@0.1.0` after publication.

### What is NOT proved

Model and backend are **loopback test doubles**. The fixture `cb_whoami`/`cb_vault_read` callbacks are synthetic and explicitly opt-in; they are excluded from all package tarballs. Their successful opening proves transcript/gate mechanics with controlled callbacks, **not** authentication/authorization to a production backend. No real cloud model, live office, VM or Telegram delivery is exercised. No cache hit rate/cost saving, complete mail delivery, automatic leader renewal, durable harvest or production deployment is claimed. Tests with disabled secretary timers do not prove every monitoring/correspondence scenario.

Plan mode is a workflow gate: `bash`/`bg_run` remain usable and logged, other tools are not a complete write detector, and restore failure leaves visible idle rather than security protection.

## Reproduce without live credentials

Use a reviewed Pi 1.4.0 executable; do not install/update a live body runtime. Root scripts are test-only and not package resources. In Bash:

```sh
PI_BIN="$(command -v pi)"
HERDR_BIN="$(command -v herdr)"
HOST_MODULES="$(dirname "$(dirname "$PI_BIN")")"
PUBLIC_ROOT="$PWD"
mkdir -p "$HOME/work"

# Native Node TypeScript tests; disposable files are retained under work.
env -i HOME="$HOME" PATH=/usr/bin:/bin \
  PI_TEST_WORK="$HOME/work" PI_TEST_RUNTIME="$HOST_MODULES" \
  node --test "$PUBLIC_ROOT/tests/contracts.test.mjs"

# Empty HOME: no inherited Pi settings or credentials. Five pack/install/load tests.
CLEAN_HOME="$(mktemp -d -p "$HOME/work")"
env -i HOME="$CLEAN_HOME" PATH=/usr/bin:/bin \
  python3 "$PUBLIC_ROOT/tests/smoke.py" --pi "$PI_BIN"

# Only run when the CALLER is already Herdr-managed. The driver controls ONLY
# its own unique named test server, with socket/data paths beneath CLEAN_HOME.
test "${HERDR_ENV:-}" = 1 && \
  env -i HOME="$CLEAN_HOME" PATH=/usr/bin:/bin HERDR_ENV=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    python3 "$PUBLIC_ROOT/tests/open-office.py" --pi "$PI_BIN" --herdr "$HERDR_BIN"

# Install Gitleaks from its verified official release; no secret suppressions.
gitleaks dir "$PUBLIC_ROOT" --redact
```

Do not set `HERDR_ENV=1` to bypass an unmanaged caller: first verify the actual caller as shown. Retain stdout/stderr, archive manifests/hashes, `smoke/results.json`, `office-opening/result.json` and cleanup diagnostics. Failed attempts and the unsupported tarball path remain evidence, not deleted to create a green summary.

## AMA addition

`@otixe/pi-cerebro-ama` 0.1.0 is validated separately as a replacement bridge/activator:

- Surface contracts: 18/18 from source and the extracted 19-file archive (the original 11 intact plus seven leader/subagent tests).
- Offline JSONL utility: 8/8 tests, retaining old-session classification, transition/cacheWrite separation, fork/duplicate exclusions, malformed usage, read-only input seals and exclusive output creation; adding profile partitions, independent profile cutoff and invalid-profile checks.
- Fresh Pi 1.4.0 SDK, no provider: eight subagent or fourteen leader active direct core tools, profile-aware optional registry/codemode callability and real `cb_whoami` output `superficie_cb=ama` plus `perfil_cb`. Both source and extracted public packages are tested independently of any duplicate bridge.
- The SDK uses an explicitly nonexistent identity and cached tool schemas: authentication is not exercised, every network attempt is prohibited, and a real nested codemode call fails closed rather than borrowing another identity. This is surface/guard validation, not production authentication or permission acceptance.
- The original five shipping packages remain unchanged by AMA (80/80 checkout files byte-identical to the existing pre-AMA HEAD). The root smoke harness explicitly selects those five; it never co-loads AMA with a duplicate Cerebro bridge or herramientas activator. AMA has its own packaged tests and separate SDK acceptance.
- The unchanged original-five candidate retains its accepted 20/20 contracts and independent/combined extracted-load evidence. R6 checks: 18/18 AMA contracts, 8/8 offline measurement tests from source and extracted archive; separate public-source/extracted SDK shadows for both profiles with zero provider/network requests. These shadows validate registered exposure under supplied role allowlists, not productive owner authentication or actual old-pane activation.
- All six current archives are source-matched and repeat-pack byte-identical. The five original archives were refreshed to match current checkout manifest metadata (repository/author/homepage/bugs); their shipping sources were not edited. Prior artifacts and seals remain historical evidence, not substitutes for this candidate's hashes in `PACKAGES.md`.
- Current directory and Git-history Gitleaks scans report zero findings without suppressions. Current inventory is 116 checkout files, 99 package files and 115 independently verified checksum entries.
- The AMA addition is retained as a worktree candidate pending gate review, not a new commit, push or npm publication. Existing history contains the prior package delivery and its npm-metadata follow-up; current checkout hashes are independently listed in `SHA256SUMS`.

Offline commands from the repository root:

```sh
(cd packages/pi-cerebro-ama && npm test)
python3 packages/pi-cerebro-ama/tests/measure.test.py
python3 packages/pi-cerebro-ama/bin/measure-jsonl.py YOUR_MANIFEST.json --output NEW_REPORT.json
```

## Rollback and residues

Only these new source/test workspaces are affected. Remove each installed test source via `pi remove SOURCE`, reload/restart test Pi, and retain test sessions/markers/audit logs for review. The office test stops its unique server after checking ownership; it never closes an ambiguous live pane. Do not delete session evidence as an installation rollback. New test HOME directories, tarballs and historical red/green logs intentionally remain under `~/work`. Reviewers receive their local paths separately; those private absolute paths are not public artifacts.
