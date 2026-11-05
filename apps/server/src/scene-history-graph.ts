import { savedOrder, type Entry } from "./scene-history-model.js";

export type HistoryObjectKind = "token" | "drawing";
export type HistoryObjectLocation = {
  kind: HistoryObjectKind | "note";
  sceneId: string | null;
};
type Node = {
  id: string;
  sequence: number;
  scope: string;
  state: "done" | "undone";
  targets: Map<string, { previousId: string | null; kind: HistoryObjectKind }>;
};
function invalid(): never {
  throw new Error("Scene history causal graph is inconsistent.");
}

/** Callers parse row/payload schemas first. Keep only lightweight graph metadata,
 * not every deleted drawing's potentially large inverse geometry. Missing links
 * are expired data, never a request to resolve an ID against another database. */
export function inspectSceneHistoryGraph(
  entries: Iterable<Entry>,
  reservations: ReadonlySet<string>,
  currentObjects: ReadonlyMap<string, HistoryObjectLocation>,
) {
  const nodes = new Map<string, Node>(),
    sequences = new Set<number>(),
    objects = new Map(currentObjects);
  const remember = (id: string, kind: HistoryObjectKind, sceneId: string) => {
    const previous = objects.get(id);
    if (
      !reservations.has(id) ||
      (previous && (previous.kind !== kind || previous.sceneId !== sceneId))
    )
      invalid();
    objects.set(id, { kind, sceneId });
  };
  for (const entry of entries) {
    if (nodes.has(entry.id) || sequences.has(entry.sequence)) invalid();
    sequences.add(entry.sequence);
    const payload = entry.payload,
      targetKinds = new Map<string, HistoryObjectKind>();
    if (payload.objectType !== "mixed") {
      for (const target of entry.targets)
        targetKinds.set(target.objectId, payload.objectType);
    } else if (payload.kind === "resize-many") {
      for (const change of payload.changes)
        targetKinds.set(change.objectId, change.objectType);
    } else if (payload.kind === "translate") {
      for (const original of payload.originals)
        targetKinds.set(original.objectId, original.objectType);
    } else if (payload.kind === "delete-many") {
      for (const saved of payload.objects)
        targetKinds.set(saved.object.id, saved.objectType);
    } else invalid();
    const targets: Node["targets"] = new Map();
    for (const target of entry.targets) {
      const kind = targetKinds.get(target.objectId);
      if (!kind || targets.has(target.objectId)) invalid();
      remember(target.objectId, kind, entry.scene_id);
      targets.set(target.objectId, {
        previousId: target.previousId,
        kind,
      });
    }
    for (const kind of ["token", "drawing"] as const) {
      const orders =
        payload.kind === "layer"
          ? payload.objectType === kind
            ? [payload.order]
            : []
          : payload.kind === "reorder"
            ? payload.objectType === kind
              ? [payload.before, payload.after]
              : []
            : [savedOrder(payload, kind) ?? []];
      for (const order of orders)
        for (const id of order) remember(id, kind, entry.scene_id);
    }
    nodes.set(entry.id, {
      id: entry.id,
      sequence: entry.sequence,
      scope: `${entry.campaign_id}/${entry.scene_id}/${entry.actor_id}`,
      state: entry.state,
      targets,
    });
  }
  const undone = new Set<string>();
  for (const node of [...nodes.values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    if (node.state === "undone") undone.add(node.scope);
    else if (undone.has(node.scope)) invalid();
  }
  const successors = new Map<string, Set<string>>();
  let retainedLinks = 0,
    expiredLinks = 0;
  for (const node of nodes.values()) {
    for (const [objectId, target] of node.targets) {
      if (!target.previousId) continue;
      const previous = nodes.get(target.previousId);
      if (!previous) {
        expiredLinks++;
        continue;
      }
      if (
        previous.sequence >= node.sequence ||
        previous.scope !== node.scope ||
        previous.targets.get(objectId)?.kind !== target.kind
      )
        invalid();
      const used = successors.get(previous.id) ?? new Set<string>();
      if (used.has(objectId)) invalid(); // Each object has one retained successor, including within mixed groups.
      used.add(objectId);
      successors.set(previous.id, used);
      retainedLinks++;
    }
  }
  return { entries: nodes.size, retainedLinks, expiredLinks };
}
