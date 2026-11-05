import {
  inspectCampaignDataReferences,
  type CampaignDataTransfer,
  type CampaignDataReference,
} from "@tableloom/module-sdk/server";
import type { ContentReference } from "@tableloom/module-sdk/content";
import { StoreError } from "./store.js";

type ResourceKind = Exclude<
  CampaignDataReference["kind"],
  "member" | "content"
>;
/** All lookups are source-local. No destination UUID lookup or UUID-shaped-string guessing. */
export function campaignModuleReferences(
  resources: ReadonlyMap<ResourceKind, ReadonlySet<string>>,
  subject: (id: string) => void,
  content: (reference: ContentReference) => boolean,
) {
  let records = 0,
    references = 0,
    complete = true;
  return {
    inspect(policy: CampaignDataTransfer | undefined, data: unknown) {
      if (!policy) {
        complete = false;
        return;
      }
      const found = inspectCampaignDataReferences(policy, data);
      references += found.length;
      if (references > 100000)
        throw new StoreError(
          "Campaign exceeds the module reference limit.",
          400,
        );
      for (const reference of found) {
        if (reference.kind === "content") {
          if (!content(reference.value)) complete = false;
        } else if (reference.kind === "member") subject(reference.value);
        else if (!resources.get(reference.kind)?.has(reference.value))
          throw new StoreError(
            "Module resource references are inconsistent.",
            400,
          );
      }
      records++;
    },
    unavailable() {
      complete = false;
    },
    summary() {
      return { records, references, complete };
    },
  };
}
