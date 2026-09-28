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
  useSignMessage,
  useSendTransaction,
  usePublicClient,
  useSwitchChain,
  WagmiProvider,
} from "wagmi";
import { baseAccount, injected } from "wagmi/connectors";
import { useMemo, useState } from "react";
import { z } from "zod";
import {
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { chainFor, chainIdSchema, consentTypedData, hexSchema, rpcUrl } from "../shared/protocol";
import "./style.css";

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

const popularChains = [
  { id: 1, name: "Ethereum" },
  { id: 8453, name: "Base" },
  { id: 10, name: "Optimism" },
] as const;
const chainInputSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(chainIdSchema);
const recoveryIdSchema = z.string().regex(/^rs_[a-f0-9]{32}$/);

function ChainSwitcher({
  selectedChain,
  onSelectChain,
}: {
  selectedChain: number;
  onSelectChain: ({ chainId }: { chainId: number }) => void;
}) {
  const current = popularChains.find((chain) => chain.id === selectedChain);
  const [choice, setChoice] = useState(current ? String(current.id) : "custom");
  const [input, setInput] = useState(String(selectedChain));
  const customChain = chainInputSchema.safeParse(input);
  return (
    <form
      className="chain-switcher"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice === "custom" && customChain.success)
          onSelectChain({ chainId: customChain.data });
      }}
    >
      <label>
        Chain{" "}
        <select
          value={choice}
          onChange={(event) => {
            const value = event.target.value;
            setChoice(value);
            if (value === "custom") {
              setInput(current ? "" : String(selectedChain));
              return;
            }
            const parsed = chainInputSchema.safeParse(value);
            if (parsed.success) onSelectChain({ chainId: parsed.data });
          }}
        >
          {popularChains.map((chain) => (
            <option key={chain.id} value={chain.id}>
              {chain.name} ({chain.id})
            </option>
          ))}
          <option value="custom">Custom chain ID</option>
        </select>
      </label>
      {choice === "custom" && (
        <>
          <label>
            Chain ID{" "}
            <input
              inputMode="numeric"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!customChain.success}>
            Use chain
          </button>
        </>
      )}
    </form>
  );
}

type ChainSelection = {
  selectedChain: number;
  onSelectChain: ({ chainId }: { chainId: number }) => void;
};

