// Practice dummies for solo testing: node test/bots.js ROOM [count] [host]
// They shuffle around their spawn point and take pot shots so you can test hits and damage.
import WebSocket from 'ws';

const room = (process.argv[2] || 'TEST').toUpperCase();
const count = Number(process.argv[3]) || 3;
const host = process.argv[4] || 'localhost:8787';
const CLASSES = ['rattler', 'scatter', 'longshot', 'thumper'];
const NAMES = ['Rusty', 'Sprocket', 'Gizmo', 'Bolt', 'Clank', 'Widget', 'Cog', 'Nibs'];

for (let i = 0; i < count; i++) {
  const ws = new WebSocket(`${host.startsWith('ws') ? host : 'ws://' + host}/ws?room=${room}`);
  const me = { id: 0, alive: false, home: [0, 0, 0], t: Math.random() * 10, others: new Map() };
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('open', () => send({ t: 'join', name: NAMES[i % NAMES.length], cls: CLASSES[i % 4], color: (i * 5 + 3) % 12 }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') me.id = m.id;
    if (m.t === 'spawn' && m.id === me.id) { me.alive = true; me.home = m.p; }
    if (m.t === 'kill' && m.v === me.id) me.alive = false;
    if (m.t === 'round' || m.t === 'end') me.alive = false;
    if (m.t === 's') for (const e of m.p) if (e[0] !== me.id) me.others.set(e[0], e);
  });
  setInterval(() => {
    if (!me.alive) { send({ t: 'spawn', cls: CLASSES[i % 4] }); return; }
    me.t += 0.1;
    const x = me.home[0] + Math.sin(me.t * 0.8) * 0.3, z = me.home[2] + Math.cos(me.t * 0.6) * 0.3;
    send({ t: 'st', s: [x, me.home[1], z, me.t * 0.5, 0, 0, 1] });
    if (Math.random() < 0.04 && me.others.size) {
      const target = [...me.others.values()][Math.floor(Math.random() * me.others.size)];
      send({ t: 'fire', w: 'rattler', o: [x, me.home[1] + 0.9, z], e: [[target[1], target[2] + 0.8, target[3]]] });
      if (Math.random() < 0.5) send({ t: 'hit', to: target[0], d: 8, w: 'rattler' });
    }
  }, 100);
}
console.log(`${count} practice bots heading to room ${room}`);
