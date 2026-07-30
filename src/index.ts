import fs from "node:fs";
import path from "node:path";
import type { InstagramPost, ProfileConfig } from "./types";
import { fetchRecentInstagramPosts } from "./instagram";
import { readState, writeState, ensureAccountState } from "./state";
import { sendDiscordNotification, sendDiscordDM, sendDiscordAdminAlert } from "./discord";
import { accountProcessors } from "./processors";

type ProfilesFile = {
  accounts: ProfileConfig[];
};

function truncate(s: string, max: number): string {
  const str = s ?? "";
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + "…";
}

function getProfilesConfig(): ProfileConfig[] {
  const watchListStr = process.env.IG_WATCH_LIST;
  if (!watchListStr) {
    console.warn("IG_WATCH_LIST is not defined. Set it as 'id1:username1, id2:username2'.");
    return [];
  }

  return watchListStr.split(',').map(pair => {
    const parts = pair.split(':');
    const id = parts[0].trim();
    const username = parts.length > 1 ? parts[1].trim() : id;
    const allowedTypes = (parts.length > 2 ? parts[2].trim().toLowerCase() : "posts") as "posts" | "reels" | "both";

    return {
      id,
      username,
      profileUrl: `https://www.instagram.com/${username}/`,
      allowedTypes
    };
  });
}

async function main(): Promise<void> {
  const profiles = getProfilesConfig();
  if (profiles.length === 0) {
    console.error("No profiles configured.");
    return;
  }

  const state = readState();
  let stateChanged = false;

  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const discordAdminUser = process.env.DISCORD_ADMIN_USER_ID;
  const discordTargetUserIds = process.env.DISCORD_TARGET_USER_ID
    ? process.env.DISCORD_TARGET_USER_ID.split(',').map(id => id.trim()).filter(Boolean)
    : [];
  const notifyOnFirstRun = process.env.NOTIFY_ON_FIRST_RUN === "true";

  for (const profile of profiles) {
    const accountKey = profile.id;
    const displayUsername = profile.username;

    ensureAccountState(state, accountKey);

    console.log(`Checking profile ID: ${accountKey}...`);

    const lastShortcode = state.accounts[accountKey]?.lastShortcode ?? null;
    let recentPosts: InstagramPost[] = [];
    try {
      recentPosts = await fetchRecentInstagramPosts(profile.profileUrl, lastShortcode, profile.allowedTypes);
    } catch (err) {
      console.error(`Failed to fetch latest posts for ID: ${accountKey}:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      if (discordBotToken && discordAdminUser) {
        console.log("Triggering admin alert for session expiration...");
        try {
          await sendDiscordAdminAlert({
            botToken: discordBotToken,
            targetUserId: discordAdminUser,
            message: "**Action Required**: Failed to poll recent post. Perhaps session key expired."
          });
        } catch (alertErr) { }
        break;
      }
      throw err;
    }

    if (recentPosts.length === 0) continue;

    const isFirstRun = lastShortcode === null;

    let newPosts: InstagramPost[] = [];
    if (isFirstRun) {
      newPosts = [recentPosts[0]];
    } else {
      const lastIndex = recentPosts.findIndex(p => p.shortcode === lastShortcode);
      if (lastIndex === 0) {
        console.log(`No new post for ID: ${accountKey} (latest: ${lastShortcode}).`);
        continue;
      } else if (lastIndex === -1) {
        // Did not find old post in top 5. They posted 6+ times. Notify on all 5.
        newPosts = [...recentPosts];
      } else {
        newPosts = recentPosts.slice(0, lastIndex);
      }
    }

    // Process posts chronologically (oldest of the new batch first)
    newPosts.reverse();

    for (const post of newPosts) {
      const processor = accountProcessors[accountKey] || accountProcessors["default"];
      const result = processor(post);

      if (result.action === "skip") {
        console.log(`[Account ${accountKey}] Skipped post ${post.shortcode}: ${result.skipReason}`);
        continue;
      }
      
      const processedPost = result.post;

      if (!isFirstRun || notifyOnFirstRun) {
        let notifiedViaWebhook = false;
        let notifiedViaDM = false;

        const postPayload = {
          ...processedPost,
          caption: processedPost.caption ? truncate(processedPost.caption, 1900) : processedPost.caption,
        };

        const shouldNotifyWebhook = result.notifyWebhook ?? true;
        if (shouldNotifyWebhook && discordWebhookUrl) {
          try {
            await sendDiscordNotification({
              webhookUrl: discordWebhookUrl,
              username: displayUsername,
              post: postPayload,
              discordConfig: result.discordConfig
            });
            notifiedViaWebhook = true;
          } catch (err) {
            console.error(`Discord webhook failed for ID: ${accountKey}:`, err);
          }
        }

        const shouldNotifyDM = result.notifyDM ?? true;
        if (shouldNotifyDM && discordBotToken && discordTargetUserIds.length > 0) {
          for (const targetUserId of discordTargetUserIds) {
            try {
              await sendDiscordDM({
                botToken: discordBotToken,
                targetUserId: targetUserId,
                username: displayUsername,
                post: postPayload,
                discordConfig: result.discordConfig
              });
              notifiedViaDM = true;
            } catch (err) {
              console.error(`Discord DM failed for target user ${targetUserId} on ID: ${accountKey}:`, err);
            }
          }
        }

        const notifyMethods: string[] = [];
        if (notifiedViaWebhook) notifyMethods.push("webhook");
        if (notifiedViaDM) notifyMethods.push("DM");

        if (notifyMethods.length > 0) {
          console.log(`Discord notified (${notifyMethods.join(" and ")}) for ID: ${accountKey} (${post.shortcode}).`);
        } else if (!discordWebhookUrl && !(discordBotToken && discordTargetUserIds.length > 0)) {
          console.log("No Discord notification methods configured.");
        }
      } else {
        console.log(`First run for ID: ${accountKey}; NOTIFY_ON_FIRST_RUN=false so skipping notify for ${post.shortcode}.`);
      }
    }

    // Update state to the absolute newest post
    state.accounts[accountKey] = {
      ...state.accounts[accountKey],
      lastShortcode: recentPosts[0].shortcode,
      lastNotifiedAt: new Date().toISOString(),
    };
    stateChanged = true;
  }

  if (stateChanged) {
    writeState(state);
    console.log("state.json updated.");
  } else {
    console.log("No state changes detected.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

