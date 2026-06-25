// goals.mjs — Dixon-Coles attack/defense goal model.
// Each team gets an attack rating (how many it scores) and a defense rating
// (how many it concedes), fit by weighted Poisson maximum-likelihood on real
// goals. Unlike single-Elo (which models only relative strength → a ~constant
// match total), this captures absolute scoring rates, enabling totals & BTTS.
//
//   λ_home = exp(base + attack[home] − defense[away] + home_adv)
//   μ_away = exp(base + attack[away] − defense[home])

const MONTH = 30.44 * 86400;
const recency = (tsSec, nowSec, halfLifeMonths = 18) =>
  Math.pow(0.5, (nowSec - tsSec) / MONTH / halfLifeMonths);

// Competition importance (mirrors the Elo calibrators), normalized so a World
// Cup match = 1 and friendlies are down-weighted.
function importance(leagueName = "") {
  const n = leagueName.toLowerCase();
  if (/world cup(?!.*qual)/.test(n)) return 1.0;
  if (/world cup.*qual|qualification/.test(n)) return 0.75;
  if (/copa america|euro championship\b|asian cup|africa cup|gold cup/.test(n)) return 0.9;
  if (/nations league|nations cup/.test(n)) return 0.6;
  if (/friendl/.test(n)) return 0.35;
  return 0.5;
}

const teamKey = (slug, name) => slug ?? `ghost:${name}`;

// Fit attack/defense by multiplicative iterative scaling (the standard, stable
// way to fit a Poisson attack/defense model — no learning rate, can't diverge):
//   λ_home = base · atk[home] · dfn[away] · hf
//   μ_away = base · atk[away] · dfn[home]
// atk>1 = scores more than average; dfn>1 = concedes more than average.
// Each rating is the weighted ratio of (goals) to (expected goals given the
// opponent), with Bayesian pseudo-counts so thin-sample teams regress to 1.
export function fitAttackDefense(matches, opts = {}) {
  const { iters = 120, halfLifeMonths = 18, prior = 4 } = opts;
  const valid = matches.filter((m) => m.hg != null && m.ag != null);
  const nowSec = valid.length ? valid[valid.length - 1].ts : Math.floor(Date.now() / 1000);

  const teams = new Set();
  let goalSum = 0, wSum = 0;
  const rows = valid.map((m) => {
    const h = teamKey(m.homeSlug, m.homeName), a = teamKey(m.awaySlug, m.awayName);
    teams.add(h); teams.add(a);
    const w = recency(m.ts, nowSec, halfLifeMonths) * importance(m.leagueName);
    goalSum += m.hg + m.ag; wSum += 2 * w;
    return { h, a, hg: m.hg, ag: m.ag, w };
  });
  // Per-team match lists for the attack/defense updates.
  const tm = {};
  for (const t of teams) tm[t] = [];
  for (const r of rows) {
    tm[r.h].push({ opp: r.a, gf: r.hg, ga: r.ag, home: true, w: r.w });
    tm[r.a].push({ opp: r.h, gf: r.ag, ga: r.hg, home: false, w: r.w });
  }

  const atk = {}, dfn = {};
  for (const t of teams) { atk[t] = 1; dfn[t] = 1; }
  let base = goalSum / valid.length / 2 || 1.3; // mean goals per team
  let hf = 1.1;
  const geomean = (o) => { let s = 0; for (const t of teams) s += Math.log(o[t]); return Math.exp(s / teams.size); };

  for (let it = 0; it < iters; it++) {
    // Attack: goals scored vs expected (prior pulls toward 1).
    for (const t of teams) {
      let num = prior, den = prior;
      for (const m of tm[t]) {
        num += m.w * m.gf;
        den += m.w * base * dfn[m.opp] * (m.home ? hf : 1);
      }
      atk[t] = num / den;
    }
    // Defense: goals conceded vs expected.
    for (const t of teams) {
      let num = prior, den = prior;
      for (const m of tm[t]) {
        num += m.w * m.ga;
        den += m.w * base * atk[m.opp] * (m.home ? 1 : hf);
      }
      dfn[t] = num / den;
    }
    // Global scoring level and home factor.
    let bn = 0, bd = 0, hn = 0, hd = 0;
    for (const r of rows) {
      bn += r.w * (r.hg + r.ag);
      bd += r.w * (atk[r.h] * dfn[r.a] * hf + atk[r.a] * dfn[r.h]);
      hn += r.w * r.hg;
      hd += r.w * base * atk[r.h] * dfn[r.a];
    }
    base = bn / bd;
    hf = hn / hd;
    // Recenter atk & dfn to geometric mean 1 (level absorbed by base).
    const ga = geomean(atk), gd = geomean(dfn);
    for (const t of teams) { atk[t] /= ga; dfn[t] /= gd; }
    base *= ga * gd;
  }

  return { base, hf, atk, dfn };
}

// Expected goals for a fixture under the fitted model. neutral=true drops the
// home-field factor (World Cup). Unknown teams fall back to average (1.0).
export function adLambdas(params, homeSlug, awaySlug, { neutral = true } = {}) {
  const aH = params.atk[homeSlug] ?? 1, dH = params.dfn[homeSlug] ?? 1;
  const aA = params.atk[awaySlug] ?? 1, dA = params.dfn[awaySlug] ?? 1;
  const hf = neutral ? 1 : params.hf;
  const clamp = (x) => Math.max(0.2, Math.min(4.5, x));
  return { lambda: clamp(params.base * aH * dA * hf), mu: clamp(params.base * aA * dH) };
}

export { teamKey };
