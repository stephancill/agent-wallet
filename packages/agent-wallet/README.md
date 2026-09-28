# @stupidtech/agent-wallet

Agent Wallet CLI for a persistent, locally keyed EVM agent account. Install [Bun](https://bun.sh/) first; the npm executable runs on Bun. The account key stays on this host. The Agent Wallet service handles approval, account association, transaction preparation/broadcasting, and parent recovery.

```sh
npx @stupidtech/agent-wallet status
npx @stupidtech/agent-wallet login
npx @stupidtech/agent-wallet status 8453
```

`login` creates a private local key if needed, prints a complete approval URL, and waits for the human to connect a **different** wallet and sign consent. Keep it running or rerun it after approval. `status` displays the account address, parent, and live chain state. Give the displayed approval URL to the human; never share the key file.

To send an atomic ordered batch, save calls as JSON (decimal wei values):

```json
[{ "to": "0x000000000000000000000000000000000000dEaD", "value": "1000000000000000" }]
```

```sh
npx @stupidtech/agent-wallet send 8453 calls.json 10000000000000000
npx @stupidtech/agent-wallet resume op_<id>
```

The optional final `send` argument caps *each prepared transaction's* maximum gas cost in wei (`gas × maxFeePerGas`); `resume` accepts the same optional cap. Calls can be piped using `-` instead of `calls.json`. The CLI signs locally, verifies the service's preparation against the saved calls and delegate, and reports inclusion or failure. Save the printed operation ID; `resume` must run on the host with the original key and saved operation record. A pre-use send first activates the EIP-7702 delegation before executing the batch; native gas is required on the selected chain.

By default the CLI uses `https://agent-wallet.stupidtech.net` and stores the key and operation records under `~/.local/share/agent-wallet` with owner-only permissions. Set `AGENT_WALLET_URL` to another service origin and `AGENT_WALLET_HOME` to another private local directory for development or isolated usage. Preserve the same values for `resume`. For parent-funded rescue, the human uses [the recovery page](https://agent-wallet.stupidtech.net/recover), not the agent CLI.

The agent-facing instructions are in `skills/agent-wallet/SKILL.md` in the Agent Wallet source repository.
