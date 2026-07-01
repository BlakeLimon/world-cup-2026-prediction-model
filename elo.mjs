// Elo + Dixon-Coles bivariate Poisson — the match model behind https://cup26matches.com
// References: World Football Elo; Maher (1982); Dixon & Coles (1997).
export const K_FACTOR_WC = 60;

// Dixon-Coles ρ — corrects vanilla Poisson's under-count of 0-0 / 1-1 draws. ~ -0.13 empirically.
export const DC_RHO = -0.13;

// Share of match goals scored in the first half (~45% empirically; H2 sees more).
// Used to approximate first-half markets — NOT validated against half-time data.
export const FIRST_HALF_GOAL_FRACTION = 0.45;

function dcTau(a, b, lambda, mu, rho) {
  if (a === 0 && b === 0) return 1 - lambda * mu * rho;
  if (a === 0 && b === 1) return 1 + lambda * rho;
  if (a === 1 && b === 0) return 1 + mu * rho;
  if (a === 1 && b === 1) return 1 - rho;
  return 1;
}

// Elo win expectancy (logistic on rating difference).
export function expectedScore(ratingA, ratingB, homeBonusA = 0) {
  return 1 / (1 + Math.pow(10, (ratingB - (ratingA + homeBonusA)) / 400));
}

// Rating difference → expected goals (Poisson λ). Flat denominator keeps single-match variance
// near real football upset frequency.
export function expectedGoals(rating, opponent, homeBonus = 0) {
  const diff = (rating + homeBonus) - opponent;
  const lambda = 1.35 + diff / 400;
  return Math.max(0.3, Math.min(3.5, lambda));
}

export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

export function poissonSample(lambda, rng = Math.random) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

// Full Dixon-Coles bivariate Poisson scoreline matrix (normalized), 0–maxGoals
// each side. Every other market — 1X2, totals, spreads, BTTS — is just an
// aggregation of this single joint distribution.
const MAX_GOALS = 8;
function buildMatrix(lambda, mu, rho, maxGoals) {
  const M = [];
  let total = 0;
  for (let a = 0; a <= maxGoals; a++) {
    M[a] = [];
    const pA = poissonPmf(a, lambda);
    for (let b = 0; b <= maxGoals; b++) {
      const p = pA * poissonPmf(b, mu) * dcTau(a, b, lambda, mu, rho);
      M[a][b] = p;
      total += p;
    }
  }
  for (let a = 0; a <= maxGoals; a++)
    for (let b = 0; b <= maxGoals; b++) M[a][b] /= total;
  return M;
}

// Score matrix for the full match. Returns the matrix plus both expected-goal rates.
export function scoreMatrix(ratingA, ratingB, homeBonusA = 0, maxGoals = MAX_GOALS) {
  const lambda = expectedGoals(ratingA, ratingB, homeBonusA);
  const mu = expectedGoals(ratingB, ratingA, -homeBonusA / 2);
  return { matrix: buildMatrix(lambda, mu, DC_RHO, maxGoals), lambda, mu };
}

// Score matrix directly from two expected-goal rates — used by the attack/defense
// (goals) model, which computes λ/μ from per-team attack & defense ratings.
export function matrixFromLambdas(lambda, mu, maxGoals = MAX_GOALS) {
  return buildMatrix(lambda, mu, DC_RHO, maxGoals);
}

// First-half score matrix. No dedicated 1H model exists, so we scale both
// expected-goal rates by FIRST_HALF_GOAL_FRACTION. APPROXIMATION — not
// validated against half-time data; treat first-half value flags with caution.
export function firstHalfMatrix(ratingA, ratingB, homeBonusA = 0, frac = FIRST_HALF_GOAL_FRACTION, maxGoals = MAX_GOALS) {
  const lambda = expectedGoals(ratingA, ratingB, homeBonusA) * frac;
  const mu = expectedGoals(ratingB, ratingA, -homeBonusA / 2) * frac;
  return { matrix: buildMatrix(lambda, mu, DC_RHO, maxGoals), lambda, mu };
}