function Approval({ selectedChain, onSelectChain }: ChainSelection) {
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
  const preview = useQuery({
    queryKey: ["preview", id, token, address, selectedChain],
    queryFn: () =>
      api<Preview>({
        path: `/api/attempts/${id}/preview?token=${encodeURIComponent(token)}&parent=${address}&chainId=${selectedChain}`,
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
      if (chainId !== selectedChain) await switchChainAsync({ chainId: selectedChain });
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
        <h1>agent wallet</h1>
        <ChainSwitcher selectedChain={selectedChain} onSelectChain={onSelectChain} />
        <p>Open the complete approval URL from the agent.</p>
      </main>
    );
  if (query.isPending)
    return (
      <main>
        <h1>agent wallet</h1>
        <ChainSwitcher selectedChain={selectedChain} onSelectChain={onSelectChain} />
        <p>Loading request…</p>
      </main>
    );
  if (query.error)
    return (
      <main>
        <h1>agent wallet</h1>
        <ChainSwitcher selectedChain={selectedChain} onSelectChain={onSelectChain} />
        <p role="alert">{query.error.message}</p>
      </main>
    );
  const attempt = query.data;
  return (
    <main>
      <h1>agent wallet</h1>
      <h2>Link agent account</h2>
      <ChainSwitcher selectedChain={selectedChain} onSelectChain={onSelectChain} />
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
              <p>
                Consent chain {selectedChain}: {preview.data.chains[0]?.state}
                {preview.data.chains[0]?.reason ? ` — ${preview.data.chains[0].reason}` : ""}
              </p>
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

type Rescue = {
  id: string;
  agent: Address;
  chainId: number;
  recipient: Address;
  amountWei: string;
  fundingWei: string;
  relayer: Address;
  state: "quoted" | "activating" | "active" | "active_partial" | "failed" | "completed";
  expiresAt: number;
  fundingTxHash: Hex | null;
  deployTxHash: Hex | null;
  activationTxHash: Hex | null;
  rescueTxHash: Hex | null;
  errorCode: string | null;
  error: string | null;
};

const rescueAbi = parseAbi([
  "function executeBatch((address to, uint256 value, bytes data)[] calls)",
]);
function rescueData({ recipient, amountWei }: { recipient: Address; amountWei: string }) {
  return encodeFunctionData({
    abi: rescueAbi,
    functionName: "executeBatch",
    args: [[{ to: recipient, value: BigInt(amountWei), data: "0x" }]],
  });
}

function Recovery({ selectedChain, onSelectChain }: ChainSelection) {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();
  const { sendTransactionAsync } = useSendTransaction();
  const client = usePublicClient({ chainId: selectedChain });
  const [signedIn, setSignedIn] = useState(false);
  const [agent, setAgent] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [quoteId, setQuoteId] = useState("");
  const [resumeInput, setResumeInput] = useState("");
  const [fundingHash, setFundingHash] = useState("");
  const [topupAmount, setTopupAmount] = useState("");
  const [topupHash, setTopupHash] = useState("");
  const [rescueHash, setRescueHash] = useState("");
  const session = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Connect your parent wallet");
      if (chainId !== selectedChain) await switchChainAsync({ chainId: selectedChain });
      const { message } = await api<{ message: string }>({
        path: "/api/session/challenge",
        body: { address, chainId: selectedChain },
      });
      await api({
        path: "/api/session",
        body: { message, signature: await signMessageAsync({ message }) },
      });
      setSignedIn(true);
    },
  });
  const accounts = useQuery({
    queryKey: ["recovery-accounts", address, selectedChain, signedIn],
    queryFn: () =>
      api<{ accounts: { agent: Address; delegate: Address }[] }>({ path: "/api/parents/accounts" }),
    enabled: signedIn,
  });
  const status = useQuery({
    queryKey: ["recovery-account", agent, selectedChain],
    queryFn: () =>
      api<{ chains: ChainState[] }>({ path: `/api/accounts/${agent}?chainId=${selectedChain}` }),
    enabled: signedIn && !!agent,
    refetchInterval: 4000,
  });
  const quote = useQuery({
    queryKey: ["rescue", quoteId],
    queryFn: () => api<Rescue>({ path: `/api/rescues/${quoteId}` }),
    enabled: signedIn && !!quoteId,
    refetchInterval: 4000,
  });
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: ["rescue", quoteId] });
  const createQuote = useMutation({
    mutationFn: async () => {
      const value = await api<Rescue>({
        path: "/api/rescues",
        body: {
          agent,
          chainId: selectedChain,
          recipient,
          amountWei: parseEther(amount).toString(),
        },
      });
      setQuoteId(value.id);
      setResumeInput(value.id);
      setFundingHash("");
      setTopupHash("");
      setRescueHash("");
    },
  });
  const fund = useMutation({
    mutationFn: async () => {
      if (!quote.data || !client || !address) throw new Error("Quote or wallet unavailable");
      if (chainId !== selectedChain) await switchChainAsync({ chainId: selectedChain });
      const hash = await sendTransactionAsync({
        account: address,
        chainId: selectedChain,
        to: quote.data.relayer,
        value: BigInt(quote.data.fundingWei),
        data: "0x",
      });
      setFundingHash(hash);
      await client.waitForTransactionReceipt({ hash, confirmations: 2 });
    },
  });
  const topup = useMutation({
    mutationFn: async () => {
      if (!quote.data || !client || !address) throw new Error("Quote or wallet unavailable");
      if (chainId !== selectedChain) await switchChainAsync({ chainId: selectedChain });
      const value = parseEther(topupAmount);
      if (value <= 0n) throw new Error("Enter a positive top-up amount");
      const hash = await sendTransactionAsync({
        account: address,
        chainId: selectedChain,
        to: quote.data.relayer,
        value,
        data: "0x",
      });
      setTopupHash(hash);
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
      if (receipt.status !== "success") throw new Error("Relayer top-up reverted");
    },
  });
  const activate = useMutation({
    mutationFn: async () => {
      if (!quote.data) throw new Error("Quote unavailable");
      await api<Rescue>({
        path: `/api/rescues/${quoteId}/activate`,
        body: { fundingTxHash: fundingHash || quote.data.fundingTxHash },
      });
      await refresh();
    },
  });
  const execute = useMutation({
    mutationFn: async () => {
      if (!client || !address) throw new Error("Wallet unavailable");
      if (chainId !== selectedChain) await switchChainAsync({ chainId: selectedChain });
      const target = quote.data?.agent ?? (agent as Address);
      const dest = quote.data?.recipient ?? (recipient as Address);
      const value = quote.data?.amountWei ?? parseEther(amount).toString();
      const hash =
        (rescueHash ? hexSchema.parse(rescueHash) : null) ||
        (await sendTransactionAsync({
          account: address,
          chainId: selectedChain,
          to: target,
          data: rescueData({ recipient: dest, amountWei: value }),
        }));
      setRescueHash(hash);
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
      if (receipt.status !== "success") throw new Error("Rescue transaction reverted");
      if (quote.data) {
        await api<Rescue>({
          path: `/api/rescues/${quoteId}/complete`,
          body: { rescueTxHash: hash },
        });
        await refresh();
      }
    },
  });
  const state = status.data?.chains.find((item) => item.chainId === selectedChain);
  const error = [session, createQuote, fund, topup, activate, execute]
    .map((item) => item.error)
    .find(Boolean);
  return (
    <main>
      <h1>agent wallet</h1>
      <p>
        Connect your wallet to manage your linked agent wallets: view their chain status and recover
        assets when needed.
      </p>
      <ChainSwitcher selectedChain={selectedChain} onSelectChain={onSelectChain} />
      {!isConnected ? (
        connectors.map((connector) => (
          <button key={connector.uid} onClick={() => connect({ connector })}>
            Connect {connector.name}
          </button>
        ))
      ) : (
        <p>
          Connected: <code>{address}</code>{" "}
          <button
            onClick={() => {
              disconnect();
              setSignedIn(false);
            }}
          >
            Disconnect
          </button>
        </p>
      )}
      {isConnected && !signedIn && (
        <button disabled={session.isPending} onClick={() => session.mutate()}>
          Sign in with parent wallet
        </button>
      )}
      {signedIn && (
        <>
          <h2>Your agent wallets</h2>
          {accounts.data?.accounts.length === 0 && (
            <p>No agent wallets linked to this wallet yet.</p>
          )}
          <label>
            Agent{" "}
            <select
              value={agent}
              onChange={(event) => {
                setAgent(event.target.value);
                setQuoteId("");
                setResumeInput("");
                setFundingHash("");
                setTopupHash("");
                setRescueHash("");
              }}
            >
              <option value="">Select agent</option>
              {accounts.data?.accounts.map((item) => (
                <option key={item.agent} value={item.agent}>
                  {item.agent}
                </option>
              ))}
            </select>
          </label>
          {accounts.error && <p role="alert">{accounts.error.message}</p>}
          {state && (
            <p>
              Chain state: {state.state}
              {state.reason ? ` — ${state.reason}` : ""}
            </p>
          )}
          <h2>Asset recovery</h2>
          <p>
            Send native assets from a linked agent to a recipient. Before activation, this requires
            a non-refundable gas payment to the relayer; any unused funds remain there.
          </p>
          {agent && (state?.state === "pre-use" || state?.state === "active") && (
            <>
              <p>
                <label>
                  Recipient{" "}
                  <input
                    value={recipient}
                    onChange={(event) => setRecipient(event.target.value)}
                    placeholder="0x…"
                  />
                </label>
              </p>
              <p>
                <label>
                  Native amount (18 decimals){" "}
                  <input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="0.01"
                  />
                </label>
              </p>
              {state.state === "pre-use" && !quoteId && (
                <button disabled={createQuote.isPending} onClick={() => createQuote.mutate()}>
                  Start recovery
                </button>
              )}
              {state.state === "active" && !quoteId && (
                <button disabled={execute.isPending} onClick={() => execute.mutate()}>
                  Recover assets
                </button>
              )}
            </>
          )}
          <details>
            <summary>Resume a pre-use recovery</summary>
            <p>Enter the recovery ID shown after starting an earlier recovery.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const parsed = recoveryIdSchema.safeParse(resumeInput);
                if (!parsed.success) return;
                setQuoteId(parsed.data);
                setFundingHash("");
                setTopupHash("");
                setRescueHash("");
              }}
            >
              <label>
                Recovery ID{" "}
                <input
                  value={resumeInput}
                  onChange={(event) => setResumeInput(event.target.value)}
                  placeholder="rs_…"
                />
              </label>
              <button type="submit" disabled={!recoveryIdSchema.safeParse(resumeInput).success}>
                Load recovery
              </button>
            </form>
          </details>
          {quote.error && <p role="alert">{quote.error.message}</p>}
          {quote.data && (
            <>
              <p>
                Recovery ID: <code>{quote.data.id}</code>
              </p>
              <p>
                Rescue: {quote.data.state}. Recipient: <code>{quote.data.recipient}</code>. Amount:{" "}
                {quote.data.amountWei} wei.
              </p>
              <p>
                Relayer: <code>{quote.data.relayer}</code>. Non-refundable gas payment:{" "}
                {quote.data.fundingWei} wei. Quote expires:{" "}
                {new Date(quote.data.expiresAt * 1000).toLocaleString()}.
              </p>
              {quote.data.errorCode && (
                <p role="alert">
                  {quote.data.errorCode}: {quote.data.error}
                </p>
              )}
              {quote.data.state === "quoted" && !fundingHash && (
                <button disabled={fund.isPending} onClick={() => fund.mutate()}>
                  Pay relayer gas
                </button>
              )}
              {quote.data.state === "quoted" && (
                <p>
                  <label>
                    Funding transaction hash{" "}
                    <input
                      value={fundingHash}
                      onChange={(event) => setFundingHash(event.target.value)}
                      placeholder="0x…"
                    />
                  </label>
                </p>
              )}
              {(quote.data.state === "quoted" || quote.data.state === "activating") && (
                <button
                  disabled={activate.isPending || !(fundingHash || quote.data.fundingTxHash)}
                  onClick={() => activate.mutate()}
                >
                  Continue activation
                </button>
              )}
              {quote.data.state === "activating" &&
                (quote.data.errorCode === "RELAYER_UNDERFUNDED" ||
                  quote.data.errorCode === "RELAYER_FEE_CAP_UNFUNDED") && (
                  <div>
                    <p>
                      The relayer needs more native gas. Additional funds are non-refundable. After
                      the top-up confirms, continue the same activation.
                    </p>
                    <label>
                      Top-up native amount{" "}
                      <input
                        value={topupAmount}
                        onChange={(event) => setTopupAmount(event.target.value)}
                        placeholder="0.000001"
                      />
                    </label>{" "}
                    <button
                      disabled={topup.isPending || !topupAmount}
                      onClick={() => topup.mutate()}
                    >
                      Pay additional gas
                    </button>
                    {topupHash && (
                      <p>
                        Top-up: <code>{topupHash}</code>
                      </p>
                    )}
                  </div>
                )}
              {(quote.data.state === "active" || quote.data.state === "active_partial") && (
                <button disabled={execute.isPending} onClick={() => execute.mutate()}>
                  Recover assets
                </button>
              )}
              {quote.data.deployTxHash && (
                <p>
                  Deployment: <code>{quote.data.deployTxHash}</code>
                </p>
              )}
              {quote.data.activationTxHash && (
                <p>
                  Activation: <code>{quote.data.activationTxHash}</code>
                </p>
              )}
              {quote.data.rescueTxHash && (
                <p>
                  Rescue transaction: <code>{quote.data.rescueTxHash}</code>
                </p>
              )}
            </>
          )}
          {quote.data &&
            (quote.data.state === "active" || quote.data.state === "active_partial") && (
              <p>
                <label>
                  Resume parent rescue transaction{" "}
                  <input
                    value={rescueHash}
                    onChange={(event) => setRescueHash(event.target.value)}
                    placeholder="0x…"
                  />
                </label>
              </p>
            )}
          {rescueHash && (
            <p>
              Wallet rescue transaction: <code>{rescueHash}</code>
            </p>
          )}
          {error && <p role="alert">{error.message}</p>}
        </>
      )}
    </main>
  );
}

