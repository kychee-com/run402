import run402 from "@run402/astro";

// Server output with the Run402 adapter. The image integration is off: this
// fixture uploads nothing and needs no project.
export default run402({ images: false });
