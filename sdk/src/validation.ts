import { LocalError } from "./errors.js";

const KNOWN_BINARY_EXTENSIONS = new Set([
  "7z",
  "avif",
  "bin",
  "bmp",
  "br",
  "dds",
  "eot",
  "flac",
  "gif",
  "gz",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "ktx",
  "ktx2",
  "m4a",
  "m4v",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "ogv",
  "opus",
  "otf",
  "pak",
  "pdf",
  "png",
  "rar",
  "tar",
  "tif",
  "tiff",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "zip",
]);

const KNOWN_BINARY_APPLICATION_TYPES = new Set([
  "application/gzip",
  "application/octet-stream",
  "application/pdf",
  "application/vnd.ms-fontobject",
  "application/wasm",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/zip",
  "model/gltf-binary",
]);

/**
 * True when a path/content-type pair describes bytes that must not originate
 * from a JavaScript string. This is deliberately conservative: textual image
 * formats such as SVG stay valid string sources, while opaque octet streams
 * are rejected only for extensions that are known to be binary.
 */
export function isKnownBinaryContent(path: string, contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const basename = path.split(/[\\/]/).pop() ?? path;
  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0 ? basename.slice(dot + 1).toLowerCase() : "";

  if (mediaType.startsWith("audio/") || mediaType.startsWith("video/") || mediaType.startsWith("font/")) {
    return true;
  }
  if (mediaType.startsWith("image/") && mediaType !== "image/svg+xml") {
    return true;
  }
  if (mediaType === "application/octet-stream") {
    return KNOWN_BINARY_EXTENSIONS.has(extension);
  }
  return KNOWN_BINARY_APPLICATION_TYPES.has(mediaType) || KNOWN_BINARY_EXTENSIONS.has(extension);
}

/** True for a direct string or a `{ data: ... }` wrapper around one. */
export function isUtf8StringSource(source: unknown): boolean {
  if (typeof source === "string") return true;
  if (
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    "data" in source
  ) {
    return isUtf8StringSource((source as { data: unknown }).data);
  }
  return false;
}

export function assertPositiveSafeInteger(
  value: number,
  name: string,
  context: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LocalError(`${name} must be a positive safe integer.`, context);
  }
}

export function assertWeiString(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new LocalError(`${name} must be a decimal non-negative integer string in wei.`, context);
  }
}

export function assertEvmAddress(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new LocalError(`${name} must be a 0x-prefixed 20-byte EVM address.`, context);
  }
}

export function assertNonEmptyString(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalError(`${name} must be a non-empty string.`, context);
  }
}

export function assertEmailAddress(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  ) {
    throw new LocalError(`${name} must be a valid email address.`, context);
  }
}

export function assertHttpUrl(
  value: unknown,
  name: string,
  context: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalError(`${name} must be an http(s) URL.`, context);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalError(`${name} must be an http(s) URL.`, context);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalError(`${name} must be an http(s) URL.`, context);
  }
}

export function assertStringInSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
  context: string,
): asserts value is T {
  if (typeof value !== "string") {
    throw new LocalError(`${name} must be one of: ${allowed.join(", ")}.`, context);
  }
  if (!allowed.includes(value as T)) {
    throw new LocalError(`${name} must be one of: ${allowed.join(", ")}.`, context);
  }
}
