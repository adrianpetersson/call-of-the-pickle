// Cloudflare host: static files come from ./public (see wrangler.toml), and each room code
// maps to one Durable Object that holds the sockets for that room. Fits the free plan.

import { Room } from '../public/shared/room.js';
import { cleanRoom } from '../public/shared/config.js';

export class GameRoom {
  constructor() {
    this.room = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    const code = cleanRoom(new URL(request.url).searchParams.get('room'));
    if (!this.room) this.room = new Room(code);
    const room = this.room;
    const [client, socket] = Object.values(new WebSocketPair());
    socket.accept();
    socket.addEventListener('message', (e) => {
      if (typeof e.data === 'string' && e.data.length < 16384) room.message(socket, e.data);
    });
    const bye = () => room.close(socket);
    socket.addEventListener('close', bye);
    socket.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const code = cleanRoom(url.searchParams.get('room'));
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
