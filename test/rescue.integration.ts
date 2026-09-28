import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, mainnet } from "viem/chains";
import { z } from "zod";
import { consentTypedData, delegateIdentity, factory, factoryHash } from "../shared/protocol";
import { rescueCalldata } from "../service/rescue";

const root = resolve(import.meta.dir, "..");
const temp = await mkdtemp(
  "/private/var/folders/sz/481762vd757_ff4593f9hyyr0000gn/T/opencode/aw-rescue-",
);
const origin = "http://127.0.0.1:8790";
const networks = [
  {
    chain: mainnet,
    url: "http://127.0.0.1:18743",
    upstream: process.env.ETHEREUM_RPC_URL ?? "https://evm.stupidtech.net/v1/1",
  },
  {
    chain: base,
    url: "http://127.0.0.1:18744",
    upstream: process.env.BASE_RPC_URL ?? "https://evm.stupidtech.net/v1/8453",
  },
] as const;
const parent = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const recipient = privateKeyToAccount(generatePrivateKey());
const relayerKey = generatePrivateKey();
const servers: ChildProcess[] = [];

async function api({
  path,
  body,
  cookie,
  status = 200,
}: {
  path: string;
  body?: unknown;
  cookie?: string;
  status?: number;
}) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = (await response.json()) as Record<string, any>;
  assert.equal(response.status, status, JSON.stringify(result));
  return { result, response };
}

async function rpc({ url, method, params }: { url: string; method: string; params: unknown[] }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const value = z
    .object({ result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() })
    .parse(await response.json());
  if (value.error || value.result === undefined)
    throw new Error(`${method}: ${value.error?.message ?? "no result"}`);
  return value.result;
}

async function waitFor({ url, chainId }: { url: string; chainId?: number }) {
  for (let i = 0; i < 100; i++) {
    try {
      if (chainId) {
        if ((await rpc({ url, method: "eth_chainId", params: [] })) === toHex(chainId)) return;
      } else if ((await fetch(`${url}/api/accounts/${agent.address}`)).ok) return;
    } catch {
      /* Server is starting. */
    }
    await delay(200);
  }
  throw new Error(`Server did not start: ${url}`);
}

