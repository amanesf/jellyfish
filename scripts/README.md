# The measure loop

plan.md §2.2 rules out adjusting colour and form by eye, so every claim about
the render has to come out of a statistic computed the same way on the render
and on the reference image. sakura kept losing this loop and rebuilding it ad
hoc; it lives here from the start.

**One file names the reference.** `scripts/reference.js` holds the image's path
and loads `scripts/tank.json`. Nothing else names either. Replacing the
reference means editing that one line and then rerunning, in this order:

```sh
node scripts/geom.js --write --overlay   # tank.json + app/src/core/measured.ts
node scripts/ramp.js --write             # app/src/scene/ramps.ts + scripts/ramps.json
node scripts/plate.js                    # app/public/plate.webp
node scripts/watermodel.js --solve       # the water's constants, refitted
```

Skipping that is how sakura ended up with shader constants fitted to an image
that had been deleted, and comments quoting statistics nobody could reproduce.

## Measuring

```sh
# deterministic capture at the reference's own 896x1200 (the scene freezes at
# ?t=<seconds>, and ?fit=frame hands the whole viewport to the picture)
node scripts/capture.js /tmp/shot.png 60

# the water, band by band down the tank: reference first, render second
node scripts/waterprofile.js 1786667042546.png /tmp/shot.png

# the geometry, drawn back over the paint so the fit can be checked
node scripts/geom.js --overlay           # /tmp/geom.png

# the plate's matte, over magenta so any leak is obvious
node scripts/plate.js --preview          # /tmp/plate-preview.png

# sRGB <-> the pre-tonemap linear HDR every colour constant is authored in
node scripts/hdr.js --to-hdr 30,75,130
```

## Notes

- **Medians are not enough.** The first render matched the reference's band
  medians to RMSE 4.8 — inside the acceptance bar — and looked obviously wrong,
  because its water was the same colour everywhere and the reference's is shot
  through with light shafts. `waterprofile.js` reports each band's p10-p90
  spread beside its median for that reason, and `watermodel.js` fits both.
- **Fit on the CPU, check on the GPU.** One capture under SwiftShader costs
  three minutes; `watermodel.js` is a port of the water shader plus the
  renderer's ACES and sRGB encode, so a solve costs seconds. It does not model
  bloom or the Kuwahara pass, so a solved parameter set is checked against a
  real capture before it is believed.
- **Argue with pinned parameters.** The solver will happily park a value on a
  bound for a fraction of a point of cost. `watermodel.js --solve` marks those
  in its output.
- **Do not edit `app/src` while a capture is running.** It goes through the vite
  dev server, so an edit mid-capture is hot-reloaded into the result.
- `capture.js` reads the canvas from inside a frame callback rather than using
  `page.screenshot()`, which times out at SwiftShader's speed.
