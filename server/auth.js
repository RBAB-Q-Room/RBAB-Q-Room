'use strict';
const crypto = require('node:crypto');
const config = require('./config');

const ROLES = { reception: 'reception', rooms_controller: 'rooms_controller' };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createUser(db, { username, displayName, role, password }) {
  if (!ROLES[role]) throw new Error('bad role');
  const { salt, hash } = hashPassword(password);
  db.prepare(
    'INSERT INTO users (username, display_name, role, password_salt, password_hash) VALUES (?,?,?,?,?)'
  ).run(username, displayName, role, salt, hash);
}

// Dummy hash so unknown usernames cost the same as wrong passwords.
const DUMMY = hashPassword('x');

function login(db, username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || ''));
  const ok = verifyPassword(String(password || ''), u ? u.password_salt : DUMMY.salt, u ? u.password_hash : DUMMY.hash);
  if (!u || !ok) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), u.id, expires);
  return { token, user: publicUser(u) };
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.display_name, role: u.role });

function userFromToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND u.active = 1`
    )
    .get(sha(token));
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    logout(db, token);
    return null;
  }
  return publicUser(row);
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const COOKIE = 'wg_session';
function sessionCookie(token, clear = false) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (config.secureCookies) attrs.push('Secure');
  attrs.push(clear ? 'Max-Age=0' : `Max-Age=${config.sessionHours * 3600}`);
  return `${COOKIE}=${clear ? '' : token}; ${attrs.join('; ')}`;
}

/** Tiny in-memory fixed-window rate limiter (per key). */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    h.n += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return h.n <= max;
  };
}

module.exports = { createUser, login, logout, userFromToken, parseCookies, sessionCookie, COOKIE, rateLimiter };
