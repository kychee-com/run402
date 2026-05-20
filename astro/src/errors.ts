/**
 * Typed errors emitted by the integration.
 *
 * Each error class carries enough context for the rendered build-error
 * message to name the offending file + line + remediation. Astro surfaces
 * thrown errors through its own diagnostic pipeline, so these need clear
 * `message` strings.
 */

export class LeadingSlashSrcError extends Error {
  readonly code = "RUN402_ASTRO_LEADING_SLASH_SRC";
  readonly src: string;
  readonly importingFile: string;

  constructor(src: string, importingFile: string) {
    super(
      `<Image src="${src}"> uses a leading-slash absolute path in ${importingFile}. ` +
        `Leading-slash paths refer to Astro's public/ directory, which bypasses the ` +
        `Run402 variant pipeline. Use a relative path (e.g., "./images/${src.replace(/^\/+/, "")}") ` +
        `or a tsconfig path alias (e.g., "@/images/...") instead.`,
    );
    this.name = "LeadingSlashSrcError";
    this.src = src;
    this.importingFile = importingFile;
  }
}

export class UnsupportedExtensionError extends Error {
  readonly code = "RUN402_ASTRO_UNSUPPORTED_EXTENSION";
  readonly src: string;
  readonly importingFile: string;
  readonly ext: string;

  constructor(src: string, importingFile: string, ext: string, accepted: readonly string[]) {
    super(
      `<Image src="${src}"> has unsupported extension "${ext}" (in ${importingFile}). ` +
        `Accepted extensions: ${accepted.join(", ")}.`,
    );
    this.name = "UnsupportedExtensionError";
    this.src = src;
    this.importingFile = importingFile;
    this.ext = ext;
  }
}

export class SourceNotFoundError extends Error {
  readonly code = "RUN402_ASTRO_SOURCE_NOT_FOUND";
  readonly src: string;
  readonly importingFile: string;
  readonly resolvedPath: string;

  constructor(src: string, importingFile: string, resolvedPath: string) {
    super(
      `<Image src="${src}"> resolves to ${resolvedPath} but no file exists at that path (referenced from ${importingFile}).`,
    );
    this.name = "SourceNotFoundError";
    this.src = src;
    this.importingFile = importingFile;
    this.resolvedPath = resolvedPath;
  }
}

export class MissingProjectIdError extends Error {
  readonly code = "RUN402_ASTRO_MISSING_PROJECT_ID";

  constructor() {
    super(
      "RUN402_PROJECT_ID is unset; set it in your environment or pass `projectId` to `run402()`.",
    );
    this.name = "MissingProjectIdError";
  }
}

export class GatewayUploadError extends Error {
  readonly code: string;
  readonly absolutePath: string;
  readonly gatewayStatus?: number | undefined;

  constructor(
    code: string,
    message: string,
    absolutePath: string,
    gatewayStatus?: number,
  ) {
    super(`${code} while uploading ${absolutePath}: ${message}`);
    this.name = "GatewayUploadError";
    this.code = code;
    this.absolutePath = absolutePath;
    this.gatewayStatus = gatewayStatus;
  }
}

export class MissingAssetRefError extends Error {
  readonly code = "RUN402_ASTRO_MISSING_ASSET_REF";
  readonly src: string;
  readonly resolvedPath: string;

  constructor(src: string, resolvedPath: string) {
    super(
      `No AssetRef available for <Image src="${src}"> (resolved: ${resolvedPath}). ` +
        `This usually means the build's image-discovery pass missed this reference — ` +
        `dynamic src expressions or non-string-literal props are not supported in v0.1.`,
    );
    this.name = "MissingAssetRefError";
    this.src = src;
    this.resolvedPath = resolvedPath;
  }
}
