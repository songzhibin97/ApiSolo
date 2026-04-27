# Security Policy

## Supported Versions

ApiSolo is pre-1.0. Security fixes are applied to the current `main` branch and the latest public release only.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories if available, or by opening a minimal private contact channel with the maintainer before publishing details.

Do not include real API tokens, passwords, private certificates, or production data in reports. A minimal reproduction with mock credentials is preferred.

## Local Data Model

ApiSolo is a local desktop API client. It can send requests to arbitrary user-provided HTTP and WebSocket endpoints.

- Normal environment variables are stored in local project JSON files.
- Secret environment values use a first-run storage choice: a local Argon2id + ChaCha20-Poly1305 encrypted vault by default, or the operating system credential vault through Rust `keyring` when explicitly selected.
- The local vault master password is not persisted; it unlocks the current app session only.
- Window size preference is stored in `$HOME/ApiSolo/scratch/window-state.json` and does not contain request data.
- Saved requests and history redact direct auth values and uploaded file bytes by default.
- Request scripts run in a QuickJS WebAssembly sandbox with a timeout and a small exposed API surface.
- The browser development bridge is for trusted local development only and requires a per-session token.

## Dependency Audits

Run `npm run audit` and `npm run audit:cargo` before public releases. Cargo audit can emit allowed upstream warnings from the Tauri/GTK/rand dependency chain; those warnings are tracked as dependency-chain risk, while new direct vulnerabilities should block a release.

## Security-Sensitive Features

- Disabling TLS verification is intended only for trusted local debugging.
- Proxy settings may expose traffic to the configured proxy.
- Imported collections may contain untrusted scripts; scripts should only be enabled for trusted workspaces.
- Release builds must not enable Tauri devtools or the development bridge.
