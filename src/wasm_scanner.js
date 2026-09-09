// Fast path for fast_load_utils.parse_document_records using the SIMD scanner in wasm/src (compiled to wasm/csvscan.wasm).
//
// The scanner implements the per-line `quoted` policy only. Everything else (other policies, multi-character delimiters,
// documents with lone CR line breaks, a missing or broken wasm file) makes parse_document_records() return null and the
// caller falls back to the JavaScript tokenizer. On a record the scanner flags as malformed the line is re-tokenized with
// the JavaScript tokenizer, so the results of both paths are identical (see test_wasm_scanner_parse_document_records).
//
// Scanner output: one u32 per field.
//   bits 0..28  byte offset one past the end of the field (UTF-8 offsets into the scanned buffer)
//   bit 29      the field contains at least one double quote
//   bit 30      the record is malformed (set on its last field)
//   bit 31      the field is the last one of its record

const csv_utils = require('../rbql_core/rbql-js/csv_utils.js');

const REC_END = 0x80000000;
const WARN = 0x40000000;
const HAS_QUOTE = 0x20000000;
const OFFSET_MASK = 0x1FFFFFFF;
const MAX_TEXT_LENGTH = 256 * 1024 * 1024; // Offsets are 29-bit; VSCode refuses to open files anywhere near this size anyway.
const OUT_SLACK = 64; // The scanner checks the output capacity once per 64-byte block.

let wasm = null; // {exports, in_ptr, in_cap, out_ptr, out_cap}
let load_error = null;
let stats = {loaded: false, load_error: null, calls: 0, fallbacks: 0, scanned_bytes: 0, scan_ms: 0, probe_scans: 0, probe_hits: 0, encode_reuses: 0};
let probe_chars = 128 * 1024; // Prefix scanned first when the caller can stop early, see parse_document_records().
let text_encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
let cached_encoding = null; // {doc_ref, version, num_bytes}: what the input buffer currently holds, see scan_text().
const weak_ref_supported = (typeof WeakRef !== 'undefined');


function encoding_cache_hit(document, text) {
    // Two parses of the same unchanged document should encode it only once. getText() returns a fresh string every
    // time, so string identity is useless here. Keying on the document object plus its version is safe: a different
    // document is a different object, and any edit bumps the version. Never key on (fileName, version): two distinct
    // documents can share both.
    if (cached_encoding === null || document === null || typeof document.version !== 'number') {
        return false;
    }
    return cached_encoding.doc_ref.deref() === document && cached_encoding.version === document.version &&
           cached_encoding.text_length === text.length;
}


function remember_encoding(document, text, num_bytes) {
    if (!weak_ref_supported || !document || typeof document.version !== 'number') {
        cached_encoding = null;
        return;
    }
    cached_encoding = {doc_ref: new WeakRef(document), version: document.version, text_length: text.length, num_bytes: num_bytes};
}


function read_wasm_bytes() {
    // In the web extension build webpack replaces `fs` and `path` with empty modules, so this throws and the scanner stays disabled.
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(path.join(__dirname, '..', 'wasm', 'csvscan.wasm'));
}


function ensure_loaded() {
    if (wasm !== null) {
        return true;
    }
    if (load_error !== null) {
        return false;
    }
    try {
        if (text_encoder === null || typeof WebAssembly === 'undefined') {
            throw new Error('TextEncoder or WebAssembly is not available');
        }
        let wasm_bytes = read_wasm_bytes();
        let instance = new WebAssembly.Instance(new WebAssembly.Module(wasm_bytes), {});
        wasm = {exports: instance.exports, in_ptr: 0, in_cap: 0, out_ptr: 0, out_cap: 0, probe_ptr: 0, probe_cap: 0};
        stats.loaded = true;
    } catch (e) {
        load_error = e;
        stats.load_error = String(e);
        return false;
    }
    return true;
}


function is_available() {
    return ensure_loaded();
}


function get_stats() {
    return Object.assign({}, stats);
}


