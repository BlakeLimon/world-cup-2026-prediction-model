#!/usr/bin/env node
// markets-backtest.mjs — walk-forward, out-of-sample validation of the DERIVED
// markets (totals O/U, BTTS) against real final scores. Same rating engine and
// burn-in as backtest.mjs; here we score the goal-total markets instead of 1X2.
//   node markets-backtest.mjs
import { readFileSync } from "node:fs";
import { scoreMatrix, totalsProb, bttsProb, spreadProb, expectedScore } from "./elo.mjs";

const D = (f) => new URL(`./data/${f}`, import.meta.url);
const SEED = {
  argentina:2085,france:2065,spain:2055,brazil:2045,england:2000,portugal:1980,netherlands:1965,germany:1945,belgium:1925,italy:1915,colombia:1890,uruguay:1875,croatia:1870,morocco:1840,switzerland:1825,usa:1830,mexico:1825,japan:1810,senegal:1795,denmark:1790,ecuador:1760,australia:1735,"south-korea":1730,iran:1720,poland:1715,canada:1700,serbia:1695,wales:1665,ghana:1665,tunisia:1655,"ivory-coast":1655,nigeria:1645,"saudi-arabia":1640,qatar:1630,egypt:1620,algeria:1615,scotland:1610,cameroon:1600,paraguay:1595,venezuela:1590,chile:1580,peru:1575,"czech-republic":1570,"bosnia-and-herzegovina":1545,"south-africa":1520,"new-zealand":1495,panama:1480,jamaica:1460,honduras:1440,jordan:1420,haiti:1380,"el-salvador":1370,"trinidad-and-tobago":1360,guatemala:1345
};
const HOME_ADV = 75, BURN_IN = 150;
const baseK = (n = "") => { n = n.toLowerCase();
  if (/world cup(?!.*qual)/.test(n)) return 55;
  if (/world cup.*qual|qualification/.test(n)) return 40;
  if (/copa america|euro championship\b|asian cup|africa cup|gold cup/.test(n)) return 50;
  if (/nations league|nations cup/.test(n)) return 32;
  if (/friendl/.test(n)) return 18;
  return 28; };
const gMult = (gd) => { const d = Math.abs(gd); return d <= 1 ? 1 : d === 2 ? 1.5 : (11 + d) / 8; };

const { matches } = JSON.parse(readFileSync(D("results.json"), "utf8"));
const R = {};
const getR = (s, nm) => { const k = s ?? `ghost:${nm}`; if (R[k] == null) R[k] = s && SEED[s] != null ? SEED[s] : 1500; return R[k]; };
const setR = (s, nm, v) => { R[s ?? `ghost:${nm}`] = v; };

const LINE = 2.5;
// Binary scorers for a market with predicted P(yes) and observed outcome y∈{0,1}.
const mk = () => ({ n: 0, brier: 0, logloss: 0, sumP: 0, sumY: 0,
  bins: Array.from({ length: 10 }, () => ({ sumP: 0, sumY: 0, n: 0 })) });
const score = (m, p, y) => {
  m.n++; m.brier += (p - y) ** 2; m.logloss += -(y ? Math.log(Math.max(1e-12, p)) : Math.log(Math.max(1e-12, 1 - p)));
  m.sumP += p; m.sumY += y;
  const b = Math.min(9, Math.floor(p * 10)); m.bins[b].sumP += p; m.bins[b].sumY += y; m.bins[b].n++;
};
const ece = (m) => m.bins.reduce((s, b) => s + (b.n ? Math.abs(b.sumP / b.n - b.sumY / b.n) * b.n : 0), 0) / m.n;

const over = mk(), btts = mk(), spread = mk();
let i = 0;
for (const m of matches) {
  if (m.hg == null || m.ag == null) continue;
  const ra = getR(m.homeSlug, m.homeName), rb = getR(m.awaySlug, m.awayName);
  if (i >= BURN_IN) {
    const { matrix } = scoreMatrix(ra, rb, HOME_ADV);
    score(over, totalsProb(matrix, LINE).over, m.hg + m.ag > LINE ? 1 : 0);
    score(btts, bttsProb(matrix).yes, m.hg > 0 && m.ag > 0 ? 1 : 0);
    score(spread, spreadProb(matrix, -1.5).homeCover, m.hg - m.ag >= 2 ? 1 : 0); // home wins by 2+
  }
  const exp = expectedScore(ra, rb, HOME_ADV);
  const sc = m.hg > m.ag ? 1 : m.hg < m.ag ? 0 : 0.5;
  const delta = baseK(m.leagueName) * gMult(m.hg - m.ag) * (sc - exp);
  setR(m.homeSlug, m.homeName, ra + delta);
  setR(m.awaySlug, m.awayName, rb - delta);
  i++;
}

const pct = (x) => (x * 100).toFixed(1) + "%";
function report(name, m) {
  const baseRate = m.sumY / m.n; // empirical frequency
  // Baseline Brier from always predicting the base rate.
  const baseBrier = baseRate * (1 - baseRate);
  console.log(`\n${name}  (n=${m.n})`);
  console.log(`  Model avg prediction:  ${pct(m.sumP / m.n)}   vs   actual rate ${pct(baseRate)}   (bias ${((m.sumP / m.n - baseRate) * 100 >= 0 ? "+" : "") + ((m.sumP / m.n - baseRate) * 100).toFixed(1)}pts)`);
  console.log(`  Brier (↓):             ${(m.brier / m.n).toFixed(4)}   (base-rate baseline ${baseBrier.toFixed(4)})`);
  console.log(`  Log-loss (↓):          ${(m.logloss / m.n).toFixed(4)}`);
  console.log(`  ECE (calibration, ↓):  ${pct(ece(m))}`);
  console.log(`  Reliability:`);
  for (const [k, b] of m.bins.entries()) {
    if (!b.n) continue;
    console.log(`    ${String(k * 10).padStart(2)}–${String(k * 10 + 10).padStart(3)}%  model ${(b.sumP / b.n * 100).toFixed(0).padStart(3)}%  →  happened ${(b.sumY / b.n * 100).toFixed(0).padStart(3)}%   (n=${b.n})`);
  }
}

console.log(`\n=== DERIVED-MARKET BACKTEST — walk-forward, ${over.n} eval matches (burn-in ${BURN_IN}) ===`);
console.log(`Lower Brier than the base-rate baseline = the model adds real information beyond "always predict the average".`);
report(`OVER ${LINE} goals`, over);
report(`BOTH TEAMS TO SCORE`, btts);
report(`HOME -1.5 (wins by 2+) — spread/margin`, spread);
console.log("");
