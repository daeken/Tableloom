export type DocumentData =
  | null
  | boolean
  | number
  | string
  | DocumentData[]
  | { [key: string]: DocumentData };
export const MAX_DOCUMENT_BYTES = 64 * 1024;

/** JSON-only payloads with bounded work and no silent serialization loss. */
export function documentData(value: unknown): DocumentData {
  let nodes = 0,
    bytes = 0;
  const encoder = new TextEncoder(),
    ancestors = new Set<object>();
  function charge(text: string) {
    bytes += encoder.encode(text).byteLength;
    if (bytes > MAX_DOCUMENT_BYTES)
      throw new Error("Document data exceeds 64 KiB.");
  }
  function string(value: string) {
    if (value.length > MAX_DOCUMENT_BYTES)
      throw new Error("Document string is too large.");
    charge(JSON.stringify(value));
  }
  function visit(value: unknown, depth: number): DocumentData {
    if (++nodes > 10000 || depth > 20)
      throw new Error("Document data is too complex.");
    if (typeof value === "string") {
      string(value);
      return value;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      charge(JSON.stringify(value));
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value))
      throw new Error("Document data must contain only finite JSON values.");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Document data must contain plain JSON objects.");
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string"))
      throw new Error("Document data cannot contain symbol keys.");
    ancestors.add(value);
    let parsed: DocumentData;
    if (Array.isArray(value)) {
      if (value.length > 10000 || keys.length !== value.length + 1)
        throw new Error("Document arrays must be bounded and dense.");
      charge("[");
      parsed = Array.from({ length: value.length }, (_, index) => {
        const entry = descriptors[String(index)];
        if (!entry || !entry.enumerable || !("value" in entry))
          throw new Error("Document arrays must contain plain values.");
        if (index) charge(",");
        return visit(entry.value, depth + 1);
      });
      charge("]");
    } else {
      if (keys.length > 10000) throw new Error("Document object is too large.");
      charge("{");
      parsed = Object.fromEntries(
        (keys as string[]).map((key, index) => {
          const entry = descriptors[key]!;
          if (!entry.enumerable || !("value" in entry))
            throw new Error(
              "Document objects must contain plain enumerable values.",
            );
          if (index) charge(",");
          string(key);
          charge(":");
          return [key, visit(entry.value, depth + 1)];
        }),
      );
      charge("}");
    }
    ancestors.delete(value);
    return parsed;
  }
  return visit(value, 0);
}
