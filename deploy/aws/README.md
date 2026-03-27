# Deploying Market Movers on AWS

This guide covers local Docker, Amazon ECS on Fargate (with an Application Load Balancer), and a single EC2 **t2.micro** instance (free tier eligible for new accounts).

---

## Local Docker

From the repository root (the folder that contains `backend/` and `frontend/`):

```bash
docker compose up --build
```

Open the app at **http://localhost:3000** (nginx on port 3000 proxies `/api` to the backend).

**Note:** The backend health check uses `curl`. The image in `backend/Dockerfile` is `python:3.12-slim`, which does not include `curl` by default. If the health check stays unhealthy, install `curl` in the backend image or change the health check to a tool that exists in the image (without changing application code, the simplest operational fix is adding `curl` via the Dockerfile when you are ready to adjust infrastructure only).

---

## AWS ECS Fargate (roughly ~$26/month and up)

Fargate charges for vCPU and memory per second, plus an Application Load Balancer (hourly + LCU), data transfer, and optional NAT Gateway. Costs vary by region and traffic; treat estimates as **order-of-magnitude** only.

### Prerequisites

- AWS CLI v2 configured (`aws configure`).
- Docker installed locally (for building images).
- Two **ECR** repositories (e.g. `market-movers-backend`, `market-movers-frontend`). Create them if they do not exist:

  ```bash
  aws ecr create-repository --repository-name market-movers-backend --region YOUR_REGION
  aws ecr create-repository --repository-name market-movers-frontend --region YOUR_REGION
  ```

- **Secrets Manager** secrets for `FINNHUB_API_KEY` and `GROQ_API_KEY` (string secrets are fine). Note each secret’s **full ARN** (including the random suffix AWS appends). Put those ARNs in `task-definition.json` under `containerDefinitions[0].secrets[].valueFrom`.
- IAM **ECS task execution role** (`ecsTaskExecutionRole`) with:
  - `AmazonECSTaskExecutionRolePolicy`
  - Permission to read your secrets, e.g. `secretsmanager:GetSecretValue` on those ARNs (and `kms:Decrypt` if the secrets use a customer KMS key).
- IAM **task role** (`ecsTaskRole`) if your application code calls AWS APIs at runtime (optional for this app if all keys are injected as env vars).

### One-time setup

1. **CloudWatch log group** (optional): create `/ecs/market-movers`, or rely on `awslogs-create-group` in the task definition (and ensure the execution role can create log groups, or pre-create the group).
2. **VPC**: use the default VPC or your own with **public subnets** for the ALB and Fargate tasks (simplest path: tasks in public subnets with public IPs, or private subnets + NAT for outbound internet).
3. **Security groups**:
   - ALB: allow inbound **80** (and **443** if you terminate TLS on the ALB).
   - Tasks: allow ALB security group to reach **TCP 80** (frontend) and **TCP 8000** (backend).

### Push images

1. Edit `deploy/aws/push-to-ecr.sh`: set `AWS_REGION`, `AWS_ACCOUNT_ID`, and repository names if needed.
2. Run from the **repository root**:

   ```bash
   chmod +x deploy/aws/push-to-ecr.sh
   ./deploy/aws/push-to-ecr.sh
   ```

3. Copy the printed **image URIs** (you will plug them into the task definition if you replace placeholders manually).

### Register the task definition

1. Copy `deploy/aws/task-definition.json` and replace every `REPLACE_WITH_*` placeholder:
   - **Account ID** and **Region**
   - **ECR image URIs** for `backend` and `frontend`
   - **executionRoleArn** and **taskRoleArn**
   - **Secret ARNs** for `FINNHUB_API_KEY` and `GROQ_API_KEY`
   - **ALLOWED_ORIGINS**: your public app URL, e.g. `https://your-alb-dns.amazonaws.com`
   - **awslogs-region** in both log configurations

2. Register:

   ```bash
   aws ecs register-task-definition --cli-input-json file://deploy/aws/task-definition.json
   ```

### Application Load Balancer and ECS service

Deploy **two target groups** on one ALB so the browser can keep using **`VITE_API_URL=/api`** (same origin as the page):

| Listener rule (priority) | Path / condition | Target group     | Port |
|--------------------------|------------------|------------------|------|
| Default                  | All other        | `frontend-tg`    | 80   |
| Higher priority          | `/api*`          | `backend-tg`     | 8000 |

Health checks:

- Backend TG: HTTP `GET /health` on port **8000**.
- Frontend TG: HTTP `GET /` on port **80**.

Create an **ECS cluster** (Fargate), then a **service**:

- Launch type: **Fargate**
- Task definition: `market-movers` family, latest revision
- Desired tasks: **1** (or more for HA)
- **Load balancing**: attach **both** target groups to the service (container **frontend** → port 80 → `frontend-tg`; container **backend** → port 8000 → `backend-tg`).
- Networking: subnets + security groups as above.

