import fs from "node:fs";
import path from "node:path";
import type { InstagramPost, ProfileConfig } from "./types";
import { fetchLatestInstagramPost } from "./instagram";
import { readState, writeState, ensureAccountState } from "./state";
import { sendDiscordNotification, sendDiscordDM, sendDiscordAdminAlert } from "./discord";

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
    // Use the explicit username mapped to the ID, or fallback to the ID if it wasn't mapped
    const username = parts.length > 1 ? parts[1].trim() : id;

    return {
      id,
      username,
      profileUrl: `https://www.instagram.com/${username}/`
    };
  });
}

async function main(): Promise<void> {
  const profiles = getProfilesConfig();
  if (profiles.length === 0) {
    console.error("No profiles configured in profiles.json");
    return;
  }

  const state = readState();
  let stateChanged = false;

  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const discordTargetUserIds = process.env.DISCORD_TARGET_USER_ID
    ? process.env.DISCORD_TARGET_USER_ID.split(',').map(id => id.trim()).filter(Boolean)
    : [];
  const notifyOnFirstRun = process.env.NOTIFY_ON_FIRST_RUN === "true";

  for (const profile of profiles) {
    const accountKey = profile.id;
    const displayUsername = profile.username;
    
    ensureAccountState(state, accountKey);

    console.log(`Checking @${displayUsername} (ID: ${accountKey})...`);

    let latest: InstagramPost | null = null;
    try {
      latest = await fetchLatestInstagramPost(profile.profileUrl);
    } catch (err) {
      console.error(`Failed to fetch latest post for @${displayUsername}:`, err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "SESSION_EXPIRED" && discordBotToken && discordTargetUserIds.length > 0) {
        console.log("Triggering admin alert for session expiration...");
        for (const targetUserId of discordTargetUserIds) {
          try {
            await sendDiscordAdminAlert({
              botToken: discordBotToken,
              targetUserId,
              message: "⚠️ **Action Required**: Instagram Session ID has expired or is invalid! Please log into Instagram, copy a fresh `sessionid` cookie, and update your configuration."
            });
          } catch (alertErr) {
            console.error(`Failed to send admin alert to ${targetUserId}:`, alertErr);
          }
        }
        break; // Stop processing further profiles since the session is globally invalid.
      }
      continue;
    }
    const currentShortcode = latest.shortcode;
    const lastShortcode = state.accounts[accountKey]?.lastShortcode ?? null;

    if (lastShortcode === currentShortcode) {
      console.log(`No new post for @${displayUsername} (latest: ${currentShortcode}).`);
      continue;
    }

    const isFirstRun = lastShortcode === null;

    // Update state even if first run (prevents repeated notifications once enabled).
    state.accounts[accountKey] = {
      ...state.accounts[accountKey],
      lastShortcode: currentShortcode,
      lastNotifiedAt: new Date().toISOString(),
    };
    stateChanged = true;

    if (!isFirstRun || notifyOnFirstRun) {
      let notifiedViaWebhook = false;
      let notifiedViaDM = false;

      const postPayload = {
        ...latest,
        caption: latest.caption ? truncate(latest.caption, 1900) : latest.caption,
      };

      if (discordWebhookUrl) {
        try {
          await sendDiscordNotification({
            webhookUrl: discordWebhookUrl,
            username: displayUsername,
            post: postPayload,
          });
          notifiedViaWebhook = true;
        } catch (err) {
          console.error(`Discord webhook notification failed for @${displayUsername}:`, err);
        }
      }

      if (discordBotToken && discordTargetUserIds.length > 0) {
        for (const targetUserId of discordTargetUserIds) {
          try {
            await sendDiscordDM({
              botToken: discordBotToken,
              targetUserId: targetUserId,
              username: displayUsername,
              post: postPayload,
            });
            notifiedViaDM = true;
          } catch (err) {
            console.error(`Discord DM notification failed for target user ${targetUserId} on @${displayUsername}:`, err);
          }
        }
      }

      const notifyMethods: string[] = [];
      if (notifiedViaWebhook) notifyMethods.push("webhook");
      if (notifiedViaDM) notifyMethods.push("DM");

      if (notifyMethods.length > 0) {
        console.log(`Discord notified (${notifyMethods.join(" and ")}) for @${displayUsername} (${currentShortcode}).`);
      } else if (!discordWebhookUrl && !(discordBotToken && discordTargetUserIds.length > 0)) {
        console.log("No Discord notification methods configured; skipping Discord notification.");
      }
    } else {
      console.log(`First run for @${displayUsername}; NOTIFY_ON_FIRST_RUN=false so skipping notify.`);
    }
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

