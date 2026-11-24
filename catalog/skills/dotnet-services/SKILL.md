---
description: Build ASP.NET Core services: dependency injection, async, EF Core, validation, options and tests
profile: standard
languages: csharp
tags: csharp, dotnet, backend
---

# .NET services

Use in solutions with `.csproj` / `.sln` files.

## Async and DI
- `async` all the way: never `.Result` or `.Wait()` on tasks (deadlocks and thread starvation). Pass `CancellationToken` through.
- Register services with the right lifetime: `DbContext` is scoped; do not inject scoped services into singletons.
- Bind configuration to typed options (`IOptions<T>`) with validation on start (`ValidateDataAnnotations().ValidateOnStart()`).

## EF Core
- Migrations via `dotnet ef migrations add`; review the generated code and the SQL (`dotnet ef migrations script`).
- Use `AsNoTracking()` for read-only queries and projections (`Select`) to avoid loading whole entities.
- Watch for N+1 with lazy loading; prefer explicit `Include` or projections.
- Never build SQL strings; `FromSqlInterpolated` parameterizes, `FromSqlRaw` with concatenated input does not.

## API
- Validate input (data annotations or FluentValidation) and return `ProblemDetails` for errors.
- Authorization with policies and resource-based checks for object ownership.
- Enable nullable reference types and treat warnings as errors in new projects.

## Verify
`dotnet build -warnaserror`, `dotnet test`, and `dotnet format --verify-no-changes` if the repo uses it.
