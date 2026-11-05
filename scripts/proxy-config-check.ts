import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CI syntax check only: no listener, certificate trust override, DNS or deployment.
const socket = "/var/run/docker.sock";
if (!(await stat(socket).catch(() => null))?.isSocket())
  throw new Error(
    "Proxy configuration checks require the local Docker socket at /var/run/docker.sock.",
  );
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), "tableloom-proxy-config-")),
  example = fileURLToPath(
    new URL("../deploy/nginx.conf.example", import.meta.url),
  );
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.DOCKER_CONTEXT;
delete env.DOCKER_HOST;
try {
  await exec(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=table.example",
      "-keyout",
      join(directory, "privkey.pem"),
      "-out",
      join(directory, "fullchain.pem"),
    ],
    { env, timeout: 30000 },
  );
  await writeFile(
    join(directory, "nginx.conf"),
    "events {}\nhttp { include /etc/nginx/tableloom.conf; }\n",
    { mode: 0o600 },
  );
  await exec(
    "docker",
    [
      "--host",
      `unix://${socket}`,
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "nginx",
      "--mount",
      `type=bind,source=${join(directory, "nginx.conf")},target=/etc/nginx/nginx.conf,readonly`,
      "--mount",
      `type=bind,source=${example},target=/etc/nginx/tableloom.conf,readonly`,
      "--mount",
      `type=bind,source=${directory},target=/etc/letsencrypt/live/table.example,readonly`,
      "nginx:stable-alpine",
      "-t",
    ],
    { env, timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  console.log(
    "nginx example syntax passed using a temporary self-signed fixture; no proxy was started.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
