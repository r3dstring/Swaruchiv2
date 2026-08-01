import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { get, run, all } from '../db.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/signup', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password too short' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    // Check if this is the first user ever — they become admin
    const existingAdmin = get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const isFirst = !existingAdmin;
    const adminEmail = process.env.ADMIN_EMAIL;
    const isAdmin = isFirst || (adminEmail && email.trim().toLowerCase() === adminEmail.toLowerCase());
    const role = isAdmin ? 'admin' : 'user';

    const result = run('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [username.trim(), email.trim().toLowerCase(), hash, role]);
    const user = get('SELECT id, username, email, role, xp, level, streak FROM users WHERE id = ?', [result.lastInsertRowid]);
    res.json({ token: generateToken(user), user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already taken' });
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = get('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const { password_hash, ...safe } = user;
  res.json({ token: generateToken(safe), user: safe });
});

router.get('/me', authMiddleware, (req, res) => {
  const user = get('SELECT id, username, email, role, xp, level, streak, last_quiz_date, created_at FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

export default router;
