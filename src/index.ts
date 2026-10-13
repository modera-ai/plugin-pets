import type {
  PluginContext,
  PluginDesktopWindow,
  PluginModule,
} from "@modera/plugin-sdk";
import { PetStore } from "./store.ts";
import { desktopHtml } from "./desktop-renderer.ts";

export const activate: PluginModule["activate"] = async (
  host: PluginContext,
) => {
  const store = new PetStore(host.storagePath);
  let petWindow: PluginDesktopWindow | undefined;
  let failure = "";
  let pending = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(() => {
      host.signal.throwIfAborted();
      return operation();
    });
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const snapshot = async () => ({
    pets: await store.list(),
    ...(await store.readSelection()),
    error: failure || undefined,
  });
  const hide = async () => {
    await petWindow?.close();
    petWindow = undefined;
    await store.select(null);
  };
  const show = async (id: string) => {
    if (!host.desktopWindows)
      throw new Error(
        "当前宿主不支持桌面宠物，请更新 Modera 并授予桌面窗口权限。",
      );
    const pet = await store.get(id);
    await petWindow?.close();
    petWindow = undefined;
    const opened = await host.desktopWindows.open({
      id: "pet",
      title: pet.name,
      width: 192,
      height: 208,
      html: desktopHtml(),
    });
    petWindow = opened;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Attach a rejection handler before update can fail or cancellation can fire.
    void ready.catch(() => {});
    const timeout = setTimeout(
      () => rejectReady(new Error("宠物图片加载超时。")),
      10000,
    );
    const abort = () => rejectReady(new Error("宠物插件已停用。"));
    host.signal.addEventListener("abort", abort, { once: true });
    const release = opened.onMessage((message) => {
      if (!message || typeof message !== "object" || !("type" in message))
        return;
      if (message.type === "ready") resolveReady();
      if (message.type === "error")
        rejectReady(new Error("宠物图片无法解码，请检查精灵图文件。"));
      if (message.type === "hide") void enqueue(hide).catch(() => {});
    });
    try {
      await opened.update({
        name: pet.name,
        version: pet.version,
        spritesheetDataUrl: `data:${pet.mimeType};base64,${pet.bytes.toString("base64")}`,
      });
      await ready;
      host.signal.throwIfAborted();
      await store.select(id);
      failure = "";
    } catch (error) {
      release();
      await opened.close();
      if (petWindow === opened) petWindow = undefined;
      await store.select(null);
      throw error;
    } finally {
      clearTimeout(timeout);
      host.signal.removeEventListener("abort", abort);
    }
  };
  const restoration = setTimeout(() => {
    void enqueue(async () => {
      const saved = await store.readSelection();
      if (saved.enabled && saved.selectedId) await show(saved.selectedId);
    }).catch((error) => {
      if (!host.signal.aborted) failure = String(error);
    });
  }, 0);
  host.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(restoration);
      void petWindow?.close();
      petWindow = undefined;
    },
    { once: true },
  );
  return {
    settings: {
      timeoutMs: 120000,
      actions: ["snapshot", "import", "select", "hide", "remove"],
      act: (action, context) =>
        enqueue(async () => {
          try {
            if (action.id === "snapshot") return await snapshot();
            const value: unknown =
              action.value === undefined ? undefined : JSON.parse(action.value);
            if (action.id !== "hide" && typeof value !== "string")
              throw new Error("宠物操作需要文字参数。");
            if (action.id === "import") {
              if (
                !host.grantedPermissions.has("network.fetch") &&
                /^https?:|^codex:/i.test(value as string)
              )
                throw new Error("导入链接需要网络访问权限。");
              await store.import(value as string, {
                signal: AbortSignal.any([host.signal, context.signal]),
              });
            } else if (action.id === "select") await show(value as string);
            else if (action.id === "hide") await hide();
            else if (action.id === "remove") {
              const selected = await store.readSelection();
              if (selected.selectedId === value) await hide();
              await store.remove(value as string);
            } else throw new Error("未知宠物操作。");
            failure = "";
            return await snapshot();
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            throw error;
          }
        }),
    },
  };
};
