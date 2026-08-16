## Scope

- Requirement IDs:
- Owning module:
- Vertical slice:
- Replaced path removed in this change:

## Documentation and contracts

- [ ] The approved PRD and module `docs/` are linked.
- [ ] The domain terms match `CONTEXT.md`.
- [ ] Cross-module data uses a TypeBox schema and JSON round-trip coverage.
- [ ] No module README was added as a second documentation entry point.

## TDD evidence

- [ ] One failing public-seam test was added before implementation.
- [ ] The focused test passes with independent expected values.
- [ ] External doubles are limited to platform and persistence boundaries.
- [ ] The replaced path and obsolete internal mocks were removed in the same slice.

## S.U.P.E.R. review

- [ ] S: every new file and function has one responsibility.
- [ ] U: input flows to processing to output; no new cycle or reverse dependency exists.
- [ ] P: every cross-module boundary is schema-defined and serializable.
- [ ] E: no hardcoded path, URL, key, or runtime configuration was introduced.
- [ ] R: the replacement matrix row remains local to the replaced part.
- [ ] All ten project S.U.P.E.R. checks pass.

## Verification

- [ ] `bun run typecheck`
- [ ] Relevant checks selected by `pre-push-checks` are listed below
- [ ] Architecture or document-link checks were run when affected
- [ ] Full-suite CI status is recorded below

Relevant local commands and outcomes:

-

Full-suite CI: pending
