# Deploy IronClaw Separately on AWS (EC2)

This runbook deploys IronClaw as a standalone internet-facing service on EC2 so hyperClaw can call it over HTTPS.

## Target Topology

- `postgres` + `ironclaw` on one EC2 instance via Docker Compose
- `caddy` terminates TLS and exposes only:
  - `GET /health`
  - `POST /webhook`
- hyperClaw uses:
  - `IRONCLAW_WEBHOOK_URL=https://<ironclaw-domain>/webhook`
  - `IRONCLAW_WEBHOOK_SECRET=<shared-secret>`

## 1. DNS + Security Group

1. Allocate and attach an Elastic IP to the EC2 instance.
2. Create DNS record:
   - `A ironclaw.example.com -> <elastic-ip>`
3. Security group inbound rules:
   - `22/tcp` from operator IP range
   - `80/tcp` from `0.0.0.0/0`
   - `443/tcp` from `0.0.0.0/0`
4. Outbound: allow internet egress so Caddy can obtain/renew certificates.

## 2. Install Docker on EC2

Ubuntu 22.04/24.04:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
```

## 3. Deploy Stack

```bash
git clone https://github.com/Halo-Labs-xyz/hyperClaw.git
cd hyperClaw
cp .env.ironclaw-aws.example .env.ironclaw-aws
```

Set secrets:

```bash
openssl rand -hex 32   # SECRETS_MASTER_KEY
openssl rand -hex 32   # HTTP_WEBHOOK_SECRET (reuse in hyperClaw as IRONCLAW_WEBHOOK_SECRET)
openssl rand -base64 24 # PG_PASSWORD
```

Edit `.env.ironclaw-aws`:

- `IRONCLAW_DOMAIN`
- `ACME_EMAIL`
- `PG_PASSWORD`
- `SECRETS_MASTER_KEY`
- `HTTP_WEBHOOK_SECRET`
- `NEARAI_SESSION_TOKEN`

Start:

```bash
bash scripts/ironclaw-aws-stack.sh up
bash scripts/ironclaw-aws-stack.sh ps
```

## 4. Verify Public Health Endpoint

```bash
curl -fsS https://ironclaw.example.com/health
```

Expected: JSON health payload from IronClaw.

If TLS is not issued:

- verify DNS resolves to the EC2 elastic IP
- verify ports `80` and `443` are open in the security group
- inspect logs: `bash scripts/ironclaw-aws-stack.sh logs caddy`

## 5. Wire hyperClaw to Remote IronClaw

In hyperClaw runtime environment:

```bash
IRONCLAW_WEBHOOK_URL=https://ironclaw.example.com/webhook
IRONCLAW_WEBHOOK_SECRET=<same-value-as-HTTP_WEBHOOK_SECRET>
```

Restart hyperClaw after env update.

## 6. Validate hyperClaw -> IronClaw Path

From hyperClaw host:

```bash
curl -sS -X POST "https://<hyperclaw-domain>/api/ironclaw" \
  -H "content-type: application/json" \
  -H "x-api-key: $HYPERCLAW_API_KEY" \
  --data '{"healthCheck":true}'
```

Expected response includes:

- `"configured": true`
- `"ironclaw": "healthy"`

## Operations

```bash
bash scripts/ironclaw-aws-stack.sh logs
bash scripts/ironclaw-aws-stack.sh restart ironclaw
bash scripts/ironclaw-aws-stack.sh pull
bash scripts/ironclaw-aws-stack.sh up
bash scripts/ironclaw-aws-stack.sh down
```

## Hard Requirements for Production

- keep `HTTP_WEBHOOK_SECRET` set
- keep `SECRETS_MASTER_KEY` stable and backed up
- keep only `80/443` public; do not publish postgres port
- rotate webhook/API secrets on any exposure event
