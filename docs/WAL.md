# WAL substrate

cc-judge writes a per-run write-ahead log (WAL) under the configured results directory. This doc covers the file layout, durability guarantees, the recovery sweep, and the contract you must hold to as a caller.

## File layout

Under `<resultsDir>/`:

```
inflight/<runId>.jsonl      ← live runs; appended to until close()
inflight/<runId>.jsonl.lock ← proper-lockfile sidecar; deleted on close
runs/<runId>.jsonl          ← finalized runs; rename target
```

`inflight/` and `runs/` MUST live on the same filesystem so `fs.renameSync` is atomic. Cross-filesystem layouts (e.g., bind-mounted `runs/`) silently degrade to non-atomic copy-then-delete on some platforms.

## Lifecycle

```
openRunLog(runId, paths)
  → handle.append(line)*           (any number, in any order, monotonic seq)
  → handle.close({status, reason}) (writes outcome line, fsyncs, renames inflight → runs)
```

`Effect.scoped` on `openRunLog`'s caller scope guarantees `close()` runs even if the user code throws or is interrupted; the scope-release path closes with `status: failed, reason: "scope released without explicit close"`.

`close()` is idempotent — calling it twice is safe.

## Durability guarantees

**At `close()`:** the WAL file is fsynced to disk and renamed atomically to `runs/`. After `close()` returns successfully, the run is durable.

**Per `append()`:** the line is `fs.appendFileSync`'d (no per-line fsync, by design — fsync per event would tank throughput). The kernel buffers the write; in normal operation the line is on disk within milliseconds.

### Partial-line loss window

If the process is killed between the user-space `appendFileSync` call returning and the kernel flushing the page cache to disk, that single event line is lost. The WAL file may also contain a truncated final line.

**On read (e.g., `cc-judge inspect`):** truncated JSON lines are silently skipped (the parser catches the JSON.parse error and moves on). The seq-gap check then surfaces the missing event as a stderr warning, so the loss is observable but not fatal to the read.

**On recovery:** the recovery sweep handles run-level loss (an inflight file that has no outcome line gets a final `kind: "orphaned"` marker appended). A truncated mid-run line still reads as a seq gap.

The cost of guaranteeing zero per-line loss would be a per-event `fs.fsync`. For a 1000-event run that's ~1000 fsync calls; each is 1-10ms on typical disks. We chose throughput over single-event durability. If a future caller needs the stricter guarantee, the call site can wrap the append in a sync barrier.

## Recovery sweep

`recoverInflightSweep(paths)` scans `inflight/` on startup and reconciles each file:

| File state | Recovery action | Outcome |
|---|---|---|
| Has outcome line | fsync + rename to `runs/` | `completed` |
| No outcome line, lockfile released | append `kind: "orphaned"` marker (seq=-1), fsync, rename | `orphaned` |
| No outcome line, lockfile held | leave alone | `locked` (assume live writer) |
| Read failure | best-effort skip | `failed` |

The orphaned marker uses `seq: -1` as a sentinel so it never collides with the monotonic event sequence. Consumers (e.g., `inspect`) can identify orphaned runs by `kind: "orphaned"` regardless of the sentinel.

## Line schema (internal, v1)

Each line is one JSON object:

```json
{
  "v": 1,
  "runId": "<string>",
  "seq": 0,
  "ts": 1714512345678,
  "kind": "event" | "turn" | "phase" | "context" | "workspace-diff" | "outcome" | "orphaned",
  "payload": <kind-specific>
}
```

This schema is **internal**. It may evolve (`v` will bump on breaking shape changes) and downstream consumers should NOT parse the JSONL files directly — use `cc-judge inspect` or the recovery-sweep API. The `WalLine` type is exported from the SDK for testability, not as a stable contract.

## Caller contract

1. **Single-writer per `runId`.** Two writers (whether two fibers in the same process or two `cc-judge` invocations) appending to the same `runId` produce undefined behavior — duplicate seqs, interleaved bytes. The in-process semaphore guards concurrent fibers within one `openRunLog` handle; nothing guards across handles. Callers MUST guarantee unique `runId` per invocation. The default `runId` is a `randomUUID()`, which trivially satisfies this; only override the default if you have reason and can guarantee uniqueness.

2. **`close()` before scope release.** The scope-release path WILL close the WAL with `status: failed`, but explicit close gives you control over the terminal status and the `reason` string.

3. **Don't read in-flight WAL files directly.** Use `cc-judge inspect <runId>` or wait for `close()` to finalize. In-flight files may have truncated tails or unfinalized state.

## Operator monitoring

WAL hot-path failures (mkdir, lock, append, fsync, rename, post-close-append) are routed through a structured stderr log keyed `cc-judge:wal`. Each line is single-line JSON with at minimum `level: "warn"`, `source`, `event`, `ts`, and event-specific detail. Examples:

```json
{"level":"warn","source":"cc-judge:wal","event":"append.failed","ts":...,"runId":"...","kind":"event","seq":...,"error":"..."}
{"level":"warn","source":"cc-judge:wal","event":"append.after-close","ts":...,"runId":"...","kind":"event","attemptedAt":...,"payloadPreview":"..."}
{"level":"warn","source":"cc-judge:wal","event":"rename.failed","ts":...,"runId":"...","error":"..."}
```

Pipe stderr through your log aggregator and alert on `source == "cc-judge:wal"` to catch silent degradation. Because of Invariant #12 (emission never affects verdict), these warnings are the only signal that the WAL had trouble — the run itself will still produce a verdict.
