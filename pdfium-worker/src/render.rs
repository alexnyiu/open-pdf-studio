use crate::protocol::{
    DisplayedPageGeometry, PageBoxGeometry, PdfiumPageGeometry, PdfiumRasterGeometry,
    PDFIUM_PAGE_GEOMETRY_CONTRACT, PDFIUM_PAGE_GEOMETRY_SCHEMA_VERSION,
};
use anyhow::{anyhow, Context, Result};
use pdfium_render::prelude::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub struct RenderResult {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub page_geometry: Option<PdfiumPageGeometry>,
}

#[derive(Clone, Copy, Debug)]
pub struct RasterLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_pixels: u64,
    pub max_raster_bytes: u64,
}

fn bounded_raster_size(
    target_width: f64,
    target_height: f64,
    limits: Option<RasterLimits>,
) -> Result<(i32, i32)> {
    if !target_width.is_finite()
        || !target_height.is_finite()
        || target_width < 1.0
        || target_height < 1.0
        || target_width > f64::from(i32::MAX)
        || target_height > f64::from(i32::MAX)
    {
        return Err(anyhow!("render dimensions are invalid"));
    }
    let width = target_width as u64;
    let height = target_height as u64;
    let pixels = width
        .checked_mul(height)
        .ok_or_else(|| anyhow!("render pixel count overflow"))?;
    let bytes = pixels
        .checked_mul(4)
        .ok_or_else(|| anyhow!("render byte count overflow"))?;
    if let Some(limits) = limits {
        if width > u64::from(limits.max_width)
            || height > u64::from(limits.max_height)
            || pixels > limits.max_pixels
            || bytes > limits.max_raster_bytes
        {
            return Err(anyhow!(
                "OCR raster exceeds the requested allocation limits"
            ));
        }
    }
    Ok((width as i32, height as i32))
}

fn inherited_user_unit(
    document: &lopdf::Document,
    mut object_id: lopdf::ObjectId,
) -> Result<(f64, String)> {
    let mut visited = HashSet::new();
    while visited.insert(object_id) {
        let dictionary = document
            .get_dictionary(object_id)
            .map_err(|error| anyhow!("read PDF page dictionary: {error}"))?;
        if let Ok(value) = dictionary.get(b"UserUnit") {
            let (_, direct) = document
                .dereference(value)
                .map_err(|error| anyhow!("dereference PDF UserUnit: {error}"))?;
            let user_unit = f64::from(
                direct
                    .as_float()
                    .map_err(|error| anyhow!("PDF UserUnit is not numeric: {error}"))?,
            );
            if !user_unit.is_finite() || user_unit <= 0.0 || user_unit > 75_000.0 {
                return Err(anyhow!("PDF UserUnit is outside the supported range"));
            }
            return Ok((user_unit, "pdf-page-dictionary".to_string()));
        }
        object_id = match dictionary
            .get(b"Parent")
            .and_then(lopdf::Object::as_reference)
        {
            Ok(parent) => parent,
            Err(_) => return Ok((1.0, "pdf-default".to_string())),
        };
    }
    Err(anyhow!("PDF page tree contains a cycle"))
}

fn read_page_user_units(bytes: &[u8]) -> Result<Vec<(f64, String)>> {
    let document = lopdf::Document::load_mem(bytes)
        .map_err(|error| anyhow!("parse PDF page dictionaries: {error}"))?;
    document
        .page_iter()
        .map(|object_id| inherited_user_unit(&document, object_id))
        .collect()
}

fn page_box_geometry(rect: PdfRect) -> PageBoxGeometry {
    PageBoxGeometry {
        coordinate_space: "pdf-default-user-space".to_string(),
        unit: "pdf-user-unit".to_string(),
        origin: "pdf-user-space-zero".to_string(),
        x: f64::from(rect.left().value),
        y: f64::from(rect.bottom().value),
        width: f64::from(rect.width().value),
        height: f64::from(rect.height().value),
    }
}

