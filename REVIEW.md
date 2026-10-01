# Self-review: weaknesses found and fixed

I reviewed the code the way a senior graphics/simulation engineer would. Some issues turned
up while profiling and testing during development; the rest came from a dedicated review
pass. Every item below is **fixed in the code**. Items marked 🧪 have a regression test (most
are in `tests/regressions.test.ts`; the others are named in the entry).

| # | Area | Weakness | Fix |
|---|------|----------|-----|
| 1 | Performance / simulation | Civilizations that **stagnated** below the interstellar level kept their 2–20-year steps for hundreds of millions of years. One interval cost 8M steps and ~27 s. | Step length now grows with time spent in the current era (`levelSince`, a pure function of state): cost is O(log age) per era. 🧪 `civ.test.ts` "stagnant civilization" |
| 2 | Numerical stability | The damped fixed-point climate iteration **oscillated** between the snowball and warm branches near the habitable-zone edges and returned whatever iteration 80 held. | Replaced with a flow-following root finder (walk dT/dt ∝ f(T)−T to a sign change, then bisect). The result is the *stable* equilibrium in the planet's current basin. 🧪 `planets.test.ts` "true fixed point" |
| 3 | Simulation correctness | Interventions re-solved the climate from the airless temperature, so a temperate world could **flip into a snowball** purely as a numerical artefact. | The climate now continues from the pre-intervention state (hysteresis), chained through successive patches. 🧪 `interventions.test.ts` "no-op change stays on the same branch", `planets.test.ts` "hysteresis" |
| 4 | Determinism | The home-environment cache filled each bucket with the value at **whichever caller's time came first**, so results depended on frame timing. | The value is evaluated at a canonical time (bucket start or latest patch), making it a pure function of t. 🧪 `determinism.test.ts` (one jump vs. uneven increments) |
| 5 | Performance | k-NN queries for colony ships used `Math.hypot` on whole shells and re-sorted every shell: **2.8 s of a 4.2 s run**. | Squared distances, bounded k-best insertion, and a per-star cached neighbour list. The run dropped 9×. 🧪 `stats-search-spatial.test.ts` (brute-force equality) |
| 6 | Rendering precision | A float64 kpc coordinate 1000 kpc from the origin has a ~7,000 km ulp (≈ one Earth radius), so planet close-ups would jitter. | Hierarchical anchors (star + AU offset), camera-relative layers, and transitions that interpolate a *shrinking offset from the target*. 🧪 `render-logic.test.ts` |
| 7 | Numerical stability | Culture traits random-walked with √dt noise and **drifted to the extremes**. That made stability a death spiral (181 of 183 civilizations died). | Exact Ornstein–Uhlenbeck update around each civilization's innate culture, valid for any step length |
| 8 | Simulation correctness | Hazard counts at 1-Myr steps **saturated** (Poisson capped at 3 per step), so mature civilizations suffered 5,000+ "pandemics". | Per-era hazard tables. Planet-scale hazards are disabled for mature interstellar polities, which get a slow decline hazard instead |
| 9 | Simulation correctness | An orbital station counted as a "refuge", so the **self-destruction filter almost never killed** anyone. | Only self-sufficient planetary or interstellar colonies count as refuges |
| 10 | Race condition | Two time-machine jumps could run **interleaved** (double-click, or a jump plus a rewind) and leave an arbitrary final time. | Jump token: every seek or jump supersedes in-flight jumps, which abandon cleanly. 🧪 |
| 11 | Race / resources | "New universe" during a survey left the **old workers running**, wasting every core. | Cancellation signal terminates the pool immediately. 🧪 |
| 12 | Robustness | If Web Workers were unavailable or crashed (CSP, OOM), generation **failed outright**. | Falls back to a time-sliced main-thread survey for the missing galaxies. 🧪 |
| 13 | Persistence | An imported file with interventions targeting **non-existent objects** passed structural validation and crashed the engine later. | Semantic validation against the regenerated universe (galaxy, star, planet and civ ranges, timeline bounds, physical mass). 🧪 |
| 14 | Performance / time travel | Checkpoints were only appended, so after loading a save **rewinding replayed from the Big Bang** every frame. | Checkpoints are kept sorted and inserted during replays; passing an existing one counts as covered. Lookups use binary search. 🧪 |
| 15 | Scheduling | With no living civilization, the scheduler advanced the whole remaining interval as **one unbudgeted chunk**, simulating every future civilization in it. Jumps could freeze the UI. | Chunks also end at the next scheduled emergence. 🧪 (#10's test relies on it) |
| 16 | Memory (GPU) | Civilization markers replaced vertex attributes in place, **leaking the old GPU buffers** on every change. | A new geometry is built and the old one disposed. Rebuilds are throttled to 4 Hz |
| 17 | State / race | A regenerated universe's old renderer **kept its DOM listeners**, so clicks were handled against a stale simulation. | All listeners are registered via an `AbortController` that is aborted on dispose |
| 18 | Memory (GPU) | Composer, bloom render targets and sky resources were **not disposed** when regenerating. | Full disposal in `Renderer.dispose()` |
| 19 | Performance (GC) | The system layer allocated quaternions and vectors **per planet per frame**, and evaluated the full planet state every frame. | Reused temporaries. Appearance is re-derived at 4 Hz or immediately after a time jump |
| 20 | Rendering | Point-sprite sizes ignored the device-pixel ratio, so **dynamic resolution scaling** changed apparent star sizes. | `uDpr` uniform for stars and markers |
| 21 | Memory | Major events (colonization) were **unbounded** in Gyr-old civilization histories. | Two-tier cap (soft and hard) that keeps defining events. It is a pure function of history length, so replays match. 🧪 |
| 22 | Race condition | Saving or intervening **during an async jump** captured or modified a half-finished state. | Both are refused while `jumping`, with UI feedback. 🧪 |
| 23 | Rendering | Additive stars, primordial gas and territory markers **saturated to white blobs**, and lit surfaces bloomed. | Auto-exposure on the focal distance, gas fades into galaxies, small colony markers, bloom threshold 0.72 |
| 24 | Testing | Render-side logic (anchors, appearance derivation, sea-level calibration, time parsing) was **untested**. | Pure functions extracted and covered in `render-logic.test.ts` |
| 25 | Correctness | Missing-result detection used `Array.some` on a **sparse array** (holes are skipped), so a crashed worker's galaxy would never have been retried. | Index-based check |

## Known limitations (deliberately not "fixed")

- **Cross-engine determinism.** RNG and hashing are pure 32-bit integer arithmetic and bit-identical everywhere. Physics uses `Math.exp/log/pow`, whose last bits are implementation-defined in ECMAScript, so the same seed is guaranteed identical within one JS engine (Node ↔ Chrome share V8) but could differ in the last digit between engines. A fully portable version would need a software libm.
- **Galaxy dynamics.** Stars rotate with their galaxy's spiral *pattern* (a density-wave approximation). Real stars shear differentially through the arms.
- **Civilizations are independent.** There's no inter-civilization contact or war. This independence is also what makes chunked and parallel stepping exactly deterministic. Adding interactions would need lock-step global epochs.
- **Climate uses time-averaged insolation** over the main sequence. The star's displayed luminosity brightens over time, but planetary climate doesn't track it.
