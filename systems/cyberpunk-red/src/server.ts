// Server-only entry point; migrations and future authoritative actions belong here.
import {
  defineServerSystem,
  defineCampaignDataTransfer,
} from "@tableloom/module-sdk/server";
import { system as shared } from "./index.js";
export const system = defineServerSystem({
  ...shared,
  // Scaffold fields are plain text, with no campaign-resource references.
  documentTransfer: defineCampaignDataTransfer(shared.documentSchema, () => []),
});
