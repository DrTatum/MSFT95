#!/usr/bin/env bash
# MSFT95 testnet on one VPS: deploys the vault to Robinhood Chain testnet, then runs the casino API and the site.
#
#   sudo ./msft95.sh install            first time: deploy + start everything (safe to re-run; it skips what's done)
#   sudo ./msft95.sh allow 0xA,0xB      let more wallets deposit
#   sudo ./msft95.sh open               turn the allowlist off (any wallet can play)
#   sudo ./msft95.sh status             what's running, vault address, API health
#   sudo ./msft95.sh logs               follow the API log
#   sudo ./msft95.sh update             rebuild after you replace backend/ or site/index.template.html
#   sudo ./msft95.sh stop               stop the API, database and web server (data is kept)
#
# Nothing here touches other programs on the VPS. Everything runs in Docker containers named msft95-testnet-*.
set -euo pipefail
cd "$(dirname "$0")"; KIT="$PWD"
DOMAIN="${DOMAIN:-retarded.cloud}"
RPC="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"     # public RPC is rate-limited; an Alchemy testnet URL also works
EXPLORER="https://explorer.testnet.chain.robinhood.com"
API_PORT="${API_PORT:-8795}"
DEP="contracts/deployments/rhTestnet.json"

say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "Run with sudo: sudo ./msft95.sh $*"

# node runs inside a container, so whatever node your IMD agent uses is never touched
node_run(){ docker run --rm -i -v "$KIT":/kit -w "/kit/${WD:-contracts}" -e RH_TESTNET_RPC="$RPC" \
  -e DEPLOYER_KEY -e SIGNER -e COSIGNER -e GUARDIAN -e ALLOW -e ADDRS -e OPEN -e BANK_ETH -e GUARDIAN_GAS node:22-slim "$@"; }
hh(){ node_run npx hardhat "$@"; }
dep(){ WD=contracts node_run node -p "require('./deployments/rhTestnet.json').$1"; }
compose(){ docker compose --env-file "$KIT/.env" "$@"; }

ensure_docker(){
  if ! command -v docker >/dev/null 2>&1; then say "Installing Docker"; curl -fsSL https://get.docker.com | sh; fi
  docker compose version >/dev/null 2>&1 || die "Docker is installed but the 'docker compose' plugin is missing (apt install docker-compose-plugin)."
}

