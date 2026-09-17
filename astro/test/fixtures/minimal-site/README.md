# Minimal image integration fixture

This is an incomplete internal test fixture, not a runnable starter app. It contains an Astro config and an image page; the image binaries and standalone dependency setup are intentionally absent.

Image-transform, AssetRef and rendering behavior are covered by the current tests under `astro/src/`. A complete build test would need generated JPEG, HEIC and PNG inputs, a stub asset service and an installed Astro toolchain before inspecting the rendered picture/img output. Do not claim that an end-to-end build ran from this directory.

For a supported application starting point, use `run402 init astro --help` and follow the [Astro guide](https://docs.run402.com/build/astro/).
