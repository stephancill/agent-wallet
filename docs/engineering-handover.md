# Agent Wallet engineering handover

## Product outcome

Give an agent a persistent EVM address controlled by a key on its Linux host, while a connected human wallet can identify the account and rescue its assets through EIP-7702 delegated code. The agent may spend assets held at its own address autonomously. It may later request funding or recurring permissions from the parent; recurring permissions are a later milestone.

Agent Wallet owns a separate browser frontend, HTTP API, and durable database for onboarding, associations, rescue artifacts, transaction preparation/broadcasting, and recovery. The connected wallet only needs to connect, sign consent, and send ordinary payments/transactions. The onboarding link is a bespoke Agent Wallet URL, not a wallet JSON-RPC request. **Do not forward `wallet_addSubAccount` to the wallet or rely on wallet support for it.** Agent operations use explicit HTTP endpoints, not `wallet_prepareRequest` or `wallet_sendPreparedRequest`. `../txlink` may provide optional, short-lived approval links for ordinary payments (such as funding), but is not the account registry, artifact custodian, or source of truth for recovery.

The intended reach is any EVM wallet that can provide verifiable typed-data consent, including ERC-1271 smart wallets, and all EIP-7702 chains where the specified deployment and transaction prerequisites can be met. Treat parent smart accounts as able to transact on the target chains. Expose prerequisites and failures rather than silently changing the account's address or delegate code.

## Agreed decisions

| Topic | Decision |
| --- | --- |
| Agent address | The local secp256k1 EOA address is the durable account address; EIP-7702 adds smart behavior to that same address. |
| Agent key | Persistent Linux host; a dedicated restricted local key file is acceptable for the first release. The key is extractable, and plaintext at rest is an explicit tradeoff. |
| Parent authority | The parent can rescue assets. This is **not** revocation of the EOA key: whoever controls that key can sign another 7702 delegation. Lost-key recovery may move assets to a new address. |
| Delegation | A standalone delegate has the parent address as a constructor immutable. Its CREATE2 initcode/address and runtime code bind that parent; the same parent yields the same verified bytecode/address on every supported chain. Different parents have different delegate addresses. Delegate deployment and agent activation are lazy. |
| Rescue artifact | After parent approval, sign and store a chain-agnostic (`chainId = 0`), nonce-0 7702 authorization for the parent-specific CREATE2 address. No initialization proof or account storage is needed. The authorization lives in Agent Wallet's durable service; no user export is required in v1. |
| Parent consent | Fresh, request-bound typed-data signature, verified via ECDSA or ERC-1271 as appropriate. Wallet connection alone is not consent. |
| Calls | Atomic batches of `{ to, data?, value? }`; the Agent Wallet API prepares exact raw transactions, the agent signs locally, and the API verifies the signed fields and broadcasts. The outer EOA signature supplies chain/nonce/call/gas binding; there is no separate operation signature or contract-level nonce. |
| Gas | Agent pays for its normal deployment, activation, and transactions from its native balance. If empty, ask the user to fund it. For rescue without an agent key, the parent funds an Agent Wallet relayer. |
| Login completion | `ready` after consent and a durable, verified parent-bound rescue authorization are stored; onchain activation is tracked separately per chain. |
| Funding permissions | One-off funding may be requested; recurring spend permissions using `https://github.com/stephancill/spend-permissions` follow in a later milestone. |

## Onboarding state machine

1. Agent is asked to install the product skill. The skill directs it to run `npx @stupidtech/agent-wallet status`. An unlinked status explains the `login` command.
2. `login` creates a local EOA key if none exists. Persist pending state atomically so a retry uses the same key rather than creating an orphaned address. Store under an application-specific directory with owner-only directory/file permissions (for example `0700` / `0600`); keep the key out of shell output and logs.
3. Create a login attempt through the Agent Wallet API with proof of control of the agent EOA, and show the complete Agent Wallet approval URL (for example, `https://agent-wallet.stupidtech.net/approve/<attempt-id>?token=...`). The delegate address cannot be calculated until the parent wallet is known; do not sign a generic nonce-0 authorization first.
4. The user opens the dedicated approval page and connects a wallet distinct from the agent EOA. Calculate the CREATE2 initcode from the verified standalone contract and that wallet's address; derive and display the parent-specific delegate address. The user signs typed consent binding at least the parent address, agent address, delegate address, Agent Wallet origin, login ID/challenge, and expiry. Verify an EOA signature or ERC-1271 on an appropriate chain. A user may have multiple agents; a given agent has one recorded parent until an explicit reassignment flow exists.
5. Once parent consent is verified and the parent-specific CREATE2 address/runtime/bootstrap prerequisites are established for the claimed chains, the CLI signs a chain-agnostic EIP-7702 authorization (`chainId = 0`, EOA nonce 0) to that address. The Agent Wallet API verifies the recovered agent EOA signer and persists the exact tuple with the parent consent in its durable store. Only then mark the association `ready`. If that chain's nonce has advanced or the expected code/deployer cannot be verified, do not claim pre-use rescue there.
6. Status distinguishes `unlinked`, `pending approval`, `awaiting rescue authorization`, `ready (not activated on this chain)`, and `active on chain`. Expired/rejected attempts remain retryable without changing the key.

