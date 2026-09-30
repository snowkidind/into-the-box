# Consonant Class — stats registry

A tiny Cloudflare Worker backed by one Durable Object (SQLite storage) that acts
as an **interest gauge**: it counts unique usernames and keeps each one's best
score. It is deliberately **not** a competitive leaderboard, and it is built to
stay small and to make spoofing easy to spot.

## API

- `POST /score` with `{ name, score }` → `{ ok, returning, best, totalUsers, throttled }`
- `GET /stats` → a paginated HTML page of users + daily activity (browse it directly)
- `GET /stats.json?page=N` → the same data as JSON

No IP addresses are ever stored or shown.

## How it resists spoofing (lightweight, by design)

- **Dedup by username.** The users table is keyed by name, so one name spamming
  the endpoint 10k times is **one row** with a high `hits` count — not 10k rows.
  Inflating the gauge requires many *distinct* names, which shows up as velocity.
- **Per-IP hourly caps.** One source may register at most `NEW_PER_IP_HR` new
  names and make `SUBS_PER_IP_HR` submissions per hour. The IP is SHA-256 hashed
  with a salt, kept only for the current hour, and never stored long-term.
- **Global circuit breaker.** No more than `GLOBAL_NEW_PER_HR` new names are
  accepted across all sources per hour.
- **Daily buckets.** New names and submissions are counted per day, so a spike
  (a burst of registrations) is visible on `/stats` — that is your provenance
  signal. Natural play trickles in; automation arrives in bursts.
- **LRU pruning.** The users table is capped at `MAX_USERS` (least-recently-seen
  pruned), so the Durable Object stays small no matter what.

The all-time unique count (`totalEver`) is monotonic; the table itself is the
pruned, most-relevant slice.

## Deploy

You already have a wrangler repo with other Durable Objects, so either deploy
this as its own Worker or merge the `Stats` class + routes into an existing one.

```sh
cd leaderboard-worker
npx wrangler secret put IP_SALT    # any random string; used only to hash IPs
npx wrangler deploy
```

Then:

1. Set `ALLOWED_ORIGINS` in `src/index.js` to your GitHub Pages origin
   (e.g. `https://<user>.github.io`). Keep the localhost entries for local dev.
2. Point the game at it by setting `STATS_URL` near the top of `js/game.js`:

   ```js
   const STATS_URL = "https://consonant-class-stats.<you>.workers.dev";
   ```

   Leave `STATS_URL = ""` and the game runs fine with no registry.

Visit `https://consonant-class-stats.<you>.workers.dev/stats` to see the numbers.

## Tuning

All limits are constants at the top of `src/index.js`: `MAX_USERS`, `PAGE_SIZE`,
`NEW_PER_IP_HR`, `SUBS_PER_IP_HR`, `GLOBAL_NEW_PER_HR`.
