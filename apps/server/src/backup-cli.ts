import { parseArgs } from "node:util";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
const usage =
  "Usage: backup-cli.js backup|restore|verify --source PATH [--destination NEW_PATH]";
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      source: { type: "string" },
      destination: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    const command = positionals[0];
    if (
      positionals.length !== 1 ||
      !values.source ||
      !["backup", "restore", "verify"].includes(command ?? "") ||
      (command === "verify" ? Boolean(values.destination) : !values.destination)
    )
      throw new Error(usage);
    if (command === "verify") await verifyBackup(values.source);
    else if (command === "restore")
      await restoreBackup({
        source: values.source,
        destination: values.destination!,
      });
    else
      await createBackup({
        source: values.source,
        destination: values.destination!,
        ...(process.env.TABLELOOM_HOST_KEY !== undefined
          ? { hostKey: process.env.TABLELOOM_HOST_KEY }
          : {}),
      });
    console.log(
      command === "verify"
        ? "Backup verified."
        : command === "restore"
          ? "Recovery created in the new data directory."
          : "Backup created and verified.",
    );
  }
} catch {
  // Parser and validation errors can contain credential input. Never print raw values/errors.
  console.error(
    "Backup/recovery command failed. Check the command, private key, database integrity and paths. Destination directories must be new. " +
      usage,
  );
  process.exitCode = 1;
}
