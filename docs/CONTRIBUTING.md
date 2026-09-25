# Contributing to HaramLite (Developer Guide)

## Development requirements

- [Rust & Cargo](https://rustup.rs/) (stable, MSVC toolchain)
- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/) 10+
- Windows 10/11 (the primary target)

## Files excluded from Git

The `bin/` and `models/` directories are large and excluded from the repository — provide them
manually to developers:

1. `bin/` ← `ffmpeg.exe` + `ffprobe.exe` + `yt-dlp.exe`
2. `models/` ← `UVR-MDX-NET-Voc_FT.onnx`

> For the published application: the installer bundles both of them automatically, and the
> self-repair handler downloads them from the `assets-v1` release when they are missing (see
> below).

## Building and running

```bash
pnpm install
pnpm tauri dev          # development (generates tailwind.css automatically via predev)
pnpm build              # frontend only (fetch_redist + tailwind + tsc + vite)
pnpm tauri build        # NSIS installer + update artifacts (latest.json + .sig)
```

- When you change Tailwind classes in `index.html`, restart `pnpm dev` or run `pnpm build:css`.
- `src/tailwind.css` is generated (in gitignore).

## Project structure

```
src/                  the frontend (Vite + TS + Tailwind built locally)
src-tauri/src/
  pipeline.rs         the shared processing pipeline (GUI + CLI)
  separator.rs        the separation engine (ort / MDX-Net / STFT)
  media.rs            ffprobe/ffmpeg + normalization + encoding
  effects.rs …        the DSP chain (reverb/delay/EQ/compressor/LUFS/silence trimming)
  yt_dlp.rs           download + safe update (SHA-256 + atomic swap)
  repair.rs           the self-repair handler (component manifest + digest verification)
  settings.rs         the unified settings (JSON in app_data_dir)
  watch_service.rs    the watch folder (notify + periodic scan + disk guard)
  bridge.rs           Native Messaging with the browser extension
browser-extension/    MV3 extension (links only — no tracking)
.github/workflows/release.yml   releases (tauri-action + repair assets)
```

## A new release — the real path (as it was executed in 0.2.3)

> Warning: pushing the tag `vX.Y.Z` **builds nothing**. The tag trigger is **deliberately
> disabled** (`release.yml:19-26`) — **and the reason recorded there is "Actions storage"**,
> while the 0.2.7 review observed that standard-runner minutes are **free for public
> repositories**, so the reason **deserves re-measuring** (item B-3 in the 0.2.7 plan) rather
> than being built upon. And signing is **deferred** (`:70-71` commented out pending the
> secret) while `includeUpdaterJson: false` (`:83` — so no `latest.json` and no `.sig`).
> The steps below are what actually happens, not what was planned.

1. Bump the version in **the five places**: `package.json` · `src-tauri/tauri.conf.json` ·
   `src-tauri/Cargo.toml` · `src-tauri/Cargo.lock` (updated automatically on build — make sure
   the updated one is the committed one) · `browser-extension/manifest.json` (the extension has
   its own release path, independent of the application).
2. Build locally: `pnpm tauri build` (it produces both installers: NSIS + MSI).
3. Write `docs/RELEASE-X.Y.Z.md` with the digests **measured from your local build output**
   (`Get-FileHash -Algorithm SHA256`).
4. Publish from your machine:
   `gh release create vX.Y.Z --target <sha> --notes-file <the short release note> <NSIS_installer> <MSI_installer>`.
5. **And the release page is not the place for explanation** (owner decision 2026-09-17, and it
   holds for every coming release): the user reaches it from the **update button inside the
   application**, so it needs **simple information**: one title line + **2-4 short bullets** on
   what changed and who is affected + **the asset table with the digests**. The long explanation,
   the limits and the details belong in `docs/RELEASE-X.Y.Z.md` **in the repository** —
   **and its text is not copied to the page**. (And the 0.2.7 precedent: it was published with
   the long text, so the owner deleted it and kept the title and the table — thus the rule came
   from his decision, not from taste.)
