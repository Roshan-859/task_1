import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

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
      socket.user.role ||= 'participant';
      next();
    } catch { next(new Error('Your session expired. Please sign in again.')); }
  });

  function validRoomId(value) {
    const room = String(value || '').trim().toUpperCase();
    return /^[A-Z0-9-]{4,24}$/.test(room) ? room : '';
  }
  function memberFor(socket) {
    return { id: socket.id, userId: socket.user.id || socket.user.sub, name: socket.user.name, role: socket.user.role, audioOn: true, videoOn: true, audioLocked: false, videoLocked: false, joinedAt: Date.now() };
  }
  function publicMembers(entry) {
    return [...entry.members.values()].map(({ id, name, role, audioOn, videoOn }) => ({ id, name, role, audioOn, videoOn }));
  }
  function isHost(socket, entry) {
    return socket.user.role === 'host' && (socket.user.id || socket.user.sub) === entry?.hostUserId;
  }
  function joinRoom(socket, room, entry) {
    if (entry.members.has(socket.id)) return;
    if (entry.members.size >= 8) return socket.emit('room:error', 'This room has reached its 8 person limit.');
    const peers = [...entry.members.values()].map(({ id, name }) => ({ id, name }));
    const member = memberFor(socket);
    entry.members.set(socket.id, member);
    socket.data.room = room;
    socket.join(room);
    socket.emit('room:peers', { roomId: room, selfId: socket.id, peers, participants: publicMembers(entry), hostUserId: entry.hostUserId });
    socket.to(room).emit('peer:joined', { id: socket.id, name: member.name, role: member.role, audioOn: member.audioOn, videoOn: member.videoOn });
  }

  io.on('connection', socket => {
    socket.emit('rtc-config', iceServers);

    socket.on('room:create', ({ roomId } = {}) => {
      const room = validRoomId(roomId);
      if (!room) return socket.emit('room:error', 'Room code must be 4–24 letters or numbers.');
      if (socket.user.role !== 'host') return socket.emit('room:error', 'Only Host accounts can create a room.');
      if (rooms.has(room)) return socket.emit('room:error', 'That room code is already in use. Create another room.');
      const entry = { hostUserId: socket.user.id || socket.user.sub, members: new Map() };
      rooms.set(room, entry);
      joinRoom(socket, room, entry);
    });

    socket.on('room:join', ({ roomId } = {}) => {
      const room = validRoomId(roomId);
      if (!room) return socket.emit('room:error', 'Room code must be 4–24 letters or numbers.');
      const entry = rooms.get(room);
      if (!entry) return socket.emit('room:error', 'Room not found. Ask the host for an active invite link.');
      joinRoom(socket, room, entry);
    });

    socket.on('rtc:signal', ({ to, signal } = {}) => {
      const entry = rooms.get(socket.data.room);
      if (entry?.members.has(to) && typeof to === 'string') io.to(to).emit('rtc:signal', { from: socket.id, signal });
    });

    socket.on('participant:media', ({ audioOn, videoOn } = {}) => {
      const entry = rooms.get(socket.data.room);
      const member = entry?.members.get(socket.id);
      if (!member) return;
      if (member.audioLocked && typeof audioOn === 'boolean') socket.emit('moderation:media', { kind: 'audio', disabled: true });
      else if (typeof audioOn === 'boolean') member.audioOn = audioOn;
      if (member.videoLocked && typeof videoOn === 'boolean') socket.emit('moderation:media', { kind: 'video', disabled: true });
      else if (typeof videoOn === 'boolean') member.videoOn = videoOn;
      io.to(socket.data.room).emit('participant:media', { id: socket.id, audioOn: member.audioOn, videoOn: member.videoOn });
    });

    socket.on('moderation:media', ({ targetId, kind, disabled } = {}) => {
      const entry = rooms.get(socket.data.room);
      const member = entry?.members.get(targetId);
      if (!isHost(socket, entry) || !member || targetId === socket.id) return;
      if (!['audio', 'video'].includes(kind) || typeof disabled !== 'boolean') return;
      if (kind === 'audio') { member.audioLocked = disabled; member.audioOn = !disabled; }
      if (kind === 'video') { member.videoLocked = disabled; member.videoOn = !disabled; }
      io.to(targetId).emit('moderation:media', { kind, disabled });
      io.to(socket.data.room).emit('participant:media', { id: targetId, audioOn: member.audioOn, videoOn: member.videoOn });
    });

    socket.on('moderation:kick', ({ targetId } = {}) => {
      const entry = rooms.get(socket.data.room);
      if (!isHost(socket, entry) || !entry.members.has(targetId) || targetId === socket.id) return;
      const target = io.sockets.sockets.get(targetId);
      if (!target || target.user.id === entry.hostUserId || target.user.sub === entry.hostUserId) return;
      target.emit('moderation:kicked');
      target.disconnect(true);
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
      const entry = rooms.get(room);
      entry?.members.delete(socket.id);
      socket.to(room).emit('peer:left', { id: socket.id, participants: publicMembers(entry || { members: new Map() }) });
      if (!entry?.members.size) rooms.delete(room);
    });
  });
  return io;
}

function validStroke(s) {
  return s && typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) && Number.isFinite(s.width) && s.width >= 1 && s.width <= 32 && Array.isArray(s.points) && s.points.length <= 400 && s.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
}
