---
description: Build and change AWS Lambda services: handler design, IAM least privilege, cold starts, retries and observability
profile: full
tags: cloud, aws, devops, backend
---

# AWS serverless

Use when writing or changing Lambda functions and their event sources.

## Handlers
- Keep handlers thin: parse and validate the event, call domain code, then return. Initialize clients outside the handler so they are reused across invocations.
- Make handlers idempotent. SQS, EventBridge and async invokes deliver at least once, so use an idempotency key (for example a DynamoDB conditional write).

## Failure handling
Configure DLQs or on-failure destinations, partial batch responses for SQS (`batchItemFailures`), and timeouts lower than the event source's visibility timeout.

## IAM
One role per function with only the actions and resources it needs. No `*` in production policies. Read secrets from Secrets Manager or Parameter Store at init, and cache them.

## Performance and cost
Right-size memory, which also scales CPU (measure it). Keep deployment packages small, and use provisioned concurrency or SnapStart only where cold starts matter.

## Observability
Use structured JSON logs with a request id, metrics for errors, throttles and duration, tracing (X-Ray or OpenTelemetry), and alarms on the error rate and DLQ depth.

## Infrastructure
Define everything as code (CDK, SAM or Terraform). Do not change functions in the console.

## Verify
Unit tests for domain code, an invocation with a recorded real event, and a deploy to a non-production stage with a smoke test.
