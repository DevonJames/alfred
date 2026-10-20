import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import {
  canonicalizeXUrl,
  handleFromXStatusUrl,
  sanitizeXIngestError,
  statusIdFromUrl,
  type XCapture,
  type XCaptureAdapter,
  type XCapturedPost,
} from "@alfred/memory";
import { loadBrowserConfig, type BrowserConfig } from "./config.js";
import { runComputerUseFallback } from "./cua.js";
import { isProfileLockError } from "./profile-lock.js";
import { browserSessionMeta, probeXSessionOnContext, xSessionHint } from "./session.js";

interface TweetExtract {
  text: string;
  author: string;
  handle: string;
  publishedAt: string;
  href: string;
  statusIds: string[];
  images: string[];
  isReply: boolean;
  quotedText?: string;
  quotedAuthor?: string;
  outbound: string[];
}

export interface PageExtract {
  loginWall: boolean;
  paywall: boolean;
  paywallHeadline?: string;
  articleTitle?: string;
  articleBody?: string;
  tweets: TweetExtract[];
  pageText: string;
}

async function loadPlaywright() {
  return import("playwright-core");
}

export function profileLockErrorMessage(userDataDir: string): string {
  return (
    `Alfred browser profile is already in use (${userDataDir}). ` +
    "Only one process can use this browser profile. Close the X login window " +
    "(Settings → Ingest, or `pnpm memory -- ingest-x-login`), then rerun ingest."
  );
}

export function rewriteProfileLockError(err: unknown, userDataDir: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ProcessSingleton|SingletonLock|profile is already in use|profile directory/i.test(msg)) {
    return new Error(profileLockErrorMessage(userDataDir), { cause: err });
  }
  return err instanceof Error ? err : new Error(msg);
}

export async function launchPersistentContext(
  config: BrowserConfig,
  opts?: { headless?: boolean },
): Promise<BrowserContext> {
  const { chromium } = await loadPlaywright();
  await mkdir(config.userDataDir, { recursive: true });
  const headless = opts?.headless ?? config.headless;
  const launch: Record<string, unknown> = {
    headless,
    ignoreDefaultArgs: ["--enable-automation"],
    chromiumSandbox: true,
    viewport: { width: 1280, height: 900 },
  };
  if (config.channel === "chrome") launch.channel = "chrome";
  if (config.channel === "chromium") {
    /* bundled/system chromium */
  }
  if (config.executablePath) launch.executablePath = config.executablePath;
  try {
    const context = await chromium.launchPersistentContext(
      config.userDataDir,
      launch as Parameters<typeof chromium.launchPersistentContext>[1],
    );
    await context.addInitScript(
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
    );
    return context;
  } catch (err) {
    throw rewriteProfileLockError(err, config.userDataDir);
  }
}

