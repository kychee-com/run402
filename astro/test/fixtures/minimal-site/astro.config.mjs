import { defineConfig } from "astro/config";
import { run402 } from "@run402/astro";

/**
 * Fixture configuration for the @run402/astro integration tests.
 *
 * In a real integration test runner, the test fixture would set
 * RUN402_PROJECT_ID via the environment or pass it explicitly here. The
 * integration validates the project ID at config:setup time.
 */
export default defineConfig({
  integrations: [
    run402({
      projectId: process.env.RUN402_PROJECT_ID ?? "prj_fixture_replace_me",
      assetPrefix: "fixture-images/",
      verbose: true,
    }),
  ],
});
