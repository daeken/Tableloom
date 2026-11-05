// Synthetic instance data; never imported by normal startup.
import { z } from "zod";
import {
  defineContentInstances,
  defineCampaignDataTransfer,
} from "@tableloom/module-sdk/server";
import { fixturePack, fixtureData } from "./content-fixture.js";
export const instanceData = z
  .object({ label: z.string().max(100), marked: z.boolean() })
  .strict();
export function instancePack() {
  return {
    ...fixturePack(),
    instances: defineContentInstances(fixtureData, {
      schemaVersion: 1,
      dataSchema: instanceData,
      transfer: defineCampaignDataTransfer(instanceData, () => []),
      create: (definition) => ({ label: definition.label, marked: false }),
    }),
  };
}
