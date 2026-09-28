# Onboarding implementation

The Bun CLI (`cli/index.ts`), Vite/React approval page (`web/`), Cloudflare Worker (`service/worker.ts`), and D1 tables in `migrations/` support login attempts, EIP-712 parent consent, locally signed EIP-7702 rescue authorizations, and read-only state for a requested EVM chain ID. The public approval URL is `https://agent-wallet.stupidtech.net/approve/<attempt-id>?token=...`. The Worker and D1 are deployed, and `@stupidtech/agent-wallet@0.1.0` is published on npm from `packages/agent-wallet/`. Local and public ephemeral-account onboarding tests pass without broadcasting transactions.

## Run locally

```sh
bun install
# First build the existing Foundry contract artifact outside a sandbox if needed.
bun run generate:delegate
bun run db:local
bun run build
bun run dev:api
```

In another terminal:

```sh
bun cli/index.ts status
bun cli/index.ts login
```

The CLI defaults to `https://agent-wallet.stupidtech.net`, and accepts `AGENT_WALLET_URL` and `AGENT_WALLET_HOME` overrides. Set `AGENT_WALLET_URL=http://127.0.0.1:8787` for the local Worker. It stores its private key in an owner-only directory/file and the pending approval URL in an owner-only file; the key never leaves the host. `login` keeps polling after displaying the complete link. Restarting it reuses the pending key/attempt, or creates a new attempt after expiry. The page supports injected EIP-1193 wallets and Base Account; select a chain ID before signing EIP-712 consent. It does not request `wallet_addSubAccount`.

For development, Vite (`bun run dev`) proxies `/api` to Wrangler on port 8787, while the approval URL points to Wrangler's built static assets. Rebuild the static assets after editing the page. `wrangler.jsonc` binds remote D1 and the custom domain; local migrations use separate Wrangler state. Public RPC reads use `https://evm.stupidtech.net/v1/<chainId>`.

## State and authority

1. `POST /api/challenges` issues a short-lived agent-key challenge for `login` or `finalize`. The CLI signs an origin-bound message; `POST /api/login` verifies it and returns a reproducible, retryable short-lived approval link.
2. The page reads only the attempt's public fields. Its `/preview?chainId=<id>` request computes the parent-specific CREATE2 address and expected runtime hash, inspects the selected chain's nonce, pointer, delegate and factory code, and shows failures.
3. `POST /api/attempts/:id/consent` verifies a request-bound EIP-712 signature from the claimed EOA or ERC-1271 account on the selected chain before saving parent consent. Link-token possession alone cannot complete consent.
4. The CLI verifies the parent-bound delegate locally, signs the chain-agnostic nonce-0 authorization, signs a fresh finalize challenge, and posts both to `/authorization`. The API recovers the agent EOA signer, rechecks chain state and parent consent, and atomically stores the association and authorization. Signed artifacts are absent from attempt and account GET responses.
5. `GET /api/accounts/:agent?chainId=<id>` reports `ready` for a stored verified association and separately computes `pre-use`, `active`, or `unavailable` on the selected chain. `pre-use` means eligibility subject to live nonce/code checks, not that a lost-key rescue has executed. A plain nonce-0 transaction on an unactivated chain is still prohibited.

The account table is durable; login attempts expire after 30 minutes. The stored nonce-0 tuple is retained independently of per-chain activation. Agent transaction preparation/broadcasting is documented in `transactions.md`; parent-funded recovery is in `recovery.md`. A parent reassignment flow, live public rescue, and public delegate source verification remain release gates. The ERC-1271 onboarding verification path uses viem's onchain typed-data verification; end-to-end onboarding integration currently exercises EOA parents, not a live ERC-1271 parent.

## Checks

```sh
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:integration # with bun run dev:api running and the local D1 migration applied
```

The unit test pins the same parent-specific identity as `production-account.md`. The integration scripts exercise failed signatures, duplicate consent, private-artifact response boundaries, an EOA approval through `ready`, and the real CLI's pending-to-ready flow against the local Worker/D1 and live Ethereum/Base read endpoints. They use ephemeral accounts and do not broadcast transactions.
