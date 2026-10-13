// prints the deployer's address and testnet ETH balance
const { ethers } = require("hardhat");
(async () => { const [me] = await ethers.getSigners(); console.log(me.address, ethers.formatEther(await ethers.provider.getBalance(me.address)), "ETH"); })().catch((e) => { console.error(e.message); process.exit(1); });
