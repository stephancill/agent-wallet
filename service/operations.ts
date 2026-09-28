import {
  concatHex,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  stringToHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { Hono } from "hono";
import { z } from "zod";
import {
  addressSchema,
  chainIdSchema,
  delegateIdentity,
  delegateInitcode,
  factory,
  inspectChain,
  salt,
  signatureSchema,
  hexSchema,
} from "../shared/protocol";
import {
  batchAbi,
  batchData,
  callsSchema,
  operationMessage,
  preparationSchema,
} from "../shared/operations";
import { clientFor, rpcFor } from "./rpc";
import type { Env } from "./worker";

type Phase = "activation" | "batch";
type Status =
  | "challenged"
  | "prepared"
  | "submitting"
  | "broadcast"
  | "awaiting_batch"
  | "included"
  | "reverted"
  | "partial"
  | "failed"
  | "expired";
type Operation = {
  id: string;
  agent: Address;
  parent: Address | null;
  chain_id: number;
  calls_json: string;
  challenge: Hex;
  status: Status;
  phase: Phase;
  preparation_json: string | null;
  signed_raw: Hex | null;
  tx_hash: Hex | null;
  activation_tx_hash: Hex | null;
  receipt_json: string | null;
  error: string | null;
  expires_at: number;
};
const now = () => Math.floor(Date.now() / 1000);
const verificationAttempts = 6;
const verificationDelayMs = 1500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const activationNoncePending = "RPC has not observed the post-activation nonce yet";
const idSchema = z.string().regex(/^op_[a-f0-9]{32}$/);
const chainSchema = chainIdSchema;
const challengeBody = z.object({ agent: addressSchema, chainId: chainSchema, calls: callsSchema });
const prepareBody = z.object({ signature: signatureSchema });
const submitBody = z.object({ signedTransaction: hexSchema });
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

function rpcOverride({ env, chainId }: { env: Env; chainId: number }) {
  return rpcFor({ env, chainId });
}

async function load({ env, id }: { env: Env; id: string }) {
  const row = await env.DB.prepare("SELECT * FROM operations WHERE id = ?")
    .bind(id)
    .first<Operation>();
  if (!row) throw new Error("Operation not found");
  return row;
}

function publicOperation({ row }: { row: Operation }) {
  return {
    id: row.id,
    agent: row.agent,
    parent: row.parent,
    chainId: row.chain_id,
    callsHash: keccak256(stringToHex(row.calls_json)),
    phase: row.phase,
    status: row.status,
    expiresAt: row.expires_at,
    preparation:
      (row.status === "prepared" || row.status === "submitting") && row.preparation_json
        ? preparationSchema.parse(JSON.parse(row.preparation_json))
        : null,
    transactionHash: row.tx_hash,
    activationTransactionHash: row.activation_tx_hash,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    error: row.error,
  };
}

// Read endpoints can briefly serve a replica that has the receipt but not the block's
// state changes. Retry before treating an included transaction as a terminal failure.
async function verifyActive({
  env,
  client,
  row,
  inactiveReason,
  parentReason,
}: {
  env: Env;
  client: ReturnType<typeof clientFor>;
  row: Operation;
  inactiveReason: string;
  parentReason: string;
}) {
  let reason: string | null = null;
  for (let attempt = 0; attempt < verificationAttempts; attempt++) {
    try {
      const state = await inspectChain({
        agent: row.agent,
        parent: row.parent!,
        chainId: row.chain_id,
        rpcUrlOverride: rpcOverride({ env, chainId: row.chain_id }),
      });
      if (state.state !== "active") throw new Error(inactiveReason);
      const bound = await client.readContract({
        address: row.agent,
        abi: batchAbi,
        functionName: "parent",
      });
      if (!isAddressEqual(bound, row.parent!)) throw new Error(parentReason);
      return { active: true, reason: null };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      if (attempt < verificationAttempts - 1) await sleep(verificationDelayMs);
    }
  }
  return { active: false, reason };
}

async function preparePhase({
  env,
  row,
  parent,
  phase,
  minimumNonce,
}: {
  env: Env;
  row: Operation;
  parent: Address;
  phase: Phase;
  minimumNonce?: number;
}) {
  const client = clientFor({ env, chainId: row.chain_id });
  const identity = delegateIdentity({ parent });
  let state: Awaited<ReturnType<typeof inspectChain>> | undefined;
  for (let attempt = 0; attempt < verificationAttempts; attempt++) {
    try {
      state = await inspectChain({
        agent: row.agent,
        parent,
        chainId: row.chain_id,
        rpcUrlOverride: rpcOverride({ env, chainId: row.chain_id }),
      });
      if (minimumNonce === undefined || state.nonce >= minimumNonce) break;
    } catch (error) {
      if (
        minimumNonce === undefined ||
        !(
          error instanceof Error &&
          /^Agent nonce \d+ invalidates pre-use rescue$/.test(error.message)
        )
      )
        throw error;
      if (attempt === verificationAttempts - 1) throw new Error(activationNoncePending);
    }
    if (attempt < verificationAttempts - 1) await sleep(verificationDelayMs);
  }
  if (!state || (minimumNonce !== undefined && state.nonce < minimumNonce))
    throw new Error(activationNoncePending);
  if (
    (phase === "activation" && state.state !== "pre-use") ||
    (phase === "batch" && state.state !== "active")
  )
    throw new Error(`Expected ${phase === "activation" ? "pre-use" : "active"} account`);
  if (phase === "batch") {
    const boundParent = await client.readContract({
      address: row.agent,
      abi: batchAbi,
      functionName: "parent",
    });
    if (!isAddressEqual(boundParent, parent)) throw new Error("Delegated parent mismatch");
  }
  const calls = callsSchema.parse(JSON.parse(row.calls_json));
  const delegateCode =
    phase === "activation" ? await client.getCode({ address: identity.address }) : null;
  const data =
    phase === "batch"
      ? batchData({ calls })
      : delegateCode && delegateCode !== "0x"
        ? ("0x" as Hex)
        : concatHex([salt, delegateInitcode({ parent })]);
  const to = phase === "batch" || data === "0x" ? row.agent : factory;
  const gas =
    phase === "activation"
      ? data === "0x"
        ? 400_000n
        : 2_000_000n
      : ((await client.estimateGas({ account: row.agent, to, data, value: 0n })) * 12n) / 10n +
        10_000n;
  const fees = await client.estimateFeesPerGas();
  if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined)
    throw new Error("EIP-1559 fees unavailable");
  const callValue = calls.reduce((total, call) => total + BigInt(call.value), 0n);
  const balance = await client.getBalance({ address: row.agent, blockTag: "pending" });
  if (balance < gas * fees.maxFeePerGas + callValue)
    throw new Error(
      `Insufficient agent gas/batch balance: need at least ${gas * fees.maxFeePerGas + callValue} wei`,
    );
  return preparationSchema.parse({
    phase,
    transaction: {
      type: phase === "activation" ? "eip7702" : "eip1559",
      chainId: row.chain_id,
      nonce: state.nonce,
      to,
      data,
      value: "0",
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    },
    ...(phase === "activation"
      ? { authorization: { address: identity.address, chainId: row.chain_id, nonce: 1 } }
      : {}),
  });
}

