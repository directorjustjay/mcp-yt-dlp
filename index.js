
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  randomUUID,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import express from "express";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const MCP_API_TOKEN = process.env.MCP_API_TOKEN;

if (!MCP_API_TOKEN || MCP_API_TOKEN.length < 32) {
  throw new Error(
    "Set MCP_API_TOKEN in Railway Variables to a random secret of at least 32 characters."
  );
}

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

const DOWNLOADS_DIR =
  process.env.DOWNLOADS_DIR || "/app/downloads";

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, "");

const DOWNLOADS_TTL_MS =
  (Number(process.env.DOWNLOADS_TTL_MINUTES) || 120)
  * 60 * 1000;

const YTDLP_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const MAX_BUFFER = 32 * 1024 * 1024;

const EXTRA_ARGS = (
  process.env.YTDLP_EXTRA_ARGS ??
  "--extractor-args youtube:player_client=tv_embedded,web_embedded,tv,mweb"
).trim().split(/\s+/).filter(Boolean);

mkdirSync(DOWNLOADS_DIR, { recursive: true });

// =====================================================
// SECURITY
// =====================================================

function secureEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));

  return (
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function signDownload(filename, expires) {
  return createHmac("sha256", MCP_API_TOKEN)
    .update(`${filename}:${expires}`)
    .digest("hex");
}

function requireAuthentication(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = /^Bearer (.+)$/i.exec(authorization);

  if (
    !match ||
    !secureEqual(match[1], MCP_API_TOKEN)
  ) {
    res.set(
      "WWW-Authenticate",
      'Bearer realm="mcp"'
    );

    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

// =====================================================
// YOUTUBE COMMAND EXECUTION
// =====================================================

async function runYtDlp(args, timeout = YTDLP_TIMEOUT_MS) {
  try {
    const { stdout } = await execFileAsync(
      YTDLP_BIN,
      [
        ...EXTRA_ARGS,
        "--no-playlist",
        "--no-warnings",
        ...args
      ],
      {
        timeout,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      }
    );

    return {
      ok: true,
      stdout
    };

  } catch (error) {
    return {
      ok: false,
      error:
        error.stderr?.toString() ||
        error.message ||
        String(error)
    };
  }
}

function result(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function failure(message) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${message}`
      }
    ]
  };
}

function parseJson(output) {
  return JSON.parse(output);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "Unknown";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);

  return [
    hours,
    minutes,
    remaining
  ]
    .filter((_, index) => index !== 0 || hours > 0)
    .map((value, index) =>
      index === 0
        ? String(value)
        : String(value).padStart(2, "0")
    )
    .join(":");
}

// =====================================================
// FILE CLEANUP
// =====================================================

function cleanupDownloads() {
  const now = Date.now();

  try {
    for (const filename of readdirSync(DOWNLOADS_DIR)) {
      const path = join(DOWNLOADS_DIR, filename);
      const info = statSync(path);

      if (
        info.isFile() &&
        now - info.mtimeMs > DOWNLOADS_TTL_MS
      ) {
        unlinkSync(path);
      }
    }
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

setInterval(cleanupDownloads, 10 * 60 * 1000);
cleanupDownloads();

// =====================================================
// MCP SERVER
// =====================================================

function createMcpServer() {
  const server = new McpServer({
    name: "youtube-downloader-mcp",
    version: "2.0.0"
  });

  // ---------------------------------------------------
  // SEARCH YOUTUBE
  // ---------------------------------------------------

  server.registerTool(
    "search-videos",
    {
      title: "Search YouTube Videos",
      description:
        "Search YouTube for videos matching keywords.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(25)
          .optional().default(10)
      }
    },
    async ({ query, limit }) => {
      const response = await runYtDlp([
        "-J",
        "--flat-playlist",
        `ytsearch${limit}:${query}`
      ]);

      if (!response.ok) return failure(response.error);

      try {
        const data = parseJson(response.stdout);

        return result({
          query,
          videos: (data.entries || []).map(video => ({
            title: video.title,
            url: video.url,
            channel: video.uploader || video.channel,
            duration: video.duration,
            views: video.view_count
          }))
        });
      } catch (error) {
        return failure(error.message);
      }
    }
  );

  // ---------------------------------------------------
  // VIDEO INFORMATION
  // ---------------------------------------------------

  server.registerTool(
    "get-video-info",
    {
      title: "Get YouTube Video Information",
      description:
        "Get video title, duration, uploader, description and metadata.",
      inputSchema: {
        url: z.string().url()
      }
    },
    async ({ url }) => {
      const response = await runYtDlp([
        "-J",
        "--ignore-no-formats-error",
        url
      ]);

      if (!response.ok) return failure(response.error);

      try {
        const video = parseJson(response.stdout);

        return result({
          title: video.title,
          channel: video.channel || video.uploader,
          duration_seconds: video.duration,
          duration: formatDuration(video.duration),
          upload_date: video.upload_date,
          views: video.view_count,
          url: video.webpage_url,
          thumbnail: video.thumbnail,
          description: video.description?.slice(0, 3000)
        });
      } catch (error) {
        return failure(error.message);
      }
    }
  );

  // ---------------------------------------------------
  // AVAILABLE VIDEO FORMATS
  // ---------------------------------------------------

  server.registerTool(
    "get-formats",
    {
      title: "Get Video Formats",
      description:
        "List available video resolutions, codecs and formats.",
      inputSchema: {
        url: z.string().url()
      }
    },
    async ({ url }) => {
      const response = await runYtDlp([
        "-J",
        "--ignore-no-formats-error",
        url
      ]);

      if (!response.ok) return failure(response.error);

      try {
        const data = parseJson(response.stdout);

        return result({
          title: data.title,
          formats: (data.formats || []).map(item => ({
            format_id: item.format_id,
            extension: item.ext,
            resolution: item.resolution,
            fps: item.fps,
            video_codec: item.vcodec,
            audio_codec: item.acodec,
            size: item.filesize || item.filesize_approx
          }))
        });
      } catch (error) {
        return failure(error.message);
      }
    }
  );

  // ---------------------------------------------------
  // YOUTUBE SUBTITLES
  // ---------------------------------------------------

  server.registerTool(
    "get-subtitles",
    {
      title: "Get YouTube Subtitles",
      description:
        "Retrieve available subtitles or automatic captions.",
      inputSchema: {
        url: z.string().url(),
        lang: z.string().optional().default("en")
      }
    },
    async ({ url, lang }) => {
      const response = await runYtDlp([
        "-J",
        "--ignore-no-formats-error",
        url
      ]);

      if (!response.ok) return failure(response.error);

      try {
        const data = parseJson(response.stdout);

        const tracks =
          data.subtitles?.[lang] ||
          data.automatic_captions?.[lang];

        if (!tracks?.length) {
          return failure("No subtitles found.");
        }

        const selected =
          tracks.find(x => x.ext === "json3") ||
          tracks.find(x => x.ext === "vtt") ||
          tracks[0];

        const download = await fetch(selected.url);

        if (!download.ok) {
          return failure(
            `Subtitle request failed: ${download.status}`
          );
        }

        const body = await download.text();

        if (selected.ext === "json3") {
          const json = JSON.parse(body);

          const text = (json.events || [])
            .flatMap(event =>
              (event.segs || []).map(seg => seg.utf8)
            )
            .join("");

          return result({
            language: lang,
            transcript: text.slice(0, 50000)
          });
        }

        return result({
          language: lang,
          transcript: body.slice(0, 50000)
        });
      } catch (error) {
        return failure(error.message);
      }
    }
  );

  // ---------------------------------------------------
  // DOWNLOAD VIDEO
  // ---------------------------------------------------

  server.registerTool(
    "download-video",
    {
      title: "Download YouTube Video",
      description:
        "Download an authorized video to the server and return a temporary signed download URL.",
      inputSchema: {
        url: z.string().url(),
        resolution: z.enum([
          "720",
          "1080",
          "2160"
        ]).optional().default("1080"),
        audio_only: z.boolean()
          .optional().default(false)
      }
    },
    async ({ url, resolution, audio_only }) => {
      const id = randomUUID();

      const outputTemplate =
        join(DOWNLOADS_DIR, `${id}.%(ext)s`);

      const format = `bv*[height<=${resolution}]+ba/b[height<=${resolution}]`;

      const args = audio_only
        ? [
            "-x",
            "--audio-format",
            "mp3",
            "-o",
            outputTemplate,
            url
          ]
        : [
            "-f",
            format,
            "--merge-output-format",
            "mp4",
            "-o",
            outputTemplate,
            url
          ];

      const response = await runYtDlp(
        args,
        DOWNLOAD_TIMEOUT_MS
      );

      if (!response.ok) {
        return failure(response.error);
      }

      const files = readdirSync(DOWNLOADS_DIR)
        .filter(file => file.startsWith(id));

      if (!files.length) {
        return failure("Downloaded file not found.");
      }

      const filename = files[0];
      const path = join(DOWNLOADS_DIR, filename);
      const stats = statSync(path);

      const expires =
        Math.floor(Date.now() / 1000) +
        Math.floor(DOWNLOADS_TTL_MS / 1000);

      const signature = signDownload(
        filename,
        expires
      );

      const downloadUrl =
        `${PUBLIC_BASE_URL}/files/` +
        `${encodeURIComponent(filename)}` +
        `?expires=${expires}&sig=${signature}`;

      return result({
        success: true,
        filename,
        size_bytes: stats.size,
        download_url: downloadUrl,
        expires_in_minutes: DOWNLOADS_TTL_MS / 60000
      });
    }
  );

  // ---------------------------------------------------
  // SERVER DIAGNOSTICS
  // ---------------------------------------------------

  server.registerTool(
    "debug-info",
    {
      title: "Server Diagnostics",
      description:
        "Check the installed yt-dlp version and server status.",
      inputSchema: {}
    },
    async () => {
      const response = await runYtDlp([
        "--version"
      ]);

      return result({
        status: "running",
        ytdlp: response.ok
          ? response.stdout.trim()
          : response.error,
        version: "2.0.0"
      });
    }
  );

  return server;
}

// =====================================================
// EXPRESS HTTP SERVER
// =====================================================

const app = express();

app.use(express.json({
  limit: "4mb"
}));

const transports = {};

// -----------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "youtube-downloader-mcp",
    version: "2.0.0"
  });
});

// -----------------------------------------------------
// SECURED FILE DOWNLOADS
// -----------------------------------------------------

app.use(
  "/files",
  (req, res, next) => {
    const filename = req.path.slice(1);
    const expires = Number(req.query.expires);
    const signature = req.query.sig;

    const validName =
      /^[0-9a-f-]+\.(mp4|mkv|webm|mp3|m4a)$/i
        .test(filename);

    const validExpiry =
      Number.isSafeInteger(expires) &&
      expires > Math.floor(Date.now() / 1000);

    const validSignature =
      typeof signature === "string" &&
      validName &&
      validExpiry &&
      secureEqual(
        signature,
        signDownload(filename, expires)
      );

    if (!validSignature) {
      return res.status(403).json({
        error: "Invalid or expired download link"
      });
    }

    next();
  },
  express.static(DOWNLOADS_DIR, {
    dotfiles: "deny",
    fallthrough: false,
    index: false,
    setHeaders: (res, path) => {
      const filename = path.split(/[\\/]/).pop();

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
    }
  })
);

// -----------------------------------------------------
// SECURED MCP ENDPOINT
// -----------------------------------------------------

app.all(
  "/mcp",
  requireAuthentication,
  async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];

      let transport = sessionId
        ? transports[sessionId]
        : null;

      if (!transport) {
        if (
          req.method !== "POST" ||
          !isInitializeRequest(req.body)
        ) {
          return res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Invalid or missing MCP session"
            },
            id: null
          });
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            transports[id] = transport;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };

        const server = createMcpServer();

        await server.connect(transport);
      }

      await transport.handleRequest(
        req,
        res,
        req.body
      );

    } catch (error) {
      console.error("MCP error:", error);

      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal server error"
        });
      }
    }
  }
);

// =====================================================
// START SERVER
// =====================================================

const httpServer = app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `YouTube Downloader MCP listening on ${HOST}:${PORT}`
    );
    console.log(`MCP endpoint: /mcp`);
    console.log(`Health endpoint: /health`);
  }
);

async function shutdown(signal) {
  console.log(`Received ${signal}`);

  httpServer.close();

  await Promise.allSettled(
    Object.values(transports)
      .map(transport => transport.close?.())
  );

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
