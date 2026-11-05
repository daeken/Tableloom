import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { defineSystem } from "@tableloom/module-sdk";
import { defineBrowserSystem } from "@tableloom/module-sdk/browser";
import type { DocumentSheetProps } from "@tableloom/module-sdk/browser";

test("browser adapter renders arbitrary typed module data with isolated edit/action capabilities and validates JSON/schema boundaries", async () => {
  const shared = defineSystem({
    manifest: {
      id: "fixture-labels",
      name: "Synthetic labels",
      version: "1.0.0",
      sdkVersion: 1,
      status: "scaffold",
      description: "Test only",
      accent: "#405f4d",
    },
    documentVersion: 1,
    documentSchema: z.object({ labels: z.array(z.string()) }).strict(),
    createDocument: () => ({ labels: [] }),
  });
  let props: DocumentSheetProps<{ labels: string[] }> | undefined;
  const browser = defineBrowserSystem(shared, (value) => {
    props = value;
    return createElement("p", null, value.data.labels.join(", "));
  });
  const changes: unknown[] = [],
    actions: unknown[] = [];
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      browser.renderSheet({
        data: browser.parse({ labels: ["<b>Plain text</b>"] }),
        onChange: (data) => changes.push(data),
        readOnly: false,
        actionsEnabled: true,
        runAction: async (action, input) => {
          actions.push({ action, input });
          return true;
        },
      }),
    ),
  );
  assert.ok(html.includes("&lt;b&gt;Plain text&lt;/b&gt;"));
  assert.equal(props!.readOnly, false);
  assert.equal(props!.actionsEnabled, true);
  props!.onChange({ labels: ["Changed"] });
  assert.deepEqual(changes, [{ labels: ["Changed"] }]);
  assert.equal(await props!.runAction("example", null), true);
  assert.deepEqual(actions, [{ action: "example", input: null }]);
  for (const data of [
    { labels: [3] },
    { labels: [], unexpected: true },
    { labels: ["x".repeat(70000)] },
  ])
    assert.throws(() => browser.parse(data));
});
