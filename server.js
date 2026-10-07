"use strict";

/*
 * KAYRO STUDIO - API de parche HQ (para Render)
 * Necesita estos 3 archivos en la raíz: package.json, kayro-hq.js (tu parche, sin tocar) y server.js
 *
 *   POST /api/patch          sube el video (campo "video") -> 202 { id, progressUrl, downloadUrl }
 *   GET  /api/progress/:id   progreso en tiempo real (Server-Sent Events)
 *   GET  /api/status/:id     lo mismo en JSON, por si prefieres consultar
 *   GET  /api/download/:id   entrega el MP4 parchado y lo borra del servidor
 *   GET  /                   página de prueba con barra de progreso
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const KAYRO_STUDIO_HQ = require("./kayro-hq.js");

/* ---------- Configuración ---------- */
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 150 * 1024 * 1024; // 150 MB
const MAX_LONG_SIDE = 1920;          // 1080p (horizontal 1920x1080 o vertical 1080x1920)
const MAX_SHORT_SIDE = 1080;
const MAX_FPS = 120;
const TAG = "BYPASS BY KAYRO STUDIO";
const MAX_QUEUE = 5;                 // videos en espera como máximo
const JOB_TTL_MS = 15 * 60 * 1000;   // si nadie lo descarga, se borra a los 15 min
const CHUNK = 8 * 1024 * 1024;
const WORK_DIR = path.join(os.tmpdir(), "kayro-work");

fs.rmSync(WORK_DIR, { recursive: true, force: true }); // limpia restos de reinicios
fs.mkdirSync(WORK_DIR, { recursive: true });

class UserError extends Error {}
const tick = () => new Promise((r) => setImmediate(r));
const rm = (f) => fs.promises.unlink(f).catch(() => {});

/* ---------- Lectura básica de cajas MP4 ---------- */
function boxesIn(buf, start, end) {
  const list = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (!Number.isSafeInteger(size) || size < hdr || p + size > end) break;
    list.push({ type, start: p, end: p + size, hdr });
    p += size;
  }
  return list;
}
const sub = (buf, box, type) => boxesIn(buf, box.start + box.hdr, box.end).find((b) => b.type === type);

async function scanTopLevel(fh, size) {
  const list = [];
  const head = Buffer.alloc(16);
  let pos = 0;
  while (pos + 8 <= size && list.length < 10000) {
    await fh.read(head, 0, 16, pos);
    let len = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    let hdr = 8;
    if (len === 1) {
      if (pos + 16 > size) break;
      len = Number(head.readBigUInt64BE(8));
      hdr = 16;
    } else if (len === 0) {
      len = size - pos;
    }
    if (!Number.isSafeInteger(len) || len < hdr || pos + len > size) break;
    list.push({ type, start: pos, end: pos + len, hdr });
    pos += len;
  }
  return list;
}

/* ---------- Revisión del video (H.264/AVC, 1080p, 120fps) ---------- */
const CODEC_NAMES = {
  hvc1: "H.265/HEVC", hev1: "H.265/HEVC", av01: "AV1", vp09: "VP9",
  mp4v: "MPEG-4 Visual", apch: "ProRes", apcn: "ProRes", apcs: "ProRes",
};

function inspectMoov(m) {
  let otherCodec = null;
  for (const trak of boxesIn(m, 0, m.length).filter((b) => b.type === "trak")) {
    const mdia = sub(m, trak, "mdia");
    const hdlr = mdia && sub(m, mdia, "hdlr");
    if (!hdlr || m.toString("latin1", hdlr.start + hdlr.hdr + 8, hdlr.start + hdlr.hdr + 12) !== "vide") continue;

    const minf = sub(m, mdia, "minf");
    const stbl = minf && sub(m, minf, "stbl");
    const stsd = stbl && sub(m, stbl, "stsd");
    const stts = stbl && sub(m, stbl, "stts");
    const mdhd = sub(m, mdia, "mdhd");
    if (!stsd || !stts || !mdhd) continue;

    const entries = boxesIn(m, stsd.start + stsd.hdr + 8, stsd.end);
    const avc = entries.find((e) => e.type === "avc1" || e.type === "avc3");
    if (!avc) {
      otherCodec = otherCodec || (entries[0] && entries[0].type) || "desconocido";
      continue;
    }

    const width = m.readUInt16BE(avc.start + 32);
    const height = m.readUInt16BE(avc.start + 34);
    const version = m[mdhd.start + mdhd.hdr];
    const timescale = m.readUInt32BE(mdhd.start + mdhd.hdr + (version === 1 ? 20 : 12));

    const n = m.readUInt32BE(stts.start + stts.hdr + 4);
    let samples = 0;
    let ticks = 0;
    let p = stts.start + stts.hdr + 8;
    for (let i = 0; i < n && p + 8 <= stts.end; i++, p += 8) {
      const count = m.readUInt32BE(p);
      samples += count;
      ticks += count * m.readUInt32BE(p + 4);
    }
    if (!samples || !ticks || !timescale) throw new UserError("No se pudo leer la duración ni los fps del video.");
    return { width, height, fps: (samples * timescale) / ticks };
  }

  if (otherCodec) {
    const name = CODEC_NAMES[otherCodec] || otherCodec;
    throw new UserError(`Tu video no está en H.264/AVC (códec detectado: ${name}). Debes subir un video en H.264/AVC.`);
  }
  throw new UserError("No se encontró ninguna pista de video en el archivo. Sube un video H.264/AVC.");
}

