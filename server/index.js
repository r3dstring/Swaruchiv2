import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import authRoutes from './routes/auth.js';
import pdfRoutes from './routes/pdf.js';
import quizRoutes from './routes/quiz.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api/quiz', quizRoutes);

function detectProvider() {
  if (process.env.CEREBRAS_API_KEY) return 'Cerebras';
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.startsWith('gsk_') ? 'Groq' : 'Gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'Anthropic';
  return null;
}

app.get('/api/health', (_, res) => res.json({ status: 'ok', provider: detectProvider() }));

(async () => {
  await initDb();
  app.listen(PORT, () => {
    const provider = detectProvider();
    const adminEmail = process.env.ADMIN_EMAIL;
    console.log(`\n  QuizForge API running on http://localhost:${PORT}`);
    console.log(`  AI provider: ${provider || 'NONE (mock questions)'}`);
    console.log(`  Admin: ${adminEmail ? adminEmail : 'first signup becomes admin'}`);
    if (!provider) console.log(`  Set CEREBRAS_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY\n`);
    else console.log('');
  });
})();
