// value.mjs — shared engine: fetch World Cup odds, build the de-vigged market
// consensus, and evaluate each outcome for value with the trust guardrail.
// Used by both compare.mjs (display) and track.mjs (logging/grading).
import { readFileSync } from "node:fs";
import { matchProb, scoreMatrix, spreadProb } from "./elo.mjs";
import {
  americanToDecimal,
  americanToImpliedProb,
  devig,
  evaluateBet,
} from "./oddsmath.mjs";
import { matchAdjustments, venueOf } from "./adjustments.mjs";

// Optional fixture → venue city map (the odds feed has no venue). Keyed by
// "homeslug|awayslug". Populate data/wc-fixtures.json to light up stadium names
// and venue-based adjustments (altitude). Missing entries are simply skipped.
let FIXTURES = {};
try {
  FIXTURES = JSON.parse(readFileSync(new URL("./data/wc-fixtures.json", import.meta.url), "utf8")).fixtures || {};
} catch { /* no fixtures map yet */ }

export const SPORT = "soccer_fifa_world_cup";

// Trust guardrail — see compare.mjs / the backtest writeup. The model is only
// validated within ~15–85%, and large disagreements with sharp consensus are
// model error, not edge.
export const TRUST_MIN = 0.15;
export const TRUST_MAX = 0.85;
export const EDGE_CAP = 0.1;

// Load KEY=VALUE pairs from .env without clobbering real environment vars.
export function loadEnv() {
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

export function loadRatings() {
  const { ratings } = JSON.parse(
    readFileSync(new URL("./data/elo-calibrated.json", import.meta.url), "utf8")
  );
  return ratings;
}

// API display name → model key. Strip accents, punctuation, spaces → hyphens.
export function norm(name) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[''.]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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

export function resolveTeam(name, ratings) {
  const n = norm(name);
  if (ratings[n] != null) return n;
  if (ALIAS[n] != null && ratings[ALIAS[n]] != null) return ALIAS[n];
  return null;
}

// --- API calls -----------------------------------------------------------

export async function fetchOdds({ apiKey, regions = "us", markets = "h2h,spreads" }) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/` +
    `?apiKey=${apiKey}&regions=${regions}&markets=${markets}&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API error ${res.status}: ${await res.text()}`);
  return { matches: await res.json(), remaining: res.headers.get("x-requests-remaining") };
}

// Completed/live scores for result-grading. daysFrom (1–3) pulls recently
// finished games too; costs 2 credits with daysFrom, 1 without.
export async function fetchScores({ apiKey, daysFrom = 3 }) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${SPORT}/scores/` +
    `?apiKey=${apiKey}&daysFrom=${daysFrom}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Scores API error ${res.status}: ${await res.text()}`);
  return { scores: await res.json(), remaining: res.headers.get("x-requests-remaining") };
}

// --- evaluation ----------------------------------------------------------

