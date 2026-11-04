# Tableloom

A self-hosted, web-based virtual tabletop for the systems you actually play. TypeScript throughout, a shared sketchable battlefield, and code-first game modules with custom sheets, rules, and content packs.

**Status:** authenticated tabletop with object permissions, private rolls, and shared/private note documents. Returning-player recovery, member/invitation management, and GM ownership reassignment are available. Campaign/scene storage and exact version pins are in place; campaign-scoped access and browser switching controls are next. This README is the authoritative work queue. Cyberpunk RED, Kids on Bikes, and Kids on Brooms are the initial module targets; their rulebooks have not been supplied and no published mechanics or catalog content are implemented yet.

## Run locally

Requires Node.js 24 and npm. No database service or external account is required.

```sh
npm ci
npm run dev
```

Open http://localhost:5173. On first launch, create the host using the private key in `data/host-key` (or your configured `TABLELOOM_HOST_KEY`). The server prints the file location, never the key itself. Keep this key private: it can also recover the host identity after signing out or losing a session. Existing prototype scene data is retained.

Once signed in, the host can choose **Invite & players**, create a one-use code, and share the table address and code with a friend. The friend enters a name and that code. Use separate browser profiles to test independent identities; ordinary tabs share a browser session. A player cannot create invitations.

Sessions last seven days and survive server restarts. Signing out revokes the session and clears the browser table. The host can select **I'm the host** to recover access with the private key. For a returning player, the GM opens **Invite & players** and chooses **Create return code** beside their existing membership. The player enters that code on the same join screen; their original identity, name, object ownership, private notes, and private rolls are preserved. The name entered on the join screen is used only for new-player invitations. Issuing a new return code replaces that player’s previous unused return code; using it signs out all of their previous sessions. Codes expire after one day and work once. Names alone never recover an identity.

The development server proxies `/api` and the WebSocket to Fastify on port 3001. The browser currently opens the default campaign and its active scene. Additional campaigns/scenes can be managed only through the internal storage boundary until scoped access and switching APIs/UI land. SQLite data lives in `data/tableloom.sqlite` (ignored by Git).

```sh
npm run check       # strict types, tests, build, production smoke check
npm run build
npm start           # frontend + API on http://127.0.0.1:3001
```

Configuration: `PORT` (default `3001`), `HOST` (default `127.0.0.1`), `DATA_DIR` (default `./data`), optional `TABLELOOM_HOST_KEY` (32–512 characters, otherwise a random key is generated in a private `host-key` file), and optional `PUBLIC_ORIGIN` (the browser-facing HTTP(S) origin, without a path). For an HTTPS reverse proxy, set `PUBLIC_ORIGIN=https://your-table.example`; this enforces the configured origin and enables Secure session cookies without trusting forwarded headers. Development defaults to same-origin HTTP on loopback.

Only authenticated members can fetch or connect to the table. Everyone can draw, create tokens, and roll dice. Players can move/delete their own tokens and delete their own drawings; the GM can edit every object and change the game system. The server assigns ownership to the creator; creation commands reject caller-supplied ownership. Older objects without a recorded owner stay under GM control until assigned. The GM can select **Manage ownership** below the cast list, choose a token/drawing/note and a current member, then review and confirm the transfer. Removed members cannot receive ownership. Assigning an object to the GM keeps it under GM control.

Scene objects are currently public to all table members. Before rolling, choose **Everyone at the table** or **You and the GM**. Private rolls are visible only to the roller and the GM; a GM's private rolls stay with the GM. The history marks private results explicitly. Public is the default, and already-recorded roll visibility cannot be changed. Sign-out/identity changes clear the local roll draft.

The **Notes** panel supports plain-text documents. **New** creates a private note visible to its owner and the GM; GM-owned private notes stay with the GM. Set **Who can read this?** to **Everyone at the table** and save to share a note. Other players can read shared notes; only the owner and GM can edit or delete them. Changing a note back to private removes it from other players' current/future views. Previously shared text may already have been read.

Note edits require **Save changes**. Unsaved drafts stay in memory when switching notes/tabs and through unrelated table updates; save before reloading or signing out. Clean editors follow remote saves. If another editor saves while you have a draft, your draft is retained and stale saves/deletes are blocked until you explicitly reload the latest version. Notes are limited to 100 per table, 120 characters per title, and 10,000 characters per body.

