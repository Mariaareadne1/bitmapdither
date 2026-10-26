# CLAUDE.md — working notes

Context for Claude Code sessions. Read this before changing the render path.

## What this is

A real-time Bayer ordered-dither effect for video, used as the cover image on
mariashowalter.com. Plain WebGL, no dependencies, no build step, ES5-compatible
so it drops into any page without a transpiler.

- `halftone-cover.js` — the engine. Exposes `window.HalftoneCover`.
- `bench.html` — standalone tuning tool. Load clips, drag sliders, export
  settings as JSON. Not shipped to the site; it is where the look gets decided.
- `demo/` — a working example in the chosen layout.
- `settings.json` — the agreed look, also baked into the engine's `DEFAULTS`.

**The shader exists in two places.** `halftone-cover.js` holds it as a JS
string array; `bench.html` holds it in a `<script type="x-shader/x-fragment">`
tag. If you change the render maths, change it in both, or the bench will stop
predicting what the site does.

## Running it

Must be served over HTTP. `python3 -m http.server 8000`, then
`localhost:8000/demo/`.

## Invariants — each was a real bug, do not undo them

**Serve over http, never file://.** Browsers refuse to read pixels from a
`file://`-origin video into WebGL. `texImage2D` throws a security error, the
texture stays blank, and the page renders as empty paper. Videos must also be
same-origin or CORS-enabled.

**`gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)`.** Video frames arrive origin
top-left; GL textures start bottom-left. Without it everything renders upside
down.

**Video elements must be in the document.** Detached elements stall at
`readyState === 1` — metadata only, no frames. They live in a 1px invisible
`vault` div. Never `display:none`, which stops decoding entirely.

**Layer presence is latched once per held frame.** `computeEnv` runs inside the
`if (fresh)` block, never per render frame. Evaluating per frame smears every
transition into a 60fps dissolve regardless of the frame-rate setting, which
destroys the stop-motion feel. That is the whole point of the
`cut` / `flicker` / `fade` switch.

**Uncovered pixels fall through to paper, not ink.** The `got` flag tracks
whether any layer contributed. Without it, a missing or still-loading video
renders as a solid black slab instead of blank page.

**Knockout runs before grain and before the dither.** Otherwise grain
reintroduces dots into areas meant to be bare ground — and the cover's
container edge becomes visible, which defeats the layout.

**A texture matted `through light` wants `multiply`, not `screen`.** Screen
cannot darken something already white, so the texture silently vanishes.
Through `dark` areas it is the reverse.

**`sources` vs `layers` in `mount()`.** `sources` swaps only src paths.
Passing a `layers` array replaces it wholesale and drops all the tuning. Prefer
`sources`; if you must pass `layers`, pass complete layer objects.

## Render pipeline order

Pointer displacement → cell quantisation → layer sampling and blending →
matte → tone (+ print wobble) → invert → knockout → grain → Bayer threshold.

The Bayer matrix is built recursively:

    bayer2(a) = fract(a.x*0.5 + a.y*a.y*0.75)      // [[0,2],[3,1]]/4
    bayer4(a) = bayer2(a/2)*0.25 + bayer2(a)
    bayer8(a) = bayer4(a/2)*0.25 + bayer2(a)

## Blend modes

Index order matters — the shader compares against numeric thresholds and the JS
`BLENDS` array must stay in the same order.

0 screen · 1 lighten · 2 multiply · 3 difference · 4 average · 5 dissolve ·
6 negate · 7 solarize

## Testing

No test suite. Verify by loading a page in headless Chromium, screenshotting
the canvas, and checking pixel statistics — output should be almost entirely
pure black and pure white, under ~1% midtones (the rest is screenshot
resampling). Shader compile errors are logged, not thrown, so watch the
console.

Software rendering caps `requestAnimationFrame` well below 60fps, so
timing-dependent assertions must not assume the configured frame rate.

## House style

Vanilla ES5-compatible JS. No frameworks, no bundler, no npm.
