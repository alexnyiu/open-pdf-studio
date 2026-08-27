//! Multi-process PDFium worker pool. Transparent to JS — the
//! `render_pdf_page` Tauri command routes through `WorkerPool::render`
//! when the pool is ready, falls back to in-proc PDFium otherwise.
//!
//! Architecture: spec/2026-05-19-multi-process-pdfium-design.md.

pub mod recovery;
pub mod routing;
pub mod spawn;
pub mod state;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

pub use state::{Status, WorkerState};

pub struct WorkerPool {
    pub workers: Vec<Arc<WorkerState>>,
    next_request_id: std::sync::atomic::AtomicU64,
    /// Laatste render-activiteit (ms sinds epoch) + of er al getrimd is sinds
    /// die activiteit. Open pagina-handles in de workers kosten op zware
    /// CAD-pagina's ruim 1 GB per worker; bij inactiviteit sturen we Trim.
    last_used_ms: std::sync::atomic::AtomicU64,
    trimmed: std::sync::atomic::AtomicBool,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn finite_positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

fn close_geometry_value(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-6 * left.abs().max(right.abs()).max(1.0)
}

fn valid_page_box(value: &PageBoxGeometry) -> bool {
    value.coordinate_space == "pdf-default-user-space"
        && value.unit == "pdf-user-unit"
        && value.origin == "pdf-user-space-zero"
        && value.x.is_finite()
        && value.y.is_finite()
        && finite_positive(value.width)
        && finite_positive(value.height)
}

fn page_box_is_within(outer: &PageBoxGeometry, inner: &PageBoxGeometry) -> bool {
    let tolerance = 1e-6;
    inner.x >= outer.x - tolerance
        && inner.y >= outer.y - tolerance
        && inner.x + inner.width <= outer.x + outer.width + tolerance
        && inner.y + inner.height <= outer.y + outer.height + tolerance
}

fn validate_pdfium_page_geometry(
    value: &PdfiumPageGeometry,
    page_index: u32,
    scale: f32,
    application_rotation: i32,
    width: u32,
    height: u32,
) -> Result<()> {
    if value.contract != "open-pdf-studio.pdfium.page-geometry"
        || value.schema_version != 1
        || value.page_index != page_index
        || !valid_page_box(&value.media_box)
        || !valid_page_box(&value.crop_box)
        || value
            .bleed_box
            .as_ref()
            .is_some_and(|entry| !valid_page_box(entry))
        || value
            .trim_box
            .as_ref()
            .is_some_and(|entry| !valid_page_box(entry))
        || value
            .art_box
            .as_ref()
            .is_some_and(|entry| !valid_page_box(entry))
        || !finite_positive(value.user_unit)
        || value.user_unit > 75_000.0
        || !matches!(
            value.user_unit_provenance.as_str(),
            "pdf-page-dictionary" | "pdf-default"
        )
    {
        return Err(anyhow!(
            "worker returned invalid PDF page geometry identity or boxes"
        ));
    }
    if !page_box_is_within(&value.media_box, &value.crop_box)
        || value
            .bleed_box
            .as_ref()
            .is_some_and(|entry| !page_box_is_within(&value.media_box, entry))
        || value
            .trim_box
            .as_ref()
            .is_some_and(|entry| !page_box_is_within(&value.media_box, entry))
        || value
            .art_box
            .as_ref()
            .is_some_and(|entry| !page_box_is_within(&value.media_box, entry))
    {
        return Err(anyhow!("worker returned a page box outside its MediaBox"));
    }
    let valid_rotation = |rotation: u16| matches!(rotation, 0 | 90 | 180 | 270);
    let expected_application = application_rotation.rem_euclid(360) as u16;
    if !valid_rotation(value.intrinsic_rotation_degrees_clockwise)
        || !valid_rotation(value.application_rotation_degrees_clockwise)
        || !valid_rotation(value.total_rotation_degrees_clockwise)
        || value.application_rotation_degrees_clockwise != expected_application
        || value.total_rotation_degrees_clockwise
            != (value.intrinsic_rotation_degrees_clockwise + expected_application) % 360
    {
        return Err(anyhow!("worker returned inconsistent page rotations"));
    }
    let unrotated_width = value.crop_box.width * value.user_unit;
    let unrotated_height = value.crop_box.height * value.user_unit;
    let (expected_display_width, expected_display_height) =
        if matches!(value.total_rotation_degrees_clockwise, 90 | 270) {
            (unrotated_height, unrotated_width)
        } else {
            (unrotated_width, unrotated_height)
        };
    if value.displayed_page.coordinate_space != "cropped-display-pdf-points"
        || value.displayed_page.unit != "pdf-point"
        || value.displayed_page.origin != "displayed-crop-top-left"
        || !close_geometry_value(value.displayed_page.width, expected_display_width)
        || !close_geometry_value(value.displayed_page.height, expected_display_height)
    {
        return Err(anyhow!(
            "worker returned inconsistent displayed page geometry"
        ));
    }
    let raster = &value.raster;
    let requested_scale = f64::from(scale);
    let ideal_width = expected_display_width * requested_scale;
    let ideal_height = expected_display_height * requested_scale;
    if width == 0
        || height == 0
        || !ideal_width.is_finite()
        || !ideal_height.is_finite()
        || ideal_width < 1.0
        || ideal_height < 1.0
        || ideal_width > f64::from(u32::MAX)
        || ideal_height > f64::from(u32::MAX)
    {
        return Err(anyhow!("worker returned invalid page raster dimensions"));
    }
    let requested_width = ideal_width.ceil() as u32;
    let requested_height = ideal_height.ceil() as u32;
    if raster.coordinate_space != "source-raster-pixels"
        || raster.unit != "pixel"
        || raster.origin != "top-left-pixel-edge"
        || !close_geometry_value(raster.requested_scale, requested_scale)
        || !close_geometry_value(raster.requested_dpi, requested_scale * 72.0)
        || !close_geometry_value(raster.ideal_width_px, ideal_width)
        || !close_geometry_value(raster.ideal_height_px, ideal_height)
        || raster.requested_width_px != requested_width
        || raster.requested_height_px != requested_height
        || raster.actual_width_px != width
        || raster.actual_height_px != height
        || !close_geometry_value(raster.width_delta_px, f64::from(width) - ideal_width)
        || !close_geometry_value(raster.height_delta_px, f64::from(height) - ideal_height)
        || raster.pdfium_adjusted != (width != requested_width || height != requested_height)
        || raster.rounding_method != "ceil-target-then-pdfium"
        || !raster.annotations_excluded
        || raster.forms_excluded
    {
        return Err(anyhow!(
            "worker returned inconsistent PDFium raster geometry"
        ));
    }
    Ok(())
}

/// Bovengrens op één worker-response-lees. Ruim boven elke legitieme render
/// (zwaarste blad in het corpus ~28 s whole-page); vangt alleen een écht
/// vastgelopen of protocol-incompatibele worker (bv. een verouderde sidecar
/// die een nieuwe `op` niet kent en niets terugstuurt). Zonder deze grens
/// blokkeert `read_line` eeuwig met de request-lock vast, waardoor die worker
/// voor ALLE volgende requests wedged raakt en de pagina blanco blijft. Bij
/// timeout -> Err -> in-proc-PDFium-fallback + respawn van de worker.
const WORKER_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const LOW_PRIORITY_IDLE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
const LOW_PRIORITY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);

