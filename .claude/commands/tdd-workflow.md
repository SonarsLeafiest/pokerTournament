---
name: tdd-workflow
description: TDD red-green-refactor cycle and testing philosophy for sonar. Use when: writing tests, implementing new features with TDD, following red-green-refactor, setting up test files, choosing what to test, understanding coverage targets, test isolation, naming conventions, or debugging test failures.
---

# TDD Workflow & Testing Philosophy

## Red-Green-Refactor (TDD)

All new code — features, bug fixes, and refactors — MUST follow a red-green-refactor cycle. Tests are written **before** production code, not after.

**The cycle:**

1. **Red** — Write the test(s) first. Run them. Confirm they fail for the *expected* reason (wrong status code, missing data, thrown error) — not a wiring or setup error. If the failure is unexpected, fix the test before proceeding.
2. **Green** — Write the minimum production code to make the tests pass. Run the tests again and confirm green.
3. **Refactor** — Clean up production code and tests with confidence that the suite catches regressions. Re-run tests after any refactor.

**Scope guidance:**

| **Scenario** | **TDD scope** |
| --- | --- |
| **Bug fix** | Write a single failing repro test → fix → green. Purest TDD. |
| **New service method** | Write unit tests for the method (happy + error paths) → implement → green. |
| **New endpoint / controller** | Write the integration tests for one `describe()` block (one HTTP method) → implement controller + service → green. Then move to the next endpoint. |
| **Batch of related endpoints** | Scaffold the test file with module setup + one smoke test. Confirm it fails for the right reason. Then iterate endpoint-by-endpoint using the cycle above. |

**Rules:**

- **Never skip the red step.** If a test passes immediately, it is not testing new behavior — delete or re-examine it.
- **Commit at green.** Each green state is a safe commit point. Prefer small, frequent commits over large batches.
- **Integration test setup is not "red."** Wiring up `createTestApp`, seed data, and auth tokens is scaffolding. The red step begins once setup is working and you write the first real assertion.
- **Refactor does not change behavior.** If a refactor requires new tests, restart the cycle.

## Testing Requirements

**What MUST be tested:**

| **Test type** | **Tool** | **Scope** | **Package** |
| --- | --- | --- | --- |
| **Unit** | Vitest | All services, composables, utilities, pure functions | All |
| **Integration** | NestJS testing module + supertest | All API endpoints, guards, interceptors | `@sonar/api` |
| **E2E** | Playwright | Critical user flows (auth, checkout, admin actions) | Root |

**What must NOT be tested here:**

- **No component tests** in this repo. Component tests live in the `@nonsuch/component-library` repo.

**Testing conventions:**

- Test files are co-located: `foo.service.ts` → `foo.service.spec.ts`
- Integration tests go in `packages/api/test/`
- E2E tests go in `tests/e2e/` at the repo root
- Use factories/fixtures for test data, never hardcode IDs or timestamps
- Test database uses `prisma migrate reset` + seed for setup/teardown

## Coverage Targets

| **Scope** | **Target** | **Rationale** |
| --- | --- | --- |
| Services, utilities, pure functions | **≥ 90% line coverage** | Core business logic must be thoroughly verified |
| Controllers / endpoints | **≥ 80% line coverage** | Integration tests cover the HTTP layer and routing |
| Overall package | **≥ 85% line coverage** | Floor for confidence in refactoring |

## Test Isolation Principles

1. **Unit tests mock at infrastructure boundaries.** Mock Redis, Prisma, and external APIs. Never make real network calls in unit tests.
2. **Integration tests use real infrastructure.** Tests that spin up the NestJS app should use the real Redis and PostgreSQL instances (via Docker). This catches serialization bugs, query errors, and config issues that mocks hide.
3. **One assertion focus per test.** Each test should verify one behavior. Multiple `expect()` calls are fine if they all assert on the same result.
4. **No shared mutable state across tests.** Each test sets up its own fixtures. Use `beforeEach` for per-test setup, not `beforeAll` (unless the setup is truly read-only).
5. **Tests must be deterministic.** No reliance on wall-clock time, random values, or external service availability. Use fixed UUIDs and timestamps in fixtures.

## Naming Conventions

- `should <expected behavior> when <condition>` — e.g., `should return 400 when email is invalid`
- Group by method or endpoint in `describe()` blocks — e.g., `describe('POST /auth/passkey/login-options', ...)`

## What to Test

- **Happy path** — The expected successful flow
- **Validation failures** — Missing fields, wrong types, malformed values
- **Auth failures** — Missing token, expired token, wrong role
- **Error paths** — Service throws, infrastructure unavailable, not found
- **Edge cases** — Empty arrays, null/undefined optionals, boundary values
