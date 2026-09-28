import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { z } from "zod";
import { addressSchema, hexSchema } from "./protocol";

export const batchAbi = parseAbi([
  "function parent() view returns (address)",
  "function executeBatch((address to, uint256 value, bytes data)[] calls)",
]);
export const callSchema = z.object({
  to: addressSchema,
  data: hexSchema.default("0x"),
  value: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .default("0"),
});
export const callsSchema = z.array(callSchema).min(1).max(64);
export type Call = z.output<typeof callSchema>;

export function batchData({ calls }: { calls: Call[] }) {
  return encodeFunctionData({
    abi: batchAbi,
    functionName: "executeBatch",
    args: [calls.map(({ to, data, value }) => ({ to, data, value: BigInt(value) }))],
  });
}

export function operationMessage({
  origin,
  id,
  agent,
  chainId,
  calls,
  challenge,
}: {
  origin: string;
  id: string;
  agent: Address;
  chainId: number;
  calls: Call[];
  challenge: Hex;
}) {
  return `Agent Wallet prepare\nOrigin: ${origin}\nID: ${id}\nAgent: ${agent.toLowerCase()}\nChain: ${chainId}\nCalls: ${JSON.stringify(calls)}\nChallenge: ${challenge}`;
}

export const preparationSchema = z.object({
  phase: z.enum(["activation", "batch"]),
  transaction: z.object({
    type: z.enum(["eip7702", "eip1559"]),
    chainId: z.number().int(),
    nonce: z.number().int().nonnegative(),
    to: addressSchema,
    data: hexSchema,
    value: z.string().regex(/^[0-9]+$/),
    gas: z.string().regex(/^[0-9]+$/),
    maxFeePerGas: z.string().regex(/^[0-9]+$/),
    maxPriorityFeePerGas: z.string().regex(/^[0-9]+$/),
  }),
  authorization: z
    .object({ address: addressSchema, chainId: z.number().int(), nonce: z.number().int() })
    .optional(),
});
