# Agent Wallet: agent instructions

## Project

Agent Wallet is a Bun CLI, dedicated browser frontend, and HTTP service for a locally keyed EVM agent account; a public CLI package name and agent skill have not yet been chosen. Agent Wallet owns human-wallet onboarding and durable association/rescue-artifact storage. Transaction preparation/broadcasting and recovery are planned but not implemented. `../txlink` is optional for short-lived ordinary payment approval links, not account state or rescue custody. The repository also contains a standalone, parent-specific EIP-7702 delegate, fork runners, tests, and planning documents. Read `docs/onboarding.md` for the current local flow and its release gates.

## Before making changes

1. Read `docs/engineering-handover.md` for the agreed product behavior, protocol constraints, and delivery gates.
2. Read `docs/implementation-notes.md` for the current implementation state and previous decisions.
3. Check `../txlink/AGENTS.md`, `../txlink/README.md`, and `../txlink/skills/txlink/SKILL.md` before changing txlink or its agent-facing API.
4. Verify assumptions against the applicable EIPs and real chain behavior before treating a recovery path as implemented.

## Working rules

- Keep the agent's signing key local. Never send private key material to Agent Wallet's service, txlink, or include it in links, logs, or API responses.
- Use explicit HTTP APIs for agent onboarding and operations; do not silently substitute browser wallet RPC forwarding for server-side behavior.
- Preserve the chain-agnostic nonce-0 rescue authorization until it is superseded by **verified onchain activation** on each chain. Do not send a plain nonce-0 transaction from the agent on an unactivated chain.
- The delegate's constructor embeds the parent address. Compute its parent-specific CREATE2 address only after the parent is known and verified; sign the nonce-0 rescue authorization for that address after consent. There is no initialization proof or universal delegate address.
- Fail loudly when chain support, deterministic deployment, authorization, or signature validation prerequisites are missing. Do not claim rescue is available based solely on a stored signature.
- Use a bespoke Agent Wallet approval URL and purpose-built authenticated, durable API records. An approval-link token can access only its short-lived attempt; parent consent and rescue access require fresh verifiable signatures. Do not use txlink's generic stored-request status as proof of consent or rescue availability.
- Follow the existing repository conventions as code is added. For TypeScript/JavaScript, use named object parameters, Zod for external input validation, viem for EVM interactions, and the configured linter/formatter. Check the package manager before dependency commands; prefer Bun when no manager is specified.
- Keep documentation in `docs/`. Before committing changes, update `docs/implementation-notes.md` with what was actually implemented and verified. Do not put personal information in implementation notes.
- If this project introduces its own planning documents, read them before changing behavior and keep them consistent with the handover and implementation notes.
