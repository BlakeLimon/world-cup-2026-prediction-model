#!/usr/bin/env node
// compare.mjs — compare the model's fair odds against US sportsbook consensus
// and flag +EV value bets (with the trust guardrail).
//   node compare.mjs                 (all listed World Cup matches)
//   node compare.mjs usa             (only matches involving a team)
//   node compare.mjs --ev 0.03       (override the EV threshold, default 0.02)
//
// Reads ODDS_API_KEY (and optional ODDS_REGIONS, default "us") from .env.
import { formatAmericanOdds } from "./elo.mjs";
import {
  loadEnv,
  loadRatings,
  norm,
  fetchOdds,
  evaluateMatch,
  TRUST_MIN,
  TRUST_MAX,
  EDGE_CAP,
} from "./value.mjs";

loadEnv();
const API_KEY = process.env.ODDS_API_KEY;
const REGIONS = process.env.ODDS_REGIONS || "us";
if (!API_KEY) {
  console.error("Missing ODDS_API_KEY. Put it in a .env file:\n  ODDS_API_KEY=your_key_here");
  process.exit(1);
}

const args = process.argv.slice(2);
let evMin = 0.02;
const evIdx = args.indexOf("--ev");
if (evIdx !== -1) evMin = parseFloat(args[evIdx + 1]);
const filter = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--ev");

const ratings = loadRatings();
const { matches, remaining } = await fetchOdds({ apiKey: API_KEY, regions: REGIONS });
matches.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

const signSym = (a) => (a > 0 ? "+" + a : "" + a);
const unmatched = new Set();
const recommendations = [];
let shown = 0;

for (const match of matches) {
  if (filter) {
    const f = norm(filter);
    if (norm(match.home_team) !== f && norm(match.away_team) !== f) continue;
  }
  const r = evaluateMatch(match, ratings, { evMin, unmatched });
  if (!r) continue;

  const kickoff = new Date(r.kickoff).toLocaleString();
  console.log(`\n  ${r.home} vs ${r.away}   (${kickoff}, ${r.bookCount} US books)`);
  console.log(
    `  ${"outcome".padEnd(16)} ${"model".padStart(6)} ${"fair".padStart(6)} ` +
      `${"mkt".padStart(6)} ${"best".padStart(7)} ${"book".padEnd(12)} ${"EV".padStart(7)}  verdict`
  );
  for (const row of r.rows) {
    const verdict = row.verdict === "value" ? "✅ VALUE" : row.verdict === "outlier" ? "⚠ outlier" : "—";
    console.log(
      `  ${row.label.padEnd(16)} ` +
        `${(row.pModel * 100).toFixed(1).padStart(5)}% ` +
        `${formatAmericanOdds(row.pModel).padStart(6)} ` +
        `${(row.pMarket * 100).toFixed(1).padStart(5)}% ` +
        `${signSym(row.american).padStart(7)} ` +
        `${row.book.padEnd(12)} ` +
        `${(row.ev * 100 >= 0 ? "+" : "") + (row.ev * 100).toFixed(1) + "%"}`.padStart(7) +
        `  ${verdict}`
    );
    if (row.value)
      recommendations.push({
        match: `${r.home} vs ${r.away}`,
        bet: row.label,
        price: signSym(row.american),
        book: row.book,
        ev: row.ev,
      });
  }
  shown++;
}

console.log("\n" + "─".repeat(70));
console.log(
  `  legend: model=model prob · fair=model fair odds · mkt=de-vigged book consensus · ` +
    `best=best US price · EV at best price`
);
console.log(
  `  ✅ VALUE = +EV and within trust band · ⚠ outlier = +EV but model disagrees too far ` +
    `(consensus outside ${TRUST_MIN * 100}–${TRUST_MAX * 100}% or edge > ${EDGE_CAP * 100}pts) — not a bet`
);
console.log(`  ${shown} match(es) compared · EV threshold +${(evMin * 100).toFixed(0)}% · credits remaining: ${remaining}`);

if (recommendations.length) {
  console.log(`\n  ⭐ ${recommendations.length} VALUE BET(S):`);
  recommendations
    .sort((a, b) => b.ev - a.ev)
    .forEach((r) =>
      console.log(`   • ${r.bet} (${r.match}) @ ${r.price} on ${r.book}  →  +${(r.ev * 100).toFixed(1)}% EV`)
    );
} else {
  console.log(`\n  No value bets clear the +${(evMin * 100).toFixed(0)}% EV threshold right now.`);
}
if (unmatched.size) {
  console.log(`\n  ⚠ Unmatched team names (add to ALIAS in value.mjs): ${[...unmatched].join(", ")}`);
}
console.log("");
