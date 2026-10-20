import type { BrowserContext, Page } from "playwright-core";
import type { XBrowserSession } from "@alfred/memory";
import { browserDisplayName, loadBrowserConfig } from "./config.js";
import { isProfileLockError, killBrowserProfileLocks } from "./profile-lock.js";
import { launchPersistentContext, rewriteProfileLockError } from "./playwright-capture.js";
import { browserSessionMeta, probeXSessionOnContext, xSessionHint } from "./session.js";
import { closeSoon, withTimeout } from "./timeout.js";

type LoginLifecycle = { context: BrowserContext; done: Promise<void> };

let loginLifecycle: LoginLifecycle | undefined;

function loginPagesOpen(context: BrowserContext): boolean {
  try {
    return context.pages().some((page) => !page.isClosed());
  } catch {
    return false;
  }
}

export function xLoginWindowOpen(): boolean {
  const context = loginLifecycle?.context;
  return Boolean(context && loginPagesOpen(context));
}

function watchLoginContext(context: BrowserContext, page: Page): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (loginLifecycle?.context === context) loginLifecycle = undefined;
      resolve();
    };
    const closeIfIdle = () => {
      if (!loginPagesOpen(context)) void context.close().catch(() => undefined);
    };
    context.once("close", finish);
    page.on("close", closeIfIdle);
    context.on("page", (next) => next.on("close", closeIfIdle));
  });
}

export async function startXLoginBrowser(): Promise<{
  started: boolean;
  alreadyOpen: boolean;
  profileDir: string;
  browser: string;
}> {
  const config = loadBrowserConfig({ headless: false });
  const browser = browserDisplayName(config.channel);
  await closeXLoginBrowserIfIdle();
  if (xLoginWindowOpen()) {
    return { started: false, alreadyOpen: true, profileDir: config.userDataDir, browser };
  }
  await closeXLoginBrowser();
  let context: BrowserContext;
  try {
    context = await launchPersistentContext(config, { headless: false });
  } catch (err) {
    if (!isProfileLockError(err)) throw err;
    await killBrowserProfileLocks(config.userDataDir);
    context = await launchPersistentContext(config, { headless: false });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" }).catch(() => undefined);
  loginLifecycle = { context, done: watchLoginContext(context, page) };
  return { started: true, alreadyOpen: false, profileDir: config.userDataDir, browser };
}

export async function waitForXLoginBrowser(): Promise<void> {
  await loginLifecycle?.done;
}

export async function closeXLoginBrowserIfIdle(): Promise<void> {
  const life = loginLifecycle;
  if (!life) return;
  if (loginPagesOpen(life.context)) return;
  await closeXLoginBrowser();
}

export async function closeXLoginBrowser(): Promise<void> {
  const life = loginLifecycle;
  loginLifecycle = undefined;
  await closeSoon(life?.context);
  await withTimeout(Promise.resolve(life?.done), 1_000, "login close timed out").catch(() => undefined);
  if (!life) return;
  await withTimeout(
    killBrowserProfileLocks(loadBrowserConfig().userDataDir),
    2_000,
    "profile unlock timed out",
  ).catch(() => undefined);
}

/** Open a headed browser on x.com so the user can log in once. Blocks until the window closes. */
export async function openXLoginBrowser(): Promise<void> {
  const { alreadyOpen, profileDir, browser } = await startXLoginBrowser();
  console.log(
    alreadyOpen
      ? `An X login window is already open. Finish signing into the dedicated ingest account, then close that ${browser} window.`
      : `Log into X in the opened ${browser} window with a dedicated ingest account (not your personal profile), then close that window.\n` +
          "Leave this command running until you close the window. ingest-x cannot use the\n" +
          "same profile while this login browser is still open.\n" +
          `Profile: ${profileDir}`,
  );
  await waitForXLoginBrowser();
}

export async function probeXSession(opts?: { context?: BrowserContext }): Promise<XBrowserSession> {
  const config = loadBrowserConfig();
  const profileDir = config.userDataDir;
  await closeXLoginBrowserIfIdle();
  if (xLoginWindowOpen()) {
    return {
      loggedIn: false,
      loginOpen: true,
      profileDir,
      hint: xSessionHint({ loggedIn: false, loginOpen: true }),
      ...browserSessionMeta(),
    };
  }
  if (opts?.context) return probeXSessionOnContext(opts.context);

  const timedOut = (message: string): XBrowserSession => ({
    loggedIn: false,
    profileDir,
    error: message,
    hint: "Session check timed out. Alfred uses its own ingest Chrome, not your everyday window. Wait if a scan is running, then try again",
    ...browserSessionMeta(),
  });

  const launchProbe = async () => {
    const context = await withTimeout(
      launchPersistentContext(config),
      8_000,
      "timed out launching the ingest browser",
    );
    try {
      return await withTimeout(
        probeXSessionOnContext(context),
        9_000,
        "timed out loading X",
      );
    } finally {
      await closeSoon(context);
    }
  };

  try {
    return await withTimeout(launchProbe(), 12_000, "session check timed out");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(message)) return timedOut(message);
    if (isProfileLockError(err)) {
      return {
        loggedIn: false,
        loginOpen: true,
        profileDir,
        error: rewriteProfileLockError(err, profileDir).message,
        hint: xSessionHint({ loggedIn: false, busy: true }),
        ...browserSessionMeta(),
      };
    }
    const rewritten = rewriteProfileLockError(err, profileDir);
    return {
      loggedIn: false,
      loginOpen: false,
      profileDir,
      error: rewritten.message,
      hint: xSessionHint({ loggedIn: false, blocked: /HTTP|blocked/i.test(rewritten.message) }),
      ...browserSessionMeta(),
    };
  }
}
