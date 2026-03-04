import { Router, Request, Response } from "express";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { S3_BUCKET, S3_REGION } from "../config.js";
import { apikeyAuth } from "../middleware/apikey.js";
import { meteringMiddleware } from "../middleware/metering.js";
import { updateStorageBytes } from "../services/budget.js";
import { hasName } from "../utils/errors.js";
import { asyncHandler, HttpError } from "../utils/async-handler.js";

interface StorageObject {
  key: string;
  size: number;
  last_modified: string;
}

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
router.post("/storage/v1/object/:bucket/*", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as Record<string, string>)[0];
  const content = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const buffer = Buffer.from(content);

  if (s3 && S3_BUCKET) {
    const key = `${project.id}/${bucket}/${filePath}`;
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: req.headers["content-type"] || "application/octet-stream",
    }));
  } else {
    const storagePath = join(LOCAL_STORAGE_ROOT, project.id, bucket, filePath);
    mkdirSync(dirname(storagePath), { recursive: true });
    writeFileSync(storagePath, buffer);
  }

  await updateStorageBytes(project.id, buffer.length);

  console.log(`  Storage upload: ${bucket}/${filePath} (${buffer.length}B, project: ${project.id})`);
  res.json({ key: `${bucket}/${filePath}`, size: buffer.length });
}));

// GET /storage/v1/object/:bucket/* — download file
router.get("/storage/v1/object/:bucket/*", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as Record<string, string>)[0];

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
        throw new HttpError(404, "File not found");
      }
      const fileContent = readFileSync(storagePath);
      res.set("Content-Type", "application/octet-stream");
      res.send(fileContent);
    }
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    if (hasName(err, "NoSuchKey")) throw new HttpError(404, "File not found");
    throw err;
  }
}));

// DELETE /storage/v1/object/:bucket/* — delete file
router.delete("/storage/v1/object/:bucket/*", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as Record<string, string>)[0];

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
}));

// POST /storage/v1/object/sign/:bucket/* — generate signed URL (S3 only)
router.post("/storage/v1/object/sign/:bucket/*", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;
  const filePath = (req.params as Record<string, string>)[0];

  if (!s3 || !S3_BUCKET) {
    res.json({
      signed_url: `/storage/v1/object/${bucket}/${filePath}`,
      expires_in: 3600,
      note: "Local storage — no signed URL needed",
    });
    return;
  }

  const key = `${project.id}/${bucket}/${filePath}`;
  const signedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: 3600 },
  );

  res.json({ signed_url: signedUrl, expires_in: 3600 });
}));

// GET /storage/v1/object/list/:bucket — list objects
router.get("/storage/v1/object/list/:bucket", asyncHandler(async (req: Request, res: Response) => {
  const project = req.project!;
  const bucket = req.params["bucket"] as string;

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
    const dirPath = join(LOCAL_STORAGE_ROOT, project.id, bucket);
    if (!existsSync(dirPath)) {
      res.json({ objects: [] });
      return;
    }

    const objects: StorageObject[] = [];
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
}));

export default router;
