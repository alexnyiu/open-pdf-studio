// Prevents the additional console window on Windows, DO NOT REMOVE!!
// Unconditional (also debug builds): the app must run fully in the
// background with only its own window. Dev logs stay visible when launched
// from a terminal (`tauri dev` pipes stdio); double-click runs log nothing,
// startup failures still land in the app-local startup diagnostics file.
#![windows_subsystem = "windows"]

use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(name = "open-pdf-studio", version)]
struct Cli {
    /// Start an in-process MCP server on `--mcp-port` (default 9223). Off by default.
    /// Production builds refuse to start the server unless OPS_ENABLE_MCP=1.
    #[arg(long, default_value_t = false)]
    mcp_server: bool,

    /// Port for the MCP server (only used when --mcp-server is set).
    #[arg(long, default_value_t = 9223)]
    mcp_port: u16,

    /// Internal production one-job process boundary. Never shown as end-user UI.
    #[arg(long, hide = true)]
    ocr_child_job: Option<String>,

    /// PDF files to open. The application routes these through its normal file-open queue.
    #[arg(value_name = "PDF")]
    files: Vec<std::path::PathBuf>,
}

fn main() {
    app_lib::linux_runtime::configure_appimage_gio_modules();

    // Tauri swallows unrecognized args (e.g. file-association launches), so we
    // try_parse rather than parse so unknown args don't abort startup.
    let args: Vec<String> = std::env::args().collect();
    let cli = Cli::try_parse_from(&args).unwrap_or(Cli {
        mcp_server: false,
        mcp_port: 9223,
        ocr_child_job: None,
        files: Vec::new(),
    });

    app_lib::run(app_lib::StartupOpts {
        mcp_server: cli.mcp_server,
        mcp_port: cli.mcp_port,
        ocr_child_job: cli.ocr_child_job,
    });
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn multiple_files_preserve_explicit_launch_options() {
        let cli = Cli::try_parse_from([
            "open-pdf-studio", "--mcp-server", "--mcp-port", "19321",
            "/tmp/first file.pdf", "/tmp/第二.pdf",
        ]).unwrap();
        assert!(cli.mcp_server);
        assert_eq!(cli.mcp_port, 19321);
        assert_eq!(cli.files, vec![
            std::path::PathBuf::from("/tmp/first file.pdf"),
            std::path::PathBuf::from("/tmp/第二.pdf"),
        ]);
    }

    #[test]
    fn ordinary_file_launch_keeps_diagnostics_disabled() {
        let cli = Cli::try_parse_from(["open-pdf-studio", "/tmp/document.pdf"]).unwrap();
        assert!(!cli.mcp_server);
        assert_eq!(cli.files.len(), 1);
        assert!(Cli::try_parse_from(["open-pdf-studio"]).unwrap().files.is_empty());
    }
}
