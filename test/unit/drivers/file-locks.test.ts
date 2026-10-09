import { afterEach, beforeEach, expect, it } from "vitest";
import { FileLockManager } from "../../../src/drivers/file-locks.js";
import { createTestHarness, type TestHarness } from "../../support/harness.js";

let resources: TestHarness;
beforeEach(() => { resources = createTestHarness(); });
afterEach(() => resources.dispose());

it("cancels waiting leases and ignores a stale release while another operation owns the file", async () => {
  const locks = new FileLockManager();
  const abort = new AbortController();
  resources.onDispose(() => abort.abort());
  const first = await locks.acquire("file");
  resources.onDispose(() => locks.release(first));
  const cancelled = locks.acquire("file", abort.signal);
  const rejected = expect(cancelled).rejects.toThrow("Withdrawn");
  abort.abort(new Error("Withdrawn"));
  await rejected;
  const secondPending = locks.acquire("file");
  await locks.release(first);
  const second = await secondPending;
  resources.onDispose(() => locks.release(second));
  let acquired = false;
  const thirdPending = locks.acquire("file").then(id => { acquired = true; return id; });
  await locks.release(first);
  expect(acquired).toBe(false);
  await locks.release(second);
  const third = await thirdPending;
  resources.onDispose(() => locks.release(third));
  expect(acquired).toBe(true);
});
