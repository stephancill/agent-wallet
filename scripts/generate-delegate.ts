import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

const schema = z.object({
  bytecode: z.object({ object: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
  deployedBytecode: z.object({
    object: z.string().regex(/^0x[0-9a-fA-F]+$/),
    immutableReferences: z.record(
      z.string(),
      z.array(z.object({ start: z.number().int(), length: z.number().int() })),
    ),
  }),
});

const artifact = schema.parse(
  JSON.parse(await readFile("out/AgentAccount.sol/AgentAccount.json", "utf8")),
);
const references = Object.values(artifact.deployedBytecode.immutableReferences);
if (references.length !== 1 || references[0].some(({ length }) => length !== 32)) {
  throw new Error("Expected one 32-byte parent immutable in AgentAccount");
}
await writeFile(
  "shared/delegate-artifact.json",
  `${JSON.stringify({ creationCode: artifact.bytecode.object, runtimeCode: artifact.deployedBytecode.object, parentReferences: references[0] })}\n`,
);
