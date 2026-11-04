// Server-only entry point; migrations and future authoritative actions belong here.
import { defineServerSystem } from "@tableloom/module-sdk/server";
import { system as shared } from "./index.js";
export const system = defineServerSystem(shared);
