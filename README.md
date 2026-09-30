# Consonant Class

A small browser game for learning the three classes of Thai consonants —
**High**, **Middle**, and **Low**.

Thai consonants fall from the sky. Tap one to hear its voice, then drag it into
the box for its class. The line you draw is the path the tile follows on its way
to the box. It speeds up as you play, and three mistakes ends the game.

Tiles never stop coming and there is no cap. They drift down slowly at first —
about ten seconds to cross the playfield — and both the fall speed and the spawn
rate step up every ten seconds, so the board gradually backs up on you. Tiles are
rigid bodies: they collide and stack rather than overlapping. A box resolves a
tile the instant the tile touches its edge: right class scores, wrong class costs
a life, freezes the board for a beat, and flashes the class the tile really
belonged to (for example `ก = Middle Class`) while glowing the correct box. Steer
each tile into its box before it lands on the wrong one.

A perfect score is **9999**, which ends the game. A sound button (top-right)
cycles through all sound / voices only / muted. Enter a name once (kept in your
browser) and, if a stats registry is configured, your best score is recorded when
a game ends.

This is a web port of the *Into The Box* mode from **Thailes**, an iOS Thai
alphabet app. The tile art, the class boxes, and the consonant voice recordings
are the originals from that app; the movement, follow‑speed, box layout, and the
consonant‑class rules are ported directly from its source.

## Play

Open `index.html` from any static web server. For example:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

It needs a server (not `file://`) because the browser loads image and audio
assets over HTTP.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In **Settings → Pages**, set the source to your default branch, root (`/`).
3. Your game will be live at `https://<user>.github.io/<repo>/`.

The included `.nojekyll` file tells Pages to serve every file as‑is.

## How it works

| File | Role |
| --- | --- |
| `index.html` | Page shell, HUD, and start/game‑over overlay |
| `css/style.css` | Layout and styling |
| `js/data.js` | The 44 consonants: code point, character, class, and name |
| `js/game.js` | Canvas game loop, tile physics, path drawing, input, scoring |
| `assets/tiles/` | Consonant tiles — `{codepoint}.png` and `{codepoint}_hi.png` (highlighted) |
| `assets/boxes/` | The High / Middle / Low class boxes |
| `assets/bg/` | The illustrated Thai street-market background |
| `assets/audio/` | Male/female consonant voices (`F####.mp3`, `M####.mp3`) plus sound effects |
| `leaderboard-worker/` | Cloudflare Worker + Durable Object for the stats registry |

## Stats registry (optional)

Instead of a competitive leaderboard, the backend is a small **interest gauge**:
it counts unique usernames and each one's best score, and it's built to stay tiny
and to make spoofing easy to spot (dedup by name, per-IP hourly caps on a hashed
IP, daily activity buckets, and LRU pruning). Browse it at `/stats`. See
[`leaderboard-worker/`](leaderboard-worker/) for details and deploy steps.

Point the game at it by setting `STATS_URL` near the top of `js/game.js`; leave it
`""` and the game runs fine with nothing to save to. On a game end the browser
submits the stored name + score once, and the overlay shows how many players have
tried the game.

Tiles are keyed by their Thai Unicode code point (ก = U+0E01 = 3585), the same
scheme the original app used. A consonant's class comes straight from the
original lookup table: an explicit Middle‑class and High‑class list, with every
other consonant treated as Low class.

### Consonant classes (verified)

All 44 consonants were cross‑checked against authoritative references
(Wikipedia and Thai‑learning sources), and every one is placed in the correct
box. The middle (9) and high (11) lists are defined explicitly; low (24) is
everything else.

| Class | Count | Consonants |
| --- | --- | --- |
| **Middle** | 9 | ก จ ฎ ฏ ด ต บ ป อ |
| **High** | 11 | ข ฃ ฉ ฐ ถ ผ ฝ ศ ษ ส ห |
| **Low** | 24 | ค ฅ ฆ ง ช ซ ฌ ญ ฑ ฒ ณ ท ธ น พ ฟ ภ ม ย ร ล ว ฬ ฮ |

The commonly‑confused letters are all correct: the "tho" group **ฐ ถ** are high
while **ฑ ฒ ท ธ** are low; the retroflex pair **ฎ ฏ** are middle (not low);
**ห** is high but **ฮ** is low; **อ** is middle; **ฬ** is low. The two obsolete
letters are included and placed right — **ฃ** (kho khuat) is high and **ฅ**
(kho khon) is low. Counts of "10 high / 23 low" seen elsewhere simply omit those
two obsolete letters; including them gives 9 / 11 / 24.

Sources:
[Wikipedia — Kho khuat](https://en.wikipedia.org/wiki/Kho_khuat) ·
[ThailandStarterKit](https://www.thailandstarterkit.com/learn-thai/thai-alphabet-consonants-and-vowels/) ·
[ExpatDen](https://expatden.com/thailand/how-to-learn-thai-alphabet/) ·
[Transparent Language Thai blog](https://blogs.transparent.com/thai/?p=1448)

### Movement

Each tile follows a list of waypoints toward the next one at a fixed speed
(80 px/s, from the original). Dragging appends the points you trace as
waypoints, so the tile chases your finger and the drawn line *is* its route.
Release over a box and the tile homes in; if its class matches you score, and if
it does not you lose a life.

There are two timings, both in `js/game.js`: the **drop time** (`DROP_SECONDS`,
10s top to box row at the start) and the **spawn rate** (`SPAWN_SECONDS`, 6s
between tiles at the start). A single clock drives both — every `SPEEDUP_EVERY`
seconds a shared multiplier grows by `SPEEDUP_STEP`, shortening the drop time and
the spawn interval together, so difficulty climbs on a clock rather than with
your score. A box "invalidates" a tile the moment their rectangles touch, so a
tile that reaches a box on its own resolves immediately — usually against you.

## Credits

- Original game, art, and voice recordings: **Thailes** (Art Of Communication, Inc.).
- Consonant voices recorded by two native speakers (alternating each tap).

## License

Code is released under the [MIT License](LICENSE). The original tile artwork and
voice recordings are included with permission of the Thailes authors; if you
fork this project, keep the attribution above.
