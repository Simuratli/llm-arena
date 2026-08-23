"use client";

import { useUser } from "@clerk/nextjs";
import { useEffect } from "react";
import posthog from "posthog-js";

export function PostHogUser() {
  const { isLoaded, user } = useUser();

  useEffect(() => {
    if (!isLoaded || !user) {
      return;
    }

    posthog.identify(user.id, {
      email: user.primaryEmailAddress?.emailAddress,
    });
  }, [isLoaded, user]);

  return null;
}