async function quickInspect(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const top = await scanTopLevel(fh, size);
    const moov = top.find((b) => b.type === "moov");
    if (!top.some((b) => b.type === "ftyp") || !moov) throw new UserError("El archivo no es un MP4 válido. Sube un video MP4 en H.264/AVC.");
    if (top.some((b) => b.type === "moof")) throw new UserError("MP4 fragmentado (fMP4) no soportado. Sube un MP4 normal en H.264/AVC.");
    if (top.filter((b) => b.type === "mdat").length !== 1) throw new UserError("Estructura de MP4 no soportada por el parche (se esperaba un solo bloque mdat).");

    const len = moov.end - moov.start - moov.hdr;
    if (len > 64 * 1024 * 1024) throw new UserError("El MP4 tiene metadatos demasiado grandes.");
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, moov.start + moov.hdr);

    const info = inspectMoov(buf);
    const long = Math.max(info.width, info.height);
    const short = Math.min(info.width, info.height);
    if (long > MAX_LONG_SIDE || short > MAX_SHORT_SIDE) {
      throw new UserError(`Solo se aceptan videos de hasta 1080p (1920x1080 o 1080x1920). Tu video es de ${info.width}x${info.height}.`);
    }
    if (info.fps > MAX_FPS + 0.5) {
      throw new UserError(`Solo se aceptan videos de hasta 120 fps. Tu video tiene ${info.fps.toFixed(1)} fps.`);
    }
    return { width: info.width, height: info.height, fps: Number(info.fps.toFixed(2)) };
  } finally {
    await fh.close();
  }
}

/* ---------- Etiqueta de metadatos (se agrega al resultado de tu parche) ---------- */
function shiftOffsets(buf, start, end, delta) {
  for (const b of boxesIn(buf, start, end)) {
    if (b.type === "trak" || b.type === "mdia" || b.type === "minf" || b.type === "stbl") {
      shiftOffsets(buf, b.start + b.hdr, b.end, delta);
    } else if (b.type === "stco") {
      const n = buf.readUInt32BE(b.start + 12);
      for (let i = 0, p = b.start + 16; i < n; i++, p += 4) buf.writeUInt32BE(buf.readUInt32BE(p) + delta, p);
    } else if (b.type === "co64") {
      const n = buf.readUInt32BE(b.start + 12);
      for (let i = 0, p = b.start + 16; i < n; i++, p += 8) buf.writeBigUInt64BE(buf.readBigUInt64BE(p) + BigInt(delta), p);
    }
  }
}

function addTag(output) {
  const buf = Buffer.from(output.buffer, output.byteOffset, output.byteLength); // vista, sin copiar
  const top = boxesIn(buf, 0, buf.length);
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (!moov || !mdat || moov.hdr !== 8 || moov.start > mdat.start) {
    throw new Error("Estructura inesperada después del parche.");
  }

  const text = Buffer.from(TAG, "utf8");
  const cmt = Buffer.alloc(12 + text.length); // atom ©cmt (comentario)
  cmt.writeUInt32BE(cmt.length, 0);
  cmt[4] = 0xa9;
  cmt.write("cmt", 5, "latin1");
  cmt.writeUInt16BE(text.length, 8);
  cmt.writeUInt16BE(0x55c4, 10); // idioma "und"
  text.copy(cmt, 12);

  const udta = Buffer.alloc(8 + cmt.length);
  udta.writeUInt32BE(udta.length, 0);
  udta.write("udta", 4, "latin1");
  cmt.copy(udta, 8);

  const newMoov = Buffer.concat([buf.subarray(moov.start, moov.end), udta]);
  newMoov.writeUInt32BE(newMoov.length, 0);
  shiftOffsets(newMoov, 8, moov.end - moov.start, udta.length); // moov va antes de mdat: se corren los offsets

  return [buf.subarray(0, moov.start), newMoov, buf.subarray(moov.end)];
}

