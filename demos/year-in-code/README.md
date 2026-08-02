# Run402 — One Year in Code

An immersive Three.js reconstruction of the last twelve completed calendar
months of any public GitHub repository.

Live on Run402: <https://year-in-code.run402.com>

- Every commit becomes an instanced architectural module and raises the tower's cumulative-commit Y axis.
- Every module is colored by its contributor, with interactive crew isolation.
- Branch refs leave their tip commits as luminous skyways.
- Every GitHub issue opening ruptures the structure in 3D; closures pull the debris home into luminous kintsugi repairs.
- A deterministic Web Audio synth score grows from a sparse foundation pulse into a crystalline arpeggio, with sub-bass ruptures and glassy repair chimes synchronized to issue events.
- Contributor mode is the default view, adds GitHub/Gravatar portraits, and runs a live leaderboard whose counts and rankings follow the commit timeline.
- Every generated tower has a canonical repository-specific share link.
- Every cached repository joins a traversable Run402 skyline. The current detailed tower anchors the city center; tap a landmark, use the tour controls, pan on touch, or roam with the arrow/WASD keys before entering another repository.

The browser calls the same-origin `/api/repo-snapshot?repo=owner/name` route. A
Run402 Node 22 function reads public GitHub REST data, transforms it into the
tower's JSON model, and caches it in Postgres for the entire calendar month.
The same function exposes a compact skyline feed from those cached snapshots,
so city traversal adds no GitHub recalculation and no full commit payloads.
Snapshots always end at the previous month boundary: a request during July
2026 covers July 1, 2025 through June 30, 2026 and remains unchanged until
August.

Commit history is sampled from the default branch, while all current public
branch tips deform the tower. Large repositories are capped at 3,000 commits,
300 branches, and 500 issues. Frank Fiegel is excluded from commits and
contributors. Contributor identities are hashed before export; raw email
addresses are never shipped to the browser. Linked GitHub accounts use their
public GitHub avatar; unmatched Git identities use a SHA-256 Gravatar URL with
an identicon fallback.

## Run locally

```sh
npm install
npm run dev
```

## Production build

```sh
npm run build
```

## Publish to Run402

The deploy script tests and builds the demo, then lets `run402 up` provision or
select a project and deploy the site, function, route, and monthly snapshot
table from the manifest. It never contains or targets the live demo's project
ID.

```sh
npm run deploy
```

The GitHub API works anonymously for public repositories. For higher rate
limits, set a `GITHUB_TOKEN` function secret on your Run402 project.
