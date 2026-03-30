import { chromium } from "playwright";
import type { InstagramPost } from "./types";

function extractJsonObjectAfterMarker(html: string, marker: string): unknown | null {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  const braceStart = html.indexOf("{", idx);
  if (braceStart === -1) return null;

  // Braces parsing with basic string/escape handling to avoid regex brittleness.
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonText = html.slice(braceStart, i + 1);
        return JSON.parse(jsonText);
      }
    }
  }

  return null;
}

function toPermalink(shortcode: string): string {
  return `https://www.instagram.com/p/${shortcode}/`;
}

export function extractLatestPostFromSharedData(data: any): InstagramPost | null {
  // Support both conventional _sharedData and GraphQL XHR intercept formats
  let edges = data?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges;

  if (!Array.isArray(edges)) {
    edges = data?.data?.user?.edge_owner_to_timeline_media?.edges;
  }
  if (!Array.isArray(edges)) {
    edges = data?.data?.user?.edge_web_feed_timeline?.edges;
  }

  if (!Array.isArray(edges) || edges.length === 0) return null;

  // Pinned posts sit at index 0-2. Sort all nodes by taken_at_timestamp descending to guarantee the chronologically latest post.
  const validNodes = edges
    .map((edge) => edge?.node)
    .filter((n) => n && typeof n.shortcode === "string");

  validNodes.sort((a, b) => {
    const timeA = Number(a.taken_at_timestamp) || 0;
    const timeB = Number(b.taken_at_timestamp) || 0;
    return timeB - timeA;
  });

  const node = validNodes[0];
  if (!node) return null;

  const shortcode = node.shortcode;

  let caption =
    node.edge_media_to_caption?.edges?.[0]?.node?.text ??
    node.caption?.text ??
    (typeof node.caption === "string" ? node.caption : undefined);

  // Instagram sometimes sticks its auto-generated alt-text in legacy fields
  if (caption && (caption.startsWith("Photo by ") || caption.includes("May be an image of "))) {
    caption = undefined;
  }

  const permalink = toPermalink(shortcode);

  // Prefer display_url (static images/carousels), fallback to thumbnail_src.
  let mediaUrl: string | undefined;

  const sidecarEdges = node.edge_sidecar_to_children?.edges;
  if (Array.isArray(sidecarEdges) && sidecarEdges.length > 0) {
    const firstChild = sidecarEdges[0]?.node;
    mediaUrl = firstChild?.display_url ?? firstChild?.thumbnail_src ?? node.thumbnail_src ?? undefined;
  } else {
    mediaUrl = node.display_url ?? node.thumbnail_src ?? node.thumbnail_resources?.[0]?.src ?? undefined;
  }

  return {
    shortcode,
    permalink,
    caption,
    mediaUrl,
    timestamp: node.taken_at_timestamp ? Number(node.taken_at_timestamp) : undefined,
  };
}

export async function fetchLatestInstagramPost(profileUrl: string): Promise<InstagramPost> {
  const isGitHubActions = Boolean(process.env.GITHUB_ACTIONS);

  const browser = await chromium.launch({
    headless: true,
    args: isGitHubActions ? ["--no-sandbox", "--disable-setuid-sandbox"] : undefined,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    });

    if (process.env.IG_SESSION_ID) {
      await context.addCookies([
        {
          name: "sessionid",
          value: process.env.IG_SESSION_ID,
          domain: ".instagram.com",
          path: "/",
        },
      ]);
    }

    const page = await context.newPage();

    // Attach response listener
    let graphqlData: any = null;
    page.on("response", async (response) => {
      if (response.url().includes("graphql/query") || response.url().includes("/api/v1/")) {
        try {
          const json = await response.json();
          if (json?.data?.user?.edge_owner_to_timeline_media?.edges?.length > 0) {
            graphqlData = json;
          } else if (json?.data?.user?.edge_web_feed_timeline?.edges?.length > 0) {
            graphqlData = json;
          }
        } catch (e) { }
      }
    });

    // Instagram can be picky; keep timeouts generous.
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Explicitly wait for posts to render in the DOM just to assure network activity
    await page.waitForSelector("a[href*='/p/']", { timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(2000);

    if (page.url().includes("/accounts/login/")) {
      throw new Error("SESSION_EXPIRED");
    }

    // Attempt to extract from DOM manually if GraphQL intercept failed
    let post: InstagramPost | null = null;

    if (graphqlData) {
      post = extractLatestPostFromSharedData(graphqlData);
    }

    // If intercept failed (perhaps it was baked into the HTML and didn't fire an XHR)
    if (!post) {
      const html = await page.content();
      const sharedData = extractJsonObjectAfterMarker(html, "window._sharedData =");
      post = sharedData ? extractLatestPostFromSharedData(sharedData) : null;

      // Fallback 2: Polaris embedded data
      if (!post) {
        const polarisData = extractJsonObjectAfterMarker(html, "\"edge_owner_to_timeline_media\":");
        if (polarisData) {
          // Mocks the structure
          post = extractLatestPostFromSharedData({ entry_data: { ProfilePage: [{ graphql: { user: { edge_owner_to_timeline_media: polarisData } } }] } });
        }
      }

      // Fallback 3: Pure DOM scraping
      if (!post) {
        post = await page.evaluate(() => {
          // Grab all post anchors
          const allLinks = Array.from(document.querySelectorAll("a[href*='/p/']"));

          // Filter out pinned posts (they usually enclose an SVG with a 'Pinned' or similar aria label/title)
          let targetLink = allLinks.find(link => {
            const hasAriaPin = link.querySelector("svg[aria-label='Pinned']");
            const hasTitlePin = Array.from(link.querySelectorAll("title")).some(t => t.textContent?.includes("Pinned"));
            return !hasAriaPin && !hasTitlePin;
          });

          // Fallback to first if all somehow look pinned or logic fails
          if (!targetLink) {
            targetLink = allLinks[0];
          }

          if (!targetLink) return null;
          console.log(targetLink);
          const img = targetLink.querySelector("img");
          let mediaUrl = img ? img.src : undefined;

          // Instagram sometimes uses picture > img or background-image
          if (!mediaUrl) {
            const alternateImg = targetLink.querySelector("img[crossorigin], img[decoding]");
            if (alternateImg) mediaUrl = (alternateImg as HTMLImageElement).src;
          }

          let caption = img ? img.alt : undefined;
          if (caption && (caption.startsWith("Photo by ") || caption.includes("May be an image of "))) {
            caption = undefined;
          }
          if (!caption) {
            const captionElement = document.querySelector("h1, ._a9zs, ._a9zt, ._a9zc");
            if (captionElement) caption = captionElement.textContent || undefined;
          }

          const href = (targetLink as HTMLAnchorElement).href;

          const shortcodeMatch = href.match(/\/p\/([^/]+)/);
          const shortcode = shortcodeMatch ? shortcodeMatch[1] : `unknown_${Date.now()}`;

          return {
            shortcode,
            permalink: href,
            caption,
            mediaUrl,
            timestamp: Date.now()
          };
        });
      }
    }

    if (!post) {
      // Helps debugging when HTML layout changes.
      await page.screenshot({ path: "debug.png" });
      throw new Error("Could not extract latest post from shared data, intercept, or DOM.");
    }

    return post;
  } finally {
    await browser.close().catch(() => { });
  }
}

