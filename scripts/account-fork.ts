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
  toHex,
  type Address,
  type Chain,
  type Hex,
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
const factoryHash = "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989";
const salt = `0x${"00".repeat(32)}` as const;
const artifact = z
  .object({
    bytecode: z.object({ object: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
    deployedBytecode: z.object({
      object: z.string().regex(/^0x[0-9a-fA-F]+$/),
      immutableReferences: z.record(
        z.string(),
        z.array(z.object({ start: z.number(), length: z.number() })),
      ),
    }),
  })
  .parse(await Bun.file("out/AgentAccount.sol/AgentAccount.json").json());
const abi = parseAbi([
  "function parent() view returns (address)",
  "function executeBatch((address to, uint256 value, bytes data)[] calls)",
]);

async function runChain({
  chain,
  upstream,
  port,
  parent,
}: {
  chain: Chain;
  upstream: string;
  port: number;
  parent: ReturnType<typeof privateKeyToAccount>;
}) {
  const initcode = concatHex([
    artifact.bytecode.object as Hex,
    encodeAbiParameters([{ type: "address" }], [parent.address]),
  ]);
  const delegate = getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt,
    bytecode: initcode,
  });
  // Solc's deployedBytecode has zeroed immutable placeholders; the constructor fills them with the parent.
  const referenceGroups = Object.values(artifact.deployedBytecode.immutableReferences);
  assert.equal(referenceGroups.length, 1, "Expected only the parent immutable");
  let runtime = artifact.deployedBytecode.object.slice(2);
  for (const { start, length } of referenceGroups[0]) {
    assert.equal(length, 32);
    runtime = `${runtime.slice(0, start * 2)}${parent.address.slice(2).padStart(64, "0")}${runtime.slice((start + length) * 2)}`;
  }
  const runtimeHash = keccak256(`0x${runtime}`);
  const pointer = concatHex(["0xef0100", delegate]);
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(
    "anvil",
    ["--fork-url", upstream, "--port", String(port), "--hardfork", "prague", "--quiet"],
    { stdio: ["ignore", "pipe", "pipe"] },
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
        // Anvil is starting.
      }
      await delay(200);
    }
    assert(ready, `Anvil failed to start for ${chain.id}: ${logs}`);
    const upstreamClient = createPublicClient({ chain, transport: http(upstream) });
    const upstreamBlock = await upstreamClient.getBlockNumber();
    const code = await client.getCode({ address: factory });
    assert(code);
    assert.equal(keccak256(code), factoryHash);

    const relayer = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey());
    const parentWallet = createWalletClient({ account: parent, chain, transport: http(url) });
    const relayerWallet = createWalletClient({ account: relayer, chain, transport: http(url) });
    const rpc = async (method: string, params: unknown[]) => {
      const response = z
        .object({
          result: z.unknown().optional(),
          error: z.object({ message: z.string() }).optional(),
        })
        .parse(
          await (
            await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            })
          ).json(),
        );
      if (response.error || response.result === undefined) {
        throw new Error(`${method}: ${response.error?.message ?? "missing result"}`);
      }
      return response.result;
    };
    const setBalance = async (address: Address, value: bigint) =>
      rpc("anvil_setBalance", [address, toHex(value)]);
    const sendAndCheck = async (hash: Hex) => {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      assert.equal(receipt.status, "success", `Transaction reverted: ${hash}`);
      return hash;
    };
    await setBalance(parent.address, parseEther("1"));
    await sendAndCheck(
      await parentWallet.sendTransaction({ to: relayer.address, value: parseEther("0.5") }),
    );
    const snapshot = z.string().parse(await rpc("evm_snapshot", []));

    // Pre-use rescue: the key signs artifacts here and is not used after this point in this branch.
    const lostAgent = privateKeyToAccount(generatePrivateKey());
    const lostWallet = createWalletClient({ account: lostAgent, chain, transport: http(url) });
    const authorization = await lostWallet.signAuthorization({
      account: lostAgent,
      chainId: 0,
      contractAddress: delegate,
      nonce: 0,
    });
    assert.equal(await recoverAuthorizationAddress({ authorization }), lostAgent.address);
    await sendAndCheck(
      await parentWallet.sendTransaction({ to: lostAgent.address, value: parseEther("0.1") }),
    );
    // A nonce-0 EOA transaction invalidates the saved pre-use authorization.
    const beforeDrift = z.string().parse(await rpc("evm_snapshot", []));
    await sendAndCheck(
      await lostWallet.sendTransaction({ to: recipient.address, value: 1n, nonce: 0 }),
    );
    await sendAndCheck(
      await relayerWallet.sendTransaction({
        type: "eip7702",
        to: lostAgent.address,
        data: "0x",
        authorizationList: [authorization],
        gas: 300_000n,
      }),
    );
    assert.equal(await client.getCode({ address: lostAgent.address }), undefined);
    assert.equal(await rpc("evm_revert", [beforeDrift]), true);

    const deployRescue = await sendAndCheck(
      await relayerWallet.sendTransaction({
        to: factory,
        data: concatHex([salt, initcode]),
        gas: 2_000_000n,
      }),
    );
    assert.equal(keccak256((await client.getCode({ address: delegate }))!), runtimeHash);

    // Execution can revert after an authorization; delegation itself is not rolled back.
    const beforeRevertedActivation = z.string().parse(await rpc("evm_snapshot", []));
    const revertedActivation = await relayerWallet.sendTransaction({
      type: "eip7702",
      to: lostAgent.address,
      data: encodeFunctionData({
        abi,
        functionName: "executeBatch",
        args: [[{ to: recipient.address, value: 1n, data: "0x" }]],
      }),
      authorizationList: [authorization],
      gas: 400_000n,
    });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: revertedActivation, timeout: 60_000 }))
        .status,
      "reverted",
    );
    assert.equal(
      (await client.getCode({ address: lostAgent.address }))?.toLowerCase(),
      pointer.toLowerCase(),
    );
    assert.equal(await client.getTransactionCount({ address: lostAgent.address }), 1);
    const partialRescue = await sendAndCheck(
      await parentWallet.sendTransaction({
        to: lostAgent.address,
        data: encodeFunctionData({
          abi,
          functionName: "executeBatch",
          args: [[{ to: recipient.address, value: 1n, data: "0x" }]],
        }),
        gas: 300_000n,
      }),
    );
    assert.equal(await client.getBalance({ address: recipient.address }), 1n);
    assert.equal(await rpc("evm_revert", [beforeRevertedActivation]), true);

    const activateRescue = await sendAndCheck(
      await relayerWallet.sendTransaction({
        type: "eip7702",
        to: lostAgent.address,
        data: "0x",
        authorizationList: [authorization],
        gas: 400_000n,
      }),
    );
    assert.equal(
      (await client.getCode({ address: lostAgent.address }))?.toLowerCase(),
      pointer.toLowerCase(),
    );
    assert.equal(
      await client.readContract({ address: lostAgent.address, abi, functionName: "parent" }),
      parent.address,
    );
    const rescue = await sendAndCheck(
      await parentWallet.sendTransaction({
        to: lostAgent.address,
        data: encodeFunctionData({
          abi,
          functionName: "executeBatch",
          args: [[{ to: recipient.address, value: parseEther("0.05"), data: "0x" }]],
        }),
        gas: 300_000n,
      }),
    );
    assert.equal(await client.getBalance({ address: recipient.address }), parseEther("0.05"));

    assert.equal(await rpc("evm_revert", [snapshot]), true);
    assert.equal(await client.getCode({ address: delegate }), undefined);
    const selfAgent = privateKeyToAccount(generatePrivateKey());
    await setBalance(selfAgent.address, parseEther("0.3"));
    const selfWallet = createWalletClient({ account: selfAgent, chain, transport: http(url) });
    const selfAuth = await selfWallet.signAuthorization({
      account: selfAgent,
      chainId: chain.id,
      contractAddress: delegate,
      nonce: 1,
    });
    assert.equal(await client.getTransactionCount({ address: selfAgent.address }), 0);
    const activateSelf = await sendAndCheck(
      await selfWallet.sendTransaction({
        type: "eip7702",
        to: factory,
        data: concatHex([salt, initcode]),
        authorizationList: [selfAuth],
        nonce: 0,
        gas: 2_000_000n,
      }),
    );
    assert.equal(await client.getTransactionCount({ address: selfAgent.address }), 2);
    assert.equal(
      (await client.getCode({ address: selfAgent.address }))?.toLowerCase(),
      pointer.toLowerCase(),
    );
    assert.equal(keccak256((await client.getCode({ address: delegate }))!), runtimeHash);
    assert.equal(
      await client.readContract({ address: selfAgent.address, abi, functionName: "parent" }),
      parent.address,
    );
    const selfBatch = await sendAndCheck(
      await selfWallet.sendTransaction({
        to: selfAgent.address,
        data: encodeFunctionData({
          abi,
          functionName: "executeBatch",
          args: [[{ to: recipient.address, value: 123n, data: "0x" }]],
        }),
        gas: 300_000n,
      }),
    );
    assert.equal(await client.getBalance({ address: recipient.address }), 123n);
    return {
      chainId: chain.id,
      upstreamBlock: upstreamBlock.toString(),
      parent: parent.address,
      factory,
      delegate,
      initcodeHash: keccak256(initcode),
      runtimeHash,
      rescue: { deployRescue, revertedActivation, partialRescue, activateRescue, rescue },
      firstUse: { activateSelf, selfBatch },
    };
  } finally {
    server.kill("SIGTERM");
  }
}

const parent = privateKeyToAccount(generatePrivateKey());
const results = [];
for (const [chain, upstream, port] of [
  [mainnet, environment.ETHEREUM_RPC_URL, 18543],
  [base, environment.BASE_RPC_URL, 18544],
] as const) {
  results.push(await runChain({ chain, upstream, port, parent }));
}
assert.equal(results[0].delegate, results[1].delegate);
assert.equal(results[0].runtimeHash, results[1].runtimeHash);
console.log(JSON.stringify({ kind: "local-fork-only", results }, null, 2));