#[derive(Clone, Copy, Debug)]
pub struct OcrRasterLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_pixels: u64,
    pub max_raster_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageBoxGeometry {
    pub coordinate_space: String,
    pub unit: String,
    pub origin: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayedPageGeometry {
    pub coordinate_space: String,
    pub unit: String,
    pub origin: String,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfiumRasterGeometry {
    pub coordinate_space: String,
    pub unit: String,
    pub origin: String,
    pub requested_dpi: f64,
    pub requested_scale: f64,
    pub ideal_width_px: f64,
    pub ideal_height_px: f64,
    pub requested_width_px: u32,
    pub requested_height_px: u32,
    pub actual_width_px: u32,
    pub actual_height_px: u32,
    pub width_delta_px: f64,
    pub height_delta_px: f64,
    pub pdfium_adjusted: bool,
    pub rounding_method: String,
    pub annotations_excluded: bool,
    pub forms_excluded: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfiumPageGeometry {
    pub contract: String,
    pub schema_version: u32,
    pub page_index: u32,
    pub media_box: PageBoxGeometry,
    pub crop_box: PageBoxGeometry,
    pub bleed_box: Option<PageBoxGeometry>,
    pub trim_box: Option<PageBoxGeometry>,
    pub art_box: Option<PageBoxGeometry>,
    pub user_unit: f64,
    pub user_unit_provenance: String,
    pub intrinsic_rotation_degrees_clockwise: u16,
    pub application_rotation_degrees_clockwise: u16,
    pub total_rotation_degrees_clockwise: u16,
    pub displayed_page: DisplayedPageGeometry,
    pub raster: PdfiumRasterGeometry,
}

#[derive(Debug)]
pub struct OcrRasterResult {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub page_geometry: PdfiumPageGeometry,
}

/// Pad naar de pdfium-worker-sidecar naast de hoofdbinary. Platform-correct
/// (`.exe` alleen op Windows) zodat respawn ook op Linux/macOS de juiste naam
/// zoekt.
pub(crate) fn worker_exe_path() -> std::path::PathBuf {
    let name = if cfg!(windows) {
        "pdfium-worker.exe"
    } else {
        "pdfium-worker"
    };
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .unwrap_or_else(|| std::path::PathBuf::from(name))
}

impl WorkerPool {
    pub fn new(workers: Vec<Arc<WorkerState>>) -> Self {
        Self {
            workers,
            next_request_id: std::sync::atomic::AtomicU64::new(1),
            last_used_ms: std::sync::atomic::AtomicU64::new(now_ms()),
            trimmed: std::sync::atomic::AtomicBool::new(true),
        }
    }

    fn touch(&self, worker: &WorkerState) {
        let now = now_ms();
        self.last_used_ms.store(now, Ordering::Release);
        self.trimmed.store(false, Ordering::Release);
        worker.last_used_ms.store(now, Ordering::Release);
        worker.trimmed.store(false, Ordering::Release);
    }

    /// Stuur Trim naar iedere levende worker die zélf langer dan `idle_ms`
    /// niets gerenderd heeft (eenmalig per inactiviteitsperiode). Per-worker:
    /// na de parallelle eerste render koelen de niet-affinity-workers zo
    /// vanzelf af (~1 GB parse-state per stuk terug), terwijl de worker die de
    /// interactieve tegels bedient heet blijft. Onder de per-worker
    /// request_lock zodat het nooit door een lopende exchange vlecht.
    pub async fn trim_if_idle(&self, idle_ms: u64) {
        let now = now_ms();
        for worker in &self.workers {
            if worker.status() != Status::Ready {
                continue;
            }
            if worker.trimmed.load(Ordering::Acquire) {
                continue;
            }
            if now.saturating_sub(worker.last_used_ms.load(Ordering::Acquire)) < idle_ms {
                continue;
            }
            worker.trimmed.store(true, Ordering::Release);
            let request_lock = worker.request_lock.clone();
            let _exchange = request_lock.lock().await;
            let mut stdin_guard = worker.stdin.lock().await;
            if let Some(stdin) = stdin_guard.as_mut() {
                let _ = stdin.write_all(b"{\"op\":\"trim\"}\n").await;
                let _ = stdin.flush().await;
                eprintln!(
                    "[pool] worker {} idle — pagina-handles getrimd",
                    worker.slot
                );
            }
        }
    }

    /// Returns true if at least one worker is Ready.
    pub fn is_ready(&self) -> bool {
        self.workers.iter().any(|w| w.status() == Status::Ready)
    }

    /// Snapshot of current queue depths (usize::MAX for dead slots).
    fn depths(&self) -> Vec<usize> {
        self.workers
            .iter()
            .map(|w| match w.status() {
                Status::Ready => w.queue_depth.load(Ordering::Acquire),
                _ => usize::MAX,
            })
            .collect()
    }

    async fn claim_low_priority_worker(&self) -> Result<Arc<WorkerState>> {
        let wait_started = std::time::Instant::now();
        loop {
            let depths = self.depths();
            if let Some(slot) = routing::pick_idle_worker(&depths) {
                let worker = self.workers[slot].clone();
                if worker.status() == Status::Ready
                    && worker
                        .queue_depth
                        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                {
                    return Ok(worker);
                }
            }
            if wait_started.elapsed() >= LOW_PRIORITY_IDLE_WAIT {
                return Err(anyhow!(
                    "low-priority PDFium request deferred: no idle worker within {} ms",
                    LOW_PRIORITY_IDLE_WAIT.as_millis()
                ));
            }
            tokio::time::sleep(LOW_PRIORITY_POLL_INTERVAL).await;
        }
    }

    /// Render via the pool. Returns (width, height, rgba_bytes).
    pub async fn render(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
    ) -> Result<(u32, u32, Vec<u8>)> {
        // First attempt. Pinned: al het werk voor dezelfde (path, page) —
        // volledige render, thumbnail, tegels — blijft op één worker, ook
        // onder druk. Uitwijken naar een koude worker zou die eerst de hele
        // content-stream laten parsen (seconden + ~1 GB parse-state op zware
        // CAD-bladen), terwijl de warme worker in ~0,4 s klaar is.
        let depths = self.depths();
        let slot = routing::pick_worker(path, page_index, &depths, true);
        let worker = self.workers[slot].clone();
        self.touch(&worker);
        worker.queue_depth.fetch_add(1, Ordering::Release);
        let result = self
            .render_on_worker(worker.clone(), path, page_index, scale, rotation)
            .await;
        worker.queue_depth.fetch_sub(1, Ordering::Release);

        if result.is_ok() {
            return result;
        }

        // First attempt failed → mark crash, retry on a DIFFERENT live slot
        let recover_task = recovery::handle_worker_crash(worker.clone(), worker_exe_path());
        tokio::spawn(recover_task);

        let mut depths_retry = self.depths();
        depths_retry[slot] = usize::MAX; // mark as dead for this retry
        if depths_retry.iter().all(|&d| d == usize::MAX) {
            return result; // no other workers — bubble up the error
        }
        let slot2 = routing::pick_worker(path, page_index, &depths_retry, true);
        let worker2 = self.workers[slot2].clone();
        self.touch(&worker2);
        worker2.queue_depth.fetch_add(1, Ordering::Release);
        let result2 = self
            .render_on_worker(worker2.clone(), path, page_index, scale, rotation)
            .await;
        worker2.queue_depth.fetch_sub(1, Ordering::Release);
        result2
    }

    /// Render only when one worker is completely idle. The OCR raster lane
    /// never starts behind an already queued or active
    /// request, and it fails after a bounded wait instead of falling back to
    /// in-process PDFium on the Tauri main process.
    pub async fn render_ocr_low_priority(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        limits: OcrRasterLimits,
    ) -> Result<OcrRasterResult> {
        let worker = self.claim_low_priority_worker().await?;

        self.touch(&worker);
        let result = self
            .render_on_worker_with_limits(
                worker.clone(),
                path,
                page_index,
                scale,
                rotation,
                Some(limits),
            )
            .await;
        worker.queue_depth.fetch_sub(1, Ordering::Release);
        if result.is_err() {
            tokio::spawn(recovery::handle_worker_crash(worker, worker_exe_path()));
        }
        let (width, height, rgba, page_geometry) = result?;
        Ok(OcrRasterResult {
            width,
            height,
            rgba,
            page_geometry: page_geometry
                .ok_or_else(|| anyhow!("OCR PDFium response omitted page geometry"))?,
        })
    }

    /// Query canonical PDFium page geometry with the same bounded render that
    /// determines the actual raster dimensions. The pixel buffer is discarded
    /// before this metadata crosses the Tauri command boundary.
    pub async fn query_page_geometry_low_priority(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        limits: OcrRasterLimits,
    ) -> Result<PdfiumPageGeometry> {
        let worker = self.claim_low_priority_worker().await?;
        self.touch(&worker);
        let result = self
            .page_geometry_on_worker(worker.clone(), path, page_index, scale, rotation, limits)
            .await;
        worker.queue_depth.fetch_sub(1, Ordering::Release);
        if result.is_err() {
            tokio::spawn(recovery::handle_worker_crash(worker, worker_exe_path()));
        }
        result
    }

    async fn page_geometry_on_worker(
        &self,
        worker: Arc<WorkerState>,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        limits: OcrRasterLimits,
    ) -> Result<PdfiumPageGeometry> {
        let request_lock = worker.request_lock.clone();
        let _exchange = request_lock.lock().await;
        let id = self.next_request_id.fetch_add(1, Ordering::Release);
        let req = json!({
            "op": "page_geometry",
            "id": id,
            "path": path,
            "page_index": page_index,
            "scale": scale,
            "rotation": rotation,
            "max_width": limits.max_width,
            "max_height": limits.max_height,
            "max_pixels": limits.max_pixels,
            "max_raster_bytes": limits.max_raster_bytes,
        });
        let req_line = format!("{}\n", req);
        {
            let mut stdin_guard = worker.stdin.lock().await;
            let stdin = stdin_guard
                .as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdin", worker.slot))?;
            stdin
                .write_all(req_line.as_bytes())
                .await
                .with_context(|| {
                    format!("write page geometry request to worker {}", worker.slot)
                })?;
            stdin.flush().await?;
        }
        let mut resp_line = String::new();
        {
            let mut stdout_guard = worker.stdout.lock().await;
            let stdout = stdout_guard
                .as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdout", worker.slot))?;
            match tokio::time::timeout(WORKER_READ_TIMEOUT, stdout.read_line(&mut resp_line)).await
            {
                Ok(result) => {
                    result.with_context(|| {
                        format!("read page geometry from worker {}", worker.slot)
                    })?;
                }
                Err(_) => {
                    return Err(anyhow!(
                        "worker {} page geometry timeout ({}s)",
                        worker.slot,
                        WORKER_READ_TIMEOUT.as_secs()
                    ));
                }
            }
        }
        if resp_line.is_empty() || resp_line.len() > 256 * 1024 {
            return Err(anyhow!(
                "worker {} returned an invalid page geometry response size",
                worker.slot
            ));
        }
        let resp: serde_json::Value = serde_json::from_str(&resp_line)
            .with_context(|| format!("parse worker {} page geometry response", worker.slot))?;
        let response = resp.as_object().ok_or_else(|| {
            anyhow!(
                "worker {} returned a non-object page geometry response",
                worker.slot
            )
        })?;
        if response.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
            return Err(anyhow!(
                "worker {} returned a mismatched page geometry response id",
                worker.slot
            ));
        }
        if !resp["ok"].as_bool().unwrap_or(false) {
            if response.len() != 3
                || !response.contains_key("id")
                || !response.contains_key("ok")
                || !response.contains_key("error")
            {
                return Err(anyhow!(
                    "worker {} returned a malformed page geometry error",
                    worker.slot
                ));
            }
            return Err(anyhow!(
                "worker {} page geometry error: {}",
                worker.slot,
                resp["error"].as_str().unwrap_or("unknown")
            ));
        }
        if response.len() != 3
            || !response.contains_key("id")
            || !response.contains_key("ok")
            || !response.contains_key("pageGeometry")
        {
            return Err(anyhow!(
                "worker {} returned a malformed page geometry response",
                worker.slot
            ));
        }
        let geometry: PdfiumPageGeometry = serde_json::from_value(resp["pageGeometry"].clone())
            .with_context(|| format!("parse worker {} page geometry", worker.slot))?;
        let width = geometry.raster.actual_width_px;
        let height = geometry.raster.actual_height_px;
        let pixels = u64::from(width) * u64::from(height);
        let bytes = pixels
            .checked_mul(4)
            .ok_or_else(|| anyhow!("worker {} page geometry byte count overflow", worker.slot))?;
        if width > limits.max_width
            || height > limits.max_height
            || pixels > limits.max_pixels
            || bytes > limits.max_raster_bytes
        {
            return Err(anyhow!(
                "worker {} returned page geometry beyond requested limits",
                worker.slot
            ));
        }
        validate_pdfium_page_geometry(&geometry, page_index, scale, rotation, width, height)?;
        Ok(geometry)
    }

    async fn render_on_worker(
        &self,
        worker: Arc<WorkerState>,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
    ) -> Result<(u32, u32, Vec<u8>)> {
        let (width, height, rgba, _) = self
            .render_on_worker_with_limits(worker, path, page_index, scale, rotation, None)
            .await?;
        Ok((width, height, rgba))
    }

    async fn render_on_worker_with_limits(
        &self,
        worker: Arc<WorkerState>,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        ocr_limits: Option<OcrRasterLimits>,
    ) -> Result<(u32, u32, Vec<u8>, Option<PdfiumPageGeometry>)> {
        // Eén request tegelijk per worker: het draadprotocol heeft geen id-demux
        // en de SHM-regio wordt per response overschreven.
        let request_lock = worker.request_lock.clone();
        let _t_queue = std::time::Instant::now();
        let _exchange = request_lock.lock().await;
        let _t_run = std::time::Instant::now();
        let _plog = PoolTrace::new(
            worker.slot,
            "render",
            path,
            page_index,
            scale,
            _t_queue,
            _t_run,
        );
        let id = self.next_request_id.fetch_add(1, Ordering::Release);

        let req = if let Some(limits) = ocr_limits {
            json!({
                "op": "render_ocr",
                "id": id,
                "path": path,
                "page_index": page_index,
                "scale": scale,
                "rotation": rotation,
                "max_width": limits.max_width,
                "max_height": limits.max_height,
                "max_pixels": limits.max_pixels,
                "max_raster_bytes": limits.max_raster_bytes,
            })
        } else {
            json!({
                "op": "render",
                "id": id,
                "path": path,
                "page_index": page_index,
                "scale": scale,
                "rotation": rotation,
            })
        };
        let req_line = format!("{}\n", req);

        // Write request
        {
            let mut stdin_guard = worker.stdin.lock().await;
            let stdin = stdin_guard
                .as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdin", worker.slot))?;
            stdin
                .write_all(req_line.as_bytes())
                .await
                .with_context(|| format!("write to worker {}", worker.slot))?;
            stdin.flush().await?;
        }

        // Read response (met timeout: een vastgelopen/verouderde worker die
        // niets terugstuurt mag de request-lock niet eeuwig vasthouden).
        let mut resp_line = String::new();
        {
            let mut stdout_guard = worker.stdout.lock().await;
            let stdout = stdout_guard
                .as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdout", worker.slot))?;
            match tokio::time::timeout(WORKER_READ_TIMEOUT, stdout.read_line(&mut resp_line)).await
            {
                Ok(r) => {
                    r.with_context(|| format!("read from worker {}", worker.slot))?;
                }
                Err(_) => {
                    return Err(anyhow!(
                        "worker {} read timeout ({}s)",
                        worker.slot,
                        WORKER_READ_TIMEOUT.as_secs()
                    ))
                }
            }
        }

        if resp_line.is_empty() {
            return Err(anyhow!("worker {} EOF", worker.slot));
        }

        let resp: serde_json::Value = serde_json::from_str(&resp_line)
            .with_context(|| format!("parse worker {} response: {}", worker.slot, resp_line))?;

        if !resp["ok"].as_bool().unwrap_or(false) {
            let err = resp["error"].as_str().unwrap_or("unknown");
            return Err(anyhow!("worker {} render error: {}", worker.slot, err));
        }

        let w = resp["w"].as_u64().unwrap_or(0) as u32;
        let h = resp["h"].as_u64().unwrap_or(0) as u32;
        let shm_bytes = resp["shm_bytes"].as_u64().unwrap_or(0) as usize;

        let expected_bytes = usize::try_from(w)
            .ok()
            .and_then(|width| {
                usize::try_from(h)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| {
                anyhow!(
                    "worker {} returned overflowing raster dimensions",
                    worker.slot
                )
            })?;
        if w == 0 || h == 0 || shm_bytes != expected_bytes {
            return Err(anyhow!(
                "worker {} returned inconsistent raster metadata",
                worker.slot
            ));
        }
        if let Some(limits) = ocr_limits {
            let pixels = u64::from(w) * u64::from(h);
            if w > limits.max_width
                || h > limits.max_height
                || pixels > limits.max_pixels
                || shm_bytes as u64 > limits.max_raster_bytes
            {
                return Err(anyhow!(
                    "worker {} returned an OCR raster beyond its limits",
                    worker.slot
                ));
            }
        }

        // Read RGBA from SHM
        let shm_guard = worker.shm.lock().await;
        let mmap = shm_guard
            .as_ref()
            .ok_or_else(|| anyhow!("worker {} has no shm", worker.slot))?;
        const HEADER: usize = 32;
        if shm_bytes + HEADER > mmap.len() {
            return Err(anyhow!(
                "worker {} shm_bytes {} exceeds region",
                worker.slot,
                shm_bytes
            ));
        }
        let rgba = mmap[HEADER..HEADER + shm_bytes].to_vec();

        let page_geometry = if ocr_limits.is_some() {
            let geometry: PdfiumPageGeometry = serde_json::from_value(resp["pageGeometry"].clone())
                .with_context(|| format!("parse worker {} page geometry", worker.slot))?;
            validate_pdfium_page_geometry(&geometry, page_index, scale, rotation, w, h)?;
            Some(geometry)
        } else {
            None
        };

        Ok((w, h, rgba, page_geometry))
    }

    /// Render a page REGION (tile) via the pool. Small tiles fit the 64 MB SHM
    /// easily, so — unlike whole huge pages — these succeed via the pool and
    /// render in a SEPARATE process (safe: no concurrent in-proc PDFium). One
    /// attempt; on error the caller falls back to in-proc.
    ///
    /// `spread`: true = tegels over alle workers spreiden (parallelle eerste
    /// render); false = affinity op (pad,pagina) zodat interactieve tegels
    /// steeds dezelfde worker (met hete pagina-handle) raken en de overige
    /// workers hun ~1 GB parse-state niet hoeven te dragen.
    pub async fn render_region(
        &self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
        spread: bool,
    ) -> Result<(u32, u32, Vec<u8>)> {
        let depths = self.depths();
        // Salt de affiniteit met de regio-coördinaten wanneer spreiding gewenst
        // is: tegels van DEZELFDE pagina landen dan op verschillende workers.
        let salt = if spread {
            region_x_pt.to_bits() ^ region_y_pt.to_bits().rotate_left(16)
        } else {
            0
        };
        // Zonder spread pinnen we op de affinity-worker (geen overflow-
        // uitwijk): één worker draagt de dure parse-state en serialiseert de
        // tegels à ~0,4 s. Met spread is uitwijken juist gewenst.
        let slot = routing::pick_worker(path, page_index ^ salt, &depths, !spread);
        let worker = self.workers[slot].clone();
        self.touch(&worker);
        worker.queue_depth.fetch_add(1, Ordering::Release);
        let result = self
            .render_region_on_worker(
                worker.clone(),
                path,
                page_index,
                scale,
                rotation,
                region_x_pt,
                region_y_pt,
                region_w_pt,
                region_h_pt,
            )
            .await;
        worker.queue_depth.fetch_sub(1, Ordering::Release);
        // Geen retry (de aanroeper valt terug op in-proc PDFium), maar een
        // gefaalde/getimede worker is mogelijk gedesynchroniseerd — respawn
        // hem zodat de volgende tegel niet weer op een wedged worker landt.
        if result.is_err() {
            tokio::spawn(recovery::handle_worker_crash(
                worker.clone(),
                worker_exe_path(),
            ));
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn render_region_on_worker(
        &self,
        worker: Arc<WorkerState>,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
    ) -> Result<(u32, u32, Vec<u8>)> {
        // Zelfde volledige-round-trip-serialisatie als render_on_worker.
        let request_lock = worker.request_lock.clone();
        let _t_queue = std::time::Instant::now();
        let _exchange = request_lock.lock().await;
        let _t_run = std::time::Instant::now();
        let _plog = PoolTrace::new(
            worker.slot,
            "region",
            path,
            page_index,
            scale,
            _t_queue,
            _t_run,
        );
        let id = self.next_request_id.fetch_add(1, Ordering::Release);

        let req = json!({
            "op": "render_region",
            "id": id,
            "path": path,
            "page_index": page_index,
            "scale": scale,
            "rotation": rotation,
            "region_x_pt": region_x_pt,
            "region_y_pt": region_y_pt,
            "region_w_pt": region_w_pt,
            "region_h_pt": region_h_pt,
        });
        let req_line = format!("{}\n", req);

        {
            let mut stdin_guard = worker.stdin.lock().await;
            let stdin = stdin_guard
                .as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdin", worker.slot))?;
            stdin
                .write_all(req_line.as_bytes())
                .await
                .with_context(|| format!("write to worker {}", worker.slot))?;
            stdin.flush().await?;
        }

        let mut resp_line = String::new();
        {
            let mut stdout_guard = worker.stdout.lock().await;
            let stdout = stdout_guard
                .as_mut()
                .ok_or_else(|| anyhow!("worker {} has no stdout", worker.slot))?;
            match tokio::time::timeout(WORKER_READ_TIMEOUT, stdout.read_line(&mut resp_line)).await
            {
                Ok(r) => {
                    r.with_context(|| format!("read from worker {}", worker.slot))?;
                }
                Err(_) => {
                    return Err(anyhow!(
                        "worker {} region read timeout ({}s)",
                        worker.slot,
                        WORKER_READ_TIMEOUT.as_secs()
                    ))
                }
            }
        }

        if resp_line.is_empty() {
            return Err(anyhow!("worker {} EOF", worker.slot));
        }

        let resp: serde_json::Value = serde_json::from_str(&resp_line)
            .with_context(|| format!("parse worker {} response: {}", worker.slot, resp_line))?;

        if !resp["ok"].as_bool().unwrap_or(false) {
            let err = resp["error"].as_str().unwrap_or("unknown");
            return Err(anyhow!(
                "worker {} region render error: {}",
                worker.slot,
                err
            ));
        }

        let w = resp["w"].as_u64().unwrap_or(0) as u32;
        let h = resp["h"].as_u64().unwrap_or(0) as u32;
        let shm_bytes = resp["shm_bytes"].as_u64().unwrap_or(0) as usize;

        let shm_guard = worker.shm.lock().await;
        let mmap = shm_guard
            .as_ref()
            .ok_or_else(|| anyhow!("worker {} has no shm", worker.slot))?;
        const HEADER: usize = 32;
        if shm_bytes + HEADER > mmap.len() {
            return Err(anyhow!(
                "worker {} shm_bytes {} exceeds region",
                worker.slot,
                shm_bytes
            ));
        }
        let rgba = mmap[HEADER..HEADER + shm_bytes].to_vec();

        Ok((w, h, rgba))
    }
}

/// Tijdelijke meet-tracer (aan met env `OPDS_POOL_TRACE=1`): schrijft per
/// pool-request de rij-wachttijd en uitvoerduur naar
/// %TEMP%/opds-pool-trace.log. RAII: logt bij drop, dus ook bij fouten.
struct PoolTrace {
    line: Option<String>,
    t_run: std::time::Instant,
}

impl PoolTrace {
    fn new(
        slot: u32,
        op: &'static str,
        path: &str,
        page: u32,
        scale: f32,
        t_queue: std::time::Instant,
        t_run: std::time::Instant,
    ) -> Self {
        if std::env::var("OPDS_POOL_TRACE").ok().as_deref() != Some("1") {
            return Self { line: None, t_run };
        }
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let wait_ms = t_run.duration_since(t_queue).as_millis();
        Self {
            line: Some(format!(
                "w{} {} p{} s{:.3} wait={}ms {}",
                slot, op, page, scale, wait_ms, name
            )),
            t_run,
        }
    }
}

impl Drop for PoolTrace {
    fn drop(&mut self) {
        if let Some(l) = self.line.take() {
            use std::io::Write;
            let p = std::env::temp_dir().join("opds-pool-trace.log");
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
            {
                let _ = writeln!(f, "{} run={}ms", l, self.t_run.elapsed().as_millis());
            }
        }
    }
}

#[cfg(test)]
mod page_geometry_tests {
    use super::*;

    fn valid_geometry() -> PdfiumPageGeometry {
        PdfiumPageGeometry {
            contract: "open-pdf-studio.pdfium.page-geometry".to_string(),
            schema_version: 1,
            page_index: 0,
            media_box: PageBoxGeometry {
                coordinate_space: "pdf-default-user-space".to_string(),
                unit: "pdf-user-unit".to_string(),
                origin: "pdf-user-space-zero".to_string(),
                x: -20.0,
                y: -30.0,
                width: 700.0,
                height: 900.0,
            },
            crop_box: PageBoxGeometry {
                coordinate_space: "pdf-default-user-space".to_string(),
                unit: "pdf-user-unit".to_string(),
                origin: "pdf-user-space-zero".to_string(),
                x: 0.0,
                y: 0.0,
                width: 612.0,
                height: 792.0,
            },
            bleed_box: None,
            trim_box: None,
            art_box: None,
            user_unit: 1.0,
            user_unit_provenance: "pdf-default".to_string(),
            intrinsic_rotation_degrees_clockwise: 0,
            application_rotation_degrees_clockwise: 90,
            total_rotation_degrees_clockwise: 90,
            displayed_page: DisplayedPageGeometry {
                coordinate_space: "cropped-display-pdf-points".to_string(),
                unit: "pdf-point".to_string(),
                origin: "displayed-crop-top-left".to_string(),
                width: 792.0,
                height: 612.0,
            },
            raster: PdfiumRasterGeometry {
                coordinate_space: "source-raster-pixels".to_string(),
                unit: "pixel".to_string(),
                origin: "top-left-pixel-edge".to_string(),
                requested_dpi: 144.0,
                requested_scale: 2.0,
                ideal_width_px: 1584.0,
                ideal_height_px: 1224.0,
                requested_width_px: 1584,
                requested_height_px: 1224,
                actual_width_px: 1584,
                actual_height_px: 1224,
                width_delta_px: 0.0,
                height_delta_px: 0.0,
                pdfium_adjusted: false,
                rounding_method: "ceil-target-then-pdfium".to_string(),
                annotations_excluded: true,
                forms_excluded: false,
            },
        }
    }

    #[test]
    fn canonical_pdfium_geometry_is_strictly_validated() {
        let geometry = valid_geometry();
        validate_pdfium_page_geometry(&geometry, 0, 2.0, 90, 1584, 1224).unwrap();

        let mut outside = geometry.clone();
        outside.crop_box.x = -30.0;
        assert!(validate_pdfium_page_geometry(&outside, 0, 2.0, 90, 1584, 1224).is_err());

        let mut wrong_actual = geometry.clone();
        wrong_actual.raster.actual_width_px = 1583;
        assert!(validate_pdfium_page_geometry(&wrong_actual, 0, 2.0, 90, 1584, 1224).is_err());
    }

    #[test]
    fn page_geometry_deserialization_rejects_unknown_keys() {
        let mut value = serde_json::to_value(valid_geometry()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_string(), serde_json::Value::Bool(true));
        assert!(serde_json::from_value::<PdfiumPageGeometry>(value).is_err());
    }
}
