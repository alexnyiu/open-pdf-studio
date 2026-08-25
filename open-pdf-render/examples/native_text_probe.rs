use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .ok_or("usage: native_text_probe <pdf> [page-index] [edited-output]")?;
    let page_index = args
        .next()
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(0);
    let output = args.next();
    let map_output = args.next();
    let bytes = fs::read(&path)?;
    let map = open_pdf_render::native_text::inspect_native_text_sources(&bytes, page_index)?;
    println!(
        "page={} runs={} eligible={} rejected={} operators={:?}",
        page_index,
        map.runs.len(),
        map.runs
            .iter()
            .filter(|run| run.eligibility.eligible)
            .count(),
        map.rejected_count,
        map.runs
            .iter()
            .fold(std::collections::BTreeMap::new(), |mut counts, run| {
                *counts.entry(run.operator_kind.clone()).or_insert(0usize) += 1;
                counts
            }),
    );
    if let Some(map_output) = map_output {
        fs::write(map_output, serde_json::to_vec_pretty(&map)?)?;
    }
    if let Some(output) = output {
        let source = map
            .runs
            .iter()
            .find(|run| run.eligibility.eligible)
            .ok_or("no eligible run")?;
        let applied = open_pdf_render::native_text::apply_native_text_edit_plan(
            &bytes,
            std::slice::from_ref(source),
        )?;
        fs::write(&output, &applied.pdf_bytes)?;
        let reopened = open_pdf_render::native_text::inspect_native_text_sources(
            &applied.pdf_bytes,
            page_index,
        )?;
        println!(
            "edited={} marker={} source-still-extractable={} neutralized={}",
            output,
            source.marker_id,
            reopened
                .runs
                .iter()
                .any(|run| run.decoded_text == source.decoded_text),
            applied.report.neutralized,
        );
    }
    Ok(())
}