6. **After publishing**: update the digests in `docs/RELEASE-X.Y.Z.md` from **the artifacts
   actually published** — an automated build does not match the local one byte for byte (proven
   on 0.2.2 and 0.2.3).
7. Alternative: run `release.yml` **manually** from the Actions tab (it builds and publishes
   without signing and without `latest.json` until the signing secrets below are added).

**And what has been added since 0.2.7 — release attestation (B-2):**

```powershell
git tag vX.Y.Z                     # the tag **first**: without it git_tag stays empty
node scripts/build-info.cjs        # ⇒ dist/release-metadata/{build-info.json,sbom.cdx.json}
gh release upload vX.Y.Z dist/release-metadata/build-info.json dist/release-metadata/sbom.cdx.json
```

- **And the tag before generation, not after it**: the `git_tag` field is read with
  `git describe --tags --exact-match HEAD`, so if the file is generated before the tag it writes
  `null` with a reason — truthful, but of no use to a reviewer.
- And the attestation file **fails and is not written** if the version differs among the four
  files (an executed mutant: `package.json` alone ⇒ rejected).
- `sbom.cdx.json` (CycloneDX 1.5) carries **804 measured components**: 597 from
  `cargo metadata --locked` (matching the `Cargo.lock` blocks) and 207 from `pnpm-lock.yaml`.
- And to scan it externally: `osv-scanner --sbom dist/release-metadata/sbom.cdx.json` — and what
  was measured at 0.2.7: **7 advisories** in Cargo packages (all `unmaintained`/`unsound`, and
  they are the same ones excluded in `deny.toml`) and **0 in npm**. (And the file name
  `sbom.cdx.json` is a **condition**, not taste: the tool rejects a name that does not conform to
  the specification.)
7. **The required repository secrets (only when self-update is enabled):**
   - `TAURI_SIGNING_PRIVATE_KEY` ← the contents of `updater.key` (generated locally, **uploading it is forbidden**).
   - Generating a new key: `pnpm tauri signer generate -w updater.key --ci` and put the public key in `plugins.updater.pubkey`.
8. **The repair assets (`assets-v1`)** — a fixed release holding what the self-repair handler
   downloads: `bin/*.exe` and `models/*.onnx` (`release.yml` uploads them when it creates the
   release for the first time) and **sixteen CUDA/cuDNN/ORT files** with their manifest
   (`cuda-assets.yml` is what assembles them and uploads them). A measured warning: the
   `release.yml:85-95` step **creates or skips without uploading**, so the release is not updated
   except by running `cuda-assets.yml` manually. And the asset digests are pinned in `repair.rs`
   — when you change the assets, update the digests (`Get-FileHash -Algorithm SHA256`).
9. **Publishing the digests (`SHA256SUMS.txt`)** — part of the release, not a cosmetic addition
   (item 2 of the 2026-09-15 review). After uploading the two installers:

   ```powershell
   # from the folder of the assets actually downloaded (not from your local build output)
   gh release download vX.Y.Z --pattern '*.exe' --pattern '*.msi' --dir rel --clobber
   $lines = Get-ChildItem rel -File | Sort-Object Name | ForEach-Object {
     "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
   }
   Set-Content rel/SHA256SUMS.txt -Value $lines -Encoding utf8NoBOM
   gh release upload vX.Y.Z rel/SHA256SUMS.txt
   ```

   Then **verify from three independent sources**: your local computation · the text of the
   uploaded file · and `asset.digest` in the GitHub interface — and the three must agree (this is
   how 0.2.5 was verified). And add to the release body the digests table **and an explicit
   statement** that digital signing is not available yet (the digest attests to the integrity of
   the transfer, not to the identity of the publisher).
   > **A measured trap**: do not publish the digests of **your local build** while the uploaded
   > assets are other than it — measure the digest from the file downloaded from the release, not
   > from `target/release/bundle/` (the 0.2.5 local and published builds differ: `a4b661ab…`
   > versus `db81868b…`).

