import {
  BlockNotFoundError,
  concatHex,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";
import { z } from "zod";
import { Hono } from "hono";
import {
  addressSchema,
  chainFor,
  chainIdSchema,
  delegateIdentity,
  delegateInitcode,
  factory,
  inspectChain,
  salt,
  hexSchema,
  publicClient,
} from "../shared/protocol";
import { rpcFor } from "./rpc";
import type { Env } from "./worker";
import { requireSession } from "./session";

const abi = parseAbi([
  "function parent() view returns (address)",
  "function executeBatch((address to, uint256 value, bytes data)[] calls)",
]);
const quoteBody = z.object({
  agent: addressSchema,
  chainId: chainIdSchema,
  recipient: addressSchema,
  amountWei: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(BigInt),
});
const activateBody = z.object({
  fundingTxHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .transform((value) => value as Hex),
});
const completeBody = z.object({
  rescueTxHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .transform((value) => value as Hex),
});
const authSchema = z.object({
  address: addressSchema,
  chainId: z.literal(0),
  nonce: z.literal(0),
  yParity: z.union([z.literal(0), z.literal(1)]),
  r: hexSchema,
  s: hexSchema,
});
type Account = { agent: Address; parent: Address; delegate: Address; authorization_json: string };
type Quote = {
  id: string;
  agent: Address;
  parent: Address;
  delegate: Address;
  chain_id: number;
  recipient: Address;
  amount_wei: string;
  funding_wei: string;
  relayer: Address;
  state: "quoted" | "activating" | "active" | "active_partial" | "failed" | "completed";
  expires_at: number;
  funding_tx_hash: Hex | null;
  deploy_tx_hash: Hex | null;
  deploy_raw: Hex | null;
  activation_tx_hash: Hex | null;
  activation_raw: Hex | null;
  rescue_tx_hash: Hex | null;
  error: string | null;
};
const now = () => Math.floor(Date.now() / 1000);
// Some EVM chains charge data/rollup fees outside the EIP-1559 gas limit.
const extraFeeReserveWei = 100_000_000_000n;
const rescueIdSchema = z.string().regex(/^rs_[a-f0-9]{32}$/);
const rescueErrors = {
  FACTORY_DEPLOYMENT_REVERTED: { message: "Delegate deployment reverted", terminal: true },
  AUTHORIZATION_NOT_INSTALLED: {
    message: "Authorization did not install the expected pointer",
    terminal: true,
  },
  AGENT_STATE_CHANGED: { message: "Agent nonce or delegation changed", terminal: true },
  RUNTIME_MISMATCH: { message: "Delegate runtime mismatch", terminal: true },
  PARENT_MISMATCH: { message: "Delegated parent mismatch", terminal: true },
  AUTHORIZATION_INVALID: { message: "Stored rescue authorization is invalid", terminal: true },
  ASSOCIATION_CHANGED: { message: "Agent association changed", terminal: true },
  RELAYER_UNDERFUNDED: {
    message: "Relayer needs more gas for this chain's total fees; add gas and retry",
    terminal: false,
  },
  RELAYER_FEE_CAP_UNFUNDED: {
    message: "Relayer balance is insufficient at current fees",
    terminal: false,
  },
  RELAYER_BROADCAST_REJECTED: {
    message: "Relayer broadcast was rejected; inspect chain state before retrying",
    terminal: false,
  },
  RELAYER_STEP_FAILED: {
    message: "Relayer step failed; inspect chain state and retry",
    terminal: false,
  },
  QUOTE_EXPIRED: { message: "Quote expired", terminal: true },
} as const;
type RescueErrorCode = keyof typeof rescueErrors;

function fail({ code }: { code: RescueErrorCode }): never {
  throw Object.assign(new Error(rescueErrors[code].message), { rescueCode: code });
}

function codeOf({ cause }: { cause: unknown }): RescueErrorCode {
  if (
    cause instanceof Error &&
    "rescueCode" in cause &&
    typeof cause.rescueCode === "string" &&
    Object.hasOwn(rescueErrors, cause.rescueCode)
  )
    return cause.rescueCode as RescueErrorCode;
  return "RELAYER_STEP_FAILED";
}

function relayerConfig({ env, chainId }: { env: Env; chainId: number }) {
  const url = rpcFor({ env, chainId });
  const key = env.RELAYER_PRIVATE_KEY;
  if (!key || !["fork", "production"].includes(env.RESCUE_MODE ?? ""))
    throw new Error("Rescue relayer is not configured");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname);
  if (env.RESCUE_MODE === "fork" ? !loopback : loopback || !url.startsWith("https://"))
    throw new Error("Rescue RPC does not match the configured mode");
  const account = privateKeyToAccount(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .parse(key) as Hex,
  );
  const chain = chainFor({ chainId });
  return {
    client: publicClient({ chainId, rpcUrlOverride: url }),
    wallet: createWalletClient({ account, chain, transport: http(url) }),
    account,
    url,
  };
}

