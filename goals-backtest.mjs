#!/usr/bin/env node
// goals-backtest.mjs — head-to-head, out-of-sample comparison of the new
// attack/defense (A/D) goal model vs the incumbent single-Elo model, scored on
// the SAME held-out test matches across all four markets. A/D is fit on the
// training split only; Elo is built walk-forward and read at each test match.
//   node goals-backtest.mjs
import { readFileSync } from "node:fs";
import { matchProb, scoreMatrix, matrixFromLambdas, totalsProb, bttsProb, spreadProb, expectedScore } from "./elo.mjs";
import { fitAttackDefense, adLambdas, teamKey } from "./goals.mjs";

const D = (f) => new URL(`./data/${f}`, import.meta.url);
const SEED = {
  argentina:2085,france:2065,spain:2055,brazil:2045,england:2000,portugal:1980,netherlands:1965,germany:1945,belgium:1925,italy:1915,colombia:1890,uruguay:1875,croatia:1870,morocco:1840,switzerland:1825,usa:1830,mexico:1825,japan:1810,senegal:1795,denmark:1790,ecuador:1760,australia:1735,"south-korea":1730,iran:1720,poland:1715,canada:1700,serbia:1695,wales:1665,ghana:1665,tunisia:1655,"ivory-coast":1655,nigeria:1645,"saudi-arabia":1640,qatar:1630,egypt:1620,algeria:1615,scotland:1610,cameroon:1600,paraguay:1595,venezuela:1590,chile:1580,peru:1575,"czech-republic":1570,"bosnia-and-herzegovina":1545,"south-africa":1520,"new-zealand":1495,panama:1480,jamaica:1460,honduras:1440,jordan:1420,haiti:1380,"el-salvador":1370,"trinidad-and-tobago":1360,guatemala:1345
};
const HOME_ADV = 75;
const baseK = (n = "") => { n = n.toLowerCase();
  if (/world cup(?!.*qual)/.test(n)) return 55;
  if (/world cup.*qual|qualification/.test(n)) return 40;
  if (/copa america|euro championship\b|asian cup|africa cup|gold cup/.test(n)) return 50;
  if (/nations league|nations cup/.test(n)) return 32;
  if (/friendl/.test(n)) return 18;
  return 28; };
const gMult = (gd) => { const d = Math.abs(gd); return d <= 1 ? 1 : d === 2 ? 1.5 : (11 + d) / 8; };

const { matches } = JSON.parse(readFileSync(D("results.json"), "utf8"));
const valid = matches.filter((m) => m.hg != null && m.ag != null);
const cutoff = valid.length - 250; // last 250 valid matches = test set

// Fit A/D on the training split only.
const trainMatches = valid.slice(0, cutoff);
const ad = fitAttackDefense(trainMatches);

// Walk Elo over everything; capture (ratings, result) for test matches.
const R = {};
const getR = (s, nm) => { const k = s ?? `ghost:${nm}`; if (R[k] == null) R[k] = s && SEED[s] != null ? SEED[s] : 1500; return R[k]; };
const setR = (s, nm, v) => { R[s ?? `ghost:${nm}`] = v; };
const test = [];
let vi = 0;
for (const m of matches) {
  if (m.hg == null || m.ag == null) continue;
  const ra = getR(m.homeSlug, m.homeName), rb = getR(m.awaySlug, m.awayName);
  if (vi >= cutoff) test.push({ ra, rb, h: teamKey(m.homeSlug, m.homeName), a: teamKey(m.awaySlug, m.awayName), hg: m.hg, ag: m.ag });
  const exp = expectedScore(ra, rb, HOME_ADV);
  const sc = m.hg > m.ag ? 1 : m.hg < m.ag ? 0 : 0.5;
  const delta = baseK(m.leagueName) * gMult(m.hg - m.ag) * (sc - exp);
  setR(m.homeSlug, m.homeName, ra + delta);
  setR(m.awaySlug, m.awayName, rb - delta);
  vi++;
}

