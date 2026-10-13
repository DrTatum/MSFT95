# MSFT95 testnet kit (retarded.cloud)

One script puts the whole real-token casino on Robinhood Chain **testnet**:

- **The vault contract**, plus free test tokens (tUSDC, tMSFT95, tNET, tIMD) that anyone can mint.
- **The casino API**: the backend from step 2, with its own Postgres database.
- **The site** at `https://retarded.cloud`, with the API at `https://retarded.cloud/api`.

Everything runs in Docker containers named `msft95-testnet-*`. Your IMD agent and anything else on the VPS is left alone, and Node runs inside a container, so your system Node is never touched.

## What you need

- **The VPS.** Ubuntu or Debian, with `sudo`.
- **DNS.** `retarded.cloud` must point at the VPS (an A record). HTTPS needs this.
- **Deployer wallet.** A testnet wallet with some Robinhood Chain testnet ETH, about 0.05 or more. You paste its private key once, during install. It's used for the deploy and never saved.
- **Your own wallet address(es).** These go on the allowlist so you can deposit.

## 1. Put the kit on the VPS

From your computer:

```bash
scp msft95-testnet-kit.zip root@YOUR_VPS_IP:/opt/
ssh root@YOUR_VPS_IP
cd /opt && apt-get install -y unzip && unzip msft95-testnet-kit.zip && cd msft95-testnet-kit
```

(Or push the folder to your GitHub repo and `git clone` it on the VPS.)

## 2. Install

```bash
sudo ./msft95.sh install
```

The script will:

1. Install Docker if it's missing.
2. Make three new keys (signer, cosigner and guardian) and a seed key, and save them in `secrets.env` on the VPS only.
3. Ask for the deployer key and your wallet address(es), then deploy the vault and the test tokens. Your wallets get 1,000,000 of each test token.
4. Put half the deployer's test tokens and some ETH (you choose how much; default 0.02) into the house bankroll, and give the guardian a little ETH for gas.
5. Ask whether any wallet may play. Saying no keeps it to the allowlist.
6. Configure and start the API, build the site, and start Caddy, which gets the HTTPS certificate by itself.

If ports 80/443 are already used by another web server, it skips Caddy and prints the few lines to add to your nginx or Caddy config instead.

It's safe to run again: anything already done is skipped (the vault is only deployed once).

## 3. Play

1. Open `https://retarded.cloud`, then open Bernard Slots or Kimmy Keno.
2. Click the **PRACTICE ▾** button, then **Cashier…**, then **Real tokens**.
3. Choose **Connect wallet & sign in**. The wallet adds Robinhood Chain Testnet if it doesn't know it.
4. Press **Get 1,000 test USDC**. This mints free test tokens.
5. **Deposit**, play, **Withdraw**.

## Everyday commands

```bash
sudo ./msft95.sh status          # containers, vault address, API health
sudo ./msft95.sh logs            # follow the API log
sudo ./msft95.sh allow 0xA,0xB   # let more wallets deposit (asks for the deployer key: it's the vault admin)
sudo ./msft95.sh open            # turn the allowlist off: any wallet can play
sudo ./msft95.sh update          # after replacing backend/ or site/index.template.html with a newer version
sudo ./msft95.sh stop            # stop it all (the database is kept)
```

## Good to know

- **RPC limits.** The public testnet RPC is rate-limited. If the log shows RPC errors, get a free Alchemy testnet URL and run `RPC_URL=https://robinhood-testnet.g.alchemy.com/v2/KEY sudo -E ./msft95.sh update`.
- **Deposits.** They're credited after 2 blocks.
- **Withdrawals.** Each one is a voucher that your wallet sends to the vault. One that isn't sent shows under "Withdrawals waiting" with a Claim button, and refunds itself after 30 minutes.
- **`secrets.env`.** It holds this testnet's signer keys, so keep it private. These keys must never be reused on mainnet: mainnet uses a KMS signer and a separate cosigner.
- **Explorer.** The vault is at `https://explorer.testnet.chain.robinhood.com/address/<vault>` (run `status` for the address).
