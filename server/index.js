import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, findUserByEmail } from './store.js';
import { attachRealtime } from './realtime.js';

const port = Number(process.env.PORT || 4000);
const secret = process.env.JWT_SECRET;
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
if (!secret || secret.length < 32 || secret.includes('replace-with')) {
  console.error('Set JWT_SECRET to a random value with at least 32 characters in .env.');
  process.exit(1);
}
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY'); next(); });

const authLimiter = new Map();
app.use('/api/auth', (req, res, next) => {
  const now = Date.now();
  const key = req.ip;
  const bucket = authLimiter.get(key) || { start: now, count: 0 };
  if (now - bucket.start > 60_000) { bucket.start = now; bucket.count = 0; }
  bucket.count++;
  authLimiter.set(key, bucket);
  if (bucket.count > 30) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  next();
});

function issueToken(user) { const role = user.role || 'participant'; return jwt.sign({ sub: user.id, id: user.id, name: user.name, email: user.email, role }, secret, { expiresIn: '12h', issuer: 'principle' }); }
function publicUser(user) { return { id: user.id || user.sub, name: user.name, email: user.email, role: user.role || 'participant' }; }

app.post('/api/auth/register', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'participant');
    if (!['host', 'participant'].includes(role)) return res.status(400).json({ error: 'Choose Host or Participant.' });
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Enter a name, valid email, and password of at least 10 characters.' });
    const user = { id: crypto.randomUUID(), name, email, role, passwordHash: await bcrypt.hash(password, 12), createdAt: new Date().toISOString() };
    if (!await createUser(user)) return res.status(409).json({ error: 'An account with that email already exists.' });
    return res.status(201).json({ token: issueToken(user), user: publicUser(user) });
  } catch (error) { console.error('Registration failed:', error.message); return res.status(500).json({ error: 'Could not create your account.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'participant');
    const user = await findUserByEmail(email);
    if (!['host', 'participant'].includes(role) || !user || (user.role || 'participant') !== role || !await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'Email, password, or account type is incorrect.' });
    return res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (error) { console.error('Login failed:', error.message); return res.status(500).json({ error: 'Could not sign in.' }); }
});

app.get('/api/auth/me', (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = jwt.verify(token, secret, { issuer: 'principle' });
    return res.json({ user: publicUser(user) });
  } catch { return res.status(401).json({ error: 'Session expired.' }); }
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const turnUrls = (process.env.TURN_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (turnUrls.length) iceServers.push({ urls: turnUrls, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
attachRealtime(server, { secret, clientOrigin, iceServers });
server.listen(port, () => console.log(`Principle server listening on http://localhost:${port}`));
