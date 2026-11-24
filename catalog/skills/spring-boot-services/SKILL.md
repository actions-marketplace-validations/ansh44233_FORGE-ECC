---
description: Build Spring Boot services: layering, transactions, JPA pitfalls, validation, security and tests
profile: standard
languages: java
tags: java, spring, backend
---

# Spring Boot services

Use in Maven or Gradle projects that depend on Spring Boot. Check the Boot version (2.x uses `javax.*`, 3.x uses `jakarta.*`).

## Structure
Controller (HTTP and validation) → service (business rules, transactions) → repository (data access). Do not put business logic in controllers or entities.

## Transactions and JPA
- `@Transactional` on service methods. It only works on public methods called from another bean; self-invocation skips the proxy.
- Avoid N+1 queries: fetch joins, `@EntityGraph`, or DTO projections. Turn on SQL logging in tests to check.
- Keep `spring.jpa.open-in-view=false` and load what the view needs inside the transaction.
- Schema changes through Flyway or Liquibase; never `ddl-auto=update` in production.
- Do not expose entities directly in responses; map to DTOs or records.

## Validation and errors
- `@Valid` on request bodies with Bean Validation annotations; handle `MethodArgumentNotValidException` in a `@RestControllerAdvice` that returns problem details.
- Constructor injection only (no field `@Autowired`), so dependencies are explicit and testable.

## Security
Spring Security with method-level checks for object ownership, CSRF on for session-based apps, secrets from the environment or a vault, actuator endpoints restricted.

## Tests
Unit tests with plain JUnit 5 and Mockito for services; `@WebMvcTest` for controllers; `@DataJpaTest` or Testcontainers for repositories against a real database.

## Verify
`./mvnw verify` or `./gradlew check`, whichever the repo uses.