/* ---------- Lectura / escritura con progreso ---------- */
async function readWithProgress(file, size, onPct) {
  const buf = Buffer.allocUnsafe(size);
  const fh = await fs.promises.open(file, "r");
  try {
    let off = 0;
    while (off < size) {
      const { bytesRead } = await fh.read(buf, off, Math.min(CHUNK, size - off), off);
      if (!bytesRead) break;
      off += bytesRead;
      onPct(off / size);
    }
    if (off !== size) throw new Error("Lectura incompleta del archivo.");
  } finally {
    await fh.close();
  }
  return buf;
}

async function writeParts(file, parts, onPct) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const fh = await fs.promises.open(file, "w");
  let done = 0;
  try {
    for (const part of parts) {
      for (let o = 0; o < part.length; o += CHUNK) {
        const slice = part.subarray(o, Math.min(o + CHUNK, part.length));
        let w = 0;
        while (w < slice.length) {
          const { bytesWritten } = await fh.write(slice, w, slice.length - w);
          w += bytesWritten;
        }
        done += slice.length;
        onPct(done / total);
      }
    }
  } finally {
    await fh.close();
  }
}

async function processFile(inPath, outPath, originalName, report) {
  const size = (await fs.promises.stat(inPath)).size;
  let data = await readWithProgress(inPath, size, (p) => report("reading", 3 + p * 27, "Leyendo el video"));

  report("patching", 35, "Aplicando el parche HQ");
  await tick();
  let result;
  try {
    result = KAYRO_STUDIO_HQ.patchHQWithInfo({ name: originalName }, data); // tu parche, tal cual
  } catch (e) {
    throw new UserError("No se pudo parchar este MP4: " + e.message);
  }
  data = null;
  await rm(inPath); // el original se borra apenas termina el parche

  report("tagging", 62, "Agregando la etiqueta de metadatos");
  await tick();
  const parts = addTag(result.output);
  await writeParts(outPath, parts, (p) => report("writing", 65 + p * 32, "Guardando el video final"));

  return { filename: result.filename, outputBytes: parts.reduce((s, x) => s + x.length, 0) };
}

/* ---------- Trabajos, cola y progreso ---------- */
const jobs = new Map();
const queue = [];
let busy = false;

function emit(job, patch) {
  Object.assign(job.state, patch);
  const line = "data: " + JSON.stringify(job.state) + "\n\n";
  for (const res of job.clients) res.write(line);
  if (job.state.stage === "done" || job.state.stage === "error") {
    for (const res of job.clients) res.end();
    job.clients.clear();
  }
}

function destroyJob(job) {
  rm(job.inPath);
  rm(job.outPath);
  for (const res of job.clients) res.end();
  jobs.delete(job.id);
}

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  queue.forEach((j, i) => emit(j, { stage: "queued", percent: 0, message: "En cola, posición " + (i + 1) }));

  processFile(job.inPath, job.outPath, job.originalName, (stage, percent, message) =>
    emit(job, { stage, percent: Math.round(percent), message })
  )
    .then((r) => {
      emit(job, {
        stage: "done", percent: 100, message: "Listo",
        downloadUrl: "/api/download/" + job.id, filename: r.filename, outputBytes: r.outputBytes,
      });
    })
    .catch((e) => {
      rm(job.inPath);
      rm(job.outPath);
      if (!(e instanceof UserError)) console.error(e);
      emit(job, { stage: "error", percent: 0, message: e instanceof UserError ? e.message : "Error interno al parchar el video." });
    })
    .finally(() => {
      busy = false;
      pump();
    });
}

setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    for (const res of job.clients) res.write(": ping\n\n");
    const finished = job.state.stage === "done" || job.state.stage === "error";
    if (finished && now - job.createdAt > JOB_TTL_MS) destroyJob(job);
  }
}, 15000).unref();

/* ---------- Servidor ---------- */
const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));

const upload = multer({
  storage: multer.diskStorage({
    destination: WORK_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + ".in"),
  }),
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single("video");

app.get("/health", (req, res) => res.send("ok"));

app.post("/api/patch", (req, res) => {
  if (Number(req.headers["content-length"] || 0) > MAX_BYTES + 1024 * 1024) {
    res.set("Connection", "close");
    return res.status(413).json({ error: "El video supera el máximo de 150 MB." });
  }
  if (queue.length >= MAX_QUEUE) {
    return res.status(503).json({ error: "El servidor está ocupado. Intenta de nuevo en unos segundos." });
  }

  upload(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? "El video supera el máximo de 150 MB." : "No se pudo recibir el archivo." });
    }
    if (!req.file) return res.status(400).json({ error: "Falta el archivo en el campo 'video'." });

    const inPath = req.file.path;
    try {
      const info = await quickInspect(inPath); // si no es H.264/AVC, 1080p o 120fps: error aquí mismo
      const id = crypto.randomUUID();
      const job = {
        id,
        inPath,
        outPath: path.join(WORK_DIR, id + ".out.mp4"),
        originalName: req.file.originalname || "video.mp4",
        createdAt: Date.now(),
        clients: new Set(),
        state: { stage: "queued", percent: 0, message: "En cola" },
      };
      jobs.set(id, job);
      queue.push(job);
      res.status(202).json({
        id,
        progressUrl: "/api/progress/" + id,
        statusUrl: "/api/status/" + id,
        downloadUrl: "/api/download/" + id,
        video: info,
      });
      pump();
    } catch (e) {
      rm(inPath);
      res.status(422).json({
        error: e instanceof UserError ? e.message : "No se pudo leer el MP4 (archivo dañado). Sube un video en H.264/AVC.",
      });
    }
  });
});

