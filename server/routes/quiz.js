import { Router } from 'express';
import { all, get, run } from '../db.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import { retrieveForTopic } from '../retrieval.js';

const router = Router();
const XP_PER_CORRECT = 10;
const XP_BONUS_PERFECT = 25;
const HISTORY_EXCLUSION_LIMIT = 20; // questions to exclude per generation
const HISTORY_CAP = 50;             // max history kept per user per topic

function calcLevel(xp) {
  let level = 1, threshold = 100, remaining = xp;
  while (remaining >= threshold) { remaining -= threshold; level++; threshold += 50 * level; }
  return level;
}

function updateStreak(userId) {
  const user = get('SELECT last_quiz_date, streak FROM users WHERE id = ?', [userId]);
  const today = new Date().toISOString().slice(0, 10);
  if (!user || user.last_quiz_date === today) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak = user.last_quiz_date === yesterday ? user.streak + 1 : 1;
  run('UPDATE users SET streak = ?, last_quiz_date = ? WHERE id = ?', [newStreak, today, userId]);
}

// ── Question history helpers ─────────────────────────────────
function normalizeQ(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getRecentQuestions(userId, topic) {
  return all(
    'SELECT question_text FROM question_history WHERE user_id = ? AND topic = ? ORDER BY asked_at DESC LIMIT ?',
    [userId, topic || '', HISTORY_EXCLUSION_LIMIT]
  ).map(r => r.question_text);
}

function logQuestionsToHistory(userId, topic, questions) {
  if (!questions?.length) return;
  // Enforce cap: delete oldest beyond HISTORY_CAP
  const existing = all(
    'SELECT id FROM question_history WHERE user_id = ? AND topic = ? ORDER BY asked_at DESC',
    [userId, topic || '']
  );
  if (existing.length >= HISTORY_CAP) {
    const toDelete = existing.slice(HISTORY_CAP - questions.length);
    for (const r of toDelete) run('DELETE FROM question_history WHERE id = ?', [r.id]);
  }
  for (const q of questions) {
    run('INSERT INTO question_history (user_id, topic, question_text, question_type) VALUES (?, ?, ?, ?)',
      [userId, topic || '', normalizeQ(q.question), q.type]);
  }
}

// Simple word-overlap similarity (Jaccard on tokens)
function similarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  if (!setA.size || !setB.size) return 0;
  const intersection = [...setA].filter(w => setB.has(w)).length;
  return intersection / (setA.size + setB.size - intersection);
}

function deduplicateAgainstHistory(questions, history) {
  return questions.filter(q => {
    const norm = normalizeQ(q.question);
    return !history.some(h => similarity(norm, h) > 0.75);
  });
}

// ── AI Provider ──────────────────────────────────────────────
function getAIProvider() {
  if (process.env.CEREBRAS_API_KEY) return { name: 'Cerebras', key: process.env.CEREBRAS_API_KEY, type: 'cerebras' };
  if (process.env.GEMINI_API_KEY) {
    const k = process.env.GEMINI_API_KEY;
    return k.startsWith('gsk_') ? { name: 'Groq', key: k, type: 'groq' } : { name: 'Gemini', key: k, type: 'gemini' };
  }
  if (process.env.ANTHROPIC_API_KEY) return { name: 'Anthropic', key: process.env.ANTHROPIC_API_KEY, type: 'anthropic' };
  return null;
}

