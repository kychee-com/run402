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
    // v0.1.6 (closes kychee-com/run402-private#405): append a code-specific
    // remediation hint so the operator sees the exact CLI command to run
    // instead of having to grep docs or file an issue. Adapter consumers
    // hit these errors deep in a Vite plugin output stream where context
    // is otherwise hard to come by.
    super(`${code} while uploading ${absolutePath}: ${message}${hintForCode(code, gatewayStatus)}`);
    this.name = "GatewayUploadError";
    this.code = code;
    this.absolutePath = absolutePath;
    this.gatewayStatus = gatewayStatus;
  }
}

/**
 * Per-error-code remediation hint appended to GatewayUploadError messages.
 * Each hint names the exact `run402` CLI command (or step) to take.
 *
 * Stays in sync with the four prerequisites documented in the README
 * "Before you start" section. If you change one, change the other.
 */
function hintForCode(code: string, gatewayStatus: number | undefined): string {
  switch (code) {
    case "PROJECT_NOT_FOUND":
      return (
        "\n\n  Auth path doesn't recognize this project.\n" +
        "    - Locally: run402 login <project-id>\n" +
        "                (provisions ~/.config/run402/projects.json)\n" +
        "    - In CI:   confirm GITHUB_ACTIONS=true AND the workflow has\n" +
        "               permissions: id-token: write, then verify a binding exists with\n" +
        "               run402 ci list --project <project-id>\n" +
        "  See @run402/astro README → 'Before you start' #2."
      );
    case "CI_ASSET_SCOPE_DENIED":
      return (
        "\n\n  CI binding's asset_key_scopes don't permit this prefix (closed by default).\n" +
        "    run402 ci list --project <project-id>             # find the binding id\n" +
        "    run402 ci set-asset-scopes <binding-id> 'astro/*' # grant the integration's prefix\n" +
        "  Local-laptop wallet deploys skip this check; only CI sessions hit it.\n" +
        "  See @run402/astro README → 'Before you start' #3."
      );
    case "CI_BINDING_REVOKED":
      // The CI/OIDC binding existed but was revoked — most often because the
      // project was transferred or handed to a new owner (a transfer suspends
      // the prior org's CI bindings). The fix is to RE-LINK, not to widen
      // asset scopes: `set-asset-scopes` 409s on a revoked binding. Closes the
      // red-herring asset-scope hint from kychee-com/run402#470 / #473.
      return (
        "\n\n  The CI/OIDC binding was revoked — most often because the project was\n" +
        "  transferred or handed to a new owner (a transfer suspends the prior org's\n" +
        "  CI bindings). Re-create it from the repository:\n" +
        "    run402 ci link github --project <project-id> --repo <owner/repo>\n" +
        "  Do NOT run `set-asset-scopes` — it 409s on a revoked binding.\n" +
        "  See @run402/astro README → 'Before you start' #2."
      );
    case "FORBIDDEN":
      // The SDK envelope-maps the gateway's CI_ASSET_SCOPE_DENIED to a
      // generic FORBIDDEN for some endpoints. If the gateway message
      // mentioned asset_key_scopes, treat it the same.
      if (gatewayStatus === 403) {
        return (
          "\n\n  HTTP 403 from the gateway. If the underlying message mentions\n" +
          "  asset_key_scopes, the CI binding hasn't been granted the integration's prefix:\n" +
          "    run402 ci list --project <project-id>\n" +
          "    run402 ci set-asset-scopes <binding-id> 'astro/*'\n" +
          "  Otherwise, verify the project exists and the workflow's binding is for this repo.\n" +
          "  See @run402/astro README → 'Before you start' #2 and #3."
        );
      }
      return "";
    case "IMAGE_DECODE_FAILED":
      return (
        "\n\n  Source bytes failed to decode as an image. The file may be corrupt,\n" +
        "  not actually an image despite its extension, or use an encoding the gateway's\n" +
        "  libvips/libheif build doesn't support. Verify with `file <path>` and `identify <path>`."
      );
    case "IMAGE_INPUT_TOO_LARGE":
      return (
        "\n\n  Source exceeds the 40 MP pixel cap or 12000-px-per-axis cap. Resize before upload\n" +
        "  or override the gateway-side IMAGE_VARIANTS_MAX_PIXELS / IMAGE_VARIANTS_MAX_DIM."
      );
    case "QUOTA_EXCEEDED":
      return (
        "\n\n  Storage quota hit. Project tier caps storage_bytes; bump the tier or delete\n" +
        "  unused blobs. The error envelope's details.caused_by_variant_shas (if present)\n" +
        "  names which variant SHAs put you over."
      );
    case "TOO_MANY_ENCODES_QUEUED":
      return (
        "\n\n  Gateway encoder queue is full (default 4 deep, 2 concurrent). The integration\n" +
        "  retries up to 3 times with backoff; if you'\\''re hitting this on every build,\n" +
        "  reduce the integration's `concurrency` option or stagger builds across runners."
      );
    default:
      return "";
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
