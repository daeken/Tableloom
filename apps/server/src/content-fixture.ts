// Synthetic test data only; this registry is never imported by normal startup.
import { z } from "zod";
import { defineContentPack } from "@tableloom/module-sdk/content";
import { system } from "@tableloom/cyberpunk-red";
export const fixtureData = z
  .object({
    label: z.string().max(100),
    tags: z.array(z.string().max(30)).max(10),
  })
  .strict();
export const fixturePack = (version = "1.0.0") =>
  defineContentPack(system, {
    id: "fixture-paper",
    version,
    dataSchema: fixtureData,
    definitions: [
      {
        id: "a-public",
        name: "Plain page",
        kind: "example",
        visibility: "public",
        data: { label: "Unmarked", tags: [] },
        sources: [
          { title: "Synthetic fixture", edition: "test", page: "case 1" },
        ],
      },
      {
        id: "b-hidden",
        name: "GM-ONLY-FIXTURE",
        kind: "example",
        data: { label: "PRIVATE-CONTENT-CANARY", tags: [] },
        sources: [
          {
            title: "GM-ONLY-SOURCE",
            edition: "synthetic",
            page: "private case",
          },
        ],
      },
      {
        id: "c-public",
        name: "Labeled page",
        kind: "example",
        visibility: "public",
        data: { label: "Labeled", tags: ["demo"] },
        sources: [],
      },
    ],
  });
