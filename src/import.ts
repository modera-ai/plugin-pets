import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
export type PetVersion = 1 | 2;
export type ImportOptions = { signal?: AbortSignal; fetch?: typeof fetch };
export type ImportedPet = {
  name: string;
  description: string | null;
  version: PetVersion;
  mimeType: "image/png" | "image/webp";
  bytes: Buffer;
};
export type InstallLink = {
  name: string;
  description?: string;
  imageUrl: string;
  version?: PetVersion;
};

function metadata(
  name: string,
  description?: string | null,
): { name: string; description: string | null } {
  name = name.trim();
  description = description?.trim() || null;
  if (!name || name.length > 200)
    throw new Error("宠物名称必须为 1 至 200 个字符");
  if (description !== null && description.length > 4000)
    throw new Error("宠物说明不能超过 4000 个字符");
  return { name, description };
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Only global unicast IPv6; mapped IPv4 and local/special ranges are excluded.
  return (
    isIP(address) === 6 &&
    /^[23]/.test(address) &&
    !address.toLowerCase().startsWith("2001:db8:")
  );
}

function imageUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (!host.includes(".") && !isIP(host)) ||
    (isIP(host) && !publicAddress(host))
  ) {
    throw new Error(
      "宠物图片必须来自公共 HTTPS 地址，不能包含账户信息或非标准端口",
    );
  }
  return url;
}

export function parseInstallLink(input: string): InstallLink {
  const url = new URL(input.trim());
  if (
    url.protocol === "codex:" &&
    url.hostname === "pets" &&
    url.pathname === "/install"
  ) {
    const source = url.searchParams.get("imageUrl");
    if (!source) throw new Error("安装链接缺少 imageUrl");
    const rawVersion = url.searchParams.get("spriteVersionNumber");
    if (rawVersion !== null && rawVersion !== "1" && rawVersion !== "2")
      throw new Error("不支持的宠物精灵图版本");
    const details = metadata(
      url.searchParams.get("name") ?? "",
      url.searchParams.get("description"),
    );
    return {
      name: details.name,
      description: details.description ?? undefined,
      imageUrl: imageUrl(source).href,
      version:
        rawVersion === null ? undefined : (Number(rawVersion) as PetVersion),
    };
  }
  if (
    url.hostname === "chatgpt.com" &&
    url.pathname.startsWith("/codex/pets/share/")
  )
    throw new Error("请从分享页面复制 Codex 安装链接，或下载宠物包后导入");
  const source = imageUrl(input);
  return {
    name: metadata(
      decodeURIComponent(path.posix.basename(source.pathname)).replace(
        /\.(png|webp)$/i,
        "",
      ) || "Pet",
    ).name,
    imageUrl: source.href,
  };
}

function inspect(
  bytes: Buffer,
  expected?: PetVersion,
): Pick<ImportedPet, "version" | "mimeType"> {
  let width = 0,
    height = 0;
  let mimeType: ImportedPet["mimeType"];
  if (
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    mimeType = "image/png";
  } else if (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    mimeType = "image/webp";
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString("ascii", offset, offset + 4),
        size = bytes.readUInt32LE(offset + 4),
        start = offset + 8;
      if (start + size > bytes.length) throw new Error("WebP 文件不完整");
      if (kind === "VP8X" && size >= 10) {
        width = bytes.readUIntLE(start + 4, 3) + 1;
        height = bytes.readUIntLE(start + 7, 3) + 1;
        break;
      }
      if (kind === "VP8L" && size >= 5 && bytes[start] === 47) {
        const bits = bytes.readUInt32LE(start + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
        break;
      }
      if (
        kind === "VP8 " &&
        size >= 10 &&
        bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))
      ) {
        width = bytes.readUInt16LE(start + 6) & 0x3fff;
        height = bytes.readUInt16LE(start + 8) & 0x3fff;
        break;
      }
      offset = start + size + (size % 2);
    }
  } else throw new Error("仅支持 PNG 或 WebP 精灵图");
  const version = height === 1872 ? 1 : height === 2288 ? 2 : undefined;
  if (width !== 1536 || !version || (expected && expected !== version))
    throw new Error(
      "精灵图尺寸必须为 v1 1536×1872 或 v2 1536×2288，并与声明版本一致",
    );
  return { version, mimeType };
}

export async function readBounded(
  file: string,
  limit: number,
): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("导入路径必须是普通文件");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) throw new Error("宠物文件超过大小限制");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

