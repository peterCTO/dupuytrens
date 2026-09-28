# Dupuytren's Hand

An educational model of a hand with Dupuytren's contracture, drawn in the calm
style of an encyclopaedia plate: a lifelike but clearly modelled right hand on a
white page.

This first milestone is the model itself. Choose which fingers are affected and
dial in the MCP, PIP and DIP flexion; the palmar cord and nodule appear under
the skin and bowstring across the flexed joints, and the panel shows the
Tubiana stage.

![Palmar aspect](docs/screenshots/palmar.png)

**Theatre** mode operates on the finger: a fasciectomy through a Z-plasty.
Mark the Z in violet, trace the incision with the scalpel, raise the flaps and
hold them with skin hooks, click the cord to excise it (the finger then
straightens), transpose the flaps and place the sutures.

![Theatre: the cord exposed](docs/screenshots/theatre-cord.png)

## Roadmap

1. The model and the clinic: configure the contracture. *Done.*
2. Theatre: fasciectomy with Z-plasty. *Done, first version.*
3. Recovery: a physio stage with a hand specialist (hand therapist) after the
   operation, covering splinting, scar care and exercises to keep the finger
   straight.

## Running it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Add `?view=ulnar` (or `palmar`, `radial`, `dorsal`) to open on a given aspect,
or `?mode=theatre&step=excise` to jump to a step of the operation.

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
- `src/hand/surgery.ts`: the Z-plasty geometry and how the finger responds once released.
- `src/scene.ts`: lighting, material, plinth and camera, plus the marks drawn on the skin.
- `src/instruments.ts`: scalpel, skin hooks, sutures, and the nerves and arteries in the wound.
- `src/theatre.ts`: the steps of the operation and the theatre panel.
