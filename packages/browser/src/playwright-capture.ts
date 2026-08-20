import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import {
  canonicalizeXUrl,
  handleFromXStatusUrl,
  statusIdFromUrl,
  type XCapture,
  type XCaptureAdapter,
  type XCapturedPost,
} from "@alfred/memory";
import { loadBrowserConfig, type BrowserConfig } from "./config.js";
import { runComputerUseFallback } from "./cua.js";

interface TweetExtract {
  text: string;
  author: string;
  handle: string;
  publishedAt: string;
  href: string;
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
    "Chrome only allows one process on this profile. Close the window from " +
    "`pnpm memory -- ingest-x-login` (and quit that command), then rerun ingest-x."
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
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1280, height: 900 },
  };
  if (config.channel === "chrome") launch.channel = "chrome";
  if (config.channel === "chromium") {
    /* bundled/system chromium */
  }
  if (config.executablePath) launch.executablePath = config.executablePath;
  try {
    return await chromium.launchPersistentContext(
      config.userDataDir,
      launch as Parameters<typeof chromium.launchPersistentContext>[1],
    );
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
      .filter((a) => /\\/status\\/\\d+/.test(a.href) && (!quote || !quote.contains(a)))
      .map((a) => a.href);
    const ownHref = wantId
      ? statusLinks.find((h) => h.includes("/status/" + wantId)) ||
        (timeHref.includes("/status/" + wantId) ? timeHref : "")
      : "";
    const href =
      ownHref ||
      (timeHref && /\\/status\\/\\d+/.test(timeHref) ? timeHref : "") ||
      statusLinks[0] ||
      location.href;
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
      handle: handleLine.replace(/^@/, ""),
      publishedAt: time,
      href,
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

function replyAddsValue(post: TweetExtract, authorHandle?: string): boolean {
  if (!post.isReply) return true;
  if (authorHandle && post.handle.toLowerCase() === authorHandle.toLowerCase()) return true;
  if (post.text.length >= 80) return true;
  if (/\d/.test(post.text) && post.text.length >= 40) return true;
  if (post.outbound.length) return true;
  return false;
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

async function expandThread(page: Page): Promise<void> {
  for (const label of ["Show more", "Show this thread", "Show replies", "See more"]) {
    const btn = page.getByText(label, { exact: false }).first();
    if (await btn.count()) {
      await btn.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(800);
    }
  }
  await page.mouse.wheel(0, 2400);
  await page.waitForTimeout(800);
}

function tweetHandle<T extends { handle?: string }>(t: T): string {
  return (t.handle ?? "").replace(/^@/, "").toLowerCase();
}

/** Prefer the tweet whose status id (or URL handle) matches the requested link. */
export function selectPrimaryTweet<T extends { href?: string; handle?: string }>(
  tweets: T[],
  url: string,
): T | undefined {
  const want = statusIdFromUrl(url);
  if (want) {
    const match = tweets.find((t) => statusIdFromUrl(t.href ?? "") === want);
    if (match) return match;
  }
  const handle = handleFromXStatusUrl(url)?.toLowerCase();
  if (handle) {
    const matches = tweets.filter((t) => tweetHandle(t) === handle);
    if (matches.length === 1) return matches[0];
    if (matches.length > 0) {
      const rootHandle = tweets[0] ? tweetHandle(tweets[0]) : "";
      if (rootHandle && rootHandle !== handle) return matches[0];
    }
  }
  return tweets[0];
}

export function toCapture(url: string, extracted: PageExtract, extras: Partial<XCapture> = {}): XCapture {
  const tweets = extracted.tweets;
  const primary = selectPrimaryTweet(tweets, url);
  const authorHandle = primary?.handle;
  const authorPosts = tweets.filter(
    (t) => authorHandle && t.handle.toLowerCase() === authorHandle.toLowerCase(),
  );
  const kept = [
    ...(primary ? [primary] : []),
    ...tweets.filter((t) => t !== primary && replyAddsValue(t, authorHandle)),
  ];
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
    extracted.articleTitle ||
    primary?.text.split("\n")[0]?.slice(0, 120) ||
    extras.headline ||
    url;
  const bodyFromAuthor = (primary ? [primary, ...authorPosts.filter((t) => t !== primary)] : []).map(
    (t) => t.text,
  );
  const text =
    extracted.articleBody || bodyFromAuthor.filter(Boolean).join("\n\n") || extracted.pageText;
  const outbound = [...new Set(tweets.flatMap((t) => t.outbound))].slice(0, 3);
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
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const statusId = statusIdFromUrl(url);
    if (statusId) {
      await page
        .locator(`article[data-testid="tweet"] a[href*="/status/${statusId}"]`)
        .first()
        .waitFor({ timeout: 12_000 })
        .catch(() => undefined);
    } else {
      await page.waitForTimeout(2000);
    }
    await expandThread(page);
    let extracted = await extractPage(page, url);

    const empty = !extracted.tweets.length && !extracted.articleBody;
    const needsCua =
      config.cua === "always" ||
      (config.cua === "fallback" && (extracted.loginWall || empty || extracted.paywall));
    if (needsCua) {
      await runComputerUseFallback(page, url);
      await expandThread(page);
      extracted = await extractPage(page, url);
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

    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    const imageUrls = extracted.tweets.flatMap((t) => t.images);
    const images = await downloadImages(page, imageUrls);

    let linkedPage: XCapture["linkedPage"];
    const outbound = extracted.tweets.flatMap((t) => t.outbound)[0];
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
    if (!capture.text.trim() && !capture.posts.length) {
      capture.failure = {
        reason: "empty capture — page did not yield post or article text",
        headline: capture.headline,
      };
    }
    return capture;
  } finally {
    await page.close().catch(() => undefined);
    if (owned) await context.close().catch(() => undefined);
  }
}

export function createPlaywrightCaptureAdapter(config?: BrowserConfig): XCaptureAdapter {
  const cfg = config ?? loadBrowserConfig();
  let contextPromise: Promise<BrowserContext> | undefined;
  const getContext = () => {
    contextPromise ??= launchPersistentContext(cfg).catch((err) => {
      contextPromise = undefined;
      throw err;
    });
    return contextPromise;
  };
  return {
    capture: async (url) => {
      const context = await getContext();
      return captureXPage(url, { config: cfg, context });
    },
    close: async () => {
      const pending = contextPromise;
      contextPromise = undefined;
      if (!pending) return;
      const context = await pending.catch(() => undefined);
      await context?.close().catch(() => undefined);
    },
  };
}

export function browserProfilePath(config?: BrowserConfig): string {
  return path.resolve((config ?? loadBrowserConfig()).userDataDir);
}
