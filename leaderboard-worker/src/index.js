/*
 * Consonant Class — unique-user registry + interest gauge.
 *
 * This is NOT a competitive leaderboard. It is a small, self-pruning counter of
 * unique usernames plus their best score, designed so that spoofing is easy to
 * spot (by velocity) and cannot bloat storage.
 *
 * Routes:
 *   POST /score        body { name, score }  -> { ok, returning, best, totalUsers }
 *   GET  /stats        -> paginated HTML view of users + daily activity (no IPs)
 *   GET  /stats.json   -> same data as JSON  (?page=N)
 *
 * Anti-spoofing model (deliberately lightweight):
 *   - The users table is keyed by name, so one name spamming = one row (its hit
 *     count just goes up). To inflate the gauge you need many distinct names.
 *   - Per-IP hourly caps limit how fast one source can register new names or
 *     submit at all. The IP is hashed with a salt, kept only for the current
 *     hour, and never stored long-term or shown anywhere.
 *   - A global hourly cap on new registrations is a circuit breaker against a
 *     botnet flood.
 *   - Daily buckets record new users / submissions per day, so an unnatural
 *     spike is visible on /stats — that is your provenance signal.
 *   - The users table is LRU-pruned to MAX_USERS, so the DO stays small.
 */

import { DurableObject } from "cloudflare:workers";

const MAX_SCORE = 9999;
const MAX_USERS = 5000;         // hard cap on retained rows (LRU prune)
const PAGE_SIZE = 50;           // /stats page size
const NEW_PER_IP_HR = 5;        // new usernames one IP may register per hour
const SUBS_PER_IP_HR = 60;      // total submissions one IP may make per hour
const GLOBAL_NEW_PER_HR = 200;  // circuit breaker: new usernames across all IPs / hour

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
  }

  ensureSchema() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY, best INTEGER, first_seen INTEGER, last_seen INTEGER, hits INTEGER
    );`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily (
      day TEXT PRIMARY KEY, new_users INTEGER, submissions INTEGER
    );`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rl (
      k TEXT PRIMARY KEY, subs INTEGER, news INTEGER, hour INTEGER
    );`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER);`);
  }

  // wipe everything (guarded admin action)
  reset() {
    for (const t of ["users", "daily", "rl", "meta"]) this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
    this.ensureSchema();
    return { ok: true };
  }

  meta(k) {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray();
    return r.length ? Number(r[0].v) : 0;
  }
  setMeta(k, v) { this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, v); }
  totalUsers() { return this.meta("total_ever"); }

  submit(rawName, rawScore, iphash) {
    const name = String(rawName ?? "").replace(/\s+/g, " ").trim().slice(0, 16) || "Anonymous";
    const score = Math.max(0, Math.min(MAX_SCORE, Math.floor(Number(rawScore) || 0)));
    const now = Date.now();
    const hour = Math.floor(now / 3600000);
    const day = new Date(now).toISOString().slice(0, 10);

    // per-IP rate-limit bucket for the current hour
    let rl = this.sql.exec(`SELECT subs, news, hour FROM rl WHERE k = ?`, iphash).toArray()[0];
    if (!rl || Number(rl.hour) !== hour) rl = { subs: 0, news: 0, hour };
    if (Number(rl.subs) >= SUBS_PER_IP_HR) {
      return { ok: false, throttled: true, totalUsers: this.totalUsers() };
    }
    rl.subs = Number(rl.subs) + 1;

    const existing = this.sql.exec(`SELECT best FROM users WHERE name = ?`, name).toArray()[0];

    if (existing) {
      const best = Math.max(Number(existing.best), score);
      this.sql.exec(`UPDATE users SET best = ?, last_seen = ?, hits = hits + 1 WHERE name = ?`,
        best, now, name);
      this.bumpDaily(day, 0);
      this.saveRl(iphash, rl);
      return { ok: true, returning: true, best, rank: this.rankFor(best), totalUsers: this.totalUsers() };
    }

    // new username — apply the new-registration caps
    if (Number(rl.news) >= NEW_PER_IP_HR) {
      return { ok: false, throttled: true, totalUsers: this.totalUsers() };
    }
    const gkey = "gnew:" + hour;
    const gnew = this.meta(gkey);
    if (gnew >= GLOBAL_NEW_PER_HR) {
      return { ok: false, throttled: true, global: true, totalUsers: this.totalUsers() };
    }

    this.sql.exec(`INSERT INTO users (name, best, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, 1)`,
      name, score, now, now);
    rl.news = Number(rl.news) + 1;
    this.setMeta(gkey, gnew + 1);
    const total = this.totalUsers() + 1;
    this.setMeta("total_ever", total);
    this.bumpDaily(day, 1);
    this.saveRl(iphash, rl);

    this.pruneUsers();
    this.pruneEphemeral(hour, gkey);

    return { ok: true, returning: false, best: score, rank: this.rankFor(score), totalUsers: total };
  }

  // rank by best score among retained users (ties share the better rank)
  rankFor(best) {
    return Number(this.sql.exec(`SELECT COUNT(*) AS c FROM users WHERE best > ?`, best).one().c) + 1;
  }

  bumpDaily(day, isNew) {
    this.sql.exec(
      `INSERT INTO daily (day, new_users, submissions) VALUES (?, ?, 1)
       ON CONFLICT(day) DO UPDATE SET new_users = new_users + ?, submissions = submissions + 1`,
      day, isNew, isNew
    );
  }
  saveRl(iphash, rl) {
    this.sql.exec(`INSERT OR REPLACE INTO rl (k, subs, news, hour) VALUES (?, ?, ?, ?)`,
      iphash, rl.subs, rl.news, rl.hour);
  }
  pruneUsers() {
    const c = Number(this.sql.exec(`SELECT COUNT(*) AS c FROM users`).one().c);
    if (c > MAX_USERS) {
      this.sql.exec(
        `DELETE FROM users WHERE name IN (
           SELECT name FROM users ORDER BY last_seen ASC, first_seen ASC LIMIT ?
         )`, c - MAX_USERS);
    }
  }
  pruneEphemeral(hour, gkey) {
    this.sql.exec(`DELETE FROM rl WHERE hour < ?`, hour);
    this.sql.exec(`DELETE FROM meta WHERE k LIKE 'gnew:%' AND k != ?`, gkey);
  }

  stats(page) {
    page = Math.max(0, Math.floor(Number(page) || 0));
    const retained = Number(this.sql.exec(`SELECT COUNT(*) AS c FROM users`).one().c);
    const pages = Math.max(1, Math.ceil(retained / PAGE_SIZE));
    const users = this.sql.exec(
      `SELECT name, best, last_seen, hits FROM users
       ORDER BY best DESC, last_seen DESC LIMIT ? OFFSET ?`,
      PAGE_SIZE, page * PAGE_SIZE
    ).toArray();
    const daily = this.sql.exec(
      `SELECT day, new_users, submissions FROM daily ORDER BY day DESC LIMIT 21`
    ).toArray();
    return { totalEver: this.totalUsers(), retained, page, pages, pageSize: PAGE_SIZE, users, daily };
  }
}

