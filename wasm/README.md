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
| `src/parity.rs` | `scan_parity`: the final scanner. Prefix-XOR quote parity, no fallback, CR LF aware |
| `bench/ladder.js` | Ground-truth check against the extension's own tokenizer, plus the timing ladder |
| `csvscan.wasm` | The built scanner, shipped inside the extension package (`npm run build-wasm` refreshes it) |
| `../src/wasm_scanner.js` | The JavaScript side: loads the module and implements `parse_document_records` on top of it |

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

* bits 0..28: byte offset one past the end of the field (UTF-8 offsets into the input buffer)
* bit 29: the field contains at least one double quote (the consumer can unquote it without rescanning)
* bit 30: set on the last field of a record that is malformed (same rule as the regex in `csv_utils.js`)
* bit 31: this field is the last one of its record

Delimiters between fields are implied: field `k` starts at `end(k-1) + 1`. Record `r` ends at the
newline; for a CR LF line ending the record ends before the CR. `last_lone_cr_count()` returns how many
CR bytes of the last scan were not followed by LF (VSCode treats those as line breaks, the scanner does
not, so the caller falls back). A trailing empty line after the final newline is not a record (the
extension skips it too).

## Semantics

Implements the `quoted` policy exactly: one record per line, a delimiter is a boundary unless an odd
number of quotes precede it on the line, and a record is flagged iff a field containing a quote is not
`spaces* " ( [^"] | "" )* " spaces*`. On flagged records the field boundaries may differ from the
JavaScript tokenizer (it falls back to splitting on every delimiter; this scanner keeps quote parity), so
`wasm_scanner.js` re-tokenizes flagged lines with the JavaScript tokenizer.

Not implemented: the multiline `quoted_rfc` policy (remove the per-line parity reset, count newlines
inside quotes), the `whitespace` and `simple` policies (trivial: `simple` is the no-quote path), and
multi-character or non-ASCII delimiters. All of those go through the JavaScript path unchanged.

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

## How it is wired into the extension

* `src/wasm_scanner.js` loads `wasm/csvscan.wasm` lazily with `fs`, keeps one input and one
  output buffer in wasm memory (grown on demand), and implements `parse_document_records` with the same
  contract as `fast_load_utils.js`: `document.getText()` is copied into wasm memory with
  `TextEncoder.encodeInto`, scanned once, and the offsets are walked in JavaScript. For non-ASCII text the
  UTF-8 offsets are converted to UTF-16 offsets with a single monotonic pass over the string. Anything the
  scanner can't handle returns `null`.
* `fast_load_utils.parse_document_records` tries the scanner first for the `quoted` policy and falls back to
  its original line loop. This is the single entry point of autodetection, CSV lint, align, shrink and the
  RBQL preview, so all of those use the scanner.
* The setting `rainbow_csv.enable_wasm_scanner` (default on) switches back to the JavaScript tokenizer.
  `extension.js` reads it on activation and on configuration changes.
* `rainbow-csv.InternalTest` with `{check_wasm_scanner_state: true}` returns the scanner statistics
  (`loaded`, `calls`, `fallbacks`, `scanned_bytes`, `scan_ms`); the integration tests assert it was used.
* Visible-range providers (`rainbow_utils.parse_document_range`: semantic tokens, inlay hints, hover) still
  use the JavaScript tokenizer: they parse about 150 lines per call and are already sub-millisecond.
* The web extension build (`dist/web`) has no `fs`, so the scanner is never loaded there and the
  JavaScript path is used.

### Tests

`test_wasm_scanner_parse_document_records` in `test/suite/unit_tests.js` compares the scanner path with the
JavaScript path on hand-written edge cases (quotes, spaces, comments, empty lines, non-ASCII, surrogate
pairs, lone surrogates), 120 random documents, and every sample file in `test/csv_files`, each with LF and
CR LF line endings, four delimiters, and all 256 combinations of the parse options. It also checks the
inputs the scanner must refuse. Run it with `npm run unit-test-only`; the full VSCode integration suite is
`npm test` (unset `ELECTRON_RUN_AS_NODE` if you run it from a VSCode terminal).

### End to end (30 MB, 920k lines, through `parse_document_records`, Node 24)

| Operation | JavaScript path | WASM path |
|---|---|---|
| CSV lint with trailing-space detection, LF | 287 ms | 58 ms |
| CSV lint, CR LF | 279 ms | 60 ms |
| autodetection | 265 ms | 45 ms |
| align / shrink (all field strings materialized) | 429 ms | 178 ms |

Of the 58 ms, about 16 ms is the copy into wasm memory, 19 ms the scan, and the rest the JavaScript walk
over 3.7 million field offsets. Align and shrink are bounded by creating 3.7 million JavaScript strings.

## Building and installing the extension

```
npm install --ignore-scripts        # scripts skipped: @vscode/test-web tries to download Chromium
npm run build-wasm                  # Rust -> wasm/csvscan.wasm (needs rustup target wasm32-unknown-unknown)
npm run unit-test-only              # ground-truth tests, a few seconds
npm run package                     # -> rainbow-csv-3.24.1.vsix (runs the webpack web build first)
code --install-extension rainbow-csv-3.24.1.vsix --force
```

The package keeps the upstream identifier `mechatroner.rainbow-csv`, so it replaces the Marketplace
install in place (VSCode pins VSIX installs, so it is not auto-updated back). Reload the window after
installing. To go back: `code --uninstall-extension mechatroner.rainbow-csv` and reinstall from the
Marketplace. To try the difference on a big file: `CSV Lint` from the command palette, with
`rainbow_csv.enable_wasm_scanner` on and off.

## Ideas left

1. Emit per-record summaries (field count, warning, edge-space flags) from the scanner so lint and
   autodetection never walk the per-field offsets in JavaScript (about 20 ms of the 58 ms above).
2. `quoted_rfc` (Dynamic CSV with multiline fields).
3. Keep the wasm input buffer in sync with `onDidChangeTextDocument` deltas so the 16 ms copy becomes a
   per-edit delta instead of a per-call full copy.

What a rewrite does not change: highlighting of plain `.csv` files is done by VS Code's TextMate engine
from `syntaxes/*.tmLanguage.json`, not by extension code, and large-file limits (20 MB / 300k lines)
are VS Code settings.
