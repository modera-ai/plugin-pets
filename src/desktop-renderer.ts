type Activity = "idle" | "running" | "waiting" | "failed" | "review";

export function lookDirection(x: number, y: number): number {
  return ((Math.round(Math.atan2(x, -y) / (Math.PI / 8)) % 16) + 16) % 16;
}

export function activityRow(activity: Activity): number {
  return (
    { idle: 0, running: 7, waiting: 6, failed: 5, review: 8 }[activity] ?? 0
  );
}

export function frameDuration(row: number, frame: number): number {
  if (row === 0) return [280, 110, 110, 140, 140, 320][frame] * 6;
  const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6];
  const normal = [0, 120, 120, 140, 140, 140, 150, 120, 150];
  const last = [0, 220, 220, 280, 280, 240, 260, 220, 280];
  return frame === counts[row] - 1 ? last[row] : (normal[row] ?? 140);
}

function startPet(
  direction: typeof lookDirection,
  rowForActivity: typeof activityRow,
  durationForFrame: typeof frameDuration,
) {
  interface Bridge {
    onData(
      listener: (data: {
        name: string;
        version: 1 | 2;
        spritesheetDataUrl: string;
      }) => void,
    ): void;
    onPointer(listener: (point: { x: number; y: number }) => void): void;
    onActivity(listener: (activity: Activity) => void): void;
    send(message: unknown): void;
    beginDrag(): void;
    endDrag(): void;
    setInteractive(interactive: boolean): void;
  }
  const bridge = (window as unknown as { moderaDesktop: Bridge }).moderaDesktop;
  const canvas = document.querySelector("canvas")!;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6];
  let image: HTMLImageElement | undefined;
  let version = 1,
    generation = 0,
    frame = 0,
    row = 0,
    deadline = 0;
  let activity: Activity = "idle";
  let pointer: { x: number; y: number } | undefined;
  let pressed: { id: number; x: number; y: number } | undefined;
  let dragged = false,
    interactive = false,
    temporary = false;
  let lastDragX = 0,
    nextClickRow = 3;
  let terminalTimer: ReturnType<typeof setTimeout> | undefined;
  let alpha: Uint8ClampedArray | undefined;
  const setInteractive = (value: boolean) => {
    if (interactive !== value) {
      interactive = value;
      bridge.setInteractive(value);
    }
  };
  const hit = (point: { x: number; y: number }) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((point.x - rect.left) * canvas.width) / rect.width);
    const y = Math.floor(((point.y - rect.top) * canvas.height) / rect.height);
    return (
      x >= 0 &&
      x < canvas.width &&
      y >= 0 &&
      y < canvas.height &&
      !!alpha &&
      alpha[(y * canvas.width + x) * 4 + 3] > 24
    );
  };
  const paint = () => {
    context.clearRect(0, 0, 192, 208);
    if (image)
      context.drawImage(
        image,
        frame * 192,
        row * 208,
        192,
        208,
        0,
        0,
        192,
        208,
      );
    alpha = context.getImageData(0, 0, 192, 208).data;
    if (pointer) setInteractive(!!pressed || hit(pointer));
  };
  const setRow = (value: number) => {
    if (row === value) return;
    row = value;
    frame = 0;
    deadline = 0;
    paint();
  };
  const updateLook = () => {
    if (!image || pressed || temporary || activity !== "idle") return;
    if (version !== 2 || !pointer) {
      setRow(0);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const index = direction(
      pointer.x - rect.left - rect.width / 2,
      pointer.y - rect.top - rect.height / 2,
    );
    row = 9 + Math.floor(index / 8);
    frame = index % 8;
    paint();
  };
  const duration = () => durationForFrame(row, frame);
  const tick = (now: number) => {
    if (image && !document.hidden && row < 9 && !reduced.matches) {
      if (!deadline) deadline = now + duration();
      if (now >= deadline) {
        frame++;
        if (frame >= counts[row]) {
          frame = 0;
          if (temporary) {
            temporary = false;
            row = rowForActivity(activity);
            updateLook();
          }
        }
        deadline = now + duration();
        paint();
      }
    }
    requestAnimationFrame(tick);
  };
  bridge.onData((data) => {
    const ticket = ++generation;
    const next = new Image();
    next.onload = () => {
      if (ticket !== generation) return;
      if (
        next.naturalWidth !== 1536 ||
        next.naturalHeight !== (data.version === 2 ? 2288 : 1872)
      ) {
        bridge.send({
          type: "error",
          message: "Pet spritesheet dimensions do not match its version.",
        });
        return;
      }
      image = next;
      version = data.version;
      temporary = false;
      row = rowForActivity(activity);
      frame = 0;
      deadline = 0;
      canvas.setAttribute("aria-label", data.name);
      document.title = data.name;
      paint();
      updateLook();
      bridge.send({ type: "ready" });
    };
    next.onerror = () => {
      if (ticket === generation)
        bridge.send({
          type: "error",
          message: "Pet spritesheet could not be decoded.",
        });
    };
    next.src = data.spritesheetDataUrl;
  });
  bridge.onPointer((point) => {
    pointer = point;
    updateLook();
    setInteractive(!!pressed || hit(point));
  });
  bridge.onActivity((next) => {
    clearTimeout(terminalTimer);
    activity = next;
    temporary = false;
    if (!dragged) {
      row = rowForActivity(next);
      frame = 0;
      deadline = 0;
      paint();
      updateLook();
    }
    if (next === "failed" || next === "review") {
      const terminalRow = rowForActivity(next);
      const cycle = Array.from({ length: counts[terminalRow] }, (_, index) =>
        durationForFrame(terminalRow, index),
      ).reduce((sum, value) => sum + value, 0);
      terminalTimer = setTimeout(() => {
        activity = "idle";
        if (!dragged) {
          setRow(0);
          updateLook();
        }
      }, cycle * 3);
    }
  });
  const finishDrag = (id?: number, allowClick = false) => {
    if (!pressed || (id !== undefined && pressed.id !== id)) return;
    const wasDragged = dragged;
    pressed = undefined;
    dragged = false;
    bridge.endDrag();
    if (allowClick && !wasDragged && activity === "idle" && !reduced.matches) {
      temporary = true;
      row = nextClickRow;
      nextClickRow = nextClickRow === 3 ? 4 : 3;
      frame = 0;
      deadline = 0;
      paint();
    } else {
      temporary = false;
      setRow(rowForActivity(activity));
      updateLook();
    }
    setInteractive(!!pointer && hit(pointer));
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      pressed ||
      !hit({ x: event.clientX, y: event.clientY })
    )
      return;
    event.preventDefault();
    pressed = { id: event.pointerId, x: event.screenX, y: event.screenY };
    lastDragX = event.screenX;
    dragged = false;
    setInteractive(true);
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pressed || pressed.id !== event.pointerId) return;
    if (
      !dragged &&
      Math.hypot(event.screenX - pressed.x, event.screenY - pressed.y) > 4
    ) {
      dragged = true;
      temporary = false;
      bridge.beginDrag();
    }
    if (dragged && event.screenX !== lastDragX)
      setRow(event.screenX > lastDragX ? 1 : 2);
    lastDragX = event.screenX;
  });
  canvas.addEventListener("pointerup", (event) =>
    finishDrag(event.pointerId, true),
  );
  canvas.addEventListener("pointercancel", (event) =>
    finishDrag(event.pointerId),
  );
  canvas.addEventListener("lostpointercapture", (event) =>
    finishDrag(event.pointerId),
  );
  window.addEventListener("blur", () => finishDrag());
  window.addEventListener("beforeunload", () => {
    clearTimeout(terminalTimer);
    finishDrag();
    setInteractive(false);
  });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    finishDrag();
    bridge.send({ type: "hide" });
  });
  reduced.addEventListener("change", () => {
    temporary = false;
    row = rowForActivity(activity);
    frame = 0;
    deadline = 0;
    paint();
    updateLook();
  });
  document.addEventListener("visibilitychange", () => {
    deadline = 0;
  });
  requestAnimationFrame(tick);
}

export function desktopHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desktop pet</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;user-select:none}body{display:grid;place-items:center}canvas{width:96px;height:104px;touch-action:none;cursor:grab}canvas:active{cursor:grabbing}</style></head><body><canvas width="192" height="208" role="img" aria-label="Desktop pet"></canvas><script>(${startPet.toString()})(${lookDirection.toString()},${activityRow.toString()},${frameDuration.toString()});</script></body></html>`;
}