async function loadQuote({ env, id }: { env: Env; id: string }) {
  const quote = await env.DB.prepare("SELECT * FROM rescues WHERE id = ?").bind(id).first<Quote>();
  if (!quote) throw new Error("Rescue quote not found");
  return quote;
}

function publicQuote({ quote }: { quote: Quote }) {
  const errorCode =
    quote.error && Object.hasOwn(rescueErrors, quote.error)
      ? (quote.error as RescueErrorCode)
      : quote.error
        ? "RELAYER_STEP_FAILED"
        : null;
  return {
    id: quote.id,
    agent: quote.agent,
    parent: quote.parent,
    delegate: quote.delegate,
    chainId: quote.chain_id,
    recipient: quote.recipient,
    amountWei: quote.amount_wei,
    fundingWei: quote.funding_wei,
    relayer: quote.relayer,
    state: quote.state,
    expiresAt: quote.expires_at,
    fundingTxHash: quote.funding_tx_hash,
    deployTxHash: quote.deploy_tx_hash,
    activationTxHash: quote.activation_tx_hash,
    nonRefundable: true,
    rescueTxHash: quote.rescue_tx_hash,
    errorCode,
    error: errorCode ? rescueErrors[errorCode].message : null,
  };
}

async function verifyFunding({
  client,
  quote,
  hash,
}: {
  client: ReturnType<typeof publicClient>;
  quote: Quote;
  hash: Hex;
}) {
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }),
    client.getTransactionReceipt({ hash }),
  ]);
  if (
    receipt.status !== "success" ||
    !tx.to ||
    !isAddressEqual(tx.to, quote.relayer) ||
    !isAddressEqual(tx.from, quote.parent) ||
    tx.value !== BigInt(quote.funding_wei) ||
    tx.input !== "0x"
  )
    throw new Error(
      "Funding must be a confirmed direct payment from the parent for the exact quote",
    );
  if (
    !(await confirmed({
      client,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      count: 2,
    }))
  )
    throw new Error("Funding needs two canonical block confirmations");
}

async function confirmed({
  client,
  blockNumber,
  blockHash,
  count,
}: {
  client: ReturnType<typeof publicClient>;
  blockNumber: bigint;
  blockHash: Hex;
  count: number;
}) {
  const block = await client.getBlock({ blockNumber }).catch((error: unknown) => {
    if (error instanceof BlockNotFoundError) return null;
    throw error;
  });
  if (!block) return false; // An RPC replica can lag behind the one that returned the receipt.
  if (block.hash !== blockHash) throw new Error("Transaction receipt is no longer canonical");
  return (await client.getBlockNumber()) >= blockNumber + BigInt(count - 1);
}

async function receiptFor({
  client,
  hash,
  mode,
}: {
  client: ReturnType<typeof publicClient>;
  hash: Hex;
  mode?: string;
}) {
  const receipt = await client.getTransactionReceipt({ hash }).catch((error: unknown) => {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  });
  if (!receipt) return null;
  if (
    !(await confirmed({
      client,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      count: mode === "production" ? 2 : 1,
    }))
  )
    return null;
  return receipt;
}