The GM can list members and unused codes, revoke codes, and remove players in **Invite & players**. Member/code lists never return saved bearer credentials; a newly issued code is displayed only in its issuing dialog. Removing a player immediately revokes their sessions and return codes. Their existing objects, notes, and rolls remain stored and available to the GM; removal does not reassign or publish them. A fresh invitation creates a different identity, even with the same name. The host cannot be removed. Backing up the private host key still needs a complete backup/recovery procedure. Module-backed character documents, rich text, attachments, and version history are not implemented yet.

Note transfers keep the saved content and visibility. A private note requires explicit confirmation before the new owner receives its full saved text and the previous player owner loses access. The GM always retains access. A public note stays readable by the table, but edit/delete rights move to the new owner. Transfers advance the note version, blocking stale edits/deletes; the review screen blocks confirmation if the note changes while being reviewed. Save drafts before transferring. Hidden notes and their local drafts disappear from the previous player’s current view; previously read content cannot be recalled. Dice results keep their original ownership and attribution. Ownership transfers have no dedicated history or undo yet.

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

The server serializes mutations and commits before sending updates. Commands have IDs for retry deduplication over the last 10,000 internal revisions; clients do not automatically replay commands after reconnecting. Every HTTP table response, initial/reconnect snapshot, mutation update, and retry response uses a per-member projection. Global revision counters stay on the server. Client views use a content fingerprint computed only from visible fields, and unchanged views are not broadcast when someone else makes a private roll.

Dragging and unfinished strokes are local previews; committed changes synchronize. This first protocol sends complete projected snapshots and is deliberately small. It is not an offline-first or CRDT implementation. Table schema/protocol version 4 includes note documents and per-note edit versions. Version 1/2/3 saves upgrade automatically, preserving scene content, internal revisions, command receipts, version 2 ownership, and version 3 private roll visibility. Older rolls remain public; ownerless legacy objects stay GM-controlled. Migrated tables start with an empty notes collection. Unsupported/incomplete saves and ambiguous object IDs fail validation. Reload older browser tabs after upgrading.

Roll retention is separate for the public audience and each private roller: 100 results per audience, at most 1,100 records overall. Private rolling never evicts public history or another player's private results. A full overall history rejects growth until archive/cleanup support is added; those controls remain queued.

SQLite uses Node 24's built-in `node:sqlite` and prepared SQL, behind a validated store boundary. Storage schema 1 separates campaign-wide notes, rolls, and internal revisions from each scene's drawings/tokens. Campaigns have versioned names/descriptions, one active scene, an exact system package version, and exact content-pack pins. Commands have separate receipt namespaces per campaign; scene changes and competing saves reject stale revisions. Limits are 100 campaigns per server and 100 scenes per campaign.

On first startup after this upgrade, the former singleton table and receipts convert atomically to **The gathering place**, preserving the scene, ownership, notes, rolls, edit versions, and receipts. Access identities/sessions/invitations remain intact. Legacy saves had no package version metadata, so this one-time conversion pins the currently installed version of their selected system. Future loads require matching installed system/content-pack versions; missing or incompatible pins fail explicitly instead of silently upgrading or importing arbitrary code. No content packs are shipped yet. This is a one-way storage upgrade: older builds require a pre-upgrade database backup; downgrade and automated package migrations remain unimplemented. The existing table wire schema/protocol remains 4.

This avoids a native package build for self-hosters; Drizzle can be introduced when normalized campaign/document storage warrants it. The Node 24 SQLite API may emit an experimental warning.

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
- [x] Enforce GM/player roles and object ownership for every command; add permission tests.
- [x] Introduce server-filtered private documents, GM notes, and secret rolls; test that hidden data never reaches unauthorized clients.
  - [x] Separate internal state from per-member client views; implement persistent private rolls and visibility controls, with raw-wire/HTTP/retry/reconnect/restart leakage tests.
  - [x] Add bounded private/public note documents, GM notes, authorization, migrations, and a notes editor; include document visibility changes/deletion in recipient-filtering tests.
