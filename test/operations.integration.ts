import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import { z } from "zod";
import {
  chainFor,
  consentTypedData,
  delegateIdentity,
  factory,
  factoryHash,
  rpcUrl,
} from "../shared/protocol";
import { callsSchema } from "../shared/operations";

const root = resolve(import.meta.dir, "..");
const temp = await mkdtemp(
  "/private/var/folders/sz/481762vd757_ff4593f9hyyr0000gn/T/opencode/aw-operations-",
);
const origin = "http://127.0.0.1:8791";
const networks = [
  {
    chain: mainnet,
    url: "http://127.0.0.1:18753",
    upstream: process.env.ETHEREUM_RPC_URL ?? "https://evm.stupidtech.net/v1/1",
  },
  {
    chain: base,
    url: "http://127.0.0.1:18754",
    upstream: process.env.BASE_RPC_URL ?? "https://evm.stupidtech.net/v1/8453",
  },
  {
    chain: chainFor({ chainId: 10 }),
    url: "http://127.0.0.1:18755",
    upstream: rpcUrl(10),
  },
] as const;
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const parent = privateKeyToAccount(generatePrivateKey());
const recipient = privateKeyToAccount(generatePrivateKey());
const servers: ChildProcess[] = [];

async function api({
  path,
  body,
  status = 200,
}: {
  path: string;
  body?: unknown;
  status?: number;
}) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, any>;
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function rpc({ url, method, params }: { url: string; method: string; params: unknown[] }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const result = z
    .object({ result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() })
    .parse(await response.json());
  if (result.error || result.result === undefined)
    throw new Error(`${method}: ${result.error?.message ?? "no result"}`);
  return result.result;
}

async function waitFor({ url, chainId }: { url: string; chainId?: number }) {
  for (let i = 0; i < 100; i++) {
    try {
      if (
        chainId
          ? (await rpc({ url, method: "eth_chainId", params: [] })) === toHex(chainId)
          : (await fetch(`${url}/api/accounts/${agent.address}`)).ok
      )
        return;
    } catch {
      /* Starting. */
    }
    await delay(200);
  }
  throw new Error(`Server did not start: ${url}`);
}

async function outputOf(stream: NodeJS.ReadableStream | null) {
  let output = "";
  if (stream) for await (const chunk of stream) output += String(chunk);
  return output;
}