After the service is stable, open the ALB DNS name in a browser. API calls from the SPA to `/api/...` hit the ALB and are routed to the backend container.

**Note:** The bundled `frontend/nginx.conf` proxies `/api` to the hostname `backend`, which is correct for **Docker Compose**. On Fargate, **path-based routing on the ALB** avoids relying on that proxy: the browser talks to the ALB for both static assets and `/api`.

### Update the app

1. Rebuild and push images (`./deploy/aws/push-to-ecr.sh`).
2. Register a **new task definition revision** (same JSON with `:latest` images is fine if you always push to `latest`; production often uses immutable tags).
3. **Update the ECS service** to force a new deployment:

   ```bash
   aws ecs update-service --cluster YOUR_CLUSTER --service YOUR_SERVICE --force-new-deployment
   ```

---

## AWS EC2 free tier (t2.micro — free eligible for 12 months for new accounts)

Good for demos and low traffic. You pay for storage and optional Elastic IP behavior; the **t2.micro** hourly charge is covered under the free tier during eligibility.

### Launch an instance

1. EC2 → **Launch instance** → **Ubuntu Server 22.04 LTS** (64-bit x86).
2. Instance type: **t2.micro**.
3. Key pair: create or choose one (SSH).
4. Security group: inbound **SSH (22)** from your IP; **TCP 3000** from `0.0.0.0/0` (or your IP only for testing).
5. Storage: default gp2/gp3 (8 GiB is enough for Docker images within free tier storage limits).

### Run the setup script

1. **Copy the project** to the instance (e.g. `git clone` or `scp -r` the repo into `~/market-movers-yf`).
2. Upload `deploy/aws/ec2-setup.sh` or use the copy inside the repo.
3. SSH in and run:

   ```bash
   export GIT_REPO_URL=""   # optional; leave empty if you already copied the repo
   export APP_DIR="$HOME/market-movers-yf"
   chmod +x deploy/aws/ec2-setup.sh
   ./deploy/aws/ec2-setup.sh
   ```

4. Edit **`backend/.env`**: set `FINNHUB_API_KEY`, `GROQ_API_KEY`, and `ALLOWED_ORIGINS` to your instance’s public URL, e.g. `http://YOUR_PUBLIC_IP:3000`.
5. If you edited `.env` after the first run:

   ```bash
   cd ~/market-movers-yf && sudo docker compose up -d --build
   ```

6. In the EC2 console, note the **public IPv4 address**. Open **http://YOUR_PUBLIC_IP:3000**.

**Logout/login** may be required after `usermod -aG docker` if you run `docker` without `sudo` later.

---

## Estimated costs (line-by-line)

| Item | ECS Fargate + ALB (typical small app) | EC2 t2.micro |
|------|--------------------------------------|----------------|
| **Compute** | Fargate: **0.25 vCPU / 0.5 GB** ≈ $12–18/mo (varies by region/uptimes); this task file uses **0.5 vCPU / 1 GB** → roughly **double** that ballpark | **t2.micro**: **$0** hourly for **12 months** if within free tier; otherwise low on-demand rate |
| **Load balancer** | **ALB**: ~$16–22/mo base + LCU (requests/connections) | **None** if you use instance public IP and port 3000 |
| **Transfer** | Data out to internet (GB/month) | Same idea; often small for personal demos |
| **NAT Gateway** | **~$32/mo + data** if tasks are in **private** subnets without IPv6 egress — often **skip** for first deploy (public subnets) | N/A for simple single-instance Docker |
| **ECR** | **Storage** for images (pennies to a few $ at small scale) | Same if you pull from ECR; **none** if you build on instance only |
| **Secrets Manager** | **Per secret/month** + API calls (usually **~$1–2/mo** for two secrets) | Optional; EC2 can use **local `.env`** only (no Secrets Manager) |
| **EBS** | N/A (Fargate) | **8 GiB gp3**: often within **30 GiB** free tier for 12 months |

**Summary:** A minimal **EC2 + Docker Compose** setup can be **near $0** during free tier (plus pennies for storage). **ECS Fargate + ALB** is more “managed” but usually **tens of dollars per month** even at low traffic because of the ALB and Fargate minimums.

---

## Files in this folder

| File | Purpose |
|------|---------|
| `push-to-ecr.sh` | Log in to ECR, build, tag, and push backend + frontend images. |
| `task-definition.json` | Fargate task with **512 CPU / 1024 memory**, backend + frontend, keys from Secrets Manager. |
| `ec2-setup.sh` | Install Docker and Compose on Ubuntu, prepare `.env`, run `docker compose up -d --build`. |