- [x] Add identity-preserving returning-player recovery, member management, invitation revocation, and GM ownership reassignment APIs/UI.
  - [x] Add GM-managed returning-player codes, member listing/removal, and pending-invitation listing/revocation, with APIs/UI and identity/privacy/session/migration tests.
  - [x] Add GM ownership reassignment for scene objects and notes, validate recipient membership, and make private-note audience changes explicit.
- [ ] Add multiple campaigns/scenes, campaign settings, and pinned system/content-pack versions.
  - [x] Add validated multi-campaign/scene storage, campaign settings, exact installed-package pins, scoped receipts, atomic legacy conversion, and storage/wire isolation tests; run the existing table on the new default campaign/scene.
  - [ ] Add campaign-scoped membership/invitations and authenticated campaign management/selection routes; map existing access to the migrated default campaign.
  - [ ] Add GM scene management/activation and campaign/scene switching UI, with explicit command-context checks so delayed commands cannot affect a newly opened scene.
- [ ] Add normalized, module-backed document storage with schema migrations; add roll-history archive/cleanup controls and avoid unlimited snapshot growth.
- [ ] Add graceful reconnect behavior for concurrent edits, protocol versions, conflict feedback, and backpressure.

### 2 — Comfortable tabletop tools

- [ ] Evaluate Excalidraw embedding against the current PixiJS approach using selection, token layering, drawing, and sync; record the decision here.
- [ ] Add durable undo/redo with multiplayer-safe semantics, multi-selection, resize, and snap-to-grid options.
- [ ] Add image/map upload, local asset storage, asset size limits, and authorization.
- [ ] Add text, shape styling, layers, grid settings, measurement, and keyboard shortcuts.
- [ ] Add note history/trash and richer document content after the basic campaign workflow is playtested.
- [ ] Extend the participant count into named presence; add transient cursors, chat, and roll visibility controls.
- [ ] Improve touch/keyboard accessibility and verify narrow-screen layouts.
- [ ] Measure canvas redraw/snapshot performance and split the initial frontend bundle (currently approximately 654 kB before gzip).

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

### 2026-11-04 — GM/player permissions and object ownership

- Added an exhaustive, system-neutral command authorization policy. Authenticated users may create drawings/tokens and roll dice; players may move/delete their own tokens and delete their own drawings. The GM may edit every scene object and change the game system. Rejected mutations leave scene state, revision, and command receipts unchanged.
- New objects receive the authenticated creator's ID on the server. Network creation schemas reject supplied ownership metadata, and the state reducer overwrites it defensively even for trusted internal callers. Drawings and tokens share a unique ID namespace, preventing ambiguous permission/deletion targets; the same invariant is validated for persisted data.
- Introduced table schema/protocol version 2 and a validated, durable version 1 migration. Legacy objects stay GM-controlled instead of guessing ownership; content, revisions, and retry receipts are preserved. Unknown schema versions and incomplete version 2 objects fail closed.
- Updated browser affordances to match the policy: system selection is GM-only, delete controls are disabled for other owners, and token dragging/eraser gestures act only on editable objects. These affordances reuse the shared policy; server authorization remains authoritative.
- Verification: `npm run check` passed with **32 tests**, strict typecheck, production builds, and the distribution smoke check. Added owner/other-player/GM matrices, ownership-spoof rejection, shared-ID collision checks, migration/restart checks, and a real three-client WebSocket test covering denied cross-owner moves/deletes, GM overrides, authenticated ownership/roll attribution, and a denied command ID subsequently used by an authorized GM. Existing two-client persistence/restart tests now operate within the permission policy. No new manual browser/layout pass was needed for these control restrictions.
- Remaining limits: ownership is assigned at creation; GM reassignment and identity-preserving player recovery remain queued. All scene objects and public rolls are still visible to every member; private documents, GM notes, secret rolls, and per-recipient projections are the next item. There are still no published game rules or content packs. Existing third-party annotation and bundle-size notices remain.

### 2026-11-04 — Per-member projections and private rolls

