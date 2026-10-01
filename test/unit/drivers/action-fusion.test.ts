import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  assertUnchangedBeforeCommand, type FusedFileQueue, THEN_RUN_FAILED, THEN_RUN_REJECTED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED,
  type ThenRunInput, wrapMutationWithThenRun,
} from "../../../src/drivers/action-fusion.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function shellOutcome(text: string, isError: boolean): AgentToolCallOutcome {
  return { toolCall: { type: "toolCall", id: "nested", name: "bash", arguments: {} }, result: textResult(text), isError };
}

function fakeWriteTool(directory: string, failure?: string): AgentTool<any> {
  return {
    name: "write",
    label: "Write",
    description: "Write a file",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id: string, args: { path: string; content: string }) => {
      if (failure) throw new Error(failure);
      writeFileSync(join(directory, args.path), args.content);
      return textResult(`Wrote ${args.path}`);
    },
  } as AgentTool<any>;
}

describe("Action fusion", () => {
  let resources: TestHarness;
  let directory: string;
  let queue: FusedFileQueue;
  beforeEach(() => { resources = createTestHarness(); directory = resources.createTempDir("pi-action-fusion-"); queue = new Map(); });
  afterEach(() => resources.dispose());

  const wrap = (tool: AgentTool<any>, shell: { available(): string | undefined; calls: ThenRunInput[]; outcome?: AgentToolCallOutcome }) =>
    wrapMutationWithThenRun(tool, {
      cwd: directory, queue,
      shell: {
        available: () => shell.available(),
        run: async (_id, _name, input) => { shell.calls.push(input); return shell.outcome ?? shellOutcome("5 passed", false); },
      },
    });

  it("adds the optional then_run parameter and passes plain calls through untouched", async () => {
    const shell = { available: () => "bash", calls: [] as ThenRunInput[] };
    const fused = wrap(fakeWriteTool(directory), shell);
    expect(fused.parameters.properties).toHaveProperty("then_run");
    const result = await fused.execute("call-1", { path: "a.txt", content: "hello" }, undefined, undefined);
    expect(result.content).toEqual([{ type: "text", text: "Wrote a.txt" }]);
    expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("hello");
    expect(shell.calls).toEqual([]);
  });

  it("skips the command when the mutation fails and reports the skip", async () => {
    const shell = { available: () => "bash", calls: [] as ThenRunInput[] };
    const fused = wrap(fakeWriteTool(directory, "disk full"), shell);
    await expect(fused.execute("call-1", { path: "a.txt", content: "x", then_run: { command: "bun test" } }, undefined, undefined))
      .rejects.toThrow(THEN_RUN_SKIPPED);
    expect(shell.calls).toEqual([]);
  });

  it("runs the command in the same call and merges both observations", async () => {
    const shell = { available: () => "bash", calls: [] as ThenRunInput[] };
    const fused = wrap(fakeWriteTool(directory), shell);
    const result = await fused.execute("call-1", { path: "a.txt", content: "hello", then_run: { command: "bun test", timeout: 30 } },
      undefined, undefined);
    expect(shell.calls).toEqual([{ command: "bun test", timeout: 30 }]);
    expect(result.content.map(block => block.type === "text" ? block.text : "")).toEqual(["Wrote a.txt", `${THEN_RUN_SUCCEEDED}\n5 passed`]);
  });

  it("keeps the mutation but fails visibly when the command errors", async () => {
    const shell = { available: () => "bash", calls: [] as ThenRunInput[], outcome: shellOutcome("2 failed", true) };
    const fused = wrap(fakeWriteTool(directory), shell);
    const error = await fused.execute("call-1", { path: "a.txt", content: "hello", then_run: { command: "bun test" } }, undefined, undefined)
      .catch((thrown: unknown) => thrown) as Error;
    expect(error.message).toContain(THEN_RUN_FAILED);
    expect(error.message).toContain("Wrote a.txt");
    expect(error.message).toContain("2 failed");
    expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("hello");
  });

  it("rejects the command when the accepted policy grants no active shell tool", async () => {
    const shell = { available: () => undefined, calls: [] as ThenRunInput[] };
    const fused = wrap(fakeWriteTool(directory), shell);
    await expect(fused.execute("call-1", { path: "a.txt", content: "hello", then_run: { command: "bun test" } }, undefined, undefined))
      .rejects.toThrow(THEN_RUN_REJECTED);
    expect(shell.calls).toEqual([]);
    expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("hello");
  });

  it("refuses to run the command when the file changed after the fused mutation", async () => {
    const target = join(directory, "a.txt");
    writeFileSync(target, "before");
    await expect(assertUnchangedBeforeCommand(target, async () => writeFileSync(target, "tampered"))).rejects.toThrow(THEN_RUN_SKIPPED);
    await expect(assertUnchangedBeforeCommand(target)).resolves.toBeUndefined();
  });

  it("serializes fused operations on one file through the shared queue", async () => {
    const order: string[] = [];
    const tool: AgentTool<any> = {
      name: "write", label: "Write", description: "Write a file",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id: string, args: { path: string; content: string }) => {
        writeFileSync(join(directory, args.path), args.content);
        order.push(`mutate:${args.content}`);
        return textResult(`Wrote ${args.content}`);
      },
    } as AgentTool<any>;
    const fused = wrapMutationWithThenRun(tool, {
      cwd: directory, queue,
      shell: {
        available: () => "bash",
        run: async (_id, _name, input) => { order.push(`run:${input.command}`); return shellOutcome("ok", false); },
      },
    });
    await Promise.all([
      fused.execute("call-1", { path: "a.txt", content: "first", then_run: { command: "one" } }, undefined, undefined),
      fused.execute("call-2", { path: "a.txt", content: "second", then_run: { command: "two" } }, undefined, undefined),
    ]);
    // Each fused pair is atomic: no second mutation may interleave between a mutation and its command.
    expect(order).toEqual(["mutate:first", "run:one", "mutate:second", "run:two"]);
  });
});
