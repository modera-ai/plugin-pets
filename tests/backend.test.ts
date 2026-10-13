import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { activate } from "../src/index.ts";

test("settings SDK JSON payload imports, selects and hides a persisted desktop pet", async (t) => {
  const root = await mkdtemp(path.resolve("tests/.pet-backend-"));
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "pet.png");
  const image = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8);
  image.write("IHDR", 12);
  image.writeUInt32BE(1536, 16);
  image.writeUInt32BE(2288, 20);
  await writeFile(file, image);
  let listener: ((data: unknown) => void) | undefined;
  let closed = 0;
  let received: any;
  const module = await activate({
    storagePath: path.join(root, "store"),
    signal: controller.signal,
    grantedPermissions: new Set([
      "desktop.windows",
      "storage.read",
      "storage.write",
    ]),
    desktopWindows: {
      open: async () => ({
        onMessage: (next: typeof listener) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        update: async (data: unknown) => {
          received = data;
          listener?.({ type: "ready" });
        },
        close: async () => {
          closed++;
        },
      }),
    },
  } as any);
  const settings = module!.settings!;
  const act = (id: string, value?: string) =>
    settings.act(
      { id, value: value === undefined ? undefined : JSON.stringify(value) },
      { signal: controller.signal },
    ) as Promise<any>;
  const imported = await act("import", file);
  assert.equal(imported.pets.length, 1);
  const id = imported.pets[0].id;
  assert.equal((await act("select", id)).selectedId, id);
  assert.equal(received.version, 2);
  assert.match(received.spritesheetDataUrl, /^data:image\/png;base64,/);
  await act("hide");
  assert.equal(closed, 1);
  assert.equal((await act("snapshot")).enabled, false);
  await assert.rejects(act("import", "https://example.com/pet.png"), /权限/);
  await assert.rejects(
    settings.act({ id: "select", value: "42" }, { signal: controller.signal }),
    /文字参数/,
  );
  await act("remove", id);
  assert.equal((await act("snapshot")).pets.length, 0);
  // Drain deferred restoration before removing this isolated store.
  await new Promise((resolve) => setTimeout(resolve, 5));
});
