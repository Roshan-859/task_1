import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

const rooms = new Map();
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function attachRealtime(httpServer, { secret, clientOrigin, iceServers }) {
  const io = new Server(httpServer, {
    cors: { origin: clientOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: MAX_FILE_BYTES + 64_000,
    pingInterval: 25000,
    pingTimeout: 20000
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Sign in to join a room'));
      socket.user = jwt.verify(token, secret);
      next();
    } catch { next(new Error('Your session expired. Please sign in again.')); }
  });

  io.on('connection', socket => {
    socket.emit('rtc-config', iceServers);
    socket.on('room:join', ({ roomId }) => {
      const room = String(roomId || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,24}$/.test(room)) return socket.emit('room:error', 'Room code must be 4–24 letters or numbers.');
      const members = rooms.get(room) || new Map();
      if (members.size >= 8) return socket.emit('room:error', 'This room has reached its 8 person limit.');
      if (members.has(socket.id)) return;
      const peers = [...members.values()];
      members.set(socket.id, { id: socket.id, name: socket.user.name, joinedAt: Date.now() });
      rooms.set(room, members);
      socket.data.room = room;
      socket.join(room);
      socket.emit('room:peers', { roomId: room, selfId: socket.id, peers, participants: [...members.values()] });
      socket.to(room).emit('peer:joined', { id: socket.id, name: socket.user.name });
    });
    socket.on('rtc:signal', ({ to, signal }) => {
      if (socket.data.room && typeof to === 'string') io.to(to).emit('rtc:signal', { from: socket.id, signal });
    });
    socket.on('board:draw', data => {
      if (socket.data.room && validStroke(data)) socket.to(socket.data.room).emit('board:draw', data);
    });
    socket.on('board:clear', () => { if (socket.data.room) socket.to(socket.data.room).emit('board:clear'); });
    socket.on('chat:message', message => {
      if (!socket.data.room || typeof message?.text !== 'string') return;
      const text = message.text.trim().slice(0, 2000);
      if (text) io.to(socket.data.room).emit('chat:message', { id: crypto.randomUUID(), name: socket.user.name, text, sentAt: Date.now() });
    });
    socket.on('file:share', file => {
      if (!socket.data.room || !file || !Buffer.isBuffer(file.data) || file.data.length > MAX_FILE_BYTES) return;
      if (typeof file.name !== 'string' || typeof file.iv !== 'string' || typeof file.key !== 'string') return;
      io.to(socket.data.room).emit('file:shared', { id: crypto.randomUUID(), name: file.name.slice(0, 180), mime: String(file.mime || 'application/octet-stream').slice(0, 120), iv: file.iv, key: file.key, data: file.data, from: socket.user.name, sentAt: Date.now() });
    });
    socket.on('disconnect', () => {
      const room = socket.data.room;
      if (!room) return;
      const members = rooms.get(room);
      members?.delete(socket.id);
      socket.to(room).emit('peer:left', { id: socket.id, participants: [...(members?.values() || [])] });
      if (!members?.size) rooms.delete(room);
    });
  });
  return io;
}

function validStroke(s) {
  return s && typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) && Number.isFinite(s.width) && s.width >= 1 && s.width <= 32 && Array.isArray(s.points) && s.points.length <= 400 && s.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
}