async function refresh({ env, row }: { env: Env; row: Operation }) {
  if (row.status === "prepared" && row.expires_at <= now()) {
    await env.DB.prepare(
      "UPDATE operations SET status = 'expired' WHERE id = ? AND status = 'prepared'",
    )
      .bind(row.id)
      .run();
    return load({ env, id: row.id });
  }
  if ((row.status === "broadcast" || row.status === "submitting") && row.tx_hash) {
    const client = clientFor({ env, chainId: row.chain_id });
    let receipt = await client
      .getTransactionReceipt({ hash: row.tx_hash })
      .catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
    // A lagging replica can return a receipt with a zero block hash; re-read until it catches up.
    for (let attempt = 0; receipt && /^0x0+$/.test(receipt.blockHash) && attempt < 3; attempt++) {
      await sleep(verificationDelayMs);
      receipt = await client.getTransactionReceipt({ hash: row.tx_hash });
    }
    if (receipt) {
      const summary = JSON.stringify({
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(),
      });
      if (row.phase === "batch") {
        const { reason } =
          receipt.status === "success"
            ? await verifyActive({
                env,
                client,
                row,
                inactiveReason: "Delegation changed after batch inclusion",
                parentReason: "Delegated parent changed",
              })
            : { reason: null };
        await env.DB.prepare(
          "UPDATE operations SET status = ?, receipt_json = ?, error = ? WHERE id = ? AND status IN ('submitting', 'broadcast')",
        )
          .bind(
            reason ? "failed" : receipt.status === "success" ? "included" : "reverted",
            summary,
            reason,
            row.id,
          )
          .run();
      } else {
        const { active, reason } =
          receipt.status === "success"
            ? await verifyActive({
                env,
                client,
                row,
                inactiveReason: "Delegation not active",
                parentReason: "Delegated parent mismatch",
              })
            : { active: false, reason: null };
        const next = receipt.status === "success" && active ? "awaiting_batch" : "partial";
        await env.DB.prepare(
          "UPDATE operations SET status = ?, activation_tx_hash = tx_hash, receipt_json = ?, error = ?, signed_raw = NULL, tx_hash = NULL WHERE id = ? AND status IN ('submitting', 'broadcast')",
        )
          .bind(
            next,
            summary,
            reason ??
              (receipt.status === "reverted"
                ? "Activation execution reverted; inspect delegation before retrying"
                : null),
            row.id,
          )
          .run();
      }
      row = await load({ env, id: row.id });
    }
  }
  if (row.status === "awaiting_batch") {
    try {
      // A type-4 self-activation consumes outer nonce 0 and authorization nonce 1.
      // Replicas may expose the new pointer before exposing the resulting nonce 2.
      const preparation = await preparePhase({
        env,
        row,
        parent: row.parent!,
        phase: "batch",
        minimumNonce: row.activation_tx_hash ? 2 : undefined,
      });
      await env.DB.prepare(
        "UPDATE operations SET status = 'prepared', phase = 'batch', preparation_json = ?, expires_at = ?, receipt_json = NULL, error = NULL WHERE id = ? AND status = 'awaiting_batch'",
      )
        .bind(JSON.stringify(preparation), now() + 300, row.id)
        .run();
      row = await load({ env, id: row.id });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === activationNoncePending)
        return { ...row, error: `Wait for the RPC to catch up, then resume ${row.id}` };
      if (reason.startsWith("Insufficient agent gas/batch balance"))
        return { ...row, error: `Fund the agent and resume ${row.id}: ${reason}` };
      await env.DB.prepare(
        "UPDATE operations SET status = 'failed', error = ? WHERE id = ? AND status = 'awaiting_batch'",
      )
        .bind(`Batch preparation failed after activation: ${reason}`, row.id)
        .run();
      return load({ env, id: row.id });
    }
  }
  return row;
}

