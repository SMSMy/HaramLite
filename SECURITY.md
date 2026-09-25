# Security Policy — HaramLite

## Reporting a vulnerability (private channel)

Use GitHub's **private vulnerability reporting** — the official private channel for this
repository. There is no dedicated security email:

<https://github.com/SMSMy/HaramLite/security/advisories/new>

- **Do not open a public issue for a security vulnerability.** Public issues are for bugs
  and suggestions only: <https://github.com/SMSMy/HaramLite/issues/new>.
- If the private reporting button is not available to you (the feature is enabled from the
  repository settings), open an issue **with no technical details** asking for a private
  channel, and we will open one with you.
- Never attach to any public report: a Telegram bot token, `api_hash`, the `updater.key`
  file, or any key/secret — and no unredacted logs (`logs/`).

## What matters to us (application scope)

HaramLite is a desktop application that runs locally on Windows: no accounts, no cloud
services. Our priorities:

- **The self-repair and download path**: verification of `assets-v1` artifacts and the CUDA
  manifest (SHA-256 digests, manifest file names, and the install path) — any bypass of that
  verification, or a write outside the install directory.
- **User secrets**: encryption of the Telegram bot token and `api_hash` with DPAPI, and
  their absence from logs and from error messages.
- **The browser bridge (Native Messaging)**: file paths, request-directory boundaries, and
  preventing what the browser sends from executing beyond what is intended.
- **Command injection** in `ffmpeg`/`ffprobe`/`yt-dlp` arguments or in file paths.
- **The website** in `docs/` (published to haramlite.com) and the build scripts in `scripts/`.

## What we ask for in a report

- A description of the vulnerability and its practical impact, plus reproduction steps.
- The application version (Settings -> About) and your operating system.
- Any evidence (screenshot / redacted log) that helps confirm it.

## Out of scope

- Vulnerabilities in third-party components themselves (**FFmpeg** · **yt-dlp** ·
  **ONNX Runtime** · the UVR model) — report those upstream; a notice is enough for us to
  update the version. The component and licence list is in
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
- Anything that already requires administrator rights on the machine, or an already
  compromised machine.
- Automated reports with no reproduction steps (generic scanners).

## What we commit to

We make a reasonable effort to confirm and respond, **we do not commit to a contractual
timeline**, and we run no bounty programme: this is a small project. We will credit the
reporter in the release notes if they wish, and will let you know when a fix lands — before
release when possible.
