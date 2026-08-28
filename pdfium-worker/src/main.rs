// Release builds: hide the console window so each spawned worker process
// doesn't pop a black terminal next to the Tauri main window. Debug builds
// keep the console so logs are visible during development. Mirrors the
// pattern in open-pdf-studio/src-tauri/src/main.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod protocol;
mod render;
mod shm;

use anyhow::{Context, Result};
use protocol::{Request, Response};
use render::{RasterLimits, Renderer};
use shm::Shm;
use std::io::{BufRead, Write};

const PNG_TRANSFER_PREFIX: &str = "open-pdf-studio-render-";
const PNG_TRANSFER_SUFFIX: &str = ".png";

fn validate_transfer_token(token: &str) -> Result<()> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("invalid PNG transfer token");
    }
    Ok(())
}

fn transfer_path(token: &str) -> Result<std::path::PathBuf> {
    validate_transfer_token(token)?;
    Ok(std::env::temp_dir().join(format!("{PNG_TRANSFER_PREFIX}{token}{PNG_TRANSFER_SUFFIX}")))
}

fn encode_png_to_transfer_file(rgba: &[u8], width: u32, height: u32, token: &str) -> Result<u64> {
    use image::ImageEncoder;

    let path = transfer_path(token)?;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| format!("create exclusive PNG transfer {}", path.display()))?;
    let encoded = (|| -> Result<u64> {
        let mut writer = std::io::BufWriter::with_capacity(16 * 1024, file);
        image::codecs::png::PngEncoder::new_with_quality(
            &mut writer,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::NoFilter,
        )
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .context("encode display PNG directly to transfer file")?;
        writer.flush().context("flush display PNG transfer file")?;
        Ok(writer
            .get_ref()
            .metadata()
            .context("stat display PNG transfer file")?
            .len())
    })();
    if encoded.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    encoded
}

fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--probe-pdfium") {
        let _renderer = Renderer::new().context("probe PDFium runtime")?;
        println!(r#"{{"pdfium":"ready"}}"#);
        return Ok(());
    }

    // Slot is passed as argv[1] (set by the spawner). Default to 0 for
    // standalone testing. Namespace (owning app PID) is argv[2] so multiple
    // app instances don't collide on the same SHM file; default "0".
    let slot: u32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let ns: String = std::env::args().nth(2).unwrap_or_else(|| "0".to_string());

    let mut renderer = Renderer::new().context("init Renderer")?;
    let mut shm_region = Shm::create(&ns, slot).context("init SHM")?;

    // Emit ready message — main process waits for this before
    // sending render requests.
    let ready = Response::Ready {
        op: "ready".to_string(),
        shm_name: format!("pdfium-worker-{}-{}.shm", ns, slot),
        shm_size: shm::SHM_SIZE as u64,
    };
    writeln!(std::io::stdout(), "{}", serde_json::to_string(&ready)?)?;
    std::io::stdout().flush()?;

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[worker {}] stdin read error: {}", slot, e);
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[worker {}] bad request: {}", slot, e);
                continue;
            }
        };

        match req {
            Request::Render {
                id,
                path,
                page_index,
                scale,
                rotation,
            } => {
                let resp = match renderer.render(&path, page_index, scale, rotation) {
                    Ok(result) => {
                        match shm_region.write_bitmap(result.width, result.height, &result.rgba) {
                            Ok(bytes) => Response::RenderOk {
                                id,
                                ok: true,
                                w: result.width,
                                h: result.height,
                                shm_bytes: bytes,
                            },
                            Err(e) => Response::RenderErr {
                                id,
                                ok: false,
                                error: format!("SHM write: {}", e),
                            },
                        }
                    }
                    Err(e) => Response::RenderErr {
                        id,
                        ok: false,
                        error: format!("{}", e),
                    },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::RenderPng {
                id,
                path,
                page_index,
                scale,
                rotation,
                transfer_token,
            } => {
                let resp = match renderer.render(&path, page_index, scale, rotation) {
                    Ok(result) => encode_png_to_transfer_file(
                        &result.rgba,
                        result.width,
                        result.height,
                        &transfer_token,
                    )
                    .map(|bytes| Response::RenderPngOk {
                        id,
                        ok: true,
                        w: result.width,
                        h: result.height,
                        file_bytes: bytes,
                    })
                    .unwrap_or_else(|error| Response::RenderErr {
                        id,
                        ok: false,
                        error: format!("PNG transport: {error}"),
                    }),
                    Err(error) => Response::RenderErr {
                        id,
                        ok: false,
                        error: error.to_string(),
                    },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::RenderOcr {
                id,
                path,
                page_index,
                scale,
                rotation,
                max_width,
                max_height,
                max_pixels,
                max_raster_bytes,
            } => {
                let limits = RasterLimits {
                    max_width,
                    max_height,
                    max_pixels,
                    max_raster_bytes,
                };
                let resp = match renderer.render_ocr(&path, page_index, scale, rotation, limits) {
                    Ok(result) => {
                        match shm_region.write_bitmap(result.width, result.height, &result.rgba) {
                            Ok(bytes) => Response::RenderOcrOk {
                                id,
                                ok: true,
                                w: result.width,
                                h: result.height,
                                shm_bytes: bytes,
                                page_geometry: result
                                    .page_geometry
                                    .expect("bounded OCR render always records page geometry"),
                            },
                            Err(error) => Response::RenderErr {
                                id,
                                ok: false,
                                error: format!("SHM write: {error}"),
                            },
                        }
                    }
                    Err(error) => Response::RenderErr {
                        id,
                        ok: false,
                        error: error.to_string(),
                    },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::PageGeometry {
                id,
                path,
                page_index,
                scale,
                rotation,
                max_width,
                max_height,
                max_pixels,
                max_raster_bytes,
            } => {
                let limits = RasterLimits {
                    max_width,
                    max_height,
                    max_pixels,
                    max_raster_bytes,
                };
                let resp = match renderer.render_ocr(&path, page_index, scale, rotation, limits) {
                    Ok(result) => Response::PageGeometryOk {
                        id,
                        ok: true,
                        page_geometry: result
                            .page_geometry
                            .expect("bounded geometry render always records page geometry"),
                    },
                    Err(error) => Response::RenderErr {
                        id,
                        ok: false,
                        error: error.to_string(),
                    },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::RenderRegion {
                id,
                path,
                page_index,
                scale,
                rotation,
                region_x_pt,
                region_y_pt,
                region_w_pt,
                region_h_pt,
            } => {
                let resp = match renderer.render_region(
                    &path,
                    page_index,
                    scale,
                    rotation,
                    region_x_pt,
                    region_y_pt,
                    region_w_pt,
                    region_h_pt,
                ) {
                    Ok(result) => {
                        match shm_region.write_bitmap(result.width, result.height, &result.rgba) {
                            Ok(bytes) => Response::RenderOk {
                                id,
                                ok: true,
                                w: result.width,
                                h: result.height,
                                shm_bytes: bytes,
                            },
                            Err(e) => Response::RenderErr {
                                id,
                                ok: false,
                                error: format!("SHM write: {}", e),
                            },
                        }
                    }
                    Err(e) => Response::RenderErr {
                        id,
                        ok: false,
                        error: format!("{}", e),
                    },
                };
                writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                stdout.flush()?;
            }
            Request::Trim => {
                renderer.trim();
            }
            Request::Shutdown => {
                eprintln!("[worker {}] shutting down", slot);
                break;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_token_is_bounded_and_path_is_derived() {
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let path = transfer_path(token).unwrap();
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            format!("{PNG_TRANSFER_PREFIX}{token}{PNG_TRANSFER_SUFFIX}")
        );
        assert!(validate_transfer_token("../escape").is_err());
        assert!(validate_transfer_token(&"a".repeat(63)).is_err());
    }

    #[test]
    fn png_is_encoded_directly_to_exclusive_file() {
        let token = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let path = transfer_path(token).unwrap();
        let _ = std::fs::remove_file(&path);
        let rgba = [255_u8, 255, 255, 255];
        let bytes = encode_png_to_transfer_file(&rgba, 1, 1, token).unwrap();
        let encoded = std::fs::read(&path).unwrap();
        assert_eq!(bytes, encoded.len() as u64);
        assert!(encoded.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(encode_png_to_transfer_file(&rgba, 1, 1, token).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
