# dsh-tool-protobuf

Read, audit and diff Protocol Buffer definitions from chat — **without installing protoc.**

Most `.proto` work in an agent loop is reading, not compiling: *what is in this file, what changed between these two versions, is this number free, did anyone reuse a field number.* A compiler is the wrong tool for all four — it answers "does this compile", which is rarely the question, and it needs a toolchain you may not have on the machine you are standing on.

This plugin parses the `.proto` grammar in-process. No protoc, no Python, no network, no external dependency.

## Install

```bash
dsh plugin --profile <your-profile> link /path/to/dsh-tool-protobuf
```

Then set where it is allowed to read from — `workDir` is a boundary, not a hint:

```yaml
# in your profile's cordis.patch.yml
- id: tool-protobuf
  config:
    workDir: C:/work/my-service/proto
```

## The six tools

| Tool | The question it answers |
| --- | --- |
| `protobuf_status` | Is a real protoc on this machine, and what `.proto` files exist under `workDir`? |
| `protobuf_outline` | What is in this file — syntax, package, imports, and the shape of everything declared. |
| `protobuf_describe` | What is in this one message or service — every field with its number, type and wire cost; every RPC with its streaming shape and gRPC path. |
| `protobuf_diff` | What changed between v1 and v2 — classified `breaking` / `risky` / `additive`. |
| `protobuf_audit` | What is wrong with this file that a compiler would have let through. |
| `protobuf_next_number` | Which field numbers are free here, or is *this* number safe to use. |

## Why `protobuf_diff` is the reason to install this

The wire format is keyed by **field number**, not by name. That single fact is behind almost every protobuf incident:

- Rename a field, keep the number → old data still decodes. Harmless.
- Rename a field, **change** the number → the name still matches, the bytes do not. Old data lands in a different field, or nowhere.
- Delete a field without reserving its number → the next person reuses it for a different type, and old data is silently reinterpreted as garbage.
- Change `int32` to `string` at the same number → the bytes are read as the wrong type.

`protobuf_diff` names each of these instead of leaving you to spot them:

```
verdict: incompatible (8 breaking, 1 risky, 5 additive)
  [breaking] type-changed: field amount_minor (2) changed type int64 -> string
  [breaking] number-reused: field 9 was "total_minor" and is now "line_items_summary" — old clients will decode new bytes into the old field
  [breaking] field-added: new field customer_detail = 14 lands in a previously reserved range
  [breaking] number-changed: field "total_minor" moved from 9 to 30 — the name is the same but the wire format is keyed by number, so old data no longer decodes into it
  [breaking] field-removed: field currency = 10 removed but 10 was NOT reserved — reserve it now or it will be reused
  [risky]    field-removed: field due_at = 6 removed and its number is reserved; consider reserving the name too
  [additive] field-added: new field currency_display = 20
```

Every message is written to be actionable. `number-reused` says what will happen, not just that a number collided. `field-removed` distinguishes a safe removal (number reserved) from a future corruption bug (number left free) — and tells you to reserve it.

## Why `protobuf_audit` catches what the compiler will not

`protoc` accepts plenty of definitions that are technically legal and practically a trap:

```
broken.proto: 10 errors, 4 warnings
  [error] Dup.b: field number 1 is already used by "a"
  [error] Dup.c: field number 19005: 19000-19999 is reserved by protobuf itself
  [error] Dup.d: field number 0: below 1
  [error] Dup.e: field number 536870912: above 536870911 (2^29-1)
  [error] ReservedClash.bad: field number 5 is declared reserved in this message
  [error] BadMap.nope: map key type "bytes" is not allowed
  [error] BadMap.dangling: map value type "MissingType" is not a scalar and is not defined in this file, and the file imports nothing
  [error] NoZero: proto3 enums must have a zero value (the default)
  [error] Aliased.ALIASED_B: enum value 0 duplicates "ALIASED_A"
  [warn] Gappy: unused field numbers 2 sit below the high-water mark 3 and are not reserved — a future edit may reuse one and break compatibility
```

The `warn` line is the one worth reading: a gap below the high-water mark means somebody deleted a field without reserving it, and the next change to that number is a data corruption bug waiting for a release. Note that a message with a wide gap reports the gaps **summarised in one finding**, not one line per number — a file with 4,095 holes produces one warning, not 4,095.

## Independent verification

The honest problem with a hand-written parser is that it can agree with itself. This plugin's test suite is therefore gated on a **second opinion from a compiler nobody here wrote**:

```
$ PROTOC_PYTHON=/path/to/python-with-grpcio-tools node _test/run-all.mjs
independent compiler: C:/Users/.../python.exe

PASS  test-logic.mjs           # tests 71  # pass 71  # fail 0
PASS  test-integration.mjs     # tests 33  # pass 33  # fail 0
PASS  test-e2e.mjs             # tests 9   # pass 9   # fail 0

all suites passed
```

The e2e suite asserts two things against the real `protoc`: that it **accepts** every well-formed fixture this parser accepts, and that it **rejects** the deliberately-broken one. Both directions matter — a parser that accepts everything passes the first test alone.

That oracle caught a real bug during development: `billing-v2.proto` had `line_items_summary = 9` while also declaring `reserved 9`, which this parser accepted and protoc rejected. The parser was lenient; the fixture was wrong. Only the outside opinion could tell which.

Without `PROTOC_PYTHON` the oracle tests report a diagnostic and skip — and `run-all.mjs` prints which mode it ran in, because a green run with the oracle skipped is a weaker result and that difference should not be invisible.

## What this plugin does not do

- **It does not compile.** No descriptor sets, no code generation, no wire encoding. `protobuf_status` tells you whether a real protoc is available so you can shell out for that.
- **It does not resolve imports.** An import is reported as a name; a type defined in another file is reported as unresolvable rather than guessed. The alternative is a parser that invents types.
- **It reads one file at a time.** `protobuf_diff` takes two paths, not two trees.

## Safety

`workDir` is enforced by taking only the **final path segment** of a caller-supplied path and discarding everything before it. That is stricter than rejecting `..`, and it is deliberate: a drive letter survives a naive segment filter, so `C:/tmp/work` + `C:\Windows\System32\config\SAM` resolves to a reachable path and leaks the file. Only the last segment is honoured, so a caller names a file and never a location.

Files larger than 8 MB are refused rather than parsed.

## License

MIT