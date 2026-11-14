// Node host: serves the client and runs the rooms. Use it for local play, a LAN, or any
// Node-capable host (Render, Railway, a home server...). `npm start`, then open the URL.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Room } from '../public/shared/room.js';
import { cleanRoom } from '../public/shared/config.js';

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const vendor = rel.startsWith('/vendor/') || rel.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': vendor ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

const rooms = new Map();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws, req) => {
  const code = cleanRoom(new URL(req.url, 'http://x').searchParams.get('room'));
  let room = rooms.get(code);
  if (!room) { room = new Room(code); rooms.set(code, room); }
  ws.on('message', (data) => room.message(ws, data.toString()));
  const bye = () => {
    room.close(ws);
    if (room.size === 0 && rooms.get(code) === room) rooms.delete(code);
  };
  ws.on('close', bye);
  ws.on('error', bye);
});

server.listen(PORT, () => {
  console.log(`Call of the Pickle running at http://localhost:${PORT}`);
});
