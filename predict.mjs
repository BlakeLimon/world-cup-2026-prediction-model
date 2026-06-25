#!/usr/bin/env node
// Predict any head-to-head from the calibrated ratings, with optional
// situational adjustments (host/altitude/rest/weather).
//   node predict.mjs brazil argentina                         (neutral venue)
//   node predict.mjs usa mexico usa                            (3rd arg = home team)
//   node predict.mjs mexico germany --venue "mexico city"      (altitude + host)
//   node predict.mjs spain italy --rest 5,2 --venue dallas --weather
import { readFileSync } from "node:fs";
import { matchProb, scoreMatrix, firstHalfMatrix, spreadProb, formatAmericanOdds } from "./elo.mjs";
import { matchAdjustments, venueOf, weatherGoalsFactor } from "./adjustments.mjs";

const { ratings } = JSON.parse(readFileSync(new URL("./data/elo-calibrated.json", import.meta.url), "utf8"));

// Parse positional args + --flags.
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (t.startsWith("--")) flags[t.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  else pos.push(t);
}
const [a, b, home] = pos;

if (!a || !b) {
  console.log("Usage: node predict.mjs <teamA> <teamB> [homeTeam] [--venue <city>] [--rest H,A] [--weather]\n");
  console.log("Teams:\n  " + Object.keys(ratings).sort().join(", "));
  process.exit(0);
}
const ra0 = ratings[a], rb0 = ratings[b];
if (ra0 == null || rb0 == null) {
  console.error(`Unknown team: ${ra0 == null ? a : b}\nAvailable: ${Object.keys(ratings).sort().join(", ")}`);
  process.exit(1);
}

const venue = flags.venue ? venueOf(flags.venue) : null;
if (flags.venue && !venue) {
  console.error(`Unknown venue: ${flags.venue}. Known: see data/venues.json`);
  process.exit(1);
}
let restHome = null, restAway = null;
if (flags.rest) { const [rh, raw] = String(flags.rest).split(","); restHome = +rh; restAway = +raw; }

// Situational adjustments (Elo deltas) — all tuned estimates, not backtested.
const adj = matchAdjustments({ homeKey: a, awayKey: b, venue, restHome, restAway });
const ra = ra0 + adj.adjHome, rb = rb0 + adj.adjAway;
const hb = home === a ? 75 : home === b ? -75 : 0;
const p = matchProb(ra, rb, hb);

const bar = (x) => "█".repeat(Math.round(x * 30));
const odds = (x) => formatAmericanOdds(x).padStart(6);
const showAdj = (r0, r) => (r !== r0 ? ` → ${r}` : "");

const venueStr = venue ? `   @ ${venue.stadium}${venue.altitudeM > 1200 ? ` (${venue.altitudeM}m)` : ""}` : hb ? `   [${home} at home]` : "   [neutral]";
console.log(`\n  ${a} (Elo ${ra0}${showAdj(ra0, ra)})  vs  ${b} (Elo ${rb0}${showAdj(rb0, rb)})${venueStr}\n`);
if (adj.notes.length) console.log(`  adjustments: ${adj.notes.join(" · ")}\n`);
console.log(`  ${"outcome".padEnd(16)}      ${"prob".padStart(5)}  ${"odds".padStart(6)}`);
console.log(`  ${a.padEnd(16)} win  ${(p.winA * 100).toFixed(1).padStart(5)}%  ${odds(p.winA)}  ${bar(p.winA)}`);
console.log(`  ${"draw".padEnd(16)}      ${(p.draw * 100).toFixed(1).padStart(5)}%  ${odds(p.draw)}  ${bar(p.draw)}`);
console.log(`  ${b.padEnd(16)} win  ${(p.winB * 100).toFixed(1).padStart(5)}%  ${odds(p.winB)}  ${bar(p.winB)}`);
console.log(`\n  expected goals:  ${p.expectedGoalsA.toFixed(2)} – ${p.expectedGoalsB.toFixed(2)}`);
console.log(`  (odds shown are fair / no-vig American moneyline)`);

// Full-time spreads (goal handicaps) — a validated market.
const ft = scoreMatrix(ra, rb, hb).matrix;
const sp = (line, side) => { const s = spreadProb(ft, line); return side === "home" ? s.homeCover : s.awayCover; };
console.log(`\n  spreads (fair):`);
for (const [label, line, side] of [[`${a} -1.5`, -1.5, "home"], [`${a} +1.5`, 1.5, "home"], [`${b} -1.5`, 1.5, "away"], [`${b} +1.5`, -1.5, "away"]]) {
  const pr = sp(line, side);
  console.log(`  ${label.padEnd(18)} ${(pr * 100).toFixed(1).padStart(5)}%  ${odds(pr)}`);
}

// First-half 1X2 — APPROXIMATION (~45% goal split; unvalidated).
const fh = firstHalfMatrix(ra, rb, hb).matrix;
let fw = 0, fd = 0, fl = 0;
for (let i = 0; i < fh.length; i++) for (let j = 0; j < fh.length; j++) { const q = fh[i][j]; if (i > j) fw += q; else if (i < j) fl += q; else fd += q; }
console.log(`\n  first half (approx, unvalidated):`);
console.log(`  ${(a + " win").padEnd(18)} ${(fw * 100).toFixed(1).padStart(5)}%  ${odds(fw)}`);
console.log(`  ${"draw".padEnd(18)} ${(fd * 100).toFixed(1).padStart(5)}%  ${odds(fd)}`);
console.log(`  ${(b + " win").padEnd(18)} ${(fl * 100).toFixed(1).padStart(5)}%  ${odds(fl)}`);

// Weather (optional, needs --venue) — informational; mainly affects totals.
if (flags.weather && venue) {
  const w = await weatherGoalsFactor(venue, flags.date ? String(flags.date) : new Date().toISOString());
  console.log(`\n  weather: ${w.notes.join(", ")}  → goals ×${w.factor.toFixed(2)} (totals effect; not bet)`);
}
console.log("");
