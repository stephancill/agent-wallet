---
name: agent-wallet
description: Create and operate a locally keyed EVM agent account using @stupidtech/agent-wallet. Use when an agent needs to link its own persistent address to a human parent wallet, check account/chain activation, send an atomic batch of onchain calls, resume a pending operation, or direct the parent to recover the agent's assets.
---

# Agent Wallet

Use the published Bun CLI to keep the signing key on the agent's host. Install [Bun](https://bun.sh/) before invoking the npm package. The CLI defaults to `https://agent-wallet.stupidtech.net`; set `AGENT_WALLET_URL` only when intentionally using another Agent Wallet service. Its private key and resumable operation records live under `~/.local/share/agent-wallet` by default; `AGENT_WALLET_HOME` overrides that location. Keep the same home and service origin across commands.

## Connect the human wallet

1. Run `npx @stupidtech/agent-wallet status` to check for a local key and an association. An unlinked result explains the next command.
2. Run `npx @stupidtech/agent-wallet login`. Copy the **complete** approval URL into your reply to the human. Ask them to open it, connect their own wallet (different from the displayed agent address), review the parent-specific delegate, and sign consent. Keep the command running while they approve; if interrupted, rerun `login` on the same host.
3. Run `npx @stupidtech/agent-wallet status <chain-id>` after approval. Distinguish `ready` (association and durable rescue authorization) from `pre-use` (not yet activated), `active`, and `unavailable` on that chain. Share the public agent address if the human needs to fund it with native gas or assets.

Never read, print, export, or send the agent's key file. Do not treat an approval link as proof of consent, and do not attempt a plain nonce-0 transaction from an unactivated agent.

## Execute agent-owned calls

Express the intended calls as an ordered JSON array, with one or more `{ "to": "0x...", "data": "0x...", "value": "0" }` entries. `value` is a decimal **wei string**; `data` and `value` may be omitted (defaults: `0x` and `0`). Check the chain ID, target addresses, amounts, calldata, and native gas before submission. For example:

```sh
npx @stupidtech/agent-wallet send 8453 calls.json 10000000000000000
# Or use stdin: ... send 8453 - < calls.json
```

The optional last value is the maximum gas cost in wei **for each prepared transaction**, not a total spend cap. The CLI verifies the service's signing plan, signs locally, and submits; the service checks/broadcasts and verifies receipts. The first send on a pre-use chain activates the parent-bound delegation with a separate type-4 transaction before executing the batch. If the chain is unavailable or the agent lacks gas, report the error and request funding or a supported chain; do not work around the activation sequence. Capture the printed `op_<id>` for interrupted operations.

```sh
npx @stupidtech/agent-wallet resume op_<id> 10000000000000000
```

Resume on the same host with the same `AGENT_WALLET_HOME` and `AGENT_WALLET_URL`. A pending broadcast may still be in flight; inspect its status rather than starting a duplicate send. A reverted or partial operation requires inspection before any new attempt. An included result is the confirmation to report, not a broadcast hash alone.

## Parent recovery

For recovery, direct the human parent to `https://agent-wallet.stupidtech.net/recover`. They authenticate with their own wallet. A pre-use rescue may require a non-refundable native-asset payment to the service relayer, followed by their rescue transaction; they should use the page's quote and status. An already-active account can be rescued with a parent wallet transaction. Never ask for the agent's private key or a copy of the stored authorization. A `ready` association alone does not prove that rescue is possible on every chain; check live chain state.