- Split persistent `TableState` from the validated `TableView` wire contract. HTTP reads and every WebSocket snapshot path now project data for the authenticated recipient. Global revision counters are internal; visible content fingerprints remain stable when hidden results change, and unchanged views are not broadcast. The retry path also returns only the requester's projected view.
- Added explicit public/private roll visibility and server-assigned roll ownership. A private result goes to its roller and the GM; GM-owned private results reach only the GM. The dice panel has an audience selector, applies it to quick rolls too, and labels private history entries. Cached views and roll drafts are scoped to member ID and role; identity changes hide stale data immediately, clear drafts, and prevent sends through a previous viewer's socket.
- Commands reject unknown fields and invalid visibility, including a misspelled visibility key, instead of silently publishing an intended secret roll. Visibility is fixed when a result is recorded. Public and private retention are separate (100 public, 100 private per roller; 1,100 records total), so private churn cannot evict another audience's history. Growth at the total cap is rejected; archive/cleanup UI is still queued.
- Added durable schema 1/2 → 3 migration. Existing object ownership and content are preserved, legacy rolls explicitly remain public, and unknown/incomplete/downgraded private save shapes fail validation. Client protocol version is 3; older browser tabs need a reload.
- Verification: `npm run check` passed with **38 tests**, strict typecheck, production builds, and the authenticated distribution smoke check. New tests cover projection/visibility policy, unchanged fingerprints under hidden activity, audience retention, overall capacity, migration, and a real GM/Alice/Bob session that inspects raw JSON frames and HTTP bodies before/after private rolls, public ordering barriers, a guessed/replayed private command ID, reconnects, and a full server/database restart. Private result IDs/expressions and internal revisions are absent from unauthorized payloads; permitted recipients retain their results after restart.
- Scope remains explicit: this completes private roll transport/controls, while the parent privacy work item stays unchecked until private document/GM-note CRUD, authorization, editor, and visibility-transition tests are implemented. All battlefield objects remain public. No published game rules/content were added. Existing third-party annotation and bundle-size notices remain; no deployment occurred.

### 2026-11-04 — Private note documents and GM notes

- Added bounded note documents with server-assigned ownership and versioned add/update/delete commands. Notes can be shared with the table or private to owner/GM. GM-owned private notes stay with the GM. Public readers cannot edit; hidden note mutations return a generic unavailable response before permission/version details are inspected. Stale updates and deletes are rejected without mutating state or consuming receipts.
- Extended per-member projections to notes. Private edits do not change unauthorized view fingerprints or send snapshots to those viewers. Publishing, retracting visibility, and deleting public notes update affected views; hidden titles, bodies, IDs, and versions are omitted. Previously public information cannot be recalled from readers' knowledge.
- Added the Notes editor with explicit save/delete controls, audience selection, read-only shared notes, and identity-scoped in-memory drafts. Drafts survive note/tab switches and unrelated rolls. Clean editors follow remote saves; real conflicts preserve the local draft and offer an explicit discard/reload action. Creation starts with a private blank note. Limits are 100 documents, 120 title characters, and 10,000 body characters; IDs remain unique across notes and battlefield objects.
- Added schema/protocol version 4 and migrations from versions 1–3. Existing object ownership, scene data, receipts, revisions, and version 3 private roll metadata are preserved. Legacy save shapes are validated strictly and receive an empty notes collection.
- Verification: `npm run check` passed with **44 tests**, strict typecheck, production builds, and the authenticated distribution smoke check. New tests cover note read/write matrices, bounds, ownership spoofing/collisions, stale writes, and private-roll-preserving migration. A real GM/Alice/Bob WebSocket/HTTP test inspects raw payloads across private creation/editing, explicit publication, retraction, guessed IDs/versions, retries of formerly public commands, public/private deletion, reconnect, and database/server restart.
- Browser QA used an isolated temporary database and synthetic host key: created/saved a private note, kept a draft across tabs and an unrelated roll, published/retracted the note, verified persistence on reload, and tested two simultaneous editors. A clean editor followed the other window's save; an unsaved editor retained its text and blocked stale save/delete until explicit reload. Test browsers/server and temporary data were cleaned up; normal campaign data was untouched.
- The privacy checklist item is complete for plain-text note documents and dice results. Module-backed character documents, note history/trash, ownership reassignment, richer content, and identity-preserving player recovery remain queued. Next: returning-player recovery and member/invitation management. No rulebook mechanics or catalog content were added; no deployment occurred. Existing third-party annotation/bundle-size notices remain.

