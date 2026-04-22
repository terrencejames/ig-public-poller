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

export function extractRecentPostsFromSharedData(data: any, limit: number = 5): InstagramPost[] {
  // Support both conventional _sharedData and GraphQL XHR intercept formats
  let edges = data?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges;

  if (!Array.isArray(edges)) {
    edges = data?.data?.user?.edge_owner_to_timeline_media?.edges;
  }
  if (!Array.isArray(edges)) {
    edges = data?.data?.user?.edge_web_feed_timeline?.edges;
  }

  if (!Array.isArray(edges) || edges.length === 0) return [];

  // Pinned posts sit at index 0-2. Sort all nodes by taken_at_timestamp descending to guarantee the chronologically latest post.
  const validNodes = edges
    .map((edge) => edge?.node)
    .filter((n) => n && typeof n.shortcode === "string");

  validNodes.sort((a, b) => {
    const timeA = Number(a.taken_at_timestamp) || 0;
    const timeB = Number(b.taken_at_timestamp) || 0;
    return timeB - timeA;
  });

  return validNodes.slice(0, limit).map(node => {
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
  });
}

export async function fetchRecentInstagramPosts(profileUrl: string, lastKnownShortcode?: string | null): Promise<InstagramPost[]> {
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

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);

    if (page.url().includes("/accounts/login/")) {
      throw new Error("SESSION_EXPIRED");
    }

    let posts: InstagramPost[] = [];
    if (graphqlData) {
      posts = extractRecentPostsFromSharedData(graphqlData, 5);
    }

    if (posts.length === 0) {
      const html = await page.content();
      const sharedData = extractJsonObjectAfterMarker(html, "window._sharedData =");
      posts = sharedData ? extractRecentPostsFromSharedData(sharedData, 5) : [];

      if (posts.length === 0) {
        const polarisData = extractJsonObjectAfterMarker(html, "\"edge_owner_to_timeline_media\":");
        if (polarisData) {
          posts = extractRecentPostsFromSharedData({ entry_data: { ProfilePage: [{ graphql: { user: { edge_owner_to_timeline_media: polarisData } } }] } }, 5);
        }
      }
    }

    // If we still have no posts via JSON, use DOM scan with pinned post filtering
    if (posts.length === 0) {
      posts = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll("a[href*='/p/']"));

        // Filter out pinned posts
        let targetLinks = allLinks.filter(link => {
          const hasAriaPin = link.querySelector("svg[aria-label='Pinned']");
          const hasTitlePin = Array.from(link.querySelectorAll("title")).some(t => t.textContent?.includes("Pinned"));
          return !hasAriaPin && !hasTitlePin;
        });

        if (targetLinks.length === 0) {
          targetLinks = allLinks;
        }

        return targetLinks.slice(0, 5).map(link => {
          const href = (link as HTMLAnchorElement).href;
          const shortcodeMatch = href.match(/\/p\/([^/]+)/);
          const img = link.querySelector("img");
          return {
            shortcode: shortcodeMatch ? shortcodeMatch[1] : "",
            permalink: href,
            mediaUrl: img ? img.src : undefined,
            timestamp: Date.now()
          };
        }).filter(p => p.shortcode);
      });
    }

    if (posts.length === 0) {
      await page.screenshot({ path: "debug.png" });
      throw new Error("Could not extract recent posts.");
    }

    // Determine which posts are new and need full captions
    const newPosts = lastKnownShortcode 
      ? posts.filter(p => p.shortcode !== lastKnownShortcode).slice(0, posts.findIndex(p => p.shortcode === lastKnownShortcode))
      : [posts[0]];

    // If lastKnownShortcode wasn't found in the first 5, process all 5
    const postsToEnrich = newPosts.length === 0 && lastKnownShortcode && !posts.some(p => p.shortcode === lastKnownShortcode)
      ? posts
      : newPosts;

    for (const post of postsToEnrich) {
      try {
        console.log(`Enriching post: ${post.shortcode}...`);
        await page.goto(post.permalink, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(1500);
        
        const enriched = await page.evaluate(() => {
          // Extract caption
          const captionSelectors = [
            "div > span > div > span",
            "h1",
            "div._a9zs",
            "div._a9zt"
          ];
          let caption: string | null = null;
          for (const sel of captionSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent && el.textContent.length > 5) {
              caption = el.textContent;
              break;
            }
          }

          // Extract image from the detail page
          const imgSelectors = [
            "article img[src*='instagram']",
            "article img[crossorigin]",
            "div[role='presentation'] img",
            "img[decoding='auto']",
            "article img"
          ];
          let mediaUrl: string | null = null;
          for (const sel of imgSelectors) {
            const el = document.querySelector(sel) as HTMLImageElement | null;
            if (el?.src && !el.src.includes('s150x150')) {
              mediaUrl = el.src;
              break;
            }
          }

          return { caption, mediaUrl };
        });

        if (enriched.caption) {
          post.caption = enriched.caption;
        }
        if (enriched.mediaUrl) {
          post.mediaUrl = enriched.mediaUrl;
        }
      } catch (err) {
        console.error(`Failed to enrich post ${post.shortcode}:`, err);
      }
    }

    return posts;
  } finally {
    await browser.close().catch(() => { });
  }
}

