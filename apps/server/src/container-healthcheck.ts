import { PROTOCOL_VERSION } from "@tableloom/core";

// A standalone compiled probe: no shell/curl, authentication, writes or secret logging.
try {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid health-check port.");
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    !("status" in body) ||
    body.status !== "ok" ||
    !("protocolVersion" in body) ||
    body.protocolVersion !== PROTOCOL_VERSION
  )
    throw new Error("Unhealthy response.");
} catch {
  process.exitCode = 1;
}
