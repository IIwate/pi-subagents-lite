import { randomUUID } from "node:crypto";
import type {
  IdGenerator,
  RuntimeClock,
  RuntimeScheduler,
} from "../../modules/subagent-runtime/public.js";

const AGENT_ID_PREFIX_LENGTH = 17;

export function createSystemClock(): RuntimeClock {
  return { now: () => Date.now() };
}

export function createCryptoIdGenerator(): IdGenerator {
  return {
    nextId: () => randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH),
  };
}

export function createNodeScheduler(): RuntimeScheduler {
  return {
    interval(ms, callback) {
      const handle = setInterval(callback, ms);
      handle.unref?.();
      return { clear: () => clearInterval(handle) };
    },
    timeout(ms, callback) {
      const handle = setTimeout(callback, ms);
      handle.unref?.();
      return { clear: () => clearTimeout(handle) };
    },
  };
}
