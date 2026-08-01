# QuizForge

Upload any PDF. Learn it through AI-generated quizzes. Level up.

## Setup

```bash
cd server && npm install
cd ../client && npm install
```

## Run

Terminal 1:
```bash
cd server
node index.js
```

Terminal 2:
```bash
cd client
npx vite --host
```

Open http://localhost:5173

## AI Setup (optional but recommended)

Get a free API key from https://console.groq.com and set it permanently:

```bash
echo 'export GEMINI_API_KEY=gsk_your-key' >> ~/.zshrc
source ~/.zshrc
```

Or use Anthropic: `export ANTHROPIC_API_KEY=sk-ant-...`

Without a key, quizzes use basic mock questions.