function extractPageScript(wantId: string): string {
  return `(() => {
  const wantId = ${JSON.stringify(wantId)};
  const bodyText = document.body?.innerText ?? "";
  const loginWall =
    /sign in to x|log in to x|sign in to twitter/i.test(bodyText) &&
    !document.querySelector('[data-testid="AppTabBar_Home_Link"]');
  const paywall = /subscribe to (read|continue)|this post is for (premium )?subscribers|paywall/i.test(
    bodyText,
  );
  const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
  const articleEl = document.querySelector('[data-testid="article"]');
  const articleBody = articleEl
    ? [...articleEl.querySelectorAll("p")]
        .map((p) => p.innerText.trim())
        .filter(Boolean)
        .join("\\n\\n")
    : "";

  const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')]
    .filter((el) => !el.parentElement?.closest('article[data-testid="tweet"]'))
    .map((el) => {
    const quote = el.querySelector('[data-testid="quoteTweet"]');
    const textEl = [...el.querySelectorAll('[data-testid="tweetText"]')].find(
      (n) => !quote || !quote.contains(n),
    );
    const text = textEl?.innerText ?? "";
    const user = el.querySelector('[data-testid="User-Name"]')?.innerText ?? "";
    const lines = user.split("\\n").map((s) => s.trim()).filter(Boolean);
    const author = lines[0] ?? "";
    const handleLine = lines.find((l) => l.startsWith("@")) ?? "";
    const timeEl = el.querySelector("time");
    const time = timeEl?.getAttribute("datetime") ?? "";
    const timeHref = timeEl?.closest("a")?.href ?? "";
    const statusLinks = [...el.querySelectorAll("a")]
      .map((a) => a.getAttribute("href") || a.href)
      .filter((h) => /\\/status\\/\\d+/.test(h));
    const statusIds = [...new Set(statusLinks.map((h) => (h.match(/\\/status\\/(\\d+)/) || [])[1]).filter(Boolean))];
    const href =
      (timeHref && /\\/status\\/\\d+/.test(timeHref) ? timeHref : "") ||
      (wantId ? statusLinks.find((h) => h.includes(wantId)) : "") ||
      statusLinks[0] ||
      "";
    const handleFromHref = (href.match(/https?:\\/\\/[^/]+\\/([A-Za-z0-9_]+)\\/status\\//i) || href.match(/^\\/([A-Za-z0-9_]+)\\/status\\//) || [])[1];
    const images = [...el.querySelectorAll("img")]
      .map((img) => img.src)
      .filter((src) => /pbs\\.twimg\\.com\\/media|ton\\.twitter\\.com/i.test(src));
    const quotedText = quote
      ? (quote.querySelector('[data-testid="tweetText"]')?.innerText ?? "")
      : "";
    const outbound = [...el.querySelectorAll("a")]
      .map((a) => a.href)
      .filter((href) => /^https?:/i.test(href) && !/x\\.com|twitter\\.com|t\\.co/i.test(href));
    const isReply = /replying to/i.test(el.textContent ?? "");
    return {
      text,
      author,
      handle: handleLine.replace(/^@/, "") || (handleFromHref && handleFromHref !== "i" ? handleFromHref : ""),
      publishedAt: time,
      href,
      statusIds,
      images,
      isReply,
      quotedText: quotedText || undefined,
      quotedAuthor: quote
        ? (quote.querySelector('[data-testid="User-Name"]')?.innerText.split("\\n")[0] ?? undefined)
        : undefined,
      outbound,
    };
  });

  return {
    loginWall,
    paywall,
    paywallHeadline: paywall ? h1 || tweets[0]?.text.slice(0, 80) : undefined,
    articleTitle: articleEl ? h1 || undefined : undefined,
    articleBody: articleBody || undefined,
    tweets,
    pageText: bodyText.slice(0, 20000),
  };
})()`;
}

async function extractPage(page: Page, url?: string): Promise<PageExtract> {
  return page.evaluate(extractPageScript(statusIdFromUrl(url ?? "") ?? "")) as Promise<PageExtract>;
}

async function downloadImages(
  page: Page,
  urls: string[],
): Promise<Array<{ name: string; mimeType: string; bytes: Buffer }>> {
  const out: Array<{ name: string; mimeType: string; bytes: Buffer }> = [];
  const seen = new Set<string>();
  for (const [i, src] of urls.slice(0, 8).entries()) {
    if (!src || seen.has(src)) continue;
    seen.add(src);
    try {
      const res = await page.request.get(src);
      if (!res.ok()) continue;
      const bytes = Buffer.from(await res.body());
      const mimeType = res.headers()["content-type"]?.split(";")[0] ?? "image/jpeg";
      const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
      out.push({ name: `x-image-${i}.${ext}`, mimeType, bytes });
    } catch {
      /* skip */
    }
  }
  return out;
}

