# Universe Simulator

A deterministic, procedurally generated universe that runs in the browser. It goes from the Big Bang through galaxies, stars, planets, biospheres and civilizations. Every number on screen is read from simulation state.

```bash
npm install
npm run dev        # → http://localhost:5173
npm test           # 110 tests (Vitest, Node — no browser needed)
npm run build
```

URL parameters: `?seed=123456&galaxies=128&density=1`. Same seed + settings ⇒ same universe.

**Controls:** drag to orbit · right/shift-drag to pan · wheel to zoom (zooming far out returns to the parent object) · click to select and fly · `Esc` up one level · `Space` pause · `[ ]` speed · `.` single tick · `/` search · `` ` `` debug · `?` help.

---

## 1. Architecture

```
src/engine/            ← pure TypeScript, no React/DOM/WebGL; fully testable in Node
  core/                RNG + hashing, high-precision clock, names/IDs, math, formatting
  gen/                 cosmology, galaxies + star catalogs, stellar physics, planets, terrain
  physics/             Kepler orbits + secular precession, climate, rotation/seasons
  life/                piecewise-analytic evolution model
  civ/                 civilization state machine, engine, cities/infrastructure
  survey/              per-galaxy survey (pure), worker pool, merged catalog
  spatial/             uniform hash grid (k-NN, range queries)
  sim/                 Simulation facade, world queries, interventions, stats,
                       describe (inspector), history, search, observer
  persistence/         save / load / validate / replay-verify
