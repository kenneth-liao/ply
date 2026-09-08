import { closeBrowser } from "./browser.js";

/** Keep the command result distinct from failure to shut down its browser. */
export async function closeCliBrowser(mutationCommitted = false): Promise<void> {
  try {
    await closeBrowser();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const outcome = mutationCommitted
      ? "The mutation is already committed and has not been rolled back. Do not retry it."
      : "The reported command outcome is unchanged.";
    console.error(
      `Browser teardown failed: ${detail}. ${outcome} ` +
      "Inspect the Project before further mutations. Stop only this command's remaining browser process if necessary.",
    );
    // A still-connected browser can keep the event loop alive. End this CLI
    // with an operational failure after reporting the preserved outcome.
    process.exit(1);
  }
}
