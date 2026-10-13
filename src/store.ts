import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  importPet,
  readBounded,
  type ImportOptions,
  type ImportedPet,
} from "./import.ts";

export type PetMetadata = Omit<ImportedPet, "bytes"> & {
  id: string;
  createdAt: string;
};
export type PetSelection = { selectedId: string | null; enabled: boolean };

export class PetStore {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private directory(id: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new Error("无效的宠物 ID");
    return path.join(this.root, id);
  }

  async list(): Promise<PetMetadata[]> {
    await mkdir(this.root, { recursive: true });
    const result: PetMetadata[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        result.push(await this.metadata(entry.name));
      } catch {
        /* Ignore incomplete or externally damaged entries. */
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async metadata(id: string): Promise<PetMetadata> {
    const data = JSON.parse(
      await readFile(path.join(this.directory(id), "metadata.json"), "utf8"),
    );
    if (
      data.id !== id ||
      typeof data.name !== "string" ||
      !(data.description === null || typeof data.description === "string") ||
      ![1, 2].includes(data.version) ||
      !["image/png", "image/webp"].includes(data.mimeType) ||
      typeof data.createdAt !== "string"
    )
      throw new Error("宠物记录损坏");
    return data;
  }

  async import(input: string, options?: ImportOptions): Promise<PetMetadata> {
    const pet = await importPet(input, options),
      id = randomUUID();
    options?.signal?.throwIfAborted();
    const metadata: PetMetadata = {
      id,
      name: pet.name,
      description: pet.description,
      version: pet.version,
      mimeType: pet.mimeType,
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.root, { recursive: true });
    const staging = path.join(this.root, `.${id}`);
    await mkdir(staging);
    try {
      await writeFile(path.join(staging, "sprite"), pet.bytes);
      await writeFile(
        path.join(staging, "metadata.json"),
        JSON.stringify(metadata, null, 2),
      );
      await rename(staging, this.directory(id));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return metadata;
  }

  async get(id: string): Promise<PetMetadata & { bytes: Buffer }> {
    const metadata = await this.metadata(id);
    return {
      ...metadata,
      bytes: await readBounded(
        path.join(this.directory(id), "sprite"),
        20 * 1024 * 1024,
      ),
    };
  }

  async remove(id: string): Promise<void> {
    const directory = this.directory(id);
    if ((await this.readSelection()).selectedId === id) await this.select(null);
    await rm(directory, { recursive: true, force: true });
  }

  async readSelection(): Promise<PetSelection> {
    try {
      const data = JSON.parse(
        await readFile(path.join(this.root, "selection.json"), "utf8"),
      );
      if (data.selectedId !== null) await this.metadata(data.selectedId);
      return {
        selectedId: data.selectedId,
        enabled: data.enabled === true && data.selectedId !== null,
      };
    } catch {
      return { selectedId: null, enabled: false };
    }
  }

  async select(id: string | null): Promise<PetSelection> {
    if (id !== null) await this.metadata(id);
    const selection = { selectedId: id, enabled: id !== null };
    await mkdir(this.root, { recursive: true });
    const temp = path.join(this.root, `.selection-${randomUUID()}.json`);
    try {
      await writeFile(temp, JSON.stringify(selection));
      await rename(temp, path.join(this.root, "selection.json"));
    } finally {
      await rm(temp, { force: true });
    }
    return selection;
  }
}
