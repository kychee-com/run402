/**
 * MIME type lookup by file extension.
 */

const MIME_TYPES: Record<string, string> = {
  // Web
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".csv": "text/csv",

  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",

  // Fonts
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",

  // Media
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",

  // Other
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

/**
 * Get MIME type from file path or extension.
 * Returns "application/octet-stream" for unknown types.
 */
export function getMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = filePath.slice(dot).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}
