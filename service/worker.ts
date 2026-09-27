import { isAddressEqual, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { z } from "zod";
import {
  addressSchema,
  agentMessage,
  chains,
  consentTypedData,
  delegateIdentity,
  hexSchema,
  inspectChain,
  publicClient,
  signatureSchema,
} from "../shared/protocol";

type Env = { DB: D1Database; ASSETS: Fetcher };
type Challenge = {
  id: string;
  agent: Address;
  purpose: "login" | "finalize";
  attempt_id: string | null;
  value: Hex;
  expires_at: number;
};
type Attempt = {
  id: string;
  agent: Address;
  token_hash: Hex;
  challenge: Hex;
  status: "pending" | "awaiting_authorization" | "ready";
  parent: Address | null;
  delegate: Address | null;
  consent_chain_id: number | null;
  consent_signature: Hex | null;
  authorization_json: string | null;
  expires_at: number;
  created_at: number;
};
type Account = { agent: Address; parent: Address; delegate: Address; created_at: number };
const now = () => Math.floor(Date.now() / 1000);
const challengeLifetime = 5 * 60;
const attemptLifetime = 30 * 60;
const challengeBody = z.object({
  agent: addressSchema,
  purpose: z.enum(["login", "finalize"]),
  attemptId: z
    .string()
    .regex(/^aw_[a-f0-9]{32}$/)
    .optional(),
});
const loginBody = z.object({
  agent: addressSchema,
  challengeId: z.string().regex(/^[a-f0-9]{32}$/),
  signature: signatureSchema,
});
const consentBody = z.object({
  token: hexSchema,
  parent: addressSchema,
  chainId: z.union([z.literal(1), z.literal(8453)]),
  signature: signatureSchema,
});
const authorizationBody = z.object({
  agent: addressSchema,
  challengeId: z.string().regex(/^[a-f0-9]{32}$/),
  signature: signatureSchema,
  authorization: z.object({
    address: addressSchema,
    chainId: z.literal(0),
    nonce: z.literal(0),
    yParity: z.union([z.literal(0), z.literal(1)]),
    r: hexSchema,
    s: hexSchema,
  }),
});

function randomHex({ bytes }: { bytes: number }) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return `0x${Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function json({ body, status = 200 }: { body: unknown; status?: number }) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function originOf({ request }: { request: Request }) {
  return new URL(request.url).origin;
}

async function parseBody<T extends z.ZodType>({
  request,
  schema,
}: {
  request: Request;
  schema: T;
}): Promise<z.output<T>> {
  return schema.parse(await request.json());
}

async function getChallenge({
  env,
  id,
  purpose,
  agent,
  attemptId,
}: {
  env: Env;
  id: string;
  purpose: Challenge["purpose"];
  agent: Address;
  attemptId?: string;
}) {
  const row = await env.DB.prepare("SELECT * FROM challenges WHERE id = ? AND expires_at > ?")
    .bind(id, now())
    .first<Challenge>();
  if (
    !row ||
    row.purpose !== purpose ||
    !isAddressEqual(row.agent, agent) ||
    (row.attempt_id ?? undefined) !== attemptId
  )
    throw new Error("Invalid or expired challenge");
  return row;
}

async function getAttempt({ env, id }: { env: Env; id: string }) {
  const row = await env.DB.prepare("SELECT * FROM attempts WHERE id = ?").bind(id).first<Attempt>();
  if (!row) throw new Error("Attempt not found");
  return row;
}

function checkToken({ row, token }: { row: Attempt; token: string }) {
  if (keccak256(token as Hex) !== row.token_hash) throw new Error("Invalid approval link");
}

async function chainStates({ agent, parent }: { agent: Address; parent: Address }) {
  return Promise.all(
    chains.map(async ({ id }) => {
      try {
        return await inspectChain({ agent, parent, chainId: id });
      } catch (error) {
        return {
          chainId: id,
          state: "unavailable" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

async function attemptResponse({ row }: { row: Attempt }) {
  return {
    id: row.id,
    agent: row.agent,
    status: row.expires_at <= now() && row.status !== "ready" ? "expired" : row.status,
    parent: row.parent,
    delegate: row.delegate,
    expiresAt: row.expires_at,
    ...(row.parent ? { chains: await chainStates({ agent: row.agent, parent: row.parent }) } : {}),
  };
}

async function route({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/challenges") {
    const { agent, purpose, attemptId } = await parseBody({ request, schema: challengeBody });
    if (purpose === "finalize") {
      if (!attemptId) throw new Error("Missing attempt ID");
      const attempt = await getAttempt({ env, id: attemptId });
      if (
        !isAddressEqual(attempt.agent, agent) ||
        attempt.status !== "awaiting_authorization" ||
        attempt.expires_at <= now()
      )
        throw new Error("Attempt is not awaiting authorization");
    } else if (attemptId) throw new Error("Login challenge cannot name an attempt");
    const id = randomHex({ bytes: 16 }).slice(2);
    const value = randomHex({ bytes: 32 });
    await env.DB.prepare(
      "INSERT INTO challenges (id, agent, purpose, attempt_id, value, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, agent.toLowerCase(), purpose, attemptId ?? null, value, now() + challengeLifetime)
      .run();
    return json({
      body: {
        id,
        value,
        message: agentMessage({
          origin: originOf({ request }),
          purpose,
          id: attemptId ?? id,
          challenge: value,
        }),
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    const { agent, challengeId, signature } = await parseBody({ request, schema: loginBody });
    const challenge = await getChallenge({ env, id: challengeId, purpose: "login", agent });
    const signer = await recoverMessageAddress({
      message: agentMessage({
        origin: originOf({ request }),
        purpose: "login",
        id: challengeId,
        challenge: challenge.value,
      }),
      signature,
    });
    if (!isAddressEqual(signer, agent)) throw new Error("Invalid agent signature");
    const id = `aw_${challengeId}`;
    const linked = await env.DB.prepare("SELECT agent FROM accounts WHERE agent = ?")
      .bind(agent.toLowerCase())
      .first();
    if (linked) throw new Error("Agent already linked");
    const token = keccak256(signature);
    const existing = await env.DB.prepare(
      "SELECT id, token_hash, expires_at FROM attempts WHERE id = ?",
    )
      .bind(id)
      .first<Pick<Attempt, "id" | "token_hash" | "expires_at">>();
    if (existing && (existing.token_hash !== keccak256(token) || existing.expires_at <= now()))
      throw new Error("Attempt expired or mismatched");
    if (!existing)
      await env.DB.prepare(
        "INSERT INTO attempts (id, agent, token_hash, challenge, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      )
        .bind(
          id,
          agent.toLowerCase(),
          keccak256(token),
          challenge.value,
          now() + attemptLifetime,
          now(),
        )
        .run();
    return json({
      body: {
        id,
        url: `${originOf({ request })}/approve/${id}?token=${token}`,
        token,
        expiresAt: existing?.expires_at ?? now() + attemptLifetime,
      },
      status: 201,
    });
  }

  const accountMatch = url.pathname.match(/^\/api\/accounts\/(0x[a-fA-F0-9]{40})$/);
  if (request.method === "GET" && accountMatch) {
    const agent = addressSchema.parse(accountMatch[1]);
    const account = await env.DB.prepare(
      "SELECT agent, parent, delegate, created_at FROM accounts WHERE agent = ?",
    )
      .bind(agent.toLowerCase())
      .first<Account>();
    if (!account) return json({ body: { status: "unlinked", agent } });
    return json({
      body: {
        status: "ready",
        agent,
        parent: account.parent,
        delegate: account.delegate,
        chains: await chainStates({ agent, parent: account.parent }),
      },
    });
  }

  const match = url.pathname.match(
    /^\/api\/attempts\/(aw_[a-f0-9]{32})(?:\/(preview|consent|authorization))?$/,
  );
  if (!match) return json({ body: { error: "Not found" }, status: 404 });
  const [, id, action] = match;
  const row = await getAttempt({ env, id });
  if (request.method === "GET" && !action) {
    checkToken({ row, token: url.searchParams.get("token") ?? "" });
    return json({ body: await attemptResponse({ row }) });
  }
  if (row.expires_at <= now() && row.status !== "ready") throw new Error("Attempt expired");
  if (request.method === "GET" && action === "preview") {
    checkToken({ row, token: url.searchParams.get("token") ?? "" });
    if (row.status !== "pending") throw new Error("Consent already submitted");
    const parent = addressSchema.parse(url.searchParams.get("parent"));
    if (isAddressEqual(parent, row.agent)) throw new Error("Parent must differ from agent");
    const identity = delegateIdentity({ parent });
    return json({
      body: {
        delegate: identity.address,
        initcodeHash: identity.initcodeHash,
        runtimeHash: identity.runtimeHash,
        chains: await chainStates({ agent: row.agent, parent }),
        consent: {
          origin: originOf({ request }),
          id,
          challenge: row.challenge,
          agent: row.agent,
          parent,
          delegate: identity.address,
          expiresAt: row.expires_at,
        },
      },
    });
  }
  if (request.method === "POST" && action === "consent") {
    const { token, parent, chainId, signature } = await parseBody({ request, schema: consentBody });
    checkToken({ row, token });
    if (isAddressEqual(parent, row.agent)) throw new Error("Parent must differ from agent");
    const identity = delegateIdentity({ parent });
    if (row.status !== "pending") {
      if (
        row.parent &&
        isAddressEqual(row.parent, parent) &&
        row.consent_signature === signature &&
        row.consent_chain_id === chainId
      )
        return json({ body: await attemptResponse({ row }) });
      throw new Error("Consent already recorded");
    }
    const account = await env.DB.prepare("SELECT parent FROM accounts WHERE agent = ?")
      .bind(row.agent)
      .first<{ parent: Address }>();
    if (account && !isAddressEqual(account.parent, parent))
      throw new Error("Agent already linked to another parent");
    const states = await chainStates({ agent: row.agent, parent });
    if (states.find(({ chainId: id }) => id === chainId)?.state === "unavailable")
      throw new Error("Consent chain prerequisites unavailable");
    const valid = await publicClient({ chainId }).verifyTypedData({
      address: parent,
      ...consentTypedData({
        origin: originOf({ request }),
        id,
        challenge: row.challenge,
        agent: row.agent,
        parent,
        delegate: identity.address,
        chainId,
        expiresAt: row.expires_at,
      }),
      signature,
    });
    if (!valid) throw new Error("Invalid parent consent");
    const updated = await env.DB.prepare(
      "UPDATE attempts SET status = 'awaiting_authorization', parent = ?, delegate = ?, consent_chain_id = ?, consent_signature = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
    )
      .bind(parent.toLowerCase(), identity.address.toLowerCase(), chainId, signature, id, now())
      .run();
    if (updated.meta.changes !== 1) throw new Error("Attempt changed; retry");
    return json({ body: await attemptResponse({ row: await getAttempt({ env, id }) }) });
  }
  if (request.method === "POST" && action === "authorization") {
    const { agent, challengeId, signature, authorization } = await parseBody({
      request,
      schema: authorizationBody,
    });
    if (
      !isAddressEqual(agent, row.agent) ||
      !row.parent ||
      !row.delegate ||
      (row.status !== "awaiting_authorization" && row.status !== "ready")
    )
      throw new Error("Attempt is not awaiting authorization");
    const challenge = await getChallenge({
      env,
      id: challengeId,
      purpose: "finalize",
      agent,
      attemptId: id,
    });
    const signer = await recoverMessageAddress({
      message: agentMessage({
        origin: originOf({ request }),
        purpose: "finalize",
        id,
        challenge: challenge.value,
      }),
      signature,
    });
    if (!isAddressEqual(signer, agent)) throw new Error("Invalid agent signature");
    if (
      !isAddressEqual(authorization.address, row.delegate) ||
      !isAddressEqual(authorization.address, delegateIdentity({ parent: row.parent }).address)
    )
      throw new Error("Wrong delegate");
    const recovered = await recoverAuthorizationAddress({ authorization });
    if (!isAddressEqual(recovered, agent)) throw new Error("Invalid authorization signer");
    if (row.status === "ready") {
      if (row.authorization_json !== JSON.stringify(authorization))
        throw new Error("Authorization already recorded");
      return json({ body: await attemptResponse({ row }) });
    }
    const states = await chainStates({ agent, parent: row.parent });
    if (!states.some(({ state }) => state === "pre-use" || state === "active"))
      throw new Error("No eligible chain for stored authorization");
    const consentValid = await publicClient({ chainId: row.consent_chain_id! }).verifyTypedData({
      address: row.parent,
      ...consentTypedData({
        origin: originOf({ request }),
        id,
        challenge: row.challenge,
        agent,
        parent: row.parent,
        delegate: row.delegate,
        chainId: row.consent_chain_id!,
        expiresAt: row.expires_at,
      }),
      signature: row.consent_signature!,
    });
    if (!consentValid) throw new Error("Parent consent is no longer valid");
    const result = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (agent, parent, delegate, consent_chain_id, consent_signature, authorization_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        agent.toLowerCase(),
        row.parent.toLowerCase(),
        row.delegate.toLowerCase(),
        row.consent_chain_id,
        row.consent_signature,
        JSON.stringify(authorization),
        now(),
      ),
      env.DB.prepare(
        "UPDATE attempts SET status = 'ready', authorization_json = ? WHERE id = ? AND status = 'awaiting_authorization' AND expires_at > ?",
      ).bind(JSON.stringify(authorization), id, now()),
    ]);
    if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1)
      throw new Error("Account already linked or attempt changed");
    return json({ body: await attemptResponse({ row: await getAttempt({ env, id }) }) });
  }
  return json({ body: { error: "Not found" }, status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route({ request, env });
    } catch (error) {
      if (error instanceof z.ZodError)
        return json({ body: { error: "Invalid input", issues: error.issues }, status: 400 });
      return json({
        body: { error: error instanceof Error ? error.message : "Request failed" },
        status: 400,
      });
    }
  },
};
