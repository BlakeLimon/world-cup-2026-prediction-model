// adjustments.mjs — situational rating adjustments layered on top of the Elo
// model: host advantage, altitude, rest, travel (as Elo deltas), plus a weather
// goals factor. ALL MAGNITUDES ARE TUNED ESTIMATES, NOT BACKTESTED — there's no
// venue/weather/rest data in results.json to validate against. Treat as informed
// priors, and keep them small. Every constant here is meant to be tweaked.
import { readFileSync } from "node:fs";

export const HOSTS = new Set(["usa", "mexico", "canada"]);
// Teams whose home matches are routinely played at altitude (acclimatized).
export const ACCLIMATIZED = new Set(["mexico", "bolivia", "ecuador", "colombia", "peru"]);

// --- tunable magnitudes (Elo points unless noted) ---
export const HOST_BONUS = 50;          // host nation playing in its own country
export const ALT_FULL_PENALTY = 45;    // penalty to a non-acclimatized side at Azteca-level altitude
export const ALT_THRESHOLD_M = 1200;   // altitude below this is ignored
export const REST_PER_DAY = 7;         // Elo per day of rest advantage over opponent (capped ±3 days)
export const TRAVEL_PER_1000KM = 6;    // fatigue penalty per 1000 km travelled since last match

const { venues } = JSON.parse(readFileSync(new URL("./data/venues.json", import.meta.url), "utf8"));

export function venueOf(city) {
  if (!city) return null;
  return venues[city.toLowerCase().trim()] || null;
}

// Great-circle distance between two {lat,lng} points, in km.
export function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Compute per-team Elo deltas for a fixture. Inputs are all optional; whatever
// is supplied gets applied. Returns { adjHome, adjAway, notes }.
export function matchAdjustments({ homeKey, awayKey, venue = null, restHome = null, restAway = null, travelKmHome = 0, travelKmAway = 0 } = {}) {
  let adjHome = 0, adjAway = 0;
  const notes = [];

  // Host advantage — goes to the host nation playing in its own country,
  // regardless of which side the feed lists as "home" (neutral-site tournament).
  // With no venue, fall back to assuming a listed home host is at home.
  if (venue) {
    if (venue.country === homeKey) { adjHome += HOST_BONUS; notes.push(`host +${HOST_BONUS} (${homeKey})`); }
    else if (venue.country === awayKey) { adjAway += HOST_BONUS; notes.push(`host +${HOST_BONUS} (${awayKey})`); }
  } else if (HOSTS.has(homeKey)) {
    adjHome += HOST_BONUS;
    notes.push(`host +${HOST_BONUS} (${homeKey})`);
  }

  // Altitude — penalize non-acclimatized teams, scaled to Azteca (2200m) = full.
  if (venue && venue.altitudeM > ALT_THRESHOLD_M) {
    const scale = Math.min(1, (venue.altitudeM - ALT_THRESHOLD_M) / (2200 - ALT_THRESHOLD_M));
    const pen = Math.round(ALT_FULL_PENALTY * scale);
    let applied = false;
    if (!ACCLIMATIZED.has(homeKey)) { adjHome -= pen; applied = true; }
    if (!ACCLIMATIZED.has(awayKey)) { adjAway -= pen; applied = true; }
    if (applied) notes.push(`altitude ${venue.altitudeM}m: -${pen} to non-acclimatized`);
  }

  // Rest — advantage to the better-rested side (difference capped at ±3 days).
  if (restHome != null && restAway != null) {
    const diff = Math.max(-3, Math.min(3, restHome - restAway));
    const delta = Math.round((diff * REST_PER_DAY) / 2);
    if (delta !== 0) {
      adjHome += delta; adjAway -= delta;
      notes.push(`rest ${restHome}v${restAway}d: ${delta > 0 ? "+" : ""}${delta} home`);
    }
  }

  // Travel fatigue since last match.
  if (travelKmHome > 0) {
    const p = Math.round((travelKmHome / 1000) * TRAVEL_PER_1000KM);
    if (p) { adjHome -= p; notes.push(`travel home ${Math.round(travelKmHome)}km: -${p}`); }
  }
  if (travelKmAway > 0) {
    const p = Math.round((travelKmAway / 1000) * TRAVEL_PER_1000KM);
    if (p) { adjAway -= p; notes.push(`travel away ${Math.round(travelKmAway)}km: -${p}`); }
  }

  return { adjHome, adjAway, notes };
}

// Weather → goals multiplier (affects totals mainly). Uses Open-Meteo (free,
// no key). Heat, heavy rain, and strong wind all suppress scoring a little.
export async function weatherGoalsFactor(venue, dateISO) {
  if (!venue) return { factor: 1, notes: [] };
  const date = dateISO.slice(0, 10);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${venue.lat}&longitude=${venue.lng}` +
    `&daily=temperature_2m_max,precipitation_sum,wind_speed_10m_max&timezone=auto&start_date=${date}&end_date=${date}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { factor: 1, notes: ["weather unavailable"] };
    const d = (await res.json()).daily;
    const temp = d.temperature_2m_max?.[0], precip = d.precipitation_sum?.[0], wind = d.wind_speed_10m_max?.[0];
    let factor = 1;
    const notes = [];
    if (temp >= 32) { factor *= 0.92; notes.push(`heat ${temp}°C`); }
    if (precip >= 10) { factor *= 0.95; notes.push(`rain ${precip}mm`); }
    if (wind >= 40) { factor *= 0.97; notes.push(`wind ${wind}km/h`); }
    if (!notes.length) notes.push(`mild (${temp}°C)`);
    return { factor, notes, temp, precip, wind };
  } catch {
    return { factor: 1, notes: ["weather fetch failed"] };
  }
}

// --- self-test ---
if (process.argv.includes("--test")) {
  const ok = (n, c) => console.log(`  ${c ? "✓" : "✗"} ${n}`);
  console.log("\n  adjustments self-test\n");
  // haversine: NY ↔ LA ≈ 3940 km
  const ny = venueOf("new york"), la = venueOf("los angeles");
  const d = haversineKm(ny, la);
  ok(`NY→LA ≈ 3940km (got ${Math.round(d)})`, Math.abs(d - 3940) < 200);
  // host bonus
  const h = matchAdjustments({ homeKey: "usa", awayKey: "brazil" });
  ok("USA home gets host bonus", h.adjHome === HOST_BONUS && h.adjAway === 0);
  // altitude: Mexico (acclimatized) vs Germany at Azteca → Germany penalized only
  const a = matchAdjustments({ homeKey: "mexico", awayKey: "germany", venue: venueOf("mexico city") });
  ok("Azteca penalizes Germany not Mexico", a.adjAway < 0 && a.adjHome === HOST_BONUS);
  // rest: home rested 5, away 2 → home edge
  const r = matchAdjustments({ homeKey: "spain", awayKey: "italy", restHome: 5, restAway: 2 });
  ok("more rest → home advantage", r.adjHome > 0 && r.adjAway < 0);
  console.log("");
}
