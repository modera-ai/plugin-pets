import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  activityRow,
  desktopHtml,
  frameDuration,
  lookDirection,
} from "../src/desktop-renderer.ts";

test("Codex animation timing holds final frames and slows idle", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((frame) => frameDuration(0, frame)),
    [1680, 660, 660, 840, 840, 1920],
  );
  const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6];
  assert.deepEqual(
    counts
      .slice(1)
      .map((count, index) => [
        frameDuration(index + 1, 0),
        frameDuration(index + 1, count - 1),
      ]),
    [
      [120, 220],
      [120, 220],
      [140, 280],
      [140, 280],
      [140, 240],
      [150, 260],
      [120, 220],
      [150, 280],
    ],
  );
});

test("Codex v2 look directions start up and turn clockwise", () => {
  assert.equal(lookDirection(0, -10), 0);
  assert.equal(lookDirection(10, 0), 4);
  assert.equal(lookDirection(0, 10), 8);
  assert.equal(lookDirection(-10, 0), 12);
  assert.equal(lookDirection(-0.1, -10), 0);
});

test("task activity uses the Codex spritesheet rows", () => {
  assert.deepEqual(
    ["idle", "running", "waiting", "failed", "review"].map((state) =>
      activityRow(state as Parameters<typeof activityRow>[0]),
    ),
    [0, 7, 6, 5, 8],
  );
});

test("desktop document includes its own renderer without remote code", () => {
  const html = desktopHtml();
  assert.match(html, /moderaDesktop/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  const source = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(source);
  assert.doesNotThrow(() => new Function(source));
});

test("renderer acknowledges decoded images and reports invalid image dimensions", () => {
  const messages: { type: string }[] = [];
  let receiveData: (data: unknown) => void = () => {};
  let loaded: {
    naturalWidth: number;
    naturalHeight: number;
    onload: () => void;
    onerror: () => void;
  };
  class FakeImage {
    naturalWidth = 1536;
    naturalHeight = 2288;
    onload = () => {};
    onerror = () => {};
    constructor() {
      loaded = this;
    }
  }
  const canvas = {
    getContext: () => ({
      clearRect() {},
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(192 * 208 * 4) }),
    }),
    setAttribute() {},
    addEventListener() {},
  };
  runInNewContext(desktopHtml().match(/<script>([\s\S]*)<\/script>/)![1], {
    window: {
      moderaDesktop: {
        onData: (callback: typeof receiveData) => {
          receiveData = callback;
        },
        onPointer() {},
        onActivity() {},
        send: (message: { type: string }) => messages.push(message),
      },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {},
    },
    document: { querySelector: () => canvas, addEventListener() {} },
    Image: FakeImage,
    requestAnimationFrame() {},
  });
  receiveData({
    name: "Pet",
    version: 2,
    spritesheetDataUrl: "data:image/png;base64,test",
  });
  assert.equal(messages.length, 0);
  loaded!.onload();
  assert.equal(messages.at(-1)?.type, "ready");
  receiveData({
    name: "Wrong size",
    version: 1,
    spritesheetDataUrl: "data:image/png;base64,test",
  });
  loaded!.onload();
  assert.equal(messages.at(-1)?.type, "error");
  receiveData({
    name: "Broken",
    version: 2,
    spritesheetDataUrl: "data:image/png;base64,broken",
  });
  loaded!.onerror();
  assert.equal(messages.at(-1)?.type, "error");
});