async function fetchLinkedPage(page: Page, url: string): Promise<XCapture["linkedPage"]> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(1500);
    const text = (await page.evaluate(`(() => {
      const paras = [...document.querySelectorAll("article p, main p, p")]
        .map((p) => p.innerText.trim())
        .filter((t) => t.length > 40);
      return {
        title: document.title,
        body: paras.slice(0, 40).join("\\n\\n"),
        paywall: /subscribe|paywall|become a member|metered/i.test(document.body.innerText),
      };
    })()`)) as { title: string; body: string; paywall: boolean };
    if (text.paywall && text.body.length < 200) {
      return { url, title: text.title || url, text: "" };
    }
    return { url, title: text.title || url, text: text.body };
  } catch {
    return { url, title: url, text: "" };
  }
}

/** Saved tweet card — permalink may be on the timestamp or any status link. */
function focusedTweetLocator(page: Page, statusId: string) {
  return page.locator(`article[data-testid="tweet"]:has(a[href*="/status/${statusId}"])`);
}

async function keepFocusedTweetInView(page: Page, url: string, statusId?: string): Promise<void> {
  if (!statusId) return;
  let card = focusedTweetLocator(page, statusId).first();
  if (!(await card.count())) {
    await gotoXStatus(page, url).catch(() => undefined);
    card = focusedTweetLocator(page, statusId).first();
  }
  await card.waitFor({ timeout: 8_000 }).catch(() => undefined);
  await card.scrollIntoViewIfNeeded().catch(() => undefined);
}

/** X collapses long tweets; collapsed body is not a valid ingest. */
export function tweetTextLooksTruncated(text: string): boolean {
  const t = text.replace(/\s+/g, " ").replace(/\uFFFC/g, "").trim();
  if (!t || /show more/i.test(t)) return true;
  if (t.length < 200 || t.length > 480) return false;
  return /[A-Za-z,;:]$/.test(t);
}

export function mergeTweetExtracts(into: TweetExtract[], extra: TweetExtract[]): TweetExtract[] {
  const keyOf = (t: TweetExtract, fallback: string) =>
    statusIdFromUrl(t.href) || t.statusIds.find(Boolean) || fallback;
  const map = new Map<string, TweetExtract>();
  const order: string[] = [];
  const add = (t: TweetExtract, i: number) => {
    const k = keyOf(t, `anon:${tweetHandle(t)}:${t.text.slice(0, 48)}:${i}`);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, t);
      order.push(k);
      return;
    }
    if (t.text.length > prev.text.length) map.set(k, { ...prev, ...t });
  };
  into.forEach((t, i) => add(t, i));
  extra.forEach((t, i) => add(t, into.length + i));
  return order.map((k) => map.get(k)!);
}

async function expandShowMoreInTweets(page: Page): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const clicked = (await page.evaluate(`(() => {
      const ok = (s) => /^(show more|see more)$/i.test((s || "").trim());
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        for (const el of article.querySelectorAll('button, [role="button"]')) {
          if (!ok(el.textContent)) continue;
          if (/reply/i.test(el.textContent || "")) continue;
          el.click();
          return true;
        }
      }
      return false;
    })()`)) as boolean;
    if (!clicked) break;
    await page.waitForTimeout(350);
  }
}

async function harvestTweets(page: Page, url: string): Promise<PageExtract> {
  await expandShowMoreInTweets(page);
  return extractPage(page, url);
}

/** Expand truncated text on the saved tweet only. */
async function expandFocusedTweet(page: Page, url: string, statusId?: string): Promise<void> {
  await expandShowMoreInTweets(page);
  if (statusId && !page.url().includes(statusId)) {
    await gotoXStatus(page, url).catch(() => undefined);
  }
  await keepFocusedTweetInView(page, url, statusId);
}