src/render/            Three.js: camera rig, cosmic layer, system layer, shaders
src/app/runtime.ts     frame loop bridging engine ⇄ renderer ⇄ UI store
src/store/             Zustand UI state (throttled snapshots, never per frame)
src/ui/                React panels
```

Data flows one way. `Simulation.update(dt)` advances state, `Renderer.render()` reads it, and every ~125 ms a snapshot goes to the Zustand store, which drives React. React never runs per frame and never mutates the engine directly (actions go through `runtime`).

## 2. Simulation model

- **Cosmology.** Flat ΛCDM scale factor `a(t)`, CMB temperature `T₀/a`, and named epochs. Galaxy positions expand with `a(t)`. Primordial gas collapses onto dark-matter halos and then fades into the galaxies.
- **Stars.** Masses come from the Kroupa IMF. L, R, T and the main-sequence lifetime derive from mass (+[Fe/H]). Each star goes through protostar, main sequence (brightening), red giant, then a white dwarf, neutron star or black hole by mass. Supernova flashes come from the same timeline.
- **Planets.** Built from a disk (mass ∝ M★·10^[Fe/H]):
  - Geometric orbital slots; core accretion with a snow-line jump.
  - Runaway gas accretion if the core forms before the disk dissipates.
  - Giant-impact merging until neighbours are ≥ 9 mutual Hill radii apart; Kirkwood-gapped asteroid belts; hot-Jupiter migration.
  - Mass–radius relations, Jeans + non-thermal atmospheric escape, and tidal locking from Gladman's timescale (including 3:2 resonances).
  - A climate solve: gray greenhouse + water-vapour and ice-albedo feedback + carbonate–silicate thermostat + Clausius–Clapeyron water phase.
  - The type is then *classified from the results*. Calibrated: Earth ≈ 288 K, Venus ≈ 660 K, Mars ≈ 210 K.
- **Orbits.** Keplerian ellipses: Newton-solved Kepler's equation, vis-viva speeds, Laplace–Lagrange apsidal precession, barycentric stellar wobble. Moons sit inside 0.4 Hill radii and outside the Roche limit. Asteroids are solved per-vertex on the GPU.
- **Rotation.** The spin axis is fixed in inertial space, so seasons emerge from geometry. The inspector shows the live sub-solar latitude and season.
- **Life.** Evolutionary "work" accrues at rate H (habitability from temperature, water, pressure, stellar energy, geology, chemistry and magnetism). Each stage transition has a duration and a *gate* (the great filters). Mass extinctions follow a Poisson process. H is piecewise-constant, so stage times are solved *analytically*, with no stepping.
- **Civilizations.** Each is a state machine (population, intelligence, technology 0–6, energy, resources, territory, stability, culture, economy, colonies) with:
  - Exact logistic growth and exponential relaxation.
  - State-dependent Poisson events: famine, war (incl. nuclear), pandemic, migration, collapse, discoveries, impacts, disasters, self-destruction, decline. Each one mutates state and records before/after values.
  - A space programme: satellites, then orbital habitats, lunar bases, interplanetary colonies, and interstellar colony ships aimed at real nearest stars by k-NN.

## 3. Procedural generation

Seeding is hierarchical: `hash32(universeSeed, galaxyIndex)` → `hash32(galaxySeed, starIndex)` → `hash32(starSeed, 1000+planet)` → moons, life genome, terrain, cities. Every entity has its own RNG stream, so anything can be generated lazily, in any order, on any thread, with identical results. Moons and dynamics use separate streams, so the fast survey (which skips them) yields exactly the same planets as the detailed view.

## 4. Determinism strategy

- Integer-only RNG (sfc32 + lowbias32 hashing via `Math.imul`); `Math.random` is used only for the "random seed" button.
- Time is `whole years + fraction`, so the clock keeps sub-second resolution at 13.8 Gyr. Periodic phases are reduced before multiplying.
- Pure-function layers: stars, planets, climate and life are functions of `(seed, interventions, t)`.
- Civilizations step with state-determined step lengths and are mutually independent. One jump and a thousand small advances therefore produce **bit-identical** state, verified by an IEEE-754-level state hash.
- Interventions are event-sourced. The log is part of the universe definition, and a new intervention in the past branches the timeline.

## 5. Rendering strategy

- **Camera-relative layers.** Cosmic (kpc) and system (AU) scenes are drawn relative to the focus with precision-safe anchors, so the GPU only ever sees small numbers (the dynamic range is ~10¹⁷).
- **Stars.** All ~475k catalog stars are **one `THREE.Points` draw call**. Galaxy transforms (expansion + pattern rotation) live in a 4×G float texture. Life phase, colour and supernova flashes are evaluated in the vertex shader from per-star birth/death attributes, so time travel costs nothing on the CPU. Brightness is auto-exposed on the focal distance.
- **Galaxies.** Each has an analytic impostor matching the generator's arm geometry (far LOD). It dims up close and disappears inside the galaxy.
- **Planets.** Procedural shader built on the *same integer-hash terrain* as the 2-D civilization map: sea level calibrated to the simulated water fraction, ice caps from the ice fraction (seasonally shifted), vegetation from the biosphere stage, lava from geology, banded giants, clouds, atmospheric rim, and night-side city lights from the civilization's actual cities. Spheres switch to a dense mesh only when the planet is large on screen.
- **Post-processing.** Bloom, plus **dynamic resolution scaling** when the GPU falls below ~38 FPS.

## 6. Performance strategy

- **No per-object heap for the many.** Stars are structure-of-arrays typed arrays (~52 B/star). Planetary systems are never stored; they're regenerated on demand (LRU of 384).
- **Survey in a Web Worker pool** (≤ 8 workers, typed arrays transferred zero-copy, largest-first load balancing, cancellable, main-thread fallback).
- **O(log n) statistics at any time.** Every population is a pair of sorted arrays (`count(start ≤ t) − count(end ≤ t)`), so charts over all of cosmic history and stats after time travel are just binary searches.
- **Fixed work budget per frame.** If exceeded, simulated time lags (shown as "compute-bound") rather than skipping work.
- **Time travel.** Sorted checkpoints of live civilizations only (dead ones are immutable) plus append-only histories truncated on restore.
- **Spatial grid.** Counting-sort uniform grid; k-NN with bounded insertion and cached neighbour lists.

Full default universe (128 galaxies): **474,606 stars, 2.3 M planets, ~7,000 biospheres**. The survey takes ~2–3 s on 8 cores, and simulating all 13.8 Gyr of civilization history takes ~0.7 s.

## 7. Persistence strategy

Saves never contain the generated universe. They hold the seed and config, the precise time, the intervention log, a civilization-engine snapshot (fast load), recent events, the camera focus, and a **state hash**. Files are validated twice: structurally (untrusted input), then semantically against the regenerated universe. `replayHash` proves a save can be rebuilt from seed + interventions alone. Saves are tens of KB to a few MB. Supports browser storage plus export/import as JSON.

## 8. Major trade-offs

- **Catalog stars are a sample** (thousands per galaxy, not 10¹¹). Statistics count simulated objects honestly; the inspector shows the represented stellar mass.
- **Civilizations are independent**, which is what enables exact determinism under chunked stepping. There's no first contact.
- **Planet climate uses time-averaged insolation.**
- **Galaxy rotation uses the density-wave pattern speed** rather than differential rotation.
- **Survivorship and timescales are realistic,** so at the present most living civilizations are interstellar (younger ones are brief). Use **"Watch the next civilization rise"** in the stats panel, or *Spawn civilization*, to see one emerge.
- **Transcendental functions** make cross-*engine* bit-identity unguaranteed (see REVIEW.md).

## 9. Extending

- **New intervention:** add a kind in `sim/interventions.ts`. It becomes either an `EnvPatch` (re-solved by the climate/life layers) or a civ-state action (`Simulation.applyCivIntervention`). Then add UI in `ui/InterventionPanel.tsx`.
- **New civilization event:** add a rate and handler in `civ/civilization.ts` (fixed order, record before/after effects).
- **New planet property:** derive it in `gen/planets.ts`, expose it in `sim/describe.ts`, and map it to visuals in `render/planetLook.ts`.
- **New statistic:** add sorted start/end arrays in `survey/catalog.ts` (or iterate the civ registry), then surface it via `Simulation.stats`.

See **REVIEW.md** for the self-review: 25 weaknesses found and fixed, with regression tests.
