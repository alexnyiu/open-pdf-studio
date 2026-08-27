mod color;
pub mod content_stream;
pub mod draw_commands;
pub mod encoding;
pub mod font_parser;
pub mod fonts;
mod graphics_state;
mod interpreter;
pub mod native_text;
mod parser;
mod renderer;
pub mod text_renderer;
pub mod tile_render;

pub use draw_commands::DrawCommandBuffer;
pub use native_text::{
    inspect_native_text_sources_batch, NativeTextApplyReportV1, NativeTextApplyResultV1,
    NativeTextSourceMapV1, NativeTextSourceProvenanceV1,
};
pub use parser::DocumentHandle;

#[derive(Debug, PartialEq)]
pub enum PageType {
    Vector,
    Tile,
}

#[derive(Debug)]
pub enum RenderError {
    ParseError(String),
    UnsupportedFeature(String),
    RenderError(String),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::ParseError(s) => write!(f, "Parse error: {}", s),
            RenderError::UnsupportedFeature(s) => write!(f, "Unsupported: {}", s),
            RenderError::RenderError(s) => write!(f, "Render error: {}", s),
        }
    }
}

impl std::error::Error for RenderError {}

pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct PdfRenderer;

impl PdfRenderer {
    pub fn new() -> Self {
        PdfRenderer
    }

    pub fn load_document(&self, bytes: &[u8]) -> Result<DocumentHandle, RenderError> {
        DocumentHandle::load(bytes)
    }
}