function reserve_input(num_bytes, use_probe_buffer) {
    // The probe has a buffer of its own so that a probe never destroys the encoded document the input buffer holds,
    // which is what makes the encoding cache in scan_text() worth having.
    if (use_probe_buffer) {
        if (num_bytes <= wasm.probe_cap) {
            return;
        }
        if (wasm.probe_cap > 0) {
            wasm.exports.wasm_free(wasm.probe_ptr, wasm.probe_cap);
        }
        wasm.probe_cap = Math.max(num_bytes, wasm.probe_cap * 2, 1 << 17);
        wasm.probe_ptr = wasm.exports.wasm_alloc(wasm.probe_cap);
        return;
    }
    if (num_bytes <= wasm.in_cap) {
        return;
    }
    if (wasm.in_cap > 0) {
        wasm.exports.wasm_free(wasm.in_ptr, wasm.in_cap);
    }
    wasm.in_cap = Math.max(num_bytes, wasm.in_cap * 2, 1 << 20);
    wasm.in_ptr = wasm.exports.wasm_alloc(wasm.in_cap);
}


function buffer_ptr(use_probe_buffer) {
    return use_probe_buffer ? wasm.probe_ptr : wasm.in_ptr;
}


function buffer_cap(use_probe_buffer) {
    return use_probe_buffer ? wasm.probe_cap : wasm.in_cap;
}


function reserve_output(num_entries) {
    if (num_entries <= wasm.out_cap) {
        return;
    }
    if (wasm.out_cap > 0) {
        wasm.exports.wasm_free(wasm.out_ptr, wasm.out_cap * 4);
    }
    wasm.out_cap = Math.max(num_entries, wasm.out_cap * 2, 1 << 18);
    wasm.out_ptr = wasm.exports.wasm_alloc(wasm.out_cap * 4);
}


function encode_text(text, use_probe_buffer) {
    // Returns the number of UTF-8 bytes written into the chosen buffer. Grows the buffer if the text is not pure ASCII.
    if (!use_probe_buffer) {
        cached_encoding = null; // Whatever the input buffer held is about to be overwritten.
    }
    reserve_input(text.length + 1, use_probe_buffer);
    while (true) {
        // Views must be re-created after every allocation: growing wasm memory detaches the old ArrayBuffer.
        let input_view = new Uint8Array(wasm.exports.memory.buffer, buffer_ptr(use_probe_buffer), buffer_cap(use_probe_buffer));
        let encode_result = text_encoder.encodeInto(text, input_view);
        if (encode_result.read >= text.length) {
            return encode_result.written;
        }
        // Not everything fitted: UTF-8 needs at most 3 bytes per UTF-16 code unit.
        reserve_input(encode_result.written + (text.length - encode_result.read) * 3 + 1, use_probe_buffer);
    }
}


function scan_text(text, delim_code, cache_document=null, use_probe_buffer=false) {
    // Returns [bytes_view, num_bytes, offsets_view, num_offsets]. The views are only valid until the next scan.
    if (!ensure_loaded()) {
        throw load_error;
    }
    let num_bytes;
    if (encoding_cache_hit(cache_document, text)) {
        num_bytes = cached_encoding.num_bytes; // The input buffer still holds this exact text.
        stats.encode_reuses += 1;
    } else {
        num_bytes = encode_text(text, use_probe_buffer);
        if (!use_probe_buffer) {
            remember_encoding(cache_document, text, num_bytes);
        }
    }
    reserve_output(Math.floor(num_bytes / 4) + OUT_SLACK + 1);
    let start_time = (typeof performance !== 'undefined') ? performance.now() : 0;
    let num_offsets = wasm.exports.scan_parity(buffer_ptr(use_probe_buffer), num_bytes, delim_code, wasm.out_ptr, wasm.out_cap);
    if (num_offsets + OUT_SLACK > wasm.out_cap) {
        // Very short fields: the guess was too small and the scanner only counted. Retry with the exact size.
        reserve_output(num_offsets + OUT_SLACK + 1);
        num_offsets = wasm.exports.scan_parity(buffer_ptr(use_probe_buffer), num_bytes, delim_code, wasm.out_ptr, wasm.out_cap);
    }
    if (typeof performance !== 'undefined') {
        stats.scan_ms += performance.now() - start_time;
    }
    stats.scanned_bytes += num_bytes;
    let bytes_view = new Uint8Array(wasm.exports.memory.buffer, buffer_ptr(use_probe_buffer), num_bytes);
    let offsets_view = new Uint32Array(wasm.exports.memory.buffer, wasm.out_ptr, num_offsets);
    return [bytes_view, num_bytes, offsets_view, num_offsets];
}


