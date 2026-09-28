import { isAddressEqual, keccak256, type Address, type Hex } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import { Hono } from "hono";
import { addressSchema, chainIdSchema, signatureSchema } from "../shared/protocol";
import { clientFor } from "./rpc";
import type { Env } from "./worker";

const requestSchema = z.object({
  address: addressSchema,
  chainId: chainIdSchema,
});
const verifySchema = z.object({ message: z.string().min(1).max(2048), signature: signatureSchema });
const now = () => Math.floor(Date.now() / 1000);
const sessionLifetime = 15 * 60;

function cookieToken({ request }: { request: Request }) {
  const match = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)aw_session=(0x[a-fA-F0-9]{64})(?:;|$)/);
  return match?.[1] as Hex | undefined;
}

export async function requireSession({ request, env }: { request: Request; env: Env }) {
  const token = cookieToken({ request });
  if (!token) throw new Error("Sign in with the parent wallet");
  const row = await env.DB.prepare(
    "SELECT parent, chain_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
  )
    .bind(keccak256(token), now())
    .first<{ parent: Address; chain_id: number }>();
  if (!row) throw new Error("Parent session expired");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new Error("Cross-origin session request");
  return { parent: row.parent, chainId: row.chain_id };
}

const json = (body: unknown, headers?: Record<string, string>) =>
  Response.json(body, { headers: { "cache-control": "no-store", ...headers } });

export const sessionApp = new Hono<{ Bindings: Env }>();

sessionApp.post("/api/session/challenge", async (c) => {
  const url = new URL(c.req.url);
  const { address, chainId } = requestSchema.parse(await c.req.json());
  const nonce = generateSiweNonce();
  const expiresAt = now() + 5 * 60;
  await c.env.DB.prepare(
    "INSERT INTO siwe_nonces (nonce, address, chain_id, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(nonce, address.toLowerCase(), chainId, expiresAt)
    .run();
  return json({
    message: createSiweMessage({
      address,
      chainId,
      domain: url.host,
      scheme: url.protocol.slice(0, -1),
      nonce,
      uri: url.origin,
      version: "1",
      issuedAt: new Date(),
      expirationTime: new Date(expiresAt * 1000),
      statement: "Sign in to view linked agents and request recovery.",
    }),
  });
});

sessionApp.post("/api/session", async (c) => {
  const url = new URL(c.req.url);
  const { message, signature } = verifySchema.parse(await c.req.json());
  const parsed = parseSiweMessage(message);
  if (
    !parsed.address ||
    !parsed.nonce ||
    !parsed.chainId ||
    parsed.domain !== url.host ||
    parsed.uri !== url.origin
  )
    throw new Error("Invalid SIWE domain, chain or URI");
  const row = await c.env.DB.prepare(
    "SELECT address, chain_id FROM siwe_nonces WHERE nonce = ? AND expires_at > ?",
  )
    .bind(parsed.nonce, now())
    .first<{ address: Address; chain_id: number }>();
  if (!row || !isAddressEqual(row.address, parsed.address) || row.chain_id !== parsed.chainId)
    throw new Error("Invalid or expired SIWE nonce");
  const valid = await clientFor({ env: c.env, chainId: row.chain_id }).verifySiweMessage({
    message,
    signature,
    address: row.address,
    domain: url.host,
    nonce: parsed.nonce,
    scheme: url.protocol.slice(0, -1),
  });
  if (!valid) throw new Error("Invalid SIWE signature");
  const claimed = await c.env.DB.prepare(
    "DELETE FROM siwe_nonces WHERE nonce = ? AND expires_at > ?",
  )
    .bind(parsed.nonce, now())
    .run();
  if (claimed.meta.changes !== 1) throw new Error("SIWE nonce already used");
  const token =
    `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, parent, chain_id, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(keccak256(token), row.address.toLowerCase(), row.chain_id, now() + sessionLifetime)
    .run();
  return json(
    { parent: row.address, chainId: row.chain_id },
    {
      "set-cookie": `aw_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${sessionLifetime}${url.protocol === "https:" ? "; Secure" : ""}`,
    },
  );
});

sessionApp.get("/api/session", async (c) =>
  json(await requireSession({ request: c.req.raw, env: c.env })),
);
sessionApp.get("/api/parents/accounts", async (c) => {
  const { parent } = await requireSession({ request: c.req.raw, env: c.env });
  const records = await c.env.DB.prepare("SELECT agent, delegate FROM accounts WHERE parent = ?")
    .bind(parent.toLowerCase())
    .all<{ agent: Address; delegate: Address }>();
  return json({ parent, accounts: records.results });
});
