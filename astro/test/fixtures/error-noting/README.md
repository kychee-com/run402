# Error-noting fixture

Pages and endpoints that fail in each way an Astro site on Run402 can fail. `astro/src/runtime/error-noting.test.ts` builds the site with `run402({ images: false })`, loads the built server entry, puts a request context with the wrapper's two slots behind `Symbol.for("run402.getCurrentContext")` (what the gateway's function wrapper publishes), and requests each path.

| File | Route | What it shows |
|---|---|---|
| `src/pages/throw.astro` | `/throw` | A frontmatter `TypeError`. Astro catches it and answers `500.astro`; the runtime notes the error and the route `/throw`. |
| `src/pages/items/[id].astro` | `/items/[id]` | A dynamic page that throws a `RangeError`: the route noted is the pattern, never `/items/42`. |
| `src/pages/api/intake.ts` | `/api/intake` | An endpoint that throws on `POST`, caught by Astro the same way. |
| `src/pages/api/five.ts` | `/api/five` | An endpoint that answers 503 itself with nothing thrown: the route is noted, no error. |
| `src/pages/late.astro` | `/late` | A component that throws after an `await`, below markup already streamed: the page answers 200 and the error surfaces only as a broken body stream, so nothing is noted (outside the requirement). |
| `src/pages/ok.astro` | `/ok` | A page that renders: nothing is noted. |
| `src/pages/500.astro` | | The site's own 500 page, whose bytes every caught error must leave unchanged. |
