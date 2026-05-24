/**
 * `<Run402Image>` — React adapter (§5 of run402-image-component-impl).
 *
 * Pure React FC wrapping the shared core (`core.ts`). Identical render
 * output to the Astro adapter under `renderToStaticMarkup` / `renderToString`
 * — see §8 byte-identity test suite.
 *
 * Consumer usage:
 *
 *   ```tsx
 *   import { Run402Image } from "@run402/astro/react";
 *
 *   export default function Hero({ asset }: { asset: AssetRef }) {
 *     return <Run402Image asset={asset} alt="..." sizes="100vw" priority />;
 *   }
 *   ```
 *
 * SSR: works under `renderToString` and `renderToStaticMarkup`. No
 * `window` or `document` references; the runtime detects SSR via the
 * absence of `globalThis.document` (matching what Astro's runtime does
 * when the React island is hydrated in the browser, where `document`
 * IS defined).
 *
 * Wrong-entry-point detection (§7): the imported symbol carries the
 * React brand via the cast at module-export time. Mixing entry points
 * (importing `@run402/astro/react` inside an `.astro` file) is caught
 * at compile time by TypeScript. Pure-JS consumers bypassing TS fall
 * through to the runtime guard inside the FC body.
 */

import { createElement, Fragment, version as REACT_VERSION, type FC, type ReactElement } from "react";

import { buildRun402ImageRenderTree } from "./core.js";
import { renderToReact } from "./render-react.js";
import {
  Run402ImageError,
  type ReactComponent,
  type RenderContext,
  type Run402ImageProps,
} from "./types.js";

/**
 * Local clone helper — mirrors render-react.ts's helper of the same
 * name. Adds a stable `key` to a returned React element without
 * mutating its identity. Used here to satisfy React's
 * `Fragment + children` key requirement when we wrap the preload and
 * root in a fragment.
 */
function cloneWithKey(el: ReactElement, key: string): ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyEl = el as any;
  return createElement(
    anyEl.type,
    { ...anyEl.props, key },
    ...(anyEl.props?.children !== undefined ? [anyEl.props.children] : []),
  );
}

/**
 * Detect SSR by checking for the absence of a DOM globals (`document`).
 * Per spec §"SSR detection mechanism": pure-client React renders SHALL
 * NOT emit preload links — preload after `<body>` is parsed defeats the
 * purpose. SSR detection in React-land is path-dependent (no
 * `import.meta.env.SSR` like Astro), so we look at the runtime:
 *
 *   - `document` undefined  → server-side rendering (Node / Workers /
 *     Deno without DOM shim) → SSR mode, emit preload
 *   - `document` present    → browser (or jsdom test env mimicking it)
 *     → CSR mode, NO preload emission
 *
 * Tests can override via the `_forceIsSSR` escape hatch on the React
 * FC's props for verification. Production code MUST NOT pass it.
 */
function detectIsSSR(): boolean {
  return typeof globalThis.document === "undefined";
}

/**
 * Internal-test-only prop. The React adapter doesn't expose a way for
 * callers to override the SSR detection from outside the component (per
 * spec); this prop is used ONLY by the byte-identity test suite (§8)
 * which needs to render in both SSR and CSR modes under jsdom without
 * tearing down `globalThis.document`.
 *
 * Stripped from the props passed to the shared core — never reaches
 * `validateProps`.
 *
 * @internal
 */
interface InternalTestProps {
  _forceIsSSR?: boolean;
}

const Run402ImageInner: FC<Run402ImageProps & InternalTestProps> = (props) => {
  // §7 runtime guard: detect if the React runtime is actually present.
  // `REACT_VERSION` is imported as `version` from "react"; if a consumer
  // builds their app without React in node_modules, the import fails at
  // build time (this code never runs). The runtime guard catches the
  // edge case where the bundle drops the React export (e.g., dead-code
  // elimination on a JS-only consumer who imported the React entry by
  // mistake).
  if (typeof REACT_VERSION !== "string") {
    throw new Run402ImageError({
      code: "R402_ASTRO_IMAGE_WRONG_ENTRY_POINT",
      message:
        "Run402Image from `@run402/astro/react` requires React. The imported " +
        "`React.version` is undefined — you may have imported the React entry " +
        "by mistake (e.g., inside a `.astro` file). Use " +
        "`@run402/astro/components` for Astro contexts.",
      suggestedFix:
        'import { Run402Image } from "@run402/astro/components"; // Astro\n' +
        'import { Run402Image } from "@run402/astro/react";      // React',
      docs: "https://run402.com/errors/#R402_ASTRO_IMAGE_WRONG_ENTRY_POINT",
    });
  }

  // Strip the internal-test prop before passing the rest to the shared core.
  const { _forceIsSSR, ...componentProps } = props;

  const context: RenderContext = {
    isSSR: _forceIsSSR !== undefined ? _forceIsSSR : detectIsSSR(),
    // The React adapter has no Astro.locals equivalent; project-level
    // imageDefaults are configured via a (future) React Provider. v1.0
    // accepts per-call props only; project-level defaults land in v1.1
    // (a `<Run402ImageProvider value={{ strict: ..., placeholder: ... }}>`
    // React Context).
  };

  const { root, preload } = buildRun402ImageRenderTree(
    componentProps as Run402ImageProps,
    context,
  );
  const rootEl = renderToReact(root);
  if (preload) {
    // Wrap both in a React Fragment so the consumer's tree carries one
    // returned element. Fragment children stay anonymous in
    // `renderToStaticMarkup` output (no extra DOM).
    return createElement(
      Fragment,
      null,
      cloneWithKey(renderToReact(preload), "preload"),
      cloneWithKey(rootEl, "root"),
    );
  }
  return rootEl;
};

/**
 * `<Run402Image>` — React entry point. The exported symbol carries the
 * React brand (`ReactComponent<Run402ImageProps>`) so TypeScript catches
 * accidental imports from inside `.astro` files at compile time.
 */
export const Run402Image = Run402ImageInner as unknown as ReactComponent<Run402ImageProps>;