app.get("/api/progress/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado o expirado." });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n");
  res.write("data: " + JSON.stringify(job.state) + "\n\n");
  if (job.state.stage === "done" || job.state.stage === "error") return res.end();
  job.clients.add(res);
  req.on("close", () => job.clients.delete(res));
});

app.get("/api/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado o expirado." });
  res.json(job.state);
});

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.state.stage !== "done" || !fs.existsSync(job.outPath)) {
    return res.status(404).json({ error: "El archivo ya no está disponible." });
  }
  res.set("Cache-Control", "no-store");
  res.download(job.outPath, job.state.filename, (err) => {
    if (!err && res.statusCode === 200) destroyJob(job); // entregado: se borra del servidor
  });
});

const PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parche HQ de Kayro Studio</title>
<style>
:root{color-scheme:light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef1f5;color:#1b2430;font:16px/1.4 system-ui,sans-serif}
main{width:min(92vw,420px);padding:24px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:19px;margin:0 0 6px}
p{margin:0 0 16px;font-size:14px;color:#566274}
input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;font:inherit}
input{border:1px solid #c7cfda}
button{margin-top:12px;border:0;background:#1d4ed8;color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
#bar{display:none;height:10px;margin-top:16px;background:#e3e8ef;border-radius:99px;overflow:hidden}
#fill{height:100%;width:0;background:#1d4ed8;transition:width .2s}
#msg{margin-top:10px;font-size:14px;min-height:20px}
.err{color:#b42318}
</style></head><body><main>
<h1>Parche HQ de Kayro Studio</h1>
<p>Video MP4 en H.264/AVC, hasta 1080p, 120 fps y 150 MB.</p>
<input id="f" type="file" accept="video/mp4,.mp4">
<button id="go">Parchar video</button>
<div id="bar"><div id="fill"></div></div>
<div id="msg"></div>
</main>
<script>
var API = ""; // desde otra web: "https://tu-api.onrender.com"
var $ = function (id) { return document.getElementById(id); };
function show(pct, text, isErr) {
  $("bar").style.display = "block";
  $("fill").style.width = pct + "%";
  $("msg").className = isErr ? "err" : "";
  $("msg").textContent = text;
}
function fail(text) { $("go").disabled = false; show(0, text, true); }
$("go").onclick = function () {
  var file = $("f").files[0];
  if (!file) return show(0, "Elige un video MP4.", true);
  if (file.size > 150 * 1024 * 1024) return show(0, "El video supera el máximo de 150 MB.", true);
  var fd = new FormData();
  fd.append("video", file);
  var xhr = new XMLHttpRequest();
  $("go").disabled = true;
  xhr.open("POST", API + "/api/patch");
  xhr.upload.onprogress = function (e) {
    if (!e.lengthComputable) return;
    var p = Math.round(e.loaded / e.total * 100);
    show(Math.round(p / 2), "Subiendo " + p + "%");
  };
  xhr.onerror = function () { fail("Error de conexión."); };
  xhr.onload = function () {
    var r = {};
    try { r = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status !== 202) return fail(r.error || "Error del servidor.");
    var es = new EventSource(API + r.progressUrl);
    es.onmessage = function (m) {
      var s = JSON.parse(m.data);
      if (s.stage === "error") { es.close(); return fail(s.message); }
      show(50 + Math.round(s.percent / 2), s.message + " " + s.percent + "%");
      if (s.stage === "done") {
        es.close();
        $("go").disabled = false;
        show(100, "Listo, descargando el video.");
        location.href = API + s.downloadUrl;
      }
    };
    es.onerror = function () { if (es.readyState === 2) fail("Se perdió la conexión del progreso."); };
  };
  xhr.send(fd);
};
</script></body></html>`;

app.get("/", (req, res) => res.type("html").send(PAGE));

if (require.main === module) {
  const server = app.listen(PORT, () => console.log("KAYRO STUDIO API en el puerto " + PORT));
  server.requestTimeout = 15 * 60 * 1000; // subidas lentas desde el celular
  server.keepAliveTimeout = 65 * 1000;
}

module.exports = { app, quickInspect, processFile, addTag, UserError };
