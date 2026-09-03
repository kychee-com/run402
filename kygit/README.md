# kygit

The encrypted Git remote's command — [kygit.com](https://kygit.com).

```
npm i -g @kychee/kygit
kygit create              # provision the vault, scaffold the remote
git push origin main      # encrypted on your machine, published as a signed head
```

**One package, one install.** `kygit create` scaffolds the remote as
`kygit::<org>/<name>` — a git remote scheme this package owns end to end,
including its own remote helper (`git-remote-kygit`, a second bin this
package installs alongside `kygit`). `git push`/`git fetch` are plain git;
git finds `kygit::` remotes by spawning `git-remote-kygit` from PATH, and
npm links every bin of the package you install *directly* — so
`npm i -g @kychee/kygit` alone is enough. (The underlying vault is the same
`run402 repos` substrate either way: a checkout made with `kygit create`
and one made with `run402 repos create` push to the same place, one
spelled `kygit::`, the other `run402::` — see "What this package is" below.)

(The package is scoped because npm's typosquat guard reserves the bare
name — it is one letter from `degit`. The command you get is still
`kygit`.)

**Run402 cannot decrypt your gitvault or repository history.** The full,
graded claims — including every limit — live at
[kygit.com](https://kygit.com) and
[run402.com/gitvault](https://run402.com/gitvault).

## What this package is (and isn't)

`kygit` is a **thin brand door over `run402 repos`** — it exists so the
name on the box matches the name on the site, and nothing else:

- Every kygit command **is** a run402 command: `kygit <verb>` executes
  `run402 repos <verb>` verbatim (same flags, same output, same exit
  codes). `kygit login` executes `run402 operator login --loopback`.
- The verb table is **derived at runtime** from the installed `run402`
  package's own `gitvault-surface.json` — the same machine-readable
  contract file that gates the marketing pages — so this shim can never
  drift from the canonical CLI. New client verbs work here without a
  `kygit` release.
- Anything outside the repo family is refused with the exact `run402 …`
  spelling to use instead. There is no second semantic CLI and no separate
  API — only a second remote scheme.
- `kygit` renders every remote it scaffolds or prints as `kygit::<org>/<name>`;
  `run402 repos` renders the same address as `run402::<org>/<name>`. Both
  spellings resolve the same vault, and neither tool ever rewrites a remote
  the other one wrote — pick whichever spelling you want to see in
  `git remote -v`.

| kygit | canonical |
|---|---|
| `kygit create` | `run402 repos create` |
| `kygit view` | `run402 repos view` |
| `kygit mirror s3://your-bucket` | `run402 repos mirror s3://your-bucket` |
| `kygit recover ./mirror` | `run402 repos recover ./mirror` |
| `kygit handoff` | `run402 repos handoff` |
| `kygit resume kgh1_…` | `run402 repos resume kgh1_…` |

After `kygit resume` you are a writer of the vault under your own key — `git push` works at once, and the sender's machine can be gone.
| `kygit login` | `run402 operator login --loopback` |

Agents: your canonical reference is
[run402.com/llms-full.txt](https://run402.com/llms-full.txt) (section
"gitvault") and the `run402` CLI — this package adds no surface for you.

By [Kychee](https://kychee.com) · Built on [run402](https://run402.com)
