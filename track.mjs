#!/usr/bin/env node
// track.mjs — record value-bet recommendations and grade them against results,
// so you can measure whether the model actually beats the market over time.
//
//   node track.mjs log       fetch odds, append today's ✅ VALUE bets to the log
//   node track.mjs grade     fetch results, settle any open bets that finished
//   node track.mjs report    summarize record, ROI, and edge-bucket performance
//
// Bets are logged at a flat 1-unit stake. Profit is in units (win = decimal−1).
// The log lives in data/bet-log.json. Reads ODDS_API_KEY / ODDS_REGIONS from .env.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  loadEnv,
  loadRatings,
  fetchOdds,
  fetchScores,
  evaluateMatch,
  norm,
} from "./value.mjs";

loadEnv();
const API_KEY = process.env.ODDS_API_KEY;
const REGIONS = process.env.ODDS_REGIONS || "us";
if (!API_KEY) {
  console.error("Missing ODDS_API_KEY (set it in .env).");
  process.exit(1);
}

const LOG_PATH = new URL("./data/bet-log.json", import.meta.url);
const STAKE = 1; // flat unit stake

function readLog() {
  if (!existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LOG_PATH, "utf8"));
  } catch {
    return [];
  }
}
function writeLog(log) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

const cmd = process.argv[2];

if (cmd === "log") await cmdLog();
else if (cmd === "grade") await cmdGrade();
else if (cmd === "report") cmdReport();
else {
  console.log("Usage: node track.mjs <log|grade|report>");
  process.exit(0);
}

// --- log -----------------------------------------------------------------

async function cmdLog() {
  const ratings = loadRatings();
  const { matches, remaining } = await fetchOdds({ apiKey: API_KEY, regions: REGIONS });
  const log = readLog();
  const seen = new Set(log.map((b) => b.id));
  const now = Date.now();

  let added = 0,
    skippedStarted = 0,
    skippedDup = 0;

  const logRow = (r, row, market) => {
    const id = market === "spread" ? `${r.eventId}:spread:${row.side}:${row.line}` : `${r.eventId}:${row.side}`;
    if (seen.has(id)) { skippedDup++; return; }
    log.push({
      id,
      loggedAt: new Date().toISOString(),
      eventId: r.eventId,
      match: `${r.home} vs ${r.away}`,
      home: r.home,
      away: r.away,
      kickoff: r.kickoff,
      market,
      bet: row.label,
      side: row.side,
      line: row.line ?? null,
      priceAmerican: row.american,
      priceDecimal: +row.decimal.toFixed(4),
      book: row.book,
      pModel: +row.pModel.toFixed(4),
      pMarket: +row.pMarket.toFixed(4),
      edge: +row.edge.toFixed(4),
      ev: +row.ev.toFixed(4),
      stake: STAKE,
      status: "open",
      result: null,
      profit: null,
      settledAt: null,
    });
    seen.add(id);
    added++;
  };

  for (const match of matches) {
    const r = evaluateMatch(match, ratings, {});
    if (!r) continue;
    // Don't log bets on matches that have already kicked off.
    if (new Date(r.kickoff).getTime() <= now) {
      if (r.recommendations.length) skippedStarted++;
      continue;
    }
    for (const row of r.recommendations) logRow(r, row, row.market);
  }

  writeLog(log);
  console.log(
    `\n  Logged ${added} new value bet(s). ` +
      `(skipped ${skippedDup} already-logged, ${skippedStarted} match(es) already started)`
  );
  console.log(`  Log now holds ${log.length} bet(s) total. Credits remaining: ${remaining}\n`);
}

// --- grade ---------------------------------------------------------------

