// Deterministic, seedable RNG (mulberry32) so runs are reproducible for telemetry.
// The seed is carried in GameState.rngState and threaded through resolution.

export function nextRandom(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) | 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
  const value = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  return { value, state: t };
}

/** Inclusive integer in [min, max] given (and advancing) an rng state. */
export function nextIntInRange(
  state: number,
  min: number,
  max: number,
): { value: number; state: number } {
  const { value, state: s } = nextRandom(state);
  return { value: min + Math.floor(value * (max - min + 1)), state: s };
}
