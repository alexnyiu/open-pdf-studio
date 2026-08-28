use serde::{Deserialize, Serialize};

pub const PDFIUM_PAGE_GEOMETRY_CONTRACT: &str = "open-pdf-studio.pdfium.page-geometry";
pub const PDFIUM_PAGE_GEOMETRY_SCHEMA_VERSION: u32 = 1;

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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Render {
        id: u64,
        path: String,
        page_index: u32,
        scale: f32,
        rotation: i32,
    },
    RenderPng {
        id: u64,
        path: String,
        page_index: u32,
        scale: f32,
        rotation: i32,
        transfer_token: String,
    },
    RenderOcr {
        id: u64,
        path: String,
        page_index: u32,
        scale: f32,
        rotation: i32,
        max_width: u32,
        max_height: u32,
        max_pixels: u64,
        max_raster_bytes: u64,
    },
    PageGeometry {
        id: u64,
        path: String,
        page_index: u32,
        scale: f32,
        rotation: i32,
        max_width: u32,
        max_height: u32,
        max_pixels: u64,
        max_raster_bytes: u64,
    },
    RenderRegion {
        id: u64,
        path: String,
        page_index: u32,
        scale: f32,
        rotation: i32,
        region_x_pt: f32,
        region_y_pt: f32,
        region_w_pt: f32,
        region_h_pt: f32,
    },
    /// Sluit open pagina-handles (parse-state, honderden MB's op zware
    /// CAD-pagina's); documenten blijven gecachet. Fire-and-forget: geen
    /// response. Gestuurd door de pool bij inactiviteit.
    Trim,
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Response {
    Ready {
        op: String,
        shm_name: String,
        shm_size: u64,
    },
    RenderOk {
        id: u64,
        ok: bool,
        w: u32,
        h: u32,
        shm_bytes: u64,
    },
    RenderPngOk {
        id: u64,
        ok: bool,
        w: u32,
        h: u32,
        file_bytes: u64,
    },
    RenderOcrOk {
        id: u64,
        ok: bool,
        w: u32,
        h: u32,
        shm_bytes: u64,
        #[serde(rename = "pageGeometry")]
        page_geometry: PdfiumPageGeometry,
    },
    PageGeometryOk {
        id: u64,
        ok: bool,
        #[serde(rename = "pageGeometry")]
        page_geometry: PdfiumPageGeometry,
    },
    RenderErr {
        id: u64,
        ok: bool,
        error: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_render_round_trips() {
        let req = Request::Render {
            id: 42,
            path: "C:/foo.pdf".to_string(),
            page_index: 5,
            scale: 0.25,
            rotation: 0,
        };
        let line = serde_json::to_string(&req).unwrap();
        let parsed: Request = serde_json::from_str(&line).unwrap();
        assert_eq!(req, parsed);
    }

    #[test]
    fn bounded_ocr_render_round_trips() {
        let req = Request::RenderOcr {
            id: 7,
            path: "/private/input.pdf".to_string(),
            page_index: 0,
            scale: 2.0,
            rotation: 0,
            max_width: 8192,
            max_height: 8192,
            max_pixels: 16_000_000,
            max_raster_bytes: 64_000_000,
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(line.contains("\"op\":\"render_ocr\""));
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), req);
    }

    #[test]
    fn lossless_display_render_round_trips() {
        let req = Request::RenderPng {
            id: 11,
            path: "/private/large.pdf".to_string(),
            page_index: 53,
            scale: 1.25,
            rotation: 90,
            transfer_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_string(),
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(line.contains("\"op\":\"render_png\""));
        assert!(line.contains("\"transfer_token\""));
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), req);
    }

    #[test]
    fn page_geometry_request_round_trips() {
        let req = Request::PageGeometry {
            id: 8,
            path: "/private/input.pdf".to_string(),
            page_index: 2,
            scale: 1.5,
            rotation: 270,
            max_width: 8192,
            max_height: 8192,
            max_pixels: 16_000_000,
            max_raster_bytes: 64_000_000,
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(line.contains("\"op\":\"page_geometry\""));
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), req);
    }

    #[test]
    fn response_render_ok_serializes_with_ok_true() {
        let resp = Response::RenderOk {
            id: 42,
            ok: true,
            w: 1289,
            h: 596,
            shm_bytes: 3072512,
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"ok\":true"));
        assert!(s.contains("\"shm_bytes\":3072512"));
    }
}
