const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const EventEmitter = require("events");

const app = express();

app.use(cors({
  origin: "http://localhost:35179",
  credentials: true,
}));
app.use(express.json());

const DOWNLOAD_DIR = path.join(os.homedir(), "Downloads");
const DATA_DIR = path.join(os.homedir(), ".vido");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// id -> job. Jobs hold everything: metadata, progress, the live process, an emitter for SSE fan-out.
const jobs = new Map();

function serializeJob(job) {
  const { emitter, proc, ...rest } = job;
  return rest;
}

function persistHistory() {
  const arr = Array.from(jobs.values())
    .map(serializeJob)
    .sort((a, b) => b.createdAt - a.createdAt);
  fs.writeFile(HISTORY_FILE, JSON.stringify(arr, null, 2), () => {});
}

function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    for (const j of arr) {
      if (j.status === "downloading" || j.status === "paused") {
        j.status = "error";
        j.error = "Interrupted (server restarted)";
      }
      jobs.set(j.id, { ...j, emitter: null, proc: null });
    }
  } catch {
    // no history file yet, that's fine
  }
}
loadHistory();

function getResolutionLabel(f) {
  const h = f.height;
  if (!h) return null;
  if (h >= 4320) return "4320p 8K";
  if (h >= 2160) return "2160p 4K";
  if (h >= 1440) return "1440p 2K";
  if (h >= 1080) return "1080p HD";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h >= 360) return "360p";
  if (h >= 240) return "240p";
  return "144p";
}

function getResolutionOrder(label) {
  const order = ["4320p 8K", "2160p 4K", "1440p 2K", "1080p HD", "720p", "480p", "360p", "240p", "144p"];
  return order.indexOf(label);
}

function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

app.get("/formats", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  const proc = spawn("yt-dlp", ["--dump-json", "--no-playlist", url]);
  let chunks = [];
  let err = "";

  proc.stdout.on("data", (c) => chunks.push(c));
  proc.stderr.on("data", (c) => (err += c.toString()));

  proc.on("close", (code) => {
    if (code !== 0) return res.status(500).json({ error: err || "yt-dlp failed" });

    try {
      const info = JSON.parse(Buffer.concat(chunks).toString());
      const raw = (info.formats || []).filter((f) => {
      if (!f.ext || f.format_note === "storyboard") return false;
      const hasVideo = f.vcodec !== "none";
      const hasAudio = f.acodec !== "none";
      return hasVideo || hasAudio;
    });

      const videoMap = new Map();
      for (const f of raw) {
        if (f.vcodec === "none") continue;
        const label = getResolutionLabel(f);
        if (!label) continue;
        const score = f.tbr || f.filesize || 0;
        const existing = videoMap.get(label);
        const existingScore = existing ? (existing.tbr || existing.filesize || 0) : -1;
        if (!existing || score > existingScore) videoMap.set(label, { ...f, _label: label });
      }

      const videoFormats = Array.from(videoMap.values())
        .sort((a, b) => getResolutionOrder(a._label) - getResolutionOrder(b._label))
        .map((f) => ({
          id: f.format_id,
          label: f._label,
          ext: f.ext,
          resolution: f.resolution || `${f.width}x${f.height}`,
          filesize: f.filesize || f.filesize_approx || null,
          filesizeLabel: formatSize(f.filesize || f.filesize_approx),
        }));

      const audioMap = new Map();
      for (const f of raw) {
        if (f.vcodec !== "none") continue;
        const codec = f.acodec?.split(".")[0] || "unknown";
        const score = f.abr || 0;
        const existing = audioMap.get(codec);
        const existingScore = existing ? (existing.abr || 0) : -1;
        if (!existing || score > existingScore) audioMap.set(codec, f);
      }

      const audioFormats = Array.from(audioMap.values())
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))
        .map((f) => ({
          id: f.format_id,
          label: `${(f.acodec?.split(".")[0] || "Audio").toUpperCase()}${f.abr ? " · " + Math.round(f.abr) + "kbps" : ""}`,
          ext: f.ext,
          resolution: "audio only",
          filesize: f.filesize || f.filesize_approx || null,
          filesizeLabel: formatSize(f.filesize || f.filesize_approx),
        }));

      const mp3Format = {
        id: "__mp3__",
        label: "MP3 · Best quality",
        ext: "mp3",
        resolution: "audio only",
        filesize: null,
        filesizeLabel: null,
      };

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        webpage_url: info.webpage_url,
        formats: [...videoFormats, mp3Format, ...audioFormats],
      });
    } catch {
      res.status(500).json({ error: "parse error" });
    }
  });
});

