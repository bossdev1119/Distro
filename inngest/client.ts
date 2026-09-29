import { eventType, Inngest } from "inngest";
import { z } from "zod";

export const inngest = new Inngest({ id: "distro" });

export const startupCreatedData = z.object({ startupId: z.uuid() });
export const startupCreated = eventType("startup.created", { schema: startupCreatedData });

export const profileConfirmed = eventType("profile.confirmed", {
  schema: z.object({ startupId: z.uuid(), userId: z.uuid() }),
});
