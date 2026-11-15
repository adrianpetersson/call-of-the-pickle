// DOM overlay. Every setter caches its last value so the frame loop can call it freely.
import { CLASSES, MAX_HP, MAX_GRENADES } from '../shared/config.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class Hud {
  constructor() {
    this.root = $('hud');
    this.c = {};        // cache
    this.toastTimer = 0;
    const pick = $('deathpick');
    CLASSES.forEach((c, i) => {
      const s = el('span');
      s.dataset.id = c.id;
      s.append(el('b', '', String(i + 1)), c.title);
      pick.append(s);
    });
    this.chatIn = $('chatin');
    this.chatIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const text = this.chatIn.value.trim(); this.closeChat(); this._chatSend?.(text); }
      else if (e.key === 'Escape') this.closeChat();
    });
    this.chatIn.addEventListener('keyup', (e) => e.stopPropagation());
    this.chatIn.addEventListener('blur', () => this.closeChat());
  }

  set(key, value, apply) { if (this.c[key] !== value) { this.c[key] = value; apply(value); } }

  setInGame(on) { this.root.classList.toggle('hidden', !on); if (!on) { $('feed').replaceChildren(); $('chatlog').replaceChildren(); } }
  setAlive(on) { this.set('alive', on, (v) => this.root.classList.toggle('dead', !v)); }

  setHealth(hp, shield) {
    this.set('hp', hp, (v) => {
      $('hpnum').textContent = v;
      $('hpbar').style.transform = `scaleX(${Math.max(0, v / MAX_HP)})`;
      $('vitals').classList.toggle('low', v <= 35);
      $('vignette').style.opacity = v <= 35 ? String(1 - v / 35) : '0';
    });
    this.set('shield', shield, (v) => $('vitals').classList.toggle('shield', v));
  }

  setAmmo(name, ammo, reserve, reload, slot) {
    this.set('wname', name, (v) => { $('wname').textContent = v; });
    this.set('ammo', ammo, (v) => { $('ammonum').textContent = v; $('ammonum').classList.toggle('dry', v === 0); });
    this.set('reserve', reserve, (v) => { $('ammores').textContent = '/ ' + (v === Infinity ? '∞' : v); });
    this.set('reload', reload < 0 ? -1 : Math.round(reload * 50), (v) => { $('reloadbar').style.transform = `scaleX(${v < 0 ? 0 : v / 50})`; });
    this.set('slot', slot, (v) => { $('slot1').classList.toggle('on', v === 0); $('slot2').classList.toggle('on', v === 1); });
  }

  setGrenades(n) {
    this.set('nades', n, (v) => {
      const pips = $('nades').querySelectorAll('i');
      for (let i = 0; i < MAX_GRENADES; i++) pips[i].classList.toggle('on', i < v);
    });
  }

  setCrosshair(gap, visible) {
    this.set('gap', Math.round(gap), (v) => $('crosshair').style.setProperty('--gap', v + 'px'));
    this.set('xvis', visible, (v) => { $('crosshair').style.visibility = v ? 'visible' : 'hidden'; });
  }
  setScope(on) { this.set('scope', !!on, (v) => $('scope').classList.toggle('on', v)); }

  setTimer(sec) {
    this.set('timer', sec, (v) => {
      $('timer').textContent = `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
      $('timer').classList.toggle('late', v > 0 && v <= 30);
    });
  }
  setPing(ms) { this.set('ping', ms, (v) => { $('ping').textContent = v + ' ms'; }); }

  setTop({ a, b }) {
    const key = `${a.label}|${a.value}|${a.css}|${a.mine}|${b.label}|${b.value}|${b.css}|${b.mine}`;
    this.set('top', key, () => {
      for (const [id, d] of [['topA', a], ['topB', b]]) {
        const chip = $(id);
        chip.style.setProperty('--c', d.css);
        chip.classList.toggle('mine', d.mine);
        chip.querySelector('.lbl').textContent = d.label;
        chip.querySelector('b').textContent = d.value;
      }
    });
  }

  hitmarker(head, kill) {
    const h = $('hitmarker');
    h.className = (head ? 'head ' : '') + (kill ? 'kill ' : '');
    void h.offsetWidth;
    h.classList.add('pop');
  }

  hurt(angle) {
    const f = $('hurtflash');
    f.classList.remove('pop'); void f.offsetWidth; f.classList.add('pop');
    if (angle == null) return;
    const arc = el('i');
    arc.style.transform = `rotate(${angle}rad)`;
    $('arcs').append(arc);
    setTimeout(() => arc.remove(), 1000);
  }

  damageNumber(x, y, amount, head) {
    const s = el('span', head ? 'head' : '', String(amount));
    s.style.left = x + (Math.random() - 0.5) * 30 + 'px'; s.style.top = y + 'px';
    $('numbers').append(s);
    setTimeout(() => s.remove(), 700);
  }

  _feed(node) {
    const feed = $('feed');
    feed.append(node);
    while (feed.children.length > 6) feed.firstChild.remove();
    setTimeout(() => node.classList.add('out'), 5200);
    setTimeout(() => node.remove(), 5800);
  }

  feedKill(killer, kcss, victim, vcss, weapon, head, mine) {
    const row = el('div', 'kf' + (mine ? ' me' : ''));
    if (killer) { const k = el('span', '', killer); k.style.color = kcss; row.append(k); }
    row.append(el('span', 'w' + (head ? ' head' : ''), killer ? weapon : 'own goal'));
    const v = el('span', '', victim); v.style.color = vcss; row.append(v);
    this._feed(row);
  }
  feedNote(text) { this._feed(el('div', 'kf note', text)); }

  toast(title, sub) {
    const t = $('toast');
    t.querySelector('.t1').textContent = title || '';
    t.querySelector('.t2').textContent = sub || '';
    t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('on'), 1900);
  }

  chat(name, color, text) {
    const row = el('div');
    const b = el('b', '', name); b.style.color = color;
    row.append(b, text);
    const log = $('chatlog');
    log.append(row);
    while (log.children.length > 7) log.firstChild.remove();
    setTimeout(() => row.classList.add('out'), 9000);
  }

  openChat(send, closed) {
    this._chatSend = send; this._chatClosed = closed;
    $('chat').classList.add('open');
    this.chatIn.value = '';
    this.chatIn.focus();
  }
  closeChat() {
    if (!$('chat').classList.contains('open')) return;
    $('chat').classList.remove('open');
    const closed = this._chatClosed; this._chatClosed = null;
    this.chatIn.blur();
    closed?.();
  }

  showDeath(d) {
    $('death').classList.toggle('hidden', !d);
    this.c.deathbar = -1;
    if (!d) return;
    const by = $('deathby');
    $('death').querySelector('.eyebrow').textContent = d.redeploy ? 'Redeploying' : 'Pickled';
    by.textContent = d.redeploy ? 'New loadout coming up' : d.killer ? `by ${d.killer}` : 'by your own jar';
    by.style.color = d.killer ? d.css : '';
    $('deathwith').textContent = d.redeploy ? 'This counts as a death' : d.killer ? `${d.weapon}${d.head ? ' · headshot' : ''}` : 'Stand further back next time';
    this.setDeathClass(d.cls);
  }
  setDeathClass(id) { for (const s of $('deathpick').children) s.classList.toggle('on', s.dataset.id === id); }
  setDeathCountdown(frac) { this.set('deathbar', Math.round(frac * 100), (v) => { $('deathbar').style.transform = `scaleX(${v / 100})`; }); }

  _rows(container, data) {
    container.replaceChildren();
    const head = el('div', 'rw head');
    head.append(el('span', '', '#'), el('span', '', 'Pickle'), el('span', '', 'Loadout'), el('span', 'n', 'Kills'), el('span', 'n', 'Lost'));
    const addRows = (rows) => rows.forEach((r, i) => {
      const row = el('div', 'rw' + (r.me ? ' me' : ''));
      const nm = el('span', 'nm', r.n); nm.style.color = r.css;
      if (r.host) nm.append(el('small', '', 'host'));
      row.append(el('span', 'rk', String(i + 1)), nm, el('span', 'cl', r.cls), el('span', 'n', String(r.k)), el('span', 'n dim', String(r.d)));
      container.append(row);
    });
    if (data.teams) {
      data.teams.forEach((t, tm) => {
        const th = el('div', 'teamhead');
        const name = el('span', '', t.name), score = el('span', '', String(t.score));
        name.style.color = score.style.color = t.css;
        th.append(name, score);
        container.append(th);
        if (tm === 0) container.append(head);
        addRows(data.rows.filter((r) => r.tm === tm));
      });
    } else { container.append(head); addRows(data.rows); }
  }

  showScoreboard(data) {
    $('board').classList.toggle('hidden', !data);
    if (!data) return;
    $('boardtitle').textContent = `${data.modeName} · ${data.mapName} · first to ${data.limit}`;
    $('boardcode').textContent = data.code;
    this._rows($('boardrows'), data);
  }

  showEnd(data) {
    $('end').classList.toggle('hidden', !data);
    this.c.endleft = -1;
    if (!data) return;
    const win = $('endwin');
    if (data.teams) {
      const [a, b] = data.teams;
      const w = a.score === b.score ? null : a.score > b.score ? a : b;
      win.textContent = w ? `${w.name} takes it` : 'Dead even';
      win.style.color = w ? w.css : '';
    } else {
      const top = data.rows[0];
      win.textContent = top && top.k > 0 ? (top.me ? 'You win the round' : `${top.n} wins the round`) : 'Nobody scored';
      win.style.color = top && top.k > 0 ? top.css : '';
    }
    this._rows($('endrows'), data);
    this._endNext = data.next;
    $('endnext').textContent = `Next arena: ${data.next}`;
    $('endnext').style.margin = '14px 0 0';
  }
  setEndCountdown(sec) { this.set('endleft', sec, (v) => { $('endnext').textContent = `Next arena: ${this._endNext} in ${v}s`; }); }
}
