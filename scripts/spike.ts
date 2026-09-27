import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type TransactionSerializedLegacy,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import { recoverAuthorizationAddress } from "viem/utils";
import { z } from "zod";

const environment = z
  .object({
    ETHEREUM_RPC_URL: z.url().default("https://evm.stupidtech.net/v1/1"),
    BASE_RPC_URL: z.url().default("https://evm.stupidtech.net/v1/8453"),
  })
  .parse(process.env);

const factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const;
const factorySigner = "0x3fab184622dc19b6109349b94811493bf2a45362" as const;
const factoryCode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;
const pinnedFactoryHash = "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989";
const pinnedInitcodeHash = "0x5402ca01dd87e53c63aa8074f626f16c779dd13164bdb018ea12b479443da495";
const pinnedRuntimeHash = "0x4136f829e1a8cba34358eaf145133e7f8e5a0c3eccbe7e7105c64f7bfd70d2f0";
const pinnedDelegate = "0x178473Ea4dcDe2519C0D80110D2D28E301B51F42";
// Arachnid deterministic-deployment-proxy's original unprotected deployment transaction.
// Public, fixed signed transaction; it contains no private key.
const factoryDeployment =
  "0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222" as const;
const salt = `0x${"00".repeat(32)}` as const;
const artifact = z
  .object({
    bytecode: z.object({ object: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
    deployedBytecode: z.object({ object: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
  })
  .parse(await Bun.file("out/SpikeDelegate.sol/SpikeDelegate.json").json());
const abi = parseAbi([
  "function initialize(address parentAddress, bytes signature)",
  "function initDigest(address parentAddress) view returns (bytes32)",
  "function parent() view returns (address)",
  "function rescue(address recipient, uint256 amount)",
]);
const initcode = artifact.bytecode.object as Hex;
const runtime = artifact.deployedBytecode.object as Hex;
const delegate = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode: initcode });
const pointer = concatHex(["0xef0100", delegate]);
const expectedRuntimeHash = keccak256(runtime);
assert.equal(keccak256(factoryCode), pinnedFactoryHash);
assert.equal(keccak256(initcode), pinnedInitcodeHash);
assert.equal(expectedRuntimeHash, pinnedRuntimeHash);
assert.equal(delegate, pinnedDelegate);

const rpcResponse = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

async function anvilRpc({
  url,
  method,
  params,
}: {
  url: string;
  method: string;
  params: unknown[];
}) {
  const response = rpcResponse.parse(
    await (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    ).json(),
  );
  if (response.error) throw new Error(`${method}: ${response.error.message}`);
  if (response.result === undefined) throw new Error(`${method}: missing result`);
  return response.result;
}

async function setBalance({
  url,
  address,
  amount,
}: {
  url: string;
  address: Address;
  amount: bigint;
}) {
  await anvilRpc({ url, method: "anvil_setBalance", params: [address, toHex(amount)] });
}

async function receipt({ client, hash }: { client: PublicClient<Transport, Chain>; hash: Hex }) {
  const result = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  assert.equal(result.transactionHash, hash);
  return result;
}

function clientFor({
  url,
  chain,
  account,
}: {
  url: string;
  chain: Chain;
  account: ReturnType<typeof privateKeyToAccount>;
}) {
  return createWalletClient({ account, chain, transport: http(url) });
}

async function bootFactory({
  url,
  client,
  relayer,
}: {
  url: string;
  client: PublicClient<Transport, Chain>;
  relayer: ReturnType<typeof clientFor>;
}) {
  assert.equal(await client.getCode({ address: factory }), factoryCode);
  // On the fork, remove the pre-existing deployer to exercise the missing-factory path.
  await anvilRpc({ url, method: "anvil_setCode", params: [factory, "0x"] });
  await anvilRpc({ url, method: "anvil_setNonce", params: [factory, "0x0"] });
  await anvilRpc({ url, method: "anvil_setNonce", params: [factorySigner, "0x0"] });
  assert.equal(await client.getCode({ address: factory }), undefined);
  assert.equal(
    (
      await recoverTransactionAddress({
        serializedTransaction: factoryDeployment as TransactionSerializedLegacy,
      })
    ).toLowerCase(),
    factorySigner.toLowerCase(),
  );
  const funding = await relayer.sendTransaction({
    type: "eip1559",
    to: factorySigner,
    value: parseEther("0.02"),
  });
  console.error(`factory signer funding: ${funding}`);
  assert.equal((await receipt({ client, hash: funding })).status, "success");
  const hash = await client.sendRawTransaction({ serializedTransaction: factoryDeployment });
  console.error(`factory replay: ${hash}`);
  assert.equal((await receipt({ client, hash })).status, "success");
  assert.equal(await client.getCode({ address: factory }), factoryCode);
  return { funding, deployment: hash };
}

async function prepareRescue({
  client,
  agent,
  parent,
}: {
  client: ReturnType<typeof clientFor>;
  agent: ReturnType<typeof privateKeyToAccount>;
  parent: Address;
}) {
  const authorization = await client.signAuthorization({
    account: agent,
    chainId: 0,
    contractAddress: delegate,
    nonce: 0,
  });
  assert.equal(
    (await recoverAuthorizationAddress({ authorization })).toLowerCase(),
    agent.address.toLowerCase(),
  );
  const initDigest = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "address" }],
      ["agent-wallet.spike.init.v1", agent.address, parent, delegate],
    ),
  );
  const signature = await agent.sign({ hash: initDigest });
  return { address: agent.address, authorization, signature };
}