/** Reveal the author's thread and unroll every card's full text. */
async function expandAuthorThread(page: Page, url: string, statusId?: string): Promise<void> {
  await expandFocusedTweet(page, url, statusId);
  const article = statusId
    ? focusedTweetLocator(page, statusId).first()
    : page.locator('article[data-testid="tweet"]').first();
  const threadBtn = article.getByRole("button", { name: /show this thread/i }).first();
  const threadLink = article.getByRole("link", { name: /show this thread/i }).first();
  if (await threadBtn.count()) {
    await threadBtn.click({ timeout: 2500 }).catch(() => undefined);
    await page.waitForTimeout(800);
  } else if (await threadLink.count()) {
    await threadLink.click({ timeout: 2500 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
  await keepFocusedTweetInView(page, url, statusId);
  await expandShowMoreInTweets(page);
}

function tweetKey(t: TweetExtract): string {
  return statusIdFromUrl(t.href) || t.statusIds[0] || `${tweetHandle(t)}:${t.text.slice(0, 32)}`;
}

/** Walk the author's thread, harvesting expanded cards before X virtualizes them away. */
async function collectAuthorThreadExtract(page: Page, url: string, statusId?: string): Promise<PageExtract> {
  await expandAuthorThread(page, url, statusId);
  let last = await harvestTweets(page, url);
  let merged = mergeTweetExtracts([], last.tweets);
  const handle = (
    handleFromXStatusUrl(url) ||
    (statusId ? merged.find((t) => tweetHasStatusId(t, statusId))?.handle : undefined) ||
    ""
  ).toLowerCase();

  for (let i = 0; i < 12; i++) {
    const before = new Set(merged.map(tweetKey));
    await page.mouse.wheel(0, 560);
    await page.waitForTimeout(400);
    last = await harvestTweets(page, url);
    merged = mergeTweetExtracts(merged, last.tweets);
    if (statusId && !(await focusedTweetLocator(page, statusId).count())) {
      await keepFocusedTweetInView(page, url, statusId);
      last = await harvestTweets(page, url);
      merged = mergeTweetExtracts(merged, last.tweets);
      break;
    }
    const added = last.tweets.filter((t) => !before.has(tweetKey(t)));
    if (!added.length) break;
    if (handle && added.every((t) => tweetHandle(t) !== handle)) break;
  }

  await keepFocusedTweetInView(page, url, statusId);
  last = await harvestTweets(page, url);
  merged = mergeTweetExtracts(merged, last.tweets);
  return { ...last, tweets: merged };
}

/** Status URLs without share-tracking query params — X often 403s `?s=` links. */
export function xNavigationUrls(raw: string): string[] {
  const handle = handleFromXStatusUrl(raw);
  const id = statusIdFromUrl(raw);
  const out: string[] = [];
  const push = (next: string) => {
    if (next && !out.includes(next)) out.push(next);
  };
  if (handle && id) {
    push(`https://x.com/${handle}/status/${id}`);
    push(`https://twitter.com/${handle}/status/${id}`);
  }
  if (id) push(`https://x.com/i/status/${id}`);
  try {
    const u = new URL(raw.trim());
    u.search = "";
    u.hash = "";
    push(u.toString().replace(/\/$/, ""));
  } catch {
    /* ignore */
  }
  return out;
}

export function isHttpNavigationFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ERR_HTTP_RESPONSE_CODE_FAILURE|net::ERR_|page\.goto/i.test(msg);
}

export function friendlyNavigationError(err: unknown): string {
  return sanitizeXIngestError(err instanceof Error ? err.message : String(err));
}

async function waitForTweetCards(page: Page, timeout = 10_000): Promise<boolean> {
  try {
    await page.locator('article[data-testid="tweet"], [data-testid="tweetText"]').first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function ensureOnXHome(page: Page): Promise<void> {
  const opened = page.url();
  if (/x\.com|twitter\.com/i.test(opened) && !/about:blank/i.test(opened)) return;
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(700);
}

async function gotoXStatus(page: Page, url: string): Promise<void> {
  await ensureOnXHome(page);
  const targets = xNavigationUrls(url);
  if (!targets.length) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return;
  }
  let lastErr: unknown;
  for (const [i, target] of targets.entries()) {
    try {
      const res = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const status = res?.status() ?? 0;
      if (status >= 400) lastErr = new Error(`X returned HTTP ${status} for ${target}`);
    } catch (err) {
      lastErr = err;
      if (!isHttpNavigationFailure(err)) throw err;
    }
    if (await waitForTweetCards(page, 8_000)) return;
    if (i < targets.length - 1) await page.waitForTimeout(800);
  }
  if (lastErr) throw lastErr;
}

function tweetHandle<T extends { handle?: string }>(t: T): string {
  return (t.handle ?? "").replace(/^@/, "").toLowerCase();
}

/**
 * Prefer the tweet whose timestamp permalink matches the requested status id.
 * If X opened a different conversation, do not fall back to tweets[0].
 */
function tweetHasStatusId<T extends { href?: string; statusIds?: string[] }>(tweet: T, want: string): boolean {
  if (statusIdFromUrl(tweet.href ?? "") === want) return true;
  if ((tweet.statusIds ?? []).includes(want)) return true;
  return (tweet.href ?? "").includes(want);
}

export function selectPrimaryTweet<T extends { href?: string; handle?: string; statusIds?: string[] }>(
  tweets: T[],
  url: string,
): T | undefined {
  const want = statusIdFromUrl(url);
  if (want) {
    const match = tweets.find((t) => tweetHasStatusId(t, want));
    if (match) return match;
    const handle = handleFromXStatusUrl(url)?.toLowerCase();
    if (handle) {
      const matches = tweets.filter((t) => tweetHandle(t) === handle);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const parentHref = tweets[0]?.href;
        return matches.find((t) => t.href && t.href !== parentHref) ?? matches[0];
      }
    }
    return undefined;
  }
  return tweets[0];
}

export function toCapture(url: string, extracted: PageExtract, extras: Partial<XCapture> = {}): XCapture {
  const tweets = extracted.tweets;
  const primary = selectPrimaryTweet(tweets, url);
  const want = statusIdFromUrl(url);
  if (want && !primary && !extracted.articleBody) {
    return {
      url,
      canonicalUrl: canonicalizeXUrl(url),
      kind: "post",
      author: extras.author || "",
      headline: extras.headline || url,
      text: "",
      posts: [],
      outboundUrls: [],
      screenshots: extras.screenshots ?? [],
      images: extras.images ?? [],
      failure: extras.failure ?? {
        reason: extracted.tweets.length
          ? "could not find that post on the page — X showed a different conversation"
          : "the tweet cards never appeared on the page",
      },
      linkedPage: extras.linkedPage,
    };
  }
  const authorHandle = primary?.handle;
  const authorPosts = tweets.filter((t) => {
    const handle = (t.handle ?? "").replace(/^@/, "").toLowerCase();
    return Boolean(authorHandle && handle === tweetHandle(primary!));
  });
  const kept = authorPosts.length ? authorPosts : primary ? [primary] : [];
  const kind: XCapture["kind"] = extracted.articleBody
    ? "article"
    : primary?.quotedText
      ? "quote"
      : authorPosts.length > 1
        ? "thread"
        : "post";
  const quoted: XCapturedPost | undefined = primary?.quotedText
    ? {
        text: primary.quotedText,
        author: primary.quotedAuthor ?? "",
      }
    : undefined;
  const posts: XCapturedPost[] = kept.map((t) => ({
    text: t.text,
    author: t.author,
    authorHandle: t.handle,
    publishedAt: t.publishedAt || undefined,
    url: t.href,
    images: t.images,
    isReply: t.isReply,
  }));
  const headline =
    (extracted.articleBody ? extracted.articleTitle : undefined) ||
    primary?.text.split("\n")[0]?.slice(0, 120) ||
    primary?.quotedText?.split("\n")[0]?.slice(0, 120) ||
    extras.headline ||
    url;
  const bodyFromAuthor = kept.map((t) => t.text);
  const text =
    extracted.articleBody ||
    bodyFromAuthor.filter(Boolean).join("\n\n") ||
    primary?.quotedText ||
    (want ? "" : extracted.pageText);
  const outbound = [...new Set((primary ? [primary] : []).flatMap((t) => t.outbound))].slice(0, 3);
  return {
    url,
    canonicalUrl: canonicalizeXUrl(url),
    kind,
    author: primary?.author || extras.author || "",
    authorHandle,
    publishedAt: primary?.publishedAt || undefined,
    headline,
    text,
    posts,
    quoted,
    outboundUrls: outbound,
    screenshots: extras.screenshots ?? [],
    images: extras.images ?? [],
    failure: extras.failure,
    linkedPage: extras.linkedPage,
  };
}

export async function captureXPage(
  url: string,
  opts?: { config?: BrowserConfig; context?: BrowserContext },
): Promise<XCapture> {
  const config = opts?.config ?? loadBrowserConfig();
  const owned = !opts?.context;
  const context = opts?.context ?? (await launchPersistentContext(config));
  const existing = context.pages().find((p) => !p.isClosed());
  const page = existing ?? (await context.newPage());
  const closePage = owned || !existing;
  try {
    try {
      await gotoXStatus(page, url);
    } catch (err) {
      return toCapture(url, {
        loginWall: false,
        paywall: false,
        tweets: [],
        pageText: "",
      }, {
        failure: { reason: friendlyNavigationError(err) },
      });
    }
    const statusId = statusIdFromUrl(url);
    if (statusId) {
      await focusedTweetLocator(page, statusId)
        .first()
        .waitFor({ timeout: 12_000 })
        .catch(() => undefined);
    } else {
      await page.waitForTimeout(2000);
    }
    let extracted = await collectAuthorThreadExtract(page, url, statusId);

    const empty = !extracted.tweets.length && !extracted.articleBody;
    if (empty) {
      console.warn(
        `[x-ingest] no tweets at ${page.url()}: ${extracted.pageText.slice(0, 180).replace(/\s+/g, " ")}`,
      );
    }
    const needsCua =
      config.cua === "always" ||
      (config.cua === "fallback" && (extracted.loginWall || extracted.paywall));
    if (needsCua) {
      await runComputerUseFallback(page, url);
      const again = await collectAuthorThreadExtract(page, url, statusId);
      extracted = { ...again, tweets: mergeTweetExtracts(extracted.tweets, again.tweets) };
    }

    if (extracted.loginWall) {
      return toCapture(url, extracted, {
        failure: { reason: "login wall — Alfred browser profile is not logged into X" },
      });
    }
    if (extracted.paywall && !extracted.articleBody && extracted.tweets.every((t) => !t.text)) {
      return toCapture(url, extracted, {
        failure: {
          reason: "paywall",
          headline: extracted.paywallHeadline,
        },
        headline: extracted.paywallHeadline,
      });
    }

    const primaryForTrunc = selectPrimaryTweet(extracted.tweets, url);
    const handleForTrunc = tweetHandle(primaryForTrunc ?? {});
    const authorTweets = extracted.tweets.filter(
      (t) => !handleForTrunc || tweetHandle(t) === handleForTrunc,
    );
    if (authorTweets.some((t) => tweetTextLooksTruncated(t.text))) {
      return toCapture(url, extracted, {
        failure: { reason: "thread posts were truncated — full text of every post is required" },
      });
    }

    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    const primaryTweet = selectPrimaryTweet(extracted.tweets, url);
    const authorHandle = (primaryTweet?.handle ?? "").replace(/^@/, "").toLowerCase();
    const threadImages = extracted.tweets
      .filter((t) => (t.handle ?? "").replace(/^@/, "").toLowerCase() === authorHandle)
      .flatMap((t) => t.images);
    const imageUrls = [...new Set(threadImages.length ? threadImages : (primaryTweet?.images ?? []))].slice(0, 8);
    const images = await downloadImages(page, imageUrls);

    let linkedPage: XCapture["linkedPage"];
    const outbound = primaryTweet?.outbound[0];
    if (outbound) {
      linkedPage = await fetchLinkedPage(page, outbound);
      if (linkedPage && !linkedPage.text) {
        /* keep linked page but caller treats empty+paywall as failure on the hop only */
      }
    }

    const capture = toCapture(url, extracted, {
      screenshots: [{ name: "x-page.png", mimeType: "image/png", bytes: Buffer.from(screenshot) }],
      images,
      linkedPage,
    });
    if (linkedPage && !linkedPage.text.trim()) {
      capture.linkedPage = {
        ...linkedPage,
        title: linkedPage.title || "Linked page",
        text: "[Could not ingest linked page: paywall or empty]",
      };
    }
    if (!capture.failure && !capture.text.trim() && !capture.posts.some((p) => p.text.trim())) {
      capture.failure = {
        reason: "empty capture — page did not yield post or article text",
        headline: capture.headline,
      };
    }
    return capture;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/has been closed|Target closed|browser has been closed/i.test(msg)) throw err;
    return toCapture(url, {
      loginWall: false,
      paywall: false,
      tweets: [],
      pageText: "",
    }, {
      failure: { reason: friendlyNavigationError(err) },
    });
  } finally {
    if (closePage) await page.close().catch(() => undefined);
    if (owned) await context.close().catch(() => undefined);
  }
}

let sharedAdapter: XCaptureAdapter | undefined;

export function getSharedPlaywrightCaptureAdapter(config?: BrowserConfig): XCaptureAdapter {
  sharedAdapter ??= createPlaywrightCaptureAdapter(config);
  return sharedAdapter;
}

export function createPlaywrightCaptureAdapter(config?: BrowserConfig): XCaptureAdapter {
  const cfg = config ?? loadBrowserConfig();
  let contextPromise: Promise<BrowserContext> | undefined;
  let lastCaptureAt = 0;
  const getContext = async () => {
    if (contextPromise) {
      try {
        const existing = await contextPromise;
        existing.pages();
        return existing;
      } catch {
        contextPromise = undefined;
      }
    }
    contextPromise = (async () => {
      let last: unknown;
      for (let i = 0; i < 8; i++) {
        try {
          return await launchPersistentContext(cfg);
        } catch (err) {
          last = err;
          if (!isProfileLockError(err)) {
            contextPromise = undefined;
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      contextPromise = undefined;
      throw last;
    })();
    return contextPromise;
  };
  const adapter: XCaptureAdapter = {
    capture: async (url) => {
      const since = Date.now() - lastCaptureAt;
      if (lastCaptureAt && since < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 1500 - since));
      }
      lastCaptureAt = Date.now();
      const run = async () => {
        const context = await getContext();
        return captureXPage(url, { config: cfg, context });
      };
      try {
        return await run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/has been closed|Target closed|browser has been closed/i.test(msg)) throw err;
        contextPromise = undefined;
        return run();
      }
    },
    probeSession: async () => {
      try {
        const context = await getContext();
        return probeXSessionOnContext(context);
      } catch (err) {
        const rewritten = rewriteProfileLockError(err, cfg.userDataDir);
        return {
          loggedIn: false,
          loginOpen: true,
          profileDir: cfg.userDataDir,
          error: rewritten.message,
          hint: xSessionHint({ loggedIn: false, busy: true }),
          ...browserSessionMeta(),
        };
      }
    },
    close: async () => {
      const pending = contextPromise;
      contextPromise = undefined;
      if (sharedAdapter === adapter) sharedAdapter = undefined;
      if (!pending) return;
      const context = await pending.catch(() => undefined);
      await context?.close().catch(() => undefined);
    },
  };
  return adapter;
}

export function browserProfilePath(config?: BrowserConfig): string {
  return path.resolve((config ?? loadBrowserConfig()).userDataDir);
}