fn normalized_right_angle(rotation: i32) -> Result<u16> {
    match rotation.rem_euclid(360) {
        0 => Ok(0),
        90 => Ok(90),
        180 => Ok(180),
        270 => Ok(270),
        other => Err(anyhow!("unsupported rotation {other}")),
    }
}

fn build_page_geometry(
    page: &PdfPage<'_>,
    page_index: u32,
    user_unit: f64,
    user_unit_provenance: &str,
    scale: f32,
    application_rotation: i32,
    actual_width: u32,
    actual_height: u32,
) -> Result<PdfiumPageGeometry> {
    let media = page
        .boundaries()
        .media()
        .map_err(|error| anyhow!("read PDF MediaBox: {error}"))?
        .bounds;
    let crop = page
        .boundaries()
        .crop()
        .map(|boundary| boundary.bounds)
        .unwrap_or(media);
    let bleed_box = page
        .boundaries()
        .bleed()
        .ok()
        .map(|boundary| page_box_geometry(boundary.bounds));
    let trim_box = page
        .boundaries()
        .trim()
        .ok()
        .map(|boundary| page_box_geometry(boundary.bounds));
    let art_box = page
        .boundaries()
        .art()
        .ok()
        .map(|boundary| page_box_geometry(boundary.bounds));
    let media_box = page_box_geometry(media);
    let crop_box = page_box_geometry(crop);
    let intrinsic_rotation = page
        .rotation()
        .map_err(|error| anyhow!("read intrinsic page rotation: {error}"))?
        .as_degrees() as u16;
    let application_rotation = normalized_right_angle(application_rotation)?;
    let total_rotation = (intrinsic_rotation + application_rotation) % 360;
    let unrotated_width = crop_box.width * user_unit;
    let unrotated_height = crop_box.height * user_unit;
    let (displayed_width, displayed_height) = if total_rotation == 90 || total_rotation == 270 {
        (unrotated_height, unrotated_width)
    } else {
        (unrotated_width, unrotated_height)
    };
    let requested_scale = f64::from(scale);
    let requested_dpi = requested_scale * 72.0;
    let ideal_width = displayed_width * requested_scale;
    let ideal_height = displayed_height * requested_scale;
    let requested_width = ideal_width.ceil();
    let requested_height = ideal_height.ceil();
    if !ideal_width.is_finite()
        || !ideal_height.is_finite()
        || requested_width < 1.0
        || requested_height < 1.0
        || requested_width > f64::from(u32::MAX)
        || requested_height > f64::from(u32::MAX)
    {
        return Err(anyhow!("page geometry raster dimensions are invalid"));
    }
    let requested_width = requested_width as u32;
    let requested_height = requested_height as u32;
    Ok(PdfiumPageGeometry {
        contract: PDFIUM_PAGE_GEOMETRY_CONTRACT.to_string(),
        schema_version: PDFIUM_PAGE_GEOMETRY_SCHEMA_VERSION,
        page_index,
        media_box,
        crop_box,
        bleed_box,
        trim_box,
        art_box,
        user_unit,
        user_unit_provenance: user_unit_provenance.to_string(),
        intrinsic_rotation_degrees_clockwise: intrinsic_rotation,
        application_rotation_degrees_clockwise: application_rotation,
        total_rotation_degrees_clockwise: total_rotation,
        displayed_page: DisplayedPageGeometry {
            coordinate_space: "cropped-display-pdf-points".to_string(),
            unit: "pdf-point".to_string(),
            origin: "displayed-crop-top-left".to_string(),
            width: displayed_width,
            height: displayed_height,
        },
        raster: PdfiumRasterGeometry {
            coordinate_space: "source-raster-pixels".to_string(),
            unit: "pixel".to_string(),
            origin: "top-left-pixel-edge".to_string(),
            requested_dpi,
            requested_scale,
            ideal_width_px: ideal_width,
            ideal_height_px: ideal_height,
            requested_width_px: requested_width,
            requested_height_px: requested_height,
            actual_width_px: actual_width,
            actual_height_px: actual_height,
            width_delta_px: f64::from(actual_width) - ideal_width,
            height_delta_px: f64::from(actual_height) - ideal_height,
            pdfium_adjusted: actual_width != requested_width || actual_height != requested_height,
            rounding_method: "ceil-target-then-pdfium".to_string(),
            annotations_excluded: true,
            forms_excluded: false,
        },
    })
}

