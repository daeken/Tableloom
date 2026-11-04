# Tableloom

A self-hosted, web-based virtual tabletop for the systems you actually play. TypeScript throughout, a shared sketchable battlefield, and code-first game modules with custom sheets, rules, and content packs.

**Status:** authenticated shared-table prototype. Host setup and one-use player invitations work; GM/player command permissions and object ownership are next. This README is the authoritative work queue. Cyberpunk RED, Kids on Bikes, and Kids on Brooms are the initial module targets; their rulebooks have not been supplied and no published mechanics or catalog content are implemented yet.

## Run locally

Requires Node.js 24 and npm. No database service or external account is required.

```sh
npm ci
npm run dev
```

Open http://localhost:5173. On first launch, create the host using the private key in `data/host-key` (or your configured `TABLELOOM_HOST_KEY`). The server prints the file location, never the key itself. Keep this key private: it can also recover the host identity after signing out or losing a session. Existing prototype scene data is retained.

Once signed in, the host can choose **Invite player**, create a one-use code, and share the table address and code with a friend. The friend enters a name and that code. Use separate browser profiles to test independent identities; ordinary tabs share a browser session. A player cannot create invitations.

Sessions last seven days and survive server restarts. Signing out revokes the session and clears the browser table. The host can select **I'm the host** to recover access with the private key. Returning players currently need a new invitation after signing out or session expiry, which creates a new identity; identity-preserving player recovery is queued.

The development server proxies `/api` and the WebSocket to Fastify on port 3001. The prototype uses one shared table. SQLite data lives in `data/tableloom.sqlite` (ignored by Git).

```sh
npm run check       # strict types, tests, build, production smoke check
npm run build
npm start           # frontend + API on http://127.0.0.1:3001
```

Configuration: `PORT` (default `3001`), `HOST` (default `127.0.0.1`), `DATA_DIR` (default `./data`), optional `TABLELOOM_HOST_KEY` (32–512 characters, otherwise a random key is generated in a private `host-key` file), and optional `PUBLIC_ORIGIN` (the browser-facing HTTP(S) origin, without a path). For an HTTPS reverse proxy, set `PUBLIC_ORIGIN=https://your-table.example`; this enforces the configured origin and enables Secure session cookies without trusting forwarded headers. Development defaults to same-origin HTTP on loopback.

Keep this prototype local while GM/player command permissions and object ownership are pending. Only authenticated members can fetch or connect to the table, but all invited participants currently have equal scene editing access and receive the entire shared scene. No private/GM-only data exists yet. Backup of the private host key and player identity recovery still need a complete recovery workflow.

## Architecture

| Location                 | Responsibility                                                      |
| ------------------------ | ------------------------------------------------------------------- |
| `apps/web`               | React/Vite application, PixiJS tabletop, local interaction previews |
| `apps/server`            | Fastify, WebSockets, server-side dice, SQLite persistence           |
| `packages/core`          | System-neutral validated commands, table state, dice primitives     |
| `packages/module-sdk`    | Module manifests, versioned data and content contracts              |
| `systems/cyberpunk-red`  | Independent Cyberpunk RED module scaffold                           |
| `systems/kids-on-bikes`  | Independent Kids on Bikes module scaffold                           |
| `systems/kids-on-brooms` | Independent Kids on Brooms module scaffold                          |

The server serializes mutations, commits before broadcasting, and sends a current snapshot on connection. Commands have IDs for retry deduplication over the last 10,000 revisions; clients do not automatically replay commands after reconnecting. Dragging and unfinished strokes are local previews; committed changes synchronize. This first protocol sends full snapshots and is deliberately small. It is not an offline-first or CRDT implementation.

SQLite currently uses Node 24's built-in `node:sqlite` and prepared SQL, behind a small store boundary. This avoids a native package build for self-hosters; Drizzle can be introduced when normalized campaign/document storage warrants it. The Node 24 SQLite API may emit an experimental warning.

Modules are trusted installed code, not a sandbox. Each has shared, client, and server entry points and an independent version. Content packs provide stable definition IDs; owned instances carry their own mutable state. Published game data will be added from user-provided sources with edition/page references. Shared Kids-system code should be extracted only after the actual implementations demonstrate common behavior.

## Work queue

Work top to bottom unless an item is blocked. Check off only verified behavior. Record blockers, tests, and progress below; keep this as the single work list.

### 0 — Runnable foundation (complete)

- [x] Set up npm workspaces, strict TypeScript, React/Vite, Fastify, and a reproducible lockfile.
- [x] Implement validated system-neutral commands and server-authoritative state transitions.
- [x] Persist the table and command receipts in SQLite; restore it on restart.
- [x] Synchronize two browser clients over WebSockets, with reconnect and connection status.
- [x] Add a PixiJS scene with pan/zoom, freehand strokes, rectangles, token placement/movement, and deletion.
- [x] Roll bounded `NdS +/- modifier` expressions on the server; show individual dice and a shared history.
- [x] Establish module SDK and independently selectable scaffolds for all three target systems.
- [x] Verify state, dice boundaries, persistence, and real two-client synchronization; perform browser QA.
- [x] Create the requested five-minute development schedule attached to this chat.