async function cmdGrade() {
  const log = readLog();
  const open = log.filter((b) => b.status === "open");
  if (!open.length) {
    console.log("\n  No open bets to grade.\n");
    return;
  }

  const { scores, remaining } = await fetchScores({ apiKey: API_KEY, daysFrom: 3 });
  const byId = new Map();
  for (const s of scores) byId.set(s.id, s);

  let settled = 0;
  for (const b of open) {
    const s = byId.get(b.eventId);
    if (!s || !s.completed || !Array.isArray(s.scores)) continue;

    const find = (team) => s.scores.find((x) => norm(x.name) === norm(team));
    const h = find(s.home_team),
      a = find(s.away_team);
    if (!h || !a) continue;
    const hg = parseInt(h.score, 10),
      ag = parseInt(a.score, 10);
    if (Number.isNaN(hg) || Number.isNaN(ag)) continue;

    let result; // "won" | "lost" | "push"
    if (b.market === "spread") {
      // margin from the bet side's perspective + its handicap line.
      const margin = (b.side === "home" ? hg - ag : ag - hg) + b.line;
      result = margin > 0 ? "won" : margin < 0 ? "lost" : "push";
    } else {
      const outcome = hg > ag ? s.home_team : hg < ag ? s.away_team : "Draw";
      result = norm(b.bet) === norm(outcome) ? "won" : "lost";
    }
    b.status = result;
    b.result = { homeGoals: hg, awayGoals: ag };
    b.profit = result === "won" ? +((b.priceDecimal - 1) * b.stake).toFixed(4) : result === "push" ? 0 : -b.stake;
    b.settledAt = new Date().toISOString();
    settled++;
  }

  writeLog(log);
  console.log(`\n  Settled ${settled} bet(s). ${open.length - settled} still open/pending result.`);
  console.log(`  Credits remaining: ${remaining}\n`);
}

// --- report --------------------------------------------------------------

function cmdReport() {
  const log = readLog();
  const graded = log.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push");
  const open = log.filter((b) => b.status === "open");

  console.log(`\n  ═══ Bet Tracker Report ═══`);
  console.log(`  Total logged: ${log.length}   ·   graded: ${graded.length}   ·   open: ${open.length}\n`);

  if (!graded.length) {
    console.log("  No graded bets yet — run `node track.mjs log` over time, then `grade` after matches finish.\n");
    if (open.length) listOpen(open);
    return;
  }

  const wins = graded.filter((b) => b.status === "won").length;
  const pushes = graded.filter((b) => b.status === "push").length;
  const losses = graded.length - wins - pushes;
  const staked = graded.reduce((s, b) => s + b.stake, 0);
  const net = graded.reduce((s, b) => s + b.profit, 0);
  const roi = net / staked;
  const avgEv = graded.reduce((s, b) => s + b.ev, 0) / graded.length;
  const decided = wins + losses;

  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log(`  Record:        ${wins}-${losses}${pushes ? `-${pushes} (push)` : ""}  (${pct(decided ? wins / decided : 0)} win rate)`);
  console.log(`  Units staked:  ${staked.toFixed(1)}`);
  console.log(`  Net profit:    ${net >= 0 ? "+" : ""}${net.toFixed(2)} units`);
  console.log(`  ROI:           ${net >= 0 ? "+" : ""}${pct(roi)}`);
  console.log(`  Realized vs expected: actual ROI ${pct(roi)}  vs  model-projected EV ${pct(avgEv)}`);

  // Performance by EV bucket — does bigger projected edge actually pay more?
  const buckets = [
    { name: "  2–5% EV ", lo: 0.02, hi: 0.05 },
    { name: "  5–10% EV", lo: 0.05, hi: 0.1 },
    { name: " 10–20% EV", lo: 0.1, hi: 0.2 },
    { name: "  20%+ EV ", lo: 0.2, hi: Infinity },
  ];
  console.log(`\n  By projected-edge bucket:`);
  for (const bk of buckets) {
    const g = graded.filter((b) => b.ev >= bk.lo && b.ev < bk.hi);
    if (!g.length) continue;
    const w = g.filter((b) => b.status === "won").length;
    const n2 = g.reduce((s, b) => s + b.profit, 0);
    const st = g.reduce((s, b) => s + b.stake, 0);
    console.log(
      `   ${bk.name}:  ${w}-${g.length - w}   net ${n2 >= 0 ? "+" : ""}${n2.toFixed(2)}u   ROI ${n2 >= 0 ? "+" : ""}${pct(n2 / st)}`
    );
  }

  console.log(
    `\n  Note: ROI here grades against actual results. Beating the *closing line*` +
      ` is the sharper test of edge — a future enhancement (snapshot lines near kickoff).`
  );
  if (open.length) listOpen(open);
  console.log("");
}

function listOpen(open) {
  console.log(`\n  Open bets (awaiting result):`);
  for (const b of open) {
    const price = b.priceAmerican > 0 ? "+" + b.priceAmerican : "" + b.priceAmerican;
    console.log(`   • ${b.bet} (${b.match}) @ ${price} on ${b.book}  —  kicks off ${new Date(b.kickoff).toLocaleString()}`);
  }
}
