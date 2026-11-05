import { z } from "zod";
import { defineSystem, documentActionIdSchema } from "./index.js";
import type { SystemDefinition } from "./index.js";
import { documentData } from "./document-data.js";

export interface DocumentActionActor {
  readonly id: string;
  readonly role: "gm" | "player";
}
export interface DocumentAction<T> {
  readonly id: string;
  readonly system: { id: string; version: string; documentVersion: number };
  /** Server executor only: receives validated stored data and raw bounded JSON input. */
  execute(data: T, input: unknown, actor: DocumentActionActor): T;
}

/** Keeps schema inference inside the module while exposing an erased execution boundary. */
export function defineDocumentAction<T, Input>(
  system: SystemDefinition<T>,
  definition: {
    id: string;
    inputSchema: z.ZodType<Input>;
    run: (context: { data: T; input: Input; actor: DocumentActionActor }) => T;
  },
): DocumentAction<T> {
  documentActionIdSchema.parse(definition.id);
  return {
    id: definition.id,
    system: {
      id: system.manifest.id,
      version: system.manifest.version,
      documentVersion: system.documentVersion,
    },
    execute(data, raw, actor) {
      const input = definition.inputSchema.parse(documentData(raw));
      documentData(input);
      return definition.run({ data, input, actor });
    },
  };
}

export interface DocumentMigration {
  from: number;
  to: number;
  outputSchema: z.ZodType<unknown>;
  migrate: (data: unknown) => unknown;
}
export interface ServerSystemDefinition<T> extends SystemDefinition<T> {
  documentMigrations?: readonly DocumentMigration[];
  documentActions?: readonly DocumentAction<T>[];
}
export function defineServerSystem<T>(
  definition: ServerSystemDefinition<T>,
): ServerSystemDefinition<T> {
  defineSystem(definition);
  const actions = new Set<string>();
  for (const action of definition.documentActions ?? []) {
    documentActionIdSchema.parse(action.id);
    if (
      actions.has(action.id) ||
      typeof action.execute !== "function" ||
      action.system.id !== definition.manifest.id ||
      action.system.version !== definition.manifest.version ||
      action.system.documentVersion !== definition.documentVersion
    )
      throw new Error(
        "Document actions must have unique IDs and match the exact system/schema pin.",
      );
    actions.add(action.id);
  }
  const from = new Set<number>();
  for (const migration of definition.documentMigrations ?? []) {
    z.number().int().positive().parse(migration.from);
    if (
      migration.to !== migration.from + 1 ||
      migration.to > definition.documentVersion ||
      from.has(migration.from) ||
      typeof migration.migrate !== "function" ||
      typeof migration.outputSchema?.parse !== "function"
    )
      throw new Error(
        "Document migrations must have unique, consecutive version steps and validated output.",
      );
    from.add(migration.from);
  }
  return definition;
}
