import { PostHog } from "posthog-node";

export type ServerEvent = {
  distinctId: string;
  event: string;
  properties?: Record<string, string | number | boolean>;
};

export async function captureServerEvent({ distinctId, event, properties }: ServerEvent) {
  const apiKey = process.env.POSTHOG_API_KEY;

  if (!apiKey) {
    return;
  }

  const client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });

  client.capture({ distinctId, event, properties });
  await client.shutdown();
}
