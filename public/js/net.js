// Thin WebSocket wrapper: JSON in, JSON out, handlers by message type.
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.ping = 0;
    this.onclose = null;
    this._pingTimer = null;
  }

  on(type, fn) { this.handlers.set(type, fn); }

  connect(room) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
      let opened = false;
      ws.onopen = () => {
        opened = true; this.ws = ws;
        this._pingTimer = setInterval(() => this.send({ t: 'pi', c: Math.round(performance.now()) }), 2000);
        resolve();
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'po') { this.ping = Math.max(0, Math.round(performance.now() - m.c)); return; }
        const h = this.handlers.get(m.t);
        if (h) h(m);
      };
      ws.onerror = () => { if (!opened) reject(new Error('Could not reach the game server')); };
      ws.onclose = () => {
        clearInterval(this._pingTimer);
        const was = this.ws === ws;
        if (was) this.ws = null;
        if (!opened) reject(new Error('Could not reach the game server'));
        else if (was && this.onclose) this.onclose();
      };
    });
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  close() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this._pingTimer);
    if (ws) ws.close();
  }
}
