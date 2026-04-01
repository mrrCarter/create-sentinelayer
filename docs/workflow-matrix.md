# Workflow Matrix: create-sentinelayer vs sentinelayer-api

## create-sentinelayer (this repo)

This repository is a Node.js npm CLI package, not a long-running service.

Required workflows here:
- Omar Gate PR deep scan (`.github/workflows/omar-gate.yml`)
- Quality gates (`.github/workflows/quality-gates.yml`)
- Release automation and publish (`.github/workflows/release-please.yml`, `.github/workflows/release.yml`)
- Omar review watchdog (`.github/workflows/omar-review-watchdog.yml`)

Not applicable here:
- ECS deploy workflows
- Alembic DB migration workflows
- Runtime worker deployment workflows
- Service rollback drill workflows

## sentinelayer-api (service repo)

Service repo owns:
- ECS deployments
- DB migrations (Alembic)
- Runtime worker deployment
- Rollback workflows
- Runtime telemetry pipelines that feed dashboard operational metrics

## Metrics and dashboard note

Workflow checks in this CLI repo validate build/release/security gating. They do not by themselves feed runtime production metrics to the admin dashboard. Dashboard runtime metrics come from deployed service telemetry in `sentinelayer-api` + `sentinelayer-web` integration.
