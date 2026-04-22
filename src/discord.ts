import type { InstagramPost } from "./types";

function truncate(s: string, max: number): string {
  const str = s ?? "";
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + "…";
}

export async function sendDiscordNotification(params: {
  webhookUrl: string;
  username: string;
  post: InstagramPost;
}): Promise<void> {
  const { webhookUrl, username, post } = params;

  const caption = post.caption?.trim() ?? "";
  const permalink = post.permalink;

  const embed: Record<string, unknown> = {
    title: `New deal alert!!!`,
    url: permalink,
    description: caption ? `[${truncate(caption, 4000)}](${permalink})` : undefined,
    timestamp: new Date().toISOString(),
  };

  const payload: any = {
    content: `New deal alert!!!`,
    embeds: [embed],
  };

  let imageBlob: Blob | null = null;
  if (post.mediaUrl) {
    try {
      const imgRes = await fetch(post.mediaUrl);
      if (imgRes.ok) {
        imageBlob = await imgRes.blob();
        embed.image = { url: "attachment://image.jpg" };
      }
    } catch (err) {
      console.error("Failed to download image for webhook:", err);
    }
  }

  let bodyData: any;
  const headers: Record<string, string> = {};

  if (imageBlob) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", imageBlob, "image.jpg");
    bodyData = form;
  } else {
    headers["content-type"] = "application/json";
    bodyData = JSON.stringify(payload);
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: bodyData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  }
}

export async function sendDiscordDM(params: {
  botToken: string;
  targetUserId: string;
  username: string;
  post: InstagramPost;
}): Promise<void> {
  const { botToken, targetUserId, username, post } = params;

  const caption = post.caption?.trim() ?? "";
  const embedTitle = "New deal alert for " + caption.substring(0, caption.indexOf(" ")); // extract the first word, which is usually the name of the place
  const permalink = post.permalink;

  const embed: Record<string, unknown> = {
    title: embedTitle,
    url: permalink,
    description: caption ? `[${truncate(caption, 4000)}](${permalink})` : undefined,
    timestamp: new Date().toISOString(),
  };

  const payload: any = {
    embeds: [embed],
  };

  let imageBlob: Blob | null = null;
  if (post.mediaUrl) {
    try {
      const imgRes = await fetch(post.mediaUrl);
      if (imgRes.ok) {
        imageBlob = await imgRes.blob();
        embed.image = { url: "attachment://image.jpg" };
      }
    } catch (err) {
      console.error("Failed to download image for DM:", err);
    }
  }

  // 1. Get DM channel
  const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      "Authorization": `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ recipient_id: targetUserId }),
  });

  if (!dmRes.ok) {
    const text = await dmRes.text().catch(() => "");
    throw new Error(`Failed to create Discord DM channel: ${dmRes.status} ${text}`);
  }

  const dmData = await dmRes.json() as { id: string };
  const channelId = dmData.id;

  // 2. Send message
  let bodyData: any;
  const reqHeaders: Record<string, string> = { "Authorization": `Bot ${botToken}` };

  if (imageBlob) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", imageBlob, "image.jpg");
    bodyData = form;
  } else {
    reqHeaders["Content-Type"] = "application/json";
    bodyData = JSON.stringify(payload);
  }

  const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: reqHeaders,
    body: bodyData,
  });

  if (!msgRes.ok) {
    const text = await msgRes.text().catch(() => "");
    throw new Error(`Failed to send Discord DM: ${msgRes.status} ${text}`);
  }
}

export async function sendDiscordAdminAlert(params: {
  botToken: string;
  targetUserId: string;
  message: string;
}): Promise<void> {
  const { botToken, targetUserId, message } = params;

  // 1. Get DM channel
  const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      "Authorization": `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ recipient_id: targetUserId }),
  });

  if (!dmRes.ok) {
    const text = await dmRes.text().catch(() => "");
    throw new Error(`Failed to create Discord DM channel for admin alert: ${dmRes.status} ${text}`);
  }

  const dmData = await dmRes.json() as { id: string };
  const channelId = dmData.id;

  // 2. Send message
  const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content: message }),
  });

  if (!msgRes.ok) {
    const text = await msgRes.text().catch(() => "");
    throw new Error(`Failed to send Discord Admin Alert: ${msgRes.status} ${text}`);
  }
}