// ---- Worker ------------------------------------------------------------

const ALLOWED_ORIGINS = [
  "https://snowkidind.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(salt + "|" + (ip || "0.0.0.0"));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statsHtml(d) {
  const rows = d.users.map((u, i) => {
    const rank = d.page * d.pageSize + i + 1;
    const seen = new Date(Number(u.last_seen)).toISOString().slice(0, 10);
    return `<tr><td class="r">${rank}</td><td>${esc(u.name)}</td><td class="s">${u.best}</td>` +
           `<td class="d">${seen}</td><td class="h">${u.hits}</td></tr>`;
  }).join("");
  const daily = d.daily.map((x) =>
    `<tr><td>${esc(x.day)}</td><td class="s">${x.new_users}</td><td>${x.submissions}</td></tr>`
  ).join("");
  const pager = [];
  if (d.page > 0) pager.push(`<a href="?page=${d.page - 1}">&larr; prev</a>`);
  pager.push(`<span>page ${d.page + 1} / ${d.pages}</span>`);
  if (d.page + 1 < d.pages) pager.push(`<a href="?page=${d.page + 1}">next &rarr;</a>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consonant Class — stats</title>
<style>
  body{margin:0;background:#20241a;color:#f4f1e4;font:15px/1.5 "Trebuchet MS",system-ui,sans-serif;padding:24px}
  .wrap{max-width:720px;margin:0 auto}
  h1{color:#ffd640;font-size:22px;margin:0 0 4px}
  .sub{opacity:.7;margin:0 0 20px;font-size:13px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 24px}
  .card{background:rgba(255,255,255,.06);border-radius:10px;padding:12px 16px;min-width:120px}
  .card b{display:block;font-size:24px;color:#ffd640}
  .card span{font-size:12px;opacity:.7;text-transform:uppercase;letter-spacing:1px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#ffd640;margin:24px 0 8px}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08)}
  th{opacity:.6;font-weight:normal;font-size:12px;text-transform:uppercase}
  td.r,td.s,td.h,td.d{text-align:right;white-space:nowrap}
  td.s{color:#ffd640;font-weight:bold}
  .pager{display:flex;gap:16px;align-items:center;margin:16px 0;opacity:.9}
  .pager a{color:#ffd640}
  .note{opacity:.6;font-size:12px;margin-top:24px}
</style></head><body><div class="wrap">
<h1>Consonant Class — stats</h1>
<p class="sub">Unique usernames and their best score. No IP addresses are stored.</p>
<div class="cards">
  <div class="card"><b>${d.totalEver}</b><span>unique names (all time)</span></div>
  <div class="card"><b>${d.retained}</b><span>retained (top ${MAX_USERS})</span></div>
</div>
<h2>Users</h2>
<table><thead><tr><th class="r">#</th><th>name</th><th class="s">best</th><th class="d">last seen</th><th class="h">hits</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">No users yet.</td></tr>'}</tbody></table>
<div class="pager">${pager.join(" ")}</div>
<h2>Activity by day</h2>
<table><thead><tr><th>day</th><th class="s">new names</th><th>submissions</th></tr></thead>
<tbody>${daily || '<tr><td colspan="3">No activity yet.</td></tr>'}</tbody></table>
<p class="note">A high <em>hits</em> count or a sudden spike in new names is the provenance signal:
natural play trickles in, automated spoofing arrives in bursts.</p>
</div></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    const stub = env.STATS.get(env.STATS.idFromName("global"));

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/score" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const ip = request.headers.get("CF-Connecting-IP") || "";
        const iphash = await hashIp(ip, env.IP_SALT || "consonant-class");
        const result = await stub.submit(body.name, body.score, iphash);
        return new Response(JSON.stringify(result), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/reset" && request.method === "POST") {
        if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
          return new Response("forbidden", { status: 403 });
        }
        return new Response(JSON.stringify(await stub.reset()), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/stats" && request.method === "GET") {
        const data = await stub.stats(url.searchParams.get("page"));
        return new Response(statsHtml(data), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/stats.json" && request.method === "GET") {
        const data = await stub.stats(url.searchParams.get("page"));
        return new Response(JSON.stringify(data), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