async function runChain({
  chain,
  upstream,
  port,
}: {
  chain: Chain;
  upstream: string;
  port: number;
}) {
  console.error(`Starting ${chain.id} fork`);
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(
    "anvil",
    [
      "--fork-url",
      upstream,
      "--port",
      String(port),
      "--hardfork",
      "prague",
      "--disable-default-create2-deployer",
      "--quiet",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  server.stderr.on("data", (chunk: Buffer) => (logs += chunk.toString()));
  try {
    const client = createPublicClient({ chain, transport: http(url) });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) break;
      try {
        ready = (await client.getChainId()) === chain.id;
        if (ready) break;
      } catch {
        /* anvil is starting */
      }
      await delay(200);
    }
    assert(ready, `Anvil failed to start on ${chain.id}: ${logs}`);
    const upstreamClient = createPublicClient({ chain, transport: http(upstream) });
    const upstreamBlock = await upstreamClient.getBlockNumber();
    assert.equal(await upstreamClient.getCode({ address: factory }), factoryCode);
    assert.equal(await client.getCode({ address: factory }), factoryCode);
    console.error(`${chain.id}: factory verified at block ${upstreamBlock}`);

    const parent = privateKeyToAccount(generatePrivateKey());
    const relayerAccount = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey());
    const parentWallet = clientFor({ url, chain, account: parent });
    const relayer = clientFor({ url, chain, account: relayerAccount });
    await setBalance({ url, address: parent.address, amount: parseEther("5") });
    // Parent pays the relayer, which funds the public one-time factory signer.
    const funding = await parentWallet.sendTransaction({
      type: "eip1559",
      to: relayerAccount.address,
      value: parseEther("1"),
    });
    assert.equal((await receipt({ client, hash: funding })).status, "success");
    const bootstrap = await bootFactory({ url, client, relayer });
    console.error(`${chain.id}: factory bootstrap replayed`);
    const factorySnapshot = z
      .string()
      .parse(await anvilRpc({ url, method: "evm_snapshot", params: [] }));

    const rescueAgent = privateKeyToAccount(generatePrivateKey());
    const rescueWallet = clientFor({ url, chain, account: rescueAgent });
    const saved = await prepareRescue({
      client: rescueWallet,
      agent: rescueAgent,
      parent: parent.address,
    });
    assert.equal(saved.authorization.chainId, 0);
    assert.equal(saved.authorization.nonce, 0);
    const endowed = await parentWallet.sendTransaction({
      type: "eip1559",
      to: saved.address,
      value: parseEther("0.2"),
    });
    assert.equal((await receipt({ client, hash: endowed })).status, "success");

    // The agent key is deliberately absent from all rescue calls below.
    const beforeRescue = z
      .string()
      .parse(await anvilRpc({ url, method: "evm_snapshot", params: [] }));
    const drift = await rescueWallet.sendTransaction({
      type: "eip1559",
      to: recipient.address,
      value: 1n,
      nonce: 0,
    });
    assert.equal((await receipt({ client, hash: drift })).status, "success");
    assert.equal(await client.getTransactionCount({ address: saved.address }), 1);
    const driftAttempt = await relayer.sendTransaction({
      type: "eip7702",
      to: saved.address,
      data: encodeFunctionData({
        abi,
        functionName: "initialize",
        args: [parent.address, saved.signature],
      }),
      authorizationList: [saved.authorization],
      gas: 400_000n,
    });
    assert.equal((await receipt({ client, hash: driftAttempt })).status, "success");
    assert.equal(await client.getCode({ address: saved.address }), undefined);
    assert.equal(await anvilRpc({ url, method: "evm_revert", params: [beforeRescue] }), true);
    console.error(`${chain.id}: nonce drift rejected`);

    const createRescue = await relayer.sendTransaction({
      type: "eip1559",
      to: factory,
      data: concatHex([salt, initcode]),
      gas: 2_000_000n,
    });
    assert.equal((await receipt({ client, hash: createRescue })).status, "success");
    assert.equal(keccak256((await client.getCode({ address: delegate }))!), expectedRuntimeHash);
    console.error(`${chain.id}: delegate deployed`);

    // A failing initialization still installs the pointer; a retry must inspect both state and nonce.
    const beforeInvalidInit = z
      .string()
      .parse(await anvilRpc({ url, method: "evm_snapshot", params: [] }));
    const wrongParent = privateKeyToAccount(generatePrivateKey());
    const invalidInit = await relayer.sendTransaction({
      type: "eip7702",
      to: saved.address,
      data: encodeFunctionData({
        abi,
        functionName: "initialize",
        args: [wrongParent.address, saved.signature],
      }),
      authorizationList: [saved.authorization],
      gas: 400_000n,
    });
    assert.equal((await receipt({ client, hash: invalidInit })).status, "reverted");
    assert.equal(
      (await client.getCode({ address: saved.address }))?.toLowerCase(),
      pointer.toLowerCase(),
    );
    assert.equal(await client.getTransactionCount({ address: saved.address }), 1);
    console.error(`${chain.id}: reverted init preserved pointer`);
    assert.equal(
      await client.readContract({ address: saved.address, abi, functionName: "parent" }),
      "0x0000000000000000000000000000000000000000",
    );
    // The legitimate signed proof can initialize the account even after a reverted relayer execution.
    assert.equal(
      await client.readContract({
        address: saved.address,
        abi,
        functionName: "initDigest",
        args: [parent.address],
      }),
      keccak256(
        encodeAbiParameters(
          [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "address" }],
          ["agent-wallet.spike.init.v1", saved.address, parent.address, delegate],
        ),
      ),
    );
    const initialize = await relayer.sendTransaction({
      type: "eip1559",
      to: saved.address,
      data: encodeFunctionData({
        abi,
        functionName: "initialize",
        args: [parent.address, saved.signature],
      }),
      gas: 400_000n,
    });
    assert.equal((await receipt({ client, hash: initialize })).status, "success");
    assert.equal(
      (
        (await client.readContract({
          address: saved.address,
          abi,
          functionName: "parent",
        })) as Address
      ).toLowerCase(),
      parent.address.toLowerCase(),
    );
    const rescueRevert = await parentWallet.sendTransaction({
      type: "eip1559",
      to: saved.address,
      data: encodeFunctionData({
        abi,
        functionName: "rescue",
        args: [recipient.address, parseEther("1")],
      }),
      gas: 150_000n,
    });
    assert.equal((await receipt({ client, hash: rescueRevert })).status, "reverted");
    const recipientBefore = await client.getBalance({ address: recipient.address });
    const rescue = await parentWallet.sendTransaction({
      type: "eip1559",
      to: saved.address,
      data: encodeFunctionData({
        abi,
        functionName: "rescue",
        args: [recipient.address, parseEther("0.1")],
      }),
      gas: 150_000n,
    });
    assert.equal((await receipt({ client, hash: rescue })).status, "success");
    console.error(`${chain.id}: parent rescue completed`);
    assert.equal(
      (await client.getBalance({ address: recipient.address })) - recipientBefore,
      parseEther("0.1"),
    );

    // Independently check the usual single-transaction authorization + signed initialization.
    assert.equal(await anvilRpc({ url, method: "evm_revert", params: [beforeInvalidInit] }), true);
    assert.equal(await client.getTransactionCount({ address: saved.address }), 0);
    const directInit = await relayer.sendTransaction({
      type: "eip7702",
      to: saved.address,
      data: encodeFunctionData({
        abi,
        functionName: "initialize",
        args: [parent.address, saved.signature],
      }),
      authorizationList: [saved.authorization],
      gas: 400_000n,
    });
    assert.equal((await receipt({ client, hash: directInit })).status, "success");
    assert.equal(
      (await client.getCode({ address: saved.address }))?.toLowerCase(),
      pointer.toLowerCase(),
    );
    assert.equal(
      (
        await client.readContract({ address: saved.address, abi, functionName: "parent" })
      ).toLowerCase(),
      parent.address.toLowerCase(),
    );

    // Restore to a chain with only the bootstrapped deployer for independent first use.
    assert.equal(await anvilRpc({ url, method: "evm_revert", params: [factorySnapshot] }), true);
    assert.equal(await client.getCode({ address: delegate }), undefined);
    const selfAgent = privateKeyToAccount(generatePrivateKey());
    await setBalance({ url, address: selfAgent.address, amount: parseEther("0.5") });
    const selfWallet = clientFor({ url, chain, account: selfAgent });
    const selfAuth = await selfWallet.signAuthorization({
      account: selfAgent,
      chainId: chain.id,
      contractAddress: delegate,
      nonce: 1,
    });
    assert.equal(
      (await recoverAuthorizationAddress({ authorization: selfAuth })).toLowerCase(),
      selfAgent.address.toLowerCase(),
    );
    assert.equal(await client.getTransactionCount({ address: selfAgent.address }), 0);
    const selfDeploy = await selfWallet.sendTransaction({
      type: "eip7702",
      to: factory,
      data: concatHex([salt, initcode]),
      nonce: 0,
      authorizationList: [selfAuth],
      gas: 2_000_000n,
    });
    assert.equal((await receipt({ client, hash: selfDeploy })).status, "success");
    assert.equal((await client.getTransaction({ hash: selfDeploy })).type, "eip7702");
    assert.equal(
      (await client.getCode({ address: selfAgent.address }))?.toLowerCase(),
      pointer.toLowerCase(),
    );
    assert.equal(await client.getTransactionCount({ address: selfAgent.address }), 2);
    assert.equal(keccak256((await client.getCode({ address: delegate }))!), expectedRuntimeHash);
    console.error(`${chain.id}: agent first-use completed`);

    return {
      chainId: chain.id,
      upstreamBlock: upstreamBlock.toString(),
      factory,
      factoryCodeHash: keccak256(factoryCode),
      factoryBootstrap: bootstrap,
      delegate,
      initcodeHash: keccak256(initcode),
      runtimeCodeHash: expectedRuntimeHash,
      preUse: {
        agent: saved.address,
        funding: endowed,
        drift,
        driftAttempt,
        create: createRescue,
        revertedInit: invalidInit,
        initialize,
        revertedRescue: rescueRevert,
        rescue,
        directInit,
      },
      firstUse: {
        agent: selfAgent.address,
        authorizationNonce: selfAuth.nonce,
        transactionNonce: 0,
        deploy: selfDeploy,
      },
    };
  } finally {
    server.kill("SIGTERM");
  }
}

const results = [];
for (const [chain, upstream, port] of [
  [mainnet, environment.ETHEREUM_RPC_URL, 18541],
  [base, environment.BASE_RPC_URL, 18542],
] as const) {
  results.push(await runChain({ chain, upstream, port }));
}
assert.equal(results[0].delegate, results[1].delegate);
assert.equal(results[0].runtimeCodeHash, results[1].runtimeCodeHash);
assert.equal(results[0].factoryCodeHash, results[1].factoryCodeHash);
console.log(JSON.stringify({ kind: "local-fork-only", results }, null, 2));