// Evaluate one match. Returns null (with the team pushed to `unmatched`) if a
// team can't be mapped. Each row carries everything both display and logging need.
export function evaluateMatch(match, ratings, { evMin = 0.02, unmatched } = {}) {
  const { id, home_team, away_team, bookmakers = [] } = match;
  const homeKey = resolveTeam(home_team, ratings);
  const awayKey = resolveTeam(away_team, ratings);
  if (!homeKey && unmatched) unmatched.add(home_team);
  if (!awayKey && unmatched) unmatched.add(away_team);
  if (!homeKey || !awayKey) return null;

  // Resolve venue (if mapped) and apply situational adjustments (host, altitude).
  const venueCity = FIXTURES[`${homeKey}|${awayKey}`] || null;
  const venue = venueCity ? venueOf(venueCity) : null;
  const adj = matchAdjustments({ homeKey, awayKey, venue });
  const rA = ratings[homeKey] + adj.adjHome;
  const rB = ratings[awayKey] + adj.adjAway;

  const p = matchProb(rA, rB, 0);
  const outcomes = [
    { label: home_team, side: "home", pModel: p.winA },
    { label: "Draw", side: "draw", pModel: p.draw },
    { label: away_team, side: "away", pModel: p.winB },
  ];

  const best = {}; // label -> { american, decimal, book }
  const fairSamples = {};
  for (const o of outcomes) fairSamples[o.label] = [];

  for (const bk of bookmakers) {
    const mkt = bk.markets?.find((m) => m.key === "h2h");
    if (!mkt) continue;
    const priced = {};
    for (const oc of mkt.outcomes) priced[oc.name] = oc.price;
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

  const rows = [];
  for (const o of outcomes) {
    const samples = fairSamples[o.label];
    if (!samples.length || !best[o.label]) continue;
    const pMarket = samples.reduce((s, x) => s + x, 0) / samples.length;
    const b = best[o.label];
    const { edge, ev } = evaluateBet(o.pModel, pMarket, b.decimal, { evMin });
    const positiveEv = edge > 0 && ev >= evMin;
    const trusted = pMarket >= TRUST_MIN && pMarket <= TRUST_MAX && edge <= EDGE_CAP;
    const value = positiveEv && trusted;
    rows.push({
      market: "h2h",
      label: o.label,
      side: o.side,
      pModel: o.pModel,
      pMarket,
      american: b.american,
      decimal: b.decimal,
      book: b.book,
      edge,
      ev,
      value,
      verdict: value ? "value" : positiveEv ? "outlier" : "none",
    });
  }

  const { matrix } = scoreMatrix(rA, rB, 0);
  const spreadRows = evaluateSpreads(matrix, home_team, away_team, bookmakers, evMin);

  // One recommendation per side (team / draw) across moneyline + spreads — keep
  // the highest-EV bet so we never recommend two bets on the same team.
  const bySide = new Map();
  for (const r of [...rows, ...spreadRows]) {
    if (!r.value) continue;
    const prev = bySide.get(r.side);
    if (!prev || r.ev > prev.ev) bySide.set(r.side, r);
  }
  for (const r of [...rows, ...spreadRows]) r.recommended = false;
  const recommendations = [...bySide.values()].sort((a, b) => b.ev - a.ev);
  for (const r of recommendations) r.recommended = true;

  return {
    eventId: id,
    home: home_team,
    away: away_team,
    kickoff: match.commence_time,
    bookCount: bookmakers.length,
    venue: venue ? { stadium: venue.stadium, city: venueCity, altitudeM: venue.altitudeM } : null,
    adjustmentNotes: adj.notes,
    rows,
    spreadRows,
    recommendations,
  };
}

const fmtLine = (x) => (x > 0 ? "+" + x : "" + x);

// Evaluate goal-handicap (spread) bets. Books quote different lines, so we
// de-vig each book's own two sides at its line (rather than averaging across
// books), evaluate the model's cover probability with push handling, and keep
// the best +EV per (side, line). Returns rows shaped like the h2h rows, with
// added `market`, `line`, and `push` fields.
function evaluateSpreads(matrix, homeTeam, awayTeam, bookmakers, evMin) {
  const byKey = new Map(); // `${side}|${line}` -> best-EV candidate
  for (const bk of bookmakers) {
    const mkt = bk.markets?.find((m) => m.key === "spreads");
    if (!mkt) continue;
    const ho = mkt.outcomes.find((o) => o.name === homeTeam);
    const ao = mkt.outcomes.find((o) => o.name === awayTeam);
    if (!ho || !ao || ho.point == null) continue;

    const hp = ho.point; // home handicap line
    const sp = spreadProb(matrix, hp);
    const ih = americanToImpliedProb(ho.price), ia = americanToImpliedProb(ao.price);
    const fairHome = ih / (ih + ia), fairAway = ia / (ih + ia);

    const sides = [
      { side: "home", label: `${homeTeam} ${fmtLine(hp)}`, line: hp, price: ho.price, pWin: sp.homeCover, pLose: sp.awayCover, fair: fairHome },
      { side: "away", label: `${awayTeam} ${fmtLine(-hp)}`, line: -hp, price: ao.price, pWin: sp.awayCover, pLose: sp.homeCover, fair: fairAway },
    ];
    for (const s of sides) {
      const decimal = americanToDecimal(s.price);
      const pAdj = s.pWin / (s.pWin + s.pLose); // push-excluded, matches the de-vig
      const edge = pAdj - s.fair;
      const ev = s.pWin * (decimal - 1) - s.pLose; // push refunds stake → 0 profit
      const positiveEv = edge > 0 && ev >= evMin;
      const trusted = s.fair >= TRUST_MIN && s.fair <= TRUST_MAX && edge <= EDGE_CAP;
      const value = positiveEv && trusted;
      const cand = {
        market: "spread", side: s.side, label: s.label, line: s.line,
        pModel: pAdj, pMarket: s.fair, push: sp.push,
        american: s.price, decimal, book: bk.title,
        edge, ev, value, verdict: value ? "value" : positiveEv ? "outlier" : "none",
      };
      const key = `${s.side}|${s.line}`;
      const prev = byKey.get(key);
      if (!prev || cand.ev > prev.ev) byKey.set(key, cand);
    }
  }
  return [...byKey.values()].sort((a, b) => b.ev - a.ev);
}