export const operationsApp = new Hono<{ Bindings: Env }>();

operationsApp.post("/api/operations/challenge", async (c) => {
  const { agent, chainId, calls } = challengeBody.parse(await c.req.json());
  const id = `op_${crypto.randomUUID().replace(/-/g, "")}`;
  const challenge =
    `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
  const expiresAt = now() + 300;
  await c.env.DB.prepare(
    "INSERT INTO operations (id, agent, chain_id, calls_json, challenge, status, phase, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'challenged', 'batch', ?, ?)",
  )
    .bind(id, agent.toLowerCase(), chainId, JSON.stringify(calls), challenge, expiresAt, now())
    .run();
  return json(
    {
      id,
      challenge,
      message: operationMessage({
        origin: new URL(c.req.url).origin,
        id,
        agent,
        chainId,
        calls,
        challenge,
      }),
      expiresAt,
    },
    201,
  );
});

operationsApp.post("/api/operations/:id/prepare", async (c) => {
  const row = await load({ env: c.env, id: idSchema.parse(c.req.param("id")) });
  const { signature } = prepareBody.parse(await c.req.json());
  if (row.expires_at <= now()) throw new Error("Operation challenge/preparation expired");
  const signer = await recoverMessageAddress({
    message: operationMessage({
      origin: new URL(c.req.url).origin,
      id: row.id,
      agent: row.agent,
      chainId: row.chain_id,
      calls: callsSchema.parse(JSON.parse(row.calls_json)),
      challenge: row.challenge,
    }),
    signature,
  });
  if (!isAddressEqual(signer, row.agent)) throw new Error("Invalid agent operation signature");
  if (row.status === "prepared") return json(publicOperation({ row }));
  if (row.status !== "challenged") throw new Error("Operation is already being processed");
  const account = await c.env.DB.prepare("SELECT parent, delegate FROM accounts WHERE agent = ?")
    .bind(row.agent.toLowerCase())
    .first<{ parent: Address; delegate: Address }>();
  if (
    !account ||
    !isAddressEqual(delegateIdentity({ parent: account.parent }).address, account.delegate)
  )
    throw new Error("Agent is not linked to a verified delegate");
  const state = await inspectChain({
    agent: row.agent,
    parent: account.parent,
    chainId: row.chain_id,
    rpcUrlOverride: rpcOverride({ env: c.env, chainId: row.chain_id }),
  });
  const phase = state.state === "pre-use" ? "activation" : "batch";
  const preparation = await preparePhase({ env: c.env, row, parent: account.parent, phase });
  await c.env.DB.prepare(
    "UPDATE operations SET status = 'expired' WHERE agent = ? AND chain_id = ? AND status = 'prepared' AND expires_at <= ?",
  )
    .bind(row.agent.toLowerCase(), row.chain_id, now())
    .run();
  const updated = await c.env.DB.prepare(
    "UPDATE operations SET status = 'prepared', parent = ?, phase = ?, preparation_json = ?, expires_at = ? WHERE id = ? AND status = 'challenged' AND expires_at > ?",
  )
    .bind(
      account.parent.toLowerCase(),
      phase,
      JSON.stringify(preparation),
      now() + 300,
      row.id,
      now(),
    )
    .run();
  if (updated.meta.changes !== 1) throw new Error("Operation changed; retry");
  return json(publicOperation({ row: await load({ env: c.env, id: row.id }) }));
});

operationsApp.get("/api/operations/:id", async (c) => {
  const row = await refresh({
    env: c.env,
    row: await load({ env: c.env, id: idSchema.parse(c.req.param("id")) }),
  });
  return json(publicOperation({ row }));
});

operationsApp.post("/api/operations/:id/submit", async (c) => {
  const env = c.env;
  let row = await load({ env, id: idSchema.parse(c.req.param("id")) });
  const { signedTransaction } = submitBody.parse(await c.req.json());
  const hash = keccak256(signedTransaction);
  if (
    row.activation_tx_hash === hash ||
    (["included", "reverted", "failed", "partial"].includes(row.status) && row.tx_hash === hash)
  )
    return json(publicOperation({ row }));
  if (row.status === "submitting" || row.status === "broadcast") {
    if (row.tx_hash !== hash || row.signed_raw !== signedTransaction)
      throw new Error("Operation already has a different signed transaction");
  } else {
    if (row.status !== "prepared" || row.expires_at <= now())
      throw new Error("Preparation expired or operation already submitted");
    const prepared = preparationSchema.parse(JSON.parse(row.preparation_json!));
    const expected = prepared.transaction;
    const tx = parseTransaction(signedTransaction as TransactionSerialized);
    if (
      tx.type !== expected.type ||
      tx.chainId !== expected.chainId ||
      tx.nonce !== expected.nonce ||
      !tx.to ||
      !isAddressEqual(tx.to, expected.to) ||
      (tx.data ?? "0x").toLowerCase() !== expected.data.toLowerCase() ||
      (tx.value ?? 0n) !== BigInt(expected.value) ||
      tx.gas !== BigInt(expected.gas) ||
      tx.maxFeePerGas !== BigInt(expected.maxFeePerGas) ||
      tx.maxPriorityFeePerGas !== BigInt(expected.maxPriorityFeePerGas) ||
      (tx.accessList?.length ?? 0) !== 0
    )
      throw new Error("Signed transaction differs from preparation");
    if (
      !isAddressEqual(
        await recoverTransactionAddress({
          serializedTransaction: signedTransaction as TransactionSerialized,
        }),
        row.agent,
      )
    )
      throw new Error("Invalid transaction signer");
    if (prepared.phase === "activation") {
      if (tx.type !== "eip7702" || tx.authorizationList?.length !== 1 || !prepared.authorization)
        throw new Error("Missing activation authorization");
      const auth = tx.authorizationList[0];
      if (
        !isAddressEqual(auth.address, prepared.authorization.address) ||
        auth.chainId !== prepared.authorization.chainId ||
        auth.nonce !== prepared.authorization.nonce ||
        !isAddressEqual(await recoverAuthorizationAddress({ authorization: auth }), row.agent)
      )
        throw new Error("Invalid activation authorization");
    } else if (tx.type !== "eip1559")
      throw new Error("Batch transaction cannot carry an authorization");
    const state = await inspectChain({
      agent: row.agent,
      parent: row.parent!,
      chainId: row.chain_id,
      rpcUrlOverride: rpcOverride({ env, chainId: row.chain_id }),
    });
    if (row.phase === "batch" && state.state === "active" && state.nonce > expected.nonce) {
      // A pending transaction might be dropped, so only replace the plan when
      // its nonce has been mined. Keep the original calls and agent proof.
      const confirmedNonce = await clientFor({ env, chainId: row.chain_id }).getTransactionCount({
        address: row.agent,
        blockTag: "latest",
      });
      if (confirmedNonce <= expected.nonce)
        throw new Error("Agent nonce is pending; resume after it is confirmed");
      // Discard the unbroadcast signature for the spent nonce and offer a new plan.
      const preparation = await preparePhase({
        env,
        row,
        parent: row.parent!,
        phase: "batch",
        minimumNonce: state.nonce,
      });
      const updated = await env.DB.prepare(
        "UPDATE operations SET preparation_json = ?, expires_at = ? WHERE id = ? AND status = 'prepared' AND phase = 'batch' AND preparation_json = ? AND expires_at > ?",
      )
        .bind(JSON.stringify(preparation), now() + 300, row.id, row.preparation_json, now())
        .run();
      if (updated.meta.changes !== 1) throw new Error("Operation changed; resume it");
      return json(publicOperation({ row: await load({ env, id: row.id }) }));
    }
    if (
      state.state !== (row.phase === "activation" ? "pre-use" : "active") ||
      state.nonce !== expected.nonce
    )
      throw new Error("Chain state or nonce changed after preparation");
    const lock = await env.DB.prepare(
      "UPDATE operations SET status = 'submitting', signed_raw = ?, tx_hash = ? WHERE id = ? AND status = 'prepared' AND expires_at > ?",
    )
      .bind(signedTransaction, hash, row.id, now())
      .run();
    if (lock.meta.changes !== 1) throw new Error("Operation already submitted");
  }
  const client = clientFor({ env, chainId: row.chain_id });
  try {
    const sent = await client.sendRawTransaction({ serializedTransaction: signedTransaction });
    if (sent !== hash) throw new Error("RPC returned a different transaction hash");
    await env.DB.prepare(
      "UPDATE operations SET status = 'broadcast' WHERE id = ? AND status = 'submitting'",
    )
      .bind(row.id)
      .run();
  } catch (error) {
    // Persisted raw bytes and hash allow a retry of this exact transaction after an uncertain RPC response.
    const known = await client
      .getTransaction({ hash })
      .then(() => true)
      .catch(() => false);
    if (!known) throw error;
    await env.DB.prepare(
      "UPDATE operations SET status = 'broadcast' WHERE id = ? AND status = 'submitting'",
    )
      .bind(row.id)
      .run();
  }
  row = await refresh({ env, row: await load({ env, id: row.id }) });
  return json(publicOperation({ row }));
});