## The soak rule between releases (item 13 — a policy with a measure, not a wish)

The purpose: to end the cycle of "a release, then an urgent patch hours later". The rule **is
measured**, not preached:

- After publishing any release: **no patch release within 7 days** merely for an ordinary field failure.
- If a failure occurs during the soak: **it is recorded in `docs/AUDIT.md` with its date, its
  cause and its impact**, and it is carried in the next accumulated release — not in an instant
  release.
- **Exempted immediately** (and patched at once, with it recorded): a security failure · data
  loss · the application failing to run on a supported configuration.
- **The measure**: (1) zero consecutive urgent patch releases · (2) the average number of days
  between releases · (3) the number of field failures recorded in `AUDIT.md` — and the log is the
  instrument of measurement, not the impression.
- The manual test corresponding to it: `qa/TEST-MATRIX.md` §7.

## Policy (B-1): a published release is not touched

**If a single byte changes in an `EXE`/`MSI`, the version number changes.** And there is no
replacing the assets of a published release; the remedy upon a mistake is **a new release** and
tagging the previous one `deprecated`. The only exception is the `assets-v1` channel
(self-repair), for it is **mutable by nature**. **And no `tag -f` and no `push --force`.**

- **The reason**: a published digest is a public contract. Whoever downloaded `0.2.6` and kept
  its digest must find the same bytes a month later; and replacing an asset under the same number
  makes the digest **lie** and voids every "matched three ways" in the release document.
- **A recorded precedent**: the `0.2.6` assets were rebuilt **under the same number** after a
  settings-panel orientation fix ⇒ the release came to have **two builds**, and the first build's
  digests were kept verbatim in `docs/RELEASE-0.2.6.md`. And the rule born from that: the byte
  changes ⇒ the number changes; so if you are forced to build a second time, mention the two
  builds **explicitly** and do not hide the first.
- **And a published tag is not moved**: the recorded alternative is that **the commit the assets
  were built from is written verbatim** in `docs/RELEASE-X.Y.Z.md` (`80e5436` for 0.2.6) ⇒ so the
  ambiguity is documented, not hidden.
- **And signing does not spare you that**: signing (when available) proves **identity**, and the
  digest proves **the integrity of the transfer** — and the two fall together if the asset is
  replaced under the same number.

## Policy (C-2): every failure ⇒ a permanent test

**Every field failure goes through**: a test that fails on the old code ← a fix ← success ← **it
stays forever**, and it is linked to the report in a comment. And if the test is manual, its row
is entered in `qa/TEST-MATRIX.md`.

- **The order is binding**: write the test against the code **before** the fix. For if it
  **passes** on the old code, you have not understood the failure yet — and that is an invalid
  mutant according to `AGENT.md` §3.
- **And a test with no report is not accepted**: the comment names the report (an issue link or
  its number) so that it is known **why** the test existed when it is read a year later.
- **And linking to CI is a condition** (`AGENT.md` §10): a test that is not run automatically is
  not a guard. And if automating it is impossible because the case needs Windows/hardware/a
  browser, then stating that is **mandatory** and the row in `qa/TEST-MATRIX.md` is **a declared
  substitute, not an equivalent**.
- **And the state of the day is measured**: the matrix is **55 rows (20 mandatory) and 0 recorded
  results** ⇒ it is **a design, not a record**, so do not read it as evidence of success.

## Architectural notes

- **Dynamic CRT on purpose:** the prebuilt ONNX Runtime libraries expect the dynamic UCRT, and the
  installer installs VC++ Redist automatically (`hooks.nsh`). Do not revert to `+crt-static`.
- **The two portable-edition constraints:** self-update and Windows notifications (AUMID) require
  installation through the installer — the portable edition degrades gracefully and makes that
  clear in the interface.