### 1 — A safe campaign session

- [x] Add host setup, player accounts or scoped invitations, authenticated sessions, and table membership.
  - [x] Implement persistent host identity/recovery, table membership, expiring sessions, and atomic single-use invitations, with access-store tests.
  - [x] Wire host-key generation/storage, setup/recovery/join/logout/invitation APIs and UI, HttpOnly session cookies, request-origin checks, and HTTP/WebSocket authentication. Recheck session expiry/revocation for live sockets, and test unauthorized access end to end.
- [ ] Enforce GM/player roles and object ownership for every command; add permission tests.
- [ ] Introduce server-filtered private documents, GM notes, and secret rolls; test that hidden data never reaches unauthorized clients.
- [ ] Add identity-preserving returning-player recovery, member management, and invitation revocation UI.
- [ ] Add multiple campaigns/scenes, campaign settings, and pinned system/content-pack versions.
- [ ] Add bounded document collections and normalized storage with schema migrations; avoid unlimited snapshot growth.
- [ ] Add graceful reconnect behavior for concurrent edits, protocol versions, conflict feedback, and backpressure.

### 2 — Comfortable tabletop tools

- [ ] Evaluate Excalidraw embedding against the current PixiJS approach using selection, token layering, drawing, and sync; record the decision here.
- [ ] Add durable undo/redo with multiplayer-safe semantics, multi-selection, resize, and snap-to-grid options.
- [ ] Add image/map upload, local asset storage, asset size limits, and authorization.
- [ ] Add text, shape styling, layers, grid settings, measurement, and keyboard shortcuts.
- [ ] Extend the participant count into named presence; add transient cursors, chat, and roll visibility controls.
- [ ] Improve touch/keyboard accessibility and verify narrow-screen layouts.
- [ ] Measure canvas redraw/snapshot performance and split the initial frontend bundle (currently approximately 638 kB before gzip).

### 3 — Module development and character sheets

- [ ] Add versioned character/document persistence, validated module actions, and migration execution.
- [ ] Add a module preview/test harness for custom React sheets and worked rules examples.
- [ ] Implement content-pack loading, stable definition references, owned item instances, and campaign homebrew overrides.
- [ ] **Blocked on source PDFs:** inventory Cyberpunk RED data, workflows, rules, sheets, and content with source references.
- [ ] **Blocked on source PDFs:** implement and verify the Cyberpunk RED module and initial content pack.
- [ ] **Blocked on source PDFs:** inventory Kids on Bikes and Kids on Brooms separately, including edition differences.
- [ ] **Blocked on source PDFs:** implement and verify both Kids modules; extract only demonstrated shared code.
- [ ] Run a complete character creation / sheet editing / roll / resource update session in two structurally different systems without core changes.

### 4 — Self-hosting and release

- [ ] Add a multi-stage Docker image, Compose example, persistent volume, and non-root runtime.
- [ ] Add consistent backup/restore for database and assets, with a tested recovery procedure.
- [ ] Add CI for clean install, typecheck, tests, and production build.
- [ ] Document reverse proxy / HTTPS setup, upgrades, trusted-module installation, and campaign export/import.
- [ ] Playtest with a real group; fix workflow friction before broadening scope.

## Scheduled development

The **Keep building Tableloom** heartbeat is active every five minutes in this Codex chat. It reads this file, implements the highest-priority actionable item, verifies the change, and updates this queue and progress log. The user authorized GitHub pushes on 2026-11-04: each coherent verified increment is committed together with its README update, then pushed to `origin` on the current branch. A failed push must be resolved or reported before making another commit; never force-push or overwrite user work. The automation does not invent rulebook content or deploy/publish the app. The schedule depends on the local Codex scheduler being available; it is not a service shipped with Tableloom.

## Progress log

### 2026-11-04 — Project started

- Agreed on pure TypeScript, self-hosting, a system-neutral core, and independently versioned game modules/content packs.
- Created the authoritative queue and agent instructions. Created the active five-minute development schedule.
- Completed the React/Vite + Fastify workspace, strict schemas, authoritative commands, atomic SQLite state/receipt persistence, bounded server dice, and reconnecting WebSocket client.
- Added the PixiJS battlefield: pan/zoom, freehand and rectangle drawing, named colored tokens, drag movement, and object deletion. The responsive shell includes the cast list, selectable game module, and shared roll history.
- Added separately versioned module packages with shared/client/server exports and validated manifests. Their provisional documents contain only name/notes; module actions, custom character sheets, published rules, migrations, and content loading remain queued.
- Verification: clean `npm ci`; strict typecheck; 8 passing tests, including two real WebSocket clients, invalid commands, roll deduplication across restart, atomic rollback, and restart with live clients. Production frontend/server builds and the tracked distribution smoke check pass, including asset delivery and clean shutdown. Dependency audit reports zero known vulnerabilities.
- Browser QA: joined the table in two tabs, rolled dice, drew a rectangle and freehand stroke, placed and moved Scout, panned/zoomed, and changed the game system in one tab with the change reflected in the other. Test scene data remains only in ignored local `data/`.
- The production smoke check caught a bundler rewrite of `node:sqlite`; preserving Node import prefixes fixes it. Server shutdown terminates WebSockets before closing storage so proxy connections cannot hold a restart open.
- Current limits: one public shared table; no accounts, ownership, secret data, custom playable sheets, content packs, image uploads, or undo yet. Snapshots replace the full scene after each committed change; large-scene optimization and frontend bundle splitting remain queued. Build output includes harmless third-party Zod annotation notices and a frontend chunk-size warning.
- Next scheduled item: host setup and scoped invitations/authenticated sessions, followed by GM/player permission enforcement. Rulebook-dependent work remains blocked on the PDFs.

