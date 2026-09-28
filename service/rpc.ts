import { z } from "zod";
import { chainIdSchema, publicClient, rpcUrl } from "../shared/protocol";
import type { Env } from "./worker";

export function rpcFor({ env, chainId }: { env: Env; chainId: number }) {
  chainIdSchema.parse(chainId);
  if (env.RESCUE_MODE !== "fork") return rpcUrl(chainId);
  const overrides = z.record(z.string(), z.url()).parse(JSON.parse(env.FORK_RPC_URLS ?? "{}"));
  return overrides[String(chainId)] ?? rpcUrl(chainId);
}

export function clientFor({ env, chainId }: { env: Env; chainId: number }) {
  return publicClient({ chainId, rpcUrlOverride: rpcFor({ env, chainId }) });
}
