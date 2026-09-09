// Ground-truth check + performance ladder for the WebAssembly CSV scanner.
//
// usage: node wasm/bench/ladder.js [csv_path] [reps] [wasm_path]
//   csv_path  comma-separated file to use as input (default: test/csv_files/column_tracking_test.csv)
//   reps      how many times the file is repeated to build a large input (default: enough for ~30 MB)
//   wasm_path default: wasm/target_simd/wasm32-unknown-unknown/release/csvscan.wasm
//
// Ground truth = the extension's own tokenizer (csv_utils.split_quoted_str) applied per line,
// i.e. Rainbow CSV's `quoted` policy. The scanner must match it on every clean record
// (same boundaries, no warning) and must flag exactly the same records as malformed.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const csv_utils = require(path.join(root, 'rbql_core', 'rbql-js', 'csv_utils.js'));

const csvPath = process.argv[2] || path.join(root, 'test', 'csv_files', 'column_tracking_test.csv');
const wasmPath = process.argv[4] || path.join(root, 'wasm', 'target_simd', 'wasm32-unknown-unknown', 'release', 'csvscan.wasm');
const src = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(l => l.length);
const srcBytes = src.reduce((a, l) => a + l.length + 1, 0);
const REP = parseInt(process.argv[3] || String(Math.max(1, Math.round(30e6 / srcBytes))));

const w = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasmPath)), {}).exports;
const enc = new TextEncoder();
const inCap = 96 * 1024 * 1024, inPtr = w.wasm_alloc(inCap);
const outCap = 32 * 1024 * 1024, outPtr = w.wasm_alloc(outCap * 4);
const mem = () => new Uint8Array(w.memory.buffer, inPtr, inCap);
const REC_END = 0x80000000, WARN = 0x40000000, HAS_QUOTE = 0x20000000, DELIM = 44;

function truth(text) {
  const out = []; let pos = 0;
  for (const line of text.split('\n')) {
    const [fields, warn] = csv_utils.split_quoted_str(line, ',', true);
    let p = pos;
    for (let k = 0; k < fields.length; k++) {
      p += fields[k].length;
      const last = k + 1 === fields.length;
      const has_quote = fields[k].indexOf('"') !== -1 ? HAS_QUOTE : 0;
      out.push((p | (last ? REC_END : 0) | (last && warn ? WARN : 0) | has_quote) >>> 0);
      p += 1;
    }
    pos += line.length + 1;
  }
  return out;
}

function compare(name, text, fn) {
  const wr = enc.encodeInto(text, mem()).written;
  if (wr !== text.length) { console.log(`  ${name}: skipped ground-truth compare (non-ASCII input: UTF-8 offsets != UTF-16 offsets)`); return null; }
  const n = fn(inPtr, wr, DELIM, outPtr, outCap);
  const got = new Uint32Array(w.memory.buffer, outPtr, n);
  const exp = truth(text);
  let recs = 0, warnMismatch = 0, boundaryMismatch = 0, gi = 0, ei = 0;
  while (ei < exp.length && gi < got.length) {
    const e0 = ei, g0 = gi;
    while (ei < exp.length && !(exp[ei] & REC_END)) ei++; ei++;
    while (gi < got.length && !(got[gi] & REC_END)) gi++; gi++;
    const ew = !!(exp[ei - 1] & WARN), gw = !!(got[gi - 1] & WARN);
    recs++;
    if (ew !== gw) { warnMismatch++; continue; }
    if (!ew) {
      const a = exp.slice(e0, ei), b = Array.from(got.slice(g0, gi));
      if (a.length !== b.length || a.some((v, k) => v !== b[k])) boundaryMismatch++;
    }
  }
  const ok = warnMismatch === 0 && boundaryMismatch === 0;
  console.log(`  ${name.padEnd(12)} records ${recs} | warn mismatches ${warnMismatch} | boundary mismatches on clean records ${boundaryMismatch} | ${ok ? 'OK' : 'FAIL'}`);
  return ok;
}

