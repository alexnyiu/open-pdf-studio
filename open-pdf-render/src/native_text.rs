//! Provenance-backed native PDF text inspection and source neutralization.
//!
//! This module deliberately works at content-stream operation granularity.
//! It never searches decoded streams for user text: every mutation is bound
//! to a document hash, stream hash, operator byte range, and exact bytes.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;

use base64::Engine;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::content_stream::ContentStreamIter;
use crate::fonts::{FontEntry, FontRegistry};
use crate::RenderError;

const MAX_FORM_DEPTH: usize = 32;
const MAX_OPERATORS_PER_PAGE: usize = 500_000;
const MAX_DECODED_CONTENT_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_SOURCE_OPERATOR_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextInvocationV1 {
    pub kind: String,
    pub owner_object_id: String,
    pub content_stream_object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub do_operator_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub do_operator_range: Option<[usize; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub do_operator_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextEligibilityV1 {
    pub eligible: bool,
    pub code: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextSourceProvenanceV1 {
    pub schema: String,
    pub version: u8,
    pub document_sha256: String,
    pub page_index: usize,
    pub page_object_id: String,
    pub stream_object_id: String,
    pub stream_sha256: String,
    pub invocation_path: Vec<NativeTextInvocationV1>,
    pub operator_kind: String,
    pub operator_index: usize,
    pub operator_range: [usize; 2],
    pub operator_sha256: String,
    pub original_operator_base64: String,
    pub decoded_text: String,
    pub total_advance: f32,
    pub font_name: String,
    pub font_size: f32,
    pub horizontal_scaling: f32,
    pub character_spacing: f32,
    pub word_spacing: f32,
    pub text_matrix: [f32; 6],
    pub ctm: [f32; 6],
    pub geometry: [f32; 4],
    pub marker_id: String,
    pub shared: bool,
    pub ownership_state: String,
    pub eligibility: NativeTextEligibilityV1,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextSourceMapV1 {
    pub schema: String,
    pub version: u8,
    pub document_sha256: String,
    pub page_index: usize,
    pub page_object_id: String,
    pub runs: Vec<NativeTextSourceProvenanceV1>,
    pub rejected_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextApplyReportV1 {
    pub neutralized: usize,
    pub already_neutralized: usize,
    pub restored: usize,
    pub cloned_streams: usize,
    pub cloned_forms: usize,
    pub marker_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextApplyResultV1 {
    pub pdf_bytes: Vec<u8>,
    pub report: NativeTextApplyReportV1,
}

#[derive(Clone, Copy, Debug)]
struct Matrix([f32; 6]);

impl Matrix {
    fn identity() -> Self {
        Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0])
    }
    fn concat(self, rhs: Self) -> Self {
        let a = self.0;
        let b = rhs.0;
        Self([
            a[0] * b[0] + a[2] * b[1],
            a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3],
            a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4],
            a[1] * b[4] + a[3] * b[5] + a[5],
        ])
    }
    fn point(self, x: f32, y: f32) -> (f32, f32) {
        (
            x * self.0[0] + y * self.0[2] + self.0[4],
            x * self.0[1] + y * self.0[3] + self.0[5],
        )
    }
}

#[derive(Clone, Debug)]
struct TextState {
    font_name: String,
    font_size: f32,
    hscale: f32,
    char_spacing: f32,
    word_spacing: f32,
    leading: f32,
    rise: f32,
    tm: Matrix,
    tlm: Matrix,
}

impl Default for TextState {
    fn default() -> Self {
        Self {
            font_name: String::new(),
            font_size: 12.0,
            hscale: 1.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            leading: 0.0,
            rise: 0.0,
            tm: Matrix::identity(),
            tlm: Matrix::identity(),
        }
    }
}

impl TextState {
    fn begin_text(&mut self) {
        self.tm = Matrix::identity();
        self.tlm = self.tm;
    }
    fn set_tm(&mut self, values: [f32; 6]) {
        self.tm = Matrix(values);
        self.tlm = self.tm;
    }
    fn translate_line(&mut self, tx: f32, ty: f32) {
        let t = Matrix([1.0, 0.0, 0.0, 1.0, tx, ty]);
        self.tlm = self.tlm.concat(t);
        self.tm = self.tlm;
    }
    fn advance(&mut self, tx: f32) {
        self.tm = self.tm.concat(Matrix([1.0, 0.0, 0.0, 1.0, tx, 0.0]));
    }
}

#[derive(Clone)]
struct WalkState {
    ctm: Matrix,
    stack: Vec<(Matrix, TextState)>,
    text: TextState,
}

impl Default for WalkState {
    fn default() -> Self {
        Self {
            ctm: Matrix::identity(),
            stack: Vec::new(),
            text: TextState::default(),
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn save_rewritten_document(doc: &mut Document, context: &str) -> Result<Vec<u8>, RenderError> {
    // A full lopdf rewrite invalidates incremental-update offsets. Retaining
    // /Prev or /XRefStm makes strict reopeners follow stale byte positions.
    doc.trailer.remove(b"Prev");
    doc.trailer.remove(b"XRefStm");
    let mut output = Vec::new();
    doc.save_to(&mut output)
        .map_err(|e| RenderError::RenderError(format!("{context}: {e}")))?;
    Ok(output)
}

fn object_id(id: ObjectId) -> String {
    format!("{} {} R", id.0, id.1)
}

fn parse_object_id(value: &str) -> Result<ObjectId, RenderError> {
    let mut parts = value.split_whitespace();
    let number = parts
        .next()
        .and_then(|v| v.parse::<u32>().ok())
        .ok_or_else(|| RenderError::ParseError(format!("Invalid object id {value}")))?;
    let generation = parts
        .next()
        .and_then(|v| v.parse::<u16>().ok())
        .ok_or_else(|| RenderError::ParseError(format!("Invalid object id {value}")))?;
    Ok((number, generation))
}

fn num(value: &Object) -> f32 {
    match value {
        Object::Integer(v) => *v as f32,
        Object::Real(v) => *v,
        _ => 0.0,
    }
}

fn dict_from_object(doc: &Document, value: &Object) -> Option<Dictionary> {
    match value {
        Object::Dictionary(dict) => Some(dict.clone()),
        Object::Reference(id) => doc.get_object(*id).ok()?.as_dict().ok().cloned(),
        _ => None,
    }
}

fn inherited_resources(doc: &Document, mut page_id: ObjectId) -> Dictionary {
    let mut seen = HashSet::new();
    while seen.insert(page_id) {
        let Ok(dict) = doc.get_object(page_id).and_then(Object::as_dict) else {
            break;
        };
        if let Ok(value) = dict.get(b"Resources") {
            if let Some(resources) = dict_from_object(doc, value) {
                return resources;
            }
        }
        let Ok(Object::Reference(parent)) = dict.get(b"Parent") else {
            break;
        };
        page_id = *parent;
    }
    Dictionary::new()
}

fn page_stream_ids(doc: &Document, page_id: ObjectId) -> Result<Vec<ObjectId>, RenderError> {
    let page = doc
        .get_object(page_id)
        .and_then(Object::as_dict)
        .map_err(|e| RenderError::ParseError(format!("Page dictionary: {e}")))?;
    let Ok(contents) = page.get(b"Contents") else {
        return Ok(Vec::new());
    };
    match contents {
        Object::Reference(id) => Ok(vec![*id]),
        Object::Array(items) => items
            .iter()
            .map(|item| match item {
                Object::Reference(id) => Ok(*id),
                _ => Err(RenderError::UnsupportedFeature(
                    "Direct page content streams are not editable".into(),
                )),
            })
            .collect(),
        _ => Err(RenderError::UnsupportedFeature(
            "Malformed page Contents".into(),
        )),
    }
}

fn stream_bytes(doc: &Document, id: ObjectId) -> Result<Vec<u8>, RenderError> {
    let stream = doc
        .get_object(id)
        .and_then(Object::as_stream)
        .map_err(|e| RenderError::ParseError(format!("Content stream {}: {e}", object_id(id))))?;
    let bytes = stream
        .get_plain_content()
        .map_err(|e| RenderError::ParseError(format!("Decode stream {}: {e}", object_id(id))))?;
    if bytes.len() > MAX_DECODED_CONTENT_STREAM_BYTES {
        return Err(RenderError::UnsupportedFeature(format!(
            "Decoded content stream {} exceeds the native text inspection limit",
            object_id(id)
        )));
    }
    Ok(bytes)
}

fn ref_count(doc: &Document, target: ObjectId) -> usize {
    fn count(obj: &Object, target: ObjectId) -> usize {
        match obj {
            Object::Reference(id) => usize::from(*id == target),
            Object::Array(items) => items.iter().map(|item| count(item, target)).sum(),
            Object::Dictionary(dict) => dict.iter().map(|(_, value)| count(value, target)).sum(),
            Object::Stream(stream) => stream
                .dict
                .iter()
                .map(|(_, value)| count(value, target))
                .sum(),
            _ => 0,
        }
    }
    doc.objects.values().map(|obj| count(obj, target)).sum()
}

fn marker_occurrences(doc: &Document, marker_id: &str) -> usize {
    let needle = format!("/OPDSNativeEdit <</ID ({marker_id})>> BDC").into_bytes();
    doc.objects
        .values()
        .filter_map(|object| object.as_stream().ok())
        .filter_map(|stream| stream.get_plain_content().ok())
        .map(|plain| {
            plain
                .windows(needle.len())
                .filter(|window| *window == needle)
                .count()
        })
        .sum()
}

fn standard14_width(font_name: &str, code: u8) -> Option<f32> {
    let clean = font_name.rsplit('+').next().unwrap_or(font_name);
    if clean.starts_with("Courier") {
        return Some(600.0);
    }
    if !clean.starts_with("Helvetica") {
        return None;
    }
    let bold = clean.contains("Bold");
    let width = if bold {
        match code {
            b' ' => 278,
            b'!' => 333,
            b'"' => 474,
            b'#' | b'$' => 556,
            b'%' => 889,
            b'&' => 722,
            b'\'' => 238,
            b'(' | b')' => 333,
            b'*' => 389,
            b'+' | b'<' | b'=' | b'>' => 584,
            b',' | b'.' => 278,
            b'-' => 333,
            b'/' => 278,
            b'0'..=b'9' => 556,
            b':' | b';' => 333,
            b'?' => 611,
            b'@' => 975,
            b'A' | b'B' => 722,
            b'C' | b'D' => 722,
            b'E' => 667,
            b'F' => 611,
            b'G' => 778,
            b'H' => 722,
            b'I' => 278,
            b'J' => 556,
            b'K' => 722,
            b'L' => 611,
            b'M' => 833,
            b'N' => 722,
            b'O' => 778,
            b'P' => 667,
            b'Q' => 778,
            b'R' => 722,
            b'S' => 667,
            b'T' => 611,
            b'U' => 722,
            b'V' => 667,
            b'W' => 944,
            b'X' | b'Y' => 667,
            b'Z' => 611,
            b'[' | b']' => 333,
            b'\\' => 278,
            b'^' => 584,
            b'_' => 556,
            b'`' => 333,
            b'a' => 556,
            b'b' => 611,
            b'c' => 556,
            b'd' => 611,
            b'e' => 556,
            b'f' => 333,
            b'g' | b'h' => 611,
            b'i' | b'j' => 278,
            b'k' => 556,
            b'l' => 278,
            b'm' => 889,
            b'n' | b'o' | b'p' | b'q' => 611,
            b'r' => 389,
            b's' => 556,
            b't' => 333,
            b'u' => 611,
            b'v' => 556,
            b'w' => 778,
            b'x' | b'y' => 556,
            b'z' => 500,
            b'{' | b'}' => 389,
            b'|' => 280,
            b'~' => 584,
            _ => return None,
        }
    } else {
        match code {
            b' ' | b'!' => 278,
            b'"' => 355,
            b'#' | b'$' => 556,
            b'%' => 889,
            b'&' => 667,
            b'\'' => 191,
            b'(' | b')' => 333,
            b'*' => 389,
            b'+' | b'<' | b'=' | b'>' => 584,
            b',' | b'.' => 278,
            b'-' => 333,
            b'/' => 278,
            b'0'..=b'9' => 556,
            b':' | b';' => 278,
            b'?' => 556,
            b'@' => 1015,
            b'A' | b'B' => 667,
            b'C' | b'D' => 722,
            b'E' => 667,
            b'F' => 611,
            b'G' => 778,
            b'H' => 722,
            b'I' => 278,
            b'J' => 500,
            b'K' => 667,
            b'L' => 556,
            b'M' => 833,
            b'N' => 722,
            b'O' => 778,
            b'P' => 667,
            b'Q' => 778,
            b'R' => 722,
            b'S' => 667,
            b'T' => 611,
            b'U' => 722,
            b'V' => 667,
            b'W' => 944,
            b'X' | b'Y' => 667,
            b'Z' => 611,
            b'[' | b']' | b'\\' => 278,
            b'^' => 469,
            b'_' => 556,
            b'`' => 333,
            b'a' | b'b' | b'd' | b'e' | b'g' | b'h' | b'n' | b'o' | b'p' | b'q' | b'u' => 556,
            b'c' | b'k' | b's' | b'v' | b'x' | b'y' | b'z' => 500,
            b'f' | b't' => 278,
            b'i' | b'j' | b'l' => 222,
            b'm' => 833,
            b'r' => 333,
            b'w' => 722,
            b'{' | b'}' => 334,
            b'|' => 260,
            b'~' => 584,
            _ => return None,
        }
    };
    Some(width as f32)
}

fn decode_and_advance(bytes: &[u8], font: &FontEntry, state: &TextState) -> (String, f32) {
    let mut text = String::new();
    let mut advance = 0.0;
    if font.is_cid {
        for pair in bytes.chunks_exact(2) {
            let code = u16::from_be_bytes([pair[0], pair[1]]);
            let ch = font
                .cid_to_unicode
                .get(&code)
                .copied()
                .or_else(|| font.to_unicode.get(&(code as u8)).copied())
                .or_else(|| char::from_u32(code as u32));
            text.push(ch.unwrap_or('\u{fffd}'));
            let width = font
                .widths
                .get(&(code as u32))
                .copied()
                .unwrap_or(font.default_width)
                / 1000.0;
            let word = if matches!(ch, Some(' ')) {
                state.word_spacing
            } else {
                0.0
            };
            advance += (width * state.font_size + state.char_spacing + word) * state.hscale;
        }
        if bytes.len() % 2 != 0 {
            text.push('\u{fffd}');
        }
    } else {
        for &code in bytes {
            let ch = font.to_unicode.get(&code).copied().unwrap_or_else(|| {
                if font.encoding_name.is_some() || !font.differences.is_empty() {
                    crate::encoding::resolve_char_code(
                        font.encoding_name.as_deref(),
                        &font.differences,
                        code,
                    )
                } else {
                    code as char
                }
            });
            text.push(ch);
            let fallback_width = || {
                font.parsed
                    .as_ref()
                    .and_then(|parsed| {
                        FontRegistry::char_to_glyph_id(font, code)
                            .and_then(|glyph_id| parsed.glyphs.get(&glyph_id))
                            .map(|glyph| {
                                glyph.advance_width * 1000.0 / parsed.units_per_em.max(1) as f32
                            })
                    })
                    .unwrap_or(0.0)
            };
            let width = font.widths.get(&(code as u32)).copied().unwrap_or_else(|| {
                if font.default_width > 0.0 {
                    font.default_width
                } else {
                    let parsed = fallback_width();
                    if parsed > 0.0 {
                        parsed
                    } else {
                        standard14_width(&font.base_font, code).unwrap_or(0.0)
                    }
                }
            }) / 1000.0;
            let word = if ch == ' ' { state.word_spacing } else { 0.0 };
            advance += (width * state.font_size + state.char_spacing + word) * state.hscale;
        }
    }
    (text, advance)
}

fn show_operand(
    op: &lopdf::content::Operation,
    font: &FontEntry,
    state: &TextState,
) -> Option<(String, f32)> {
    let string = |value: &Object| match value {
        Object::String(bytes, _) => Some(decode_and_advance(bytes, font, state)),
        _ => None,
    };
    match op.operator.as_str() {
        "Tj" | "'" => string(op.operands.first()?),
        "\"" => string(op.operands.get(2)?),
        "TJ" => {
            let Object::Array(items) = op.operands.first()? else {
                return None;
            };
            let mut text = String::new();
            let mut advance = 0.0;
            for item in items {
                match item {
                    Object::String(bytes, _) => {
                        let (part, width) = decode_and_advance(bytes, font, state);
                        text.push_str(&part);
                        advance += width;
                    }
                    Object::Integer(_) | Object::Real(_) => {
                        advance += -(num(item) / 1000.0) * state.font_size * state.hscale;
                    }
                    _ => return None,
                }
            }
            Some((text, advance))
        }
        _ => None,
    }
}

struct InspectContext<'a> {
    doc: &'a Document,
    document_hash: &'a str,
    page_index: usize,
    page_id: ObjectId,
    fonts: &'a mut FontRegistry,
    runs: Vec<NativeTextSourceProvenanceV1>,
    active_forms: HashSet<ObjectId>,
    operator_count: usize,
}

impl<'a> InspectContext<'a> {
    fn walk_stream(
        &mut self,
        stream_id: ObjectId,
        resources: &Dictionary,
        state: &mut WalkState,
        path: &[NativeTextInvocationV1],
        depth: usize,
    ) -> Result<(), RenderError> {
        if depth > MAX_FORM_DEPTH {
            return Err(RenderError::UnsupportedFeature(
                "Form nesting limit exceeded".into(),
            ));
        }
        let bytes = stream_bytes(self.doc, stream_id)?;
        let stream_hash = sha256(&bytes);
        let mut iter = ContentStreamIter::new(&bytes);
        let mut operation = lopdf::content::Operation {
            operator: String::new(),
            operands: Vec::new(),
        };
        let mut operator_index = 0usize;
        while iter.next_into(&mut operation) {
            self.operator_count += 1;
            if self.operator_count > MAX_OPERATORS_PER_PAGE {
                return Err(RenderError::UnsupportedFeature(
                    "Native text inspection operator limit exceeded".into(),
                ));
            }
            let range = iter.operation_span().unwrap_or((0, 0));
            match operation.operator.as_str() {
                "q" => state.stack.push((state.ctm, state.text.clone())),
                "Q" => {
                    if let Some((saved_ctm, saved_text)) = state.stack.pop() {
                        state.ctm = saved_ctm;
                        state.text = saved_text;
                    }
                }
                "cm" if operation.operands.len() >= 6 => {
                    state.ctm = state.ctm.concat(Matrix([
                        num(&operation.operands[0]),
                        num(&operation.operands[1]),
                        num(&operation.operands[2]),
                        num(&operation.operands[3]),
                        num(&operation.operands[4]),
                        num(&operation.operands[5]),
                    ]));
                }
                "BT" => state.text.begin_text(),
                "Tf" if operation.operands.len() >= 2 => {
                    if let Object::Name(name) = &operation.operands[0] {
                        state.text.font_name = String::from_utf8_lossy(name).into_owned();
                    }
                    state.text.font_size = num(&operation.operands[1]);
                }
                "Tc" => {
                    if let Some(value) = operation.operands.first() {
                        state.text.char_spacing = num(value);
                    }
                }
                "Tw" => {
                    if let Some(value) = operation.operands.first() {
                        state.text.word_spacing = num(value);
                    }
                }
                "Tz" => {
                    if let Some(value) = operation.operands.first() {
                        state.text.hscale = num(value) / 100.0;
                    }
                }
                "TL" => {
                    if let Some(value) = operation.operands.first() {
                        state.text.leading = num(value);
                    }
                }
                "Ts" => {
                    if let Some(value) = operation.operands.first() {
                        state.text.rise = num(value);
                    }
                }
                "Td" if operation.operands.len() >= 2 => state
                    .text
                    .translate_line(num(&operation.operands[0]), num(&operation.operands[1])),
                "TD" if operation.operands.len() >= 2 => {
                    state.text.leading = -num(&operation.operands[1]);
                    state
                        .text
                        .translate_line(num(&operation.operands[0]), num(&operation.operands[1]));
                }
                "Tm" if operation.operands.len() >= 6 => state.text.set_tm([
                    num(&operation.operands[0]),
                    num(&operation.operands[1]),
                    num(&operation.operands[2]),
                    num(&operation.operands[3]),
                    num(&operation.operands[4]),
                    num(&operation.operands[5]),
                ]),
                "T*" => state.text.translate_line(0.0, -state.text.leading),
                "Tj" | "TJ" | "'" | "\"" => {
                    if operation.operator == "'" {
                        state.text.translate_line(0.0, -state.text.leading);
                    }
                    if operation.operator == "\"" && operation.operands.len() >= 3 {
                        state.text.word_spacing = num(&operation.operands[0]);
                        state.text.char_spacing = num(&operation.operands[1]);
                        state.text.translate_line(0.0, -state.text.leading);
                    }
                    let start_tm = state.text.tm;
                    let start = state.ctm.point(
                        start_tm.0[4] + state.text.rise * start_tm.0[2],
                        start_tm.0[5] + state.text.rise * start_tm.0[3],
                    );
                    let font = self
                        .fonts
                        .get_font(&state.text.font_name, self.doc, resources);
                    let (decoded, advance, eligibility) = match font
                        .as_deref()
                        .and_then(|entry| show_operand(&operation, entry, &state.text))
                    {
                        Some((decoded, advance))
                            if !decoded.is_empty()
                                && !decoded.contains('\u{fffd}')
                                && advance.is_finite()
                                && advance.abs() > f32::EPSILON =>
                        {
                            (
                                decoded,
                                advance,
                                NativeTextEligibilityV1 {
                                    eligible: true,
                                    code: "eligible".into(),
                                    reason: "Exact show-text operator decoded".into(),
                                },
                            )
                        }
                        Some((decoded, advance)) if !decoded.contains('\u{fffd}') => (
                            decoded,
                            advance,
                            NativeTextEligibilityV1 {
                                eligible: false,
                                code: "unknown-advance".into(),
                                reason:
                                    "Font widths are unavailable for state-equivalent advancement"
                                        .into(),
                            },
                        ),
                        Some((decoded, advance)) => (
                            decoded,
                            advance,
                            NativeTextEligibilityV1 {
                                eligible: false,
                                code: "undecodable-font".into(),
                                reason: "Font mapping produced undecodable characters".into(),
                            },
                        ),
                        None => (
                            String::new(),
                            0.0,
                            NativeTextEligibilityV1 {
                                eligible: false,
                                code: "undecodable-font".into(),
                                reason: "Font or show-text operands could not be decoded".into(),
                            },
                        ),
                    };
                    state.text.advance(advance);
                    // A numeric-only TJ array is the state-equivalent
                    // advancement emitted by neutralization. It produces no
                    // text and must not become a new editable source run.
                    if decoded.is_empty() {
                        operator_index += 1;
                        continue;
                    }
                    let end = state.ctm.point(state.text.tm.0[4], state.text.tm.0[5]);
                    let original = bytes.get(range.0..range.1).unwrap_or_default();
                    if original.len() > MAX_SOURCE_OPERATOR_BYTES {
                        return Err(RenderError::UnsupportedFeature(
                            "Show-text operator exceeds the native editing limit".into(),
                        ));
                    }
                    let operator_hash = sha256(original);
                    let marker_seed = format!(
                        "{}|{}|{}|{}",
                        self.document_hash,
                        object_id(stream_id),
                        operator_index,
                        operator_hash
                    );
                    let marker_id = format!("OPDS-{}", &sha256(marker_seed.as_bytes())[..24]);
                    let width = ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt();
                    self.runs.push(NativeTextSourceProvenanceV1 {
                        schema: "open-pdf-studio.native-text-source".into(),
                        version: 1,
                        document_sha256: self.document_hash.into(),
                        page_index: self.page_index,
                        page_object_id: object_id(self.page_id),
                        stream_object_id: object_id(stream_id),
                        stream_sha256: stream_hash.clone(),
                        invocation_path: path.to_vec(),
                        operator_kind: operation.operator.clone(),
                        operator_index,
                        operator_range: [range.0, range.1],
                        operator_sha256: operator_hash,
                        original_operator_base64: base64::engine::general_purpose::STANDARD
                            .encode(original),
                        decoded_text: decoded,
                        total_advance: advance,
                        font_name: state.text.font_name.clone(),
                        font_size: state.text.font_size,
                        horizontal_scaling: state.text.hscale,
                        character_spacing: state.text.char_spacing,
                        word_spacing: state.text.word_spacing,
                        text_matrix: start_tm.0,
                        ctm: state.ctm.0,
                        geometry: [start.0, start.1, width, state.text.font_size.abs()],
                        marker_id,
                        shared: ref_count(self.doc, stream_id) > 1 || path.len() > 1,
                        ownership_state: "source".into(),
                        eligibility,
                    });
                }
                "Do" => {
                    let Some(Object::Name(name)) = operation.operands.first() else {
                        operator_index += 1;
                        continue;
                    };
                    let Some((form_id, form_stream, form_resources)) =
                        resolve_form(self.doc, resources, name)
                    else {
                        operator_index += 1;
                        continue;
                    };
                    if !self.active_forms.insert(form_id) {
                        return Err(RenderError::UnsupportedFeature(
                            "Cyclic Form XObject graph".into(),
                        ));
                    }
                    let do_bytes = bytes.get(range.0..range.1).unwrap_or_default();
                    let mut child_path = path.to_vec();
                    child_path.push(NativeTextInvocationV1 {
                        kind: "form".into(),
                        owner_object_id: object_id(form_id),
                        content_stream_object_id: object_id(stream_id),
                        resource_name: Some(String::from_utf8_lossy(name).into_owned()),
                        do_operator_index: Some(operator_index),
                        do_operator_range: Some([range.0, range.1]),
                        do_operator_hash: Some(sha256(do_bytes)),
                    });
                    let mut child_state = state.clone();
                    child_state.stack.clear();
                    child_state.text = TextState::default();
                    if let Ok(matrix) = form_stream.dict.get(b"Matrix").and_then(Object::as_array) {
                        if matrix.len() >= 6 {
                            child_state.ctm = child_state.ctm.concat(Matrix([
                                num(&matrix[0]),
                                num(&matrix[1]),
                                num(&matrix[2]),
                                num(&matrix[3]),
                                num(&matrix[4]),
                                num(&matrix[5]),
                            ]));
                        }
                    }
                    self.walk_stream(
                        form_id,
                        &form_resources.unwrap_or_else(|| resources.clone()),
                        &mut child_state,
                        &child_path,
                        depth + 1,
                    )?;
                    self.active_forms.remove(&form_id);
                }
                _ => {}
            }
            operator_index += 1;
        }
        Ok(())
    }
}

fn resolve_form(
    doc: &Document,
    resources: &Dictionary,
    name: &[u8],
) -> Option<(ObjectId, Stream, Option<Dictionary>)> {
    let xobjects = dict_from_object(doc, resources.get(b"XObject").ok()?)?;
    let Object::Reference(id) = xobjects.get(name).ok()? else {
        return None;
    };
    let stream = doc.get_object(*id).ok()?.as_stream().ok()?.clone();
    if stream.dict.get(b"Subtype").ok()?.as_name().ok()? != b"Form" {
        return None;
    }
    let form_resources = stream
        .dict
        .get(b"Resources")
        .ok()
        .and_then(|value| dict_from_object(doc, value));
    Some((*id, stream, form_resources))
}

pub fn inspect_native_text_sources(
    bytes: &[u8],
    page_index: usize,
) -> Result<NativeTextSourceMapV1, RenderError> {
    let doc = Document::load_from(Cursor::new(bytes))
        .map_err(|e| RenderError::ParseError(e.to_string()))?;
    if doc.is_encrypted() {
        return Err(RenderError::UnsupportedFeature(
            "Encrypted PDFs are not eligible for native text editing".into(),
        ));
    }
    let pages = doc.get_pages();
    let page_id = pages
        .iter()
        .nth(page_index)
        .map(|(_, id)| *id)
        .ok_or_else(|| RenderError::ParseError(format!("Page {page_index} not found")))?;
    let resources = inherited_resources(&doc, page_id);
    let document_hash = sha256(bytes);
    let mut fonts = FontRegistry::new();
    let mut context = InspectContext {
        doc: &doc,
        document_hash: &document_hash,
        page_index,
        page_id,
        fonts: &mut fonts,
        runs: Vec::new(),
        active_forms: HashSet::new(),
        operator_count: 0,
    };
    let mut state = WalkState::default();
    for stream_id in page_stream_ids(&doc, page_id)? {
        let path = vec![NativeTextInvocationV1 {
            kind: "page".into(),
            owner_object_id: object_id(page_id),
            content_stream_object_id: object_id(stream_id),
            resource_name: None,
            do_operator_index: None,
            do_operator_range: None,
            do_operator_hash: None,
        }];
        context.walk_stream(stream_id, &resources, &mut state, &path, 0)?;
    }
    let rejected_count = context
        .runs
        .iter()
        .filter(|run| !run.eligibility.eligible)
        .count();
    Ok(NativeTextSourceMapV1 {
        schema: "open-pdf-studio.native-text-source-map".into(),
        version: 1,
        document_sha256: document_hash.clone(),
        page_index,
        page_object_id: object_id(page_id),
        runs: context.runs,
        rejected_count,
    })
}

fn neutral_operation(source: &NativeTextSourceProvenanceV1) -> Result<Vec<u8>, RenderError> {
    if !source.eligibility.eligible {
        return Err(RenderError::UnsupportedFeature(
            source.eligibility.reason.clone(),
        ));
    }
    if source.font_size == 0.0 || source.horizontal_scaling == 0.0 {
        return Err(RenderError::UnsupportedFeature(
            "Zero text scale cannot be neutralized".into(),
        ));
    }
    let adjustment =
        -source.total_advance * 1000.0 / (source.font_size * source.horizontal_scaling);
    let advance = format!("[{adjustment:.8}] TJ");
    let body = match source.operator_kind.as_str() {
        "Tj" | "TJ" => advance,
        "'" => format!("T*\n{advance}"),
        "\"" => format!(
            "{} Tw\n{} Tc\nT*\n{advance}",
            source.word_spacing, source.character_spacing
        ),
        other => {
            return Err(RenderError::UnsupportedFeature(format!(
                "Unsupported source operator {other}"
            )))
        }
    };
    Ok(format!(
        "/OPDSNativeEdit <</ID ({})>> BDC\n{}\nEMC",
        source.marker_id, body
    )
    .into_bytes())
}

fn replace_page_stream_reference(
    doc: &mut Document,
    page_id: ObjectId,
    old: ObjectId,
    new: ObjectId,
) -> Result<(), RenderError> {
    let page = doc
        .get_object_mut(page_id)
        .and_then(Object::as_dict_mut)
        .map_err(|e| RenderError::ParseError(format!("Page dictionary missing: {e}")))?;
    let contents = page
        .get_mut(b"Contents")
        .map_err(|e| RenderError::ParseError(format!("Page Contents missing: {e}")))?;
    match contents {
        Object::Reference(id) if *id == old => *id = new,
        Object::Array(items) => {
            let Some(Object::Reference(id)) = items
                .iter_mut()
                .find(|item| matches!(item, Object::Reference(id) if *id == old))
            else {
                return Err(RenderError::UnsupportedFeature(
                    "Selected content stream is no longer owned by the page".into(),
                ));
            };
            *id = new;
        }
        _ => {
            return Err(RenderError::UnsupportedFeature(
                "Selected content stream is no longer owned by the page".into(),
            ))
        }
    }
    Ok(())
}

fn resources_with_child(
    doc: &Document,
    resources: &Dictionary,
    name: &str,
    child: ObjectId,
) -> Result<Dictionary, RenderError> {
    let mut cloned = resources.clone();
    let mut xobjects = cloned
        .get(b"XObject")
        .ok()
        .and_then(|value| dict_from_object(doc, value))
        .unwrap_or_default();
    if xobjects.get(name.as_bytes()).is_ok() {
        return Err(RenderError::UnsupportedFeature(format!(
            "Clone resource name {name} already exists"
        )));
    }
    xobjects.set(name.as_bytes().to_vec(), Object::Reference(child));
    cloned.set("XObject", Object::Dictionary(xobjects));
    Ok(cloned)
}

fn unique_form_name(source: &NativeTextSourceProvenanceV1, depth: usize) -> String {
    let seed = sha256(format!("{}|{}|{depth}", source.marker_id, source.operator_index).as_bytes());
    format!("OPDSF{}", &seed[..12])
}

fn clone_stream_with_replacements(
    doc: &mut Document,
    stream_id: ObjectId,
    mut replacements: Vec<(usize, usize, Vec<u8>, Option<String>)>,
    resources: Option<Dictionary>,
) -> Result<ObjectId, RenderError> {
    let original = doc
        .get_object(stream_id)
        .and_then(Object::as_stream)
        .map_err(|e| RenderError::ParseError(format!("Clone source stream missing: {e}")))?
        .clone();
    let mut plain = original
        .get_plain_content()
        .map_err(|e| RenderError::ParseError(format!("Clone source stream decode failed: {e}")))?;
    replacements.sort_by_key(|replacement| std::cmp::Reverse(replacement.0));
    let mut previous_start = usize::MAX;
    for (start, end, replacement, expected_hash) in replacements {
        if end > previous_start || start >= end {
            return Err(RenderError::UnsupportedFeature(
                "Overlapping clone-on-write operator ownership".into(),
            ));
        }
        let actual = plain.get(start..end).ok_or_else(|| {
            RenderError::ParseError("Clone-on-write operator range is outside its stream".into())
        })?;
        if expected_hash
            .as_deref()
            .is_some_and(|hash| sha256(actual) != hash)
        {
            return Err(RenderError::UnsupportedFeature(
                "Stale Form invocation operator hash".into(),
            ));
        }
        plain.splice(start..end, replacement);
        previous_start = start;
    }
    let mut cloned = original;
    if let Some(resources) = resources {
        cloned.dict.set("Resources", Object::Dictionary(resources));
    }
    cloned.set_plain_content(plain);
    let _ = cloned.compress();
    Ok(doc.add_object(cloned))
}

fn apply_form_group(
    doc: &mut Document,
    edits: &[&NativeTextSourceProvenanceV1],
    report: &mut NativeTextApplyReportV1,
) -> Result<(), RenderError> {
    let first = edits
        .first()
        .ok_or_else(|| RenderError::ParseError("Empty Form edit group".into()))?;
    let path = &first.invocation_path;
    if path.len() < 2 {
        return Err(RenderError::ParseError(
            "Form edit path is incomplete".into(),
        ));
    }
    if edits.iter().any(|source| {
        source.invocation_path != *path || source.stream_object_id != first.stream_object_id
    }) {
        return Err(RenderError::UnsupportedFeature(
            "Ambiguous Form edit group".into(),
        ));
    }
    let target_id = parse_object_id(&first.stream_object_id)?;
    let original_target = stream_bytes(doc, target_id)?;
    if edits
        .iter()
        .any(|source| sha256(&original_target) != source.stream_sha256)
    {
        return Err(RenderError::UnsupportedFeature(
            "Stale native text Form stream hash".into(),
        ));
    }
    let mut target_replacements = Vec::new();
    for source in edits {
        let [start, end] = source.operator_range;
        let actual = original_target.get(start..end).ok_or_else(|| {
            RenderError::ParseError("Native Form operator range is outside its stream".into())
        })?;
        let expected = base64::engine::general_purpose::STANDARD
            .decode(&source.original_operator_base64)
            .map_err(|_| {
                RenderError::ParseError("Native text original bytes are malformed".into())
            })?;
        if actual != expected || sha256(actual) != source.operator_sha256 {
            return Err(RenderError::UnsupportedFeature(
                "Stale native text Form operator hash".into(),
            ));
        }
        target_replacements.push((
            start,
            end,
            neutral_operation(source)?,
            Some(source.operator_sha256.clone()),
        ));
        report.neutralized += 1;
        report.marker_ids.push(source.marker_id.clone());
    }
    let mut child_clone =
        clone_stream_with_replacements(doc, target_id, target_replacements, None)?;
    report.cloned_forms += 1;
    report.cloned_streams += 1;

    let page_id = parse_object_id(&first.page_object_id)?;
    let mut effective_resources = vec![inherited_resources(doc, page_id)];
    for step in path.iter().skip(1) {
        let form_id = parse_object_id(&step.owner_object_id)?;
        let form = doc
            .get_object(form_id)
            .and_then(Object::as_stream)
            .map_err(|e| RenderError::ParseError(format!("Form path object missing: {e}")))?;
        let inherited = effective_resources.last().cloned().unwrap_or_default();
        effective_resources.push(
            form.dict
                .get(b"Resources")
                .ok()
                .and_then(|value| dict_from_object(doc, value))
                .unwrap_or(inherited),
        );
    }

    for path_index in (1..path.len()).rev() {
        let step = &path[path_index];
        let parent_stream_id = parse_object_id(&step.content_stream_object_id)?;
        let [start, end] = step.do_operator_range.ok_or_else(|| {
            RenderError::ParseError("Form invocation lacks an operator range".into())
        })?;
        let expected_hash = step.do_operator_hash.clone().ok_or_else(|| {
            RenderError::ParseError("Form invocation lacks an operator hash".into())
        })?;
        let resource_name = unique_form_name(first, path_index);
        let parent_resources = resources_with_child(
            doc,
            &effective_resources[path_index - 1],
            &resource_name,
            child_clone,
        )?;
        let replacement = format!("/{resource_name} Do").into_bytes();
        let parent_clone = clone_stream_with_replacements(
            doc,
            parent_stream_id,
            vec![(start, end, replacement, Some(expected_hash))],
            (path_index > 1).then_some(parent_resources.clone()),
        )?;
        report.cloned_streams += 1;
        if path_index > 1 {
            report.cloned_forms += 1;
            child_clone = parent_clone;
        } else {
            replace_page_stream_reference(doc, page_id, parent_stream_id, parent_clone)?;
            let page = doc
                .get_object_mut(page_id)
                .and_then(Object::as_dict_mut)
                .map_err(|e| {
                    RenderError::ParseError(format!(
                        "Page dictionary missing during Form retarget: {e}"
                    ))
                })?;
            page.set("Resources", Object::Dictionary(parent_resources));
        }
    }
    Ok(())
}

pub fn restore_native_text_sources(
    bytes: &[u8],
    sources: &[NativeTextSourceProvenanceV1],
) -> Result<NativeTextApplyResultV1, RenderError> {
    if sources.is_empty() {
        return Ok(NativeTextApplyResultV1 {
            pdf_bytes: bytes.to_vec(),
            report: NativeTextApplyReportV1::default(),
        });
    }
    let mut doc = Document::load_from(Cursor::new(bytes))
        .map_err(|e| RenderError::ParseError(e.to_string()))?;
    let stream_ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, object)| object.as_stream().ok().map(|_| *id))
        .collect();
    let mut report = NativeTextApplyReportV1::default();
    for source in sources {
        let marker = neutral_operation(source)?;
        let original = base64::engine::general_purpose::STANDARD
            .decode(&source.original_operator_base64)
            .map_err(|_| {
                RenderError::ParseError("Native text original bytes are malformed".into())
            })?;
        let mut found: Option<(ObjectId, usize)> = None;
        for stream_id in &stream_ids {
            let Ok(stream) = doc.get_object(*stream_id).and_then(Object::as_stream) else {
                continue;
            };
            let Ok(plain) = stream.get_plain_content() else {
                continue;
            };
            let positions: Vec<usize> = plain
                .windows(marker.len())
                .enumerate()
                .filter_map(|(index, window)| (window == marker.as_slice()).then_some(index))
                .collect();
            if positions.len() > 1 || (!positions.is_empty() && found.is_some()) {
                return Err(RenderError::UnsupportedFeature(format!(
                    "Duplicate native edit marker {}",
                    source.marker_id
                )));
            }
            if let Some(index) = positions.first() {
                found = Some((*stream_id, *index));
            }
        }
        let (stream_id, start) = found.ok_or_else(|| {
            RenderError::UnsupportedFeature(format!(
                "Native edit marker {} is missing",
                source.marker_id
            ))
        })?;
        let stream = doc
            .get_object_mut(stream_id)
            .and_then(Object::as_stream_mut)
            .map_err(|e| {
                RenderError::ParseError(format!("Native edit marker stream is unavailable: {e}"))
            })?;
        let mut plain = stream.get_plain_content().map_err(|e| {
            RenderError::ParseError(format!("Native edit marker stream decode failed: {e}"))
        })?;
        plain.splice(start..start + marker.len(), original);
        stream.set_plain_content(plain);
        let _ = stream.compress();
        report.restored += 1;
        report.marker_ids.push(source.marker_id.clone());
    }
    let output = save_rewritten_document(&mut doc, "Restore native text source")?;
    Ok(NativeTextApplyResultV1 {
        pdf_bytes: output,
        report,
    })
}

pub fn apply_native_text_edit_plan(
    bytes: &[u8],
    sources: &[NativeTextSourceProvenanceV1],
) -> Result<NativeTextApplyResultV1, RenderError> {
    if sources.is_empty() {
        return Ok(NativeTextApplyResultV1 {
            pdf_bytes: bytes.to_vec(),
            report: NativeTextApplyReportV1::default(),
        });
    }
    let document_hash = sha256(bytes);
    let mut doc = Document::load_from(Cursor::new(bytes))
        .map_err(|e| RenderError::ParseError(e.to_string()))?;
    if doc.is_encrypted() {
        return Err(RenderError::UnsupportedFeature(
            "Encrypted PDFs are not eligible for native text editing".into(),
        ));
    }
    let mut report = NativeTextApplyReportV1::default();
    let mut owned = HashSet::new();
    let mut marker_ids = HashSet::new();
    let mut by_stream: HashMap<ObjectId, Vec<&NativeTextSourceProvenanceV1>> = HashMap::new();
    let mut form_groups: HashMap<String, Vec<&NativeTextSourceProvenanceV1>> = HashMap::new();
    for source in sources {
        if source.schema != "open-pdf-studio.native-text-source" || source.version != 1 {
            return Err(RenderError::UnsupportedFeature(
                "Unknown native text provenance version".into(),
            ));
        }
        if source.document_sha256 != document_hash {
            return Err(RenderError::UnsupportedFeature(
                "Stale native text document hash".into(),
            ));
        }
        if !owned.insert((source.stream_object_id.clone(), source.operator_index)) {
            return Err(RenderError::UnsupportedFeature(
                "Overlapping native text operator ownership".into(),
            ));
        }
        if !marker_ids.insert(source.marker_id.clone())
            || marker_occurrences(&doc, &source.marker_id) > 0
        {
            return Err(RenderError::UnsupportedFeature(format!(
                "Duplicate native edit marker {}",
                source.marker_id
            )));
        }
        if source.invocation_path.len() > 1 {
            let key = format!("{:?}", source.invocation_path);
            form_groups.entry(key).or_default().push(source);
        } else {
            by_stream
                .entry(parse_object_id(&source.stream_object_id)?)
                .or_default()
                .push(source);
        }
    }
    let mut form_roots = HashSet::new();
    for edits in form_groups.values() {
        let root = edits
            .first()
            .and_then(|source| source.invocation_path.first())
            .ok_or_else(|| RenderError::ParseError("Form edit path has no page root".into()))?;
        if !form_roots.insert((
            root.owner_object_id.clone(),
            root.content_stream_object_id.clone(),
        )) {
            return Err(RenderError::UnsupportedFeature(
                "Multiple Form edits sharing one parent stream require a single atomic selection"
                    .into(),
            ));
        }
    }
    for edits in form_groups.values() {
        apply_form_group(&mut doc, edits, &mut report)?;
    }
    for (stream_id, mut edits) in by_stream {
        edits.sort_by_key(|source| std::cmp::Reverse(source.operator_range[0]));
        let page_id = parse_object_id(&edits[0].page_object_id)?;
        let original = doc
            .get_object(stream_id)
            .and_then(Object::as_stream)
            .map_err(|e| RenderError::ParseError(format!("Source stream missing: {e}")))?
            .clone();
        let mut plain = original
            .get_plain_content()
            .map_err(|e| RenderError::ParseError(format!("Source stream decode failed: {e}")))?;
        if edits
            .iter()
            .any(|source| sha256(&plain) != source.stream_sha256)
        {
            return Err(RenderError::UnsupportedFeature(
                "Stale native text stream hash".into(),
            ));
        }
        for source in edits {
            let [start, end] = source.operator_range;
            let actual = plain.get(start..end).ok_or_else(|| {
                RenderError::ParseError("Native text operator range is outside its stream".into())
            })?;
            let expected = base64::engine::general_purpose::STANDARD
                .decode(&source.original_operator_base64)
                .map_err(|_| {
                    RenderError::ParseError("Native text original bytes are malformed".into())
                })?;
            if actual != expected || sha256(actual) != source.operator_sha256 {
                return Err(RenderError::UnsupportedFeature(
                    "Stale native text operator hash".into(),
                ));
            }
            plain.splice(start..end, neutral_operation(source)?);
            report.neutralized += 1;
            report.marker_ids.push(source.marker_id.clone());
        }
        let mut cloned = original;
        cloned.set_plain_content(plain);
        let _ = cloned.compress();
        let cloned_id = doc.add_object(cloned);
        replace_page_stream_reference(&mut doc, page_id, stream_id, cloned_id)?;
        report.cloned_streams += 1;
    }
    let output = save_rewritten_document(&mut doc, "Save native text plan")?;
    Ok(NativeTextApplyResultV1 {
        pdf_bytes: output,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn fixture(operator: &str) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let font_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let stream_id = doc.add_object(Stream::new(
            Dictionary::new(),
            format!("BT /F1 12 Tf 1 0 0 1 72 700 Tm {operator} ET").into_bytes(),
        ));
        doc.objects.insert(page_id, Object::Dictionary(lopdf::dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => lopdf::dictionary! { "Font" => lopdf::dictionary! { "F1" => font_id } },
            "Contents" => stream_id,
        }));
        doc.objects.insert(pages_id, Object::Dictionary(lopdf::dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 }));
        let catalog_id =
            doc.add_object(lopdf::dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    fn repeated_form_fixture() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let font_id = doc.add_object(
            dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
        );
        let form_id = doc.add_object(Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 200.into(), 40.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
        }, b"BT /F1 12 Tf 1 0 0 1 0 0 Tm (Hello) Tj ET".to_vec()));
        let page_stream = doc.add_object(Stream::new(
            Dictionary::new(),
            b"q 1 0 0 1 72 700 cm /Fm Do Q q 1 0 0 1 72 650 cm /Fm Do Q".to_vec(),
        ));
        doc.objects.insert(page_id, Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Fm" => form_id } }, "Contents" => page_stream,
        }));
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 },
            ),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn inspects_and_neutralizes_all_show_text_operators() {
        for operator in [
            "(Hello) Tj",
            "[(Hel) -120 (lo)] TJ",
            "(Hello) '",
            "2 0 (Hello) \"",
        ] {
            let bytes = fixture(operator);
            let map = inspect_native_text_sources(&bytes, 0).unwrap();
            assert_eq!(map.runs.len(), 1, "{operator}");
            assert_eq!(map.runs[0].decoded_text, "Hello", "{operator}");
            let result = apply_native_text_edit_plan(&bytes, &map.runs).unwrap();
            let reparsed = inspect_native_text_sources(&result.pdf_bytes, 0).unwrap();
            assert!(reparsed.runs.is_empty(), "{operator}");
            assert_eq!(result.report.neutralized, 1);
            let restored = restore_native_text_sources(&result.pdf_bytes, &map.runs).unwrap();
            assert_eq!(restored.report.restored, 1);
            let restored_map = inspect_native_text_sources(&restored.pdf_bytes, 0).unwrap();
            assert_eq!(restored_map.runs[0].decoded_text, "Hello", "{operator}");
        }
    }

    #[test]
    fn rejects_stale_source_hashes() {
        let bytes = fixture("(Hello) Tj");
        let mut map = inspect_native_text_sources(&bytes, 0).unwrap();
        map.runs[0].stream_sha256 = "stale".to_owned();
        let error = apply_native_text_edit_plan(&bytes, &map.runs).unwrap_err();
        assert!(error
            .to_string()
            .to_ascii_lowercase()
            .contains("stale native text stream hash"));
    }

    #[test]
    fn clones_only_the_selected_shared_form_invocation() {
        let bytes = repeated_form_fixture();
        let map = inspect_native_text_sources(&bytes, 0).unwrap();
        assert_eq!(map.runs.len(), 2);
        assert!(map.runs.iter().all(|run| run.shared));
        let result = apply_native_text_edit_plan(&bytes, &map.runs[..1]).unwrap();
        assert_eq!(result.report.neutralized, 1);
        assert!(result.report.cloned_forms >= 1);
        let reparsed = inspect_native_text_sources(&result.pdf_bytes, 0).unwrap();
        assert_eq!(
            reparsed
                .runs
                .iter()
                .filter(|run| run.decoded_text == "Hello")
                .count(),
            1
        );
    }
}
