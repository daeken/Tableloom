# Using and hosting Tableloom

[Project overview and task list](../README.md) · [Platform reference](platform.md)

## Getting started


Requires Node.js 24 and npm. No database service or external account is required.

```sh
npm ci
npm run dev
```

Open http://localhost:5173. On first launch, create the host using the private key in `data/host-key` (or your configured `TABLELOOM_HOST_KEY`). The server prints the file location, never the key itself. Keep this key private: it can also recover the host identity after signing out or losing a session. Existing prototype scene data is retained.

Once signed in, the host can choose **Invite & players**, create a one-use code, and share the table address and code with a friend. The friend enters a name and that code. Use separate browser profiles to test independent identities; ordinary tabs share a browser session. A player cannot create invitations.

Sessions last seven days and survive server restarts. Signing out revokes the session and clears the browser table. The host can select **I'm the host** to recover access with the private key. For a returning player, the GM opens **Invite & players** and chooses **Create return code** beside their existing membership. The player enters that code on the same join screen; their original identity, name, object ownership, private notes, and private rolls are preserved. The name entered on the join screen is used only for new-player invitations. Issuing a new return code replaces that player’s previous unused return code; using it signs out all of their previous sessions. Codes expire after one day and work once. Names alone never recover an identity.

Before sign-in, the page contains only **Table access**. Setup/join begins in the name field; host recovery begins in the key field. Failed attempts clear the credential and focus its field beside the error. Successful sign-in focuses the Battlefield area. On short screens, scroll the access page to reach the full form.

The development server proxies `/api` and the WebSocket to Fastify on port 3001. The browser opens the campaign selected by its session and that campaign’s active scene. New invitations enter their own campaign; host setup/recovery opens the default campaign. Use the campaign name in the header to select/create a campaign, edit its settings as GM, or join another invitation under your existing identity. The campaign and active-scene headings update live. GMs can open **Manage scenes**, create an empty offstage scene, and review **Show scene to everyone** to move the whole campaign to it. Each scene retains its own drawings/tokens; campaign notes and rolls stay available. Save drafts before changing campaigns. In-memory note drafts survive scene changes, while unfinished canvas gestures/selection reset. SQLite data lives in `data/tableloom.sqlite` (ignored by Git).

```sh
npm run check       # strict types, tests, build, production smoke check
npm run build
npm start           # frontend + API on http://127.0.0.1:3001
```

The battlefield loads when a signed-in scene is ready. If it cannot load, the other panels remain available; save panel drafts before choosing **Reload page**. Production hosting must serve the entire generated frontend folder, including all hashed JavaScript assets.

After a build, `npm run bundle:report` reports initial/deferred JavaScript sizes. `npm run check` includes this report; gzip sizes are estimates and require host/proxy compression to affect transfer sizes.

Configuration: `PORT` (default `3001`), `HOST` (default `127.0.0.1`), `DATA_DIR` (default `./data`), optional `TABLELOOM_HOST_KEY` (32–512 characters, otherwise a random key is generated in a private `host-key` file), and optional `PUBLIC_ORIGIN` (the browser-facing HTTP(S) origin, without a path). For an HTTPS reverse proxy, set `PUBLIC_ORIGIN=https://your-table.example`; this enforces the configured origin and enables Secure session cookies without trusting forwarded headers. Development defaults to same-origin HTTP on loopback.

Only authenticated members can fetch or connect to the table. Everyone can draw, create tokens, and roll dice. Players can move, resize, and delete their own tokens and drawings (including text labels); the GM can edit every object and change the game system. The server assigns ownership to the creator; creation commands reject caller-supplied ownership. Older objects without a recorded owner stay under GM control until assigned. The GM can select **Manage ownership** below the cast list, choose a token/drawing/note and a current member, then review and confirm the transfer. Removed members cannot receive ownership. Assigning an object to the GM keeps it under GM control.

To create objects without pointing at the canvas, Tab to **Shared battlefield** and press **N**, or choose **Create object…**. Pick Token, Room or Text label, enter X/Y and any dimensions/text, then choose **Create shared object**. Coordinates use canvas units (right/down), with a token center or a room/label upper-left corner. Snap and zoom do not change entered coordinates. Cancel/Escape discards the draft; saved creations support the usual undo/redo. Press **L** to select existing objects and use arrow keys to move them. In Select mode, press **G** or choose **Position selection…** to enter an exact position. For one token this sets its center; for drawings/groups, the dialog explains the shared anchor. If someone changes a selected object while the dialog is open, cancel and reopen it to review the latest position.

Tab into **Drawing tools** once. Left/Right and Home/End move between tools and named colors; Enter or Space chooses one. Tab leaves, and returning remembers the last focused control. Moving focus alone changes no tool or object.

Long campaign names are shortened only in the header. Open **Choose campaign** to read the full name; the header also exposes it as a description and tooltip.

In the **Table panels** tabs (Dice & rolls, Your game, Notes and Chat), Left/Right move between choices and Home/End jump to the first/last. Press Enter or Space to open the focused panel, then Tab to enter it. Unsaved note, chat and dice drafts survive panel changes.

Keyboard focus is marked with a dark-and-pale ring. Fields use an inset ring so the focus cue stays clear of their labels. Built-in labels, hints and metadata use a darker text palette for readability.

For exact drawing sizes, select one room, freehand drawing or text label, then Tab to **Resize drawing…** in its selection actions. Enter Width and Height and confirm; the upper-left corner stays fixed. Sizes must be at least one canvas unit and fit the board. Flat drawings can only scale as part of a group. Token and group selections have their own size controls.

To measure without dragging, press **M** with the battlefield focused, then Tab to **Enter endpoints…**. Enter Start/End X/Y, review the distance preview and choose **Show measurement**. Optional snapping previews the actual grid intersections and applies only to this ruler. The ruler is local to your view; Cancel preserves the previous result. Reopen the dialog if the shared grid changes.

