// Boot: settings, home screen, pause menu, and joining a room.
import { loadModels } from './assets.js';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { Sound } from './audio.js';
import { Net } from './net.js';
import { CLASSES, STAT_LABELS, COLORS, MODES, DURATIONS, WEAPONS, cleanName, cleanRoom } from '../shared/config.js';
import { MAPS } from '../shared/maps.js';

const $ = (id) => document.getElementById(id);
const KEY = 'call-of-the-pickle';
const params = new URLSearchParams(location.search);

const settings = Object.assign(
  { name: '', color: Math.floor(Math.random() * COLORS.length), cls: 'rattler', sens: 1, vol: 0.6, fov: 80, mode: 'ffa', map: 0, dur: 300 },
  (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })(),
);
if (!CLASSES.some((c) => c.id === settings.cls)) settings.cls = 'rattler';
if (!(settings.color >= 0 && settings.color < COLORS.length)) settings.color = 0;
if (!(settings.mode in MODES)) settings.mode = 'ffa';
if (!(settings.map >= 0 && settings.map < MAPS.length)) settings.map = 0;
if (!DURATIONS.includes(settings.dur)) settings.dur = 300;
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ } };

const hud = new Hud();
const sound = new Sound();
const muted = params.has('mute');          // ?mute silences this tab without touching saved settings
sound.setVolume(muted ? 0 : settings.vol);
await loadModels();
const game = new Game($('view'), hud, sound, settings);
let net = null;

// ---- small UI helpers -------------------------------------------------------------------
function segmented(container, options, get, set) {
  const paint = () => { for (const b of container.children) b.setAttribute('aria-checked', String(b.dataset.v === String(get()))); };
  container.replaceChildren();
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.v = String(o.v); b.textContent = o.label; b.setAttribute('role', 'radio');
    b.addEventListener('click', () => { set(o.v); paint(); sound.unlock(); sound.play('ui'); });
    container.append(b);
  }
  paint();
  return paint;
}
const modeOpts = Object.entries(MODES).map(([v, m]) => ({ v, label: m.name }));
const mapOpts = MAPS.map((m, v) => ({ v, label: m.name }));
const durOpts = DURATIONS.map((v) => ({ v, label: `${v / 60} min` }));
const randomCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
const inviteLink = (code) => `${location.origin}${location.pathname}?r=${code}`;

async function copy(button, text) {
  const label = button.textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
  catch { button.textContent = text.replace(/^https?:\/\//, ''); }
  setTimeout(() => { button.textContent = label; }, 1600);
}

// ---- home ---------------------------------------------------------------------------------
const nameIn = $('name'), roomIn = $('room'), status = $('status'), playBtn = $('play');
const setPlay = (text) => { playBtn.querySelector('.d1').textContent = text; };
nameIn.value = settings.name;
roomIn.value = cleanRoom(params.get('r') || randomCode());
const invited = params.has('r');
if (invited) { setPlay(`Join room ${roomIn.value}`); $('opts').classList.add('hidden'); }
roomIn.addEventListener('input', () => { roomIn.value = roomIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('newroom').addEventListener('click', () => { roomIn.value = randomCode(); setPlay('Deploy'); $('opts').classList.remove('hidden'); summary(); });
$('copylink').addEventListener('click', (e) => copy(e.currentTarget, inviteLink(cleanRoom(roomIn.value))));

const swatches = $('swatches');
COLORS.forEach((hex, i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', `Headband colour ${i + 1}`);
  b.style.background = '#' + hex.toString(16).padStart(6, '0');
  b.addEventListener('click', () => { settings.color = i; save(); paintSwatches(); game.setPreview(settings.color, settings.cls); summary(); });
  swatches.append(b);
});
function paintSwatches() { [...swatches.children].forEach((b, i) => b.setAttribute('aria-checked', String(i === settings.color))); }
paintSwatches();

const classes = $('classes');
CLASSES.forEach((c) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'cls'; b.dataset.id = c.id; b.setAttribute('role', 'radio');
  const ttl = document.createElement('div'); ttl.className = 'ttl';
  const t = document.createElement('b'); t.textContent = c.title;
  const wn = document.createElement('span'); wn.textContent = WEAPONS[c.id].name;
  ttl.append(t, wn);
  const p = document.createElement('p'); p.textContent = c.blurb;
  const stats = document.createElement('div'); stats.className = 'stats';
  c.stats.forEach((v, i) => {
    const l = document.createElement('span'); l.textContent = STAT_LABELS[i];
    const bar = document.createElement('i'); bar.style.setProperty('--v', v + '%');
    stats.append(l, bar);
  });
  b.append(ttl, p, stats);
  b.addEventListener('click', () => { pickClass(c.id); sound.unlock(); sound.play('ui'); });
  classes.append(b);
});
let paintPauseClasses = () => {};
function pickClass(id) {
  settings.cls = id; save();
  for (const b of classes.children) b.setAttribute('aria-checked', String(b.dataset.id === id));
  game.setPreview(settings.color, id);
  game.setClass(id);
  paintPauseClasses();
  if ($('sumcls')) summary();
}

segmented($('optMode'), modeOpts, () => settings.mode, (v) => { settings.mode = v; save(); summary(); });
segmented($('optMap'), mapOpts, () => settings.map, (v) => { settings.map = v; save(); summary(); });
segmented($('optDur'), durOpts, () => settings.dur, (v) => { settings.dur = v; save(); summary(); });

// lobby: tabs, the player chip, and the deployment summary
for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t === tab));
    for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('hidden', pane.dataset.pane !== tab.dataset.tab);
    sound.unlock(); sound.play('ui');
  });
}
function summary() {
  const cls = CLASSES.find((c) => c.id === settings.cls);
  $('sumcls').textContent = `${cls.title} · ${WEAPONS[cls.id].name}`;
  $('summode').textContent = invited ? 'Set by the room' : `${MODES[settings.mode].name} · ${settings.dur / 60} min`;
  $('summap').textContent = invited ? 'Set by the room' : MAPS[settings.map].name;
  $('deploysub').textContent = invited ? `Room ${cleanRoom(roomIn.value)}` : `${MODES[settings.mode].name} · ${MAPS[settings.map].name}`;
  $('whoname').textContent = nameIn.value.trim() || 'Unnamed pickle';
  $('whoroom').textContent = `Room ${cleanRoom(roomIn.value)}`;
  $('whodot').style.background = '#' + COLORS[settings.color].toString(16).padStart(6, '0');
}
nameIn.addEventListener('input', summary);
roomIn.addEventListener('input', summary);

