/**
 * Set or change the admin password.
 *
 * Usage:
 *   node scripts/set-admin-password.js "your-new-password"
 *
 * If you don't pass a password as an argument, you'll be prompted for one
 * (typed characters are not masked — run this somewhere private).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ADMIN_FILE = path.join(__dirname, '..', 'data', 'admin.json');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function save(password) {
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ salt, hash }, null, 2));
  console.log('Admin password updated. Existing admin sessions still remain valid');
  console.log('until they expire or the server restarts — log out elsewhere if needed.');
}

const argPassword = process.argv[2];

if (argPassword) {
  save(argPassword);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('New admin password (min 8 characters): ', (answer) => {
    rl.close();
    save(answer.trim());
  });
}
