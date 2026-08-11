# Model access decision tables

This table defines the combinations that must be settled before Model access implementation. The table is a decision specification, not a copy of the schema.

| Question | Effective rule |
|:--|:--|
| Is the requested model the exact Parent model? | Use the Agent type's Parent model access. No alternate authorization is needed, but an explicit denial still blocks the call. |
| Is the requested model an alternate? | Model routing, explicit Provider access, Agent/provider or exact-model access, Pi availability, explicit selection, and Model scope must all allow it. |
| Provider disabled or credentials unavailable? | Saved rules remain dormant and reversible. They do not authorize a call and are not destructively removed. |
| Provider rule is All models? | Current and future models from that explicitly enabled Provider are eligible when all other checks pass. |
| Provider rule is Selected models? | Only the saved exact model set is eligible. Switching from All models snapshots the visible current set. |
| Model is outside scope? | It is not selectable. Saved rules remain unchanged and are not cleaned as unavailable rules. |
| Model is unavailable in the reliable catalogue? | An exact unavailable rule may be batch-cleaned only by an explicit cleanup action. |
| Thinking override exists? | The exact Agent type/model override supplies allowed and default levels. |
| Thinking override is absent? | Parent default use inherits the parent session's current level when omitted; non-parent use follows Pi-supported normalization of `high`. |
| Scope pins Thinking? | The pinned level is the only effective allowed/default level and does not rewrite saved policy. |
| Quick model setup fails? | No routing, Provider, Agent/model, or Thinking partial update remains. |

Every row needs at least one acceptance example and one public-surface test before its implementation slice is approved.