async function download(
  source: string,
  options: ImportOptions,
  redirects = 0,
): Promise<Buffer> {
  if (redirects > 4) throw new Error("图片重定向次数过多");
  options.signal?.throwIfAborted();
  const url = imageUrl(source);
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let response: Response;
  if (options.fetch) {
    response = await options.fetch(url.href, {
      redirect: "manual",
      credentials: "omit",
      signal,
    });
  } else {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
      all: true,
    });
    if (
      !addresses.length ||
      addresses.some(({ address }) => !publicAddress(address))
    )
      throw new Error("图片地址解析到非公共网络");
    const chosen = addresses[0];
    response = await new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          signal,
          family: chosen.family,
          lookup: (_host, _options, callback) =>
            callback(null, chosen.address, chosen.family),
        },
        (res) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value)
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on("data", (chunk: Buffer) => {
                res.pause();
                controller.enqueue(chunk);
              });
              res.on("end", () => controller.close());
              res.on("error", (error) => controller.error(error));
            },
            pull() {
              res.resume();
            },
            cancel() {
              res.destroy();
            },
          });
          const status = res.statusCode ?? 500;
          if ([204, 205, 304].includes(status)) {
            res.destroy();
            resolve(new Response(null, { status, headers }));
          } else {
            try {
              resolve(new Response(stream, { status, headers }));
            } catch (error) {
              res.destroy();
              reject(error);
            }
          }
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new Error("图片重定向缺少地址");
    return download(new URL(location, url).href, options, redirects + 1);
  }
  const mime = response.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (
    !response.ok ||
    !["image/png", "image/webp"].includes(mime ?? "") ||
    Number(response.headers.get("content-length")) > MAX_IMAGE ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("下载失败：需要不超过 20 MiB 的 PNG/WebP 图片");
  }
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE) throw new Error("图片超过 20 MiB 限制");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const bytes = Buffer.concat(chunks);
  if (inspect(bytes).mimeType !== mime)
    throw new Error("图片类型与服务器声明不一致");
  return bytes;
}

export async function importPet(
  input: string,
  options: ImportOptions = {},
): Promise<ImportedPet> {
  input = input.trim();
  options.signal?.throwIfAborted();
  if (!input) throw new Error("请输入宠物文件路径或安装链接");
  if (/^(codex:|https?:)/i.test(input)) {
    const link = parseInstallLink(input),
      bytes = await download(link.imageUrl, options);
    return {
      name: link.name,
      description: link.description ?? null,
      bytes,
      ...inspect(bytes, link.version),
    };
  }
  let file = path.resolve(input),
    info = await stat(file);
  if (info.isDirectory()) {
    const current = path.join(file, "pet.json"),
      legacy = path.join(file, "avatar.json");
    try {
      await stat(current);
      file = current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      file = legacy;
    }
  }
  if (path.extname(file).toLowerCase() !== ".json") {
    const bytes = await readBounded(file, MAX_IMAGE);
    return { ...metadata(path.parse(file).name), bytes, ...inspect(bytes) };
  }
  const data = JSON.parse(
    (await readBounded(file, MAX_MANIFEST)).toString("utf8"),
  );
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("宠物清单必须是对象");
  for (const field of ["id", "displayName", "spritesheetPath"])
    if (
      data[field] !== undefined &&
      (typeof data[field] !== "string" || !data[field].trim())
    )
      throw new Error(`宠物清单字段 ${field} 无效`);
  if (data.description != null && typeof data.description !== "string")
    throw new Error("宠物说明必须为文字");
  const version =
    data.spriteVersionNumber === undefined ? 1 : data.spriteVersionNumber;
  if (version !== 1 && version !== 2) throw new Error("不支持的宠物版本");
  const root = await realpath(path.dirname(file)),
    relative = data.spritesheetPath?.trim() ?? "spritesheet.webp";
  if (
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.includes(":")
  )
    throw new Error("精灵图路径必须在宠物目录内");
  const candidate = path.resolve(root, relative),
    lexical = path.relative(root, candidate);
  if (!lexical || lexical === ".." || lexical.startsWith(`..${path.sep}`))
    throw new Error("精灵图路径越出宠物目录");
  const resolved = await realpath(candidate),
    actual = path.relative(root, resolved);
  if (
    !actual ||
    actual === ".." ||
    actual.startsWith(`..${path.sep}`) ||
    path.isAbsolute(actual)
  )
    throw new Error("精灵图符号链接越出宠物目录");
  const bytes = await readBounded(resolved, MAX_IMAGE);
  return {
    ...metadata(
      data.displayName?.trim() ?? data.id?.trim() ?? path.basename(root),
      data.description,
    ),
    bytes,
    ...inspect(bytes, version),
  };
}
