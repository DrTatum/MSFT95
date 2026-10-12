require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the solc-js compiler bundled in node_modules/solc (no compiler download needed).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return { compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: "0.8.24+commit.e11b9ed9" };
  }
  return runSuper();
});

const PK = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 500 }, evmVersion: "shanghai" } },
  networks: {
    rhTestnet: { url: process.env.RH_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com", chainId: 46630, accounts: PK },
    rhMainnet: { url: process.env.RH_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com", chainId: 4663, accounts: PK },
  },
  gasReporter: { enabled: !!process.env.REPORT_GAS },
};
