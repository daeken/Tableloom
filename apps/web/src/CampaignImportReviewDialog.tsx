import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  CampaignImportReviewClient,
  emptyImportReview,
  reviewedChoiceCount,
  mergedChoices,
  buildReviewPlan,
} from "./campaign-import-review-client.js";
import type { ImportChoice } from "./campaign-import-review-client.js";

const blockerLabels: Record<string, string> = {
  system_unavailable: "Install the exact game-system version used by the file.",
  system_changed: "The installed system differs from the file's pin.",
  system_incompatible: "The installed game system is incompatible.",
  content_pack_unavailable: "A required content pack is not installed.",
  content_pack_changed: "A required content pack has different contents.",
  content_pack_incompatible:
    "A content pack is incompatible with this game system.",
  stored_pack_binding_changed:
    "A content-pack fingerprint conflicts with this server's saved binding.",
  campaign_capacity_reached: "This server has reached its campaign limit.",
  document_schema_unavailable:
    "The required character-record schema is unavailable.",
  instance_schema_unavailable:
    "The required owned-content schema is unavailable.",
  content_definition_unavailable:
    "A referenced content definition is unavailable.",
  module_transfer_unavailable:
    "A required module transfer declaration is unavailable.",
  identity_merge_acknowledgement_required:
    "Confirm the combined identities before continuing.",
  import_member_capacity_reached: "The proposed campaign has too many members.",
  source_or_ownership_review_incomplete:
    "Finish the file and ownership review first.",
  candidate_mapping_failed:
    "The proposed resource mapping could not be completed.",
  mapped_storage_limits_exceeded:
    "The proposed ownership mapping exceeds saved-data limits.",
  mapped_campaign_invalid: "The mapped records or history are inconsistent.",
  mapped_campaign_unavailable:
    "The mapped campaign needs compatible modules or updated destination state.",
};
function Blockers({ items }: { items: string[] }) {
  return items.length ? (
    <div role="status">
      <p>These checks need attention:</p>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}:${index}`}>
            {blockerLabels[item] ??
              "An additional validation check needs attention. Review installed modules and destination capacity."}
          </li>
        ))}
      </ul>
    </div>
  ) : null;
}
export function CampaignImportReviewDialog({
  close,
  saved,
  openCampaign,
}: {
  close: () => void;
  saved: () => void;
  openCampaign: (id: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    resultHeading = useRef<HTMLHeadingElement>(null),
    savedCallback = useRef(saved),
    [view, setView] = useState(emptyImportReview),
    [client] = useState(
      () =>
        new CampaignImportReviewClient(
          (path, init) => fetch(path, init),
          setView,
        ),
    ),
    [query, setQuery] = useState(""),
    [sourcePage, setSourcePage] = useState(0),
    [opening, setOpening] = useState(false),
    [openError, setOpenError] = useState("");
  useEffect(() => {
    const element = dialog.current,
      trigger = document.activeElement;
    element?.showModal();
    client.start();
    void client.loadPeople();
    return () => {
      client.stop();
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, [client]);
  savedCallback.current = saved;
  useEffect(() => {
    if (view.result) {
      savedCallback.current();
      resultHeading.current?.focus();
    }
  }, [view.result]);
  useEffect(() => {
    setSourcePage(0);
  }, [view.inspection]);
  useEffect(() => {
    if (!view.file && view.busy !== "file" && fileInput.current)
      fileInput.current.value = "";
  }, [view.file, view.busy]);
  const locked = !!view.busy || view.execution !== "idle",
    inspection = view.inspection,
    subjects = inspection?.ownership.subjects ?? [],
    count = reviewedChoiceCount(view),
    merges = mergedChoices(view),
    plan = buildReviewPlan(view),
    choicesReady =
      !!inspection &&
      !inspection.blockers.length &&
      inspection.moduleReferenceValidation.complete &&
      count === subjects.length,
    people = view.host
      ? [view.host, ...view.people.filter((p) => p.id !== view.host!.id)]
      : [];
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog access-management campaign-import-dialog"
      aria-labelledby="import-review-title"
      aria-describedby="import-review-scope"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        autoFocus
        type="button"
        className="dialog-close"
        aria-label="Close import review"
        onClick={close}
      >
        <X size={18} />
      </button>
      <h1 id="import-review-title">Review a campaign import</h1>
      <p id="import-review-scope">
        Only the server host can import files. Review private content and
        ownership before confirming a separate new campaign. Retrying the exact
        same file recovers its saved result instead of creating another copy.
      </p>
      {view.error && (
        <p role="alert" className="inline-error">
          {view.error}
        </p>
      )}
      {view.busy && (
        <p role="status">
          {view.busy === "people"
            ? "Loading local people…"
            : view.busy === "file"
              ? "Reading selected file…"
              : view.busy === "inspect"
                ? "Inspecting private file and images…"
                : view.busy === "ownership"
                  ? "Checking ownership choices…"
                  : view.busy === "candidate"
                    ? "Validating the mapped campaign…"
                    : view.busy === "status"
                      ? "Checking the saved import result…"
                      : "Creating the imported campaign…"}
        </p>
      )}
      {view.execution === "idle" && (
        <>
          <section
            className="access-section"
            aria-labelledby="import-file-title"
          >
            <h2 id="import-file-title">1. Inspect a private file</h2>
            <p>
              The file can contain unrevealed maps, private notes and chat,
              character records and history. Keep it private. The entire file
              will be sent to this server only after you confirm inspection.
            </p>
            <label htmlFor="import-campaign-file">
              Campaign export file (up to 32 MiB)
            </label>
            <input
              ref={fileInput}
              id="import-campaign-file"
              type="file"
              accept=".json,application/json"
              disabled={locked || !view.host}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void client.selectFile(file);
              }}
            />
            {view.file && (
              <p>
                Selected: <strong>{view.file.name}</strong> ·{" "}
                {(view.file.bytes / 1024).toFixed(1)} KiB
              </p>
            )}
            <label className="transfer-consent">
              <input
                type="checkbox"
                disabled={locked || !view.file}
                checked={view.uploadConsent}
                onChange={(event) =>
                  client.acknowledgeUpload(event.target.checked)
                }
              />
              <span>
                Allow this server to inspect all private content in this file.
              </span>
            </label>
            <button
              type="button"
              disabled={locked || !view.file || !view.uploadConsent}
              onClick={() => void client.inspect()}
            >
              Inspect private file
            </button>
          </section>
          {inspection && (
            <section
              className="access-section"
              aria-labelledby="import-inspection-title"
            >
              <h2 id="import-inspection-title">{inspection.campaign.name}</h2>
              <p>
                {inspection.resourceCounts.scene_records} scenes ·{" "}
                {inspection.resourceCounts.module_documents} character records ·{" "}
                {inspection.resourceCounts.campaign_assets} library images ·{" "}
                {subjects.length} source identities
              </p>
              <p>
                Game system: {inspection.packages.system.id} ·{" "}
                {inspection.packages.system.version} —{" "}
                {inspection.packages.system.status === "available"
                  ? "available"
                  : "needs attention"}
              </p>
              {!!inspection.packages.contentPacks.length && (
                <details>
                  <summary>
                    {inspection.packages.contentPacks.length} content-pack
                    checks
                  </summary>
                  <ul className="import-package-checks">
                    {inspection.packages.contentPacks.map((pack) => (
                      <li key={`${pack.id}@${pack.version}`}>
                        {pack.id} · {pack.version} —{" "}
                        {pack.status === "available"
                          ? "available"
                          : pack.status === "historical-only"
                            ? "historical reference"
                            : "needs attention"}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <Blockers items={inspection.blockers} />
              {!inspection.blockers.length && (
                <p role="status">
                  File checks passed. Ownership and mapped-data checks are still
                  required.
                </p>
              )}
            </section>
          )}
          {inspection && (
            <>
              <section
                className="access-section"
                aria-labelledby="import-local-people-title"
              >
                <h2 id="import-local-people-title">Find local people</h2>
                <p>
                  Choose people deliberately. Matching names or file IDs never
                  select a local person. The host ({view.host?.name}) will
                  independently be a GM.
                </p>
                <form
                  className="import-people-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void client.loadPeople(query);
                  }}
                >
                  <label htmlFor="import-people-query">
                    Name on this server
                  </label>
                  <input
                    id="import-people-query"
                    value={query}
                    maxLength={32}
                    disabled={locked}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div className="access-actions">
                    <button disabled={locked}>Find local people</button>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => {
                        setQuery("");
                        void client.loadPeople();
                      }}
                    >
                      Start of local list
                    </button>
                    {view.nextCursor && (
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          void client.loadPeople(
                            view.peopleQuery,
                            view.nextCursor!,
                          )
                        }
                      >
                        More local people
                      </button>
                    )}
                  </div>
                </form>
                <p>
                  Showing {view.people.length} local results. Selected people
                  stay selected when these results change. Profiles without
                  campaign membership are not listed.
                </p>
              </section>
              <form
                className="access-section"
                onSubmit={(event) => {
                  event.preventDefault();
                  void client.reviewOwnership();
                }}
              >
                <h2>2. Choose ownership and access</h2>
                <p>
                  Source roles below describe the file and grant no access.
                  Every identity needs a choice, including departed people. New
                  people receive no sign-in session or invitation. Unclaimed
                  attribution preserves ownership without giving anyone access.
                </p>
                <p role="status">
                  {count} of {subjects.length} identities have valid choices.
                </p>
                {subjects
                  .slice(sourcePage * 25, (sourcePage + 1) * 25)
                  .map((subject) => {
                    const choice = view.choices[subject.sourceId],
                      selected = choice?.kind === "existing" ? choice : null,
                      options =
                        selected?.userId &&
                        !people.some((p) => p.id === selected.userId)
                          ? [
                              { id: selected.userId, name: selected.label },
                              ...people,
                            ]
                          : people;
                    const patch = (fields: Partial<ImportChoice>) => {
                      if (choice)
                        client.choose(subject.sourceId, {
                          ...choice,
                          ...fields,
                        } as ImportChoice);
                    };
                    return (
                      <fieldset
                        key={subject.sourceId}
                        disabled={locked}
                        className="import-person-choice"
                      >
                        <legend>
                          {subject.name ?? "Departed or unnamed person"}
                        </legend>
                        <small>
                          Source ID: {subject.sourceId} · From file:{" "}
                          {subject.sourceRole === "gm"
                            ? "GM"
                            : subject.sourceRole === "player"
                              ? "player"
                              : "no current role"}
                        </small>
                        <label htmlFor={`import-choice-${subject.sourceId}`}>
                          Ownership choice
                        </label>
                        <select
                          id={`import-choice-${subject.sourceId}`}
                          value={choice?.kind ?? ""}
                          onChange={(event) =>
                            client.choose(
                              subject.sourceId,
                              event.target.value === "unclaimed"
                                ? { kind: "unclaimed" }
                                : event.target.value === "new"
                                  ? { kind: "new", name: "", role: "player" }
                                  : {
                                      kind: "existing",
                                      userId: "",
                                      role: "player",
                                      label: "",
                                    },
                            )
                          }
                        >
                          <option value="" disabled>
                            Choose for this identity…
                          </option>
                          <option value="unclaimed">
                            Keep attribution without access
                          </option>
                          <option value="new">Create a new person</option>
                          <option value="existing">
                            Choose an existing local person
                          </option>
                        </select>
                        {choice?.kind === "new" && (
                          <>
                            <label htmlFor={`import-name-${subject.sourceId}`}>
                              New person's name
                            </label>
                            <input
                              id={`import-name-${subject.sourceId}`}
                              value={choice.name}
                              maxLength={32}
                              onChange={(event) =>
                                patch({ name: event.target.value })
                              }
                            />
                          </>
                        )}
                        {selected && (
                          <>
                            <label
                              htmlFor={`import-person-${subject.sourceId}`}
                            >
                              Local person
                            </label>
                            <select
                              id={`import-person-${subject.sourceId}`}
                              value={selected.userId}
                              onChange={(event) =>
                                patch({ userId: event.target.value })
                              }
                            >
                              <option value="" disabled>
                                Choose a local person…
                              </option>
                              {options.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} · {p.id.slice(0, 8)}
                                  {p.id === view.host?.id ? " (host)" : ""}
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                        {choice && choice.kind !== "unclaimed" && (
                          <>
                            <label htmlFor={`import-role-${subject.sourceId}`}>
                              Role in the new campaign
                            </label>
                            <select
                              id={`import-role-${subject.sourceId}`}
                              disabled={
                                !!selected &&
                                (!selected.userId ||
                                  selected.userId === view.host?.id)
                              }
                              value={choice.role}
                              onChange={(event) =>
                                patch({
                                  role: event.target.value as "gm" | "player",
                                })
                              }
                            >
                              <option value="player">Player</option>
                              <option value="gm">
                                GM — can see all campaign content
                              </option>
                            </select>
                          </>
                        )}
                        {selected?.userId === view.host?.id && (
                          <p>The server host always remains a GM.</p>
                        )}
                      </fieldset>
                    );
                  })}
                {subjects.length > 25 && (
                  <div
                    className="access-actions"
                    aria-label="Source identity pages"
                  >
                    <button
                      type="button"
                      disabled={locked || sourcePage === 0}
                      onClick={() => setSourcePage((value) => value - 1)}
                    >
                      Previous identities
                    </button>
                    <span>
                      Page {sourcePage + 1} of {Math.ceil(subjects.length / 25)}
                    </span>
                    <button
                      type="button"
                      disabled={
                        locked || (sourcePage + 1) * 25 >= subjects.length
                      }
                      onClick={() => setSourcePage((value) => value + 1)}
                    >
                      Next identities
                    </button>
                  </div>
                )}
                {!!merges.length && (
                  <label className="transfer-consent">
                    <input
                      type="checkbox"
                      checked={view.mergeConsent}
                      disabled={locked}
                      onChange={(event) =>
                        client.acknowledgeMerges(event.target.checked)
                      }
                    />
                    <span>
                      I intend to combine {merges.length} groups of source
                      identities as the same local person, including their
                      private content and editing history.
                    </span>
                  </label>
                )}
                <label className="transfer-consent">
                  <input
                    type="checkbox"
                    checked={view.reviewConsent}
                    disabled={
                      locked ||
                      !choicesReady ||
                      (!!merges.length && !view.mergeConsent)
                    }
                    onChange={(event) =>
                      client.acknowledgeReview(event.target.checked)
                    }
                  />
                  <span>
                    I reviewed these people and access choices, including
                    private content.
                  </span>
                </label>
                <button disabled={locked || !plan || !choicesReady}>
                  Review ownership choices
                </button>
              </form>
            </>
          )}
          {view.review && (
            <section
              className="access-section"
              aria-labelledby="import-mapping-title"
            >
              <h2 id="import-mapping-title">3. Check the mapped campaign</h2>
              <p>
                {view.review.ownershipReview.counts.memberships} proposed
                members, including the host ·{" "}
                {view.review.ownershipReview.counts.newUsers} new people ·{" "}
                {view.review.ownershipReview.counts.unclaimed} unclaimed
                identities
              </p>
              <details>
                <summary>Resolved people and access</summary>
                <p>
                  The host remains a GM independently of these assignments.
                  Local names below come from this server's latest review.
                </p>
                <ul className="import-resolved-people">
                  {view.review.ownershipReview.assignments.map(
                    ({ sourceId, target }) => (
                      <li key={sourceId}>
                        {inspection?.ownership.subjects.find(
                          (subject) => subject.sourceId === sourceId,
                        )?.name ?? "Departed or unnamed person"}{" "}
                        ({sourceId.slice(0, 8)}) →{" "}
                        {target.kind === "unclaimed"
                          ? "Unclaimed attribution; no access"
                          : `${target.name} · ${target.role === "gm" ? "GM — all campaign content" : "Player"}${target.kind === "new" ? " · new person" : ` · local ${target.userId.slice(0, 8)}`}`}
                      </li>
                    ),
                  )}
                </ul>
              </details>
              <Blockers items={view.review.blockers} />
              <button
                type="button"
                disabled={
                  locked ||
                  !view.review.ownershipReview.complete ||
                  !!view.review.blockers.length
                }
                onClick={() => void client.prepare()}
              >
                Validate mapped campaign
              </button>
            </section>
          )}
          {view.candidate && (
            <section
              className="access-section"
              aria-label="Mapped campaign result"
            >
              <Blockers items={view.candidate.blockers} />
              {view.candidate.resourcePlan.complete &&
                view.candidate.candidateValidation.complete &&
                !view.candidate.blockers.length && (
                  <p role="status">
                    File, ownership and mapped-data checks passed. No campaign
                    has been created yet.
                  </p>
                )}
              {view.candidate.resourcePlan.complete &&
                view.candidate.candidateValidation.complete &&
                !view.candidate.blockers.length && (
                  <div className="access-section">
                    <h2>4. Create the new campaign</h2>
                    <p>
                      This creates a separate campaign with fresh resource IDs
                      and exactly the reviewed memberships. Existing campaigns
                      stay unchanged. If interrupted, reselect this exact file
                      to recover its saved result. The same file is imported
                      once per host through this browser workflow; intentional
                      additional copies require the administrator API with a
                      separate request ID.
                    </p>
                    <label className="transfer-consent">
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={view.createConsent}
                        onChange={(event) =>
                          client.acknowledgeCreation(event.target.checked)
                        }
                      />
                      <span>
                        Create a new campaign with these private records and
                        reviewed memberships.
                      </span>
                    </label>
                    <button
                      type="button"
                      disabled={locked || !view.createConsent}
                      onClick={() => void client.create()}
                    >
                      Create imported campaign
                    </button>
                  </div>
                )}
            </section>
          )}
        </>
      )}
      {view.execution === "pending" && (
        <p role="status">
          This request may finish even if the review closes. Reopen with the
          exact same file to check its saved result.
        </p>
      )}
      {view.execution === "uncertain" && view.host && (
        <section className="access-section" aria-label="Recover import result">
          <h2>Check before starting anything else</h2>
          <p>
            Confirmed file: <strong>{view.file?.name}</strong>
          </p>
          <p>
            The confirmed request is kept unchanged while this review stays
            open. Closing or reloading does not guarantee cancellation. Reopen
            with the exact same file to recover the result; no private file is
            stored in this browser.
          </p>
          <div className="access-actions">
            <button
              type="button"
              disabled={!!view.busy}
              onClick={() => void client.checkSavedResult()}
            >
              Check saved result
            </button>
            <button
              type="button"
              disabled={!!view.busy}
              onClick={() => void client.retry()}
            >
              Retry same confirmed import
            </button>
          </div>
        </section>
      )}
      {view.result && (
        <section className="access-section" aria-label="Imported campaign">
          <h2 ref={resultHeading} tabIndex={-1}>
            {view.result.replayed
              ? "Saved import recovered"
              : "Campaign imported"}
          </h2>
          <p>
            <strong>{view.result.campaign.name}</strong> was imported. Your
            active campaign has not changed.
          </p>
          {view.differentPlan && (
            <p role="status">
              This exact file was already imported using a different ownership
              review. No additional copy was created. Open the existing campaign
              to inspect its members.
            </p>
          )}
          <p>
            At import: {view.result.summary.memberships} members · New people:{" "}
            {view.result.summary.createdPeople} · Unclaimed attribution:{" "}
            {view.result.summary.attributionRecords}
          </p>
          <p>
            Import does not copy sign-in sessions or invitations. Open this
            campaign and use Invite &amp; players to issue return codes to new
            people who have not joined. Save current drafts before changing
            campaigns.
          </p>
          {openError && <p role="alert">{openError}</p>}
          {opening && <p role="status">Opening the imported campaign…</p>}
          <div className="access-actions">
            <button
              type="button"
              disabled={opening}
              onClick={() => {
                if (opening || !view.result) return;
                setOpening(true);
                setOpenError("");
                void openCampaign(view.result.campaign.id)
                  .catch(() =>
                    setOpenError(
                      "The imported campaign could not open. Refresh the campaign list and check access and installed modules.",
                    ),
                  )
                  .finally(() => setOpening(false));
              }}
            >
              Open imported campaign
            </button>
            <button type="button" onClick={close}>
              Close and choose a campaign
            </button>
          </div>
        </section>
      )}
      {!view.host && view.execution === "idle" && (
        <button
          type="button"
          disabled={locked}
          onClick={() => void client.loadPeople()}
        >
          Check host access again
        </button>
      )}
      <button type="button" onClick={close} className="import-review-close">
        {view.execution === "idle"
          ? "Close without creating a campaign"
          : "Close import"}
      </button>
    </dialog>,
    document.body,
  );
}
