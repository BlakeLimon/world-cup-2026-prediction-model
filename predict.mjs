#!/usr/bin/env node
// Predict any head-to-head from the calibrated ratings.
//   node predict.mjs brazil argentina            (neutral venue)
//   node predict.mjs usa mexico usa               (3rd arg = home team)
import { readFileSync } from "node:fs";
import { matchProb, formatAmericanOdds } from "./elo.mjs";

const { ratings } = JSON.parse(readFileSync(new URL("./data/elo-calibrated.json", import.meta.url), "utf8"));
const [a, b, home] = process.argv.slice(2);

if (!a || !b) {
  console.log("Usage: node predict.mjs <teamA> <teamB> [homeTeam]\n");
  console.log("Teams:\n  " + Object.keys(ratings).sort().join(", "));
  process.exit(0);
}
const ra = ratings[a], rb = ratings[b];
if (ra == null || rb == null) {
  console.error(`Unknown team: ${ra == null ? a : b}\nAvailable: ${Object.keys(ratings).sort().join(", ")}`);
  process.exit(1);
}
const hb = home === a ? 75 : home === b ? -75 : 0;
const p = matchProb(ra, rb, hb);
const bar = (x) => "█".repeat(Math.round(x * 30));
const odds = (x) => formatAmericanOdds(x).padStart(6);

console.log(`\n  ${a} (Elo ${ra})  vs  ${b} (Elo ${rb})${hb ? `   [${home} at home]` : "   [neutral]"}\n`);
console.log(`  ${"outcome".padEnd(16)}      ${"prob".padStart(5)}  ${"odds".padStart(6)}`);
console.log(`  ${a.padEnd(16)} win  ${(p.winA * 100).toFixed(1).padStart(5)}%  ${odds(p.winA)}  ${bar(p.winA)}`);
console.log(`  ${"draw".padEnd(16)}      ${(p.draw * 100).toFixed(1).padStart(5)}%  ${odds(p.draw)}  ${bar(p.draw)}`);
console.log(`  ${b.padEnd(16)} win  ${(p.winB * 100).toFixed(1).padStart(5)}%  ${odds(p.winB)}  ${bar(p.winB)}`);
console.log(`\n  expected goals:  ${p.expectedGoalsA.toFixed(2)} – ${p.expectedGoalsB.toFixed(2)}`);
console.log(`  (odds shown are fair / no-vig American moneyline)\n`);
console.log("  Full 48-team tournament title odds (50,000 sims, conditioned on real results): https://cup26matches.com");