The approval page and API belong to Agent Wallet, with purpose-built durable records, signature validation, authenticated parent rescue access, and idempotent state transitions. The approval-link token grants access only to its short-lived attempt; it does not grant ongoing control of an agent account. Neither link possession nor a client-reported connected address proves parent consent. txlink's generic `POST /api/requests`, public polling, bearer completion URL, and seven-day request retention (`../txlink/src/worker.ts`) are **not** an authenticated, durable agent registry and must not store rescue authorizations or determine account state.

## Chain deployment and execution

EIP-7702 signs `[chainId, delegateAddress, nonce]` and installs a code pointer, not the implementation bytecode. CREATE2 gives the same address only when the **deployer address, salt, and initcode hash** match; the initcode includes the parent constructor argument. Calculate and verify these values and the resulting runtime-code hash **per parent** on every chain. A CREATE2 deployer must itself exist at the expected address; it cannot be replaced by an arbitrary factory without changing the derived address.

**Before first agent transaction on each chain**, the Agent Wallet API checks EIP-7702 support, the EOA nonce and existing code, the CREATE2 deployer/bootstrap path, and available native gas. The stored nonce-0 authorization remains a viable pre-use rescue artifact only while that chain's agent nonce is 0 and the account has not been delegated elsewhere.

The first **agent-funded** transaction must not be an ordinary nonce-0 deployment: it would consume the nonce and invalidate the stored authorization before rescue became available. Instead prepare a **type-4 transaction from the agent EOA at transaction nonce 0 with a freshly signed 7702 authorization at authorization nonce 1**. EIP-7702 increments the outer sender's nonce before processing authorizations. That transaction can call the CREATE2 deployer to deploy the parent-specific delegate; batch execution follows in a separate transaction. Verify the onchain delegation pointer, deployed code hash, immutable parent, and receipts before reporting `active` or completed. EIP-7702 can persist the delegation even when the transaction's execution fails; handle partial states explicitly.

If the shared CREATE2 deployer is missing, the first actor needing it funds its bootstrap: agent for normal first use; parent via the funded relayer for pre-use rescue. **Engineering gate:** prove the same deployer address can actually be bootstrapped on every claimed chain. No arbitrary CREATE transaction can guarantee the same address. If that bootstrap is unavailable on a chain, report the chain unavailable until it is resolved.

For normal batches, the standalone delegate permits calls from the agent EOA to itself or from the constructor-bound parent. The signed outer EOA transaction binds chain, EOA nonce, target, calldata and gas; the parent's own transaction or smart-wallet rules authorize rescue. Use atomic batches. The Agent Wallet API must bind a prepared raw transaction to its operation and reject expired submissions, but an offchain expiry cannot invalidate signed raw bytes already disclosed to another broadcaster. The delegate validates ERC-1271 signatures from the underlying agent EOA for integrations. Inspect existing 7702 delegation before replacing it; a fresh authorization can overwrite code even though this implementation has no mutable parent.

The CLI accepts an ordered batch of `{ to, data?, value? }` calls and a chain ID, retaining the original intent locally. It signs an operation-bound challenge; the API validates chain state and returns an exact, expiring signing plan. The CLI independently checks the plan against the requested calls, expected parent-specific delegate, authorization scope/nonce, and fee limits before signing. It saves the original calls and challenge in an owner-only file keyed by operation ID before signing, so `resume <id>` needs no calls-file argument and still verifies the preparation against locally expressed intent. It submits signed raw bytes; the API recovers the signer, compares every signed field against its durable preparation, broadcasts idempotently, and tracks receipts. Signing and submission occur in phases: if the agent is pre-use at nonce 0, first prepare a fresh **chain-specific authorization at nonce 1** and type-4 outer transaction at nonce 0 (deploying the delegate through the verified CREATE2 factory if needed). The stored chain-agnostic nonce-0 authorization is reserved for lost-key rescue and is never used for agent-funded first use. Only after the activation receipt, pointer, code hash and parent are verified does the API prepare the batch transaction using the new live nonce (2 after the tested self-activation). An already active account proceeds directly to batch preparation. A missing factory requires its separately verified bootstrap path or an unavailable-chain result. Partial activation/revert must never silently trigger the batch.

## Pre-use and post-use rescue

- **Before activation:** the stored nonce-0 authorization to the parent-bound CREATE2 delegate allows recovery without the agent key, provided the nonce is still 0 and the exact runtime is available. The parent pays a non-refundable gas quote to an Agent Wallet relayer through a normal connected-wallet payment; an optional txlink payment link can carry that one-off request. The relayer ensures that delegate code exists and broadcasts a type-4 transaction carrying the saved authorization; the parent then calls the delegated account to rescue. Independently confirm the payment onchain and report failed or partial activation explicitly. Unused relayer funds remain with the relayer; there is no refund flow.
- **After activation:** the parent calls `executeBatch` directly or via the Agent Wallet frontend/API. Validate the actual delegate pointer, code hash, and immutable parent first.
- **If a nonce advanced before activation, an incompatible delegation exists, or the delegate/bootstrap cannot be installed:** report that the saved rescue artifact is insufficient. Do not promise recovery. Never ask the service to forge a new authorization without the agent key.

