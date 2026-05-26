// license GPL Jonas Immanuel Frey
import { join, extname } from "jsr:@std/path@1";
import { ensureDir } from "jsr:@std/fs@1";

const PORT = parseInt(Deno.env.get("PORT") || "3456");
const dir = import.meta.dirname;
if (!dir) throw new Error("Cannot determine script directory");
const STATIC_ROOT: string = dir;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

function ext(path: string): string {
  const e = extname(path).toLowerCase();
  // Deno 2.7 extname returns empty for files like ".gitignore" — treat leading-dot files correctly
  if (!e && path.startsWith(".")) return path;
  return e;
}

function mime(path: string): string {
  return MIME[ext(path)] || "application/octet-stream";
}

async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let filePath = join(STATIC_ROOT, url.pathname === "/" ? "index.html" : url.pathname);

  // Prevent directory traversal
  if (!filePath.startsWith(STATIC_ROOT)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const stat = await Deno.stat(filePath);
    if (stat.isDirectory) {
      filePath = join(filePath, "index.html");
      await Deno.stat(filePath); // throws if doesn't exist
    }
    const body = await Deno.readFile(filePath);
    return new Response(body, {
      headers: { "content-type": mime(filePath), "cache-control": "no-cache" },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// ---- API: Extract frames via ffmpeg ----

interface ExtractRequest {
  timestamps: number[];
}

interface ExtractedFrame {
  dataURL: string;
  width: number;
  height: number;
  timestamp: number;
}

async function handleExtractFrames(req: Request): Promise<Response> {
  let videoPath: string | null = null;

  try {
    const form = await req.formData();
    const videoFile = form.get("video");
    const timestampsRaw = form.get("timestamps");

    if (!(videoFile instanceof File)) {
      return json({ error: "Missing video file" }, 400);
    }

    let timestamps: number[];
    try {
      timestamps = JSON.parse(timestampsRaw as string);
      if (!Array.isArray(timestamps) || timestamps.length === 0) {
        return json({ error: "timestamps must be a non-empty array of seconds" }, 400);
      }
    } catch {
      return json({ error: "Invalid timestamps JSON" }, 400);
    }

    // Write video to temp file
    const tmpDir = join(STATIC_ROOT, ".tmp");
    await ensureDir(tmpDir);
    const videoExt = videoFile.name.includes(".") ? `.${videoFile.name.split(".").pop()}` : ".mp4";
    videoPath = join(tmpDir, `upload_${crypto.randomUUID()}${videoExt}`);
    await Deno.writeFile(videoPath, new Uint8Array(await videoFile.arrayBuffer()));

    // Get video dimensions via ffprobe
    let width = 0;
    let height = 0;
    try {
      const probe = new Deno.Command("ffprobe", {
        args: [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height",
          "-of", "csv=p=0",
          videoPath,
        ],
        stdout: "piped",
        stderr: "piped",
      });
      const out = new TextDecoder().decode((await probe.output()).stdout).trim();
      const [w, h] = out.split(",").map(Number);
      if (w && h) { width = w; height = h; }
    } catch {
      // fall back to 0, caller can check
    }

    // Extract each frame
    const frames: ExtractedFrame[] = [];

    for (const ts of timestamps) {
      const cmd = new Deno.Command("ffmpeg", {
        args: [
          "-ss", ts.toString(),
          "-i", videoPath,
          "-vframes", "1",
          "-f", "image2pipe",
          "-vcodec", "mjpeg",
          "-q:v", "2",
          "-",
        ],
        stdout: "piped",
        stderr: "piped",
      });

      const output = await cmd.output();
      if (!output.success) {
        const errText = new TextDecoder().decode(output.stderr);
        console.error(`ffmpeg failed for timestamp ${ts}: ${errText}`);
        continue;
      }

      const jpegBytes = output.stdout;
      const base64 = btoa(String.fromCharCode(...jpegBytes));
      frames.push({
        dataURL: `data:image/jpeg;base64,${base64}`,
        width,
        height,
        timestamp: ts,
      });

      if (width === 0 || height === 0) {
        // Try to read dimensions from the JPEG (simple SOF0 parser)
        const dims = parseJpegDimensions(jpegBytes);
        if (dims) {
          width = dims.w;
          height = dims.h;
          frames[frames.length - 1].width = width;
          frames[frames.length - 1].height = height;
        }
      }
    }

    return json({ frames });
  } catch (err) {
    console.error("extract-frames error:", err);
    return json({ error: "Internal server error" }, 500);
  } finally {
    // Cleanup temp video
    if (videoPath) {
      try { await Deno.remove(videoPath); } catch { /* ok */ }
    }
  }
}

function parseJpegDimensions(buf: Uint8Array): { w: number; h: number } | null {
  // Walk JPEG markers to find SOF0 (0xFF 0xC0)
  let i = 2; // skip SOI marker (0xFF 0xD8)
  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      // SOF0/SOF1/SOF2: after marker, skip length (2), precision (1), then height (2), width (2)
      if (i + 9 >= buf.length) return null;
      const h = (buf[i + 5] << 8) | buf[i + 6];
      const w = (buf[i + 7] << 8) | buf[i + 8];
      return { w, h };
    }
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; } // SOI/EOI — no length
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; } // no length
    // Read segment length and skip
    const len = (buf[i + 2] << 8) | buf[i + 3];
    i += 2 + len;
  }
  return null;
}

// ---- Health check ----

async function handleHealth(): Promise<Response> {
  let ffmpegAvailable = false;
  try {
    const cmd = new Deno.Command("ffmpeg", { args: ["-version"], stdout: "null", stderr: "null" });
    ffmpegAvailable = (await cmd.output()).success;
  } catch { /* unavailable */ }

  return json({ status: "ok", ffmpeg: ffmpegAvailable });
}

// ---- Helpers ----

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return origin
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" }
    : {};
}

// ---- CDN proxy (cross-origin worker workaround) ----

let gifWorkerScript: ArrayBuffer | null = null;

async function handleGifWorker(): Promise<Response> {
  if (!gifWorkerScript) {
    const resp = await fetch("https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js");
    if (!resp.ok) return new Response("Worker script not found", { status: 502 });
    gifWorkerScript = await resp.arrayBuffer();
  }
  return new Response(gifWorkerScript, {
    headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}

// ---- Router ----

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // API routes
  if (url.pathname === "/api/health") {
    return addCors(await handleHealth(), req);
  }

  if (url.pathname === "/api/extract-frames" && req.method === "POST") {
    return addCors(await handleExtractFrames(req), req);
  }

  // Proxy gif.worker.js to avoid cross-origin Worker restriction
  if (url.pathname === "/lib/gif.worker.js") {
    return handleGifWorker();
  }

  // Static files
  return serveStatic(req);
}

function addCors(res: Response, req: Request): Response {
  const headers = corsHeaders(req);
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

// ---- Startup ----

console.log(`Stop Motion Maker server starting on http://localhost:${PORT}`);

// Ensure tmp dir exists
try { await ensureDir(join(STATIC_ROOT, ".tmp")); } catch { /* ok */ }

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, handler);
