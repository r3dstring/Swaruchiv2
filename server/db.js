import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'quizforge.db');
let db;

export async function initDb() {
  const SQL = await initSqlJs();
  db = existsSync(DB_PATH) ? new SQL.Database(readFileSync(DB_PATH)) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT DEFAULT 'user', xp INTEGER DEFAULT 0, level INTEGER DEFAULT 1, streak INTEGER DEFAULT 0, last_quiz_date TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS pdfs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, filename TEXT NOT NULL, text_content TEXT, chunks TEXT, indexed INTEGER DEFAULT 0, page_count INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS quizzes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pdf_id INTEGER, questions TEXT NOT NULL, topic TEXT, consequence_mode INTEGER DEFAULT 0, docs_referenced TEXT, score INTEGER DEFAULT 0, total INTEGER DEFAULT 0, xp_earned INTEGER DEFAULT 0, completed_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS topic_progress (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, topic TEXT NOT NULL, attempted INTEGER DEFAULT 0, correct INTEGER DEFAULT 0, incorrect INTEGER DEFAULT 0, last_practiced TEXT, revision_count INTEGER DEFAULT 0, UNIQUE(user_id, topic));
    CREATE TABLE IF NOT EXISTS question_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, topic TEXT NOT NULL, question_text TEXT NOT NULL, question_type TEXT NOT NULL, asked_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS flagged_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, topic TEXT, question_text TEXT NOT NULL, question_type TEXT, options TEXT, correct_answer TEXT, explanation TEXT, reason TEXT NOT NULL, comment TEXT, status TEXT DEFAULT 'open', flagged_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT, FOREIGN KEY (user_id) REFERENCES users(id));
  `);

  // Migrations for existing DBs
  const migrations = [
    ['pdfs',    'chunks',           'ALTER TABLE pdfs ADD COLUMN chunks TEXT'],
    ['pdfs',    'indexed',          'ALTER TABLE pdfs ADD COLUMN indexed INTEGER DEFAULT 0'],
    ['quizzes', 'topic',            'ALTER TABLE quizzes ADD COLUMN topic TEXT'],
    ['quizzes', 'consequence_mode', 'ALTER TABLE quizzes ADD COLUMN consequence_mode INTEGER DEFAULT 0'],
    ['quizzes', 'docs_referenced',  'ALTER TABLE quizzes ADD COLUMN docs_referenced TEXT'],
    ['users',   'role',             "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'"],
  ];
  for (const [table, col, sql] of migrations) {
    try { db.run(`SELECT ${col} FROM ${table} LIMIT 0`); } catch { db.run(sql); }
  }
  save();

  // Promote first user or ADMIN_EMAIL match to admin
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    try { db.run("UPDATE users SET role = 'admin' WHERE email = ?", [adminEmail.toLowerCase()]); save(); } catch {}
  } else {
    // First user ever becomes admin
    const first = get('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    if (first) { db.run("UPDATE users SET role = 'admin' WHERE id = ?", [first.id]); save(); }
  }

  // Seed demo users if empty
  const [{ values: [[count]] }] = db.exec('SELECT COUNT(*) FROM users');
  if (count === 0) {
    const bcrypt = await import('bcryptjs');
    const hash = bcrypt.default.hashSync('demo123', 10);
    const demoUsers = [['StudyOwl','owl@demo.com',hash,2450,8,12],['BrainWave','brain@demo.com',hash,1820,6,7],['QuizNinja','ninja@demo.com',hash,1540,5,3],['PageTurner','page@demo.com',hash,980,4,15],['DocWizard','wiz@demo.com',hash,760,3,5]];
    const stmt = db.prepare('INSERT INTO users (username, email, password_hash, xp, level, streak) VALUES (?, ?, ?, ?, ?, ?)');
    for (const u of demoUsers) { stmt.run(u); }
    stmt.free();
    // First demo user becomes admin
    // Demo users are not admin — first real signup gets admin
    save();
  }
  return db;
}

export function save() { if (db) writeFileSync(DB_PATH, Buffer.from(db.export())); }
export function all(sql, params = []) { const stmt = db.prepare(sql); stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; }
export function get(sql, params = []) { return all(sql, params)[0] || null; }
export function run(sql, params = []) { db.run(sql, params); const lastId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0]; save(); return { lastInsertRowid: lastId, changes: db.getRowsModified() }; }
