# Call of the Pickle

A small browser arena shooter for a team of about ten. Pickle fighters, four loadouts, five
arenas (one of them a snowy North Pole for the holidays), free-for-all or two teams. No accounts, no install: everyone opens the same link.

**Play it: https://call-of-the-pickle.call-of-the-pickle.workers.dev**

Press Deploy, then use "Copy invite link" and send it to the others. Everyone with the same room
code lands in the same game. The link is public, so anyone who has it can play.

## Play locally

```bash
npm install
```

```bash
npm start
```

Open http://localhost:8080 (set `PORT` to change it). Press Deploy, then send the invite link
(or the room code) to the others. People on the same network can join via your machine's IP.

Practice targets for solo testing, while the server runs:

```bash
node test/bots.js ROOMCODE 3 localhost:8080
```

Useful URL switches: `?r=CODE` joins that room, `?mute` silences the tab.

## Hosting (Cloudflare Workers, free plan)

The live site above runs on Cloudflare. Pushing to GitHub does not update it; to publish a new
version, run `npx wrangler deploy` from this folder.

The whole game is static files plus one small WebSocket room per room code. On Cloudflare the
files are served as Worker assets and each room is a Durable Object (`server/worker.js`,
`wrangler.toml`). This uses SQLite-backed Durable Objects, which Cloudflare offers on the free
Workers plan.

To deploy from a machine that is not logged in yet:

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

Wrangler prints the public URL when it finishes.

Rough free-plan budget: incoming WebSocket messages are billed at 20 per request against
100,000 requests a day, and a ten-player half hour sends roughly half a million messages
(about 27,000 requests). A weekly session fits with a wide margin.

Any Node host works too (`npm start` is all it needs), for example a home server or a free
Render web service.

## How it fits together

- `public/shared/` rules, maps and the room logic, used by both browser and server
- `server/node.js` Node host, `server/worker.js` Cloudflare host (both wrap the same `Room`)
- `public/js/` the client: `game.js` (loop, weapons, netcode), `world.js` (block rendering and
  collision), `avatar.js`, `fx.js`, `audio.js`, `hud.js`, `main.js` (menus)
- `test/room.test.js` room logic tests (`npm test`)

The server is a referee, not an anti-cheat: each browser simulates its own movement and reports
its own hits, and the room owns health, scores, spawns, pickups and the round clock. That keeps
it tiny and responsive, and is the right trade for a group of colleagues.

## Rebuilding the art and sound

- Models: `tools/blender/build_assets.py` builds every model in Blender (fighter, weapons,
  pickups and the arena props) and exports the `.glb` files in `public/assets/models/`. The
  holiday set (trees, presents, snowmen, sleigh, Santa hats and the snow, ice, gingerbread and
  peppermint blocks) is the `xmas` builder and goes to `xmas.glb`.
- Building blocks: each arena is assembled from kit blocks (brick, stone, crate, container,
  steel platform, planks, can, cheese, cinder block, floor tile, paver). A map's `kit` says which
  block each part uses and `palette` tints it; `public/js/world.js` instances them.
- Arenas: `public/shared/maps.js`. `b.prop('Barrel', x, z)` places a solid prop (it gets an
  invisible collision box), `b.decor(...)` places decoration, and `scenery` lists the giant
  kitchen items standing outside the walls. A map with `hats: true` puts a Santa hat on every
  fighter and `snow: true` makes it snow.
- Balance: all weapon numbers live in `public/shared/config.js`; `node tools/balance.js` prints
  shots-to-kill and time-to-kill at several ranges so changes can be checked against numbers.
- Sound: `tools/build_sfx.sh <sonniss dir> <kenney dir>` cuts the clips in `public/assets/sfx/`
  with ffmpeg from the source recordings (which are not in the repo; see Credits).

## Credits

- Sound: recordings from the [Sonniss GDC game-audio bundles](https://sonniss.com/gameaudiogdc)
  (royalty-free for use in games; the clips ship only as part of this game and are not for reuse
  as sound files), a CC0 grenade-launcher recording by LeMudCrab (freesound.org 163458), and a few
  interface sounds from [Kenney](https://kenney.nl) packs (CC0).
- Rendering: [three.js](https://threejs.org), MIT.
