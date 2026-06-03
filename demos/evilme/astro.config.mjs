// The entire Astro config. The run402() preset is the whole thing — it wires the
// run402 SSR adapter (Lambda + SnapStart + ISR cache + AsyncLocalStorage request
// context so auth()/db()/assets() resolve), the image-variant pipeline, and the
// hosted-auth components. See https://run402.com and @run402/astro's README.
import run402 from "@run402/astro";

export default run402();
