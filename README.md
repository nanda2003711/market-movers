# Market Movers

Market movers dashboard with a FastAPI backend and Vite + React frontend.

## Running locally (no Docker)

**Backend**

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install --legacy-peer-deps
npm run dev
```

Open **http://localhost:5173**

## Running locally (Docker)

From the repository root:

```bash
docker compose up --build
```

Open **http://localhost:3000**

## Deploying to AWS

See **[deploy/aws/README.md](deploy/aws/README.md)** for ECS Fargate, ECR, and EC2 (free tier) options.

## Data sources

| Service | What it provides | Key required |
|---------|------------------|--------------|
| Yahoo Finance | Market data, gainers/losers, sparklines | No |
| Finnhub | News headlines | Yes — free at [finnhub.io](https://finnhub.io) |
| Groq | AI analysis (Llama-3.3-70B) | Yes — free at [console.groq.com](https://console.groq.com) |
