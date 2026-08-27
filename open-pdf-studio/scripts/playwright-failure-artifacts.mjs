import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function startPlaywrightFailureArtifacts(context, artifactName) {
  const artifactDirectory = process.env.OPEN_PDF_STUDIO_TEST_ARTIFACT_DIR?.trim();
  if (!artifactDirectory) {
    return {
      capture: async () => {},
      discard: async () => {},
    };
  }

  await mkdir(artifactDirectory, { recursive: true });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  let traceStopped = false;

  return {
    async capture(page) {
      await page?.screenshot({
        path: join(artifactDirectory, `${artifactName}-failure.png`),
        fullPage: true,
      }).catch(() => {});
      await context.tracing.stop({
        path: join(artifactDirectory, `${artifactName}-failure-trace.zip`),
      }).then(() => { traceStopped = true; }).catch(() => {});
    },
    async discard() {
      if (traceStopped) return;
      await context.tracing.stop().catch(() => {});
      traceStopped = true;
    },
  };
}
