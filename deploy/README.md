# scanflow-api deployment

## Prerequisites

```bash
docker network create scanflow-shared-network
cp .env.example .env
# Edit .env with secrets (MONGODB_URL, JWT_SECRET, SMTP_*, BYPASS_EMAIL/OTP)
# For production set NODE_ENV=production, BEHIND_REVERSE_PROXY=true (if behind Apache/Nginx)
```

MongoDB is external (reference parity): point `MONGODB_URL` at your mongod
(e.g. `mongodb://127.0.0.1:27017/scanflow`; from a container use the host's LAN/container gateway, e.g. `mongodb://host.docker.internal:27017/scanflow`).

## Start / stop

Single replica:

```bash
docker compose -p scanflow-api up -d --build api
docker compose -p scanflow-api down
```

Two replicas (load-balanced via Apache on ports 3000 + 3004):

```bash
docker compose -p scanflow-api --profile replica up -d --build
docker compose -p scanflow-api --profile replica down
```

## Apache

- Public port: **7001**
- Backends: **3000** (primary), **3004** (replica)
- Config: [deploy/apache/scanflow-api.conf](./apache/scanflow-api.conf)

```bash
sudo a2enmod proxy proxy_http proxy_balancer lbmethod_byrequests rewrite headers
sudo ln -s $(pwd)/deploy/apache/scanflow-api.conf /etc/apache2/sites-available/
sudo a2ensite scanflow-api.conf && sudo systemctl reload apache2
```

## Health checks

```bash
curl http://localhost:3000/v1/health
curl http://localhost:3004/v1/health
```

## Resources

- Memory limit: **2G** per container (`MEMORY_LIMIT`, `MEMORY_RESERVATION` in `.env`)
- Ports: `HOST_PORT` (3000), `REPLICA_PORT` (3004), `CONTAINER_PORT` (3000)
- OTP: SMTP via `.env` (`SMTP_HOST/PORT/USERNAME/PASSWORD/EMAIL_FROM`); falls back to console in development; dev bypass via `BYPASS_EMAIL`/`BYPASS_OTP`.