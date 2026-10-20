import {
  browserDisplayName,
  closeXLoginBrowser,
  closeXLoginBrowserIfIdle,
  installedBrowserChannels,
  loadBrowserConfig,
  parseBrowserChannel,
  getSharedPlaywrightCaptureAdapter,
  probeXSession,
  startXLoginBrowser,
  xLoginWindowOpen,
  type BrowserChannel,
} from "@alfred/browser";
import type { XBrowserSession } from "@alfred/memory";
import { loadDesktopSettings, saveDesktopSettings } from "./desktop-settings.js";

export interface XIngestSessionView extends XBrowserSession {
  channel: BrowserChannel;
  browser: string;
  browsers: Array<{ id: BrowserChannel; name: string; installed: boolean }>;
}

function withBrowserList(session: XBrowserSession): XIngestSessionView {
  const cfg = loadBrowserConfig();
  const channel = session.channel ?? cfg.channel;
  return {
    ...session,
    channel,
    browser: session.browser ?? browserDisplayName(channel),
    browsers: installedBrowserChannels(),
  };
}

export async function applyBrowserChannelFromSettings(): Promise<BrowserChannel> {
  const file = await loadDesktopSettings();
  process.env.ALFRED_BROWSER_CHANNEL = file.browserChannel;
  return file.browserChannel;
}

export async function readXIngestSession(): Promise<XIngestSessionView> {
  await applyBrowserChannelFromSettings();
  await closeXLoginBrowserIfIdle();
  const shared = getSharedPlaywrightCaptureAdapter();
  if (shared.probeSession) return withBrowserList(await shared.probeSession());
  return withBrowserList(await probeXSession());
}

export async function setXIngestBrowser(raw: string): Promise<XIngestSessionView> {
  const channel = parseBrowserChannel(raw);
  if (!channel || channel === "chromium") {
    throw new Error("Choose Chrome or Brave");
  }
  const installed = installedBrowserChannels().find((row) => row.id === channel);
  if (installed && !installed.installed) {
    throw new Error(`${installed.name} is not installed on this Mac`);
  }
  const current = await loadDesktopSettings();
  await saveDesktopSettings({ ...current, browserChannel: channel });
  process.env.ALFRED_BROWSER_CHANNEL = channel;
  await closeXLoginBrowser();
  return withBrowserList({
    loggedIn: false,
    hint: `${browserDisplayName(channel)} is selected. Log into X with the dedicated ingest account, then close that window.`,
    channel,
    browser: browserDisplayName(channel),
  });
}

export async function openXIngestLogin(): Promise<{
  started: boolean;
  alreadyOpen: boolean;
  profileDir: string;
  browser: string;
  hint: string;
}> {
  await applyBrowserChannelFromSettings();
  const result = await startXLoginBrowser();
  return {
    ...result,
    hint: result.alreadyOpen
      ? `Sign-in window is already open. Finish logging into the dedicated ingest account, then close that ${result.browser} window.`
      : `${result.browser} opened on x.com/login. Use a dedicated ingest account, then close that window so scans can run.`,
  };
}

export async function closeXIngestLogin(): Promise<{ closed: boolean; loginOpen: boolean }> {
  const wasOpen = xLoginWindowOpen();
  await closeXLoginBrowser();
  return { closed: wasOpen, loginOpen: xLoginWindowOpen() };
}
