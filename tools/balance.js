// Prints the balance sheet for every weapon straight from the rule file, so tuning is done
// against numbers rather than feel alone.  Run: node tools/balance.js
import { WEAPONS, MAX_HP, PLAYER } from '../public/shared/config.js';

const RANGES = [3, 10, 25, 45];
const BODY_HALF_WIDTH = 0.36;
const pad = (s, n) => String(s).padEnd(n);
const falloff = (d, dist) => {
  if (!d.falloff) return 1;
  const [full, minAt, min] = d.falloff;
  return 1 + (min - 1) * Math.max(0, Math.min(1, (dist - full) / (minAt - full)));
};
// chance that one pellet inside a uniform cone of half-angle `spread` lands on a body-width target
const hitChance = (spread, dist) => {
  const r = Math.tan(spread) * dist;
  return r <= BODY_HALF_WIDTH ? 1 : Math.min(1, (BODY_HALF_WIDTH / r) ** 2 * 1.6);
};

console.log(`Health ${MAX_HP}. Times are milliseconds from the first shot to the kill, every shot landing.\n`);
console.log(pad('weapon', 14) + pad('rpm', 6) + RANGES.map((r) => pad(`${r} m body`, 16)).join('') + pad('head, 10 m', 14) + 'first-shot hit at 25 m');
for (const [id, d] of Object.entries(WEAPONS)) {
  if (d.kind !== 'hitscan') continue;
  const cells = RANGES.map((dist) => {
    const perShot = d.dmg * d.pellets * falloff(d, dist) * (d.pellets > 1 ? hitChance(d.spread, dist) : 1);
    const stk = Math.ceil(MAX_HP / perShot);
    return pad(`${stk} shots ${(stk - 1) * d.rate}`, 16);
  });
  const headShot = d.dmg * d.pellets * d.head * falloff(d, 10);
  const hstk = Math.ceil(MAX_HP / headShot);
  const spread = d.scope ? d.scopedSpread : d.spread;
  console.log(pad(d.name, 14) + pad(Math.round(60000 / d.rate), 6) + cells.join('') + pad(`${hstk} shots ${(hstk - 1) * d.rate}`, 14)
    + `${Math.round(hitChance(spread, 25) * 100)}%` + (d.scope ? ' (scoped)' : ''));
}
console.log('');
for (const [id, d] of Object.entries(WEAPONS)) {
  if (d.kind === 'hitscan') continue;
  const at = (dist) => Math.round(d.dmg * Math.max(0, 1 - (dist / d.radius) ** 1.4));
  console.log(`${pad(d.name, 14)}blast radius ${d.radius} m: ${[0.8, 1.5, 2.5, 3.5].map((x) => `${at(x)} at ${x} m`).join(', ')}; own blast x${d.selfScale}` + (d.direct ? `; direct hit ${d.direct}` : ''));
}
const bloomed = (d) => d.spread + (d.maxBloom ?? 0);
console.log('');
for (const id of ['rattler', 'sidearm']) {
  const d = WEAPONS[id];
  console.log(`${pad(d.name, 14)}spread ${d.spread} rad on the first shot, up to ${bloomed(d).toFixed(3)} when sprayed (${Math.round(hitChance(bloomed(d), 25) * 100)}% hit chance at 25 m); kick ${d.kick} rad per shot`);
}
console.log(`\nMoving at full speed (${PLAYER.speed} m/s) and jumping widen spread further; aiming tightens it.`);