function make_byte_to_char_converter(text, is_ascii) {
    // Converts UTF-8 byte offsets into UTF-16 (JS string) offsets. Offsets must be requested in non-decreasing order.
    if (is_ascii) {
        return (byte_offset) => byte_offset;
    }
    let char_index = 0;
    let byte_index = 0;
    return function(byte_offset) {
        while (byte_index < byte_offset) {
            let code = text.charCodeAt(char_index);
            if (code < 0x80) {
                byte_index += 1;
                char_index += 1;
            } else if (code < 0x800) {
                byte_index += 2;
                char_index += 1;
            } else if (code >= 0xD800 && code <= 0xDBFF && char_index + 1 < text.length && (text.charCodeAt(char_index + 1) & 0xFC00) == 0xDC00) {
                byte_index += 4; // Surrogate pair.
                char_index += 2;
            } else {
                byte_index += 3; // 3-byte character, or a lone surrogate which TextEncoder writes as U+FFFD (3 bytes).
                char_index += 1;
            }
        }
        return char_index;
    };
}


function bytes_start_with(bytes, start, end, prefix_bytes) {
    if (end - start < prefix_bytes.length) {
        return false;
    }
    for (let i = 0; i < prefix_bytes.length; i++) {
        if (bytes[start + i] !== prefix_bytes[i]) {
            return false;
        }
    }
    return true;
}


function unquoted_field_bounds(bytes, start, end) {
    // For a well-formed quoted field ` "..." ` returns the byte bounds of the content between the quotes.
    while (start < end && bytes[start] === 32) {
        start++;
    }
    while (end > start && bytes[end - 1] === 32) {
        end--;
    }
    return [start + 1, end - 1];
}


function field_has_edge_space(bytes, start, end, has_quote, preserve_quotes_and_whitespaces) {
    // Mirrors the trailing-space check of RecordTextConsumer on the field string the JS tokenizer would have produced.
    if (has_quote && !preserve_quotes_and_whitespaces) {
        [start, end] = unquoted_field_bounds(bytes, start, end);
    }
    return start < end && (bytes[start] === 32 || bytes[end - 1] === 32);
}


