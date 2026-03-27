#!/usr/bin/env bash
# Run on a fresh Ubuntu 22.04 LTS t2.micro (user data or SSH session).
# Installs Docker Engine and the Docker Compose plugin, prepares the app,
# creates backend/.env, and starts the stack.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/market-movers-yf}"
GIT_REPO_URL="${GIT_REPO_URL:-}"

sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "${USER}" || true

if [[ -n "${GIT_REPO_URL}" ]]; then
  git clone "${GIT_REPO_URL}" "${APP_DIR}"
else
  echo "Set GIT_REPO_URL to clone the app, or copy the project into: ${APP_DIR}"
  if [[ ! -d "${APP_DIR}/backend" ]] || [[ ! -d "${APP_DIR}/frontend" ]]; then
    exit 1
  fi
fi

cd "${APP_DIR}"

if [[ ! -f backend/.env ]]; then
  if [[ -f backend/.env.example ]]; then
    cp backend/.env.example backend/.env
  else
    cat > backend/.env << 'EOF'
FINNHUB_API_KEY=
GROQ_API_KEY=
ALLOWED_ORIGINS=http://localhost:3000
EOF
  fi
fi

echo ""
echo "Edit backend/.env: set FINNHUB_API_KEY, GROQ_API_KEY, and ALLOWED_ORIGINS (e.g. http://YOUR_PUBLIC_IP:3000)."
sudo docker compose up -d --build
echo ""
echo "Stack started. Open http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):3000"