- **The watch folder:** events alone are not enough (OneDrive/antivirus miss them) — the periodic
  scan (60 seconds by default) is the safety net, and the disk guard refuses before the
  disconnection.
- **The extension:** Native Messaging only (no HTTP ports). The host writes a request file in
  `app_data_dir/requests/` and the running instance picks it up — see `bridge.rs`.

## The gates (fifteen — run in this order)

The `Quality gate` workflow (`.github/workflows/ci.yml`) runs these fifteen on **every push and
every pull request to `main`**. Run them locally in the same order before pushing: the cheapest
and fastest first, then what touches the interface, then the textual guards.

| # | Gate | The exact command | What it governs | CI step |
|---|---|---|---|---|
| 1 | Rust tests | `cargo test --quiet` | **246 passing · 0 failing · 3 ignored** out of 249 (measured 2026-09-21 after M1): separation with the real model · media · settings · the bridge · CUDA case tests · and two E2E tests (one of them `#[ignore]`, needing ffmpeg). **And it needs a `Stub bundle resources` step** because `bin/`, `models/` and `vc_redist.x64.exe` are excluded from git | `Rust tests` |
| 2 | **Formatting** | `cargo fmt --check` | The whole tree is formatted: it was **410 diff blocks** until a single formatting commit that touched no logic closed them — and this line prevents their return | `Rust formatting` |
| 3 | clippy | `cargo clippy --all-targets` | **An error = a failure** — and the workflow omits `-D warnings` deliberately so that the remaining warnings (12 documented, 4 of them `too_many_arguments`, standing before M1) do not turn into a gate failure | `Clippy (errors only)` |
| 4 | TypeScript | `pnpm exec tsc --noEmit` | The soundness of the frontend types | `TypeScript check` |
| 5 | **Frontend build** | `pnpm build:web` | That the bundle **actually builds** (tailwind then Rollup): a missing import or a broken module brings it down — and it is what ships | `Frontend build (tailwind + vite)` |
| 6 | **Frontend tests** | `pnpm test:web` | **89 cases in 7 files** (measured 2026-09-21 after M1): the HTML-resource contract · path sanitization · output folder names · **single-run exclusivity** (`runExclusivity`) · **normalizing the cap on concurrent separations** (`concurrentJobsClamp`) · translation-key parity with `index.html` · and `docsLang` (applying the language in `docs/` pages) | `Frontend regression tests (vitest)` |
| 7 | **The layout guard** | `node scripts/check-layout.cjs` | **18 floating boxes in 6 window states** (ltr/rtl × 820/1084/1920) stay inside the window bounds. **And its position after the build is mandatory**: it measures `dist/`, not the source | `Layout guard (headless geometry)` |
| 8 | Settings parity | `pnpm settings:parity` | The parity of settings keys between the frontend and Rust (24=24) — and it follows `collectSettings()` wherever it is in `src/**/*.ts` and fails on zero definitions or two definitions | `Settings parity guard` |
| 9 | The extension guard | `pnpm ext:guard` | 513 checks on `browser-extension/content.js` (the single audio position **executed**, not read · preventing seek-back · the mandatory behaviour · the gap decision · the speed-up mode · the attribution structure on both elements) | `Extension sync guard` |
| 10 | **The mutant gate (negative)** | `pnpm ext:mutants` | 36 behavioural mutants applied to the shipped file **in memory**, and every mutant **must** bring the guard down | `Extension mutant gate (negative tests)` |
| 11 | Version consistency | `pnpm versions:check` | The application version in four files (`package.json` · `tauri.conf.json` · `Cargo.toml` · `Cargo.lock`) — it fails on the first divergence, and it prints the extension version **flagged as an independent cycle** (`1.1.5`) so that it is not unified with it | `Version consistency guard` |
| 12 | The site guards | `pnpm site:check` | **Six** guards over `docs/`: CSS · the pages · the tags · the Arabic · the links · **and the footer and the badge** (the last was connected to this very `pnpm site:check` command — it used to be run manually, so it recorded the drift and exited 0) | `Site guards` |
| 13 | **The manual test log** | `node scripts/matrix-check.cjs` | The **20** mandatory rows in `qa/TEST-MATRIX.md` must each carry **a date, a machine and a result** in its last cell. **And it measures the existence of the record, not the honesty of the tester**: "not executed" is an accepted recorded result. And it fails loudly (exit 2) on a missing file or zero mandatory rows — "a guard that does not see is not a guard" | `Manual test matrix (every mandatory row carries a record)` |
| 14 | **The single-separation-entry guard** | `pnpm separation:entry` | Every **live mention** of the identifier `process_file` in the Rust sources is matched against an explicit allow-list (file + **expected count**): **3 places** today (2 directly in the tests · and the **only** product entry, carried by the `slots.rs` wrapper) — and the old five-file constraints were dropped when M1 was merged because their entries moved to the wrapper, so keeping them was "a stale list". It was born because the 0.2.9 protection (the separation-slots limiter) rests on **all** the entries passing through one wrapper — so a guard that prevents the **sixth** is cheaper than discovering it after building on it. The match is **deliberately broad** and is against the text **after stripping comments**: it catches `p::process_file(` after `use … as p`, and the bare call after `use …::process_file`, and the function pointer — not one specific form. And it fails (exit 2) on **zero places** or a missing source folder: "zero entries is not a success". Measured (2026-09-21 after the merge): **3 allowed places · 0 not allowed** | `Separation entry guard (one entry, one wrapper)` |
| 15 | **The guard of the guards** | `pnpm guards:selfcheck` | For each of **eleven** guards it builds a crafted environment under `%TEMP%` containing a **mutant** (which must bring it down), a **control** (which must pass it, having seen a non-zero entry), and **zero entry** (which must fail loudly). Measured (2026-09-21 after M1): **controls 11/11 · mutants 39/39 · zero entry 11/11** — and the time is **8.5 s and 15.5 s** across two runs (it varies with machine load, so let it be read as a range, not a number). And this is the **third face** of the repository rule: "a guard that does not see is not a guard" **applied to the guards themselves** | `Guard self-check gate (mutant + control per guard)` |

