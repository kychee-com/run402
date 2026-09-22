# Static site + `/_run402/config.js`

The smallest runnable example of a static page that reads its own project keys
from the host it is served on — no key pasted into the HTML.

- `run402.json` — a v2 release manifest: two migrations (create a `notes` table,
  seed one row), expose `notes` to the browser with the `public_read_authenticated_write`
  policy (anyone can read; only authenticated users can write), and one site file.
- `index.html` — loads `<script src="/_run402/config.js"></script>`, which defines
  `window.RUN402 = { project_id, api_base, anon_key }` for whatever project the
  page was loaded from, then fetches `${api_base}/rest/v1/notes?select=*` with the
  `apikey` and `Authorization: Bearer <anon_key>` headers.

Deploy from this directory:

```sh
npm install -g run402@latest
run402 up --name <name> -y
```

`run402 up --name <name> -y` claims the `<name>` host automatically, so the
manifest carries no `subdomains` block; `up` also creates the allowance, funds it
from the testnet faucet, sets the free prototype tier, and creates the
project on a cold machine. The result's `urls.site` is `https://<name>.run402.com`;
open it and the seeded note renders. A branch host or a transferred project
serves the same HTML with its own `window.RUN402` values.

`/_run402/` is reserved on every host: `/_run402/config.json` returns the same
object as JSON, and a site file, route, or public path under that prefix is
rejected at plan time. The service key is never served there.
