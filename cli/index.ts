#!/usr/bin/env bun
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { isAddressEqual, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";
import { z } from "zod";
import { addressSchema, delegateIdentity, hexSchema } from "../shared/protocol";

const origin = z
  .url()
  .parse(process.env.AGENT_WALLET_URL ?? "http://127.0.0.1:8787")
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

async function status({ create }: { create: boolean }) {
  const account = await loadKey({ create });
  if (!account) {
    console.log("unlinked — run `agent-wallet login`");
    return null;
  }
  console.log(`Agent: ${account.address}`);
  const linked = await api({
    path: `/api/accounts/${account.address}`,
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

const command = process.argv[2];
try {
  if (command === "status") await status({ create: false });
  else if (command === "login") await login();
  else throw new Error("Usage: agent-wallet <status|login>");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
