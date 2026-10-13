import { useCallback, useEffect, useState } from "react";
import { Button, DialogNotice, Input, UiProvider } from "@modera/ui";
import { SettingsPage } from "@modera/ui/settings";
import {
  frontend,
  mountPlugin,
  settingsAction,
  usePluginSnapshot,
} from "@modera/plugin-sdk/react";
import "@modera/ui/styles.css";
import "./pets.css";

interface Pet {
  id: string;
  name: string;
  description: string;
  version: 1 | 2;
}
interface PetSnapshot {
  pets: Pet[];
  selectedId: string | null;
  enabled: boolean;
  error?: string;
}

function PetSettings() {
  const { snapshot, error } = usePluginSnapshot();
  const [data, setData] = useState<PetSnapshot>();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const zh = (snapshot?.locale || "zh-CN").startsWith("zh");
  const t = (cn: string, en: string) => (zh ? cn : en);
  const run = useCallback(async (action: string, value?: string) => {
    setBusy(true);
    setActionError("");
    try {
      setData(await settingsAction<PetSnapshot>(action, value));
      if (action === "import") setSource("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void frontend()
      .ready()
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (snapshot) void run("snapshot");
  }, [snapshot, run]);
  const browse = async () => {
    setBusy(true);
    setActionError("");
    try {
      const path = await frontend().settings.pickFile();
      if (path) {
        setSource(path);
      }
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <UiProvider
      theme="system"
      locale={zh ? "zh-CN" : "en"}
      className="pets-settings"
    >
      <SettingsPage
        title={t("桌面宠物", "Desktop pets")}
        description={t(
          "导入 Codex 宠物，让它在桌面陪伴你的工作。",
          "Import a Codex pet to accompany your work on the desktop.",
        )}
      >
        {(error || actionError || data?.error) && (
          <DialogNotice tone="error">
            {error || actionError || data?.error}
          </DialogNotice>
        )}
        <form
          className="pets-import"
          onSubmit={(event) => {
            event.preventDefault();
            if (source.trim() && !busy) void run("import", source.trim());
          }}
        >
          <Input
            label={t("宠物资源", "Pet source")}
            placeholder={t(
              "粘贴 Codex 安装链接、图片网址或本地文件路径",
              "Paste a Codex install link, image URL or local file path",
            )}
            value={source}
            onChange={setSource}
            disabled={busy}
          />
          <p>
            {t(
              "支持本地宠物清单与精灵图、Codex 安装链接，以及 v1 / v2 精灵图网址。",
              "Supports local manifests and spritesheets, Codex install links, and v1 / v2 spritesheet URLs.",
            )}
          </p>
          <div className="pets-actions">
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => void browse()}
            >
              {t("选择文件", "Choose file")}
            </Button>
            <Button type="submit" disabled={busy || !source.trim()}>
              {busy ? t("处理中…", "Working…") : t("导入宠物", "Import pet")}
            </Button>
          </div>
        </form>
        {!data && !busy && !actionError && (
          <DialogNotice>
            {t("正在连接插件…", "Connecting to plugin…")}
          </DialogNotice>
        )}
        {data && (
          <section
            className="pets-library"
            aria-label={t("我的宠物", "My pets")}
          >
            <header>
              <h2>{t("我的宠物", "My pets")}</h2>
              {data.enabled && (
                <Button
                  variant="outline"
                  size="small"
                  disabled={busy}
                  onClick={() => void run("hide")}
                >
                  {t("隐藏桌面宠物", "Hide desktop pet")}
                </Button>
              )}
            </header>
            {!data.pets.length && (
              <p className="pets-empty">
                {t(
                  "还没有宠物。导入你已有的 Codex 宠物资源即可开始。",
                  "No pets yet. Import your existing Codex pet assets to get started.",
                )}
              </p>
            )}
            <ul>
              {data.pets.map((pet) => (
                <li key={pet.id}>
                  <div className="pets-details">
                    <h3>
                      {pet.name}
                      <span>v{pet.version}</span>
                    </h3>
                    {pet.description && <p>{pet.description}</p>}
                    {data.enabled && data.selectedId === pet.id && (
                      <p className="pets-active">
                        {t("正在桌面显示", "Visible on desktop")}
                      </p>
                    )}
                  </div>
                  <div className="pets-actions">
                    <Button
                      variant="outline"
                      size="small"
                      disabled={
                        busy || (data.enabled && data.selectedId === pet.id)
                      }
                      onClick={() => void run("select", pet.id)}
                    >
                      {t("显示", "Show")}
                    </Button>
                    <Button
                      variant="quiet"
                      size="small"
                      disabled={busy}
                      onClick={() => void run("remove", pet.id)}
                    >
                      {t("移除", "Remove")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {!!data.pets.length && (
              <p className="pets-help">
                {t(
                  "拖动宠物调整位置，单击互动，右键隐藏。任务运行和等待时会切换动作。",
                  "Drag to reposition, click to interact, and right-click to hide. Animations respond to running and waiting tasks.",
                )}
              </p>
            )}
          </section>
        )}
      </SettingsPage>
    </UiProvider>
  );
}

mountPlugin(<PetSettings />);