function parse_document_records(document, delim, policy, comment_prefix=null, stop_on_warning=false, max_records_to_parse=-1, collect_records=true, preserve_quotes_and_whitespaces=false, detect_trailing_spaces=false, min_num_fields_for_autodetection=-1, trim_whitespaces=false) {
    // Same contract as fast_load_utils.parse_document_records. Returns null if this input can't be handled by the scanner.
    if (policy !== 'quoted' || typeof delim !== 'string' || delim.length !== 1) {
        return null;
    }
    let delim_code = delim.charCodeAt(0);
    if (delim_code >= 128 || delim_code === 34 || delim_code === 10 || delim_code === 13 || delim_code === 32) {
        // Non-ASCII delimiters would need byte comparisons; space delimiter changes the external-whitespace rule of the tokenizer.
        return null;
    }
    if (!ensure_loaded()) {
        return null;
    }
    let text = document.getText();
    if (text.length > MAX_TEXT_LENGTH) {
        return null;
    }
    // Note: no CRLF normalization here, the scanner handles CR LF itself (a copy of a 30 MB string costs more than the scan).
    stats.calls += 1;
    let opts = {delim: delim, policy: policy, comment_prefix: comment_prefix, stop_on_warning: stop_on_warning,
                max_records_to_parse: max_records_to_parse, collect_records: collect_records,
                preserve_quotes_and_whitespaces: preserve_quotes_and_whitespaces, detect_trailing_spaces: detect_trailing_spaces,
                min_num_fields_for_autodetection: min_num_fields_for_autodetection, trim_whitespaces: trim_whitespaces};

    // The JS path returns after a handful of lines when it hits a stop condition, so scanning the whole document up front
    // would be pure waste. Scan a line-aligned prefix first and keep its result only if the walk actually stopped inside it:
    // all three stop conditions (a warning, the autodetection column threshold, the record limit) depend on a prefix only.
    let can_stop_early = stop_on_warning || min_num_fields_for_autodetection !== -1 || max_records_to_parse !== -1;
    if (can_stop_early && text.length > probe_chars) {
        let probe_end = text.lastIndexOf('\n', probe_chars - 1) + 1;
        if (probe_end > 0) {
            let probe_text = text.substring(0, probe_end);
            let [probe_bytes, _probe_num_bytes, probe_offsets, probe_num_offsets] = scan_text(probe_text, delim_code, /*cache_document=*/null, /*use_probe_buffer=*/true);
            stats.probe_scans += 1;
            if (wasm.exports.last_lone_cr_count() > 0) {
                // The lone CR is inside the prefix, so it is in the whole document too: no point scanning the rest.
                stats.fallbacks += 1;
                return null;
            }
            let [probe_result, probe_early_stop] = walk_scanned(probe_text, probe_bytes, probe_offsets, probe_num_offsets, /*is_full_text=*/false, opts);
            if (probe_early_stop) {
                stats.probe_hits += 1;
                return probe_result;
            }
        }
    }

    let [bytes, _num_bytes, offsets, num_offsets] = scan_text(text, delim_code, /*cache_document=*/document);
    if (wasm.exports.last_lone_cr_count() > 0) {
        // A CR without LF is a line break for VSCode but not for the scanner (CRLF is handled: the record ends before the CR).
        stats.fallbacks += 1;
        return null;
    }
    return walk_scanned(text, bytes, offsets, num_offsets, /*is_full_text=*/true, opts)[0];
}


