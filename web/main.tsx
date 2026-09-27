import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
  createConfig,
  http,
  useAccount,
  useConnect,
  useDisconnect,
  useSignTypedData,
  useSwitchChain,
  WagmiProvider,
} from "wagmi";
import { baseAccount, injected } from "wagmi/connectors";
import { base, mainnet } from "wagmi/chains";
import { useState } from "react";
import { isAddressEqual, type Address, type Hex } from "viem";
import { consentTypedData, rpcUrl } from "../shared/protocol";
import "./style.css";

const config = createConfig({
  chains: [mainnet, base],
  connectors: [
    injected(),
    baseAccount({ appName: "Agent Wallet", preference: { telemetry: false } }),
  ],
  transports: { [mainnet.id]: http(rpcUrl(mainnet.id)), [base.id]: http(rpcUrl(base.id)) },
});
const queryClient = new QueryClient();

type ChainState = { chainId: number; state: "pre-use" | "active" | "unavailable"; reason?: string };
type Attempt = {
  id: string;
  agent: Address;
  status: string;
  parent: Address | null;
  delegate: Address | null;
  expiresAt: number;
  chains?: ChainState[];
};
type Preview = {
  delegate: Address;
  initcodeHash: Hex;
  runtimeHash: Hex;
  chains: ChainState[];
  consent: {
    origin: string;
    id: string;
    challenge: Hex;
    agent: Address;
    parent: Address;
    delegate: Address;
    expiresAt: number;
  };
};

async function api<T>({ path, body }: { path: string; body?: unknown }): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

function Approval() {
  const [, , id] = location.pathname.split("/");
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const query = useQuery({
    queryKey: ["attempt", id, token],
    queryFn: () => api<Attempt>({ path: `/api/attempts/${id}?token=${encodeURIComponent(token)}` }),
    enabled: !!id && !!token,
    refetchInterval: 3000,
  });
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const cache = useQueryClient();
  const [selectedChain, setSelectedChain] = useState<number>(1);
  const preview = useQuery({
    queryKey: ["preview", id, token, address],
    queryFn: () =>
      api<Preview>({
        path: `/api/attempts/${id}/preview?token=${encodeURIComponent(token)}&parent=${address}`,
      }),
    enabled:
      !!query.data &&
      query.data.status === "pending" &&
      !!address &&
      !isAddressEqual(address, query.data.agent),
  });
  const submit = useMutation({
    mutationFn: async () => {
      if (!address || !preview.data) throw new Error("Connect a parent wallet first");
      if (chainId !== selectedChain) await switchChainAsync({ chainId: selectedChain as 1 | 8453 });
      const signature = await signTypedDataAsync({
        account: address,
        ...consentTypedData({ ...preview.data.consent, chainId: selectedChain }),
      });
      await api<Attempt>({
        path: `/api/attempts/${id}/consent`,
        body: { token, parent: address, chainId: selectedChain, signature },
      });
      await cache.invalidateQueries({ queryKey: ["attempt", id, token] });
    },
  });
  if (!id || !token)
    return (
      <main>
        <h1>Agent Wallet</h1>
        <p>Open the complete approval URL from the agent.</p>
      </main>
    );
  if (query.isPending)
    return (
      <main>
        <h1>Agent Wallet</h1>
        <p>Loading request…</p>
      </main>
    );
  if (query.error)
    return (
      <main>
        <h1>Agent Wallet</h1>
        <p role="alert">{query.error.message}</p>
      </main>
    );
  const attempt = query.data;
  return (
    <main>
      <h1>Link agent account</h1>
      <p>
        Agent address: <code>{attempt.agent}</code>
      </p>
      <p>Status: {attempt.status}</p>
      {attempt.status === "pending" && (
        <>
          <p>
            Your wallet will be able to rescue assets held at this agent address. The agent retains
            its own signing key and can spend those assets independently. Connecting alone does not
            approve this request.
          </p>
          {!isConnected ? (
            <div>
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  disabled={connecting}
                  onClick={() => connect({ connector })}
                >
                  Connect {connector.name}
                </button>
              ))}
            </div>
          ) : (
            <p>
              Connected: <code>{address}</code>{" "}
              <button onClick={() => disconnect()}>Disconnect</button>
            </p>
          )}
          {address && isAddressEqual(address, attempt.agent) && (
            <p role="alert">Choose a parent wallet different from the agent.</p>
          )}
          {preview.error && <p role="alert">{preview.error.message}</p>}
          {preview.data && (
            <>
              <p>
                Parent: <code>{address}</code>
              </p>
              <p>
                Parent-bound delegate: <code>{preview.data.delegate}</code>
              </p>
              <p>
                Expected runtime hash: <code>{preview.data.runtimeHash}</code>
              </p>
              <label>
                Consent chain{" "}
                <select
                  value={selectedChain}
                  onChange={(event) => setSelectedChain(Number(event.target.value))}
                >
                  {preview.data.chains.map((chain) => (
                    <option
                      key={chain.chainId}
                      value={chain.chainId}
                      disabled={chain.state === "unavailable"}
                    >
                      {chain.chainId === 1 ? "Ethereum" : "Base"} — {chain.state}
                      {chain.reason ? `: ${chain.reason}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                This approval names this agent, your wallet, the delegate, this request, and its
                expiry. The agent must separately store a verified rescue authorization before
                linking is complete.
              </p>
              <button
                disabled={
                  submit.isPending ||
                  preview.data.chains.find((chain) => chain.chainId === selectedChain)?.state ===
                    "unavailable"
                }
                onClick={() => submit.mutate()}
              >
                Sign consent
              </button>
              {submit.error && <p role="alert">{submit.error.message}</p>}
            </>
          )}
        </>
      )}
      {attempt.parent && (
        <p>
          Parent: <code>{attempt.parent}</code>
        </p>
      )}
      {attempt.delegate && (
        <p>
          Delegate: <code>{attempt.delegate}</code>
        </p>
      )}
      {attempt.status === "awaiting_authorization" && (
        <p>Consent recorded. Waiting for the agent to sign and store the rescue authorization.</p>
      )}
      {attempt.status === "ready" && (
        <p>Link complete. Onchain activation and rescue eligibility vary by chain.</p>
      )}
      {attempt.chains?.map((chain) => (
        <p key={chain.chainId}>
          Chain {chain.chainId}: {chain.state}
          {chain.reason ? ` — ${chain.reason}` : ""}
        </p>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <WagmiProvider config={config}>
      <Approval />
    </WagmiProvider>
  </QueryClientProvider>,
);
