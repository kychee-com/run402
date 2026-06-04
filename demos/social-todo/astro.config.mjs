// The entire Astro config. run402() wires the SSR adapter (Lambda + SnapStart +
// ISR cache + AsyncLocalStorage request context so auth()/db() resolve) and the
// hosted-auth components. Needs RUN402_PROJECT_ID at build time (deploy.ts sets
// it); see https://run402.com.
import run402 from "@run402/astro";

export default run402();