> **Step names, not line numbers**: the column used to point at `ci.yml:<line>` — and they all
> went stale as soon as two steps were inserted. A name does not go stale; and the check is
> `grep "name: <the name>" .github/workflows/ci.yml`.

> **And a gate is not considered connected until it is seen green in CI** (a rule born from a
> measurement, 2026-09-17): the push that published 0.2.7 carried **three gates connected in the
> sprint and never run once in CI** — so the three fell on the first real run, each **for an
> environmental reason, not for product code**: an assets check asking for what its job never
> fetched · a Docker container action on a Windows runner · and test tooling needing a Node
> higher than the installed one. And "connected" in the planning table meant **run locally**. The
> detail is in `docs/AUDIT.md` (2026-09-17).
> **And the practical check**: after every connection, open the CI run and read the step itself —
> do not assume it.

> **The mutant gate is negative in the precise sense: success in it is not "the guard is
> green" but "the guard sees".** A green guard on a sound file proves nothing; the evidence is
> that it falls on a corrupted text. Therefore **a mutant that passes = a confirmed hole**,
> and the command fails (`exit 1`) and names the mutant that passed
> (`scripts/check-extension-mutants.cjs:8-10` · `:145-151`). And it is what exposed **13 holes**
> in the guard in a single session — so do not run it after the push, but before it.
>
> The practical rule: **if you add a check to a guard with no mutant that brings it down, you
> have not added a check.**

### And four measured rules born from the 0.2.8 round (each of them from an incident, with its numbers)

