//! Freshness beacon (CONTRACTS.md §7.5, §9.1): raw SlotHashes reads, no full deserialization.
//!
//! Layout: `u64 len` at offset 0; entry i at `8 + 40·i` = `(u64 slot, [u8;32] hash)`,
//! sorted by slot, descending.
use anchor_lang::prelude::*;

use crate::constants::BEACON_MAX_AGE_SLOTS;
use crate::errors::VerdictError;

const ENTRY: usize = 40;
const MAX_ENTRIES: usize = 512;

fn read_u64(d: &[u8], o: usize) -> Option<u64> {
    d.get(o..o + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}

/// Binary-searches the SlotHashes data for `slot`. Returns the bank hash.
pub fn find_slot_hash(data: &[u8], slot: u64) -> Option<[u8; 32]> {
    let len = read_u64(data, 0)? as usize;
    let len = len.min(MAX_ENTRIES).min(data.len().saturating_sub(8) / ENTRY);
    let (mut lo, mut hi) = (0usize, len);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let o = 8 + ENTRY * mid;
        let s = read_u64(data, o)?;
        if s == slot {
            let mut h = [0u8; 32];
            h.copy_from_slice(&data[o + 8..o + 40]);
            return Some(h);
        } else if s > slot {
            // Descending: larger slots come first, so the target is to the right.
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    None
}

/// Verifies `current_slot - beacon_slot <= BEACON_MAX_AGE_SLOTS` and that the entry exists.
pub fn verify_beacon(slot_hashes: &AccountInfo, current_slot: u64, beacon_slot: u64) -> Result<[u8; 32]> {
    require!(beacon_slot <= current_slot, VerdictError::BeaconSlotNotFound);
    require!(current_slot - beacon_slot <= BEACON_MAX_AGE_SLOTS, VerdictError::BeaconTooOld);
    let data = slot_hashes.try_borrow_data()?;
    find_slot_hash(&data, beacon_slot).ok_or_else(|| error!(VerdictError::BeaconSlotNotFound))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(slots: &[u64]) -> Vec<u8> {
        let mut v = (slots.len() as u64).to_le_bytes().to_vec();
        for &s in slots {
            v.extend_from_slice(&s.to_le_bytes());
            v.extend_from_slice(&[s as u8; 32]);
        }
        v
    }

    #[test]
    fn finds_every_entry_and_rejects_missing() {
        let slots: Vec<u64> = (0..300).rev().map(|i| 1000 + 2 * i).collect();
        let d = data(&slots);
        for &s in &slots {
            assert_eq!(find_slot_hash(&d, s), Some([s as u8; 32]));
        }
        assert_eq!(find_slot_hash(&d, 1001), None);
        assert_eq!(find_slot_hash(&d, 999), None);
        assert_eq!(find_slot_hash(&d, 5000), None);
        assert_eq!(find_slot_hash(&data(&[]), 1), None);
        assert_eq!(find_slot_hash(&[1, 2], 1), None);
    }

    #[test]
    fn truncated_len_is_clamped() {
        let mut d = data(&[10, 9, 8]);
        d[0] = 200; // claims 200 entries, only 3 present
        assert_eq!(find_slot_hash(&d, 8), Some([8; 32]));
        assert_eq!(find_slot_hash(&d, 7), None);
    }
}
