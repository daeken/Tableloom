import { SceneMapDialog } from "./SceneMapDialog.js";
import { AssetLibraryDialog } from "./AssetLibraryDialog.js";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  Dice5,
  Eraser,
  FileText,
  Hand,
  Layers2,
  MousePointer2,
  Pencil,
  Plus,
  Square,
  Type,
  Users,
  X,
} from "lucide-react";
import { manifest as cyberpunk } from "@tableloom/cyberpunk-red";
import { manifest as bikes } from "@tableloom/kids-on-bikes";
import { manifest as brooms } from "@tableloom/kids-on-brooms";
import { SystemPanel as CyberpunkPanel } from "@tableloom/cyberpunk-red/client";
import { SystemPanel as BikesPanel } from "@tableloom/kids-on-bikes/client";
import { SystemPanel as BroomsPanel } from "@tableloom/kids-on-brooms/client";
import { parseDice } from "@tableloom/core";
import type { RollVisibility } from "@tableloom/core";
import { Tabletop } from "./Tabletop.js";
import type { Tool } from "./Tabletop.js";
import { useTable } from "./useTable.js";
import { useAccess, accessRequest } from "./useAccess.js";
import { AccessGate } from "./AccessGate.js";
import { InviteDialog } from "./InviteDialog.js";
import { OwnershipDialog } from "./OwnershipDialog.js";
import { CampaignDialog } from "./CampaignDialog.js";
import { RollHistoryDialog } from "./RollHistoryDialog.js";
import { SceneDialog } from "./SceneDialog.js";
import { contextKey } from "@tableloom/core/campaigns";
import { SceneHistoryControls } from "./SceneHistoryControls.js";
import { CommandStatus } from "./CommandStatus.js";
import { NotesPanel } from "./NotesPanel.js";
import { accessStatusSchema } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";

const modules = [cyberpunk, bikes, brooms];
const panels = {
  "cyberpunk-red": CyberpunkPanel,
  "kids-on-bikes": BikesPanel,
  "kids-on-brooms": BroomsPanel,
};
const tools = [
  { id: "select", label: "Select & move objects", Icon: MousePointer2 },
  { id: "hand", label: "Pan the table", Icon: Hand },
  { id: "pen", label: "Freehand drawing", Icon: Pencil },
  { id: "rectangle", label: "Draw a room", Icon: Square },
  { id: "text", label: "Place a text label", Icon: Type },
  { id: "token", label: "Place a token", Icon: Circle },
  { id: "erase", label: "Delete an object", Icon: Eraser },
] as const;
const colors = ["#405f4d", "#b45f4e", "#627d9c", "#a27a44", "#8c6c9c"];

