//! Parity (prefix-XOR) scanner: branch-light, no scalar fallback.
//!
//! Semantics = Rainbow CSV's `quoted` policy (one record per line, quotes never span lines):
//!   * a newline is always a record boundary; a CR right before the LF is not part of the record
//!     (CRLF documents), and the number of CRs that are NOT followed by LF is reported by
//!     `last_lone_cr_count()` so the caller can fall back for documents with lone-CR line breaks;
//!   * a delimiter is a field boundary unless an odd number of quotes precede it on the line;
//!   * a record is WARNed iff some field containing a quote is not
//!     `spaces* " ( [^"] | "" )* " spaces*` (exactly the current regex rule).
//! On WARNed records field boundaries are best-effort (the extension ignores them anyway).
//! Output format: u32 end offset per field (bits 0..28), bit31 record end, bit30 warning,
//! bit29 the field contains at least one quote character (so consumers can unquote without rescanning).

use crate::{HAS_QUOTE, REC_END};
use core::sync::atomic::{AtomicU32, Ordering};

/// Number of CR bytes not immediately followed by LF in the last `scan_parity` input.
static LONE_CR: AtomicU32 = AtomicU32::new(0);

#[no_mangle]
pub extern "C" fn last_lone_cr_count() -> u32 {
    LONE_CR.load(Ordering::Relaxed)
}

#[inline(always)]
fn masks(block: &[u8], delim: u8) -> (u64, u64, u64, u64) {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let q = i8x16_splat(b'"' as i8);
        let d = i8x16_splat(delim as i8);
        let nl = i8x16_splat(b'\n' as i8);
        let cr = i8x16_splat(b'\r' as i8);
        let mut qm = 0u64;
        let mut dm = 0u64;
        let mut nm = 0u64;
        let mut cm = 0u64;
        for k in 0..4 {
            let v = unsafe { v128_load(block.as_ptr().add(k * 16) as *const v128) };
            qm |= (i8x16_bitmask(i8x16_eq(v, q)) as u64) << (k * 16);
            dm |= (i8x16_bitmask(i8x16_eq(v, d)) as u64) << (k * 16);
            nm |= (i8x16_bitmask(i8x16_eq(v, nl)) as u64) << (k * 16);
            cm |= (i8x16_bitmask(i8x16_eq(v, cr)) as u64) << (k * 16);
        }
        (qm, dm, nm, cm)
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        let mut qm = 0u64;
        let mut dm = 0u64;
        let mut nm = 0u64;
        let mut cm = 0u64;
        for (k, &b) in block.iter().enumerate().take(64) {
            qm |= ((b == b'"') as u64) << k;
            dm |= ((b == delim) as u64) << k;
            nm |= ((b == b'\n') as u64) << k;
            cm |= ((b == b'\r') as u64) << k;
        }
        (qm, dm, nm, cm)
    }
}

#[inline(always)]
fn prefix_xor(mut x: u64) -> u64 {
    x ^= x << 1;
    x ^= x << 2;
    x ^= x << 4;
    x ^= x << 8;
    x ^= x << 16;
    x ^= x << 32;
    x
}

/// Exact validity check for a field that contains at least one quote (slow path, short fields).
#[inline(never)]
fn quoted_field_ok(f: &[u8]) -> bool {
    let mut s = 0;
    let mut e = f.len();
    while s < e && f[s] == b' ' {
        s += 1;
    }
    while e > s && f[e - 1] == b' ' {
        e -= 1;
    }
    if e - s < 2 || f[s] != b'"' || f[e - 1] != b'"' {
        return false;
    }
    // interior quotes must come in runs of even length
    let mut run = 0usize;
    for &c in &f[s + 1..e - 1] {
        if c == b'"' {
            run += 1;
        } else if run & 1 == 1 {
            return false;
        } else {
            run = 0;
        }
    }
    run & 1 == 0
}

