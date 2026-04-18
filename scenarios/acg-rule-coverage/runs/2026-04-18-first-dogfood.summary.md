# cc-judge report

- total: 1
- passed: 0
- failed: 1
- avg latency: 7265ms
- artifacts: ./eval-results

## Runs

| scenario | run | verdict | severity | latency | retries |
| --- | --- | --- | --- | --- | --- |
| acg-rule-coverage.no-raw-throw-to-tagged | 1 | FAIL | critical | 7265ms | 0 |

## Failures

### acg-rule-coverage.no-raw-throw-to-tagged #1
- reason: The agent failed to execute — it returned an error message ('When using --print, --output-format=stream-json requires --verbose') instead of performing the refactor. No changes were made to src/validate.ts, so none of the validation checks are met.
- issues:
  - [critical] src/validate.ts does not define a class extending Data.TaggedError (no edits were made)
  - [critical] src/validate.ts does not use Effect.fail with a tagged error instance
  - [critical] The raw 'throw new Error' remains in the validate function body
  - [critical] Agent did not produce any output or file changes due to a CLI invocation error
