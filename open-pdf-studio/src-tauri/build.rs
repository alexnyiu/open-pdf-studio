fn main() {
    // Copy the pdfium-worker binary into src-tauri/binaries/ so Tauri's
    // sidecar bundler picks it up. The binary must be named with the
    // target triple suffix per Tauri's externalBin convention.
    // This must happen BEFORE tauri_build::build() so the validator finds the file.
    //
    // De worker wordt vlak vóór deze app-build vers gecompileerd door het
    // npm-voorscript (predev/prebuild -> `cargo build -p pdfium-worker`). Wij
    // KOPIEREN hem alleen; we bouwen hem hier NIET (een cargo-aanroep vanuit
    // een build-script deadlockt op de target-lock die de ouder-cargo houdt).
    let target = std::env::var("TARGET").unwrap_or_else(|_| "x86_64-pc-windows-msvc".to_string());
    let host = std::env::var("HOST").unwrap_or_else(|_| target.clone());
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let exe_suffix = if target.contains("windows") { ".exe" } else { "" };
    let worker_name = format!("pdfium-worker{}", exe_suffix);

    // De worker staat in DEZELFDE target-directory als deze app-build. Bij een
    // gezette CARGO_TARGET_DIR (test-rig) is dat NIET `../../target`, dus leiden
    // we het pad af van OUT_DIR: `<target>/<profiel>/build/<crate>-<hash>/out`.
    // Drie niveaus omhoog vanaf OUT_DIR geeft de `<profiel>`-map waar de worker
    // ligt — ongeacht CARGO_TARGET_DIR of een cross-target-subpad.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        if let Some(profile_dir) = std::path::Path::new(&out_dir).ancestors().nth(3) {
            candidates.push(profile_dir.join(&worker_name));
        }
    }
    // Terugval: de klassieke workspace-target-map (geen CARGO_TARGET_DIR).
    // Bij cross-compilatie bevat deze map echter de HOST-worker. Die naar een
    // targetnaam kopiëren levert een geldig ogend maar onstartbaar pakket op.
    if host == target {
        candidates.push(
            std::path::PathBuf::from("../../target").join(&profile).join(&worker_name),
        );
    }

    let dst = std::path::PathBuf::from("binaries")
        .join(format!("pdfium-worker-{}{}", target, exe_suffix));
    if let Some(src) = candidates.iter().find(|p| p.exists()) {
        validate_binary_target(src, &target).unwrap_or_else(|error| {
            panic!("pdfium-worker validation failed for {}: {}", src.display(), error)
        });
        println!("cargo:rerun-if-changed={}", src.display());
        let _ = std::fs::create_dir_all("binaries");
        std::fs::copy(src, &dst).unwrap_or_else(|error| {
            panic!(
                "pdfium-worker copy failed ({} -> {}): {}",
                src.display(),
                dst.display(),
                error
            )
        });
        validate_binary_target(&dst, &target).unwrap_or_else(|error| {
            panic!("staged pdfium-worker validation failed for {}: {}", dst.display(), error)
        });
    } else if dst.exists() {
        // Release workflows may deliberately pre-stage the target-specific
        // sidecar. Validate it instead of overwriting it with a host binary.
        println!("cargo:rerun-if-changed={}", dst.display());
        validate_binary_target(&dst, &target).unwrap_or_else(|error| {
            panic!("pre-staged pdfium-worker validation failed for {}: {}", dst.display(), error)
        });
    } else {
        println!(
            "cargo:warning=pdfium-worker not found for target {} (host {}) in {:?}; build that target before bundling",
            target,
            host,
            candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
        );
    }

    // Windows: link Simple MAPI for MAPISendMail (src/email.rs). The in-source
    // #[link(name = "mapi32")] is not reliably honoured across every rustc/SDK
    // setup (CI left __imp_MAPISendMail unresolved), so force the link here.
    if target.contains("windows") {
        println!("cargo:rustc-link-lib=mapi32");
    }

    tauri_build::build();
}

