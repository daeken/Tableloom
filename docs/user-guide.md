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

The repository includes a multi-stage `Dockerfile` and `compose.yaml`. **Container verification is pending:** this development machine has a Docker CLI but no running engine or installed Compose/build plugins. Compose syntax and a fresh source-free production install have been checked; actual Linux image building, volume ownership, non-root operation and container replacement still need `npm run container:check` on a working local Docker setup. The README task stays unchecked until that succeeds.

With Docker Engine and Compose/buildx available, the intended local startup is:

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

The key is not baked into the image, passed through default Compose configuration or printed in application logs. Optional `TABLELOOM_HOST_KEY` injection requires your own Compose override/environment mapping; supplying it bypasses generated-key loading. Bind mounts also require administrator-prepared write ownership for UID/GID 1000 and a private key file; the application does not start as root to repair ownership. The default named-volume initialization/ownership remains part of the pending engine verification.

`docker compose stop` shuts down the service, and ordinary `docker compose down` retains its named volume. Rebuild/recreate with `docker compose up --build -d` to reuse that data. Do not remove the volume during an upgrade. Backup/restore commands are available below; automatic downgrade and container-specific recovery verification remain pending. Keep the data volume and host key safe. The container health probe reads `/api/health` through loopback and checks the protocol version; it does not log credentials or mutate data, and it is not a complete database-integrity check.

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

The compiled commands are also included in the Docker image as `node apps/server/dist/backup-cli.js backup|verify|restore`. Actual container/mount recovery is still unverified while the local Docker engine is unavailable. Supply separate appropriately owned backup/recovery mounts and explicit paths when testing that workflow; the standard container check remains open in README.