async function callLLM(prompt, provider) {
  if (provider.type === 'cerebras') {
    const r = await fetch('https://api.cerebras.ai/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${provider.key}`}, body: JSON.stringify({ model:'llama-3.3-70b', messages:[{role:'user',content:prompt}], temperature:0.7, max_tokens:3500 }) });
    if (!r.ok) { console.error('Cerebras error:', r.status, await r.text()); return null; }
    return (await r.json()).choices?.[0]?.message?.content || '';
  }
  if (provider.type === 'groq') {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${provider.key}`}, body: JSON.stringify({ model:'llama-3.3-70b-versatile', messages:[{role:'user',content:prompt}], temperature:0.7, max_tokens:3500 }) });
    if (!r.ok) { console.error('Groq error:', r.status, await r.text()); return null; }
    return (await r.json()).choices?.[0]?.message?.content || '';
  }
  if (provider.type === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${provider.key}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.7,maxOutputTokens:3500} }) });
    if (!r.ok) { console.error('Gemini error:', r.status, await r.text()); return null; }
    return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  if (provider.type === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'Content-Type':'application/json','x-api-key':provider.key,'anthropic-version':'2023-06-01'}, body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:3500, messages:[{role:'user',content:prompt}] }) });
    if (!r.ok) { console.error('Anthropic error:', r.status); return null; }
    return (await r.json()).content?.[0]?.text || '';
  }
  return null;
}

// ── Adaptive directive ────────────────────────────────────────
function getAdaptiveDirective(userId, topic) {
  if (!topic) return '';
  const prog = get('SELECT * FROM topic_progress WHERE user_id = ? AND topic = ?', [userId, topic]);
  if (!prog || prog.attempted < 3) return '';
  const accuracy = Math.round((prog.correct / prog.attempted) * 100);
  if (accuracy < 50) return `\nLEARNER PROFILE: ${accuracy}% accuracy on "${topic}" (${prog.attempted} attempts). WEAK AREA. Emphasize fundamentals and core definitions. Build confidence with clear foundational questions.\n`;
  if (accuracy < 80) return `\nLEARNER PROFILE: ${accuracy}% accuracy on "${topic}" (${prog.attempted} attempts). DEVELOPING. Mix reinforcement with questions targeting the gap between recall and understanding.\n`;
  return `\nLEARNER PROFILE: ${accuracy}% accuracy on "${topic}" — MASTERED. Avoid basics. Focus on advanced aspects, edge cases, and cross-system interactions.\n`;
}

const DIFFICULTY_GUIDE = {
  easy: 'Straightforward recall. Basic facts, definitions, simple concepts stated in the text.',
  medium: 'Mix of recall and understanding. Include relationships, causes, and implications.',
  hard: 'Deep analysis, comparison, inference, application. "Why" and "how" questions requiring combined ideas.'
};
const CONSEQUENCE_DIFFICULTY = {
  easy: 'Simple operational situations with one clear safe response.',
  medium: 'Multiple process variables, the operator must prioritize actions.',
  hard: 'Complex cascading situations requiring analytical thinking, competing priorities, root cause identification.'
};

function buildPrompt({ context, count, difficulty, topic, topicParent, consequenceMode, adaptive, previousQuestions }) {
  const mcqCount = Math.ceil(count * 0.5);
  const tfCount = Math.ceil(count * 0.25);
  const fitbCount = count - mcqCount - tfCount;

  const topicBlock = topic ? `
TOPIC FOCUS: ${topicParent ? topicParent + ' > ' : ''}${topic}
Generate questions STRICTLY about "${topic}" in refinery/petrochemical operations.
Use retrieved material if it covers this topic directly; supplement with industry-standard knowledge if coverage is partial.
Every question must pass: "Is this about ${topic}?"
` : '';

  const exclusionBlock = previousQuestions.length > 0 ? `
PREVIOUSLY ASKED — DO NOT repeat these or create near-duplicates:
${previousQuestions.map((q, i) => `${i + 1}. "${q}"`).join('\n')}

Generate completely different questions covering different aspects, facts, or angles of the topic.
` : '';

  if (consequenceMode) {
    return `You are a senior refinery operations trainer creating SCENARIO-BASED assessment.
Every question MUST present a realistic operational SITUATION requiring a decision — NO definition or recall questions.
${topicBlock}${adaptive}${exclusionBlock}
SCENARIOS must describe: plant situations, upsets, alarms, developing deviations, pre-task decisions.
Focus: decision making, safety, troubleshooting, root cause, consequence awareness.
Wrong options = actions a real operator might plausibly (but incorrectly) take.

DIFFICULTY: ${(difficulty||'medium').toUpperCase()} — ${CONSEQUENCE_DIFFICULTY[difficulty]||CONSEQUENCE_DIFFICULTY.medium}

GENERATE EXACTLY ${count} scenario questions:
- ${mcqCount} scenario MCQ (type:"mcq") — 4 action options, correct answer letter a/b/c/d
- ${tfCount} scenario T/F (type:"tf") — about what WOULD happen or whether an action is correct
- ${fitbCount} scenario fill-in-the-blank (type:"fitb") — missing word is key action/cause/consequence

Every question MUST include "explanation" (2-3 sentences: why correct answer is right, why tempting wrong choices fail).

Return ONLY valid JSON array, no markdown:
[{"type":"mcq","question":"...","options":["...","...","...","..."],"answer":"a","explanation":"..."},{"type":"tf","question":"...","options":["True","False"],"answer":"true","explanation":"..."},{"type":"fitb","question":"... _____ ...","options":null,"answer":"...","explanation":"..."}]

RETRIEVED PLANT DOCUMENTATION:
${context}`;
  }

  return `You are an expert quiz designer for refinery and petrochemical training.
${topicBlock}${adaptive}${exclusionBlock}
RULES: Questions must be answerable from the material or standard industry knowledge. Test actual understanding. Wrong MCQ options must be plausible. T/F should test meaningful claims. Fill-in answers: 1-3 specific key terms. No duplicates. Cover different aspects.

DIFFICULTY: ${(difficulty||'medium').toUpperCase()} — ${DIFFICULTY_GUIDE[difficulty]||DIFFICULTY_GUIDE.medium}

GENERATE EXACTLY ${count} questions:
- ${mcqCount} MCQ (type:"mcq") — 4 options, correct letter a/b/c/d
- ${tfCount} T/F (type:"tf") — answer "true" or "false"
- ${fitbCount} fill-in-the-blank (type:"fitb") — _____ in question, short answer

Every question MUST include "explanation" (1-2 sentences explaining the correct answer).

Return ONLY valid JSON array, no markdown:
[{"type":"mcq","question":"...","options":["...","...","...","..."],"answer":"a","explanation":"..."},{"type":"tf","question":"...","options":["True","False"],"answer":"true","explanation":"..."},{"type":"fitb","question":"... _____ ...","options":null,"answer":"...","explanation":"..."}]

RETRIEVED STUDY MATERIAL:
${context}`;
}

async function generateQuestions(userId, { count, difficulty, topic, topicParent, consequenceMode }) {
  const provider = getAIProvider();
  const { context, docsReferenced } = retrieveForTopic(topic || '', { rotate: true });
  if (!context) return { questions: null, docsReferenced: [] };
  if (!provider) return { questions: null, docsReferenced };

  const adaptive = getAdaptiveDirective(userId, topic);
  const previousQuestions = getRecentQuestions(userId, topic);
  const prompt = buildPrompt({ context, count, difficulty, topic, topicParent, consequenceMode, adaptive, previousQuestions });

  try {
    const responseText = await callLLM(prompt, provider);
    if (!responseText) return { questions: null, docsReferenced };
    const match = responseText.match(/\[[\s\S]*\]/);
    if (!match) { console.error('No JSON array in response'); return { questions: null, docsReferenced }; }
    let questions = JSON.parse(match[0]);
    if (!Array.isArray(questions)) return { questions: null, docsReferenced };

    // Validate structure
    questions = questions.filter(q =>
      q.type && q.question && q.answer &&
      (q.type === 'fitb' || (Array.isArray(q.options) && q.options.length >= 2))
    );

    // Post-generation dedup safety net against history
    const deduped = deduplicateAgainstHistory(questions, previousQuestions);
    const final = deduped.slice(0, count);

    console.log(`[${provider.name}] ${final.length}/${count} questions | topic: ${topic||'general'} | excluded: ${previousQuestions.length} prev | docs: ${docsReferenced.length}`);
    return { questions: final.length > 0 ? final : null, docsReferenced };
  } catch (e) {
    console.error('Generation failed:', e.message);
    return { questions: null, docsReferenced };
  }
}

function generateMockQuestions(topic) {
  const t = topic || 'refinery operations';
  return [
    { type:'mcq', question:`Which of the following best describes ${t}?`, options:['Core operational concept','Unrelated topic','Historical detail','Marketing term'], answer:'a', explanation:'Mock — configure an AI key for real questions.' },
    { type:'mcq', question:`In ${t}, what should the operator prioritize?`, options:['Safety and stable operation','Speed above all','Skipping checks','Ignoring alarms'], answer:'a', explanation:'Safety and stability are always the priority.' },
    { type:'tf', question:`${t} is a relevant area of refinery training.`, options:['True','False'], answer:'true', explanation:'It is part of the refinery knowledge tree.' },
    { type:'fitb', question:`The knowledge area being tested is _____.`, answer: t.toLowerCase(), explanation:'This is the selected topic.' },
  ];
}

function updateTopicProgress(userId, topic, correct, incorrect) {
  if (!topic) return;
  const existing = get('SELECT * FROM topic_progress WHERE user_id = ? AND topic = ?', [userId, topic]);
  const now = new Date().toISOString();
  if (existing) {
    run('UPDATE topic_progress SET attempted=attempted+?, correct=correct+?, incorrect=incorrect+?, last_practiced=?, revision_count=revision_count+1 WHERE user_id=? AND topic=?',
      [correct+incorrect, correct, incorrect, now, userId, topic]);
  } else {
    run('INSERT INTO topic_progress (user_id, topic, attempted, correct, incorrect, last_practiced, revision_count) VALUES (?,?,?,?,?,?,1)',
      [userId, topic, correct+incorrect, correct, incorrect, now]);
  }
}

// ── Routes ───────────────────────────────────────────────────

router.post('/generate', authMiddleware, async (req, res) => {
  const { count=10, difficulty='medium', topic=null, topicParent=null, consequenceMode=false } = req.body;
  const qCount = Math.min(Math.max(parseInt(count)||10, 5), 20);
  const diff = ['easy','medium','hard'].includes(difficulty) ? difficulty : 'medium';

  const docCount = get('SELECT COUNT(*) as c FROM pdfs')?.c || 0;
  if (docCount === 0) return res.status(400).json({ error: 'No documents in the knowledge base yet. Ask your admin to upload training material.' });

  const { questions: aiQ, docsReferenced } = await generateQuestions(req.user.id, { count: qCount, difficulty: diff, topic, topicParent, consequenceMode: !!consequenceMode });
  const questions = aiQ || generateMockQuestions(topic);

  // Log to history immediately (at generation time, not submit — so abandoned quizzes still count)
  if (aiQ) logQuestionsToHistory(req.user.id, topic, questions);

  res.json({ questions, topic, consequenceMode: !!consequenceMode, docsReferenced });
});

router.post('/submit', authMiddleware, (req, res) => {
  const { questions, answers, topic, consequenceMode=false, docsReferenced=[] } = req.body;
  if (!questions || !answers) return res.status(400).json({ error: 'Missing data' });

  let score = 0;
  const total = questions.length;
  const results = questions.map((q, i) => {
    const userAnswer = (answers[i]||'').toString().toLowerCase().trim();
    const correct = (q.answer||'').toString().toLowerCase().trim();
    const isCorrect = userAnswer === correct;
    if (isCorrect) score++;
    return { ...q, userAnswer: answers[i], isCorrect };
  });

  let xpEarned = score * XP_PER_CORRECT;
  if (score === total) xpEarned += XP_BONUS_PERFECT;

  const primaryDoc = docsReferenced?.[0]?.id || null;
  run('INSERT INTO quizzes (user_id, pdf_id, questions, topic, consequence_mode, docs_referenced, score, total, xp_earned) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.user.id, primaryDoc, JSON.stringify(results), topic||null, consequenceMode?1:0, JSON.stringify(docsReferenced||[]), score, total, xpEarned]);

  const user = get('SELECT xp FROM users WHERE id=?', [req.user.id]);
  const newXp = (user?.xp||0) + xpEarned;
  run('UPDATE users SET xp=?, level=? WHERE id=?', [newXp, calcLevel(newXp), req.user.id]);
  updateStreak(req.user.id);
  updateTopicProgress(req.user.id, topic, score, total-score);

  const updatedUser = get('SELECT id, username, xp, level, streak FROM users WHERE id=?', [req.user.id]);
  res.json({ score, total, xpEarned, perfectBonus: score===total, results, user: updatedUser, topic: topic||null, consequenceMode: !!consequenceMode, docsReferenced });
});

// ── Flag a question ──────────────────────────────────────────
router.post('/flag', authMiddleware, (req, res) => {
  const { topic, question_text, question_type, options, correct_answer, explanation, reason, comment } = req.body;
  if (!question_text || !reason) return res.status(400).json({ error: 'question_text and reason required' });
  run('INSERT INTO flagged_questions (user_id, topic, question_text, question_type, options, correct_answer, explanation, reason, comment) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.user.id, topic||null, question_text, question_type||null, options ? JSON.stringify(options) : null, correct_answer||null, explanation||null, reason, comment||null]);
  res.json({ ok: true });
});

// ── Admin: get flagged questions ─────────────────────────────
router.get('/admin/flags', authMiddleware, requireAdmin, (req, res) => {
  const { status = 'open' } = req.query;
  const flags = all(`
    SELECT f.*, u.username as flagged_by
    FROM flagged_questions f JOIN users u ON f.user_id = u.id
    WHERE f.status = ?
    ORDER BY f.flagged_at DESC
  `, [status]);

  // Most-flagged topic summary
  const topicSummary = all(`
    SELECT topic, COUNT(*) as count
    FROM flagged_questions WHERE status = 'open' AND topic IS NOT NULL
    GROUP BY topic ORDER BY count DESC LIMIT 5
  `);

  const openCount = get('SELECT COUNT(*) as c FROM flagged_questions WHERE status = "open"')?.c || 0;

  res.json({ flags, topicSummary, openCount });
});

// ── Admin: update flag status ────────────────────────────────
router.patch('/admin/flags/:id', authMiddleware, requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['reviewed','dismissed'].includes(status)) return res.status(400).json({ error: 'status must be reviewed or dismissed' });
  run('UPDATE flagged_questions SET status=?, reviewed_at=? WHERE id=?',
    [status, new Date().toISOString(), req.params.id]);
  res.json({ ok: true });
});

// ── Progress / recommendations / history / leaderboard ───────
router.get('/history', authMiddleware, (req, res) => {
  res.json(all(`
    SELECT q.id, q.score, q.total, q.xp_earned, q.completed_at, q.topic, q.consequence_mode, q.docs_referenced, p.filename as pdf_name
    FROM quizzes q LEFT JOIN pdfs p ON q.pdf_id = p.id
    WHERE q.user_id = ? ORDER BY q.completed_at DESC LIMIT 20
  `, [req.user.id]));
});

router.get('/progress', authMiddleware, (req, res) => {
  const progress = all('SELECT * FROM topic_progress WHERE user_id = ?', [req.user.id]);
  const quizzes = all('SELECT topic, score, total, completed_at FROM quizzes WHERE user_id=? AND topic IS NOT NULL ORDER BY completed_at ASC', [req.user.id]);
  const byTopic = {};
  for (const q of quizzes) {
    if (!byTopic[q.topic]) byTopic[q.topic] = [];
    byTopic[q.topic].push(q.score / q.total);
  }
  const enriched = progress.map(p => {
    const accuracy = p.attempted > 0 ? Math.round((p.correct/p.attempted)*100) : 0;
    const mastery = accuracy >= 80 ? 'mastered' : accuracy >= 50 ? 'revision' : 'weak';
    let trend = 'stable';
    const series = byTopic[p.topic] || [];
    if (series.length >= 2) {
      const half = Math.floor(series.length/2);
      const early = series.slice(0,half).reduce((a,b)=>a+b,0)/half;
      const late = series.slice(half).reduce((a,b)=>a+b,0)/(series.length-half);
      if (late-early > 0.1) trend = 'improving';
      else if (early-late > 0.1) trend = 'declining';
    }
    return { ...p, accuracy, mastery, trend };
  });
  res.json(enriched);
});

router.get('/recommendations', authMiddleware, (req, res) => {
  const progress = all('SELECT * FROM topic_progress WHERE user_id=? AND attempted >= 3', [req.user.id]);
  const withAcc = progress.map(p => ({ ...p, accuracy: Math.round((p.correct/p.attempted)*100) }));
  const weakest = [...withAcc].sort((a,b)=>a.accuracy-b.accuracy).slice(0,5);
  const mastered = withAcc.filter(p=>p.accuracy>=80).sort((a,b)=>b.accuracy-a.accuracy);
  let recommendation = null;
  if (weakest.length > 0 && weakest[0].accuracy < 80) {
    recommendation = { topic: weakest[0].topic, reason: weakest[0].accuracy < 50 ? 'This is your weakest area and needs focused revision.' : 'You are close to mastering this — one more session should do it.', accuracy: weakest[0].accuracy, estimatedMinutes: weakest[0].accuracy < 50 ? 10 : 7 };
  }
  const recent = all('SELECT score, total, completed_at, topic FROM quizzes WHERE user_id=? ORDER BY completed_at DESC LIMIT 15', [req.user.id]).reverse();
  const growth = recent.map(q => ({ date: q.completed_at, accuracy: Math.round((q.score/q.total)*100), topic: q.topic }));
  res.json({ weakest, mastered: mastered.slice(0,3), recommendation, growth });
});

router.get('/leaderboard', (req, res) => {
  res.json(all('SELECT id, username, xp, level, streak FROM users ORDER BY xp DESC LIMIT 10'));
});

export default router;
