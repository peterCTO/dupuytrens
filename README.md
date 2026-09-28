# Dupuytren's Hand

An educational model of a hand with Dupuytren's contracture, drawn in the calm
style of an encyclopaedia plate: a lifelike but clearly modelled right hand on a
white page.

This first milestone is the model itself. Choose which fingers are affected and
dial in the MCP, PIP and DIP flexion; the palmar cord and nodule appear under
the skin and bowstring across the flexed joints, and the panel shows the
Tubiana stage.

![Palmar aspect](docs/screenshots/palmar.png)

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Add `?view=ulnar` (or `palmar`, `radial`, `dorsal`) to open on a given aspect.

## How the hand is made

There is no sculpted mesh. The skin is a signed distance field built from
anatomical shapes (tapered phalanges, finger pads, eminences, metacarpals,
webs, the palmar hollow) blended with a smooth minimum, so creases and webs
form naturally for any pose.

- `src/hand/anatomy.ts`: dimensions, finger kinematics and the cord path.
- `src/hand/sdf.ts`: the distance field and the skin colouring (creases, nails, flush).
- `src/hand/mesher.ts`: Surface Nets meshing, sampled finely only near the skin.
- `src/hand/worker.ts`: runs the meshing off the main thread (about a second at full detail).
- `src/hand/skin.ts`: bends the current mesh while a slider is dragged, so the
  finger follows the pointer; the exact mesh replaces it when the pointer settles.
- `src/scene.ts`: lighting, material, plinth and camera.
