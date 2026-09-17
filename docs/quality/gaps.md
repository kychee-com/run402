# Documentation capability gaps

| Gap | Owner | Interim path | Status |
|---|---|---|---|
| Manual schedule-trigger invocation has no dedicated CLI verb | SDK/CLI functions + gateway functions | Native HTTP trigger operation in the [HTTP reference](https://run402.com/llms-full.txt); function-run creation is a different operation | Product follow-up; no command invented |
| Server islands and Astro Sessions | Astro adapter | SSR/client hydration and supported hosted auth | Unsupported; documented in Astro guide |
| Cross-repo publication and clean installation | Docs/distribution | Source checks do not certify hosted bytes | Pending acceptance |
| Astro optional functions peer range excludes the published 4.x runtime helper | Astro package maintainer | Existing runtime reference and explicit installed-version checks; do not force incompatible dependency resolution | Fixture uses the supported 3.7.0 peer and common query/auth APIs; widening the peer range remains a separate package release |
| Published 2.5.0 SignIn component does not compile on Astro 7 | Astro component maintainer | Tested fixture uses hosted auth routes and direct image component imports on patched Astro 7.3.2 | Product follow-up; no package patch or downgrade hidden in the fixture |
