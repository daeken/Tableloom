import { z } from "zod";
import { defineSystem } from "./index.js";
import type { SystemDefinition } from "./index.js";

export interface DocumentMigration {
  from: number;
  to: number;
  outputSchema: z.ZodType<unknown>;
  migrate: (data: unknown) => unknown;
}
export interface ServerSystemDefinition<T> extends SystemDefinition<T> {
  documentMigrations?: readonly DocumentMigration[];
}
export function defineServerSystem<T>(
  definition: ServerSystemDefinition<T>,
): ServerSystemDefinition<T> {
  defineSystem(definition);
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
