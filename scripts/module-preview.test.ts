import { test } from "node:test";
import {
  verifyModulePreview,
  verifyNormalStartupIsolation,
} from "./modules/verify.js";
test("synthetic module harness exercises real HTTP/client actions, diverse sheets, rollback and audience filtering", async () => {
  await verifyModulePreview();
});
test(
  "normal startup never installs preview modules or fixture session routes",
  verifyNormalStartupIsolation,
);