// Accumulators per model.
const acc = () => ({ rps: 0, x2ll: 0, totBrier: 0, totP: 0, bttsBrier: 0, bttsP: 0, sprBrier: 0, n: 0 });
const E = acc(), A = acc();
const rps3 = (p, y) => 0.5 * ((p[0] - y[0]) ** 2 + (p[0] + p[1] - y[0] - y[1]) ** 2);

let actualTot = 0, actualBtts = 0;
for (const t of test) {
  const yWin = t.hg > t.ag ? 0 : t.hg < t.ag ? 2 : 1;
  const y = [yWin === 0 ? 1 : 0, yWin === 1 ? 1 : 0, yWin === 2 ? 1 : 0];
  const yOver = t.hg + t.ag > 2.5 ? 1 : 0;
  const yBtts = t.hg > 0 && t.ag > 0 ? 1 : 0;
  const ySpread = t.hg - t.ag >= 2 ? 1 : 0;
  actualTot += yOver; actualBtts += yBtts;

  // Elo model
  const ep = matchProb(t.ra, t.rb, HOME_ADV);
  const em = scoreMatrix(t.ra, t.rb, HOME_ADV).matrix;
  // A/D model
  const { lambda, mu } = adLambdas(ad, t.h, t.a, { neutral: false });
  const am = matrixFromLambdas(lambda, mu);
  let aw = 0, ad_ = 0, al = 0;
  for (let i = 0; i < am.length; i++) for (let j = 0; j < am.length; j++) { const p = am[i][j]; if (i > j) aw += p; else if (i < j) al += p; else ad_ += p; }

  for (const [M, probs, matrix] of [[E, [ep.winA, ep.draw, ep.winB], em], [A, [aw, ad_, al], am]]) {
    M.rps += rps3(probs, y);
    M.x2ll += -Math.log(Math.max(1e-12, probs[yWin]));
    const over = totalsProb(matrix, 2.5).over, btts = bttsProb(matrix).yes, spr = spreadProb(matrix, -1.5).homeCover;
    M.totBrier += (over - yOver) ** 2; M.totP += over;
    M.bttsBrier += (btts - yBtts) ** 2; M.bttsP += btts;
    M.sprBrier += (spr - ySpread) ** 2;
    M.n++;
  }
}

const f = (x, d = 4) => x.toFixed(d);
const pct = (x) => (x * 100).toFixed(1) + "%";
const line = (label, e, a, better) => {
  const win = better === "lo" ? (a < e ? "A/D" : "Elo") : (a > e ? "A/D" : "Elo");
  console.log(`  ${label.padEnd(26)} Elo ${f(e).padStart(8)}   A/D ${f(a).padStart(8)}   → ${win}`);
};
console.log(`\n=== A/D vs Elo — ${E.n} held-out test matches (train ${cutoff}) ===`);
console.log(`  Actual rates: over2.5 ${pct(actualTot / E.n)} · BTTS ${pct(actualBtts / E.n)}\n`);
line("1X2 RPS (↓)", E.rps / E.n, A.rps / A.n, "lo");
line("1X2 log-loss (↓)", E.x2ll / E.n, A.x2ll / A.n, "lo");
line("Spread -1.5 Brier (↓)", E.sprBrier / E.n, A.sprBrier / A.n, "lo");
line("Totals O/U2.5 Brier (↓)", E.totBrier / E.n, A.totBrier / A.n, "lo");
line("BTTS Brier (↓)", E.bttsBrier / E.n, A.bttsBrier / A.n, "lo");
console.log("");
console.log(`  Totals avg pred:  Elo ${pct(E.totP / E.n)}  A/D ${pct(A.totP / A.n)}  (actual ${pct(actualTot / E.n)})`);
console.log(`  BTTS avg pred:    Elo ${pct(E.bttsP / E.n)}  A/D ${pct(A.bttsP / A.n)}  (actual ${pct(actualBtts / E.n)})`);
console.log(`\n  base=${f(ad.base, 3)}  hf=${f(ad.hf, 3)}  (A/D fit on ${trainMatches.length} matches)\n`);
