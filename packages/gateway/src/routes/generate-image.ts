import { Router, Request, Response } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { HttpError } from "../utils/async-handler.js";
import { generateImage, ImageGenerationError, ALLOWED_ASPECTS } from "../services/generate-image.js";

const router = Router();

router.get("/generate-image/v1", (_req: Request, res: Response) => {
  res.json({
    description: "Generate an image from a text prompt",
    price: "$0.03",
    method: "POST",
    body: {
      prompt: "string (required, max 1000 chars)",
      aspect: `string (optional, one of: ${[...ALLOWED_ASPECTS].join(", ")}; default: square)`,
    },
  });
});

router.post(
  "/generate-image/v1",
  asyncHandler(async (req: Request, res: Response) => {
    const { prompt, aspect } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new HttpError(400, "prompt is required");
    }
    if (prompt.length > 1000) {
      throw new HttpError(400, "prompt must be 1000 characters or less");
    }
    const resolvedAspect = aspect || "square";
    if (!ALLOWED_ASPECTS.has(resolvedAspect)) {
      throw new HttpError(400, `invalid aspect, must be one of: ${[...ALLOWED_ASPECTS].join(", ")}`);
    }

    try {
      const result = await generateImage(prompt.trim(), resolvedAspect);
      res.json(result);
    } catch (err) {
      if (err instanceof ImageGenerationError) {
        throw new HttpError(err.statusCode, err.message);
      }
      throw err;
    }
  }),
);

export default router;
