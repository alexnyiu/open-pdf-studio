//! Read-only allocator attribution for explicit performance diagnostics.
//! These estimates are not process RSS and do not include GPU/IOSurface memory.

#[cfg(target_os = "macos")]
pub fn allocator_snapshot() -> serde_json::Value {
    // Walking allocator zones can fault pages into residency and perturb both
    // RSS and rendering latency. Never enable this in ordinary acceptance runs.
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ENABLED.get_or_init(|| {
        std::env::var("OPEN_PDF_STUDIO_ALLOCATOR_DIAGNOSTICS").as_deref() == Ok("1")
    }) {
        return serde_json::json!({ "supported": true, "enabled": false });
    }
    // Layout and NULL-zone aggregation follow the installed macOS malloc.h.
    #[repr(C)]
    #[derive(Default)]
    struct Statistics {
        blocks_in_use: libc::c_uint,
        size_in_use: usize,
        max_size_in_use: usize,
        size_allocated: usize,
    }
    extern "C" {
        fn malloc_zone_statistics(zone: *mut libc::c_void, statistics: *mut Statistics);
    }
    let mut statistics = Statistics::default();
    unsafe { malloc_zone_statistics(std::ptr::null_mut(), &mut statistics) };
    serde_json::json!({
        "supported": true,
        "enabled": true,
        "blocksInUse": statistics.blocks_in_use,
        "bytesInUse": statistics.size_in_use,
        "bytesAllocated": statistics.size_allocated,
        "highWaterBytes": statistics.max_size_in_use,
        "reservedUnusedBytes": statistics.size_allocated.saturating_sub(statistics.size_in_use),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn allocator_snapshot() -> serde_json::Value {
    serde_json::json!({ "supported": false })
}
