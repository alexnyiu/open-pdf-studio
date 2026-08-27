use std::hash::{Hash, Hasher};

/// Hybrid affinity+overflow routing. Returns the worker slot index
/// (0..N-1) to dispatch the next render to.
///
/// Rules:
///   1. Compute affinity = hash(path, page_index) % N
///   2. If `pin` OR depths[affinity] <= OVERFLOW_THRESHOLD: use affinity
///   3. Otherwise: pick the least-busy slot
///
/// `pin = true` schakelt de overflow-uitwijk uit: alle werk voor dezelfde
/// (path, page) blijft dan op één worker, ook onder druk. Dat is essentieel
/// voor zware CAD-pagina's — een uitwijk-worker moet eerst de volledige
/// content-stream parsen (seconden, ~1+ GB parse-state per worker), terwijl
/// wachten op de warme worker een tegel in ~0,4 s oplevert. Overflow-routing
/// is alleen nuttig voor goedkope pagina's (spread-pad).
///
/// Dead slots (depth == usize::MAX as sentinel) are skipped.
pub const OVERFLOW_THRESHOLD: usize = 2;

/// Low-priority work may start only on a live worker with no queued or active
/// request. Unlike interactive routing, this deliberately ignores affinity:
/// OCR must not wait in front of a page render the user can see.
pub fn pick_idle_worker(depths: &[usize]) -> Option<usize> {
    depths.iter().position(|&depth| depth == 0)
}

pub fn pick_worker(path: &str, page_index: u32, depths: &[usize], pin: bool) -> usize {
    assert!(!depths.is_empty(), "depths cannot be empty");

    let alive: Vec<usize> = depths
        .iter()
        .enumerate()
        .filter(|(_, &d)| d != usize::MAX)
        .map(|(i, _)| i)
        .collect();
    assert!(!alive.is_empty(), "no live workers");

    let n_alive = alive.len();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    page_index.hash(&mut h);
    let affinity_idx = (h.finish() as usize) % n_alive;
    let affinity = alive[affinity_idx];

    if pin || depths[affinity] <= OVERFLOW_THRESHOLD {
        return affinity;
    }

    // Overflow: least-busy among alive
    *alive.iter().min_by_key(|&&i| depths[i]).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affinity_used_when_depth_under_threshold() {
        let depths = vec![0, 0, 0, 0, 0];
        // Same (path, page) should always pick the same worker
        let a = pick_worker("foo.pdf", 5, &depths, false);
        let b = pick_worker("foo.pdf", 5, &depths, false);
        assert_eq!(a, b);
        assert!(a < 5);
    }

    #[test]
    fn different_pages_distribute() {
        let depths = vec![0, 0, 0, 0, 0];
        let mut picks = std::collections::HashSet::new();
        for p in 0..20 {
            picks.insert(pick_worker("foo.pdf", p, &depths, false));
        }
        // 20 pages across 5 workers should hit at least 3 different slots
        assert!(
            picks.len() >= 3,
            "got only {} distinct workers",
            picks.len()
        );
    }

    #[test]
    fn overflow_falls_back_to_least_busy() {
        // Force affinity = slot 0 (load all into slot 0)
        // We can't easily control hash output, so test the BEHAVIOR:
        // if every slot has depth 3, the affinity target ALSO has depth 3 → overflow.
        // The fallback picks least-busy, which will be the slot with the lowest depth.
        let depths = vec![5, 1, 5, 5, 5];
        for p in 0..10 {
            let picked = pick_worker("foo.pdf", p, &depths, false);
            // Picked slot must EITHER be the affinity target (if <= 2) OR slot 1 (least busy)
            // Since depths[1] = 1 is the only one <= 2, picked must be 1
            assert_eq!(picked, 1, "page {} picked {}", p, picked);
        }
    }

    #[test]
    fn pinned_ignores_overflow() {
        // Alle sloten druk: zonder pin zou de router uitwijken naar het minst
        // drukke slot; met pin blijft dezelfde (path, page) op zijn
        // affinity-slot, ongeacht de diepte.
        let depths = vec![5, 1, 5, 5, 5];
        let calm = vec![0, 0, 0, 0, 0];
        for p in 0..10 {
            let expected = pick_worker("foo.pdf", p, &calm, false); // = affinity
            let pinned = pick_worker("foo.pdf", p, &depths, true);
            assert_eq!(pinned, expected, "page {} week uit ondanks pin", p);
        }
    }

    #[test]
    fn skips_dead_workers() {
        let depths = vec![usize::MAX, 0, usize::MAX, 0, usize::MAX]; // only 1 and 3 alive
        for p in 0..10 {
            let picked = pick_worker("foo.pdf", p, &depths, false);
            assert!(picked == 1 || picked == 3, "got {}", picked);
        }
    }

    #[test]
    fn low_priority_uses_only_an_idle_worker() {
        assert_eq!(pick_idle_worker(&[usize::MAX, 2, 0, 1]), Some(2));
        assert_eq!(pick_idle_worker(&[usize::MAX, 2, 1]), None);
    }

    #[test]
    #[should_panic(expected = "no live workers")]
    fn panics_when_all_dead() {
        let depths = vec![usize::MAX, usize::MAX, usize::MAX];
        pick_worker("foo.pdf", 0, &depths, false);
    }
}
