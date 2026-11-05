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

The development server proxies `/api` and the WebSocket to Fastify on port 3001. The browser opens the campaign selected by its session and that campaign’s active scene. New invitations enter their own campaign; host setup/recovery opens the default campaign. Use the campaign name in the header to select/create a campaign, edit its settings as GM, or join another invitation under your existing identity. The campaign and active-scene headings update live. GMs can open **Manage scenes**, create an empty offstage scene, and review **Show scene to everyone** to move the whole campaign to it. Each scene retains its own drawings/tokens; campaign notes and rolls stay available. Save drafts before changing campaigns. In-memory note drafts survive scene changes, while unfinished canvas gestures/selection reset. SQLite data lives in `data/tableloom.sqlite` (ignored by Git).

```sh
npm run check       # strict types, tests, build, production smoke check
npm run build
npm start           # frontend + API on http://127.0.0.1:3001
```

Configuration: `PORT` (default `3001`), `HOST` (default `127.0.0.1`), `DATA_DIR` (default `./data`), optional `TABLELOOM_HOST_KEY` (32–512 characters, otherwise a random key is generated in a private `host-key` file), and optional `PUBLIC_ORIGIN` (the browser-facing HTTP(S) origin, without a path). For an HTTPS reverse proxy, set `PUBLIC_ORIGIN=https://your-table.example`; this enforces the configured origin and enables Secure session cookies without trusting forwarded headers. Development defaults to same-origin HTTP on loopback.

Only authenticated members can fetch or connect to the table. Everyone can draw, create tokens, and roll dice. Players can move, resize, and delete their own tokens and drawings (including text labels); the GM can edit every object and change the game system. The server assigns ownership to the creator; creation commands reject caller-supplied ownership. Older objects without a recorded owner stay under GM control until assigned. The GM can select **Manage ownership** below the cast list, choose a token/drawing/note and a current member, then review and confirm the transfer. Removed members cannot receive ownership. Assigning an object to the GM keeps it under GM control.

Scene objects are currently public to all table members. Before rolling, choose **Everyone at the table** or **You and the GM**. Private rolls are visible only to the roller and the GM; a GM's private rolls stay with the GM. The history marks private results explicitly. Public is the default, and already-recorded roll visibility cannot be changed. Sign-out/identity changes clear the local roll draft.

The **Notes** panel supports plain-text documents. **New** creates a private note visible to its owner and the GM; GM-owned private notes stay with the GM. Set **Who can read this?** to **Everyone at the table** and save to share a note. Other players can read shared notes; only the owner and GM can edit or delete them. Changing a note back to private removes it from other players' current/future views. Previously shared text may already have been read.

Note edits require **Save changes**. Unsaved drafts stay in memory when switching notes/tabs and through unrelated table updates; save before reloading or signing out. Clean editors follow remote saves. If another editor saves while you have a draft, your draft is retained and stale saves/deletes are blocked until you explicitly reload the latest version. Notes are limited to 100 per campaign, 120 characters per title, and 10,000 characters per body.

The GM can list members and unused codes, revoke codes, and remove players in **Invite & players**. Member/code lists never return saved bearer credentials; a newly issued code is displayed only in its issuing dialog. Removing a player immediately revokes their sessions and return codes. Their existing objects, notes, and rolls remain stored and available to the GM; removal does not reassign or publish them. A fresh invitation creates a different identity, even with the same name. The host cannot be removed. Backing up the private host key still needs a complete backup/recovery procedure. Module-backed documents have a separate API described below; character-sheet UI, rich text, attachments, and version history are not implemented yet.

Note transfers keep the saved content and visibility. A private note requires explicit confirmation before the new owner receives its full saved text and the previous player owner loses access. The GM always retains access. A public note stays readable by the table, but edit/delete rights move to the new owner. Transfers advance the note version, blocking stale edits/deletes; the review screen blocks confirmation if the note changes while being reviewed. Save drafts before transferring. Hidden notes and their local drafts disappear from the previous player’s current view; previously read content cannot be recalled. Dice results keep their original ownership and attribution. Ownership transfers have no dedicated history or undo yet.

