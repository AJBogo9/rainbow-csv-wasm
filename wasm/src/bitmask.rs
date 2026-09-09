//! Block-wise bitmask scanner (simdjson-style).
//!
//! Output format is identical to `scan` / `scan_fast` in lib.rs:
//! one u32 per field = offset one past the field end, bit31 = record end, bit30 = record warning.
//!
//! Strategy: 64-byte blocks. Compute three bitmasks (quote / delimiter / newline).
//! While the parser is in the "plain" state (not inside quotes, no quote seen in the current field)
//! and the block contains no quote byte, every delimiter/newline bit is a field boundary and can be
//! emitted straight from the mask with a count-trailing-zeros loop. Blocks that contain a quote are
//! handled by the exact scalar state machine (same rules as `scan`), so results are identical.

use crate::{REC_END, WARN};

#[inline(always)]
fn block_masks(block: &[u8], delim: u8) -> (u64, u64, u64) {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let q = i8x16_splat(b'"' as i8);
        let d = i8x16_splat(delim as i8);
        let nl = i8x16_splat(b'\n' as i8);
        let mut qm = 0u64;
        let mut dm = 0u64;
        let mut nm = 0u64;
        for k in 0..4 {
            let v = unsafe { v128_load(block.as_ptr().add(k * 16) as *const v128) };
            qm |= (i8x16_bitmask(i8x16_eq(v, q)) as u64) << (k * 16);
            dm |= (i8x16_bitmask(i8x16_eq(v, d)) as u64) << (k * 16);
            nm |= (i8x16_bitmask(i8x16_eq(v, nl)) as u64) << (k * 16);
        }
        (qm, dm, nm)
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        let mut qm = 0u64;
        let mut dm = 0u64;
        let mut nm = 0u64;
        for (k, &b) in block.iter().enumerate().take(64) {
            qm |= ((b == b'"') as u64) << k;
            dm |= ((b == delim) as u64) << k;
            nm |= ((b == b'\n') as u64) << k;
        }
        (qm, dm, nm)
    }
}

struct St {
    i: usize,
    field_start: usize,
    warn: bool,
    in_quotes: bool,
    had_quote: bool,
    quoted_closed: bool,
    close_pos: usize,
}

/// Exact scalar step: consumes from st.i up to and including the next field boundary
/// (or the next quote event). Mirrors `scan_fast` in lib.rs.
#[inline(always)]
fn scalar_step(src: &[u8], delim: u8, st: &mut St, out: &mut [u32], n: &mut usize) {
    let len = src.len();
    if st.in_quotes {
        match memchr::memchr(b'"', &src[st.i..]) {
            None => {
                st.i = len;
            }
            Some(off) => {
                let q = st.i + off;
                if q + 1 < len && src[q + 1] == b'"' {
                    st.i = q + 2;
                } else {
                    st.in_quotes = false;
                    st.quoted_closed = true;
                    st.close_pos = q + 1;
                    st.i = q + 1;
                }
            }
        }
        return;
    }
    let Some(off) = memchr::memchr3(delim, b'\n', b'"', &src[st.i..]) else {
        if st.quoted_closed && src[st.close_pos..].iter().any(|&c| c != b' ') {
            st.warn = true;
        }
        st.i = len;
        return;
    };
    let p = st.i + off;
    let b = src[p];
    if b == b'"' {
        let only_spaces = !st.had_quote && src[st.field_start..p].iter().all(|&c| c == b' ');
        if only_spaces {
            st.in_quotes = true;
        } else {
            st.warn = true;
        }
        st.had_quote = true;
        st.i = p + 1;
        return;
    }
    if st.quoted_closed && src[st.close_pos..p].iter().any(|&c| c != b' ') {
        st.warn = true;
    }
    if st.had_quote && !st.quoted_closed {
        st.warn = true;
    }
    if *n < out.len() {
        let mut v = p as u32;
        if b == b'\n' {
            v |= REC_END;
            if st.warn {
                v |= WARN;
            }
            st.warn = false;
        }
        out[*n] = v;
    }
    *n += 1;
    st.i = p + 1;
    st.field_start = st.i;
    st.had_quote = false;
    st.quoted_closed = false;
}

#[no_mangle]
pub extern "C" fn scan_bitmask(
    ptr: *const u8,
    len: usize,
    delim: u8,
    out_ptr: *mut u32,
    out_cap: usize,
) -> usize {
    let src = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, out_cap) };
    let mut n = 0usize;
    let mut st = St {
        i: 0,
        field_start: 0,
        warn: false,
        in_quotes: false,
        had_quote: false,
        quoted_closed: false,
        close_pos: 0,
    };

    while st.i + 64 <= len {
        let plain = !st.in_quotes && !st.had_quote;
        if plain {
            let (qm, dm, nm) = block_masks(&src[st.i..st.i + 64], delim);
            if qm == 0 {
                // Fast path: every delimiter / newline bit is a boundary.
                let base = st.i;
                let mut m = dm | nm;
                let mut warn = st.warn as u32;
                let mut last = usize::MAX;
                while m != 0 {
                    let t = m.trailing_zeros() as usize;
                    let p = base + t;
                    let is_nl = ((nm >> t) & 1) as u32;
                    let v = (p as u32) | (is_nl << 31) | ((is_nl & warn) << 30);
                    if n < out_cap {
                        out[n] = v;
                    }
                    n += 1;
                    warn &= !is_nl;
                    last = p;
                    m &= m - 1;
                }
                st.warn = warn != 0;
                if last != usize::MAX {
                    st.field_start = last + 1;
                }
                st.i = base + 64;
                continue;
            }
            // Block has a quote: run the exact state machine through this block.
            let block_end = st.i + 64;
            while st.i < block_end {
                scalar_step(src, delim, &mut st, out, &mut n);
            }
        } else {
            scalar_step(src, delim, &mut st, out, &mut n);
        }
    }
    while st.i < len {
        scalar_step(src, delim, &mut st, out, &mut n);
    }
    // Trailing field without a final newline.
    if st.field_start < len || (len > 0 && src[len - 1] == delim) {
        if st.in_quotes || (st.had_quote && !st.quoted_closed) {
            st.warn = true;
        }
        if n < out_cap {
            let mut v = len as u32 | REC_END;
            if st.warn {
                v |= WARN;
            }
            out[n] = v;
        }
        n += 1;
    }
    n
}