function walk_scanned(text, bytes, offsets, num_offsets, is_full_text, opts) {
    // Walks the scanner output into the parse_document_records return value. Returns [result, early_stop].
    let {delim, policy, comment_prefix, stop_on_warning, max_records_to_parse, collect_records,
         preserve_quotes_and_whitespaces, detect_trailing_spaces, min_num_fields_for_autodetection, trim_whitespaces} = opts;
    let num_bytes = bytes.length;
    let is_ascii = (num_bytes === text.length);
    let to_char = make_byte_to_char_converter(text, is_ascii);
    let comment_prefix_bytes = comment_prefix ? text_encoder.encode(comment_prefix) : null;

    let records = collect_records ? [] : null;
    let comments = [];
    let fields_info = new Map();
    let num_records_parsed = 0;
    let first_defective_line = null;
    let first_trailing_space_line = null;

    let k = 0;
    let record_start = 0;
    let lnum = 0;
    let early_stop = false; // The JS path returns immediately in these cases, before it can see the last empty line.
    while (k < num_offsets) {
        let first_field = k;
        while (!(offsets[k] & REC_END)) {
            k++;
        }
        let last_field = k;
        k++;
        let record_end = offsets[last_field] & OFFSET_MASK;
        let is_defective = (offsets[last_field] & WARN) !== 0;
        let num_fields = last_field - first_field + 1;

        if (comment_prefix_bytes !== null && bytes_start_with(bytes, record_start, record_end, comment_prefix_bytes)) {
            if (collect_records) {
                comments.push({record_num: num_records_parsed, comment_text: text.substring(to_char(record_start), to_char(record_end))});
            }
            lnum++;
            record_start = record_end + 1 + (bytes[record_end] === 13 ? 1 : 0); // Skip LF, or CR LF.
            continue;
        }

        let record = null;
        if (is_defective) {
            if (first_defective_line === null) {
                first_defective_line = lnum;
            }
            if (stop_on_warning) {
                early_stop = true;
                break;
            }
            // Field boundaries of malformed lines are tokenizer-specific: use the JS tokenizer to get exactly its result.
            let line_text = text.substring(to_char(record_start), to_char(record_end));
            record = csv_utils.smart_split(line_text, delim, policy, preserve_quotes_and_whitespaces)[0];
            num_fields = record.length;
        }

        if (detect_trailing_spaces && first_trailing_space_line === null) {
            if (record !== null) {
                for (let field of record) {
                    if (field.length && (field.charAt(0) == ' ' || field.charAt(field.length - 1) == ' ')) {
                        first_trailing_space_line = lnum;
                    }
                }
            } else {
                let field_start = record_start;
                for (let f = first_field; f <= last_field; f++) {
                    let field_end = offsets[f] & OFFSET_MASK;
                    if (field_has_edge_space(bytes, field_start, field_end, (offsets[f] & HAS_QUOTE) !== 0, preserve_quotes_and_whitespaces)) {
                        first_trailing_space_line = lnum;
                    }
                    field_start = field_end + 1;
                }
            }
        }

        if (!fields_info.has(num_fields)) {
            fields_info.set(num_fields, num_records_parsed);
            if (min_num_fields_for_autodetection != -1) {
                // Autodetection mode: stop on inconsistent records length and when there is not enough columns (typically less than 2 i.e. 1).
                if (num_fields < min_num_fields_for_autodetection || fields_info.size > 1) {
                    early_stop = true;
                    break;
                }
            }
        }

        if (collect_records) {
            if (record === null) {
                record = new Array(num_fields);
                let field_start = record_start;
                for (let f = first_field; f <= last_field; f++) {
                    let field_end = offsets[f] & OFFSET_MASK;
                    if ((offsets[f] & HAS_QUOTE) && !preserve_quotes_and_whitespaces) {
                        let [content_start, content_end] = unquoted_field_bounds(bytes, field_start, field_end);
                        record[f - first_field] = text.substring(to_char(content_start), to_char(content_end)).replace(/""/g, '"');
                    } else {
                        record[f - first_field] = text.substring(to_char(field_start), to_char(field_end));
                    }
                    field_start = field_end + 1;
                }
            }
            if (trim_whitespaces) {
                record = record.map((v) => v.trim());
            }
            records.push(record);
        }
        num_records_parsed += 1;
        lnum++;
        record_start = record_end + 1 + (bytes[record_end] === 13 ? 1 : 0); // Skip LF, or CR LF.
        if (max_records_to_parse !== -1 && num_records_parsed >= max_records_to_parse) {
            early_stop = true;
            break;
        }
    }

    if (!early_stop && is_full_text && collect_records && (text.length === 0 || text.charCodeAt(text.length - 1) === 10)) {
        // The last line is empty: the JS path records it as a comment so that align/shrink keep it.
        comments.push({record_num: num_records_parsed, comment_text: ''});
    }
    return [[records, num_records_parsed, fields_info, first_defective_line, first_trailing_space_line, comments], early_stop];
}


module.exports.parse_document_records = parse_document_records;
module.exports.set_probe_chars_for_tests = function(n) { let old = probe_chars; probe_chars = n; return old; };
module.exports.is_available = is_available;
module.exports.get_stats = get_stats;
module.exports.scan_text = scan_text;
module.exports.REC_END = REC_END;
module.exports.WARN = WARN;
module.exports.HAS_QUOTE = HAS_QUOTE;
module.exports.OFFSET_MASK = OFFSET_MASK;