async function sendPersisted({
  env,
  quote,
  kind,
  to,
  data,
  authorizationList,
}: {
  env: Env;
  quote: Quote;
  kind: "deploy" | "activation";
  to: Address;
  data: Hex;
  authorizationList?: z.infer<typeof authSchema>[];
}) {
  const { client, account, wallet } = relayerConfig({ env, chainId: quote.chain_id });
  const rawColumn = kind === "deploy" ? "deploy_raw" : "activation_raw";
  const hashColumn = kind === "deploy" ? "deploy_tx_hash" : "activation_tx_hash";
  let raw = kind === "deploy" ? quote.deploy_raw : quote.activation_raw;
  let hash = kind === "deploy" ? quote.deploy_tx_hash : quote.activation_tx_hash;
  if (!raw) {
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined)
      fail({ code: "RELAYER_STEP_FAILED" });
    const gas = kind === "deploy" ? 2_000_000n : 400_000n;
    if (
      (await client.getBalance({ address: account.address, blockTag: "pending" })) <
      gas * fees.maxFeePerGas
    )
      fail({ code: "RELAYER_FEE_CAP_UNFUNDED" });
    const nonce = await client.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    const fields = {
      chainId: quote.chain_id,
      nonce,
      to,
      data,
      value: 0n,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    raw = authorizationList
      ? await account.signTransaction({ ...fields, type: "eip7702", authorizationList })
      : await account.signTransaction({ ...fields, type: "eip1559" });
    hash = keccak256(raw);
    const stored = await env.DB.prepare(
      `UPDATE rescues SET ${rawColumn} = ?, ${hashColumn} = ? WHERE id = ? AND state = 'activating' AND ${rawColumn} IS NULL`,
    )
      .bind(raw, hash, quote.id)
      .run();
    if (stored.meta.changes !== 1) throw new Error("Rescue broadcast changed; retry");
  }
  if (!hash) throw new Error("Missing persisted transaction hash");
  if (!(await receiptFor({ client, hash, mode: env.RESCUE_MODE }))) {
    try {
      const sent = await wallet.sendRawTransaction({ serializedTransaction: raw });
      if (sent !== hash) throw new Error("RPC returned a different transaction hash");
    } catch (error) {
      // The signed bytes are durable. A later request retries this exact transaction.
      const seen = await client
        .getTransaction({ hash })
        .then(() => true)
        .catch(() => false);
      if (!seen) {
        if (error instanceof Error && error.message.includes("insufficient funds"))
          fail({ code: "RELAYER_UNDERFUNDED" });
        fail({ code: "RELAYER_BROADCAST_REJECTED" });
      }
    }
  }
  return hash;
}

async function activate({ env, quote }: { env: Env; quote: Quote }) {
  const { client } = relayerConfig({ env, chainId: quote.chain_id });
  const identity = delegateIdentity({ parent: quote.parent });
  const record = await env.DB.prepare(
    "SELECT authorization_json FROM accounts WHERE agent = ? AND parent = ? AND delegate = ?",
  )
    .bind(quote.agent.toLowerCase(), quote.parent.toLowerCase(), quote.delegate.toLowerCase())
    .first<Pick<Account, "authorization_json">>();
  if (!record) fail({ code: "ASSOCIATION_CHANGED" });
  const authorization = authSchema.parse(JSON.parse(record.authorization_json));
  if (
    !isAddressEqual(authorization.address, identity.address) ||
    !isAddressEqual(await recoverAuthorizationAddress({ authorization }), quote.agent)
  )
    fail({ code: "AUTHORIZATION_INVALID" });
  const before = await inspectChain({
    agent: quote.agent,
    parent: quote.parent,
    chainId: quote.chain_id,
    rpcUrlOverride: rpcFor({ env, chainId: quote.chain_id }),
  });
  if (before.state !== "pre-use" && !(before.state === "active" && quote.activation_tx_hash))
    fail({ code: "AGENT_STATE_CHANGED" });
  const existingCode = await client.getCode({ address: identity.address });
  if (!existingCode || existingCode === "0x") {
    const hash = await sendPersisted({
      env,
      quote,
      kind: "deploy",
      to: factory,
      data: concatHex([salt, delegateInitcode({ parent: quote.parent })]),
    });
    const receipt = await receiptFor({ client, hash, mode: env.RESCUE_MODE });
    if (!receipt) return "activating" as const;
    if (receipt.status !== "success") fail({ code: "FACTORY_DEPLOYMENT_REVERTED" });
  }
  const deployedCode = await client.getCode({ address: identity.address });
  if (!deployedCode || keccak256(deployedCode) !== identity.runtimeHash)
    fail({ code: "RUNTIME_MISMATCH" });
  const state = await inspectChain({
    agent: quote.agent,
    parent: quote.parent,
    chainId: quote.chain_id,
    rpcUrlOverride: rpcFor({ env, chainId: quote.chain_id }),
  });
  if (state.state !== "pre-use" && !(state.state === "active" && quote.activation_tx_hash))
    fail({ code: "AGENT_STATE_CHANGED" });
  const hash = await sendPersisted({
    env,
    quote,
    kind: "activation",
    to: quote.agent,
    data: "0x",
    authorizationList: [authorization],
  });
  const receipt = await receiptFor({ client, hash, mode: env.RESCUE_MODE });
  if (!receipt) return "activating" as const;
  const after = await inspectChain({
    agent: quote.agent,
    parent: quote.parent,
    chainId: quote.chain_id,
    rpcUrlOverride: rpcFor({ env, chainId: quote.chain_id }),
  });
  if (after.state !== "active") fail({ code: "AUTHORIZATION_NOT_INSTALLED" });
  const boundParent = await client.readContract({
    address: quote.agent,
    abi,
    functionName: "parent",
  });
  if (!isAddressEqual(boundParent, quote.parent)) fail({ code: "PARENT_MISMATCH" });
  return receipt.status === "success" ? ("active" as const) : ("active_partial" as const);
}

