import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const dbPath = path.join(dataDir, 'users.json');
let queue = Promise.resolve();

async function readUsers() {
  await fs.mkdir(dataDir, { recursive: true });
  try { return JSON.parse(await fs.readFile(dbPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function findUserByEmail(email) {
  return readUsers().then(users => users.find(user => user.email === email.toLowerCase()) || null);
}

export function createUser(user) {
  const operation = queue.then(async () => {
    const users = await readUsers();
    if (users.some(item => item.email === user.email)) return false;
    users.push(user);
    await fs.writeFile(dbPath, JSON.stringify(users, null, 2), { mode: 0o600 });
    return true;
  });
  queue = operation.catch(() => {});
  return operation;
}
