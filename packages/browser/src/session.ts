import type { BrowserContext, Page } from "playwright-core";
import { sanitizeXIngestError, type XBrowserSession } from "@alfred/memory";
import { browserDisplayName, loadBrowserConfig } from "./config.js";

export function browserSessionMeta(): Pick<XBrowserSession, "channel" | "browser"> {
  const channel = loadBrowserConfig().channel;
  return { channel, browser: browserDisplayName(channel) };
}

export function xSessionHint(status: {
  loggedIn: boolean;
  handle?: string;
  loginOpen?: boolean;
  busy?: boolean;
  blocked?: boolean;
}): string {
  if (status.busy) {
    return "The ingest browser is busy (a scan may be running). Wait for it to finish before checking the session";
  }
  if (status.loginOpen) {
    return "Sign-in window is open. Finish logging into the dedicated ingest account, then close that browser window so ingest can use the profile";
  }
  if (status.loggedIn) {
    return status.handle
      ? `Logged in as @${status.handle}. Keep this a dedicated ingest account, not your personal X`
      : "Logged in. Prefer a dedicated ingest account so X lockouts stay off your personal profile";
  }
  if (status.blocked) {
    return "X blocked this browser. Log in headed with a dedicated ingest account (Settings → Ingest, or ingest-x-login), then close that window";
  }
  return "Not logged into X. Sign in with a dedicated ingest account from Settings → Ingest, then close that browser window";
}

export async function readXSessionFromPage(page: Page): Promise<{
  loggedIn: boolean;
  handle?: string;
  loginWall: boolean;
  blocked: boolean;
  href: string;
}> {
  return page.evaluate(`(() => {
    const home = document.querySelector('[data-testid="AppTabBar_Home_Link"]');
    const account = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const body = document.body?.innerText ?? "";
    const loginWall =
      /sign in to x|log in to x|sign in to twitter/i.test(body) && !home;
    const aria = account?.getAttribute("aria-label") ?? "";
    const fromAria = (aria.match(/@([A-Za-z0-9_]+)/) || [])[1];
    const fromProfile = (profile?.getAttribute("href") || "").replace(/^\\//, "").split("/")[0];
    const handle = fromAria || (fromProfile && !/^(home|i|explore|login)$/i.test(fromProfile) ? fromProfile : "");
    const href = location.href;
    const blocked = /account\\/access|something went wrong/i.test(body + href);
    return {
      loggedIn: Boolean((home || account) && !loginWall),
      loginWall,
      blocked,
      handle: handle || undefined,
      href,
    };
  })()`) as Promise<{
    loggedIn: boolean;
    handle?: string;
    loginWall: boolean;
    blocked: boolean;
    href: string;
  }>;
}

export function sessionFromPageState(
  state: {
    loggedIn: boolean;
    handle?: string;
    loginWall: boolean;
    blocked: boolean;
    href: string;
  },
  extras: Partial<XBrowserSession> = {},
): XBrowserSession {
  const loginOpen = Boolean(extras.loginOpen);
  const blocked =
    Boolean(extras.blocked) ||
    state.blocked ||
    (!state.loggedIn && !state.loginWall && /ERR_|http|blocked/i.test(extras.error ?? ""));
  const loggedIn = !loginOpen && state.loggedIn;
  const status = {
    loggedIn,
    handle: state.handle,
    loginOpen,
    blocked: !loggedIn && blocked,
    profileDir: extras.profileDir ?? loadBrowserConfig().userDataDir,
    error: extras.error,
    ...browserSessionMeta(),
  };
  return { ...status, hint: xSessionHint(status) };
}

export async function probeXSessionOnContext(context: BrowserContext): Promise<XBrowserSession> {
  const profileDir = loadBrowserConfig().userDataDir;
  const page = await context.newPage();
  try {
    try {
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 8_000 });
    } catch (err) {
      const error = sanitizeXIngestError(err instanceof Error ? err.message : String(err));
      const opened = page.url();
      if (!/x\.com|twitter\.com/i.test(opened)) {
        return {
          loggedIn: false,
          blocked: true,
          profileDir,
          error,
          hint: xSessionHint({ loggedIn: false, blocked: true }),
          ...browserSessionMeta(),
        };
      }
    }
    await page.waitForTimeout(500);
    const state = await readXSessionFromPage(page);
    return sessionFromPageState(state, { profileDir });
  } catch (err) {
    const error = sanitizeXIngestError(err instanceof Error ? err.message : String(err));
    const blocked = /HTTP|blocked|could not be loaded/i.test(error);
    return {
      loggedIn: false,
      blocked,
      profileDir,
      error,
      hint: xSessionHint({ loggedIn: false, blocked }),
      ...browserSessionMeta(),
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}
