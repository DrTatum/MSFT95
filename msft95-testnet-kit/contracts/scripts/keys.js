// prints fresh keys for the signer, cosigner and guardian (three different wallets) and the seed key
const { Wallet, hexlify, randomBytes } = require("ethers");
for (const k of ["SIGNER", "COSIGNER", "GUARDIAN"]) { const w = Wallet.createRandom(); console.log(`${k}_KEY=${w.privateKey.slice(2)}`); console.log(`${k}=${w.address}`); }
console.log(`SEED_KEY=${hexlify(randomBytes(32)).slice(2)}`);