**1) Run the gate under runner emulation before you believe its local green.**
The machine environment is not the runner environment: `GITHUB_ACTIONS=true` and a foreign
`GITHUB_SHA`, **with no local git configuration and no tags**. And the reason is measured —
**four classes of failure appeared in CI alone**, and each **for an environmental reason, not for
product code**:

| Class | What fell in CI | The place |
|---|---|---|
| **`GITHUB_SHA` identity** | The `build-info.cjs` control **inherits `GITHUB_SHA`** from the parent (`spawnSync` without `env` passes the whole environment) and `build-info.cjs` compares it with `git rev-parse HEAD` before writing ⇒ `exit 1` on the runner and `0` on the machine | run `35220340741` (`bde5ea2`) |
| **Node version** | `jsdom@30` declares `engines: ^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` and `undici@8` requires `>=22.19.0` ⇒ the test workers die **before a single test** on Node 20 | `1bba8e9` (Node 24 now) |
| **The job scope** | `verify:resources` requested **all** the assets in a job that fetches the model alone ⇒ "bin/ffmpeg.exe — missing" **and it stopped the steps that came after it** | `3f2849c` |
| **The runner OS** | A Docker container action (`cargo-deny-action`) on a Windows runner died with "Container action is only supported on Linux" **before it checked anything** | `12b0284` |

**And the practical check that was performed here**: `GITHUB_ACTIONS=true` + a foreign
`GITHUB_SHA` on the clean tree ⇒ **controls 10/10 · mutants 32/32 · zero entry 10/10 — exit 0**
(2026-09-17).

**2) Read the CI result before you push on top of it.**
A **red** run was pushed over, so two red pushes accumulated: **`35226009844`** (the M2 run) and
**`35227712772`** (the M3 run) — and both fell **before** the M2/M3 steps at all, at `TypeScript
check`, from an earlier merge (`a10382c` is what closed it). ⇒ **A push whose run is not read is
not built upon**: read `gh run view <id>` before the next push, and do not assume that the red is
"from somewhere else".

**3) A timeout must have margins, or it becomes a gate that lies under load.**
`check-layout` fell in CI with `CDP timeout: Runtime.evaluate` (the default timeout is **60 s**
for a single evaluation, `scripts/check-layout.cjs:103`) — and the **first** case took **37 s** on
a loaded runner, against **12 s** in the last green run (`35221426680` on `4dad49d`) and **26 s**
in the retry attempt. **And locally 3/3 green** (39.3 / 38.9 / 39.2 s for the full cycle) ⇒ **the
difference is environmental, not code**. And the lesson: a timeout without a margin produces **a
false red** that spends a whole round on diagnosis — and the margin is measured from the
**slowest** recorded measurement, not the fastest.

**4) Check `main` against `origin/main` before pushing.**
The local `main` once drifted to a different commit while `origin/main` was sound. And the check
is one line: `git rev-parse main origin/main` — and on every tree before pushing:
`git status --short --branch`.

## Protecting the `main` branch and the "no force-push" rule

- **The required check `gate`** (the job name in `ci.yml:22`): a pull request is not merged with a red check.
- **The protection enabled on GitHub:** blocking **force-push** and blocking the **deletion** of
  the branch — so the tests above are not a habit but a condition. And the setting is documented
  with its verification in `docs/AUDIT.md` (`enforce_admins=false` deliberately so that the
  owner's direct pushes are not rejected, and with no pull-request or approval requirement so
  that the path is not locked).
- **The "no force-push" rule** applies to **every** branch in this repository, not to `main`
  alone: shared history is not rewritten — whoever needs a correction pushes a new commit. (And a
  well-behaved local run stops at the push: no `push` and no `rebase` onto other people's
  branches.)

## Quick manual tests

```bash
cargo run --bin HaramLite -- --check     # checks the four components
cargo run --bin HaramLite -- --probe <file>
# the host protocol:
echo -n '{"type":"ping"}' | (write the length 4 bytes then the message) | HaramLite.exe --native-host
```