The Agent Wallet service is the sole custodian of rescue artifacts in v1. Parent retrieval/execution requires fresh proof of parent control; a public request ID or login URL is insufficient. A service outage therefore delays recovery—this is an accepted availability dependency, not a cryptographic recovery guarantee independent of the service.

## Proposed HTTP surface (names provisional)

Host a dedicated frontend and HTTP API backed by Agent Wallet's own durable database (a Cloudflare Worker with D1 is the proposed deployment). Keep account and operation records separate from txlink's generic wallet-request API. Validate external bodies with Zod; authenticate agent actions with fresh, bound agent-key signatures and parent actions with fresh parent signatures. Avoid a long-lived bearer token as the sole authority. The browser displays the attempt, computed delegate, consent terms, and per-chain status; the local CLI alone signs agent EOA transactions and 7702 authorizations.

| Endpoint role | Essential behavior |
| --- | --- |
| Create/read login attempt | Accept public agent identity and proof, issue bounded challenge and bespoke Agent Wallet URL; return pollable state without private artifacts. |
| Store rescue authorization | Verify EIP-7702 signer, exact parent-specific delegate/nonce/scope, deterministic initcode and runtime identity, and parent consent; commit atomically and idempotently. |
| Prepare operation | Authenticate an agent-signed, operation-bound request for `{ agentAddress, chainId, calls[] }`; check chain state and gas; return exact current-phase transaction and, for first use, a fresh authorization payload. Re-prepare the batch only after activation is verified. |
| Submit prepared operation | Verify locally signed authorization and raw transaction against every prepared field; broadcast idempotently; return operation ID and transaction hash/status. |
| Read operation/status | Distinguish prepared, broadcast, included, reverted, and partial activation states; return receipts and chain identifiers. |
| Quote/execute rescue | Verify parent control, prerequisite code/nonce, funding, relayer submission, and final onchain state. |

Do not persist signed artifacts in publicly pollable responses. Keep account records durable beyond a login attempt's lifetime. Make network retries and duplicate submissions idempotent; never interpret a submitted hash as confirmation. Optional txlink requests can supply short-lived payment links and pollable transaction hashes, but Agent Wallet must confirm their outcomes onchain.

## Delivery sequence and verification gates

1. **Protocol spike:** on two 7702 chains, prove identical CREATE2 runtime code and deployer bootstrap, nonce-0 parent-funded pre-use rescue with the agent key unavailable, and a separate nonce-1 self-funded first-use transaction. Include failure/revert and nonce-drift cases. Record bytecode hashes, addresses, transaction IDs, and reproducible tests without private keys.
2. **Account implementation:** audited or thoroughly tested parent-committed delegate with atomic batch execution, agent and parent paths, outer-transaction replay protection, and ERC-1271 where needed. Verify source/deployments; never treat an unaudited or unverified implementation as universally safe by assumption.
3. **Agent Wallet service and frontend:** dedicated Worker/database and bespoke approval URL; durable schemas, typed-consent verification (EOA and ERC-1271), artifact storage/access control, prepare/submit/status, browser onboarding, wallet connector coverage, and parent-funded rescue relayer flow. Treat txlink as an optional payment-link integration, not a dependency for association or recovery.
4. **CLI and skill:** package the Bun CLI as `@stupidtech/agent-wallet` and ship `skills/agent-wallet`; implement local key lifecycle, `status`, `login`, atomic batch signing/submission, funding prompt, and clear recovery/chain-state reporting. Test retries, process crashes, and missing credentials.
5. **Later funding milestone:** integrate the linked allowance-based spend-permissions manager for recurring ERC-20 funding. It requires the parent to approve the manager and sign a permission naming the agent as spender; the manager must be deployed on the target chain. This is distinct from blanket access to the parent's balance.

## References

- [EIP-7702: Set Code for EOAs](https://eips.ethereum.org/EIPS/eip-7702) — authorization/nonce processing and initialization front-running.
- [ERC-7895: API for Hierarchical Accounts](https://eips.ethereum.org/EIPS/eip-7895) — account terminology; wallet support is not a dependency of this implementation.
- [ERC-1271: Standard Signature Validation Method for Contracts](https://eips.ethereum.org/EIPS/eip-1271).
- [txlink implementation and instructions](../../txlink/README.md) — optional one-off wallet approval links, not Agent Wallet's account or recovery store.
- [Allowance Spend Permissions fork](https://github.com/stephancill/spend-permissions) — later recurring funding integration; it is distinct from Coinbase's upstream deployment/signature format.