export function rescueCalldata({ recipient, amount }: { recipient: Address; amount: bigint }) {
  return encodeFunctionData({
    abi,
    functionName: "executeBatch",
    args: [[{ to: recipient, value: amount, data: "0x" }]],
  });
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const rescueApp = new Hono<{ Bindings: Env }>();

rescueApp.post("/api/rescues", async (c) => {
  const env = c.env;
  const session = await requireSession({ request: c.req.raw, env });
  const { agent, chainId, recipient, amountWei } = quoteBody.parse(await c.req.json());
  if (session.chainId !== chainId) throw new Error("Sign in on the rescue chain");
  const { client, account: relayer } = relayerConfig({ env, chainId });
  const linked = await env.DB.prepare(
    "SELECT agent, parent, delegate, authorization_json FROM accounts WHERE agent = ?",
  )
    .bind(agent.toLowerCase())
    .first<Account>();
  if (!linked) throw new Error("Agent is not linked");
  if (!isAddressEqual(linked.parent, session.parent))
    throw new Error("Agent belongs to another parent");
  const parentCode = await client.getCode({ address: linked.parent });
  if (parentCode && parentCode !== "0x")
    throw new Error("Fork rescue funding currently requires an EOA parent");
  const state = await inspectChain({
    agent,
    parent: linked.parent,
    chainId,
    rpcUrlOverride: rpcFor({ env, chainId }),
  });
  if (state.state !== "pre-use") throw new Error("Pre-use rescue is unavailable on this chain");
  if ((await client.getBalance({ address: agent })) < amountWei)
    throw new Error("Agent balance is below rescue amount");
  const pending = await env.DB.prepare(
    "SELECT id FROM rescues WHERE chain_id = ? AND state IN ('quoted', 'activating') AND expires_at > ?",
  )
    .bind(chainId, now())
    .first();
  if (pending) throw new Error("Another rescue quote is pending for this relayer on this chain");
  await env.DB.prepare(
    "UPDATE rescues SET state = 'failed', error = 'QUOTE_EXPIRED' WHERE chain_id = ? AND state = 'quoted' AND expires_at <= ?",
  )
    .bind(chainId, now())
    .run();
  const fees = await client.estimateFeesPerGas();
  const identity = delegateIdentity({ parent: linked.parent });
  const code = await client.getCode({ address: identity.address });
  const gasBudget = (code && code !== "0x" ? 0n : 2_000_000n) + 400_000n;
  const funding = fees.maxFeePerGas * gasBudget + extraFeeReserveWei;
  const id = `rs_${crypto.randomUUID().replace(/-/g, "")}`;
  const expiresAt = now() + 10 * 60;
  await env.DB.prepare(
    "INSERT INTO rescues (id, agent, parent, delegate, chain_id, recipient, amount_wei, funding_wei, relayer, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)",
  )
    .bind(
      id,
      agent.toLowerCase(),
      linked.parent.toLowerCase(),
      linked.delegate.toLowerCase(),
      chainId,
      recipient.toLowerCase(),
      amountWei.toString(),
      funding.toString(),
      relayer.address.toLowerCase(),
      expiresAt,
      now(),
    )
    .run();
  return json(publicQuote({ quote: await loadQuote({ env, id }) }), 201);
});

async function sessionQuote({ request, env, id }: { request: Request; env: Env; id: string }) {
  const session = await requireSession({ request, env });
  const quote = await loadQuote({ env, id });
  if (!isAddressEqual(session.parent, quote.parent) || session.chainId !== quote.chain_id)
    throw new Error("Rescue is not associated with this parent session");
  return quote;
}

rescueApp.get("/api/rescues/:id", async (c) => {
  const quote = await sessionQuote({
    request: c.req.raw,
    env: c.env,
    id: rescueIdSchema.parse(c.req.param("id")),
  });
  relayerConfig({ env: c.env, chainId: quote.chain_id });
  return json(publicQuote({ quote }));
});

async function settleFunding({ request, env, id }: { request: Request; env: Env; id: string }) {
  const quote = await sessionQuote({ request, env, id });
  const { client } = relayerConfig({ env, chainId: quote.chain_id });
  const { fundingTxHash } = activateBody.parse(await request.json());
  if (quote.state === "quoted") {
    if (quote.expires_at <= now()) throw new Error("Rescue quote expired");
    await verifyFunding({ client, quote, hash: fundingTxHash });
    const lock = await env.DB.prepare(
      "UPDATE rescues SET state = 'activating', funding_tx_hash = ? WHERE id = ? AND state = 'quoted'",
    )
      .bind(fundingTxHash, id)
      .run();
    if (lock.meta.changes !== 1) throw new Error("Rescue already claimed");
  } else if (quote.state !== "activating" || quote.funding_tx_hash !== fundingTxHash)
    throw new Error("Rescue is already processed or funding hash changed");
  else await verifyFunding({ client, quote, hash: fundingTxHash });
  try {
    const state = await activate({ env, quote: await loadQuote({ env, id }) });
    await env.DB.prepare(
      "UPDATE rescues SET state = ?, error = NULL WHERE id = ? AND state = 'activating'",
    )
      .bind(state, id)
      .run();
  } catch (cause) {
    // Once raw bytes exist, a broadcast may have happened despite an RPC failure.
    // Leave the rescue resumable rather than incorrectly declaring the funds lost.
    const errorCode = codeOf({ cause });
    const terminal = rescueErrors[errorCode].terminal;
    await env.DB.prepare("UPDATE rescues SET state = ?, error = ? WHERE id = ?")
      .bind(terminal ? "failed" : "activating", errorCode, id)
      .run();
  }
  return json(publicQuote({ quote: await loadQuote({ env, id }) }));
}

rescueApp.post("/api/rescues/:id/activate", async (c) =>
  settleFunding({
    request: c.req.raw,
    env: c.env,
    id: rescueIdSchema.parse(c.req.param("id")),
  }),
);

rescueApp.post("/api/rescues/:id/complete", async (c) => {
  const env = c.env;
  const id = rescueIdSchema.parse(c.req.param("id"));
  const quote = await sessionQuote({ request: c.req.raw, env, id });
  const { client } = relayerConfig({ env, chainId: quote.chain_id });
  const { rescueTxHash } = completeBody.parse(await c.req.json());
  if (quote.state === "completed" && quote.rescue_tx_hash === rescueTxHash)
    return json(publicQuote({ quote }));
  if (quote.state !== "active" && quote.state !== "active_partial")
    throw new Error("Agent delegation was not verified");
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: rescueTxHash }),
    client.getTransactionReceipt({ hash: rescueTxHash }),
  ]);
  if (
    !(await confirmed({
      client,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      count: 2,
    }))
  )
    throw new Error("Rescue needs two canonical block confirmations");
  if (
    receipt.status !== "success" ||
    !tx.to ||
    !isAddressEqual(tx.to, quote.agent) ||
    !isAddressEqual(tx.from, quote.parent) ||
    tx.value !== 0n ||
    tx.input.toLowerCase() !==
      rescueCalldata({
        recipient: quote.recipient,
        amount: BigInt(quote.amount_wei),
      }).toLowerCase()
  )
    throw new Error("Rescue transaction does not match the parent-approved ETH transfer");
  const pointer = await inspectChain({
    agent: quote.agent,
    parent: quote.parent,
    chainId: quote.chain_id,
    rpcUrlOverride: rpcFor({ env, chainId: quote.chain_id }),
  });
  if (pointer.state !== "active") throw new Error("Expected delegation is no longer active");
  const updated = await env.DB.prepare(
    "UPDATE rescues SET state = 'completed', rescue_tx_hash = ? WHERE id = ? AND state IN ('active', 'active_partial')",
  )
    .bind(rescueTxHash, id)
    .run();
  if (updated.meta.changes !== 1) throw new Error("Rescue state changed");
  return json(publicQuote({ quote: await loadQuote({ env, id }) }));
});