// Eén Pdfium-instantie voor de levensduur van de worker. Nodig om geladen
// documenten te kunnen CACHEN: PdfDocument leent van Pdfium, en via een
// 'static Pdfium krijgt de handle een 'static levensduur (zelfde patroon als
// pdfium_renderer.rs in de app). NB: pdfium-render staat maar ÉÉN binding per
// proces toe (PdfiumLibraryBindingsAlreadyInitialized) — alles loopt dus via
// deze ene instantie.
static PDFIUM: OnceLock<Pdfium> = OnceLock::new();

fn absolute_library_path(directory: PathBuf) -> PathBuf {
    let candidate = Pdfium::pdfium_platform_library_name_at_path(&directory);
    candidate.canonicalize().unwrap_or(candidate)
}

fn pdfium_library_candidates(exe_path: Option<&Path>, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(exe_dir) = exe_path.and_then(Path::parent) {
        directories.extend([
            exe_dir.to_path_buf(),
            // macOS application bundle resources.
            exe_dir.join("../Resources"),
            // Tauri AppImage/deb resources. Product-name and identifier-style
            // directories are both accepted because bundle layouts can differ.
            exe_dir.join("../lib/Open PDF Studio"),
            exe_dir.join("../lib/open-pdf-studio"),
        ]);
    }
    if let Some(cwd) = cwd {
        directories.push(cwd.to_path_buf());
    }

    let mut candidates = Vec::new();
    for directory in directories {
        let candidate = absolute_library_path(directory);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn pdfium() -> Result<&'static Pdfium> {
    if PDFIUM.get().is_none() {
        // Zoekvolgorde voor de PDFium-bibliotheek:
        //   1. systeem-zoekpad (Windows vindt pdfium.dll naast de exe);
        //   2. naast de sidecar-binary zelf;
        //   3. ../Resources t.o.v. de binary — op macOS draait de sidecar in
        //      Contents/MacOS terwijl de gebundelde libpdfium.dylib als resource
        //      in Contents/Resources staat;
        //   4. ../lib/<product> — Tauri AppImage/deb resource layout;
        //   5. de huidige werkdirectory (dev / handmatige runs).
        let exe_path = std::env::current_exe().ok();
        let cwd = std::env::current_dir().ok();
        let mut failures = Vec::new();
        let bindings = match Pdfium::bind_to_system_library() {
            Ok(bindings) => bindings,
            Err(error) => {
                failures.push(format!("system: {error}"));
                let mut loaded = None;
                for candidate in pdfium_library_candidates(exe_path.as_deref(), cwd.as_deref()) {
                    match Pdfium::bind_to_library(&candidate) {
                        Ok(bindings) => {
                            loaded = Some(bindings);
                            break;
                        }
                        Err(error) => failures.push(format!("{}: {error}", candidate.display())),
                    }
                }
                loaded.ok_or_else(|| {
                    anyhow!(
                        "PDFium library not found; attempted system lookup and: {}",
                        failures.join("; ")
                    )
                })?
            }
        };
        let _ = PDFIUM.set(Pdfium::new(bindings));
    }
    Ok(PDFIUM.get().expect("PDFIUM set above"))
}

/// Gecachet geladen document + open pagina-handle. Houdt de bytes levend voor
/// de document-levensduur; VELDVOLGORDE = DROP-VOLGORDE: `page` leent uit
/// `document`, `document` leent uit `_bytes`.
///
/// Safety: `document` leent uit `_bytes` (heap-buffer verplaatst niet, ook
/// niet als de struct move't) en uit PDFIUM ('static, nooit gedropt). `page`
/// leent uit `document`; de entry zit in een Box zodat het document-adres
/// stabiel is, ook als de cache-Vec verplaatst. De bytes leven per
/// constructie langer dan document en pagina binnen deze struct.
struct CachedDoc {
    path: String,
    mtime: Option<std::time::SystemTime>,
    len: u64,
    /// (pagina-index, parse-duur in ms, open handle). De parse-duur bepaalt of
    /// de handle na de render blijft leven (zie release_page_if_cheap).
    page: Option<(u32, u32, PdfPage<'static>)>,
    document: PdfDocument<'static>,
    page_user_units: Option<std::result::Result<Vec<(f64, String)>, String>>,
    _bytes: Vec<u8>,
}

/// Max gecachete documenten per worker. Zware CAD-documenten kunnen honderden
/// MB's parse-state dragen; 2 dekt "actief document + vergelijk-/vorig doc"
/// zonder het werkgeheugen te laten ontsporen.
const DOC_CACHE_CAP: usize = 2;

pub struct Renderer {
    cache: Vec<Box<CachedDoc>>,
}

impl Renderer {
    pub fn new() -> Result<Self> {
        // Bind PDFium meteen zodat een ontbrekende DLL bij worker-start faalt
        // (Ready wordt dan nooit gemeld) i.p.v. pas bij de eerste render.
        pdfium()?;
        Ok(Self { cache: Vec::new() })
    }

    /// Cache-lookup met verversing: hit alleen als pad + mtime + lengte
    /// overeenkomen (het bestand kan herschreven zijn door opslaan van
    /// annotaties). Miss → lees + parse en evict de oudste boven de cap.
    /// De parse van een zwaar CAD-document kost seconden — deze cache is
    /// wat regio-tegels goedkoop maakt.
    fn get_or_load(&mut self, path: &str) -> Result<usize> {
        let meta = std::fs::metadata(path).with_context(|| format!("stat {}", path))?;
        let mtime = meta.modified().ok();
        let len = meta.len();

        if let Some(i) = self
            .cache
            .iter()
            .position(|c| c.path == path && c.mtime == mtime && c.len == len)
        {
            return Ok(i);
        }
        // Verouderde versie van hetzelfde pad weggooien.
        self.cache.retain(|c| c.path != path);

        let bytes = std::fs::read(path).with_context(|| format!("read {}", path))?;
        // Safety: zie CachedDoc — buffer-adres is stabiel en de bytes blijven
        // in dezelfde struct levend zolang het document bestaat.
        let bytes_ref: &'static [u8] =
            unsafe { std::slice::from_raw_parts(bytes.as_ptr(), bytes.len()) };
        let document = pdfium()?
            .load_pdf_from_byte_slice(bytes_ref, None)
            .map_err(|e| anyhow!("PDFium parse: {}", e))?;

        if self.cache.len() >= DOC_CACHE_CAP {
            self.cache.remove(0);
        }
        self.cache.push(Box::new(CachedDoc {
            path: path.to_string(),
            mtime,
            len,
            page: None,
            document,
            page_user_units: None,
            _bytes: bytes,
        }));
        Ok(self.cache.len() - 1)
    }

    /// Sluit alle open pagina-handles (de dure parse-state); documenten en
    /// bytes blijven. De volgende render op die pagina betaalt eenmalig de
    /// her-parse. Aangeroepen bij pool-inactiviteit om het werkgeheugen van
    /// zware CAD-pagina's (ruim 1 GB per open handle) terug te geven.
    pub fn release_document(&mut self, path: &str) {
        self.cache.retain(|entry| entry.path != path);
    }

    pub fn trim(&mut self) {
        for e in self.cache.iter_mut() {
            e.page = None;
        }
    }

    /// Open (of hergebruik) de pagina-handle. FPDF_LoadPage parset de volledige
    /// content-stream — op zware CAD-pagina's SECONDEN per keer, en dat gebeurde
    /// voorheen bij ÉLKE regio-render opnieuw. Met een open handle betaalt
    /// alleen de eerste render die parse; daarna is een tegel puur rasterwerk.
    fn get_or_load_page(&mut self, doc_idx: usize, page_index: u32) -> Result<&PdfPage<'static>> {
        let entry = &mut self.cache[doc_idx];
        let reuse = matches!(&entry.page, Some((idx, _, _)) if *idx == page_index);
        if !reuse {
            entry.page = None; // oude handle expliciet sluiten vóór de nieuwe opent
                               // Safety: het document zit in een Box (stabiel heap-adres, ook als de
                               // cache-Vec verplaatst) en leeft zolang deze entry bestaat; `page`
                               // staat vóór `document` in de struct en dropt dus altijd eerder.
            let doc_ref: &'static PdfDocument<'static> =
                unsafe { &*(&entry.document as *const PdfDocument<'static>) };
            let t0 = std::time::Instant::now();
            let page = doc_ref
                .pages()
                .get(page_index as i32)
                .map_err(|e| anyhow!("page {}: {}", page_index, e))?;
            let load_ms = t0.elapsed().as_millis() as u32;
            entry.page = Some((page_index, load_ms, page));
        }
        Ok(&self.cache[doc_idx].page.as_ref().expect("zojuist gezet").2)
    }

    /// Sluit de pagina-handle weer als de parse GOEDKOOP was. Alleen zware
    /// pagina's (parse in de honderden ms tot seconden — grote CAD-bladen)
    /// verdienen de open handle met zijn forse parse-state (~1 GB op extreme
    /// bladen); normale pagina's parsen in enkele tientallen ms en hun handle
    /// vasthouden zou bij veel tabs/documenten onnodig geheugen stapelen.
    fn release_page_if_cheap(&mut self, doc_idx: usize) {
        const KEEP_HANDLE_MS: u32 = 250;
        if let Some((_, load_ms, _)) = &self.cache[doc_idx].page {
            if *load_ms < KEEP_HANDLE_MS {
                self.cache[doc_idx].page = None;
            }
        }
    }

    pub fn render(
        &mut self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
    ) -> Result<RenderResult> {
        self.render_with_limits(path, page_index, scale, rotation, None)
    }

    pub fn render_ocr(
        &mut self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        limits: RasterLimits,
    ) -> Result<RenderResult> {
        self.render_with_limits(path, page_index, scale, rotation, Some(limits))
    }

    fn render_with_limits(
        &mut self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        limits: Option<RasterLimits>,
    ) -> Result<RenderResult> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err(anyhow!("render scale must be a positive finite number"));
        }
        let idx = self.get_or_load(path)?;
        let (user_unit, user_unit_provenance) = if limits.is_some() {
            if self.cache[idx].page_user_units.is_none() {
                self.cache[idx].page_user_units = Some(
                    read_page_user_units(&self.cache[idx]._bytes)
                        .map_err(|error| error.to_string()),
                );
            }
            self.cache[idx]
                .page_user_units
                .as_ref()
                .expect("UserUnit metadata initialized above")
                .as_ref()
                .map_err(|error| anyhow!("read PDF UserUnit metadata: {error}"))?
                .get(page_index as usize)
                .cloned()
                .ok_or_else(|| anyhow!("page {page_index} has no PDF UserUnit metadata"))?
        } else {
            (1.0, "pdf-default".to_string())
        };
        let geometry_user_unit = user_unit;
        let result = {
            let page = self.get_or_load_page(idx, page_index)?;

            let w_pt = page.width().value;
            let h_pt = page.height().value;
            let target_w_value = (f64::from(w_pt) * geometry_user_unit * f64::from(scale)).ceil();
            let target_h_value = (f64::from(h_pt) * geometry_user_unit * f64::from(scale)).ceil();
            let (target_w, target_h) = bounded_raster_size(target_w_value, target_h_value, limits)?;

            let rot = match rotation.rem_euclid(360) {
                0 => PdfPageRenderRotation::None,
                90 => PdfPageRenderRotation::Degrees90,
                180 => PdfPageRenderRotation::Degrees180,
                270 => PdfPageRenderRotation::Degrees270,
                other => return Err(anyhow!("unsupported rotation {}", other)),
            };

            let config = PdfRenderConfig::new()
                .set_target_width(target_w)
                .set_maximum_height(target_h)
                .rotate(rot, true)
                .render_form_data(true)
                .render_annotations(false)
                .use_lcd_text_rendering(true)
                .set_format(PdfBitmapFormat::BGRA);

            let bitmap = page
                .render_with_config(&config)
                .map_err(|e| anyhow!("PDFium render: {}", e))?;

            let width = bitmap.width() as u32;
            let height = bitmap.height() as u32;
            let page_geometry = if limits.is_some() {
                Some(build_page_geometry(
                    page,
                    page_index,
                    user_unit,
                    &user_unit_provenance,
                    scale,
                    rotation,
                    width,
                    height,
                )?)
            } else {
                None
            };

            RenderResult {
                width,
                height,
                rgba: bitmap.as_rgba_bytes(),
                page_geometry,
            }
        };
        // Goedkope pagina's houden geen open handle vast (geheugen-garantie
        // voor normale PDF's); zware behouden hem voor snelle vervolg-tegels.
        self.release_page_if_cheap(idx);
        Ok(result)
    }

    /// Render a sub-region of a page at `scale` into an output bitmap of
    /// (region_w_pt*scale × region_h_pt*scale) px. `rotation` (extra
    /// gebruikersrotatie) must be 0.
    ///
    /// De regio-coördinaten komen uit de viewer in WEERGAVE-ruimte (na de
    /// intrinsieke /Rotate van de pagina). De matrix-API van PDFium werkt
    /// in RUWE paginaruimte, dus voor /Rotate-pagina's wordt de rotatie in
    /// de matrix meegebakken.
    pub fn render_region(
        &mut self,
        path: &str,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
    ) -> Result<RenderResult> {
        if rotation != 0 {
            return Err(anyhow!(
                "render_region: rotation {} not supported",
                rotation
            ));
        }
        if region_w_pt <= 0.0 || region_h_pt <= 0.0 {
            return Err(anyhow!("render_region: region must be positive"));
        }
        let idx = self.get_or_load(path)?;
        let result = {
            let page = self.get_or_load_page(idx, page_index)?;

            let bitmap_w = (region_w_pt * scale).ceil() as i32;
            let bitmap_h = (region_h_pt * scale).ceil() as i32;
            if bitmap_w <= 0 || bitmap_h <= 0 {
                return Err(anyhow!(
                    "render_region: invalid bitmap {}x{}",
                    bitmap_w,
                    bitmap_h
                ));
            }

            // De matrix van FPDF_RenderPageBitmapWithMatrix werkt in WEERGAVE-ruimte
            // (ná de intrinsieke /Rotate van de pagina), y-omlaag vanaf linksboven —
            // exact de ruimte waarin de viewer regio's aanlevert. Empirisch
            // vastgesteld met hoek-probes op /Rotate=0- én /Rotate=90-pagina's
            // (titelblok/logo-ankers): een plain schaal+translatie-matrix levert
            // voor élke paginarotatie de juiste tegel. Geen rotatie-mapping nodig.
            let config = PdfRenderConfig::new()
                .set_fixed_size(bitmap_w, bitmap_h)
                .transform(
                    scale,
                    0.0,
                    0.0,
                    scale,
                    -region_x_pt * scale,
                    -region_y_pt * scale,
                )
                .map_err(|e2| anyhow!("invalid transform: {}", e2))?
                .render_annotations(false)
                .use_lcd_text_rendering(true)
                .set_format(PdfBitmapFormat::BGRA);

            let bitmap = page
                .render_with_config(&config)
                .map_err(|e| anyhow!("PDFium region render: {}", e))?;

            RenderResult {
                width: bitmap.width() as u32,
                height: bitmap.height() as u32,
                rgba: bitmap.as_rgba_bytes(),
                page_geometry: None,
            }
        };
        // Goedkope pagina's houden geen open handle vast (geheugen-garantie
        // voor normale PDF's); zware behouden hem voor snelle vervolg-tegels.
        self.release_page_if_cheap(idx);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Object};
    use std::path::{Path, PathBuf};

    fn user_unit_document(user_unit: Option<f64>) -> (lopdf::Document, lopdf::ObjectId) {
        let mut document = lopdf::Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let mut pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        };
        if let Some(value) = user_unit {
            pages.set("UserUnit", value as f32);
        }
        document.objects.insert(pages_id, Object::Dictionary(pages));
        document.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => Object::Reference(pages_id),
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            }),
        );
        (document, page_id)
    }

    #[test]
    fn bundled_platform_resource_directories_are_searched_with_absolute_library_paths() {
        let candidates = pdfium_library_candidates(
            Some(Path::new("/bundle/usr/bin/pdfium-worker")),
            Some(Path::new("/tmp")),
        );
        assert!(candidates.contains(&PathBuf::from(
            "/bundle/usr/bin/../Resources/libpdfium.dylib",
        )));
        assert!(candidates.contains(&PathBuf::from(
            "/bundle/usr/bin/../lib/Open PDF Studio/libpdfium.dylib",
        )));
        assert!(candidates.contains(&PathBuf::from(
            "/bundle/usr/bin/../lib/open-pdf-studio/libpdfium.dylib",
        )));
        assert!(candidates.iter().all(|candidate| candidate.is_absolute()));
    }

    #[test]
    fn duplicate_current_directory_candidate_is_removed() {
        let candidates = pdfium_library_candidates(
            Some(Path::new("/opt/open-pdf-studio/pdfium-worker")),
            Some(Path::new("/opt/open-pdf-studio")),
        );

        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| {
                    candidate == &&Path::new("/opt/open-pdf-studio/libpdfium.dylib")
                })
                .count(),
            1,
        );
    }

    #[test]
    fn ocr_raster_limits_reject_before_bitmap_allocation() {
        let limits = RasterLimits {
            max_width: 8192,
            max_height: 8192,
            max_pixels: 16_000_000,
            max_raster_bytes: 64_000_000,
        };
        assert!(bounded_raster_size(2000.0, 3000.0, Some(limits)).is_ok());
        assert!(bounded_raster_size(9000.0, 100.0, Some(limits)).is_err());
        assert!(bounded_raster_size(8000.0, 8000.0, Some(limits)).is_err());
        assert!(bounded_raster_size(f64::INFINITY, 1.0, Some(limits)).is_err());
    }

    #[test]
    fn inherited_user_unit_is_read_from_the_page_tree() {
        let (document, page_id) = user_unit_document(Some(2.5));
        let (value, provenance) = inherited_user_unit(&document, page_id).unwrap();
        assert_eq!(value, 2.5);
        assert_eq!(provenance, "pdf-page-dictionary");
    }

    #[test]
    fn missing_user_unit_uses_the_pdf_default() {
        let (document, page_id) = user_unit_document(None);
        let (value, provenance) = inherited_user_unit(&document, page_id).unwrap();
        assert_eq!(value, 1.0);
        assert_eq!(provenance, "pdf-default");
    }

    #[test]
    fn invalid_user_unit_is_rejected() {
        let (document, page_id) = user_unit_document(Some(0.0));
        assert!(inherited_user_unit(&document, page_id).is_err());
    }

    #[test]
    #[ignore]
    fn renders_a4_at_scale_1() {
        let _r = Renderer::new();
    }
}
