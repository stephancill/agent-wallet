import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { consentTypedData } from "../shared/protocol";

const origin = process.env.AGENT_WALLET_URL ?? "http://127.0.0.1:8787";
const home = await mkdtemp(
  "/private/var/folders/sz/481762vd757_ff4593f9hyyr0000gn/T/opencode/agent-wallet-cli-",
);
const child = Bun.spawn(["bun", "cli/index.ts", "login"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, AGENT_WALLET_HOME: home, AGENT_WALLET_URL: origin },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  let output = "";
  let resolveLink: (value: { agent: string; url: URL }) => void = () => {};
  const link = new Promise<{ agent: string; url: URL }>((resolve) => {
    resolveLink = resolve;
  });
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      const agent = output.match(/Agent: (0x[a-fA-F0-9]{40})/);
      const url = output.match(/https?:\/\/[^\s]+\/approve\/aw_[a-f0-9]{32}\?token=0x[a-f0-9]+/);
      if (agent && url) resolveLink({ agent: agent[1], url: new URL(url[0]) });
    }
  })();
  const { agent, url } = await Promise.race([
    link,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("CLI did not print approval URL")), 15_000),
    ),
  ]);
  const parent = privateKeyToAccount(generatePrivateKey());
  const id = url.pathname.split("/")[2];
  const token = url.searchParams.get("token");
  const previewResponse = await fetch(
    `${origin}/api/attempts/${id}/preview?token=${token}&parent=${parent.address}&chainId=1`,
  );
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()) as {
    consent: Parameters<typeof consentTypedData>[0];
  };
  const signature = await parent.signTypedData(
    consentTypedData({ ...preview.consent, chainId: 1 }),
  );
  const approved = await fetch(`${origin}/api/attempts/${id}/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, parent: parent.address, chainId: 1, signature }),
  });
  assert.equal(approved.status, 200, await approved.text());
  assert.equal(await child.exited, 0, await new Response(child.stderr).text());
  await reading;
  assert.match(output, /ready/);
  const account = (await fetch(`${origin}/api/accounts/${agent}`).then((response) =>
    response.json(),
  )) as { status: string };
  assert.equal(account.status, "ready");
  console.log("CLI-to-browser-API onboarding passed with ephemeral accounts");
} finally {
  child.kill();
  await rm(home, { recursive: true, force: true });
}