function App() {
  const [selectedChain, setSelectedChain] = useState(() => {
    const candidate = Number(
      new URLSearchParams(location.search).get("chainId") ??
        localStorage.getItem("agent-wallet-chain") ??
        "1",
    );
    return chainIdSchema.safeParse(candidate).success ? candidate : 1;
  });
  const config = useMemo(
    () =>
      createConfig({
        chains: [chainFor({ chainId: selectedChain })],
        connectors: [
          injected(),
          baseAccount({ appName: "agent wallet", preference: { telemetry: false } }),
        ],
        transports: { [selectedChain]: http(rpcUrl(selectedChain)) },
      }),
    [selectedChain],
  );
  const selectChain = ({ chainId }: { chainId: number }) => {
    localStorage.setItem("agent-wallet-chain", String(chainId));
    setSelectedChain(chainId);
  };
  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider key={selectedChain} config={config}>
        {location.pathname === "/recover" || location.pathname === "/" ? (
          <Recovery selectedChain={selectedChain} onSelectChain={selectChain} />
        ) : (
          <Approval selectedChain={selectedChain} onSelectChain={selectChain} />
        )}
      </WagmiProvider>
      <p>
        <a href="https://github.com/stephancill/agent-wallet">github</a>
        {" - "}
        <a href="https://x.com/stephancill">twitter</a>
        {" - "}
        <a href="https://stupidtech.net">stupidtech.net</a>
      </p>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
