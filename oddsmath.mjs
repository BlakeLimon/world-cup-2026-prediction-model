// oddsmath.mjs — provider-independent odds + value-betting math.
// Used by compare.mjs to turn model probabilities and sportsbook prices
// into expected-value recommendations. Run `node oddsmath.mjs --test`
// to exercise the built-in self-checks.

// ---- format conversions -------------------------------------------------

// American moneyline → decimal odds (total return per $1, stake included).
export function americanToDecimal(a) {
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

// American moneyline → implied probability (includes the book's vig).
export function americanToImpliedProb(a) {
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

// Decimal odds → implied probability.
export function decimalToProb(d) {
  return 1 / d;
}

// ---- consensus / de-vig -------------------------------------------------

// Strip the bookmaker margin so a set of implied probabilities sums to 1.
// Sportsbook prices on the 3 outcomes (home/draw/away) sum to > 1 — the
// excess is the vig. Normalizing recovers the market's "fair" opinion.
export function devig(probs) {
  const sum = probs.reduce((s, p) => s + p, 0);
  return probs.map((p) => p / sum);
}

// Build a de-vigged market consensus from many books.
// `byOutcome` is an array (one per outcome, in a fixed order) of arrays of
// implied probabilities — one entry per book quoting that outcome.
// Returns the consensus fair probability for each outcome.
export function consensusFairProbs(byOutcome) {
  const avg = byOutcome.map((ps) =>
    ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : 0
  );
  return devig(avg);
}

// ---- value / expected value ---------------------------------------------

// Expected profit per $1 staked, given the model's true-probability estimate
// and the decimal odds actually on offer. Positive = +EV (a value bet).
export function evPerDollar(pModel, decimalOdds) {
  return pModel * (decimalOdds - 1) - (1 - pModel);
}

// Decide whether an outcome is a recommended value bet.
//   pModel       – model's fair probability for the outcome
//   pMarket      – de-vigged market consensus probability
//   bestDecimal  – best decimal odds available across books
//   opts.evMin   – minimum EV to recommend (default +2%)
// Requires both a positive edge vs. consensus AND EV above the threshold.
export function evaluateBet(pModel, pMarket, bestDecimal, opts = {}) {
  const evMin = opts.evMin ?? 0.02;
  const edge = pModel - pMarket;
  const ev = evPerDollar(pModel, bestDecimal);
  const value = edge > 0 && ev >= evMin;
  return { edge, ev, value };
}

// ---- self-test ----------------------------------------------------------

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function runTests() {
  let pass = 0,
    fail = 0;
  const check = (name, cond) => {
    if (cond) {
      pass++;
    } else {
      fail++;
      console.log(`  ✗ ${name}`);
    }
  };

  // Format conversions
  check("+150 → 2.5 decimal", approx(americanToDecimal(150), 2.5));
  check("-200 → 1.5 decimal", approx(americanToDecimal(-200), 1.5));
  check("+100 → 2.0 decimal", approx(americanToDecimal(100), 2.0));
  check("+150 → 0.4 implied", approx(americanToImpliedProb(150), 0.4));
  check("-200 → 0.6667 implied", approx(americanToImpliedProb(-200), 2 / 3));
  check("2.5 decimal → 0.4 prob", approx(decimalToProb(2.5), 0.4));

  // De-vig: a 3-way market quoted with vig should normalize to 1.
  const raw = [0.5, 0.3, 0.28]; // sums to 1.08 (8% overround)
  const fair = devig(raw);
  check("devig sums to 1", approx(fair.reduce((s, p) => s + p, 0), 1));
  check("devig keeps ordering", fair[0] > fair[1] && fair[1] > fair[2]);

  // Consensus across two books, two outcomes.
  const consensus = consensusFairProbs([
    [0.55, 0.57], // outcome A across 2 books
    [0.5, 0.48], // outcome B across 2 books
  ]);
  check("consensus sums to 1", approx(consensus[0] + consensus[1], 1));

  // EV: fair coin (p=0.5) at +100 (decimal 2.0) is break-even.
  check("p=0.5 @ +100 is EV 0", approx(evPerDollar(0.5, 2.0), 0));
  // Model says 0.55, book pays +100 → +0.10 EV per $1.
  check("p=0.55 @ +100 is +0.10 EV", approx(evPerDollar(0.55, 2.0), 0.1));

  // evaluateBet: clear value case.
  const v = evaluateBet(0.55, 0.5, 2.0);
  check("0.55 vs 0.50 @ 2.0 is value", v.value === true && approx(v.ev, 0.1));
  // No edge → no bet, even at fair price.
  const nv = evaluateBet(0.45, 0.5, 2.0);
  check("0.45 vs 0.50 is not value", nv.value === false);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  return fail === 0;
}

if (process.argv.includes("--test")) {
  console.log("\n  oddsmath self-test\n");
  process.exit(runTests() ? 0 : 1);
}
