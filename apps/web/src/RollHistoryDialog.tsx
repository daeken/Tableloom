import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Roll } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { canManageRoll } from "@tableloom/core/permissions";
import {
  rollArchivePageSchema,
  rollHistoryResultSchema,
} from "@tableloom/core/roll-history";
import type { z } from "zod";
import { accessRequest } from "./useAccess.js";

type Page = z.infer<typeof rollArchivePageSchema>;
export function RollHistoryDialog({
  member,
  rolls,
  enabled,
  close,
}: {
  member: Member;
  rolls: Roll[];
  enabled: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    reads = useRef(0);
  const [source, setSource] = useState<"live" | "archive">("live");
  const [page, setPage] = useState<Page>({ entries: [], next: null });
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<{
    ids: string[];
    source: "live" | "archive";
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const root = `/api/campaigns/${member.tableId}/rolls`;
  const visible =
    source === "live"
      ? [...rolls].reverse()
      : page.entries.map((entry) => entry.roll);
  const eligible = visible.filter((roll) => canManageRoll(member, roll));
  const stale =
    review?.source === "live" &&
    review.ids.some((id) => !rolls.some((roll) => roll.id === id));
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      ++reads.current;
      element?.close();
    };
  }, []);
  async function load(after?: string) {
    const sequence = ++reads.current;
    const result = await accessRequest(
      `${root}/archive?limit=50${after ? `&after=${after}` : ""}`,
      rollArchivePageSchema,
    );
    if (sequence === reads.current) {
      setPage(result);
      setCursor(after);
      setSelected([]);
      setReview(null);
    }
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to manage history.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function change(
    ids: string[],
    operation: "archive" | "delete",
    from: "live" | "archive",
  ) {
    const result = await accessRequest(
      `${root}/${from === "archive" ? "archive/delete" : operation}`,
      rollHistoryResultSchema,
      { ids },
    );
    setSelected([]);
    setReview(null);
    if (from === "archive") await load(cursor);
    setMessage(
      `${result.affected} ${result.affected === 1 ? "roll" : "rolls"} ${operation === "archive" ? "archived" : "deleted"}.`,
    );
  }
  return (
    <dialog
      ref={dialog}
      className="join-card invite-dialog access-management campaign-dialog roll-management"
      onCancel={close}
      aria-labelledby="roll-history-title"
    >
      <button
        className="dialog-close"
        onClick={close}
        aria-label="Close roll history"
      >
        <X size={17} />
      </button>
      <span className="eyebrow">DICE HISTORY</span>
      <h1 id="roll-history-title">Keep the story moving.</h1>
      <p>
        Archive results to keep them outside the live history. Private rolls
        keep their audience. Players manage their own private rolls; the GM
        manages all results.
      </p>
      <p className="muted">
        Live history keeps the latest 100 results per audience. Older results
        drop off unless you archive them first. Archives hold up to 10,000
        results per campaign.
      </p>
      <div className="history-actions">
        <button
          disabled={busy || !enabled}
          aria-pressed={source === "live"}
          onClick={() => {
            setSource("live");
            setSelected([]);
            setReview(null);
            setMessage("");
          }}
        >
          Live history
        </button>
        <button
          disabled={busy || !enabled}
          aria-pressed={source === "archive"}
          onClick={() =>
            void act(async () => {
              await load();
              setSource("archive");
            })
          }
        >
          Browse archive
        </button>
      </div>
      <p>
        {source === "live" ? "Live results, newest first" : "Archived results"}.
        Select up to 100 results.
      </p>
      <div className="history-actions">
        <button
          disabled={busy || !enabled || eligible.length === 0}
          onClick={() => {
            setSelected(eligible.slice(0, 100).map((roll) => roll.id));
            setReview(null);
          }}
        >
          Select rolls you can manage
        </button>
        <button
          disabled={busy || !selected.length}
          onClick={() => {
            setSelected([]);
            setReview(null);
          }}
        >
          Clear selection
        </button>
      </div>
      <ul className="access-list history-results">
        {visible.map((roll) => (
          <li key={roll.id}>
            <label className="history-choice">
              <input
                type="checkbox"
                checked={selected.includes(roll.id)}
                disabled={
                  busy ||
                  !enabled ||
                  !canManageRoll(member, roll) ||
                  (!selected.includes(roll.id) && selected.length >= 100)
                }
                onChange={(event) => {
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, roll.id]
                      : current.filter((id) => id !== roll.id),
                  );
                  setReview(null);
                }}
              />
              <span>
                <strong>
                  {roll.actor}: {roll.expression} = {roll.total}
                </strong>
                <small>
                  {new Date(roll.at).toLocaleString()} ·{" "}
                  {roll.visibility === "gm" ? "Private" : "Public"}
                </small>
                <small>
                  [{roll.dice.join(", ")}]
                  {roll.modifier
                    ? ` ${roll.modifier > 0 ? "+" : "−"} ${Math.abs(roll.modifier)}`
                    : ""}
                </small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {visible.length === 0 && <p>No results on this page.</p>}
      {source === "archive" && (
        <div className="history-actions">
          <button
            disabled={busy || !enabled}
            onClick={() => void act(() => load())}
          >
            First page / refresh
          </button>
          <button
            disabled={busy || !enabled || !page.next}
            onClick={() => void act(() => load(page.next ?? undefined))}
          >
            Next page
          </button>
        </div>
      )}
      <div className="history-actions">
        {source === "live" && (
          <button
            disabled={busy || !enabled || !selected.length}
            onClick={() => void act(() => change(selected, "archive", source))}
          >
            Archive selected ({selected.length})
          </button>
        )}
        <button
          disabled={busy || !enabled || !selected.length}
          onClick={() => setReview({ ids: [...selected], source })}
        >
          Delete selected…
        </button>
      </div>
      {review && (
        <section
          className="ownership-review"
          aria-label="Confirm roll deletion"
        >
          <h2>Delete {review.ids.length} results permanently?</h2>
          <p>
            These selected {review.source === "live" ? "live" : "archived"}{" "}
            results will be removed for everyone who could read them. There is
            no undo.
          </p>
          {stale && (
            <p role="alert">
              The selected live history changed. Clear the selection and review
              again.
            </p>
          )}
          <button
            className="join-button"
            disabled={busy || !enabled || stale}
            onClick={() =>
              void act(() => change(review.ids, "delete", review.source))
            }
          >
            Permanently delete results
          </button>
          <button
            className="access-switch"
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Keep results
          </button>
        </section>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
