import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { importPet, parseInstallLink } from "../src/import.ts";
import { PetStore } from "../src/store.ts";

function png(version = 2) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(1536, 16);
  bytes.writeUInt32BE(version === 1 ? 1872 : 2288, 20);
  return bytes;
}
function webp(version = 2) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8X", 8);
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(1535, 24, 3);
  bytes.writeUIntLE((version === 1 ? 1872 : 2288) - 1, 27, 3);
  return bytes;
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = path.resolve("tests"),
    root = await mkdtemp(path.join(base, ".modera-pets-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function transport(bytes: Buffer, type = "image/png"): typeof fetch {
  return (async () =>
    new Response(bytes, { headers: { "content-type": type } })) as typeof fetch;
}

test("Codex install link preserves metadata and missing version auto-detects", async () => {
  const link =
    "codex://pets/install?name=Cloud&description=Hello&imageUrl=https%3A%2F%2Fexample.com%2Fs.png";
  assert.deepEqual(parseInstallLink(link), {
    name: "Cloud",
    description: "Hello",
    imageUrl: "https://example.com/s.png",
    version: undefined,
  });
  const pet = await importPet(link, { fetch: transport(png()) });
  assert.equal(pet.version, 2);
  assert.equal(pet.description, "Hello");
  await assert.rejects(
    importPet(link + "&spriteVersionNumber=1", { fetch: transport(png()) }),
    /尺寸/,
  );
});
test("directory, legacy manifest, default version and raw PNG/WebP work", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "avatar.json"),
    JSON.stringify({ id: "legacy" }),
  );
  await writeFile(path.join(root, "spritesheet.webp"), webp(1));
  assert.equal((await importPet(root)).name, "legacy");
  await writeFile(
    path.join(root, "pet.json"),
    JSON.stringify({
      displayName: "New",
      spriteVersionNumber: 2,
      spritesheetPath: "new.png",
    }),
  );
  await writeFile(path.join(root, "new.png"), png());
  assert.equal((await importPet(root)).name, "New");
  assert.equal((await importPet(path.join(root, "new.png"))).version, 2);
  await writeFile(
    path.join(root, "pet.json"),
    JSON.stringify({ spritesheetPath: "new.png" }),
  );
  await assert.rejects(importPet(root), /尺寸/);
});
test("rejects invalid manifests, traversal, symlink escape, oversized files", async (t) => {
  const root = await fixture(t),
    pack = path.join(root, "pack");
  await mkdir(pack);
  await writeFile(path.join(root, "outside.png"), png());
  for (const spritesheetPath of [
    "../outside.png",
    path.join(root, "outside.png"),
    "C:\\outside.png",
  ]) {
    await writeFile(
      path.join(pack, "pet.json"),
      JSON.stringify({ spritesheetPath }),
    );
    await assert.rejects(importPet(pack), /目录/);
  }
  await writeFile(
    path.join(pack, "pet.json"),
    JSON.stringify({ description: 42 }),
  );
  await assert.rejects(importPet(pack), /说明/);
  await writeFile(path.join(pack, "pet.json"), " ".repeat(65537));
  await assert.rejects(importPet(pack), /大小/);
  await writeFile(
    path.join(root, "huge.png"),
    Buffer.alloc(20 * 1024 * 1024 + 1),
  );
  await assert.rejects(importPet(path.join(root, "huge.png")), /大小/);
  try {
    await symlink(root, path.join(pack, "escape"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    throw error;
  }
  await writeFile(
    path.join(pack, "pet.json"),
    JSON.stringify({
      spritesheetPath: "escape/outside.png",
      spriteVersionNumber: 2,
    }),
  );
  await assert.rejects(importPet(pack), /符号链接/);
});
test("network validates URL, redirect destinations, MIME, size and abort", async () => {
  for (const input of [
    "http://example.com/a.png",
    "https://localhost/a.png",
    "https://127.0.0.1/a.png",
    "https://[::1]/a.png",
    "https://user:pass@example.com/a.png",
    "https://10.0.0.1/a.png",
  ])
    assert.throws(() => parseInstallLink(input));
  await assert.rejects(
    importPet("https://example.com/a.png", {
      fetch: transport(png(), "text/html"),
    }),
    /下载失败/,
  );
  await assert.rejects(
    importPet("https://example.com/a.png", {
      fetch: transport(png(), "image/webp"),
    }),
    /类型/,
  );
  await assert.rejects(
    importPet("https://example.com/a.png", {
      fetch: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/a.png" },
        })) as typeof fetch,
    }),
    /公共/,
  );
  await assert.rejects(
    importPet("https://example.com/a.png", {
      fetch: transport(Buffer.alloc(20 * 1024 * 1024 + 1)),
    }),
    /20 MiB/,
  );
  await assert.rejects(
    importPet("https://example.com/a.png", {
      signal: AbortSignal.abort(),
      fetch: transport(png()),
    }),
  );
  assert.throws(
    () => parseInstallLink("https://chatgpt.com/codex/pets/share/123"),
    /安装链接/,
  );
});
test("rejects malformed image headers and dimensions", async (t) => {
  const root = await fixture(t),
    file = path.join(root, "bad.png");
  for (const bytes of [
    Buffer.from("not image"),
    png().subarray(0, 24),
    webp().subarray(0, 29),
  ]) {
    await writeFile(file, bytes);
    await assert.rejects(importPet(file));
  }
  const bytes = png();
  bytes.writeUInt32BE(1, 16);
  await writeFile(file, bytes);
  await assert.rejects(importPet(file), /尺寸/);
});
test("store imports copies, persists selection, deletes safely and rejects invalid IDs", async (t) => {
  const root = await fixture(t),
    source = path.join(root, "pet.png"),
    storage = path.join(root, "store");
  await writeFile(source, png());
  const store = new PetStore(storage),
    item = await store.import(source);
  await rm(source);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get(item.id)).bytes.length, 33);
  await store.select(item.id);
  assert.deepEqual(await new PetStore(storage).readSelection(), {
    selectedId: item.id,
    enabled: true,
  });
  await assert.rejects(store.remove("../outside"), /ID/);
  await store.remove(item.id);
  assert.deepEqual(await store.readSelection(), {
    selectedId: null,
    enabled: false,
  });
  assert.deepEqual(await store.list(), []);
});

