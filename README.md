# Sentinel Lava Lamp

A glass lava lamp you can watch, tune, and play music under.

The wax is driven by heat, not by a loop. The coil warms a pool at the bottom until it domes up, necks and pinches off a blob. Each blob carries its own temperature: it rises while it's warm, coasts through the insulated middle of the bottle, cools under the cap, sinks and melts back into the pool. Small blobs heat and cool faster than big ones, blobs stretch as they move and wobble when they break free, and the liquid carries slow convection currents that never repeat.

Behind the lamp, real Navier–Stokes smoke (buoyancy plus vorticity confinement, solved on the GPU) rises from the floor and off the warm cap, lit and shadowed by the lamp's own glow. The glass refracts the room behind it, reflects a studio's strip lights, and the lamp throws light onto the wall and a glossy table.

Drop in an mp3, or paste a YouTube link, and the coil follows the low end. Drag inside the glass to nudge the wax, or drag the air to push the smoke.

**Try it:** https://sentinel-lava-lamp.vercel.app

Amber, a cool coil, a still rise, large gobs, and a dim glow are the defaults.

## Run it locally

```bash
npm install
npm run dev
```

Then open http://127.0.0.1:8080

## Credits

- Glass and metal reflections use [Monochrome Studio 02](https://polyhaven.com/a/monochrome_studio_02) by Poly Haven (CC0), via the three.js examples.
- Dithering and grain use a [blue-noise texture](https://github.com/Calinou/free-blue-noise-textures) by Christoph Peters (CC0).
- The smoke solver is adapted from [Navier–Stokes Laboratory](https://github.com/jkh2/navier-stokes-laboratory).
