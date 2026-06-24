import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { z } from "astro/zod";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // Consumed by scripts/build-agent-flat-docs.mjs to order pages within an
        // agent bundle (cli/sdk/mcp) when generating the flat llms-*.txt files.
        // Not used by Starlight's own sidebar ordering.
        order: z.number().optional(),
      }),
    }),
  }),
};
