# Run402 Full-Stack Integration Fixture

This fixture is intentionally product-neutral. It models a small Run402-hosted app so the live integration suite can exercise platform behavior across database migrations, exposed REST tables, static hosting, routed functions, direct functions, scheduled functions, secrets, blob storage, email, AI helpers, auth, and release observability.

Run it with:

```bash
npm run test:integration:fullstack
```

The suite is headless: it uses HTTP and API assertions only. It does not drive a browser, perform visual checks, or exercise any downstream app SDK/CLI surface.
