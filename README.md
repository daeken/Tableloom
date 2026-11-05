# Tableloom

A self-hosted, web-based virtual tabletop for RPG campaigns: working character sheets, good dice, and a battlefield you can sketch as quickly as a whiteboard.

The goal is support for **any game system** through independently versioned code modules. The first targets are **Cyberpunk RED**, **Kids on Bikes**, and **Kids on Brooms**. Agents will build the modules; a visual rules builder is not a goal.

## Current state

The platform already supports authenticated campaigns, invitations and returning players; GM/player permissions; multiple scenes; drawings, tokens, text, maps, layers and undo/redo; server-side dice with private rolls; notes, chat, named presence and optional shared cursors. Compact controls and keyboard shortcuts are available.

**Early development:** game modules are scaffolds. Playable character sheets, published rules, items and powers are not implemented yet. Rulebook work is waiting for source PDFs. Touch/accessibility, performance and deployment/recovery tooling still need work.

## Run locally

Requires **Node.js 24** and npm. No external database or account is needed.

```sh
npm ci
npm run dev
```

Open [localhost:5173](http://localhost:5173). Set up the host with the private key in `data/host-key`, then use **Invite & players** to invite friends. Data lives in `data/tableloom.sqlite`; the development API runs on port 3001.

For a production build:

```sh
npm run check       # strict types, tests, builds and production smoke check
npm run build
npm start           # http://127.0.0.1:3001
```

Use `HOST`, `PORT`, `DATA_DIR`, `TABLELOOM_HOST_KEY` and `PUBLIC_ORIGIN` to configure hosting. See the [usage and hosting guide](docs/user-guide.md) for sessions, recovery, permissions, private content and configuration.

## Stack and design

TypeScript throughout: React/Vite and PixiJS in the browser, Fastify/WebSockets on the server, and SQLite for local persistence. The server owns saved state and dice outcomes. Core concepts stay system-neutral; modules have separate shared, browser and server entry points.

- `apps/web` — application and battlefield
- `apps/server` — authenticated APIs, synchronization and persistence
- `packages/core` — validated neutral state, commands and dice
- `packages/module-sdk` — module/data/content contracts
- `systems/*` — separately versioned game modules

## Task list

This is the **single source of truth for goals and remaining work**. Work top to bottom within the next actionable milestone. Blocked tasks wait for their stated input; implementation details belong in the linked docs.

### Platform foundation

- [x] Build a strict TypeScript workspace with authoritative state, dice and SQLite persistence.
- [x] Add authenticated campaigns/scenes, invitations/recovery, ownership and filtered private content.
- [x] Build the shared drawing/token/map tools, selection, resizing, layers, grid, measurement and durable undo/redo.
- [x] Add reconnect/conflict handling, bounded transport, named presence, cursors and public/private chat.
- [x] Establish independently versioned module scaffolds and validated document/migration APIs.

### Make the tabletop comfortable

- [x] Restore compact campaign controls, fit the phone toolbar and add keyboard skip navigation.
- [x] Guard pointer gestures with one owner, second-contact cancellation and release-only tap actions.
- [ ] **Next:** audit dense selection controls and narrow dialogs; verify touch/pen behavior on real devices.
- [ ] Complete keyboard object workflows and screen-reader, contrast, zoom and mobile-keyboard checks.
- [ ] Measure canvas redraw/snapshot performance and split the initial frontend bundle.

### Make game modules playable

- [ ] Connect persisted module documents to custom character sheets and validated module actions.
- [ ] Add a module preview/test harness with worked rules examples.
- [ ] Load content packs with stable definitions, owned item instances and campaign homebrew overrides.
- [ ] **Needs PDFs:** inventory and implement Cyberpunk RED with edition/page references.
- [ ] **Needs PDFs:** inventory and implement Kids on Bikes and Kids on Brooms separately; extract shared code only where demonstrated.
- [ ] Run character creation, sheet editing, rolls and resource updates in two structurally different systems without changing core.

### Make self-hosting dependable

- [ ] Add a multi-stage Docker image, Compose setup, persistent volume and non-root runtime.
- [ ] Add consistent database/asset backup and restore, with tested recovery.
- [ ] Add CI for clean install, strict checks, tests and builds.
- [ ] Document reverse proxy/HTTPS, upgrades, trusted-module installation and campaign export/import.
- [ ] Playtest a complete campaign session with a real group and fix workflow friction.
- [ ] **After playtest feedback:** add note history/trash and richer document content.

## Documentation and contributing

- [Usage and hosting](docs/user-guide.md) — running a table, access, recovery and privacy
- [Platform reference](docs/platform.md) — architecture, tools, APIs, limits and upgrade behavior
- [Development history](docs/progress.md) — detailed changes and verification results
- [Agent instructions](AGENTS.md) — repository workflow and constraints

Run `npm run check` before completing cross-cutting changes. Keep this README short: update task status and material scope changes here, and put detailed implementation notes in `docs/`. The existing five-minute build automation follows this task list; completed verified increments are committed and pushed to the current branch.

## License

[MIT](LICENSE). Game names indicate intended compatibility; published game content is not included.
