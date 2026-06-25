#!/usr/bin/env node
// histbacktest.mjs — backtest the value engine against real pre-game odds +
// final scores transcribed into data/hist-odds.json. Reuses the exact same
// evaluateMatch() the live tools use (de-vig consensus across books, best price,
// trust guardrail), then grades each flagged value bet at a flat 1-unit stake.
//   node histbacktest.mjs
import { readFileSync } from "node:fs";
import { loadRatings, evaluateMatch } from "./value.mjs";

const ratings = loadRatings();
const { games } = JSON.parse(
  readFileSync(new URL("./data/hist-odds.json", import.meta.url), "utf8")
);

// Turn a transcribed game into the API match shape evaluateMatch expects.
function toMatch(g) {
  const bookmakers = Object.entries(g.books)
    .filter(([, v]) => v && v.every((x) => typeof x === "number"))
    .map(([title, [h, a, d]]) => ({
      title,
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: g.home, price: h },
            { name: g.away, price: a },
            { name: "Draw", price: d },
          ],
        },
      ],
    }));
  return {
    id: `${g.date}:${g.home}:${g.away}`,
    home_team: g.home,
    away_team: g.away,
    commence_time: g.date,
    bookmakers,
  };
}

const sign = (a) => (a > 0 ? "+" + a : "" + a);
const pct = (x) => (x * 100).toFixed(1) + "%";

const bets = [];
let topHits = 0,
  graded = 0,
  unmatchedAny = new Set();

for (const g of games) {
  const r = evaluateMatch(toMatch(g), ratings, { evMin: 0.02, unmatched: unmatchedAny });
  if (!r) continue;
  const actualLabel = g.hg > g.ag ? g.home : g.hg < g.ag ? g.away : "Draw";

  // Model top-pick accuracy (independent of betting).
  const top = r.rows.reduce((m, x) => (x.pModel > m.pModel ? x : m), r.rows[0]);
  if (top.label === actualLabel) topHits++;
  graded++;

  console.log(`\n  ${g.home} v ${g.away}  (${g.date})  →  ${g.home} ${g.hg}-${g.ag} ${g.away}  [${actualLabel} won]`);
  console.log(`    outcome        model  market   best   book          EV     verdict`);
  for (const row of r.rows) {
    const v = row.verdict === "value" ? "VALUE" : row.verdict === "outlier" ? "outlier" : "-";
    const won = row.label === actualLabel;
    const tag = row.value ? (won ? "  WON" : "  lost") : "";
    console.log(
      `    ${row.label.padEnd(13)} ${pct(row.pModel).padStart(6)} ${pct(row.pMarket).padStart(6)} ` +
        `${sign(row.american).padStart(6)} ${row.book.padEnd(12)} ${((row.ev >= 0 ? "+" : "") + (row.ev * 100).toFixed(0) + "%").padStart(6)}  ${v}${tag}`
    );
    if (row.value)
      bets.push({
        game: `${g.home} v ${g.away}`,
        bet: row.label,
        price: row.american,
        decimal: row.decimal,
        ev: row.ev,
        won,
        profit: won ? row.decimal - 1 : -1,
      });
  }
}

// ---- summary ------------------------------------------------------------

console.log("\n" + "═".repeat(72));
console.log(`  HISTORICAL BACKTEST — ${games.length} games`);
console.log(`  Model top-pick accuracy: ${topHits}/${graded} (${pct(topHits / graded)})\n`);

if (!bets.length) {
  console.log("  No value bets were flagged across these games.\n");
} else {
  const wins = bets.filter((b) => b.won).length;
  const staked = bets.length;
  const net = bets.reduce((s, b) => s + b.profit, 0);
  const avgEv = bets.reduce((s, b) => s + b.ev, 0) / bets.length;
  console.log(`  VALUE BETS: ${bets.length} placed (1u each)`);
  console.log(`  Record:     ${wins}-${bets.length - wins} (${pct(wins / bets.length)} win rate)`);
  console.log(`  Net:        ${net >= 0 ? "+" : ""}${net.toFixed(2)}u`);
  console.log(`  ROI:        ${net >= 0 ? "+" : ""}${pct(net / staked)}   (model projected avg EV ${pct(avgEv)})`);

  const buckets = [
    { name: " 2–5%  ", lo: 0.02, hi: 0.05 },
    { name: " 5–10% ", lo: 0.05, hi: 0.1 },
    { name: " 10–20%", lo: 0.1, hi: 0.2 },
    { name: " 20%+  ", lo: 0.2, hi: Infinity },
  ];
  console.log(`\n  By projected-edge bucket:`);
  for (const bk of buckets) {
    const g = bets.filter((b) => b.ev >= bk.lo && b.ev < bk.hi);
    if (!g.length) continue;
    const w = g.filter((b) => b.won).length;
    const n2 = g.reduce((s, b) => s + b.profit, 0);
    console.log(`   ${bk.name}: ${w}-${g.length - w}  net ${n2 >= 0 ? "+" : ""}${n2.toFixed(2)}u  ROI ${pct(n2 / g.length)}`);
  }
  console.log(`\n  Every value bet:`);
  for (const b of bets)
    console.log(`   ${b.won ? "[W]" : "[L]"} ${b.bet} (${b.game}) @ ${sign(b.price)}  EV ${pct(b.ev)}  → ${b.profit >= 0 ? "+" : ""}${b.profit.toFixed(2)}u`);
}
if (unmatchedAny.size) console.log(`\n  ⚠ Unmatched teams: ${[...unmatchedAny].join(", ")}`);
console.log(
  `\n  Note: tiny samples are noise — a few dozen bets minimum before ROI means anything.` +
    ` Paste more match days into data/hist-odds.json to grow the sample.\n`
);