Scene objects are currently public to all table members. Before rolling, choose **Everyone at the table** or **You and the GM**. Private rolls are visible only to the roller and the GM; a GM's private rolls stay with the GM. The history marks private results explicitly. Public is the default, and already-recorded roll visibility cannot be changed. Sign-out/identity changes clear the local roll draft.

The **Notes** panel supports plain-text documents. **New** creates a private note visible to its owner and the GM; GM-owned private notes stay with the GM. Set **Who can read this?** to **Everyone at the table** and save to share a note. Other players can read shared notes; only the owner and GM can edit or delete them. Changing a note back to private removes it from other players' current/future views. Previously shared text may already have been read.

Note edits require **Save changes**. Unsaved drafts stay in memory when switching notes/tabs and through unrelated table updates; save before reloading or signing out. Clean editors follow remote saves. If another editor saves while you have a draft, your draft is retained and stale saves/deletes are blocked until you explicitly reload the latest version. Notes are limited to 100 per campaign, 120 characters per title, and 10,000 characters per body.

The GM can list members and unused codes, revoke codes, and remove players in **Invite & players**. Member/code lists never return saved bearer credentials; a newly issued code is displayed only in its issuing dialog. Removing a player immediately revokes their sessions and return codes. Their existing objects, notes, and rolls remain stored and available to the GM; removal does not reassign or publish them. A fresh invitation creates a different identity, even with the same name. The host cannot be removed. Use the [backup/recovery commands](#backup-and-recovery) to preserve the database and private host key together. Module-backed documents have separate storage and a versioned owner/GM action API in the [platform reference](platform.md#module-document-api). The **Your game** panel now has provisional module-provided character records. Published character-sheet rules, items/powers, rich text, attachments and version history are not implemented yet.

Note transfers keep the saved content and visibility. A private note requires explicit confirmation before the new owner receives its full saved text and the previous player owner loses access. The GM always retains access. A public note stays readable by the table, but edit/delete rights move to the new owner. Transfers advance the note version, blocking stale edits/deletes; the review screen blocks confirmation if the note changes while being reviewed. Save drafts before transferring. Hidden notes and their local drafts disappear from the previous player’s current view; previously read content cannot be recalled. Dice results keep their original ownership and attribution. Ownership transfers have no dedicated history or undo yet.


## Character records

Open **Your game**, choose **New private record**, and fill in the record title and module fields. **Save record** stores the changes. The three initial modules currently expose name and notes only; these are provisional records awaiting rulebooks. A record title labels the list separately from the module's character name.

New records are visible to their owner and the GM. Change **Who can read this record?** to **Everyone at the table** and save to share. Other players can read a shared record; editing stays with the owner/GM. **More records** and **First page** browse the visible list.

Drafts stay when switching panel tabs or briefly disconnecting. Save or discard before opening another record, creating one, changing campaign/system, reloading or signing out. **Refresh records** checks saved changes. If someone else edited while you had a draft, your draft is kept and Save is blocked; **Discard draft & use latest** loads their saved version. There is no merge. If saving is not confirmed, refresh and check the record/list before trying again; changes are never silently retried. Installed modules can supply action buttons using saved versions, but the initial scaffolds have no game actions yet.


## Content packs and homebrew

The server can load trusted, versioned content packs, let a GM replace individual definitions for a campaign, and create owned copies using a module-supplied factory. Packs must match the campaign's exact system version and be selected in its saved settings. Players receive only public definitions; homebrew defaults are never inferred from private originals. A reset restores the installed definition. Active overrides must be reset and owned copies removed before removing their pack or changing the campaign's system version. Owned copies preserve the definition they were made from and separate editable module state; later homebrew changes do not alter them. New copies are private to their owner and the GM. Owners/GMs can explicitly share them and save versioned edits.

When an installed module supplies content controls, **Your game → Catalog & your copies** lists the campaign's visible definitions. Open one and choose **Make a private copy**. Edit its name, sharing and module fields, then choose **Save copy**. Shared copies are read-only for other players. Catalog and copy lists have separate page controls. **Refresh content** checks saved changes; switching away from and back to Your game also refreshes. Content has no background polling or live updates yet.

Save or discard a copy draft before opening another entry or making another copy. Refresh preserves a dirty draft; competing edits block saving until **Discard copy draft & use latest**. Failed or uncertain writes block further writes until refresh; check the copies list before retrying creation, since a lost confirmation may already have saved. Save before switching campaigns, reloading or signing out. Losing access clears the displayed content/draft on refresh.

No packs ship with the real game scaffolds yet, so their content panel is hidden. `npm run modules:preview` supplies synthetic paper and kit examples for testing. Copy deletion remains API-only. No character-record links, instance migration or ownership transfer are provided. Character records continue to work independently. Module authors can use the [content-pack contract](platform.md#content-packs-and-campaign-homebrew); published content is waiting for source PDFs.


GMs can use **Manage content packs** in the catalog panel to select exact installed versions compatible with the campaign's system. Save the selection to refresh the catalog. Only one version of a pack can be selected. Existing overrides or owned copies block removal; reset the overrides and remove the copies first. Pack settings use the campaign version to prevent overwriting competing name/system/scene changes. After a failed or uncertain save, refresh the settings; the local selection draft is kept, and a conflict requires discarding it before editing the latest settings. A legacy unavailable pin is retained and cannot be removed through this dialog.

Open a definition and choose **Edit campaign homebrew** when its module provides an editor. Change the name, audience, module fields and replacement source references, then **Save homebrew replacement**. This replaces the catalog entry for this campaign; owned copies keep their earlier source/state. Changing a private entry to **Everyone at the table** requires reviewing the replacement fields and listed sources. Any further edit clears that review checkbox. The editor starts with the entry's effective source list; it does not add separate original-source citations. Review every listed source before sharing.

Save or discard the homebrew draft before choosing another entry, making a copy or managing packs. Refresh keeps a dirty draft; a changed definition blocks saving until **Discard homebrew draft**. Copy and homebrew editing are kept separate while a homebrew form is open. To restore an overridden entry, expand **Reset to the installed definition…** and confirm: this restores its installed data, name, sources **and audience**. Reset has no undo. Published content already copied/read by others cannot be recalled by resetting or hiding the entry. These controls use synthetic examples in the preview until real packs and rulebooks are supplied.


## Docker packaging

The repository includes a multi-stage `Dockerfile` and `compose.yaml`. [Linux CI](https://github.com/daeken/Tableloom/actions/runs/42044000646) verified the image build, UID 1000, read-only application filesystem, generated key permissions, HTTP/WebSocket behavior and named-volume persistence across container replacement on Ubuntu 24.04/Linux amd64. The development Mac still has no local engine/plugins; this does not claim Apple Silicon or Windows container verification.

With Docker Engine and Compose/buildx available, local startup is:

```sh
docker compose up --build -d
docker compose ps
```

Open http://localhost:3001. Compose binds the published port to loopback by default. The image listens on port 3001 internally; `TABLELOOM_PORT` changes the host port, and `TABLELOOM_BIND` changes the host interface. `PUBLIC_ORIGIN` sets the exact browser-facing origin as described above, including HTTPS cookie behavior. No reverse proxy or TLS termination is bundled. `TABLELOOM_IMAGE` optionally changes the locally built image tag (default `tableloom:local`); nothing is pushed to a registry.

The image is configured to run as **node, UID/GID 1000**, with a private `/app/data` directory. Compose mounts the named `tableloom-data` volume there, makes the application filesystem read-only, gives `/tmp` a small temporary filesystem, drops capabilities, prevents privilege escalation and forwards termination signals through Docker's init process. Database state, uploaded images (stored inside SQLite), sessions and the generated `host-key` all live in that volume. Only the data volume is intended to persist; runtime sources/development tools are not copied into the image.

On first use, read the generated private key on your server to set up the host:

```sh
docker compose exec -T tableloom cat /app/data/host-key
```

The key is not baked into the image, passed through default Compose configuration or printed in application logs. Optional `TABLELOOM_HOST_KEY` injection requires your own Compose override/environment mapping; supplying it bypasses generated-key loading. Bind mounts also require administrator-prepared write ownership for UID/GID 1000 and a private key file; the application does not start as root to repair ownership. Default named-volume initialization and application write access passed the Linux CI check.

`docker compose stop` shuts down the service, and ordinary `docker compose down` retains its named volume. Rebuild/recreate with `docker compose up --build -d` to reuse that data. Do not remove the volume during an upgrade. Backup/restore commands are available below; automatic downgrade and separate backup/recovery-mount CLI verification inside Docker remain pending. Keep the data volume and host key safe. The container health probe reads `/api/health` through loopback and checks the protocol version; it does not log credentials or mutate data, and it is not a complete database-integrity check.

For development verification:

- `npm run runtime:check` builds the app, installs production dependencies into a fresh temporary folder, confirms no source/compiler/tsx is present, and checks built assets, generated key permissions, authentication, WebSockets, stored records/images, online backup and verified recovery/restart into a new data directory. It uses your local Node 24 and removes its temporary data. It proves the production dependency boundary, not container ownership/mount behavior.
- `npm run container:check` requires a running **local socket** Docker engine and Compose/buildx. It builds an isolated randomly named project/image with a private test volume and ephemeral loopback port, checks UID/read-only filesystem/health and the same HTTP workflow, then recreates the container and checks key/session/record/image persistence. It removes only its own project, volume and image afterward. Remote Docker endpoints are rejected. It never uses the normal Compose project's data. A failure before Docker preflight creates nothing; an interrupted process may need cleanup of the printed test project.

The base image uses the official [Node 24 Debian slim image](https://github.com/nodejs/docker-node/blob/main/24/bookworm-slim/Dockerfile). Docker's [volume documentation](https://docs.docker.com/engine/storage/volumes/) describes named-volume retention and initialization. The base tag tracks Node 24 updates rather than a pinned image digest; npm dependencies use the repository lockfile. When adding workspace modules, update the Dockerfile manifest-copy list and the isolated runtime check together.


## Backup and recovery

After `npm run build`, use the administrator's local commands:

```sh
npm run backup -- --source ./data --destination /srv/tableloom-backups/session-2026-11-05
npm run backup:verify -- --source /srv/tableloom-backups/session-2026-11-05
npm run restore -- --source /srv/tableloom-backups/session-2026-11-05 --destination ./data-recovered
```

Both destination directories must be **new**, with an existing writable parent. Existing directories—even empty ones—are refused. Restore also refuses destinations inside its source archive, including through symlinks. Neither command overwrites the live data directory, stops/starts a server or changes your hosting settings. After stopping the normal server, start it with `DATA_DIR=./data-recovered npm start` and check recovery before switching your normal configuration. Keep the original data until the restored table is verified.

Backup can run while the server is online. It holds a SQLite read snapshot and uses the online backup API, including committed WAL data, then produces a standalone database. All campaigns, scenes, map images (SQLite blobs), notes, rolls, histories, module records/overrides/owned copies, memberships and credentials in that database recover together. Changes after the snapshot are absent. Unexpired sessions and invitation/access state return to their saved state; recovery does not merge changes from the original server.

Each backup is a private directory with exactly `tableloom.sqlite`, `host-key` and `tableloom-backup.json`. The manifest records format version, creation time, Node version, key source, byte counts and SHA-256 checksums. Verification checks file types/limits, exact directory contents, key validity, hashes, SQLite integrity/foreign keys and recognized initialized Tableloom tables. Backup databases are limited to 64 GiB, manifests to 32 KiB and key files to 2 KiB. Database/key/manifest files are written with mode 600 and directories with mode 700 on POSIX. Keep the whole directory together, outside served web folders and preferably outside the live data volume. It contains **all private campaign content and the host recovery key**. Checksums detect corruption; they do not authenticate or encrypt an archive. Store and transport backups privately.

By default backup reads the existing private `host-key` file without generating one. If your server uses `TABLELOOM_HOST_KEY`, give the backup command that **same environment setting**; it is included privately in the archive, never in command output. Environment keys with surrounding whitespace are refused because file-based startup trims whitespace. Restore writes the captured key as a private file. Unset an unrelated `TABLELOOM_HOST_KEY` when starting the restored server, or explicitly configure the matching key; an environment key overrides the restored file.

Only verify/recover archives you trust. Verification does not load modules, migrate schemas or prove compatibility with a different app build. Keep the matching application and trusted system/content-pack versions separately: archives contain stored pins, homebrew and owned snapshots, not installed code or original pack catalogs. This tool requires initialized campaign/access storage; it is not an importer for pre-campaign prototype files. Normal startup performs its existing version/pin checks and rejects incompatible saves.

The commands use exclusive creation, private incomplete markers and flushed files/directories. Failed operations remove only their newly created files; if cleanup cannot finish, a marker remains and the server refuses that directory. Archives are also refused as live `DATA_DIR` values, preventing accidental writes to a backup. A process kill can leave an incomplete directory; use a different destination and inspect the incomplete one before cleaning it up. There is no overwrite/force mode, automatic retention, scheduling, encryption, compression or in-app download endpoint. The commands do not expose backups or recovery keys to campaign players.

The compiled commands are also included in the Docker image as `node apps/server/dist/backup-cli.js backup|verify|restore`. Container recreation against the named data volume passed Linux CI. Backup/restore through separately mounted archive/recovery directories has not yet been exercised inside Docker; supply appropriately owned mounts and explicit paths when testing that workflow.


## Reverse proxy and HTTPS

Serve Tableloom at the **root of one HTTPS origin**, such as `https://table.example`. Subpaths such as `/vtt/` are unsupported: the browser uses root `/api` and asset paths, and `PUBLIC_ORIGIN` accepts only an HTTP(S) origin without credentials, query, fragment or path. Use a certificate trusted by your players' browsers and configure DNS/TLS in your existing hosting setup; Tableloom does not issue certificates or configure your domain.

Keep Node or the Compose-published port on loopback when the proxy runs on the same host. Persist the public origin in your normal service configuration. For Compose, an ignored `.env` beside `compose.yaml` can contain:

```dotenv
PUBLIC_ORIGIN=https://table.example
TABLELOOM_BIND=127.0.0.1
TABLELOOM_PORT=3001
```

Use that same configuration on later recreations. The default Compose file does not map `TABLELOOM_HOST_KEY` automatically; the generated private key still lives in the data volume unless you explicitly configure an override.

A proxy must forward the complete site to the Node backend, preserving paths, query strings, cookies and the browser's **Origin**. Forward the external Host header and WebSocket Upgrade/Connection headers, using HTTP/1.1 upstream. Do **not** replace Origin with a fixed trusted value or strip it: mutations and `/api/live` require the real matching origin. `PUBLIC_ORIGIN=https://table.example` makes the HTTP backend accept that external HTTPS origin and issue Secure cookies. Forwarded scheme/host/client-IP headers are not trusted by the app and do not replace this setting.

The proxy example allows 65 MiB for host-only ownership review, which wraps a source file and plan in JSON. The source file and raw preflight still allow 32 MiB, images 5 MiB and ordinary JSON 256 KiB; their app limits are unchanged. Preserve API `Cache-Control: no-store` and disable proxy caching of authenticated responses. Forward the WebSocket protocol query unchanged. The app sends 30-second pings, so allow idle time beyond that rather than using a short proxy timeout. Sign-in rate limiting currently sees the proxy's socket IP, so users behind one proxy share its built-in sign-in attempt bucket; adding forwarded IP headers does not change this behavior.

If you already use nginx, [deploy/nginx.conf.example](../deploy/nginx.conf.example) is an optional include for its `http {}` context. Replace every example hostname and certificate path, then validate with `nginx -t` in your installation before loading it. It assumes a proxy on the Docker/Node host with backend `127.0.0.1:3001`. For a proxy in another container, use a deliberately configured private container network/upstream instead; that container's loopback is not the Tableloom container. No proxy service or certificate is installed by this repository. The forwarding directives follow nginx's [WebSocket](https://nginx.org/en/docs/http/websocket.html) and [proxy-header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) documentation.

After configuring your endpoint, check `/api/health`, host sign-in, a second player's invitation, a live scene change/dice result and an image upload through the public URL. An unauthenticated `/api/table` returning 401 is expected. For 403 on sign-in or live connection, compare the browser's exact origin with `PUBLIC_ORIGIN` and check that Origin reaches Node unchanged. For HTTP success but no live updates, check WebSocket upgrade forwarding. For upload 413, check both proxy and app size limits. Do not work around these errors by weakening origin or cookie protections.

The application-side HTTP/WebSocket contract is integration-tested with an HTTP upstream simulating TLS offload. CI additionally runs `nginx -t` against the checked-in example using a temporary self-signed fixture and no network/listener. That verifies syntax, not your DNS, certificate chain, renewal, firewall or real proxy deployment.

## Upgrades and rollback

Upgrades can change database formats, live protocol and module schemas. Keep the reviewed application revision/image, matching trusted modules/content-pack versions, service settings and host-key configuration. Record those references **beside**, not inside, a backup archive: the archive's strict three-file format rejects extras. Save browser drafts before maintenance; drafts are not backups.

1. Build and check the candidate in a separate checkout/image so the running server's assets and dependencies stay intact. Use `npm ci` and `npm run check`, or build your candidate image. Preserve local module changes; do not force-reset a working checkout.
2. Take and verify a [backup](#backup-and-recovery), restore it into a new rehearsal directory, and test the candidate there. For a native local rehearsal, use an explicit separate origin/port, for example `HOST=127.0.0.1 PORT=3002 PUBLIC_ORIGIN=http://127.0.0.1:3002 DATA_DIR=/srv/tableloom-rehearsal npm start`. Open that exact loopback URL. Check access, scenes, private/shared records, maps, rolls and module fields; do not expose the rehearsal as the live table.
3. For cutover, stop the live server and take a **final verified backup** before running the candidate on live data. This captures edits made after the rehearsal snapshot. Select the intended final data directory/volume explicitly, then start the candidate with the normal public origin and key configuration. Native hosting can use a freshly restored final snapshot to retain the original directory untouched; backup/restore through separate Docker mounts still needs operator validation.
4. Check the real endpoint and have players reload old tabs. Old protocol versions fail the live handshake rather than guessing compatibility. Keep the previous build and final pre-upgrade archive until recovery has been checked.

Compose upgrades must keep the existing project identity and data volume. Record the current project with `docker compose ls`; use the same `-p <existing-project>` if moving to another checkout directory. Changing the project/volume name can create a fresh empty instance. `docker compose up --build -d` recreates the service against its existing volume; ordinary `down` keeps that volume. Do not remove it as an upgrade step.

Known storage upgrades run through the existing validated migrations; unknown/future formats and missing package pins fail startup. There is no general downgrade or automatic campaign package-pin migration. If the candidate fails, stop it and investigate without editing version markers or package pins to bypass checks. Rollback uses the previous compatible build and a **new directory restored from its pre-upgrade archive**, not an older binary pointed at a database already migrated by newer code. Data after that archive's snapshot is absent; restore does not merge it back. Avoid serving two independently writable copies as the same live table.

## Installing trusted modules and content packs

Modules are **reviewed source packages compiled into your server and browser**, not uploaded rule files or sandboxed plugins. There is no marketplace installer, arbitrary import-path loader or visual rules builder. Server code has the host process's access; install only code you intend to trust with all campaign data. The three game packages remain provisional scaffolds until source rulebooks are supplied.

For an agent/developer adding a module:

- Add its separately versioned workspace package under `systems/`, using the SDK's shared, `/client` and `/server` entry points. Keep schemas/pure shared data separate from browser controls and server migrations/actions/content providers. Private pack definitions and authoritative code stay server-only; the browser imports shared schemas/pins and typed UI adapters.
- Register its manifest in `apps/server/src/modules.ts`, server definition in `apps/server/src/document-modules.ts`, and manifest/browser adapter in `apps/web/src/App.tsx` (`modules` and `panels`). Add explicit workspace dependencies to the server/web package manifests. Update the Dockerfile and `scripts/runtime-check.ts` manifest lists when adding a workspace, refresh the lockfile and run the full checks.
- Use the isolated module preview/tests before trying a copy of real data. Browser boundary scans cover the synthetic preview markers, not an audit of arbitrary module code; inspect actual browser imports/assets too. Published content and rule cases need the supplied edition/page references.
- Register versioned content packs on the trusted server system with `defineContentPack`/optional owned-instance factories, and matching `defineBrowserContent` controls in the client adapter. Rebuild/restart before selecting a loaded compatible pack in **Your game → Manage content packs**. A checkbox selects existing code; it does not download or install a package.

Campaigns pin exact system and pack versions. The server installs **one version per system ID**, so swapping a used system version is not a side-by-side upgrade or an automatic migration. Document schema migration does not silently change that package pin. Keep the old build/data for campaigns that still require it until an explicit compatible transition exists. Multiple versions of a content pack may be registered, but a campaign selects one per ID; active overrides/owned copies protect their current pins. Changing content under an existing pack version fails fingerprint validation. Bump versions for data/schema/behavior changes and rehearse on a restored copy; never relabel old stored data to force it to load.

## Campaign transfer: current limits

**Campaign export, preflight, ownership review, candidate preparation and atomic import have administrator APIs. Browser export and read-only import review are available; confirmed import/retry controls and a CLI are unfinished.** Import creates a separate campaign on a compatible installation; it does not replace [whole-instance backups](#backup-and-recovery), which also preserve credentials, recovery keys and server configuration.

### Download a campaign from the browser

Open the campaign picker by selecting the campaign name, then choose **Export campaign…** on the current campaign. This action is available to GMs, including campaign GMs who are not the server host. The review loads current campaign settings and explains the private scope. Confirm **I understand this file includes private and unrevealed campaign content**, choose **Prepare private file**, then **Save private campaign file**. Preparing the file does not automatically save it. If your browser opens it instead, use its save option.

The exported file preserves the server's exact UTF-8 bytes, including embedded images. Keep it private: all scenes, unrevealed maps, private notes/chat/records and history are included. Secrets written into campaign content remain in the file. Stored sign-in credentials, invitations and host-key configuration are excluded. It is an unencrypted campaign transfer file, not a player handout or whole-instance backup. Compatible game code and an explicit ownership review are still required for import.

If settings or access change, export fails without offering a file. **Review latest campaign** reloads settings and resets your confirmation. Closing the review cancels pending requests and releases the prepared save link; reopening requires confirmation again. It leaves campaign settings drafts and the campaign selector open. No private file is saved in browser storage by the app. Requests time out after 30 seconds, and both declared and streamed file size are bounded to 32 MiB. Use a whole-instance backup if portable export is too large.

### Export API

An authenticated GM with the campaign active can request `POST /api/campaigns/<campaign-id>/export` from the same origin, with JSON:

```json
{
  "expectedVersion": 1,
  "include": "all-campaign-content-including-private"
}
```

Use the campaign's current version from its settings response, not a fixed version of 1. A stale version returns 409. The response is a `no-store` JSON attachment named with the campaign UUID. The GM browser review below provides a download link. Players, signed-out sessions, foreign origins and other inactive campaigns cannot request this export.

**Treat the file as private administrator data.** It includes all scenes (including inactive ones), maps and library images, notes, current/archived rolls, private chat, module records, homebrew, owned content and durable edit history for that campaign. It includes source ownership identifiers and the current member names/roles as descriptors, but no login sessions, invitation/recovery codes, private host key or other campaigns' records. User-entered secrets in notes/module fields remain content and are included. This is not a player-safe share file. Files are plaintext, unsigned and unencrypted.

Exports are limited to 32 MiB of JSON and 100,000 data rows; embedded images use base64. Large campaigns should use whole-instance backup. Export runs in one consistent read snapshot without changing the source. It retains exact system/pack versions and content-pack fingerprints, including historical reset-only pack references. Source identities are preserved **without access grants**: departed owners may have no current member descriptor. Import applies a reviewed ownership plan and validates installed code, references and module data; matching names or IDs never grant access automatically. No module code or installed base catalog is bundled, and compatibility must be checked on the destination.

For **whole-instance** transfer, back up, verify and restore into a new data directory on a matching installation. It brings every campaign and saved access state/recovery key; it cannot select one campaign, remap owners, merge into an existing server or supply missing module/pack code. Selective transfer is available through the APIs below; its UI remains in the README task list.


### Review an import from the browser

Open the campaign picker and choose **Review campaign import…**. Only the signed-in **server host**, acting as a GM, can load the review. Other campaign GMs receive an access message and cannot select/upload a file. This workflow is **read-only**: it creates no campaigns, people, memberships or invitations. Confirmed creation and safe retry controls are still being built; use the administrator import API below when you need to execute an import.

Choose a UTF-8 Tableloom export of at most 32 MiB. Reading the file locally does not upload it. Confirm **Allow this server to inspect all private content in this file**, then choose **Inspect private file**. The full file is sent to this server, including private/unrevealed content. File/package blockers appear before ownership review; compatible trusted modules and declarations are required. Unsupported, malformed, empty or oversized local files are not uploaded.

Choose ownership for **every** source identity, including departed/unnamed people. Nothing is selected automatically, even when names or UUIDs match. Keep unclaimed attribution without access, create a distinct named person with an explicit role, or select an existing local person. Search local names or page through the list; it includes the host and profiles with current membership in at least one campaign, excluding membership-free attribution profiles. Changing results preserves selected people. Source identities are shown 25 per page, and choices persist across pages. Source roles describe the file, not destination access. Selecting a different local person resets the proposed role to Player; the host independently remains a GM. New people receive no session or invitation.

If several source identities map to one local person, explicitly confirm their combination, including private content and editing history. Confirm the people/access review, then choose **Review ownership choices**. The summary includes the server's current resolved names and roles. Choose **Validate mapped campaign** to check fresh resource IDs, modules, ownership, history and storage limits together. A successful result still creates nothing and reserves no IDs. A final import must repeat these checks atomically. Unknown historical content-pack bindings can still block execution until trusted code is installed/verified.

Any ownership edit clears previous approval and mapped validation. Replacing the file clears all choices and consent. Closing cancels requests, discards the in-memory file/review and returns to the campaign picker without discarding campaign settings drafts. Reopening starts fresh. The app writes no file or plan to browser storage; a lost session/host change clears private review state. Requests time out after 30 seconds. Review can always be repeated safely because it makes no saved changes.

### Read-only destination preflight

The signed-in **server host** can send the downloaded file directly as the JSON body of `POST /api/campaign-imports/preflight`, from the same origin. Do not wrap it in another object or use multipart upload. The endpoint requires valid UTF-8 and accepts at most 32 MiB; authorization runs before the body is parsed. If a reverse proxy returns 413, update its limit for the chosen endpoint; the current example allows 65 MiB for wrapped ownership reviews. The app's other JSON/image limits are unchanged.

Preflight returns `status: "preflight-only"` and **always** `importReady: false`. It checks the current file/storage format, table row limits, neutral current state and resource references, canonical base64/length/image hashes, decoded canonical PNG data, exact installed package fingerprints and available document/content/instance schemas. Missing or changed packages and schema versions are reported as blockers. A current source member's name/role is labelled as a source descriptor; departed owners discovered in saved records appear without a name/role. Every source identity requires an explicit review choice, even if a destination account has the same name or UUID. Raw preflight proposes no matches or access grants; the separate ownership-review endpoint accepts your choices.

The response contains resource counts, package statuses, source identities, source-ID collision counts, blockers, pending checks and a SHA-256 of the exact file bytes. It omits private document/map/chat bodies and makes no persistent changes, consumes no invitations and runs no module actions, migrations or instance factories. The fingerprint identifies the inspected bytes; it is not an import token or a compatibility guarantee. File content is still untrusted and private.

**An empty blocker list is not an import authorization.** Ownership review and fresh-ID candidate preparation are separate read-only steps. The import endpoint below rebuilds and validates the candidate under its write transaction. Collision results and preview IDs reserve nothing. Whole-instance backup remains the recovery mechanism.


Preflight now applies the live stores' source-data limits as well as file limits: 100 chat messages per public/private audience and 1,100 per campaign; 100 object-history entries per person per scene, 10,000 per campaign and 32 MiB of stored payload/target JSON; 100 map-history entries per scene, 10,000 per campaign, 4 KiB per entry and 8 MiB in total. Image-library totals and the existing scene/document/content/instance/roll/object-ID limits are checked too. Raw JSON byte budgets use UTF-8, including whitespace; oversized files are rejected without silently pruning data.

The destination summary includes `campaignCapacity` with campaign/access-registry usage and the 100-campaign limit. Either registry being full adds `campaign_capacity_reached`, even when the source UUID already exists: import creates a new campaign rather than overwriting one. These reads reserve nothing. Source quotas being satisfied does not prove that a future ownership mapping fits: combining authors can merge private chat/history buckets, and remapping can change JSON sizes. `mapped-storage-quotas` therefore remains pending and execution must recheck both mapped limits and destination capacity.


Map undo/redo history is checked against the saved map for every scene, including inactive private scenes. Entries must form an ordered chain, point to retained asset references and agree with the saved cursor and the available undo/redo states. A nonzero cursor must name a retained entry. Cleared history with cursor zero, pruned prefixes, nonconsecutive sequences after branching and fresh image access keys after undo/redo remain valid. The comparison checks source image, position, dimensions and visibility; it does not restore old access keys.

Object edit history is checked for correctly scoped, backward-only causal links, consistent object types/scenes and undo/redo stack order. Saved layer and restoration-order references must use reserved IDs of the right type. Missing predecessors from retention are allowed, as are stale edits that another person’s later changes have made unavailable. The response includes `objectHistoryValidation` counts for entries, retained links and expired links. History is never resolved against destination records or replayed during preflight.

These checks establish consistency within the supplied file, not the authenticity of its past edits or whether each edit can still be undone. Combining source authors can change stack order, so `mapped-history-graph` remains pending alongside mapped quotas. `importReady` remains false; any eventual import still needs reviewed identity/resource mapping and fresh destination image capabilities.


### Read-only ownership review

The signed-in server host can send `POST /api/campaign-imports/ownership-review` with `{ file, plan }`. `file` is the **exact export text as a JSON string**, preserving whitespace and its preflight SHA-256. The plan requires a choice for every `ownership.subjects[].sourceId`, including departed owners and module-declared member references. Get existing local UUIDs from an authorized campaign member listing; names and matching source UUIDs never select people automatically.

```json
{
  "file": "<exact export file text>",
  "plan": {
    "version": 1,
    "archiveSha256": "<preflight archiveSha256>",
    "acknowledge": "reviewed-private-content-and-access",
    "acknowledgeMerges": false,
    "assignments": [
      {
        "sourceId": "<source identity UUID>",
        "target": { "kind": "existing", "userId": "<local host UUID>", "role": "gm" }
      }
    ]
  }
}
```

Repeat assignments until every source identity appears exactly once. Three target choices are supported:

| Kind | Required fields | Result of import |
| --- | --- | --- |
| `existing` | Local `userId`, explicit `role` (`gm` or `player`) | Membership for that person in the new campaign |
| `new` | Explicit `name` (1–32 characters) and `role` | A distinct new person; equal names do not merge identities |
| `unclaimed` | No other fields | Create a distinct attribution-only profile without membership or login credentials; the GM controls the content |

The server host is always planned as a GM independently of source roles and counts toward the 1,000-member limit. Choosing a player role for the local host or conflicting roles for one local person is rejected. Source GM roles never become grants. Mapping several source identities to one existing person is shown in `mergedTargets` and adds `identity_merge_acknowledgement_required` until you explicitly set `acknowledgeMerges: true`; their combined private content and editing stacks still need mapped validation. New/unclaimed choices remain distinct per source identity.

The result is `status: "ownership-review-only"`, **always** `importReady: false`, with normalized plan/assignment previews, current local names, merge/capacity summaries and `planSha256`. Completion removes only `ownership-plan` from pending checks; incomplete module identity inventory, unacknowledged merges or too many planned members keep it pending. Image/source/package checks run again. Local targets and host authorization are checked after image work. A missing local person or changed file fingerprint returns 409. The plan hash fingerprints normalized choices; it is not a reservation, permission token or guarantee that a later write will succeed.

This endpoint allocates no IDs, creates no people/memberships/invitations/sessions, copies no source credentials and saves nothing. The browser review above uses this endpoint; campaign creation remains API-only. It accepts a 65-MiB JSON envelope to accommodate escaping a file of at most 32 MiB, plus a bounded plan (at most 1,000 assignments and 512 KiB of normalized JSON). Existing proxies capped at 32 MiB may reject larger wrapped reviews; use the current 65-MiB example. Raw preflight/image/ordinary JSON limits remain unchanged.


### Prepare a fresh campaign candidate

The server host can call `POST /api/campaign-imports/prepare` with the same exact `file` text and complete ownership `plan`, plus the required `resourcePolicy: "fresh-campaign-and-resource-identifiers"`. The request uses the same 65-MiB envelope limit as ownership review. This creates a private **in-memory candidate**, with no writes, accounts, memberships, invitations or live refresh.

```ts
await fetch("/api/campaign-imports/prepare", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    file,
    plan,
    resourcePolicy: "fresh-campaign-and-resource-identifiers",
  }),
});
```

Campaigns, scenes, objects, documents, instances, assets, rolls, chat and history receive fresh server-generated IDs. Explicitly selected existing people retain their local user IDs; new/unclaimed source identities get distinct fresh IDs. New/unclaimed choices still create no database rows. Image access keys are replaced, with separate keys per scene even if a source file reused one. Private/public visibility, geometry, versions, dice outcomes, historical display names and content-package pins stay intact. Only declared module links are rewritten; UUID-looking text remains text.

Old command retry receipts and digest bindings are omitted from the candidate: they belong to the source command context and cannot be rebound without the original commands. Editing history itself is retained and remapped, including expired predecessor links. Source commands/actions/migrations/factories are never replayed. The source file and image bytes remain unchanged, and no private candidate records or image keys are returned.

The response is `status: "candidate-preflight-only"` and **always** `importReady: false`. `resourcePlan` gives completion, policy, a preview campaign UUID, candidate fingerprint, mapping counts and dropped retry counts. `candidateValidation` reports mapped history/module checks. A complete candidate has only `atomic-import` pending. Preparation rechecks mapped storage quotas, identity inventory, module schemas/references, history graphs and destination capacity/package bindings. Candidate IDs are checked against global destination keys; no existing campaign or resource is overwritten. Merges that exceed storage limits or break editing-stack order are blocked, without silently pruning data.

Incomplete source/ownership review leaves candidate generation blocked. Later failures add `candidate_mapping_failed`, `mapped_storage_limits_exceeded`, `mapped_campaign_invalid` or `mapped_campaign_unavailable`; failed-stage summaries omit private errors and partial candidates. Adjust the ownership choices or source data and review again. A retry generates different IDs and fingerprints; previews reserve nothing and their hashes are not import tokens. **Preparation saves nothing.** The import endpoint repeats checks under its atomic write transaction; confirmed import/retry controls and a CLI remain unfinished.


### Import a reviewed campaign

The signed-in **server host** can send `POST /api/campaign-imports/import` from the same origin. Use the exact export text and reviewed plan, the review response's `ownershipReview.planSha256`, a new UUID `requestId`, and both explicit confirmations:

```ts
const body = {
  file,
  plan,
  expectedPlanSha256: ownershipReview.planSha256,
  resourcePolicy: "fresh-campaign-and-resource-identifiers",
  requestId: crypto.randomUUID(),
  confirm: "create-new-campaign",
};
// Retain this exact body until the result is known; reuse it after a lost response.
await fetch("/api/campaign-imports/import", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
```

The same 65-MiB envelope and 32-MiB file limits apply. The server checks image bytes, rechecks host access, then rebuilds and validates a fresh candidate under one write transaction. It saves campaign data, images, planned profiles/memberships and the retry result together. Any failure rolls back every write. The source and existing campaigns remain unchanged. A historical content-pack fingerprint must already be known locally or match installed trusted code; an unsigned file cannot establish an unknown global binding. Install/verify the historical pack if this check blocks import.

A new import returns **201**, `status: "imported"`, `replayed: false`, the new `campaign` membership, request/file/plan fingerprints, timestamp and summary counts (`createdPeople`, `attributionRecords`, `memberships`, `rows`). It returns no private record bodies or image keys. It does not switch your active campaign or rotate your session. Select the returned campaign through the normal campaign selector. Only explicit existing/new choices and the independent host GM receive membership. New people have no sessions or invitations; use normal GM recovery-code controls to let them sign in. Unclaimed owners get fresh attribution-only profiles labelled **Unclaimed identity**, with no membership, credentials or recovery invitations. They preserve ownership/history foreign keys and give no person access.

An exact retry with the **same request ID, file and normalized plan** returns **200**, `replayed: true`, and the original result, including after restart, backup/restore or container replacement. Reusing the ID with different choices/file returns 409; removing the target or host's GM membership also returns 409 without recreating it or restoring grants. Current host authorization is always required. Keep the original request body after a timeout; using a new ID can create another campaign. The server retains at most **1,000** import results (each at most 256 KiB); at capacity it rejects new requests while existing retries remain available. There is no receipt-pruning API yet. Results are server operational metadata, included in whole-instance backups but excluded from campaign exports.

Preflight/review/prepare continue to return `importReady: false` because they authorize no writes. Import succeeds only through the confirmed endpoint. There is no campaign overwrite, automatic package download, migration, action replay or browser creation/retry controls yet. Existing live permissions/version checks still determine whether an imported undo edge is usable.


### Module references during preflight

Saved module documents, homebrew definition data, owned instance state and saved definition snapshots need explicit transfer declarations from their installed server packages. A declaration lists resource-reference fields or explicitly states there are none. Missing declarations add `module_transfer_unavailable` and retain the `module-external-references` pending check; ordinary play and existing records are unaffected. The bundled name/notes scaffolds declare plain text only. No published game rules or content are added.

Declared links must refer to the correct kind of resource inside the source file. Existing destination IDs and deleted object reservations do not satisfy missing links. Module-declared member IDs join the source ownership review, including departed people without names/roles, and never become access grants. UUID-looking ordinary text is left alone. Reports add `moduleReferenceValidation: { records, references, complete }`, without field paths or private data. Successful inspection removes the source reference placeholder; raw preflight still leaves `mapped-module-references` pending. Candidate preparation rewrites declared links and checks the mapped copy. The import writer repeats validation atomically. No data is rewritten by preflight.


### PNG decoding during preflight

Successful HTTP preflight now decodes every embedded PNG using the same validator as image uploads, checks its encoded dimensions against metadata and requires its bytes to already be normalized. CRC, compressed raster, row/filter, palette, transparency and interlacing checks run before success; stripped ancillary metadata or trailing bytes are rejected rather than rewritten. Hashes and metadata alone do not complete this phase. The response adds `imageValidation: { checked, pixels, pixelLimit }` and removes `image-decoding` from pending checks only after all images pass. `importReady` still remains false.

PNG processing runs in one short-lived worker per check, with at most one worker job per app instance, a 10-second worker deadline and a budget of **67,108,864 total pixels** across all images. Existing per-image dimension/pixel/inflate limits and file limits still apply. A file that exceeds this work budget returns 400; use whole-instance backup for larger transfers. A busy inspector, timed-out job or worker failure returns a generic 409 and can be retried. There is no job queue. Busy uploads are rejected before parsing their bodies; unrelated table requests remain available.

Disconnecting cancels the worker. Server shutdown also cancels active inspection, and worker termination is awaited before releasing its slot. Host access is checked again after asynchronous work, so signing out or revoking the session prevents a pending response from returning inspection results. No source/destination data, image bytes or access keys are rewritten, and decoder errors/private names are not echoed. These checks validate a file's image data within the work limits; they do not authenticate its content or authorize import.
