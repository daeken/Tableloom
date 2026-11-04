import { useCallback, useEffect, useRef, useState } from "react";
import { accessStatusSchema } from "@tableloom/core/access";
import type { AccessStatus } from "@tableloom/core/access";
import { z } from "zod";

export async function accessRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(json);
    throw new Error(
      parsed.success
        ? parsed.data.error
        : "The server could not complete that request.",
    );
  }
  return schema.parse(json);
}

export function useAccess() {
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const status = await accessRequest("/api/access", accessStatusSchema);
      if (id === sequence.current) {
        setAccess(status);
        setError("");
      }
    } catch {
      if (id === sequence.current)
        setError(
          "We couldn't reach your table. Check the server and try again.",
        );
    }
  }, []);
  const accept = useCallback((status: AccessStatus) => {
    ++sequence.current;
    setAccess(status);
    setError("");
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      ++sequence.current;
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  return { access, error, refresh, accept };
}
