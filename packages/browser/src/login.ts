import { loadBrowserConfig } from "./config.js";
import { launchPersistentContext } from "./playwright-capture.js";

/** Open a headed browser on x.com so the user can log in once. */
export async function openXLoginBrowser(): Promise<void> {
  const config = loadBrowserConfig({ headless: false });
  const context = await launchPersistentContext(config, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });
  // Keep the process alive until the user closes the window.
  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
    page.on("close", () => resolve());
    console.log(
      "Log into X in the opened window, then close that Chrome window when done.\n" +
        "Leave this command running until you close the window. ingest-x cannot use the\n" +
        "same profile while this login Chrome is still open.\n" +
        `Profile: ${config.userDataDir}`,
    );
  });
}
