#!/usr/bin/env node
// compare.mjs — compare the model's fair odds against US sportsbook consensus
// and flag +EV value bets.
//   node compare.mjs                 (all listed World Cup matches)
//   node compare.mjs usa             (only matches involving a team)
//   node compare.mjs --ev 0.03       (override the EV threshold, default 0.02)
//
// Reads ODDS_API_KEY (and optional ODDS_REGIONS, default "us") from .env.
import { readFileSync } from "node:fs";
import { matchProb, formatAmericanOdds } from "./elo.mjs";
import {
  americanToDecimal,
  americanToImpliedProb,
  devig,
  evaluateBet,
} from "./oddsmath.mjs";

// ---- config / env -------------------------------------------------------

function loadEnv() {
  try {
    const txt = readFileSync(new URL("./.env", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* no .env — fall back to real environment */
  }
}
loadEnv();

const API_KEY = process.env.ODDS_API_KEY;
const REGIONS = process.env.ODDS_REGIONS || "us";
const SPORT = "soccer_fifa_world_cup";

if (!API_KEY) {
  console.error("Missing ODDS_API_KEY. Put it in a .env file:\n  ODDS_API_KEY=your_key_here");
  process.exit(1);
}

// ---- args ---------------------------------------------------------------

const args = process.argv.slice(2);
let evMin = 0.02;
const evIdx = args.indexOf("--ev");
if (evIdx !== -1) evMin = parseFloat(args[evIdx + 1]);
const filter = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--ev");

// ---- team-name matching -------------------------------------------------

const { ratings } = JSON.parse(
  readFileSync(new URL("./data/elo-calibrated.json", import.meta.url), "utf8")
);

// API display name → model key. Strip accents, punctuation, spaces → hyphens.
function norm(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[''.]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Known divergences where normalization alone won't line up.
const ALIAS = {
  "united-states": "usa",
  "korea-republic": "south-korea",
  "ir-iran": "iran",
  "cote-d-ivoire": "ivory-coast",
  czechia: "czech-republic",
  turkiye: "turkey",
  "congo-dr": "dr-congo",
  "democratic-republic-of-the-congo": "dr-congo",
};

function resolveTeam(name) {
  const n = norm(name);
  if (ratings[n] != null) return n;
  if (ALIAS[n] != null && ratings[ALIAS[n]] != null) return ALIAS[n];
  return null;
}

// ---- fetch --------------------------------------------------------------

const url =
  `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/` +
  `?apiKey=${API_KEY}&regions=${REGIONS}&markets=h2h&oddsFormat=american`;

const res = await fetch(url);
if (!res.ok) {
  console.error(`API error ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const remaining = res.headers.get("x-requests-remaining");
const matches = await res.json();

// ---- per-match comparison ----------------------------------------------

const unmatched = new Set();
const recommendations = [];
let shown = 0;

for (const match of matches) {
  const { home_team, away_team, bookmakers } = match;

  if (filter) {
    const f = norm(filter);
    if (norm(home_team) !== f && norm(away_team) !== f) continue;
  }

  const homeKey = resolveTeam(home_team);
  const awayKey = resolveTeam(away_team);
  if (!homeKey) unmatched.add(home_team);
  if (!awayKey) unmatched.add(away_team);
  if (!homeKey || !awayKey) continue;

  // Model fair probabilities (neutral venue — World Cup).
  const p = matchProb(ratings[homeKey], ratings[awayKey], 0);
  const outcomes = [
    { label: home_team, pModel: p.winA },
    { label: "Draw", pModel: p.draw },
    { label: away_team, pModel: p.winB },
  ];

  // Gather book prices per outcome: best price + de-vigged consensus.
  const best = {}; // label -> { american, decimal, book }
  const fairSamples = {}; // label -> [devigged prob per book]
  for (const o of outcomes) fairSamples[o.label] = [];

  for (const bk of bookmakers) {
    const mkt = bk.markets.find((m) => m.key === "h2h");
    if (!mkt) continue;
    const priced = {};
    for (const oc of mkt.outcomes) priced[oc.name] = oc.price;
    // Need all three to de-vig this book cleanly.
    if (outcomes.some((o) => priced[o.label] === undefined)) continue;

    const implied = outcomes.map((o) => americanToImpliedProb(priced[o.label]));
    const fair = devig(implied);
    outcomes.forEach((o, i) => {
      fairSamples[o.label].push(fair[i]);
      const dec = americanToDecimal(priced[o.label]);
      if (!best[o.label] || dec > best[o.label].decimal) {
        best[o.label] = { american: priced[o.label], decimal: dec, book: bk.title };
      }
    });
  }

  // Print the match table.
  const kickoff = new Date(match.commence_time).toLocaleString();
  console.log(`\n  ${home_team} vs ${away_team}   (${kickoff}, ${bookmakers.length} US books)`);
  console.log(
    `  ${"outcome".padEnd(16)} ${"model".padStart(6)} ${"fair".padStart(6)} ` +
      `${"mkt".padStart(6)} ${"best".padStart(7)} ${"book".padEnd(12)} ${"EV".padStart(7)}  verdict`
  );

  for (const o of outcomes) {
    const samples = fairSamples[o.label];
    if (!samples.length || !best[o.label]) continue;
    const pMarket = samples.reduce((s, x) => s + x, 0) / samples.length;
    const b = best[o.label];
    const { ev, value } = evaluateBet(o.pModel, pMarket, b.decimal, { evMin });
    const verdict = value ? "✅ VALUE" : "—";
    console.log(
      `  ${o.label.padEnd(16)} ` +
        `${(o.pModel * 100).toFixed(1).padStart(5)}% ` +
        `${formatAmericanOdds(o.pModel).padStart(6)} ` +
        `${(pMarket * 100).toFixed(1).padStart(5)}% ` +
        `${String(b.american > 0 ? "+" + b.american : b.american).padStart(7)} ` +
        `${b.book.padEnd(12)} ` +
        `${(ev * 100 >= 0 ? "+" : "") + (ev * 100).toFixed(1) + "%"}`.padStart(7) +
        `  ${verdict}`
    );
    if (value) {
      recommendations.push({
        match: `${home_team} vs ${away_team}`,
        bet: o.label,
        price: b.american > 0 ? "+" + b.american : "" + b.american,
        book: b.book,
        ev: ev,
      });
    }
  }
  shown++;
}

// ---- summary ------------------------------------------------------------

console.log("\n" + "─".repeat(70));
console.log(
  `  legend: model=model prob · fair=model fair odds · mkt=de-vigged book consensus · ` +
    `best=best US price · EV at best price`
);
console.log(`  ${shown} match(es) compared · EV threshold +${(evMin * 100).toFixed(0)}% · credits remaining: ${remaining}`);

if (recommendations.length) {
  console.log(`\n  ⭐ ${recommendations.length} VALUE BET(S):`);
  recommendations
    .sort((a, b) => b.ev - a.ev)
    .forEach((r) =>
      console.log(
        `   • ${r.bet} (${r.match}) @ ${r.price} on ${r.book}  →  +${(r.ev * 100).toFixed(1)}% EV`
      )
    );
} else {
  console.log(`\n  No value bets clear the +${(evMin * 100).toFixed(0)}% EV threshold right now.`);
}

if (unmatched.size) {
  console.log(`\n  ⚠ Unmatched team names (add to ALIAS in compare.mjs): ${[...unmatched].join(", ")}`);
}
console.log("");
