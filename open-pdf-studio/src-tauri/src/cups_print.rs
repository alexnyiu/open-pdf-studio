use std::{path::Path, process::Command};

fn submission_command(path: &Path, printer: &str) -> Result<Command, String> {
    if printer.trim().is_empty() || printer.contains('\0') {
        return Err("Choose a printer before submitting the PDF".to_string());
    }
    #[cfg(target_os = "macos")]
    let executable = "/usr/bin/lp";
    #[cfg(not(target_os = "macos"))]
    let executable = "lp";
    let mut command = Command::new(executable);
    // Keep destination and file names as separate OS arguments. CUPS copies
    // the file into the scheduler before lp resolves; no source association
    // or shell is involved. https://openprinting.github.io/cups/doc/man-lp.html
    command
        .arg("-d")
        .arg(printer)
        .arg("--")
        .arg(path.as_os_str());
    Ok(command)
}

fn submission_result(success: bool, stderr: &[u8]) -> Result<bool, String> {
    if success {
        // Accepted by the spooler, not a claim that paper has been printed.
        return Ok(true);
    }
    let detail = String::from_utf8_lossy(stderr);
    let detail = detail.trim();
    Err(if detail.is_empty() {
        "The printer did not accept the PDF. Check its queue and try again.".to_string()
    } else {
        format!("The printer did not accept the PDF: {detail}")
    })
}

pub fn submit_pdf(path: String, printer: String) -> Result<bool, String> {
    let source = Path::new(&path)
        .canonicalize()
        .map_err(|error| format!("Cannot read the print PDF: {error}"))?;
    if !source.is_file() {
        return Err("The print PDF is not a file".to_string());
    }
    let output = submission_command(&source, &printer)?
        .output()
        .map_err(|error| format!("Cannot start the CUPS print service: {error}"))?;
    submission_result(output.status.success(), &output.stderr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn destination_and_unicode_path_are_literal_arguments() {
        let path = Path::new("/tmp/Reports and notes/épreuve $(ignored).pdf");
        let command = submission_command(path, "Office;still-literal").unwrap();
        assert_eq!(
            command.get_args().collect::<Vec<&OsStr>>(),
            vec![
                OsStr::new("-d"),
                OsStr::new("Office;still-literal"),
                OsStr::new("--"),
                path.as_os_str(),
            ]
        );
    }

    #[test]
    fn empty_destination_and_failed_submission_cannot_report_success() {
        assert!(submission_command(Path::new("/tmp/test.pdf"), " ").is_err());
        assert!(submission_result(false, b"unknown destination")
            .unwrap_err()
            .contains("unknown destination"));
        assert!(submission_result(false, b"").is_err());
        assert_eq!(submission_result(true, b"").unwrap(), true);
    }

    #[test]
    fn missing_pdf_is_rejected_before_starting_the_spooler() {
        assert!(submit_pdf(
            "/nonexistent-opds-print-test/input.pdf".into(),
            "unused".into()
        )
        .is_err());
    }
}
