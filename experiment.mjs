#!/usr/bin/env node
// experiment.mjs — sweep the Elo→goals spread parameters and score each against
// the same walk-forward eval set the backtest uses. The Elo ratings trajectory
// is built from expectedScore (the logistic), NOT the goal model, so changing
// the goal mapping only changes the 1X2 probability conversion — letting us
// build ratings ONCE and score many parameter sets fairly.
//   node experiment.mjs
import { readFileSync } from "node:fs";

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
const expectedScore = (a, b, hb) => 1 / (1 + Math.pow(10, (b - (a + hb)) / 400));

// --- parameterized goal model ---
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}
function dcTau(a, b, lambda, mu, rho) {
  if (a === 0 && b === 0) return 1 - lambda * mu * rho;
  if (a === 0 && b === 1) return 1 + lambda * rho;
  if (a === 1 && b === 0) return 1 + mu * rho;
  if (a === 1 && b === 1) return 1 - rho;
  return 1;
}
function eGoals(rating, opp, hb, P) {
  const lambda = P.base + ((rating + hb) - opp) / P.denom;
  return Math.max(0.3, Math.min(3.5, lambda));
}
function matchProbP(rA, rB, hbA, P) {
  const lambda = eGoals(rA, rB, hbA, P);
  const mu = eGoals(rB, rA, -hbA / 2, P);
  let winA = 0, draw = 0, winB = 0;
  for (let a = 0; a <= 8; a++) {
    const pA = poissonPmf(a, lambda);
    for (let b = 0; b <= 8; b++) {
      const p = pA * poissonPmf(b, mu) * dcTau(a, b, lambda, mu, P.rho);
      if (a > b) winA += p; else if (a < b) winB += p; else draw += p;
    }
  }
  const t = winA + draw + winB;
  return [winA / t, draw / t, winB / t];
}

// --- build ratings ONCE, capture eval tuples (ra, rb, actualIdx) ---
const { matches } = JSON.parse(readFileSync(D("results.json"), "utf8"));
const R = {};
const getR = (s, nm) => { const k = s ?? `ghost:${nm}`; if (R[k] == null) R[k] = s && SEED[s] != null ? SEED[s] : 1500; return R[k]; };
const setR = (s, nm, v) => { R[s ?? `ghost:${nm}`] = v; };

const evalSet = [];
let i = 0;
for (const m of matches) {
  if (m.hg == null || m.ag == null) continue;
  const ra = getR(m.homeSlug, m.homeName), rb = getR(m.awaySlug, m.awayName);
  if (i >= BURN_IN) {
    const actual = m.hg > m.ag ? 0 : m.hg < m.ag ? 2 : 1;
    evalSet.push([ra, rb, actual]);
  }
  const exp = expectedScore(ra, rb, HOME_ADV);
  const score = m.hg > m.ag ? 1 : m.hg < m.ag ? 0 : 0.5;
  const delta = baseK(m.leagueName) * gMult(m.hg - m.ag) * (score - exp);
  setR(m.homeSlug, m.homeName, ra + delta);
  setR(m.awaySlug, m.awayName, rb - delta);
  i++;
}

// --- score a parameter set over the fixed eval set ---
function score(P) {
  const BINS = 10;
  const calib = Array.from({ length: BINS }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  let n = 0, hit = 0, logloss = 0, rps = 0, drawSum = 0;
  for (const [ra, rb, actual] of evalSet) {
    const p = matchProbP(ra, rb, HOME_ADV, P);
    const y = [actual === 0 ? 1 : 0, actual === 1 ? 1 : 0, actual === 2 ? 1 : 0];
    if (p.indexOf(Math.max(...p)) === actual) hit++;
    logloss += -Math.log(Math.max(1e-12, p[actual]));
    rps += 0.5 * ((p[0] - y[0]) ** 2 + (p[0] + p[1] - y[0] - y[1]) ** 2);
    drawSum += p[1];
    for (let k = 0; k < 3; k++) {
      const b = Math.min(BINS - 1, Math.floor(p[k] * BINS));
      calib[b].sumP += p[k]; calib[b].sumY += y[k]; calib[b].n++;
    }
    n++;
  }
  const ece = calib.reduce((s, b) => s + (b.n ? Math.abs(b.sumP / b.n - b.sumY / b.n) * b.n : 0), 0) / (3 * n);
  return { acc: hit / n, logloss: logloss / n, rps: rps / n, ece, avgDraw: drawSum / n };
}

// Reference mismatch: Netherlands(1965) vs Tunisia(1655), neutral venue.
function mismatch(P) {
  const [w, d, l] = matchProbP(1965, 1655, 0, P);
  return `NED ${(w*100).toFixed(0)}% / draw ${(d*100).toFixed(0)}% / TUN ${(l*100).toFixed(0)}%`;
}

console.log(`\nEval set: ${evalSet.length} matches.  Market reference for NED-TUN ≈ 87% / 9% / 4%\n`);
console.log("base  denom |   acc   logloss     rps      ece   avgDraw |  NED-TUN (neutral)");
console.log("─".repeat(92));
const RHO = -0.13;
for (const base of [1.35]) {
  for (const denom of [400, 350, 300, 275, 250, 225, 200, 175, 150]) {
    const P = { base, denom, rho: RHO };
    const s = score(P);
    const tag = denom === 400 ? "  ← current" : "";
    console.log(
      `${base.toFixed(2)}   ${String(denom).padStart(3)}  | ` +
        `${(s.acc*100).toFixed(1)}%   ${s.logloss.toFixed(4)}  ${s.rps.toFixed(4)}   ${(s.ece*100).toFixed(1)}%   ${(s.avgDraw*100).toFixed(1)}%  | ${mismatch(P)}${tag}`
    );
  }
}
console.log("\n(lower logloss / rps / ece = better; avgDraw should track real draw rate ~22%)\n");