ask_deployer(){
  if [ -z "${DEPLOYER_KEY:-}" ]; then read -rsp "Deployer private key (a testnet wallet with testnet ETH; used now, never saved): " DEPLOYER_KEY; echo; fi
  DEPLOYER_KEY="${DEPLOYER_KEY#0x}"; [[ "$DEPLOYER_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "That isn't a 64-character hex private key."
  export DEPLOYER_KEY="0x$DEPLOYER_KEY"
}

install(){
  ensure_docker
  say "Installing the contract tools (in a container)"
  [ -d contracts/node_modules ] || node_run npm ci --no-audit --no-fund --loglevel=error
  hh compile --quiet

  if [ ! -f secrets.env ]; then
    say "Making the signer, cosigner and guardian keys (stay on this server, in secrets.env)"
    umask 077; node_run node scripts/keys.js > secrets.env; echo "DB_PASSWORD=$(openssl rand -hex 16)" >> secrets.env; umask 022
  fi
  set -a; . ./secrets.env; set +a

  if [ ! -f "$DEP" ]; then
    ask_deployer
    say "Deployer wallet"; hh run scripts/balance.js --network rhTestnet
    read -rp "Your wallet address(es) that may deposit, comma-separated (you can add more later): " ALLOW; export ALLOW
    say "Deploying the vault and test tokens to Robinhood Chain testnet (a few minutes)"
    hh run scripts/deploy.js --network rhTestnet
    read -rp "ETH to put in the house bankroll [0.02]: " BANK_ETH; export BANK_ETH="${BANK_ETH:-0.02}"
    say "Funding the house bankroll and the guardian's gas"
    hh run scripts/fund.js --network rhTestnet
    read -rp "Let ANY wallet play (turn the allowlist off)? [y/N]: " yn
    if [[ "$yn" =~ ^[Yy] ]]; then OPEN=1; export OPEN; hh run scripts/allow.js --network rhTestnet; fi
    unset DEPLOYER_KEY
  fi
  VAULT="$(dep vault | tr -d '\r')"; BLOCK="$(dep deployBlock | tr -d '\r')"

  say "Configuring the API"
  WD=backend node_run node scripts/tokens-from-deployment.mjs rhTestnet
  umask 077; cat > backend/.env <<EOF
NODE_ENV=production
CHAIN_ID=46630
RPC_URL=$RPC
VAULT_ADDRESS=$VAULT
START_BLOCK=$BLOCK
CONFIRMATIONS=2
SIWE_DOMAIN=$DOMAIN
SIWE_ORIGIN=https://$DOMAIN
CORS_ORIGINS=https://$DOMAIN
TRUST_PROXY=1
SEED_KEY=$SEED_KEY
SIGNER_KEY=$SIGNER_KEY
COSIGNER_KEY=$COSIGNER_KEY
GUARDIAN_KEY=$GUARDIAN_KEY
WITHDRAWAL_TTL_SEC=1800
TOKENS_FILE=config/tokens.testnet.json
EOF
  printf 'DOMAIN=%s\nAPI_PORT=%s\nDB_PASSWORD=%s\n' "$DOMAIN" "$API_PORT" "$DB_PASSWORD" > .env; umask 022

  say "Building the site for https://$DOMAIN"
  sed -e "s#__CASINO_API__#https://$DOMAIN/api#" -e "s#__VAULT__#$VAULT#" site/index.template.html > site/index.html

  start
  status
  cat <<EOF

Done. Open https://$DOMAIN, open Bernard Slots or Kimmy Keno, press the mode button at the top (PRACTICE ▾) → Cashier → Real tokens.
In the cashier, "Get 1,000 test USDC" mints free test tokens to your wallet, then Deposit.
Vault on the explorer: $EXPLORER/address/$VAULT
Keep secrets.env private: it holds the signer keys for this testnet.
EOF
}

webserver(){   # Caddy when 80/443 are free; otherwise the API stays on 127.0.0.1:$API_PORT behind your own web server
  if ss -ltnH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -q . && ! docker ps --format '{{.Names}}' | grep -q '^msft95-testnet-caddy'; then echo busy; else echo caddy; fi
}

start(){
  [ -f .env ] || die "Run: sudo ./msft95.sh install"
  local ws; ws="$(webserver)"
  if [ "$ws" = caddy ]; then
    local ip dns; ip="$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)"; dns="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
    [ -n "$ip" ] && [ "$ip" != "$dns" ] && echo "Warning: $DOMAIN points to ${dns:-nothing}, this server is $ip. HTTPS will work once DNS points here."
    say "Starting database, API and Caddy (HTTPS for $DOMAIN)"
    compose --profile caddy up -d --build
    command -v ufw >/dev/null && ufw status | grep -q "Status: active" && echo "ufw is on: if the site doesn't load, run: ufw allow 80,443/tcp"
  else
    say "Ports 80/443 are already used by another web server: starting database and API only"
    compose up -d --build db api
    cat <<EOF
Add this to your existing web server for $DOMAIN, then reload it.

nginx (inside the server block for $DOMAIN, with HTTPS set up as usual):
    root $KIT/site;
    index index.html;
    location /api/ {
        proxy_pass http://127.0.0.1:$API_PORT/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

Caddy:
    $DOMAIN {
        handle_path /api/* { reverse_proxy 127.0.0.1:$API_PORT }
        handle { root * $KIT/site; file_server }
    }
EOF
  fi
}

status(){
  say "Status"
  compose ps
  [ -f "$DEP" ] && echo "Vault: $(dep vault | tr -d '\r')   ($EXPLORER/address/$(dep vault | tr -d '\r'))"
  for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break; sleep 2; done
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then echo "API: up on 127.0.0.1:$API_PORT"; else echo "API: not answering yet — see: sudo ./msft95.sh logs"; fi
  curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1 && echo "Public: https://$DOMAIN/api is reachable" || echo "Public: https://$DOMAIN/api not reachable yet (DNS, certificate or web server)"
}

case "${1:-}" in
  install) install ;;
  allow) [ -n "${2:-}" ] || die "Usage: sudo ./msft95.sh allow 0xA,0xB"; ensure_docker; ask_deployer; ADDRS="$2"; export ADDRS; hh run scripts/allow.js --network rhTestnet ;;
  open) ensure_docker; ask_deployer; OPEN=1; export OPEN; hh run scripts/allow.js --network rhTestnet ;;
  status) status ;;
  logs) compose logs -f --tail=100 api ;;
  update) [ -f .env ] || die "Run install first"; [ -n "${RPC_URL:-}" ] && sed -i "s#^RPC_URL=.*#RPC_URL=$RPC#" backend/.env; VAULT="$(dep vault | tr -d '\r')"; sed -e "s#__CASINO_API__#https://$DOMAIN/api#" -e "s#__VAULT__#$VAULT#" site/index.template.html > site/index.html; start; status ;;
  stop) compose --profile caddy down ;;
  *) sed -n '2,12p' "$0" ;;
esac