function time(label, fn, bytes, reps = 5) {
  let best = Infinity, r;
  for (let k = 0; k < reps; k++) { const t = process.hrtime.bigint(); r = fn(); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); }
  console.log('  ' + label.padEnd(44), best.toFixed(1).padStart(7), 'ms', ('(' + (bytes / best / 1e6).toFixed(2) + ' GB/s)').padStart(13));
  return r;
}

const pad = 'x'.repeat(70);
const edge = [
  'a,"b,c",d', '"x""y",z', ' "p" ,q', 'a,"unclosed', 'a,b,', '"a","b"', ',,', 'a"b,c', 'x,"a"b,c', '"a" x,b', '"",x', '""",x', 'a""b,c', '"a"""b"', 'a,",b', 'plain,line',
  'a,"unc,losed', 'next,line,fine', '"multi', 'line",attempt', pad + ',' + pad + ',"q,q"', pad + 'a"b,' + pad, '"' + pad + ',' + pad + '"', pad + ',"' + pad + '""' + pad + '"',
  pad + ' "z" ,' + pad, pad + ',"' + pad, '"' + 'y'.repeat(130) + '"', '"' + 'y'.repeat(62) + '","' + 'y'.repeat(62) + '"', 'trailing,delim,', ' , , ', '"a"' + ' '.repeat(70) + ',b',
];
console.log('--- edge cases vs ground truth');
let allOk = true;
for (const l of edge) allOk = compare(JSON.stringify(l).slice(0, 12), l, w.scan_parity) && allOk;
allOk = compare('joined', edge.join('\n'), w.scan_parity) && allOk;

const shapes = {
  'as-is': src,
  'all fields quoted': src.map(l => csv_utils.split_quoted_str(l, ',', true)[0].map(f => f.startsWith('"') ? f : '"' + f.replace(/"/g, '""') + '"').join(',')),
  'no quotes': src.map(l => l.replace(/"/g, '')),
};
for (const [name, base] of Object.entries(shapes)) {
  const lines = []; for (let r = 0; r < REP; r++) for (const l of base) lines.push(l);
  const text = lines.join('\n');
  console.log(`\n=== ${name}: ${lines.length} lines, ${text.length} chars (${path.basename(csvPath)} x ${REP})`);
  const ok = compare('scan_parity', text, w.scan_parity);
  if (ok === false) allOk = false;
  const written = enc.encodeInto(text, mem()).written;
  time('current per-line regex tokenizer', () => { let n = 0; for (const l of lines) n += csv_utils.split_quoted_str(l, ',', true)[0].length; return n; }, written, 3);
  time('Rust scalar', () => w.scan(inPtr, written, DELIM, outPtr, outCap), written);
  time('Rust memchr3', () => w.scan_fast(inPtr, written, DELIM, outPtr, outCap), written);
  time('Rust bitmask + scalar fallback', () => w.scan_bitmask(inPtr, written, DELIM, outPtr, outCap), written);
  time('Rust parity (prefix-XOR, final)', () => w.scan_parity(inPtr, written, DELIM, outPtr, outCap), written);
  time('copy JS string -> WASM (fixed cost)', () => enc.encodeInto(text, mem()).written, written);
  time('FLOOR memchr newline count', () => w.count_newlines(inPtr, written), written);
  const nOff = w.scan_parity(inPtr, written, DELIM, outPtr, outCap);
  time('JS consumer: fields-per-record consistency', () => {
    const o = new Uint32Array(w.memory.buffer, outPtr, nOff);
    let f = 0, width = -1, consistent = true, rec = 0;
    for (let k = 0; k < nOff; k++) { f++; if (o[k] & REC_END) { if (width === -1) width = f; else if (f !== width) consistent = false; f = 0; rec++; } }
    return [width, consistent, rec];
  }, written);
}
console.log('\nground truth:', allOk ? 'ALL OK' : 'MISMATCHES FOUND');
process.exit(allOk ? 0 : 1);