async function send({
  chainId,
  callsPath,
  resumeId,
}: {
  chainId: number;
  callsPath: string;
  resumeId?: string;
}) {
  const child = spawn(
    "bun",
    ["cli/index.ts", ...(resumeId ? ["resume", resumeId] : ["send", String(chainId), callsPath])],
    {
      cwd: root,
      env: { ...process.env, AGENT_WALLET_HOME: join(temp, "home"), AGENT_WALLET_URL: origin },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [stdout, stderr] = await Promise.all([outputOf(child.stdout), outputOf(child.stderr)]);
  const code = await new Promise<number>((resolve) =>
    child.exitCode !== null
      ? resolve(child.exitCode)
      : child.on("exit", (value) => resolve(value ?? 1)),
  );
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  const id = stdout.match(/Operation: (op_[a-f0-9]{32})/)?.[1];
  assert(id, stdout);
  return api({ path: `/api/operations/${id}` });
}

try {
  for (const network of networks) {
    const server = spawn(
      "anvil",
      [
        "--fork-url",
        network.upstream,
        "--port",
        new URL(network.url).port,
        "--hardfork",
        "prague",
        "--quiet",
      ],
      { cwd: root, stdio: "ignore" },
    );
    servers.push(server);
    await waitFor({ url: network.url, chainId: network.chain.id });
    const client = createPublicClient({ chain: network.chain, transport: http(network.url) });
    const code = await client.getCode({ address: factory });
    assert(code && keccak256(code) === factoryHash);
    await rpc({
      url: network.url,
      method: "anvil_setBalance",
      params: [agent.address, toHex(parseEther("1"))],
    });
  }
  await mkdir(join(temp, "migrations"));
  for (const name of (await readdir(join(root, "migrations"))).filter((file) =>
    file.endsWith(".sql"),
  ))
    await writeFile(join(temp, "migrations", name), await readFile(join(root, "migrations", name)));
  const config = join(temp, "wrangler.jsonc");
  await writeFile(
    config,
    JSON.stringify({
      name: "agent-wallet-operations-test",
      main: join(root, "service/worker.ts"),
      compatibility_date: "2026-09-25",
      assets: {
        binding: "ASSETS",
        directory: join(root, "dist"),
        not_found_handling: "single-page-application",
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: "agent-wallet-test",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: "migrations",
        },
      ],
    }),
  );
  await writeFile(
    join(temp, ".dev.vars"),
    `RESCUE_MODE=fork\nFORK_RPC_URLS=${JSON.stringify(Object.fromEntries(networks.map(({ chain, url }) => [chain.id, url])))}\n`,
    { mode: 0o600 },
  );
  const migrate = spawn(
    "bunx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "agent-wallet-test",
      "--local",
      "--config",
      config,
      "--persist-to",
      join(temp, "state"),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const [migrateOut, migrateErr] = await Promise.all([
    outputOf(migrate.stdout),
    outputOf(migrate.stderr),
  ]);
  const migrated = await new Promise<number>((resolve) =>
    migrate.exitCode !== null
      ? resolve(migrate.exitCode)
      : migrate.on("exit", (value) => resolve(value ?? 1)),
  );
  assert.equal(migrated, 0, `${migrateOut}\n${migrateErr}`);
  servers.push(
    spawn(
      "bunx",
      [
        "wrangler",
        "dev",
        "--config",
        config,
        "--port",
        "8791",
        "--persist-to",
        join(temp, "state"),
      ],
      { cwd: root, stdio: "ignore" },
    ),
  );
  await waitFor({ url: origin });

  const loginChallenge = await api({
    path: "/api/challenges",
    body: { agent: agent.address, purpose: "login" },
  });
  const login = await api({
    path: "/api/login",
    body: {
      agent: agent.address,
      challengeId: loginChallenge.id,
      signature: await agent.signMessage({ message: loginChallenge.message }),
    },
    status: 201,
  });
  const preview = await api({
    path: `/api/attempts/${login.id}/preview?token=${login.token}&parent=${parent.address}&chainId=1`,
  });
  await api({
    path: `/api/attempts/${login.id}/consent`,
    body: {
      token: login.token,
      parent: parent.address,
      chainId: 1,
      signature: await parent.signTypedData(consentTypedData({ ...preview.consent, chainId: 1 })),
    },
  });
  const finalize = await api({
    path: "/api/challenges",
    body: { agent: agent.address, purpose: "finalize", attemptId: login.id },
  });
  const authorization = await agent.signAuthorization({
    contractAddress: preview.delegate,
    chainId: 0,
    nonce: 0,
  });
  await api({
    path: `/api/attempts/${login.id}/authorization`,
    body: {
      agent: agent.address,
      challengeId: finalize.id,
      signature: await agent.signMessage({ message: finalize.message }),
      authorization: {
        address: authorization.address,
        chainId: 0,
        nonce: 0,
        r: authorization.r,
        s: authorization.s,
        yParity: authorization.yParity,
      },
    },
  });
  await mkdir(join(temp, "home"), { mode: 0o700 });
  const key = await open(join(temp, "home", "agent.key"), "wx", 0o600);
  try {
    await key.writeFile(agentKey);
  } finally {
    await key.close();
  }
  const callsPath = join(temp, "calls.json");
  const calls = [{ to: recipient.address, value: parseEther("0.01").toString(), data: "0x" }];
  await writeFile(callsPath, JSON.stringify(calls));

  const firstChallenge = await api({
    path: "/api/operations/challenge",
    body: { agent: agent.address, chainId: 1, calls },
    status: 201,
  });
  const first = await api({
    path: `/api/operations/${firstChallenge.id}/prepare`,
    body: { signature: await agent.signMessage({ message: firstChallenge.message }) },
  });
  assert.equal(first.phase, "activation");
  assert(!JSON.stringify(first).includes(authorization.r));
  const firstTx = first.preparation.transaction;
  const wrongAuth = await agent.signAuthorization({
    contractAddress: first.preparation.authorization.address,
    chainId: 1,
    nonce: 0,
  });
  const wrongActivation = await agent.signTransaction({
    type: "eip7702",
    chainId: 1,
    nonce: 0,
    to: firstTx.to as Address,
    data: firstTx.data as Hex,
    value: 0n,
    gas: BigInt(firstTx.gas),
    maxFeePerGas: BigInt(firstTx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(firstTx.maxPriorityFeePerGas),
    authorizationList: [wrongAuth],
  });
  await api({
    path: `/api/operations/${first.id}/submit`,
    body: { signedTransaction: wrongActivation },
    status: 400,
  });
  await mkdir(join(temp, "home", "operations"), { mode: 0o700 });
  await writeFile(
    join(temp, "home", "operations", `${first.id}.json`),
    JSON.stringify({
      id: first.id,
      origin,
      agent: agent.address,
      chainId: 1,
      calls: callsSchema.parse(calls),
      challenge: firstChallenge.challenge,
    }),
    { mode: 0o600 },
  );
  assert.equal(
    await createPublicClient({
      chain: mainnet,
      transport: http(networks[0].url),
    }).getTransactionCount({ address: agent.address }),
    0,
  );
  const correctAuth = await agent.signAuthorization({
    contractAddress: first.preparation.authorization.address,
    chainId: 1,
    nonce: 1,
  });
  const signedActivation = await agent.signTransaction({
    type: "eip7702",
    chainId: 1,
    nonce: 0,
    to: firstTx.to as Address,
    data: firstTx.data as Hex,
    value: 0n,
    gas: BigInt(firstTx.gas),
    maxFeePerGas: BigInt(firstTx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(firstTx.maxPriorityFeePerGas),
    authorizationList: [correctAuth],
  });
  // The CLI is absent after activation submission; resume must finish only the batch.
  const activationHash = keccak256(signedActivation);
  await api({
    path: `/api/operations/${first.id}/submit`,
    body: { signedTransaction: signedActivation },
  });
  const staleBatch = await api({ path: `/api/operations/${first.id}` });
  assert.equal(staleBatch.phase, "batch");
  assert.equal(staleBatch.preparation.transaction.nonce, 2);
  // Consume the prepared nonce with an independent agent transaction. The CLI
  // must resume the original calls after the service replaces the stale plan.
  const mainnetClient = createPublicClient({ chain: mainnet, transport: http(networks[0].url) });
  const fees = await mainnetClient.estimateFeesPerGas();
  const intervening = await agent.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: 2,
    to: agent.address,
    data: "0x",
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  await rpc({ url: networks[0].url, method: "anvil_setAutomine", params: [false] });
  try {
    await rpc({
      url: networks[0].url,
      method: "eth_sendRawTransaction",
      params: [intervening],
    });
    const staleTx = staleBatch.preparation.transaction;
    const staleSigned = await agent.signTransaction({
      type: "eip1559",
      chainId: 1,
      nonce: staleTx.nonce,
      to: staleTx.to as Address,
      data: staleTx.data as Hex,
      value: 0n,
      gas: BigInt(staleTx.gas),
      maxFeePerGas: BigInt(staleTx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(staleTx.maxPriorityFeePerGas),
    });
    const pending = await api({
      path: `/api/operations/${first.id}/submit`,
      body: { signedTransaction: staleSigned },
      status: 400,
    });
    assert.match(pending.error, /nonce is pending/);
  } finally {
    await rpc({ url: networks[0].url, method: "anvil_setAutomine", params: [true] });
  }
  await rpc({ url: networks[0].url, method: "evm_mine", params: [] });
  await mainnetClient.waitForTransactionReceipt({ hash: keccak256(intervening) });

  for (const network of networks) {
    const client = createPublicClient({ chain: network.chain, transport: http(network.url) });
    const before = await client.getBalance({ address: recipient.address });
    const result = await send({
      chainId: network.chain.id,
      callsPath,
      resumeId: network.chain.id === 1 ? first.id : undefined,
    });
    assert.equal(result.status, "included", JSON.stringify(result));
    assert(result.activationTransactionHash);
    if (network.chain.id === 1) assert.equal(result.activationTransactionHash, activationHash);
    assert.equal(
      await client.getBalance({ address: recipient.address }),
      before + parseEther("0.01"),
    );
    assert.equal(
      await client.getTransactionCount({ address: agent.address }),
      network.chain.id === 1 ? 4 : 3,
    );
    assert.equal(
      (await client.getCode({ address: agent.address }))?.toLowerCase(),
      delegateIdentity({ parent: parent.address }).pointer.toLowerCase(),
    );
    console.log(
      `Operation fork ${network.chain.id}: activation ${result.activationTransactionHash}, batch ${result.transactionHash}`,
    );
  }
  const active = await send({ chainId: 1, callsPath });
  assert.equal(active.status, "included");
  assert.equal(active.activationTransactionHash, null);
  const balanceAfterActive = await createPublicClient({
    chain: mainnet,
    transport: http(networks[0].url),
  }).getBalance({ address: recipient.address });
  const resumed = await send({ chainId: 1, callsPath, resumeId: active.id });
  assert.equal(resumed.transactionHash, active.transactionHash);
  assert.equal(
    await createPublicClient({ chain: mainnet, transport: http(networks[0].url) }).getBalance({
      address: recipient.address,
    }),
    balanceAfterActive,
  );

  const challenge = await api({
    path: "/api/operations/challenge",
    body: { agent: agent.address, chainId: 1, calls },
    status: 201,
  });
  await api({
    path: `/api/operations/${challenge.id}/prepare`,
    body: { signature: await parent.signMessage({ message: challenge.message }) },
    status: 400,
  });
  const prepared = await api({
    path: `/api/operations/${challenge.id}/prepare`,
    body: { signature: await agent.signMessage({ message: challenge.message }) },
  });
  const tx = prepared.preparation.transaction;
  const tampered = await agent.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: tx.nonce,
    to: parent.address,
    data: tx.data as Hex,
    value: 0n,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  });
  await api({
    path: `/api/operations/${challenge.id}/submit`,
    body: { signedTransaction: tampered },
    status: 400,
  });
  assert.equal((await api({ path: `/api/operations/${challenge.id}` })).status, "prepared");
  const signed = await agent.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: tx.nonce,
    to: tx.to as Address,
    data: tx.data as Hex,
    value: 0n,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  });
  const submitted = await api({
    path: `/api/operations/${challenge.id}/submit`,
    body: { signedTransaction: signed },
  });
  assert.equal(submitted.transactionHash, keccak256(signed));
  let completed = submitted;
  for (let i = 0; i < 30 && completed.status !== "included"; i++) {
    await delay(200);
    completed = await api({ path: `/api/operations/${challenge.id}` });
  }
  assert.equal(completed.status, "included");
  const duplicate = await api({
    path: `/api/operations/${challenge.id}/submit`,
    body: { signedTransaction: signed },
  });
  assert.equal(duplicate.transactionHash, completed.transactionHash);
  assert.equal(duplicate.status, "included");
  const revertingChallenge = await api({
    path: "/api/operations/challenge",
    body: { agent: agent.address, chainId: 1, calls },
    status: 201,
  });
  const revertingPlan = await api({
    path: `/api/operations/${revertingChallenge.id}/prepare`,
    body: { signature: await agent.signMessage({ message: revertingChallenge.message }) },
  });
  const revertTx = revertingPlan.preparation.transaction;
  const revertingSigned = await agent.signTransaction({
    type: "eip1559",
    chainId: 1,
    nonce: revertTx.nonce,
    to: revertTx.to as Address,
    data: revertTx.data as Hex,
    value: 0n,
    gas: BigInt(revertTx.gas),
    maxFeePerGas: BigInt(revertTx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(revertTx.maxPriorityFeePerGas),
  });
  const beforeRevert = await createPublicClient({
    chain: mainnet,
    transport: http(networks[0].url),
  }).getBalance({ address: recipient.address });
  await rpc({
    url: networks[0].url,
    method: "anvil_setCode",
    params: [recipient.address, "0x60006000fd"],
  });
  let reverted = await api({
    path: `/api/operations/${revertingChallenge.id}/submit`,
    body: { signedTransaction: revertingSigned },
  });
  for (let i = 0; i < 30 && reverted.status !== "reverted"; i++) {
    await delay(200);
    reverted = await api({ path: `/api/operations/${revertingChallenge.id}` });
  }
  assert.equal(reverted.status, "reverted");
  assert.equal(reverted.receipt.status, "reverted");
  assert.equal(
    await createPublicClient({ chain: mainnet, transport: http(networks[0].url) }).getBalance({
      address: recipient.address,
    }),
    beforeRevert,
  );
  console.log(
    "Operations CLI first use on Ethereum/Base/Optimism, active batch, signed-field rejection, duplicate submission and reverted batch passed",
  );
} finally {
  for (const server of servers.reverse()) server.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
