#!/usr/bin/env bun
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { concatHex, isAddressEqual, keccak256, stringToHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";
import { z } from "zod";
import {
  addressSchema,
  chainIdSchema,
  delegateIdentity,
  delegateInitcode,
  factory,
  hexSchema,
  salt,
} from "../shared/protocol";
import {
  batchData,
  callsSchema,
  operationMessage,
  preparationSchema,
  type Call,
} from "../shared/operations";

const origin = z
  .url()
  .parse(process.env.AGENT_WALLET_URL ?? "https://agent-wallet.stupidtech.net")
  .replace(/\/$/, "");
const directory =
  process.env.AGENT_WALLET_HOME ?? join(homedir(), ".local", "share", "agent-wallet");
const keyPath = join(directory, "agent.key");
const pendingPath = join(directory, "pending.json");
const pendingSchema = z.object({ id: z.string(), token: hexSchema, url: z.url() });
const attemptSchema = z.object({
  id: z.string(),
  agent: addressSchema,
  parent: addressSchema.nullable(),
  delegate: addressSchema.nullable(),
  status: z.enum(["pending", "awaiting_authorization", "ready", "expired"]),
  expiresAt: z.number(),
  chains: z
    .array(z.object({ chainId: z.number(), state: z.string(), reason: z.string().optional() }))
    .optional(),
});
type Attempt = z.infer<typeof attemptSchema>;

async function api<T extends z.ZodType>({
  path,
  schema,
  body,
}: {
  path: string;
  schema: T;
  body?: unknown;
}): Promise<z.output<T>> {
  const response = await fetch(
    `${origin}${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error);
  return schema.parse(result);
}

async function loadKey({ create }: { create: boolean }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (process.getuid && dir.uid !== process.getuid()))
    throw new Error("Agent directory is not owned by this user or is a symlink");
  await chmod(directory, 0o700);
  try {
    await lstat(keyPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (!create) return null;
    const key = generatePrivateKey();
    try {
      const file = await open(keyPath, "wx", 0o600);
      try {
        await file.writeFile(key);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (writeError) {
      if (!(writeError instanceof Error && "code" in writeError && writeError.code === "EEXIST"))
        throw writeError;
    }
  }
  const stat = await lstat(keyPath);
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Agent key file is not private or is not owned by this user");
  return privateKeyToAccount(
    z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .parse((await readFile(keyPath, "utf8")).trim()) as Hex,
  );
}

async function pending() {
  try {
    const stat = await lstat(pendingPath);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("Pending approval file is not private or is not owned by this user");
    return pendingSchema.parse(JSON.parse(await readFile(pendingPath, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function savePending({ value }: { value: z.infer<typeof pendingSchema> }) {
  const temporary = join(dirname(pendingPath), `pending.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, pendingPath);
}

async function getAttempt({ value }: { value: z.infer<typeof pendingSchema> }) {
  return api({
    path: `/api/attempts/${value.id}?token=${encodeURIComponent(value.token)}`,
    schema: attemptSchema,
  });
}

function printChains({ attempt }: { attempt: Attempt }) {
  for (const chain of attempt.chains ?? [])
    console.log(
      `Chain ${chain.chainId}: ${chain.state}${chain.reason ? ` (${chain.reason})` : ""}`,
    );
}

async function status({ create, chainId }: { create: boolean; chainId?: number }) {
  const account = await loadKey({ create });
  if (!account) {
    console.log("unlinked — run `agent-wallet login`");
    return null;
  }
  console.log(`Agent: ${account.address}`);
  const linked = await api({
    path: `/api/accounts/${account.address}${chainId ? `?chainId=${chainId}` : ""}`,
    schema: z.object({
      status: z.enum(["unlinked", "ready"]),
      parent: addressSchema.optional(),
      delegate: addressSchema.optional(),
      chains: attemptSchema.shape.chains,
    }),
  });
  if (linked.status === "ready") {
    console.log(`ready — parent ${linked.parent}, delegate ${linked.delegate}`);
    for (const chain of linked.chains ?? [])
      console.log(
        `Chain ${chain.chainId}: ${chain.state}${chain.reason ? ` (${chain.reason})` : ""}`,
      );
    return { account, ready: true };
  }
  const value = await pending();
  if (!value) console.log("unlinked — run `agent-wallet login`");
  else {
    const attempt = await getAttempt({ value });
    console.log(`Login: ${attempt.status}`);
    console.log(`Approval URL: ${value.url}`);
    printChains({ attempt });
  }
  return { account, ready: false };
}

async function login() {
  const local = await status({ create: true });
  if (!local || local.ready) return;
  const { account } = local;
  let value = await pending();
  if (value && (await getAttempt({ value })).status === "expired") value = null;
  if (!value) {
    const challenge = await api({
      path: "/api/challenges",
      body: { agent: account.address, purpose: "login" },
      schema: z.object({ id: z.string(), value: hexSchema, message: z.string() }),
    });
    const signature = await account.signMessage({ message: challenge.message });
    value = await api({
      path: "/api/login",
      body: { agent: account.address, challengeId: challenge.id, signature },
      schema: pendingSchema.extend({ expiresAt: z.number() }),
    });
    await savePending({ value });
  }
  console.log(`Open this complete approval URL:\n${value.url}`);
  while (true) {
    const attempt = await getAttempt({ value });
    if (attempt.status === "expired")
      throw new Error("Login expired. Run login again; your agent key is unchanged.");
    if (attempt.status === "ready") {
      console.log("ready");
      printChains({ attempt });
      await rm(pendingPath, { force: true });
      return;
    }
    if (attempt.status === "awaiting_authorization") {
      if (!attempt.parent || !attempt.delegate) throw new Error("Incomplete approved attempt");
      const expected = delegateIdentity({ parent: attempt.parent });
      if (
        !isAddressEqual(expected.address, attempt.delegate) ||
        isAddressEqual(attempt.parent, account.address)
      )
        throw new Error("Unexpected delegate or parent");
      const authorization = await account.signAuthorization({
        contractAddress: attempt.delegate,
        chainId: 0,
        nonce: 0,
      });
      if (!isAddressEqual(await recoverAuthorizationAddress({ authorization }), account.address))
        throw new Error("Local authorization verification failed");
      const challenge = await api({
        path: "/api/challenges",
        body: { agent: account.address, purpose: "finalize", attemptId: attempt.id },
        schema: z.object({ id: z.string(), value: hexSchema, message: z.string() }),
      });
      const signature = await account.signMessage({ message: challenge.message });
      const complete = await api({
        path: `/api/attempts/${attempt.id}/authorization`,
        body: {
          agent: account.address,
          challengeId: challenge.id,
          signature,
          authorization: {
            address: authorization.address,
            chainId: authorization.chainId,
            nonce: authorization.nonce,
            r: authorization.r,
            s: authorization.s,
            yParity: authorization.yParity,
          },
        },
        schema: attemptSchema,
      });
      console.log(complete.status);
      printChains({ attempt: complete });
      await rm(pendingPath, { force: true });
      return;
    }
    await delay(3000);
  }
}

const operationSchema = z.object({
  id: z.string().regex(/^op_[a-f0-9]{32}$/),
  agent: addressSchema,
  parent: addressSchema.nullable(),
  chainId: chainIdSchema,
  callsHash: hexSchema,
  phase: z.enum(["activation", "batch"]),
  status: z.enum([
    "challenged",
    "prepared",
    "submitting",
    "broadcast",
    "awaiting_batch",
    "included",
    "reverted",
    "partial",
    "failed",
    "expired",
  ]),
  preparation: preparationSchema.nullable(),
  transactionHash: hexSchema.nullable(),
  activationTransactionHash: hexSchema.nullable(),
  error: z.string().nullable(),
});
type Operation = z.output<typeof operationSchema>;

async function readCalls({ path }: { path: string }) {
  const text = path === "-" ? await Bun.stdin.text() : await readFile(path, "utf8");
  return callsSchema.parse(JSON.parse(text));
}

const operationDirectory = join(directory, "operations");
const operationRecordSchema = z.object({
  id: z.string().regex(/^op_[a-f0-9]{32}$/),
  origin: z.url(),
  agent: addressSchema,
  chainId: chainIdSchema,
  calls: callsSchema,
  challenge: hexSchema,
});
type OperationRecord = z.output<typeof operationRecordSchema>;

async function checkOperationDirectory() {
  await mkdir(operationDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(operationDirectory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Operation directory is not owned by this user or is a symlink");
  await chmod(operationDirectory, 0o700);
}

async function saveOperation({ record }: { record: OperationRecord }) {
  await checkOperationDirectory();
  const path = join(operationDirectory, `${record.id}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

async function loadOperation({ id }: { id: string }) {
  await checkOperationDirectory();
  const path = join(operationDirectory, `${id}.json`);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(
        `No local calls for ${id}; resume requires the host that started this operation`,
      );
    throw error;
  }
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Operation file is not private or is not owned by this user");
  const record = operationRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (record.id !== id) throw new Error("Operation file ID mismatch");
  return record;
}

async function checkPreparation({
  operation,
  calls,
  account,
  maxGasCost,
}: {
  operation: Operation;
  calls: Call[];
  account: NonNullable<Awaited<ReturnType<typeof loadKey>>>;
  maxGasCost?: bigint;
}) {
  if (
    !isAddressEqual(operation.agent, account.address) ||
    !operation.parent ||
    !operation.preparation
  )
    throw new Error("Invalid operation identity or missing preparation");
  if (operation.callsHash !== keccak256(stringToHex(JSON.stringify(calls))))
    throw new Error("Operation calls differ from the local batch");
  const linked = await api({
    path: `/api/accounts/${account.address}`,
    schema: z.object({
      status: z.literal("ready"),
      parent: addressSchema,
      delegate: addressSchema,
    }),
  });
  const identity = delegateIdentity({ parent: linked.parent });
  if (
    !isAddressEqual(operation.parent, linked.parent) ||
    !isAddressEqual(identity.address, linked.delegate)
  )
    throw new Error("Operation does not match local parent-bound delegate");
  const plan = operation.preparation;
  const tx = plan.transaction;
  if (
    tx.chainId !== operation.chainId ||
    tx.value !== "0" ||
    BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)
  )
    throw new Error("Unexpected transaction chain, value or fees");
  const gasCost = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
  if (maxGasCost !== undefined && gasCost > maxGasCost)
    throw new Error(`Prepared maximum gas cost ${gasCost} wei exceeds limit ${maxGasCost} wei`);
  if (plan.phase === "activation") {
    const deployment = concatHex([salt, delegateInitcode({ parent: linked.parent })]);
    if (
      tx.type !== "eip7702" ||
      tx.nonce !== 0 ||
      !plan.authorization ||
      !isAddressEqual(plan.authorization.address, identity.address) ||
      plan.authorization.chainId !== operation.chainId ||
      plan.authorization.nonce !== 1 ||
      !(
        (isAddressEqual(tx.to, factory) && tx.data.toLowerCase() === deployment.toLowerCase()) ||
        (isAddressEqual(tx.to, account.address) && tx.data === "0x")
      )
    )
      throw new Error("Unexpected first-use authorization or deployment transaction");
  } else if (
    tx.type !== "eip1559" ||
    plan.authorization ||
    !isAddressEqual(tx.to, account.address) ||
    tx.data.toLowerCase() !== batchData({ calls }).toLowerCase()
  )
    throw new Error("Prepared batch differs from requested calls");
  return plan;
}

async function signPrepared({
  operation,
  calls,
  account,
  maxGasCost,
}: {
  operation: Operation;
  calls: Call[];
  account: NonNullable<Awaited<ReturnType<typeof loadKey>>>;
  maxGasCost?: bigint;
}) {
  const plan = await checkPreparation({ operation, calls, account, maxGasCost });
  const tx = plan.transaction;
  const fields = {
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
  };
  if (plan.phase === "activation") {
    const authorization = await account.signAuthorization({
      contractAddress: plan.authorization!.address,
      chainId: plan.authorization!.chainId,
      nonce: plan.authorization!.nonce,
    });
    return account.signTransaction({
      ...fields,
      type: "eip7702",
      authorizationList: [authorization],
    });
  }
  return account.signTransaction({ ...fields, type: "eip1559" });
}

async function sendBatch({
  resumeId,
  chainId,
  callsPath,
  maxGasCost,
}: {
  resumeId?: string;
  chainId?: number;
  callsPath?: string;
  maxGasCost?: bigint;
}) {
  const account = await loadKey({ create: false });
  if (!account) throw new Error("No local agent key. Run login first.");
  let record: OperationRecord;
  let operation: Operation;
  if (resumeId) {
    record = await loadOperation({ id: resumeId });
    operation = await api({ path: `/api/operations/${resumeId}`, schema: operationSchema });
  } else {
    if (chainId === undefined) throw new Error("Missing chain ID");
    chainId = chainIdSchema.parse(chainId);
    if (!callsPath) throw new Error("Missing calls file");
    const calls = await readCalls({ path: callsPath });
    const challenge = await api({
      path: "/api/operations/challenge",
      body: { agent: account.address, chainId, calls },
      schema: z.object({ id: z.string(), challenge: hexSchema, message: z.string() }),
    });
    if (
      challenge.message !==
      operationMessage({
        origin,
        id: challenge.id,
        agent: account.address,
        chainId,
        calls,
        challenge: challenge.challenge,
      })
    )
      throw new Error("Operation challenge differs from requested calls");
    record = {
      id: challenge.id,
      origin,
      agent: account.address,
      chainId,
      calls,
      challenge: challenge.challenge,
    };
    await saveOperation({ record });
    operation = await api({ path: `/api/operations/${challenge.id}`, schema: operationSchema });
  }
  if (
    record.origin !== origin ||
    !isAddressEqual(record.agent, account.address) ||
    !isAddressEqual(operation.agent, account.address) ||
    operation.chainId !== record.chainId ||
    operation.callsHash !== keccak256(stringToHex(JSON.stringify(record.calls)))
  )
    throw new Error("Operation does not match the locally saved request");
  console.log(`Operation: ${operation.id}`);
  for (;;) {
    if (operation.status === "challenged") {
      const message = operationMessage({
        origin,
        id: operation.id,
        agent: account.address,
        chainId: record.chainId,
        calls: record.calls,
        challenge: record.challenge,
      });
      operation = await api({
        path: `/api/operations/${operation.id}/prepare`,
        body: { signature: await account.signMessage({ message }) },
        schema: operationSchema,
      });
      continue;
    }
    if (operation.status === "prepared" || operation.status === "submitting") {
      const signedTransaction = await signPrepared({
        operation,
        calls: record.calls,
        account,
        maxGasCost,
      });
      operation = await api({
        path: `/api/operations/${operation.id}/submit`,
        body: { signedTransaction },
        schema: operationSchema,
      });
      if (operation.transactionHash)
        console.log(`${operation.phase}: ${operation.transactionHash}`);
      continue;
    }
    if (operation.status === "included") {
      console.log(`included: ${operation.transactionHash}`);
      return;
    }
    if (
      operation.status === "partial" ||
      operation.status === "reverted" ||
      operation.status === "failed" ||
      operation.status === "expired"
    )
      throw new Error(
        `Operation ${operation.status}: ${operation.error ?? operation.transactionHash ?? "check chain state"}`,
      );
    if (operation.status === "awaiting_batch" && operation.error) throw new Error(operation.error);
    await delay(2000);
    operation = await api({ path: `/api/operations/${operation.id}`, schema: operationSchema });
  }
}

const command = process.argv[2];
try {
  if (command === "status")
    await status({
      create: false,
      chainId: process.argv[3] ? chainIdSchema.parse(Number(process.argv[3])) : undefined,
    });
  else if (command === "login") await login();
  else if (command === "send")
    await sendBatch({
      chainId: Number(process.argv[3]),
      callsPath: z.string().min(1).parse(process.argv[4]),
      maxGasCost: process.argv[5]
        ? BigInt(
            z
              .string()
              .regex(/^[0-9]+$/)
              .parse(process.argv[5]),
          )
        : undefined,
    });
  else if (command === "resume")
    await sendBatch({
      resumeId: z
        .string()
        .regex(/^op_[a-f0-9]{32}$/)
        .parse(process.argv[3]),
      maxGasCost: process.argv[4]
        ? BigInt(
            z
              .string()
              .regex(/^[0-9]+$/)
              .parse(process.argv[4]),
          )
        : undefined,
    });
  else
    throw new Error(
      "Usage: agent-wallet <status [chain-id]|login|send <chain-id> <calls.json|-> [max-gas-cost-wei]|resume <operation-id> [max-gas-cost-wei]>",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