// 1X2 probabilities — the scoreline matrix collapsed three ways.
export function matchProb(ratingA, ratingB, homeBonusA = 0) {
  const { matrix, lambda, mu } = scoreMatrix(ratingA, ratingB, homeBonusA);
  let winA = 0, draw = 0, winB = 0;
  for (let a = 0; a < matrix.length; a++)
    for (let b = 0; b < matrix.length; b++) {
      const p = matrix[a][b];
      if (a > b) winA += p; else if (a < b) winB += p; else draw += p;
    }
  return { winA, draw, winB, expectedGoalsA: lambda, expectedGoalsB: mu };
}

// Over/under totals. Integer lines (e.g. 3.0) can push; half lines (2.5) cannot.
export function totalsProb(matrix, line) {
  let over = 0, under = 0, push = 0;
  for (let a = 0; a < matrix.length; a++)
    for (let b = 0; b < matrix.length; b++) {
      const t = a + b, p = matrix[a][b];
      if (t > line) over += p; else if (t < line) under += p; else push += p;
    }
  return { over, under, push };
}

// Goal handicap applied to the HOME side (homeLine -1.5 → home must win by 2+).
// Whole-number lines can push (stake refunded).
export function spreadProb(matrix, homeLine) {
  let homeCover = 0, push = 0, awayCover = 0;
  for (let a = 0; a < matrix.length; a++)
    for (let b = 0; b < matrix.length; b++) {
      const margin = a - b + homeLine, p = matrix[a][b];
      if (margin > 0) homeCover += p; else if (margin < 0) awayCover += p; else push += p;
    }
  return { homeCover, push, awayCover };
}

// Asian handicap result for the HOME side at handicap `hp`, returning
// { cover, push, lose } probabilities. Quarter lines (.25 / .75) are SPLIT
// into the two adjacent whole/half lines (half stake each) and averaged — so
// +0.25 prices strictly between +0.0 and +0.5, never identical to either.
export function asianHandicap(matrix, hp) {
  const single = (line) => {
    let cover = 0, push = 0, lose = 0;
    for (let a = 0; a < matrix.length; a++)
      for (let b = 0; b < matrix.length; b++) {
        const m = a - b + line, p = matrix[a][b];
        if (m > 0) cover += p; else if (m < 0) lose += p; else push += p;
      }
    return { cover, push, lose };
  };
  if (Math.abs((hp * 2) % 1) < 1e-9) return single(hp); // whole or half line
  const lo = single(hp - 0.25), hi = single(hp + 0.25); // quarter → average the split
  return {
    cover: (lo.cover + hi.cover) / 2,
    push: (lo.push + hi.push) / 2,
    lose: (lo.lose + hi.lose) / 2,
  };
}

// Both teams to score.
export function bttsProb(matrix) {
  let yes = 0;
  for (let a = 1; a < matrix.length; a++)
    for (let b = 1; b < matrix.length; b++) yes += matrix[a][b];
  return { yes, no: 1 - yes };
}

// Convert a fair probability (0–1) to American moneyline odds.
// Favorites (p > 0.5) come out negative ("lay $X to win $100"); underdogs
// positive ("$100 wins $X"). NOTE: these are no-vig "fair" odds derived
// straight from the model probability — real sportsbooks bake in a margin,
// so their posted lines will be a little worse than these. Use these to
// judge whether a book's price offers value.
export function toAmericanOdds(p) {
  if (p <= 0) return Infinity;
  if (p >= 1) return -Infinity;
  return p > 0.5 ? (-100 * p) / (1 - p) : (100 * (1 - p)) / p;
}

// Format American odds for display: leading +/- sign, rounded to a whole number.
export function formatAmericanOdds(p) {
  const o = toAmericanOdds(p);
  if (!Number.isFinite(o)) return o > 0 ? "+∞" : "-∞";
  const r = Math.round(o);
  return (r > 0 ? "+" : "") + r;
}

// Sample a scoreline (for Monte Carlo). allowDraw=false → penalty shootout nudge toward higher Elo.
export function sampleMatch(ratingA, ratingB, homeBonusA = 0, allowDraw = true, rng = Math.random) {
  const eA = expectedGoals(ratingA, ratingB, homeBonusA);
  const eB = expectedGoals(ratingB, ratingA, -homeBonusA / 2);
  let goalsA = poissonSample(eA, rng);
  let goalsB = poissonSample(eB, rng);
  if (!allowDraw && goalsA === goalsB) {
    if (rng() < expectedScore(ratingA, ratingB, homeBonusA)) goalsA += 1; else goalsB += 1;
  }
  return { goalsA, goalsB };
}