fn read_u16(bytes: &[u8], offset: usize, little_endian: bool) -> Result<u16, String> {
    let value: [u8; 2] = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| "truncated executable header".to_string())?
        .try_into()
        .map_err(|_| "invalid executable header".to_string())?;
    Ok(if little_endian {
        u16::from_le_bytes(value)
    } else {
        u16::from_be_bytes(value)
    })
}

fn read_u32(bytes: &[u8], offset: usize, little_endian: bool) -> Result<u32, String> {
    let value: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "truncated executable header".to_string())?
        .try_into()
        .map_err(|_| "invalid executable header".to_string())?;
    Ok(if little_endian {
        u32::from_le_bytes(value)
    } else {
        u32::from_be_bytes(value)
    })
}

fn cpu_architecture(cpu_type: u32) -> &'static str {
    match cpu_type {
        0x0100_0007 => "x86_64",
        0x0100_000c => "arm64",
        _ => "unknown",
    }
}

fn inspect_binary(bytes: &[u8]) -> Result<(&'static str, Vec<&'static str>), String> {
    let magic = read_u32(bytes, 0, false)?;

    let thin_endian = match magic {
        0xcefa_edfe | 0xcffa_edfe => Some(true),
        0xfeed_face | 0xfeed_facf => Some(false),
        _ => None,
    };
    if let Some(little_endian) = thin_endian {
        return Ok((
            "mach-o",
            vec![cpu_architecture(read_u32(bytes, 4, little_endian)?)],
        ));
    }

    let fat = match magic {
        0xcafe_babe => Some((false, 20usize)),
        0xcafe_babf => Some((false, 32usize)),
        0xbeba_feca => Some((true, 20usize)),
        0xbfba_feca => Some((true, 32usize)),
        _ => None,
    };
    if let Some((little_endian, entry_size)) = fat {
        let count = read_u32(bytes, 4, little_endian)? as usize;
        if count == 0 || count > 32 {
            return Err(format!("invalid fat Mach-O architecture count {count}"));
        }
        let mut architectures = Vec::with_capacity(count);
        for index in 0..count {
            architectures.push(cpu_architecture(read_u32(
                bytes,
                8 + index * entry_size,
                little_endian,
            )?));
        }
        architectures.sort_unstable();
        architectures.dedup();
        return Ok(("mach-o", architectures));
    }

    if bytes.get(0..4) == Some(&[0x7f, b'E', b'L', b'F']) {
        let little_endian = match bytes.get(5) {
            Some(1) => true,
            Some(2) => false,
            value => return Err(format!("invalid ELF byte order {value:?}")),
        };
        let architecture = match read_u16(bytes, 18, little_endian)? {
            62 => "x86_64",
            183 => "arm64",
            _ => "unknown",
        };
        return Ok(("elf", vec![architecture]));
    }

    if bytes.get(0..2) == Some(&[b'M', b'Z']) {
        let pe_offset = read_u32(bytes, 0x3c, true)? as usize;
        if bytes.get(pe_offset..pe_offset + 4) != Some(b"PE\0\0") {
            return Err("PE signature is missing".to_string());
        }
        let architecture = match read_u16(bytes, pe_offset + 4, true)? {
            0x8664 => "x86_64",
            0xaa64 => "arm64",
            _ => "unknown",
        };
        return Ok(("pe", vec![architecture]));
    }

    Err("unrecognized executable format".to_string())
}

fn validate_binary_target(path: &std::path::Path, target: &str) -> Result<(), String> {
    let expected_architecture = if target.starts_with("x86_64-") {
        "x86_64"
    } else if target.starts_with("aarch64-") {
        "arm64"
    } else {
        // Mobile and other unsupported targets do not bundle this desktop
        // sidecar. Leave validation to their platform-specific configuration.
        return Ok(());
    };
    let expected_format = if target.contains("apple-darwin") {
        "mach-o"
    } else if target.contains("windows") {
        "pe"
    } else if target.contains("linux") {
        "elf"
    } else {
        return Ok(());
    };

    let bytes = std::fs::read(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let (format, architectures) = inspect_binary(&bytes)?;
    if format != expected_format || !architectures.contains(&expected_architecture) {
        return Err(format!(
            "target {target} requires {expected_format}/{expected_architecture}, found {format}/{}",
            architectures.join("+")
        ));
    }
    Ok(())
}
