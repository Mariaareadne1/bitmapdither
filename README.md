# halftone-cover

A real-time bitmap dither effect for video. Bayer ordered dithering, layered
clips, a hand-made stop-motion cadence, and a cursor that scatters the grain.

Plain WebGL in one file. No dependencies, no build step, no npm.

Built for the masthead of [mariashowalter.com](https://mariashowalter.com).

```
halftone-cover.js    the engine — the only file a page needs
bench.html           tuning tool: load clips, drag sliders, export settings
settings.json        the current look, saved
demo/                a working example (layout A), runs as-is
CLAUDE.md            working notes for Claude Code sessions
```

## Try it

The demo ships with stand-in clips, so it runs immediately. It **must** be
served over HTTP — browsers refuse to read video pixels from a `file://` page,
and opening it from disk shows a blank page instead.

```sh
python3 -m http.server 8000
# open http://localhost:8000/demo/
```

Drag across the figure.

## Use it on a page

Three things: a sized container, the script, and one call.

```html
<div id="cover" style="width:74%; height:94%; cursor:crosshair"></div>

<script src="halftone-cover.js"></script>
<script>
  HalftoneCover.mount("#cover", {
    sources: ["media/look.mp4", "media/hair.mp4"]
  });
</script>
```

Clip paths are relative to **the page**, not the script.

> **Use `sources`, not `layers`.** `sources` swaps only the file paths.
> Passing a whole `layers` array replaces the array wholesale and silently
> takes the blend modes, mattes and pulse timing with it.

Anything you leave out falls back to `DEFAULTS` at the top of
`halftone-cover.js` — which is where the saved look actually lives. The
settings are not a separate artefact to load; committing that file commits the
look.

### Other helpers

```js
HalftoneCover.text("#wordmark", { dot: 2 });   // render type as pixels
HalftoneCover.image("#portrait", { dot: 2 });  // dither a still image
```

`text()` keeps the real words in the DOM for screen readers and search
engines, and respects per-run styling, so a two-weight wordmark stays two
weights.

## Tuning the look

Open `bench.html`, drop clips onto the canvas, adjust. Press **copy settings**
and paste the JSON into your `mount()` call or into `settings.json`.

Controls are grouped in signal order.

**Source** — up to three video layers, each with a blend mode, an optional
matte and a trigger.

| | |
|---|---|
| `blend` | `dissolve` replaces what's underneath. `negate` flips the picture underneath to its negative where the incoming clip is dark, so dark over dark reads light instead of stacking into a ghost. `solarize` flips only where both clips are dark. |
| `matte` | Restricts a layer to the light or dark regions of layer A, so a texture reads as showing *through* the subject's shape. Through light wants `multiply`; through dark wants `screen`. |
| `appears` | `always`, or `pulse` to come in on a cycle. |
| `switch` | How it arrives: `cut`, `flicker` (the clips trade frames at random across the window) or `fade`. All quantised to the frame clock. |

**Tone** — exposure, contrast, scan grain, polarity, and the knockout pair.
Pull **blank above** down until a plain background drops out entirely; those
areas render as bare ground with no dots in them, because the knockout runs
before the dither. This is what makes the cover's container edge invisible.

**Dither** — matrix size (2×2, 4×4, 8×8), dot size, threshold, and whether the
source is sampled once per halftone cell or per pixel.

**Motion** — `frame rate` is how often a new frame lands; `speed` is how much
action happens between them. Drop both for stop-motion. Then `judder`
(irregular timing), `drift` (frames sitting off-register) and `print wobble`
(exposure varying frame to frame) supply the handmade imperfections.

**Pointer** — `focus` sharpens detail near the cursor, `reveal` brings the
image out of blank ground, `repel` pushes the grid away, `disperse` scatters
the grain along a drag and lets it settle back.

## Shooting for it

- Hard light, real separation from the background. Thresholding to pure black
  and white destroys subtle tonal steps, so flat lighting turns to mush.
- Shoot at the aspect ratio of the container. `framing: "cover"` crops hard;
  `"contain"` letterboxes.
- Compress before committing — GitHub rejects files over 100MB and the dither
  destroys fine detail anyway:

```sh
ffmpeg -i raw.mov -vf "scale=-2:720" -an -crf 30 -movflags +faststart look.mp4
```

## Accessibility

`respectReducedMotion` is on by default and freezes the cover on a single
frame for visitors who ask for reduced motion. Give the container a `role` and
`aria-label`, as the demo does. `touch-action: pan-y` keeps the page scrollable
on phones despite the drag interaction.

## Credit

Ordered dithering is a technique from the 1970s and isn't anyone's property.
The approach here was worked out after watching a TouchDesigner walkthrough by
[Komal Yadav](https://www.patreon.com/KomalYadav); none of her project files
were used — this is an independent WebGL implementation.