#[no_mangle]
pub extern "C" fn scan_parity(
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
    let mut warn = 0u32; // pending warning for the current record
    let mut carry = false; // inside quotes at block start (relative to current line)
    let mut fq_carry = false; // current field (started in an earlier block) contains a quote
    let mut lone_cr = 0u32;
    let mut prev_cr_top = false; // previous block ended with a CR (its LF, if any, is in this block)

    // Tail handling: copy the last partial block into a zero-padded buffer so one loop serves all.
    let mut tail = [0u8; 64];
    let full_blocks = len / 64;
    let rem = len % 64;
    let total_blocks = full_blocks + (rem > 0) as usize;

    for blk in 0..total_blocks {
        let base = blk * 64;
        let block: &[u8] = if blk < full_blocks {
            &src[base..base + 64]
        } else {
            tail[..rem].copy_from_slice(&src[base..]);
            &tail
        };
        let valid = if blk < full_blocks {
            u64::MAX
        } else {
            (1u64 << rem) - 1
        };
        let (qm, dm, nm, cm) = masks(block, delim);
        let (qm, dm, nm, cm) = (qm & valid, dm & valid, nm & valid, cm & valid);
        lone_cr += (cm & !(nm >> 1)).count_ones();
        if prev_cr_top && (nm & 1) != 0 {
            lone_cr -= 1;
        }
        // bit t set iff byte t-1 is a CR (bit 0 comes from the previous block)
        let cr_before = (cm << 1) | (prev_cr_top as u64);
        prev_cr_top = (cm >> 63) != 0;

        let boundaries;
        if qm == 0 && !carry && !fq_carry {
            boundaries = dm | nm;
        } else {
            // parity of quotes since line start, with reset at every newline in this block
            let qx = prefix_xor(qm);
            let mut basemask = 0u64;
            let mut m = nm;
            // first segment [0, first_nl]: relative to carry
            let first_nl = if m != 0 {
                m.trailing_zeros() as u64
            } else {
                64
            };
            if carry {
                basemask |= if first_nl >= 63 {
                    u64::MAX
                } else {
                    (1u64 << (first_nl + 1)) - 1
                };
            }
            let mut last_qx_at_nl = 0u64;
            let mut any_nl = false;
            while m != 0 {
                let k = m.trailing_zeros() as u64;
                m &= m - 1;
                let next = if m != 0 {
                    m.trailing_zeros() as u64
                } else {
                    64
                };
                let seg_lo = if k >= 63 { 0 } else { u64::MAX << (k + 1) };
                let seg_hi = if next >= 63 {
                    u64::MAX
                } else {
                    (1u64 << (next + 1)) - 1
                };
                let qxk = (qx >> k) & 1;
                if qxk != 0 {
                    basemask |= seg_lo & seg_hi;
                }
                last_qx_at_nl = qxk;
                any_nl = true;
            }
            let inq = qx ^ basemask;
            boundaries = nm | (dm & !inq);
            let top = (qx >> 63) & 1;
            carry = if any_nl {
                top != last_qx_at_nl
            } else {
                (top != 0) != carry
            };
            if blk == total_blocks - 1 && rem != 0 {
                // padded tail: parity beyond `rem` is meaningless
                carry = false;
            }
        }

        // emit boundaries
        let mut m = boundaries;
        let mut last_t = usize::MAX;
        // One capacity check per block (a block holds at most 64 boundaries); writes below are unchecked.
        let can_write = n + 64 <= out_cap;
        if qm == 0 && !fq_carry {
            // Lean path: no quote can touch any field closed in this block.
            while m != 0 {
                let t = m.trailing_zeros() as usize;
                m &= m - 1;
                let is_nl = ((nm >> t) & 1) as u32;
                let p = base + t;
                let end = p - (is_nl as usize & ((cr_before >> t) & 1) as usize);
                let v = (end as u32) | (is_nl << 31) | ((is_nl & warn) << 30);
                if can_write {
                    unsafe { *out.get_unchecked_mut(n) = v };
                }
                n += 1;
                warn &= !is_nl;
                last_t = t;
            }
            if last_t != usize::MAX {
                field_start = base + last_t + 1;
            }
            i = base + 64;
            continue;
        }
        while m != 0 {
            let t = m.trailing_zeros() as usize;
            m &= m - 1;
            let p = base + t;
            let is_nl = ((nm >> t) & 1) as u32;
            // record ends before a CR that precedes this LF (CRLF line ending)
            let end = p - (is_nl as usize & ((cr_before >> t) & 1) as usize);
            // does the field [field_start, p) contain a quote?
            let range = if field_start >= base {
                let lo = field_start - base;
                (if t >= 64 { u64::MAX } else { (1u64 << t) - 1 }) & !((1u64 << lo) - 1)
            } else {
                (1u64 << t) - 1
            };
            let qf = qm & range;
            let mut has_quote = 0u32;
            if fq_carry || qf != 0 {
                has_quote = HAS_QUOTE;
                // fast accept: exactly opening and closing quote at the field edges, field within this block
                let fast_ok = !fq_carry
                    && field_start >= base
                    && end >= base + 1
                    && end > field_start + 1
                    && qf == ((1u64 << (field_start - base)) | (1u64 << (end - 1 - base)));
                if !fast_ok && !quoted_field_ok(&src[field_start..end]) {
                    warn = 1;
                }
                fq_carry = false;
            }
            let v = (end as u32) | (is_nl << 31) | ((is_nl & warn) << 30) | has_quote;
            if can_write {
                unsafe { *out.get_unchecked_mut(n) = v };
            }
            n += 1;
            warn &= !is_nl;
            field_start = p + 1;
            last_t = t;
        }
        // quotes after the last boundary belong to the open field
        let open_from = if last_t == usize::MAX {
            if field_start >= base {
                field_start - base
            } else {
                0
            }
        } else {
            last_t + 1
        };
        if open_from < 64 && (qm & (u64::MAX << open_from)) != 0 {
            fq_carry = true;
        }
        i = base + 64;
    }
    let _ = i;
    LONE_CR.store(lone_cr, Ordering::Relaxed);
    // trailing field without final newline (a trailing CR would be a lone CR: caller falls back)
    if field_start < len || (len > 0 && src[len - 1] == delim) {
        let mut has_quote = 0u32;
        if fq_carry {
            has_quote = HAS_QUOTE;
            if !quoted_field_ok(&src[field_start..len]) {
                warn = 1;
            }
        }
        let v = (len as u32) | REC_END | (warn << 30) | has_quote;
        if n < out_cap {
            out[n] = v;
        }
        n += 1;
    }
    n
}
