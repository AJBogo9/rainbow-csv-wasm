// Minimal RFC-4180 field scanner over a UTF-8 buffer.
// Writes one u32 per field: the byte offset one past the field's end.
// Bit 31 is set on the last field of each record (i.e. at a newline / end of input).
// Bit 30 is set if the record had a quoting problem (mirrors csv_utils "warning").

use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}

#[no_mangle]
pub extern "C" fn wasm_free(ptr: *mut u8, len: usize) {
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1)) }
}

pub(crate) const REC_END: u32 = 1 << 31;
pub(crate) const WARN: u32 = 1 << 30;

mod bitmask;
mod parity;

#[no_mangle]
pub extern "C" fn scan(
    ptr: *const u8,
    len: usize,
    delim: u8,
    out_ptr: *mut u32,
    out_cap: usize,
) -> usize {
    let src = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, out_cap) };
    let mut n = 0usize;
    let mut i = 0usize;
    let mut field_start = 0usize;
    let mut warn = false;
    let mut in_quotes = false;
    let mut had_quote = false; // field contained a quote character
    let mut quoted_closed = false; // field was a complete "..." token
    while i < len {
        let b = src[i];
        if in_quotes {
            if b == b'"' {
                if i + 1 < len && src[i + 1] == b'"' {
                    i += 2;
                    continue;
                }
                in_quotes = false;
                quoted_closed = true;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                // A quote is only a valid opener at the field start (after optional spaces).
                let only_spaces = src[field_start..i].iter().all(|&c| c == b' ');
                if only_spaces && !had_quote {
                    in_quotes = true;
                } else {
                    warn = true;
                }
                had_quote = true;
                i += 1;
            }
            b' ' => {
                i += 1;
            }
            _ if b == delim || b == b'\n' => {
                if had_quote && !quoted_closed {
                    warn = true;
                }
                if n < out_cap {
                    let mut v = i as u32;
                    if b == b'\n' {
                        v |= REC_END;
                        if warn {
                            v |= WARN;
                        }
                        warn = false;
                    }
                    out[n] = v;
                }
                n += 1;
                i += 1;
                field_start = i;
                had_quote = false;
                quoted_closed = false;
            }
            _ => {
                if quoted_closed {
                    // Non-space garbage after a closed quoted token.
                    warn = true;
                }
                i += 1;
            }
        }
    }
    // Flush the last field if the input did not end with a newline.
    if field_start < len || (len > 0 && src[len - 1] == delim) {
        if in_quotes || (had_quote && !quoted_closed) {
            warn = true;
        }
        if n < out_cap {
            let mut v = len as u32 | REC_END;
            if warn {
                v |= WARN;
            }
            out[n] = v;
        }
        n += 1;
    }
    n
}

// ---------------------------------------------------------------------------
// Floor: touch every byte once with a SIMD memchr, output nothing but a count.
#[no_mangle]
pub extern "C" fn count_newlines(ptr: *const u8, len: usize) -> usize {
    let src = unsafe { std::slice::from_raw_parts(ptr, len) };
    memchr::memchr_iter(b'\n', src).count()
}

// Fast scanner: jump between "interesting" bytes (delim, newline, quote) with
// SIMD memchr3 instead of inspecting every byte in a scalar loop.
// Same output format and semantics as `scan`.
#[no_mangle]
pub extern "C" fn scan_fast(
    ptr: *const u8,
    len: usize,
    delim: u8,
    out_ptr: *mut u32,
    out_cap: usize,
) -> usize {
    let src = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, out_cap) };
    let mut n = 0usize;
    let mut i = 0usize;
    let mut field_start = 0usize;
    let mut warn = false;
    let mut had_quote = false;
    let mut quoted_closed = false;
    let mut in_quotes = false;
    let mut close_pos = 0usize;
    while i < len {
        if in_quotes {
            // Find the closing quote; "" is an escaped quote.
            match memchr::memchr(b'"', &src[i..]) {
                None => {
                    break;
                }
                Some(off) => {
                    let q = i + off;
                    if q + 1 < len && src[q + 1] == b'"' {
                        i = q + 2;
                        continue;
                    }
                    in_quotes = false;
                    quoted_closed = true;
                    close_pos = q + 1;
                    i = q + 1;
                    continue;
                }
            }
        }
        let Some(off) = memchr::memchr3(delim, b'\n', b'"', &src[i..]) else {
            // No more interesting bytes: rest is the tail of the last field.
            if quoted_closed && src[close_pos..].iter().any(|&c| c != b' ') {
                warn = true;
            }
            break;
        };
        let p = i + off;
        let b = src[p];
        if b == b'"' {
            // Valid opener only if everything since field start is spaces and no quote seen yet.
            let only_spaces = !had_quote && src[field_start..p].iter().all(|&c| c == b' ');
            if only_spaces {
                in_quotes = true;
            } else {
                warn = true;
            }
            had_quote = true;
            i = p + 1;
            continue;
        }
        // delim or newline: close the field. Bytes after a closed quoted token must be spaces.
        if quoted_closed && src[close_pos..p].iter().any(|&c| c != b' ') {
            warn = true;
        }
        if had_quote && !quoted_closed {
            warn = true;
        }
        if n < out_cap {
            let mut v = p as u32;
            if b == b'\n' {
                v |= REC_END;
                if warn {
                    v |= WARN;
                }
                warn = false;
            }
            out[n] = v;
        }
        n += 1;
        i = p + 1;
        field_start = i;
        had_quote = false;
        quoted_closed = false;
    }
    if field_start < len || (len > 0 && src[len - 1] == delim) {
        if in_quotes || (had_quote && !quoted_closed) {
            warn = true;
        }
        if n < out_cap {
            let mut v = len as u32 | REC_END;
            if warn {
                v |= WARN;
            }
            out[n] = v;
        }
        n += 1;
    }
    n
}
