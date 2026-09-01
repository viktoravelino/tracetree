# metrics

Machine-written data, not code. `.github/workflows/metrics.yml` on `main`
appends here once a day; nothing on this branch is ever merged anywhere.

It exists because GitHub's traffic API only keeps 14 days, so views and clones
are a rolling window rather than a record. Whatever is here is the record.

| file | shape |
| --- | --- |
| `data/github.json` | `views` / `clones` keyed by date, plus a daily `repo` count of stars, forks and watchers |
| `data/npm.json` | downloads keyed by date |
| `data/referrers.ndjson` | one line per run: the top referrers and paths at that moment, which are top-N lists rather than a per-day series |

Dates merge by overwrite. Each source revises its most recent, still-partial day,
so the newest snapshot of a date wins.
