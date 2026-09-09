# WebAssembly CSV scanner for Rainbow CSV

A learning project: replace the JavaScript tokenizer in
[Rainbow CSV](https://github.com/mechatroner/vscode_rainbow_csv) with a SIMD scanner written in Rust
and compiled to WebAssembly. The upstream extension is MIT licensed (see `../LICENSE`); this fork keeps
that license and its history. The `upstream` git remote points at the original repository.

## What is here

| File | Purpose |
|---|---|
| `src/lib.rs` | `scan` (scalar reference), `scan_fast` (memchr3), `count_newlines` (physical floor), allocator exports |
| `src/bitmask.rs` | `scan_bitmask`: 64-byte SIMD bitmasks, scalar fallback for blocks with quotes |
| `src/parity.rs` | `scan_parity`: the final scanner. Prefix-XOR quote parity, no fallback |
| `bench/ladder.js` | Ground-truth check against the extension's own tokenizer, plus the timing ladder |

## Build

```
rustup target add wasm32-unknown-unknown
cd wasm
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --target-dir target_simd
```

SIMD is required for the speed: without `+simd128` the mask construction is not vectorized and the
scanner is 3 to 4 times slower. VS Code's Electron and every current browser support WebAssembly SIMD.

## Verify and measure

```
node wasm/bench/ladder.js                      # uses test/csv_files/column_tracking_test.csv
node wasm/bench/ladder.js path/to/file.csv 50  # your own file, repeated 50 times
```

The script exits non-zero if the scanner disagrees with `csv_utils.split_quoted_str` on any clean record
or flags a different set of records as malformed.

## Output format

`scan_parity(ptr, len, delim, out_ptr, out_cap) -> count` writes one `u32` per field into `out`:

* bits 0..29: byte offset one past the end of the field (UTF-8 offsets into the input buffer)
* bit 31: this field is the last one of its record
* bit 30: set on the last field of a record that is malformed (same rule as the regex in `csv_utils.js`)

Delimiters between fields are implied: field `k` starts at `end(k-1) + 1`. Record `r` ends at the
newline. A trailing empty line after the final newline is not a record (the extension skips it too).

## Semantics

Implements the `quoted` policy exactly: one record per line, a delimiter is a boundary unless an odd
number of quotes precede it on the line, and a record is flagged iff a field containing a quote is not
`spaces* " ( [^"] | "" )* " spaces*`. On flagged records the field boundaries may differ from the
JavaScript tokenizer (it falls back to splitting on every delimiter; this scanner keeps quote parity).
The extension discards fields on flagged records everywhere except the hover column count.

Not implemented yet: the multiline `quoted_rfc` policy (remove the per-line parity reset, count newlines
inside quotes), the `whitespace` and `simple` policies (trivial: `simple` is the no-quote path), and
multi-character delimiters.

## Measured (36 MB, 252k lines, 21 columns, one quoted field per line; Node 24, x86-64)

| Scanner | as is | all fields quoted | no quotes |
|---|---|---|---|
| current per-line regex tokenizer (JS) | 300 ms | 407 ms | 136 ms |
| `scan` scalar | 70 ms | 79 ms | 73 ms |
| `scan_fast` memchr3 | 46 ms | 102 ms | 42 ms |
| `scan_bitmask` | 24 ms | 87 ms | 12 ms |
| `scan_parity` | 18 ms | 32 ms | 12.5 ms |
| copy JS string into WASM memory | 16 ms | 20 ms | 17 ms |
| floor: SIMD newline count, no output | 2 ms | 3 ms | 2 ms |

The scan now costs about the same as the unavoidable copy, so further scanner work has small returns.

## Integration roadmap (the actual learning project)

1. **Load the module.** In `extension.js`, read `csvscan.wasm` with `fs` (node) or `fetch` (web build,
   see `webpack.config.js` and `load_resource_file_universal`) and instantiate it once, lazily, like
   `ll_rainbow_utils()` does for the JS modules.
2. **Whole-document operations first.** `fast_load_utils.parse_document_records` is the single entry
   point for autodetection, lint, align and shrink. Replace its line loop with: `document.getText()`,
   `TextEncoder.encodeInto` into WASM memory, one `scan_parity` call, then walk the offsets. For
   autodetection only field counts per record and the first flagged record are needed (no strings at all).
3. **Offsets to VS Code positions.** For ASCII text a byte offset is a character offset. For non-ASCII
   text build a cumulative map from UTF-8 byte offsets to UTF-16 code units, or keep line starts from
   the newline bits and convert per line. `document.positionAt(offset)` also works but is slow per call.
4. **Visible-range providers.** `rainbow_utils.parse_document_range` (semantic tokens, inlay hints,
   column tracking, hover) parses about 150 lines per call and is already sub-millisecond in JS. Port it
   last, or not at all; the gain is not perceptible there.
5. **Keep the JS tokenizer as the oracle.** `bench/ladder.js` already compares both; wire the same
   comparison into `test/suite/unit_tests.js` so a semantics drift fails the test suite.
6. **Optional, bigger step.** Keep the WASM input buffer in sync with `onDidChangeTextDocument`
   deltas so the 16 ms copy becomes a per-edit delta instead of a per-call full copy.

What a rewrite does not change: highlighting of plain `.csv` files is done by VS Code's TextMate engine
from `syntaxes/*.tmLanguage.json`, not by extension code, and large-file limits (20 MB / 300k lines)
are VS Code settings.