async function signIn({ chainId }: { chainId: number }) {
  const { result: challenge } = await api({
    path: "/api/session/challenge",
    body: { address: parent.address, chainId },
  });
  const signature = await parent.signMessage({ message: challenge.message });
  await api({
    path: "/api/session",
    body: {
      message: challenge.message,
      signature: await agent.signMessage({ message: challenge.message }),
    },
    status: 400,
  });
  const { response } = await api({
    path: "/api/session",
    body: { message: challenge.message, signature },
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie?.startsWith("aw_session="));
  await api({ path: "/api/session", body: { message: challenge.message, signature }, status: 400 });
  return cookie;
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
    const code = await createPublicClient({
      chain: network.chain,
      transport: http(network.url),
    }).getCode({ address: factory });
    assert(code && keccak256(code) === factoryHash);
    await rpc({
      url: network.url,
      method: "anvil_setBalance",
      params: [parent.address, toHex(parseEther("1"))],
    });
  }
  await mkdir(join(temp, "migrations"));
  for (const name of [
    "0001_onboarding.sql",
    "0002_rescues.sql",
    "0003_sessions.sql",
    "0004_nonrefundable_rescues.sql",
    "0006_rescue_broadcast.sql",
    "0007_rescue_error_codes.sql",
  ])
    await writeFile(join(temp, "migrations", name), await readFile(join(root, "migrations", name)));
  const config = join(temp, "wrangler.jsonc");
  await writeFile(
    config,
    JSON.stringify({
      name: "agent-wallet-fork-test",
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
  const vars = await open(join(temp, ".dev.vars"), "wx", 0o600);
  try {
    await vars.writeFile(
      `RESCUE_MODE=fork\nFORK_RPC_URLS=${JSON.stringify(Object.fromEntries(networks.map(({ chain, url }) => [chain.id, url])))}\nRELAYER_PRIVATE_KEY=${relayerKey}\n`,
    );
  } finally {
    await vars.close();
  }
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
  const readStream = async (stream: NodeJS.ReadableStream | null) => {
    let output = "";
    if (stream) for await (const chunk of stream) output += String(chunk);
    return output;
  };
  const [migrateOutput, migrateError] = await Promise.all([
    readStream(migrate.stdout),
    readStream(migrate.stderr),
  ]);
  assert.equal(
    await new Promise<number>((resolve) =>
      migrate.exitCode !== null
        ? resolve(migrate.exitCode)
        : migrate.on("exit", (code) => resolve(code ?? 1)),
    ),
    0,
    `${migrateOutput}\n${migrateError}`,
  );
  const worker = spawn(
    "bunx",
    ["wrangler", "dev", "--config", config, "--port", "8790", "--persist-to", join(temp, "state")],
    { cwd: root, stdio: "ignore" },
  );
  servers.push(worker);
  await waitFor({ url: origin });

  const { result: loginChallenge } = await api({
    path: "/api/challenges",
    body: { agent: agent.address, purpose: "login" },
  });
  const { result: login } = await api({
    path: "/api/login",
    body: {
      agent: agent.address,
      challengeId: loginChallenge.id,
      signature: await agent.signMessage({ message: loginChallenge.message }),
    },
    status: 201,
  });
  const { result: preview } = await api({
    path: `/api/attempts/${login.id}/preview?token=${login.token}&parent=${parent.address}&chainId=1`,
  });
  const { result: approved } = await api({
    path: `/api/attempts/${login.id}/consent`,
    body: {
      token: login.token,
      parent: parent.address,
      chainId: 1,
      signature: await parent.signTypedData(consentTypedData({ ...preview.consent, chainId: 1 })),
    },
  });
  assert.equal(approved.status, "awaiting_authorization");
  const { result: finalize } = await api({
    path: "/api/challenges",
    body: { agent: agent.address, purpose: "finalize", attemptId: login.id },
  });
  const authorization = await agent.signAuthorization({
    contractAddress: preview.delegate,
    chainId: 0,
    nonce: 0,
  });
  const { result: ready } = await api({
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
  assert.equal(ready.status, "ready");
  // The agent key is not used again: both chains recover from the same saved tuple.

  for (const network of networks) {
    const chainId = network.chain.id;
    console.log(`Rescue fork ${chainId}: funding agent`);
    const client = createPublicClient({ chain: network.chain, transport: http(network.url) });
    const parentWallet = createWalletClient({
      account: parent,
      chain: network.chain,
      transport: http(network.url),
    });
    const deposit = await parentWallet.sendTransaction({
      to: agent.address,
      value: parseEther("0.1"),
    });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: deposit, timeout: 60_000 })).status,
      "success",
    );
    const cookie = await signIn({ chainId });
    await api({ path: "/api/parents/accounts", status: 400 });
    const { result: linked } = await api({ path: "/api/parents/accounts", cookie });
    assert(
      linked.accounts.some(
        (account: { agent: Address }) =>
          account.agent.toLowerCase() === agent.address.toLowerCase(),
      ),
    );
    const { result: quote } = await api({
      path: "/api/rescues",
      body: {
        agent: agent.address,
        chainId,
        recipient: recipient.address,
        amountWei: parseEther("0.05").toString(),
      },
      cookie,
      status: 201,
    });
    assert(!JSON.stringify(quote).includes(authorization.r));
    console.log(`Rescue fork ${chainId}: checking funding`);
    const wrongFunding = await parentWallet.sendTransaction({
      to: recipient.address,
      value: BigInt(quote.fundingWei),
    });
    await client.waitForTransactionReceipt({ hash: wrongFunding, timeout: 60_000 });
    await api({
      path: `/api/rescues/${quote.id}/activate`,
      body: { fundingTxHash: wrongFunding },
      cookie,
      status: 400,
    });
    const payment = await parentWallet.sendTransaction({
      to: quote.relayer,
      value: BigInt(quote.fundingWei),
    });
    await client.waitForTransactionReceipt({ hash: payment, timeout: 60_000 });
    await rpc({ url: network.url, method: "anvil_mine", params: ["0x1"] });
    console.log(`Rescue fork ${chainId}: activating`);
    const relayerBalance = await client.getBalance({ address: quote.relayer });
    await rpc({ url: network.url, method: "anvil_setBalance", params: [quote.relayer, "0x0"] });
    const { result: underfunded } = await api({
      path: `/api/rescues/${quote.id}/activate`,
      body: { fundingTxHash: payment },
      cookie,
    });
    assert.equal(underfunded.state, "activating");
    assert.equal(underfunded.errorCode, "RELAYER_FEE_CAP_UNFUNDED");
    assert(!JSON.stringify(underfunded).includes(authorization.r));
    await rpc({
      url: network.url,
      method: "anvil_setBalance",
      params: [quote.relayer, toHex(relayerBalance)],
    });
    let activated: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      ({ result: activated } = await api({
        path: `/api/rescues/${quote.id}/activate`,
        body: { fundingTxHash: payment },
        cookie,
      }));
      if (activated.state === "active") break;
      assert.equal(activated.state, "activating", JSON.stringify(activated));
      await delay(500);
    }
    assert(activated);
    assert.equal(activated.state, "active", JSON.stringify(activated));
    assert.equal(activated.errorCode, null);
    assert.equal(activated.nonRefundable, true);
    const identity = delegateIdentity({ parent: parent.address });
    assert.equal(
      (await client.getCode({ address: agent.address }))?.toLowerCase(),
      identity.pointer.toLowerCase(),
    );
    assert.equal(
      keccak256((await client.getCode({ address: identity.address }))!),
      identity.runtimeHash,
    );
    const before = await client.getBalance({ address: recipient.address });
    const rescueHash = await parentWallet.sendTransaction({
      to: agent.address,
      data: rescueCalldata({ recipient: recipient.address, amount: parseEther("0.05") }),
      gas: 300_000n,
    });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: rescueHash, timeout: 60_000 })).status,
      "success",
    );
    await rpc({ url: network.url, method: "anvil_mine", params: ["0x1"] });
    const { result: completed } = await api({
      path: `/api/rescues/${quote.id}/complete`,
      body: { rescueTxHash: rescueHash },
      cookie,
    });
    assert.equal(completed.state, "completed");
    assert.equal(
      await client.getBalance({ address: recipient.address }),
      before + parseEther("0.05"),
    );
    console.log(
      JSON.stringify({
        chainId,
        funding: payment,
        deploy: activated.deployTxHash,
        activation: activated.activationTxHash,
        rescue: rescueHash,
        kind: "local-fork-only",
      }),
    );
  }
} finally {
  for (const server of servers.reverse()) server.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