### 2026-11-04 — Persistent access primitives

- Added `apps/server/src/access.ts`: a separate SQLite access store for the initial table, with validated identities, GM/player memberships, host-key verification, one-time host setup, and host identity recovery after session loss. The caller must supply the machine owner's host key; key generation/storage is part of the next integration step.
- Sessions use random 256-bit bearer tokens with a seven-day absolute expiry. Invitations are scoped to the initial table, issue only to players, default to a one-day expiry (at most seven days), and are single-use. Only an authenticated host may issue invitations or remove members. Session and invitation tokens are stored as SHA-256 hashes; the host key stays outside the shared database.
- Invitation consumption, user creation, membership, and session creation commit together. Failed writes roll back the entire join. Logout revokes a session; removing a member invalidates their sessions through database foreign keys. Active invitations and table membership have explicit limits; expired credentials are pruned during writes.
- Verification: `npm run check` passed: strict typecheck, **16 tests**, production builds, and the distribution startup/asset/shutdown smoke check. Eight new tests cover setup claims, role gates, persistence across database connections/restart, invitation replay, expiry boundaries, recovery, revocation, hash-only credential storage, rollback after a forced SQLite failure, and invitation capacity.
- **Remaining limitation:** these are tested storage primitives, not active application authentication. No live server data or public endpoints changed. The host setup/access work item remains unchecked. Next: connect these primitives to the API/browser and enforce authenticated table access before claiming that item complete; command ownership/GM permissions remain a subsequent item. No rulebook content was added.

### 2026-11-04 — Host setup, invitations, and authenticated table access

- Connected the access store to the running app. First startup generates a private host key (`data/host-key`, mode 600), or accepts `TABLELOOM_HOST_KEY`. Keys are never printed or returned by an API. Existing keys are reused, symlinks and public file permissions are rejected, and the server owner can recover their original host identity with that key.
- Added setup/recovery/join/logout/invitation endpoints and matching browser flows, with shared runtime-validated public contracts. Session tokens travel only in host-only HttpOnly/SameSite=Strict cookies; the browser does not store them in local storage. API responses are not cached. One-use invitation codes are shown to the host explicitly and are not put in URLs.
- Protected both the HTTP table read and the WebSocket upgrade. Roll attribution now comes from the authenticated membership, ignoring caller-supplied names. Expiry/revocation is rechecked before commands and every outbound update, and on periodic socket health checks. Logout closes that session's sockets; the UI discards scene data and returns to the access screen.
- Added exact origin checks on unsafe requests and WebSocket upgrades, bounded sign-in attempts, and an explicit `PUBLIC_ORIGIN` setting for HTTPS proxies/Secure cookies. Requests do not trust forwarded host/protocol headers. The initial rate limiter is per process/IP; a reverse proxy shares its IP budget until a deliberate trusted-proxy design is added.
- Verification: `npm run check` passed with **24 tests**, strict typecheck, production builds, and the expanded distribution smoke check, including unauthenticated denial, host setup, cookie-authenticated table access, asset delivery, and clean shutdown. Coverage includes origin rejection, cookie flags, invitation replay/role escalation rejection, session expiry/revocation during live connections, expiry before idle-socket broadcasts, authenticated attribution, persistence across restart, host-key permissions/symlinks, and sign-in throttling.
- Browser QA on an isolated temporary test database with a synthetic host key: host setup, invitation creation, host sign-out, one-use player join, a roll attributed to Test Player, player sign-out with scene/history cleared, and recovery of the original host. Test server and temporary browser were stopped after QA; normal campaign data was not altered.
- Remaining limits: this completes authenticated membership, not per-command permissions. All invited members still edit the shared scene equally; object ownership and GM-only actions are next. Players need a fresh invitation/new identity after session loss for now. There is one table, no private documents or secret rolls, and no published system rules/content. Existing harmless dependency annotation and bundle-size notices remain.

## License

Tableloom code is MIT licensed; see [LICENSE](LICENSE). Game names identify intended compatibility. Published game content is not included in this repository.