### 2026-11-04 — Returning players and access management

- Added GM-issued single-use return codes targeting an existing player membership. Redemption preserves the original UUID/name, object ownership, private notes, and private rolls; a supplied name cannot select or rename the identity. A new code replaces prior unused return codes for that player. Redemption atomically consumes the code, revokes previous sessions, and creates a replacement session; failed writes roll everything back.
- Added authenticated GM-only member listing/removal, pending-code listing/revocation, and recovery-code APIs. Removal immediately disconnects affected live sockets, revokes all sessions/return codes, and preserves owned scene data without transferring or publishing it. Hosts cannot be removed or recovered using player codes. Management lists contain opaque UUIDs and expiry/target metadata, never reusable tokens or token hashes.
- Expanded **Invite & players** into a member/code management dialog, with private one-time code display/copy, return-code controls, explicit removal confirmation/cancellation, code revocation, and refresh. The join screen explains returning-player recovery. A revoked/used code disappears on refresh; the dialog does not poll for external changes. Existing tabs clear their snapshot on revoked sessions and retry after refreshing access, allowing a replaced same-identity cookie to reconnect without replaying mutations.
- Added an atomic access-database upgrade that assigns stable management IDs to existing invitations and initializes their recovery target as empty. Old invitation tokens, sessions, memberships, host identity, and table schema/protocol 4 remain compatible. No new dependencies or published rules/content were added.
- Verification: `npm run check` passed with **49 tests**, strict typecheck, frontend/server builds, and production startup/assets/authentication/shutdown smoke verification. New tests cover GM/player/anonymous access, identity/name preservation, management IDs that cannot redeem codes, replacement/revocation/expiry/replay, membership removal, cross-connection restart, legacy-access migration, and forced session-insert rollback that preserves both the unused code and previous sessions. A real WebSocket/API test recovers a private note and editable token under the same owner, immediately closes replaced/removed sessions, checks another player's filtered view, and verifies retained ownership after server/database restart.
- Browser QA used a separate temporary database and synthetic host key: recovered the GM, listed existing members, created/revoked a return code, inspected/cancelled player removal, and redeemed a fresh return code under a different entered name. The original player name and editable private journal were restored. Test browser/server/data were cleaned up; normal campaign data was untouched.
- Remaining scope: the parent access-management item stays unchecked until GM ownership reassignment is implemented. Removed identities cannot be restored through this UI; their data stays GM-accessible, and reassignment is next. There is still one table, no self-service player recovery or member renaming/role changes, no backup/restore workflow, and no rulebook mechanics or catalog content. Existing third-party annotation and approximately 649 kB bundle notices remain. No deployment occurred.

### 2026-11-04 — GM ownership reassignment

- Added strict GM-only `object.assign` and `note.assign` commands. The running server resolves the recipient from current table membership immediately before applying a command; client-supplied recipient objects/roles are rejected. Missing/removed members, missing objects, same-owner transfers, stale expected owners, and stale note versions fail without changing persistent state or consuming a command receipt. Legacy ownerless drawings/tokens can be assigned too.
- Note transfers preserve title/body/visibility and advance the edit version. Private transfers additionally require an explicit access acknowledgement bound to the expected note version. The new owner gains private read/edit/delete access; the former player owner loses it; the GM retains it. Public notes remain public while edit/delete rights move. Every snapshot/HTTP/retry/reconnect path uses the resulting per-member projection; unrelated players' visible fingerprints remain unchanged during private transfers. Dice history ownership/attribution is unchanged.
- Added **Manage ownership** below the GM’s cast list, with object/note and current-member selectors, current-owner labels (including legacy/removed owners), a separate transfer review, an explicit private-access confirmation, inline server errors, refreshable members, and server-confirmed completion. Reviewing a stale note disables confirmation until reviewed again. Transfers use saved note content; the dialog tells the GM to save drafts first. No schema migration or dependency was needed; table schema/protocol remains 4.
- Verification: `npm run check` passed with **53 tests**, strict typecheck, production builds, and the startup/assets/authentication/shutdown smoke check. New core tests cover GM/player permission matrices, verified-recipient requirements, stale/no-op/legacy assignments, private acknowledgement, visibility/projection changes, shared-note edit rights, immutable previous state, and payload spoofing. A four-client WebSocket/API test covers active versus removed recipients, denied mutations and unconsumed receipts, retry filtering, private audience changes and former-owner reconnect, private GM ownership, public note transfers, new token/drawing rights, and durable ownership after restart. An initial integration-test failure was an old-snapshot match; the check now waits for the specific post-transfer update.
- Browser QA used a separate temporary database with synthetic identities/content: transferred a private GM note to an existing player and verified the saved owner/private visibility/success message. Reviewed a subsequent transfer while a second browser edited the note; the review showed a conflict and disabled confirmation. Test tabs/server/data were cleaned up; normal campaign data was untouched.
- The access-management/recovery/ownership checklist item is complete for the initial table. Next: multiple campaigns/scenes, settings, and pinned system/content versions. Remaining limits include single-object ownership (no group ownership), no ownership history/undo or bulk transfers, manual member-list refresh, no module-backed character documents, and no supplied rulebooks/content. Existing third-party annotation and frontend bundle notices remain. No deployment occurred.