export function App() {
  const { access, error: accessError, refresh, accept } = useAccess();
  const member = access?.member ?? null;
  const name = member?.name ?? null;
  const viewerKey = member
    ? `${member.id}:${member.tableId}:${member.role}`
    : null;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [ownershipOpen, setOwnershipOpen] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(colors[0]!);
  const [tokenName, setTokenName] = useState("Adventurer");
  const emptyDraft = {
    viewerKey,
    expression: "2d6",
    visibility: "public" as RollVisibility,
  };
  const [draft, setDraft] = useState(emptyDraft);
  const currentDraft = draft.viewerKey === viewerKey ? draft : emptyDraft;
  const expression = currentDraft.expression;
  const rollVisibility = currentDraft.visibility;
  const setExpression = (value: string) =>
    setDraft({ ...currentDraft, expression: value });
  const setRollVisibility = (value: RollVisibility) =>
    setDraft({ ...currentDraft, visibility: value });
  const [rollError, setRollError] = useState("");
  const [tab, setTab] = useState<"rolls" | "game" | "notes">("rolls");
  const [copied, setCopied] = useState(false);
  const table = useTable(viewerKey, refresh, member?.tableId ?? null);
  const { status, participants, error, clearError, send } = table;
  const state = member ? table.state : null;
  const connected = status === "connected";
  const sceneEditPending = table.deliveries.some(
    (item) =>
      item.status === "pending" &&
      [
        "token.add",
        "drawing.add",
        "drawing.resize",
        "drawing.text.update",
        "drawing.style.update",
        "drawing.reorder",
        "drawing.layer.update",
        "token.reorder",
        "token.resize",
        "objects.resize",
        "token.move",
        "tokens.move",
        "objects.move",
        "object.delete",
        "objects.delete",
        "object.assign",
        "scene.undo",
        "scene.redo",
      ].includes(item.type),
  );
  const currentModule =
    modules.find((m) => m.id === state?.systemId) ?? cyberpunk;
  const Panel = panels[currentModule.id as keyof typeof panels];
  useEffect(() => {
    setDraft({ viewerKey, expression: "2d6", visibility: "public" });
    setRollError("");
    setCampaignOpen(false);
    setSceneOpen(false);
    setHistoryOpen(false);
    setInviteOpen(false);
    setOwnershipOpen(false);
    setAssetsOpen(false);
    setMapOpen(false);
  }, [viewerKey]);

  async function logout() {
    try {
      accept(await accessRequest("/api/access/logout", accessStatusSchema, {}));
      setInviteOpen(false);
      setOwnershipOpen(false);
    } catch (err) {
      setRollError(err instanceof Error ? err.message : "Unable to sign out.");
    }
  }
  function roll(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const value = override ?? expression;
    try {
      parseDice(value);
      setRollError("");
      send({
        type: "dice.roll",
        expression: value,
        visibility: rollVisibility,
      });
    } catch (err) {
      setRollError(err instanceof Error ? err.message : "Check your roll.");
    }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setRollError(
        "Copy the page address from your browser to share this table.",
      );
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Tableloom home">
          <span className="brand-mark">
            <Layers2 size={22} strokeWidth={1.7} />
          </span>
          <span>
            tableloom<span className="brand-period">.</span>
          </span>
        </a>
        <span className="header-divider" />
        <button
          className="table-name campaign-picker"
          disabled={!member}
          aria-label="Choose campaign"
          onClick={() => setCampaignOpen(true)}
        >
          {table.campaignName || "Campaigns"} <ChevronDown size={12} />
        </button>
        <span className="prototype-badge">EARLY ACCESS</span>
        <div className="header-actions">
          <span className={`connection ${connected ? "online" : ""}`}>
            <span className="live-dot" />
            {!member
              ? "Sign in to join"
              : connected
                ? "Connected to table"
                : status === "blocked"
                  ? "Reload required"
                  : status === "offline"
                    ? "Reconnecting…"
                    : "Connecting…"}
          </span>
          <button
            className="invite-button"
            disabled={!member}
            onClick={() =>
              member?.role === "gm" ? setInviteOpen(true) : void copyLink()
            }
          >
            {copied ? <Check size={15} /> : <Users size={15} />}
            {member?.role === "gm"
              ? "Invite & players"
              : copied
                ? "Link copied"
                : "Copy table link"}
          </button>
          {member && status === "blocked" && (
            <button className="sign-out" onClick={() => location.reload()}>
              Reload page
            </button>
          )}
          {member && (
            <button className="sign-out" onClick={() => void logout()}>
              Sign out
            </button>
          )}
          <div className="avatar" title={name ?? "Guest"}>
            {name?.slice(0, 1).toUpperCase() ?? "?"}
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-rail">
          <div className="rail-heading">
            <span className="eyebrow">THE TABLE</span>
            <span className="chapter-number">01</span>
          </div>
          <div className="scene-card" aria-label="Current scene">
            <span className="scene-art">
              <span className="scene-room room-one" />
              <span className="scene-room room-two" />
              <span className="scene-path" />
              <span className="scene-pin" />
            </span>
            <span className="scene-caption">
              <span>
                <strong>{table.sceneName || "The gathering place"}</strong>
                <small>Your shared battlefield</small>
              </span>
              <span className="scene-active" />
            </span>
          </div>
          {member?.role === "gm" && table.context && (
            <button
              className="add-cast manage-scenes"
              onClick={() => setSceneOpen(true)}
            >
              Manage scenes
            </button>
          )}
          {member?.role === "gm" && (
            <button
              className="add-cast manage-scenes"
              onClick={() => setAssetsOpen(true)}
            >
              Map assets
            </button>
          )}
          {member?.role === "gm" && table.context && (
            <button
              className="add-cast manage-scenes"
              disabled={!connected}
              onClick={() => setMapOpen(true)}
            >
              Scene map
            </button>
          )}
          <div className="rail-section">
            <span className="eyebrow">GAME SYSTEM</span>
            <div className="system-select">
              <span
                className="system-color"
                style={{ background: currentModule.accent }}
              />
              <select
                aria-label="Game system"
                disabled={!connected || member?.role !== "gm"}
                title={
                  member?.role === "gm"
                    ? "Choose the game system"
                    : "Only the GM can change the game system"
                }
                value={currentModule.id}
                onChange={(e) =>
                  send({ type: "system.set", systemId: e.target.value })
                }
              >
                {modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <p className="rail-note">Every story plays a little differently.</p>
          </div>
          <div className="rail-section cast-section">
            <div className="section-row">
              <span className="eyebrow">ON THE TABLE</span>
              <span className="count">{state?.tokens.length ?? 0}</span>
            </div>
            {!state?.tokens.length ? (
              <p className="rail-note">
                A cast of characters,
                <br />
                waiting to arrive.
              </p>
            ) : (
              <div className="cast-list">
                {state.tokens.map((token) => (
                  <div className="cast-member" key={token.id}>
                    <span
                      className="token-mini"
                      style={{ background: token.color }}
                    >
                      {token.name.slice(0, 1)}
                    </span>
                    <span>{token.name}</span>
                    <button
                      aria-label={`Delete ${token.name}`}
                      disabled={!connected || !canEditObject(member, token)}
                      title={
                        canEditObject(member, token)
                          ? "Delete token"
                          : "Only the owner or GM can delete this token"
                      }
                      onClick={() =>
                        send({
                          type: "object.delete",
                          objectId: token.id,
                          expectedVersion: token.version,
                        })
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button className="add-cast" onClick={() => setTool("token")}>
              <Plus size={14} /> Place a token
            </button>
            {member?.role === "gm" && state && (
              <button
                className="add-cast"
                onClick={() => {
                  clearError();
                  setOwnershipOpen(true);
                }}
              >
                Manage ownership
              </button>
            )}
          </div>
          <div className="rail-footer">
            <span className="small-spark">✧</span>
            <p>
              Good stories start
              <br />
              with good company.
            </p>
            <span className="version">TABLELOOM / 0.1</span>
          </div>
        </aside>

        <main className="main-table">
          <div className="table-heading">
            <div>
              <span className="eyebrow">A PLACE TO MAKE BELIEVE</span>
              <h1>
                {table.sceneName || "The gathering place"}
                <span>.</span>
              </h1>
            </div>
            <div className="table-presence">
              <Users size={15} />
              <span>{participants} at the table</span>
            </div>
          </div>
          <SceneHistoryControls
            history={table.history}
            enabled={connected}
            pending={sceneEditPending}
            send={send}
          />
          <CommandStatus deliveries={table.deliveries} />
          <div className="canvas-frame">
            {state ? (
              <Tabletop
                key={
                  table.context
                    ? `${viewerKey}:${contextKey(table.context)}`
                    : viewerKey
                }
                member={member}
                state={state}
                background={table.background}
                campaignId={member?.tableId ?? ""}
                sceneId={table.context?.sceneId ?? ""}
                tool={tool}
                color={color}
                tokenName={tokenName}
                enabled={connected}
                pending={sceneEditPending}
                send={send}
              />
            ) : (
              <div className="table-loading">Setting a place for you…</div>
            )}
            <div className="toolbar" role="toolbar" aria-label="Drawing tools">
              {tools.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  title={label}
                  aria-label={label}
                  aria-pressed={tool === id}
                  className={tool === id ? "active" : ""}
                  onClick={() => setTool(id)}
                >
                  <Icon size={19} strokeWidth={1.7} />
                </button>
              ))}
              <span className="tool-divider" />
              <div className="color-options">
                {colors.map((c) => (
                  <button
                    key={c}
                    className={`color-swatch ${color === c ? "selected" : ""}`}
                    style={{ background: c }}
                    aria-label={`Use ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
            {tool === "token" && (
              <div className="token-options">
                <label htmlFor="token-name">Token name</label>
                <input
                  id="token-name"
                  maxLength={32}
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                />
                <span>Click the table to place</span>
              </div>
            )}
          </div>
          <footer className="table-footer">
            <span>
              <span className="keyboard-hint">↖</span>
              {tool === "select"
                ? "Shift-click to select several · Drag to move"
                : tool === "hand"
                  ? "Drag to explore the table"
                  : tool === "pen"
                    ? "Drag to sketch something"
                    : tool === "text"
                      ? "Click to place a shared text label"
                      : tool === "rectangle"
                        ? "Drag to draw a room"
                        : tool === "erase"
                          ? "Click a token or drawing edge to remove it"
                          : "Click to place your token"}
            </span>
            <span>
              Scroll to zoom <span className="footer-dot">·</span> Made for your
              imagination
            </span>
          </footer>
        </main>

        <aside className="right-rail">
          <div className="panel-tabs">
            <button
              className={tab === "rolls" ? "active" : ""}
              onClick={() => setTab("rolls")}
            >
              <Dice5 size={16} /> Dice &amp; rolls
            </button>
            <button
              className={tab === "game" ? "active" : ""}
              onClick={() => setTab("game")}
            >
              <Layers2 size={16} /> Your game
            </button>
            <button
              className={tab === "notes" ? "active" : ""}
              onClick={() => setTab("notes")}
            >
              <FileText size={16} /> Notes
            </button>
          </div>
          {member && state && (
            <NotesPanel
              key={viewerKey}
              active={tab === "notes"}
              notes={state.notes}
              deliveries={table.deliveries}
              member={member}
              enabled={connected}
              send={send}
            />
          )}
          {tab === "game" ? (
            <Panel />
          ) : tab === "rolls" ? (
            <>
              <section className="dice-section">
                <span className="eyebrow">LET FATE HAVE A SAY</span>
                <h2>A roll of the dice.</h2>
                <p className="muted">A little uncertainty goes a long way.</p>
                <form onSubmit={roll}>
                  <label htmlFor="roll-visibility">Who sees this roll?</label>
                  <select
                    id="roll-visibility"
                    className="roll-visibility"
                    value={rollVisibility}
                    onChange={(event) =>
                      setRollVisibility(
                        event.target.value === "gm" ? "gm" : "public",
                      )
                    }
                  >
                    <option value="public">Everyone at the table</option>
                    <option value="gm">You and the GM</option>
                  </select>
                  <label htmlFor="dice-expression">Dice expression</label>
                  <div className="roll-input">
                    <Dice5 size={19} />
                    <input
                      id="dice-expression"
                      value={expression}
                      maxLength={32}
                      onChange={(e) => setExpression(e.target.value)}
                      placeholder="2d6 + 3"
                      autoComplete="off"
                    />
                    <button
                      type="submit"
                      disabled={!connected}
                      aria-label="Roll dice"
                    >
                      <ArrowUpRight size={19} />
                    </button>
                  </div>
                </form>
                <div className="quick-dice">
                  {["d4", "d6", "d8", "d10", "d12", "d20"].map((die) => (
                    <button
                      key={die}
                      disabled={!connected}
                      onClick={() => {
                        setExpression(die);
                        roll(undefined, die);
                      }}
                    >
                      {die}
                    </button>
                  ))}
                </div>
                {rollError && (
                  <p className="inline-error" role="alert">
                    {rollError}
                  </p>
                )}
              </section>
              <section className="roll-history">
                <button
                  className="history-manage"
                  disabled={!member || !connected}
                  onClick={() => setHistoryOpen(true)}
                >
                  Manage roll history
                </button>
                <div className="section-row">
                  <span className="eyebrow">THE EVENING'S ROLLS</span>
                  <span className="count">{state?.rolls.length ?? 0}</span>
                </div>
                {!state?.rolls.length ? (
                  <div className="empty-rolls">
                    <Dice5 size={31} strokeWidth={1} />
                    <p>
                      The dice are quiet.
                      <br />
                      <span>Give them something to say.</span>
                    </p>
                  </div>
                ) : (
                  <ol aria-live="polite">
                    {[...(state?.rolls ?? [])].reverse().map((result) => (
                      <li key={result.id}>
                        <div className="roll-meta">
                          <strong>{result.actor}</strong>
                          <time dateTime={result.at}>
                            {new Date(result.at).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                        <div className="roll-result">
                          <div>
                            <span className="roll-expression">
                              {result.expression}
                            </span>
                            {result.visibility === "gm" && (
                              <span className="roll-private">Private roll</span>
                            )}
                            <p className="roll-breakdown">
                              [{result.dice.join(", ")}]
                              {result.modifier
                                ? ` ${result.modifier > 0 ? "+" : "−"} ${Math.abs(result.modifier)}`
                                : ""}
                            </p>
                          </div>
                          <span className="roll-total">{result.total}</span>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <div className="dice-footnote">
                <span className="live-dot" /> Rolled together. Saved to your
                table.
              </div>
            </>
          ) : null}
        </aside>
      </div>
      {error && (
        <div className="error-toast" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={clearError}>
            <X size={16} />
          </button>
        </div>
      )}
      {!member && (
        <AccessGate
          key={access?.setupRequired ? "setup" : "join"}
          access={access}
          connectionError={accessError}
          refresh={refresh}
          accept={accept}
        />
      )}
      {campaignOpen && member && (
        <CampaignDialog
          key={viewerKey}
          member={member}
          modules={modules}
          accept={accept}
          close={() => setCampaignOpen(false)}
        />
      )}
      {mapOpen && member?.role === "gm" && table.context && (
        <SceneMapDialog
          key={`${viewerKey}:${contextKey(table.context)}`}
          context={table.context}
          version={table.backgroundVersion}
          enabled={connected}
          close={() => setMapOpen(false)}
        />
      )}
      {assetsOpen && member?.role === "gm" && (
        <AssetLibraryDialog
          key={viewerKey}
          campaignId={member.tableId}
          close={() => setAssetsOpen(false)}
        />
      )}
      {sceneOpen && member?.role === "gm" && table.context && (
        <SceneDialog
          key={viewerKey}
          context={table.context}
          enabled={connected}
          close={() => setSceneOpen(false)}
        />
      )}
      {ownershipOpen && member?.role === "gm" && state && (
        <OwnershipDialog
          key={viewerKey}
          state={state}
          enabled={connected}
          send={send}
          error={error}
          clearError={clearError}
          close={() => setOwnershipOpen(false)}
        />
      )}
      {historyOpen && member && state && (
        <RollHistoryDialog
          key={viewerKey}
          member={member}
          rolls={state.rolls}
          enabled={connected}
          close={() => setHistoryOpen(false)}
        />
      )}
      {inviteOpen && member?.role === "gm" && (
        <InviteDialog close={() => setInviteOpen(false)} />
      )}
    </div>
  );
}
