# Revisor catalog PR conflicted with the current service definition

- Date: 2026-08-18
- Status: fixed in working tree
- Area: Excubitor catalog / Ostiarius startup configuration
- Severity: deployment-blocking

## Summary

Revisor local PR #631 could not merge because its newly added `excubitor.catalog.yaml` conflicted with a
newer catalog that already defines the face sidecar and Ostiarius service.

## Evidence

Revisor reported: `The head conflicts with the current 'main' in 1 file(s): "excubitor.catalog.yaml"`.
`server/config.ts` requires both `CERNERE_BASE_URL` and `CERNERE_SERVICE_TOKEN`, while the current
Ostiarius service catalog listed only the base URL as required.

## Cause

The original catalog fragment was authored before the later sidecar catalog expansion and therefore
attempted to add a second Ostiarius service definition instead of updating the existing one.

## Fix Requirements

- Preserve the existing face-sidecar and Ostiarius service definitions.
- Declare every Cernere startup value required by `loadConfig()`, including `CERNERE_SERVICE_TOKEN`.
- Retain the base branch's `.revisor-version` metadata.

## Verification

Revisor must re-review the rebased catalog branch and run its registered checks before merge.