### 2026-11-04 — Campaign and scene storage foundation

- Replaced singleton persistence with validated campaign records, scene records, campaign-scoped command receipts, and an explicit storage-schema marker. The existing live table now uses the default campaign/active scene through the same store interface. Notes and roll histories belong to the campaign; each scene owns its drawings/tokens. No new campaign/scene payloads or hidden scenes are sent to the existing browser.
- Added internal storage operations to create/list campaigns, update versioned names/descriptions and exact package pins, create/list scenes, and activate a scene with a settings-version precondition. Creation is bounded to 100 campaigns and 100 scenes per campaign. New scenes start offstage and empty; activation preserves campaign-wide notes/rolls. Saves compare internal revisions, reject stale writers, and atomically commit settings/system-pin changes, scene state, and receipts. New note IDs cannot collide with inactive-scene objects.
- Added strict shared campaign/scene/pin contracts and a trusted installed-module catalog. Pins require exact installed versions and content-pack/system compatibility; caller-supplied package paths, version ranges, duplicate pack pins, and missing/incompatible versions fail validation. Synthetic pack metadata exists only in tests; no published mechanics/content were added.
- Added a transactional conversion from legacy singleton storage, including validated table-schema 1–4 restoration and receipt migration. Existing owners, private note/roll audiences, note versions, internal revisions, retry receipts, and access identities/sessions survive. Invalid legacy data/receipts roll back all new records/tables and leave the source untouched. Missing/unknown storage versions, incomplete storage, mismatched identifiers, and legacy tables re-created by an older build fail closed. The one-time conversion adopts the installed system version because legacy saves had no version metadata; subsequent loads never silently update pins.
- Verification: `npm run check` passed with **61 tests**, strict typecheck, production frontend/server builds, and the production startup/assets/authentication/shutdown smoke check. Added migration/restart/rollback/access-preservation tests; campaign data/receipt isolation; scene graphics versus campaign notes/rolls; stale switches/writers; cross-campaign scene rejection; exact pins and missing-package restart behavior; settings conflicts; capacity/boundary validation; and metadata/scene/pin/receipt transaction rollback. A real GM/player WebSocket/HTTP test confirms that offstage scene IDs/names/objects and another campaign's public notes never reach current-table payloads, that a receipt in another campaign cannot suppress a valid local command, and that normal play preserves offstage/other-campaign content. No browser/layout changes were made in this increment.
- Scope: this completes the storage substep, while the parent multi-campaign item stays unchecked. Public access still uses the initial `main` membership and the browser opens only the default campaign. The new management methods are trusted server internals, not exposed endpoints; authorization/context binding must land before campaign/scene selection is enabled. Next: campaign-scoped membership/invitations and management routes, then GM scene activation and switching UI. Deletion/renaming of scenes, module-backed document storage, ownership history/undo, automated package migrations, and backup/restore remain queued. This storage upgrade has no downgrade path; use a pre-upgrade backup with older builds. Existing dependency annotation/bundle notices remain. No deployment occurred.

## License

Tableloom code is MIT licensed; see [LICENSE](LICENSE). Game names identify intended compatibility. Published game content is not included in this repository.