async function play() {
  if (net) return;
  sound.unlock();
  settings.name = cleanName(nameIn.value); nameIn.value = settings.name; save();
  const code = cleanRoom(roomIn.value);
  status.textContent = ''; playBtn.disabled = true; setPlay('Connecting…');
  const fail = (msg) => {
    net?.close(); net = null;
    status.textContent = msg; playBtn.disabled = false; setPlay(invited ? `Join room ${code}` : 'Deploy');
  };
  const n = new Net();
  net = n;
  try { await n.connect(code); } catch (e) { fail(e.message); return; }
  n.on('full', () => fail('That jar is full (16 pickles). Try another code.'));
  n.on('welcome', (w) => {
    game.attach(n);
    game.enterRoom(w);
    $('home').classList.add('hidden');
    history.replaceState(null, '', `?r=${w.code}${game.noLock ? '&nolock' : ''}${muted ? '&mute' : ''}`);
    playBtn.disabled = false; setPlay(`Join room ${w.code}`);
    game.requestLock();
    setTimeout(() => { if (game.inRoom && !game.locked && !game.noLock) showPause(true); }, 250);
  });
  n.onclose = () => {
    if (net !== n) return;
    net = null;
    if (game.inRoom) { game.leaveRoom(); showPause(false); $('home').classList.remove('hidden'); }
    status.textContent = 'Connection lost. Jump back in when you are ready.';
    playBtn.disabled = false; setPlay('Deploy');
  };
  n.send({ t: 'join', name: settings.name, cls: settings.cls, color: settings.color, cfg: { mode: settings.mode, map: settings.map, dur: settings.dur } });
}
playBtn.addEventListener('click', play);
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
roomIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });

// ---- pause --------------------------------------------------------------------------------
const pause = $('pause');
const host = { mode: 'ffa', map: 0, dur: 300 };
let paintHost = [];
function showPause(on) {
  pause.classList.toggle('hidden', !on);
  if (!on) return;
  $('pausecode').textContent = game.code;
  refreshHost(true);
}
function refreshHost(reset) {
  const mine = game.inRoom && game.hostId === game.me.id;
  $('hostbox').classList.toggle('hidden', !mine);
  if (reset) { host.mode = game.mode; host.map = game.mapIdx; host.dur = game.dur; paintHost.forEach((p) => p()); }
}
paintHost = [
  segmented($('hostMode'), modeOpts, () => host.mode, (v) => { host.mode = v; }),
  segmented($('hostMap'), mapOpts, () => host.map, (v) => { host.map = v; }),
  segmented($('hostDur'), durOpts, () => host.dur, (v) => { host.dur = v; }),
];
paintPauseClasses = segmented($('pauseclasses'), CLASSES.map((c) => ({ v: c.id, label: c.title })), () => settings.cls, (v) => pickClass(v));
pickClass(settings.cls);

$('resume').addEventListener('click', () => { if (game.noLock) showPause(false); else game.requestLock(); });
$('pausecopy').addEventListener('click', (e) => copy(e.currentTarget, inviteLink(game.code)));
$('hostapply').addEventListener('click', () => {
  net?.send({ t: 'cfg', mode: host.mode, map: host.map, dur: host.dur });
  if (game.noLock) showPause(false); else game.requestLock();
});
$('leave').addEventListener('click', () => {
  const n = net; net = null;
  game.leaveRoom(); n?.close();
  showPause(false); $('home').classList.remove('hidden');
  status.textContent = '';
});

function slider(id, key, fmt, apply) {
  const input = $(id), out = $(id + 'v');
  input.value = settings[key]; out.textContent = fmt(settings[key]);
  input.addEventListener('input', () => { settings[key] = Number(input.value); out.textContent = fmt(settings[key]); apply?.(settings[key]); save(); });
}
slider('sens', 'sens', (v) => v.toFixed(2) + '×');
slider('vol', 'vol', (v) => Math.round(v * 100) + '%', (v) => sound.setVolume(muted ? 0 : v));
slider('fov', 'fov', (v) => v + '°');

game.onLock = (locked) => {
  if (!game.inRoom) return;
  if (locked) { sound.unlock(); showPause(false); } else if (!game.typing) showPause(true);
};
game.onRoster = () => { if (!pause.classList.contains('hidden')) refreshHost(false); };
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && game.inRoom && game.noLock) showPause(pause.classList.contains('hidden'));
});

if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) $('touchnote').classList.remove('hidden');
window.__tt = { game, hud, settings, get net() { return net; } };