// ---- Jobs ----

app.get("/jobs", (req, res) => {
  const list = Array.from(jobs.values())
    .map(serializeJob)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.get("/jobs/active", (req, res) => {
  const list = Array.from(jobs.values())
    .filter((j) => j.status === "downloading" || j.status === "paused")
    .map(serializeJob);
  res.json(list);
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(serializeJob(job));
});

app.delete("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.proc) job.proc.kill();
  jobs.delete(req.params.id);
  persistHistory();
  res.json({ ok: true });
});

function startDownloadProcess(job) {
  const isMp3 = job.formatId === "__mp3__";
  const args = [
    "--newline", "--progress", "--no-quiet", "--no-playlist", "--no-part", "--no-colors",
    "-o", path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s"),
  ];
  if (isMp3) args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  else if (job.formatId) args.push("-f", job.formatId);
  args.push(job.url);

  const proc = spawn("yt-dlp", args, {
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
  });
  job.proc = proc;

  const emit = (data) => {
    job.updatedAt = Date.now();
    job.emitter.emit("update", data);
  };

  function parseLine(line) {
    const t = line.trim();
    if (!t) return;

    const progressMatch = t.match(/\[download\]\s+([\d.]+)%.*?at\s+(.+?)\s+ETA\s+(.+)/);
    if (progressMatch) {
      job.percent = Number(progressMatch[1]);
      job.speed = progressMatch[2].trim();
      job.eta = progressMatch[3].trim();
      emit({ type: "progress", percent: job.percent, speed: job.speed, eta: job.eta });
      return;
    }

    const dest = t.match(/\[(?:download|ExtractAudio)\] Destination:\s+(.+)/);
    if (dest) job.filepath = dest[1];

    emit({ type: "log", message: t });
  }

  let stdoutBuf = "";
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop();
    for (const line of lines) parseLine(line);
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop();
    for (const line of lines) parseLine(line);
  });

  proc.on("error", (e) => {
    job.status = "error";
    job.error = e.message;
    persistHistory();
    emit({ type: "error", message: e.message });
  });

  proc.on("close", (code) => {
    if (job.status !== "cancelled") {
      job.status = code === 0 ? "done" : "error";
      if (job.status === "error" && !job.error) job.error = `failed (${code})`;
      if (job.status === "done") job.percent = 100;
    }
    persistHistory();
    emit({
      type: job.status,
      message: job.status === "done" ? "Download complete" : job.error || "Cancelled",
    });
  });
}

app.post("/download", (req, res) => {
  const { url, formatId, title, thumbnail, webpage_url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  const id = crypto.randomUUID();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  const job = {
    id,
    url,
    formatId: formatId || null,
    title: title || url,
    thumbnail: thumbnail || null,
    webpage_url: webpage_url || url,
    status: "downloading",
    percent: 0,
    speed: null,
    eta: null,
    error: null,
    filepath: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    emitter,
    proc: null,
  };

  jobs.set(id, job);
  persistHistory();
  startDownloadProcess(job);

  res.json({ jobId: id });
});

app.get("/download/:id/stream", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };

  send({ type: "snapshot", job: serializeJob(job) });

  const onUpdate = (payload) => send(payload);
  job.emitter?.on("update", onUpdate);

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    job.emitter?.off("update", onUpdate);
  });
});

app.post("/download/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  job.status = "cancelled";
  if (job.proc) job.proc.kill();
  persistHistory();
  job.emitter?.emit("update", { type: "cancelled", message: "Cancelled by user" });
  res.json({ ok: true });
});

app.post("/download/:id/pause", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.proc && os.platform() !== "win32") job.proc.kill("SIGSTOP");
  job.status = "paused";
  job.emitter?.emit("update", { type: "paused" });
  res.json({ ok: true });
});

app.post("/download/:id/resume", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.proc && os.platform() !== "win32") job.proc.kill("SIGCONT");
  job.status = "downloading";
  job.emitter?.emit("update", { type: "resumed" });
  res.json({ ok: true });
});

app.listen(39101, "0.0.0.0", () => {
  console.log(`Server running ...`);
});