test("metadata limits and empty inputs reject before import", async (t) => {
  await assert.rejects(importPet("  "), /请输入/);
  const prefix =
    "codex://pets/install?imageUrl=https%3A%2F%2Fexample.com%2Fp.png";
  assert.throws(() => parseInstallLink(prefix), /名称/);
  assert.throws(
    () => parseInstallLink(prefix + "&name=" + "a".repeat(201)),
    /名称/,
  );
  assert.throws(
    () =>
      parseInstallLink(prefix + "&name=Pet&description=" + "a".repeat(4001)),
    /说明/,
  );
  const root = await fixture(t);
  await writeFile(path.join(root, "spritesheet.webp"), webp());
  await writeFile(
    path.join(root, "pet.json"),
    JSON.stringify({ displayName: "a".repeat(201), spriteVersionNumber: 2 }),
  );
  await assert.rejects(importPet(root), /名称/);
});

test("redirect loops are bounded and mutated stored images remain bounded", async (t) => {
  let calls = 0;
  await assert.rejects(
    importPet("https://example.com/p.png", {
      fetch: (async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "/p.png" },
        });
      }) as typeof fetch,
    }),
    /重定向次数/,
  );
  assert.equal(calls, 5);
  const root = await fixture(t),
    source = path.join(root, "p.png"),
    storage = path.join(root, "store");
  await writeFile(source, png());
  const store = new PetStore(storage),
    item = await store.import(source);
  await writeFile(
    path.join(storage, item.id, "sprite"),
    Buffer.alloc(20 * 1024 * 1024 + 1),
  );
  await assert.rejects(store.get(item.id), /大小/);
});
