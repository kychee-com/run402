import { Router, Request, Response } from "express";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { S3_BUCKET, S3_REGION } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";
import { updateStorageBytes } from "../services/budget.js";

const router = Router();

// S3 client (only initialized if S3_BUCKET is set)
const s3 = S3_BUCKET
  ? new S3Client({ region: S3_REGION })
  : null;

// Fallback: local filesystem storage root
const LOCAL_STORAGE_ROOT = process.env.STORAGE_ROOT || "./storage";

// All storage routes require apikey
router.use("/storage/v1", apikeyAuth, meteringMiddleware);

// POST /storage/v1/object/:bucket/* — upload file
router.post("/storage/v1/object/:bucket/*", async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as any)[0] as string;
  const content = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const buffer = Buffer.from(content);

  try {
    if (s3 && S3_BUCKET) {
      const key = `${project.id}/${bucket}/${filePath}`;
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: req.headers["content-type"] || "application/octet-stream",
      }));
    } else {
      // Local filesystem fallback
      const storagePath = join(LOCAL_STORAGE_ROOT, project.id, bucket, filePath);
      mkdirSync(dirname(storagePath), { recursive: true });
      writeFileSync(storagePath, buffer);
    }

    await updateStorageBytes(project.id, buffer.length);

    console.log(`  Storage upload: ${bucket}/${filePath} (${buffer.length}B, project: ${project.id})`);
    res.json({ key: `${bucket}/${filePath}`, size: buffer.length });
  } catch (err: any) {
    console.error("Storage upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// GET /storage/v1/object/:bucket/* — download file
router.get("/storage/v1/object/:bucket/*", async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as any)[0] as string;

  try {
    if (s3 && S3_BUCKET) {
      const key = `${project.id}/${bucket}/${filePath}`;
      const obj = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }));
      res.set("Content-Type", obj.ContentType || "application/octet-stream");
      const body = await obj.Body!.transformToByteArray();
      res.send(Buffer.from(body));
    } else {
      const storagePath = join(LOCAL_STORAGE_ROOT, project.id, bucket, filePath);
      if (!existsSync(storagePath)) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const content = readFileSync(storagePath);
      res.set("Content-Type", "application/octet-stream");
      res.send(content);
    }
  } catch (err: any) {
    if (err.name === "NoSuchKey") {
      res.status(404).json({ error: "File not found" });
    } else {
      console.error("Storage download error:", err.message);
      res.status(500).json({ error: "Download failed" });
    }
  }
});

// DELETE /storage/v1/object/:bucket/* — delete file
router.delete("/storage/v1/object/:bucket/*", async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as any)[0] as string;

  try {
    if (s3 && S3_BUCKET) {
      const key = `${project.id}/${bucket}/${filePath}`;
      await s3.send(new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }));
    } else {
      const storagePath = join(LOCAL_STORAGE_ROOT, project.id, bucket, filePath);
      if (existsSync(storagePath)) {
        const stat = statSync(storagePath);
        unlinkSync(storagePath);
        await updateStorageBytes(project.id, -stat.size);
      }
    }

    console.log(`  Storage delete: ${bucket}/${filePath} (project: ${project.id})`);
    res.json({ status: "deleted", key: `${bucket}/${filePath}` });
  } catch (err: any) {
    console.error("Storage delete error:", err.message);
    res.status(500).json({ error: "Delete failed" });
  }
});

// POST /storage/v1/object/sign/:bucket/* — generate signed URL (S3 only)
router.post("/storage/v1/object/sign/:bucket/*", async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as any)[0] as string;

  if (!s3 || !S3_BUCKET) {
    // For local dev, return a direct URL
    res.json({
      signed_url: `/storage/v1/object/${bucket}/${filePath}`,
      expires_in: 3600,
      note: "Local storage — no signed URL needed",
    });
    return;
  }

  try {
    const key = `${project.id}/${bucket}/${filePath}`;
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      { expiresIn: 3600 },
    );

    res.json({ signed_url: signedUrl, expires_in: 3600 });
  } catch (err: any) {
    console.error("Signed URL error:", err.message);
    res.status(500).json({ error: "Failed to generate signed URL" });
  }
});

// GET /storage/v1/object/list/:bucket — list objects
router.get("/storage/v1/object/list/:bucket", async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;

  try {
    if (s3 && S3_BUCKET) {
      const prefix = `${project.id}/${bucket}/`;
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
      }));

      const objects = (result.Contents || []).map((obj) => ({
        key: obj.Key!.replace(prefix, ""),
        size: obj.Size,
        last_modified: obj.LastModified?.toISOString(),
      }));

      res.json({ objects });
    } else {
      // Local filesystem listing
      const dirPath = join(LOCAL_STORAGE_ROOT, project.id, bucket);
      if (!existsSync(dirPath)) {
        res.json({ objects: [] });
        return;
      }

      const objects: any[] = [];
      function walk(dir: string, prefix: string) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          const key = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(fullPath, key);
          } else {
            const stat = statSync(fullPath);
            objects.push({ key, size: stat.size, last_modified: stat.mtime.toISOString() });
          }
        }
      }
      walk(dirPath, "");
      res.json({ objects });
    }
  } catch (err: any) {
    console.error("Storage list error:", err.message);
    res.status(500).json({ error: "List failed" });
  }
});

export default router;
