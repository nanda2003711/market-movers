#!/usr/bin/env bash
# Build and push Docker images to Amazon ECR.
# Run from the repository root (directory that contains backend/ and frontend/).
set -euo pipefail

AWS_REGION=us-east-1
AWS_ACCOUNT_ID=your_account_id_here
ECR_BACKEND=market-movers-backend
ECR_FRONTEND=market-movers-frontend

ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
BACKEND_URI="${ECR_REGISTRY}/${ECR_BACKEND}"
FRONTEND_URI="${ECR_REGISTRY}/${ECR_FRONTEND}"

if [[ "${AWS_ACCOUNT_ID}" == "your_account_id_here" ]]; then
  echo "Edit push-to-ecr.sh and set AWS_ACCOUNT_ID (and other variables if needed)."
  exit 1
fi

aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

docker build -t "${ECR_BACKEND}:latest" ./backend
docker tag "${ECR_BACKEND}:latest" "${BACKEND_URI}:latest"
docker push "${BACKEND_URI}:latest"

docker build -t "${ECR_FRONTEND}:latest" ./frontend --build-arg VITE_API_URL=/api
docker tag "${ECR_FRONTEND}:latest" "${FRONTEND_URI}:latest"
docker push "${FRONTEND_URI}:latest"

echo ""
echo "Pushed images:"
echo "  Backend:  ${BACKEND_URI}:latest"
echo "  Frontend: ${FRONTEND_URI}:latest"
