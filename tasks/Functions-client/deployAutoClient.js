const { types } = require("hardhat/config")
const { VERIFICATION_BLOCK_CONFIRMATIONS, networkConfig } = require("../../network-config")
const {
  simulateRequest,
  buildRequest,
  getDecodedResultLog,
  getRequestConfig,
} = require("../../FunctionsSandboxLibrary")
const { verifyOffchainSecrets } = require("./buildRequestJSON")
const readline = require("readline-promise").default

task("functions-deploy-auto-client", "Deploys the AutomatedFunctionsConsumer contract")
  .addParam("subid", "Billing subscription ID used to pay for Functions requests")
  .addOptionalParam("interval", "Update interval in seconds for Automation to call performUpkeep", 300, types.int)
  .addOptionalParam("verify", "Set to true to verify client contract", false, types.boolean)
  .addOptionalParam(
    "gaslimit",
    "Maximum amount of gas that can be used to call fulfillRequest in the client contract",
    250000,
    types.int
  )
  .setAction(async (taskArgs) => {
    if (network.name === "hardhat") {
      throw Error(
        'This command cannot be used on a local hardhat chain.  Specify a valid network or simulate an FunctionsConsumer request locally with "npx hardhat functions-simulate".'
      )
    }

    if (taskArgs.gaslimit > 300000) {
      throw Error("Gas limit must be less than or equal to 300,000")
    }

    console.log(`Deploying AutomatedFunctionsConsumer contract to ${network.name}`)

    const oracleAddress = networkConfig[network.name]["functionsOracle"]

    console.log("\n__Compiling Contracts__")
    await run("compile")

    const autoClientContractFactory = await ethers.getContractFactory("AutomatedFunctionsConsumer")
    const autoClientContract = await autoClientContractFactory.deploy(
      oracleAddress,
      taskArgs.subid,
      taskArgs.gaslimit,
      taskArgs.interval
    )

    console.log(`\nWaiting 1 block for transaction ${autoClientContract.deployTransaction.hash} to be confirmed...`)
    await autoClientContract.deployTransaction.wait(1)

    await addClientConsumerToSubscription(taskArgs.subid, autoClientContract.address)

    const request = await generateRequest()

    const functionsRequestBytes = await autoClientContract.generateRequest(
      request.source,
      request.secrets ?? [],
      request.secretsLocation,
      request.args ?? []
    )

    console.log("Setting Functions request")
    const setRequestTx = await autoClientContract.setRequest(functionsRequestBytes)

    console.log(
      `\nWaiting ${VERIFICATION_BLOCK_CONFIRMATIONS} block for transaction ${setRequestTx.hash} to be confirmed...`
    )
    await setRequestTx.wait(VERIFICATION_BLOCK_CONFIRMATIONS)

    const verifyContract = taskArgs.verify

    if (verifyContract && (process.env.POLYGONSCAN_API_KEY || process.env.ETHERSCAN_API_KEY)) {
      try {
        console.log("\nVerifying contract...")
        await autoClientContract.deployTransaction.wait(Math.max(6 - VERIFICATION_BLOCK_CONFIRMATIONS, 0))
        await run("verify:verify", {
          address: autoClientContract.address,
          constructorArguments: [oracleAddress, taskArgs.subid, taskArgs.gaslimit, taskArgs.interval],
        })
        console.log("Contract verified")
      } catch (error) {
        if (!error.message.includes("Already Verified")) {
          console.log("Error verifying contract.  Try delete the ./build folder and try again.")
          console.log(error)
        } else {
          console.log("Contract already verified")
        }
      }
    } else if (verifyContract) {
      console.log("\nPOLYGONSCAN_API_KEY or ETHERSCAN_API_KEY missing. Skipping contract verification...")
    }

    console.log(`\nAutomatedFunctionsConsumer contract deployed to ${autoClientContract.address} on ${network.name}`)
  })

const generateRequest = async () => {
  console.log("Simulating Functions request locally...")
  const unvalidatedRequestConfig = require("../../Functions-request-config.js")
  const requestConfig = getRequestConfig(unvalidatedRequestConfig)

  if (requestConfig.secretsLocation === 1) {
    requestConfig.secrets = undefined
    if (!requestConfig.globalOffchainSecrets || Object.keys(requestConfig.globalOffchainSecrets).length === 0) {
      if (
        requestConfig.perNodeOffchainSecrets &&
        requestConfig.perNodeOffchainSecrets[0] &&
        Object.keys(requestConfig.perNodeOffchainSecrets[0]).length > 0
      ) {
        requestConfig.secrets = requestConfig.perNodeOffchainSecrets[0]
      }
    } else {
      requestConfig.secrets = requestConfig.globalOffchainSecrets
    }
    // Get node addresses for off-chain secrets
    const [nodeAddresses, publicKeys] = await oracle.getAllNodePublicKeys()
    if (requestConfig.secretsURLs && requestConfig.secretsURLs.length > 0) {
      await verifyOffchainSecrets(requestConfig.secretsURLs, nodeAddresses)
    }
  }

  const { success, resultLog } = await simulateRequest(requestConfig)
  console.log(`\n${resultLog}`)

  // If the simulated JavaScript source code contains an error, confirm the user still wants to continue
  if (!success) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const q1answer = await rl.questionAsync(
      "There was an error when running the JavaScript source code for the request.\nContinue? (y) Yes / (n) No\n"
    )
    rl.close()
    if (q1answer.toLowerCase() !== "y" && q1answer.toLowerCase() !== "yes") {
      return
    }
  }

  const OracleFactory = await ethers.getContractFactory("FunctionsOracle")
  const oracle = await OracleFactory.attach(networkConfig[network.name]["functionsOracle"])
  // Fetch the DON public key from on-chain
  const DONPublicKey = await oracle.getDONPublicKey()
  // Remove the preceding 0x from the DON public key
  requestConfig.DONPublicKey = DONPublicKey.slice(2)
  // Build the parameters to make a request from the client contract
  const request = await buildRequest(requestConfig)
  request.secretsLocation = requestConfig.secretsLocation
  return request
}
