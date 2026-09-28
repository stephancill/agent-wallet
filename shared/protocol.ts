import {
  concatHex,
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  getContractAddress,
  http,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import artifact from "./delegate-artifact.json";

export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .transform((value) => value as Address);
export const hexSchema = z
  .string()
  .regex(/^0x([a-fA-F0-9]{2})*$/)
  .transform((value) => value as Hex);
export const signatureSchema = hexSchema.refine(
  (value) => value.length <= 8194,
  "Signature too long",
);
export const factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c" as const;
export const factoryHash = "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989";
export const salt = `0x${"00".repeat(32)}` as Hex;
export const rpcUrl = (chainId: number) => `https://evm.stupidtech.net/v1/${chainId}`;
export const chainIdSchema = z.number().int().positive().safe();
export function chainFor({ chainId }: { chainId: number }) {
  chainIdSchema.parse(chainId);
  return defineChain({
    id: chainId,
    name: `EVM ${chainId}`,
    nativeCurrency: { name: "Native asset", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl(chainId)] } },
  });
}

export function delegateInitcode({ parent }: { parent: Address }) {
  return concatHex([
    artifact.creationCode as Hex,
    encodeAbiParameters([{ type: "address" }], [parent]),
  ]);
}

export function delegateIdentity({ parent }: { parent: Address }) {
  const initcode = delegateInitcode({ parent });
  const address = getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt,
    bytecode: initcode,
  });
  let runtime = artifact.runtimeCode.slice(2);
  for (const { start, length } of artifact.parentReferences) {
    if (length !== 32) throw new Error("Invalid parent immutable reference");
    runtime = `${runtime.slice(0, start * 2)}${parent.slice(2).padStart(64, "0")}${runtime.slice((start + length) * 2)}`;
  }
  return {
    address,
    initcodeHash: keccak256(initcode),
    runtimeHash: keccak256(`0x${runtime}`),
    pointer: concatHex(["0xef0100", address]),
  };
}

export function consentTypedData({
  origin,
  id,
  challenge,
  agent,
  parent,
  delegate,
  chainId,
  expiresAt,
}: {
  origin: string;
  id: string;
  challenge: Hex;
  agent: Address;
  parent: Address;
  delegate: Address;
  chainId: number;
  expiresAt: number;
}) {
  return {
    domain: { name: "Agent Wallet", version: "1", chainId },
    types: {
      LinkAgent: [
        { name: "origin", type: "string" },
        { name: "attemptId", type: "string" },
        { name: "challenge", type: "bytes32" },
        { name: "agent", type: "address" },
        { name: "parent", type: "address" },
        { name: "delegate", type: "address" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    primaryType: "LinkAgent" as const,
    message: {
      origin,
      attemptId: id,
      challenge,
      agent,
      parent,
      delegate,
      expiresAt: BigInt(expiresAt),
    },
  };
}

export function agentMessage({
  origin,
  purpose,
  id,
  challenge,
}: {
  origin: string;
  purpose: "login" | "finalize";
  id: string;
  challenge: Hex;
}) {
  return `Agent Wallet ${purpose}\nOrigin: ${origin}\nID: ${id}\nChallenge: ${challenge}`;
}

export function publicClient({
  chainId,
  rpcUrlOverride,
}: {
  chainId: number;
  rpcUrlOverride?: string;
}) {
  return createPublicClient({
    chain: chainFor({ chainId }),
    transport: http(rpcUrlOverride ?? rpcUrl(chainId)),
  });
}

export async function inspectChain({
  agent,
  parent,
  chainId,
  rpcUrlOverride,
}: {
  agent: Address;
  parent: Address;
  chainId: number;
  rpcUrlOverride?: string;
}) {
  const client = publicClient({ chainId, rpcUrlOverride });
  const identity = delegateIdentity({ parent });
  if ((await client.getChainId()) !== chainId) throw new Error("RPC chain mismatch");
  const [factoryCode, delegateCode, agentCode, nonce] = await Promise.all([
    client.getCode({ address: factory }),
    client.getCode({ address: identity.address }),
    client.getCode({ address: agent }),
    client.getTransactionCount({ address: agent, blockTag: "pending" }),
  ]);
  if (!factoryCode || keccak256(factoryCode) !== factoryHash)
    throw new Error("CREATE2 factory missing or unexpected");
  if (delegateCode && keccak256(delegateCode) !== identity.runtimeHash)
    throw new Error("Delegate runtime mismatch");
  if (agentCode && agentCode !== "0x") {
    if (agentCode.toLowerCase() !== identity.pointer.toLowerCase())
      throw new Error("Agent delegated to unexpected code");
    if (!delegateCode) throw new Error("Delegation points to undeployed code");
    return { chainId, state: "active" as const, nonce };
  }
  if (nonce !== 0) throw new Error(`Agent nonce ${nonce} invalidates pre-use rescue`);
  if (isAddressEqual(agent, parent)) throw new Error("Parent and agent must differ");
  return { chainId, state: "pre-use" as const, nonce };
}
