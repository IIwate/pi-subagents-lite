import { Check } from "typebox/value";
import {
  ModelAccessFragmentSchema,
  type ModelAccessFragment,
} from "../contracts/model-access-contracts.js";

export function requireFragment(routing: unknown): ModelAccessFragment {
  if (!Check(ModelAccessFragmentSchema, routing)) {
    throw new TypeError("Model access fragment is invalid.");
  }
  return routing;
}

/**
 * Persist and settings commit copy whatever this layer returns. An unchecked
 * fragment is how a half-valid mutation becomes the saved policy. Fail
 * closed here so bootstrap's JSON round-trip cannot launder a broken shape.
 * Revisit if a dedicated result envelope replaces throw-on-invalid.
 */
export function outboundFragment(fragment: ModelAccessFragment): ModelAccessFragment {
  if (!Check(ModelAccessFragmentSchema, fragment)) {
    throw new TypeError("Model access fragment does not match its contract.");
  }
  return fragment;
}
