#!/usr/bin/env node
/**
 * Build site: injects llms.txt into index.html as a <template> tag.
 *
 * Reads site/index.html and site/llms.txt, injects the llms.txt content
 * (HTML-escaped) inside <template id="llms-txt"> before </body>,
 * writes everything to site-dist/.
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const siteDir = join(root, "site");
const outDir = join(root, "site-dist");

// Clean + copy entire site/ → site-dist/
mkdirSync(outDir, { recursive: true });
cpSync(siteDir, outDir, { recursive: true });

// Read sources
const html = readFileSync(join(siteDir, "index.html"), "utf-8");
const llmsTxt = readFileSync(join(siteDir, "llms.txt"), "utf-8");

// HTML-escape so the content survives HTML parsing intact
const escaped = llmsTxt
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const template = `<template id="llms-txt">${escaped}</template>`;

// Inject before </body>
const output = html.replace("</body>", `${template}\n</body>`);

writeFileSync(join(outDir, "index.html"), output);

const kb = (Buffer.byteLength(output) / 1024).toFixed(1);
console.log(`site-dist/index.html: ${kb} KB (llms.txt injected as <template>)`);
