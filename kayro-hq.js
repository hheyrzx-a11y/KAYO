/* =========================================================
   KAYRO STUDIO — HQ MP4 PATCH ENGINE
   Version 1.0.0
   ========================================================= */

(function (root) {
  "use strict";

  const KAYRO_STUDIO_HQ = (() => {

    /* =====================================================
       1. BINARY UTILITIES
       ===================================================== */

    const EXTRA_SAMPLE = Uint8Array.from([
      0x00, 0x00, 0x00, 0x04,
      0x00, 0x00, 0x00, 0x00
    ]);

    const CONTAINER_TYPES = new Set([
      "moov", "trak", "mdia", "minf",
      "stbl", "edts", "dinf", "udta",
      "meta", "ilst"
    ]);

    function toUint8(data) {
      if (data instanceof Uint8Array) {
        return data.constructor === Uint8Array
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
      if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
      }
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
      throw new TypeError("Se esperaba Uint8Array, ArrayBuffer o una vista tipada.");
    }

    function read32(data, pos) {
      return (
        (data[pos] << 24) |
        (data[pos + 1] << 16) |
        (data[pos + 2] << 8) |
        data[pos + 3]
      ) >>> 0;
    }

    function read64(data, pos) {
      return (BigInt(read32(data, pos)) << 32n) | BigInt(read32(data, pos + 4));
    }

    function write32(data, pos, value) {
      const n = Number(value) >>> 0;
      data[pos]     = (n >>> 24) & 255;
      data[pos + 1] = (n >>> 16) & 255;
      data[pos + 2] = (n >>>  8) & 255;
      data[pos + 3] =  n        & 255;
    }

    function write64(data, pos, value) {
      const n = BigInt(value);
      write32(data, pos,     Number((n >> 32n) & 0xffffffffn));
      write32(data, pos + 4, Number( n        & 0xffffffffn));
    }

    function boxType(data, pos) {
      return String.fromCharCode(
        data[pos], data[pos + 1], data[pos + 2], data[pos + 3]
      );
    }

    function createBox(type, payload) {
      const size = payload.byteLength + 8;
      if (size > 0xffffffff) {
        throw new Error(`La caja ${type} supera el límite de 32 bits.`);
      }
      const out = new Uint8Array(size);
      write32(out, 0, size);
      for (let i = 0; i < 4; i++) {
        out[4 + i] = type.charCodeAt(i);
      }
      out.set(payload, 8);
      return out;
    }

    function joinBytes(parts) {
      const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    }

    /* =====================================================
       2. MP4 BOX PARSER
       ===================================================== */

    function parseBoxes(data, start, end) {
      const result = [];
      let cursor = start;

      while (cursor + 8 <= end) {
        const declaredSize = read32(data, cursor);
        const type = boxType(data, cursor + 4);

        let size = declaredSize;
        let headerSize = 8;

        if (declaredSize === 1) {
          if (cursor + 16 > end) break;
          size = Number(read64(data, cursor + 8));
          headerSize = 16;
        } else if (declaredSize === 0) {
          size = end - cursor;
        }

        if (
          !Number.isSafeInteger(size) ||
          size < headerSize ||
          cursor + size > end
        ) {
          break;
        }

        const node = {
          type,
          start: cursor,
          end: cursor + size,
          size,
          header: headerSize,
          children: []
        };

        const childrenStart = cursor + headerSize + (type === "meta" ? 4 : 0);

        if (CONTAINER_TYPES.has(type) && childrenStart < node.end) {
          node.children = parseBoxes(data, childrenStart, node.end);
        }

        result.push(node);
        cursor += size;
      }

      return result;
    }

    function findPath(root, path) {
      let current = root;
      for (const wanted of path) {
        current = current?.children?.find(child => child.type === wanted);
        if (!current) return null;
      }
      return current;
    }

    /* =====================================================
       3. TABLE READERS
       ===================================================== */

    function readSampleSizes(data, stsz) {
      const fixedSize = read32(data, stsz.start + 12);
      const count = read32(data, stsz.start + 16);

      if (fixedSize !== 0) {
        return new Array(count).fill(fixedSize);
      }

      const sizes = new Array(count);
      let p = stsz.start + 20;
      for (let i = 0; i < count; i++, p += 4) {
        sizes[i] = read32(data, p);
      }
      return sizes;
    }

    function readChunkOffsets(data, offsetBox) {
      const count = read32(data, offsetBox.start + 12);
      const offsets = new Array(count);
      const width = offsetBox.type === "co64" ? 8 : 4;
      let p = offsetBox.start + 16;

      for (let i = 0; i < count; i++) {
        offsets[i] = offsetBox.type === "co64"
          ? Number(read64(data, p))
          : read32(data, p);
        p += width;
      }
      return offsets;
    }

    function readTimeEntries(data, stts) {
      const count = read32(data, stts.start + 12);
      const result = [];
      let p = stts.start + 16;

      for (let i = 0; i < count; i++, p += 8) {
        result.push({
          sampleCount: read32(data, p),
          sampleDelta: read32(data, p + 4)
        });
      }
      return result;
    }

    function readChunkMap(data, stsc) {
      const count = read32(data, stsc.start + 12);
      const result = [];
      let p = stsc.start + 16;

      for (let i = 0; i < count; i++, p += 12) {
        result.push({
          firstChunk: read32(data, p),
          samplesPerChunk: read32(data, p + 4),
          sampleDescriptionIndex: read32(data, p + 8)
        });
      }
      return result;
    }

    /* =====================================================
       4. TRACK INSPECTION
       ===================================================== */

    function getTrackKind(data, trak) {
      const handler = findPath(trak, ["mdia", "hdlr"]);
      if (!handler) return null;
      return boxType(data, handler.start + handler.header + 8);
    }

    function findAVCCodec(data, stbl) {
      const stsd = findPath(stbl, ["stsd"]);
      if (!stsd) return null;

      const count = read32(data, stsd.start + 12);
      let p = stsd.start + 16;

      for (let i = 0; i < count && p + 8 <= stsd.end; i++) {
        const size = read32(data, p);
        const type = boxType(data, p + 4);

        if (size < 8 || p + size > stsd.end) break;

        if (type === "avc1" || type === "avc3") {
          return { type };
        }
        p += size;
      }
      return null;
    }

    function inspectTrack(data, trak) {
      const stbl = findPath(trak, ["mdia", "minf", "stbl"]);
      const stsz = findPath(trak, ["mdia", "minf", "stbl", "stsz"]);
      const stsc = findPath(trak, ["mdia", "minf", "stbl", "stsc"]);
      const offsetBox =
        findPath(trak, ["mdia", "minf", "stbl", "stco"]) ||
        findPath(trak, ["mdia", "minf", "stbl", "co64"]);
      const stts = findPath(trak, ["mdia", "minf", "stbl", "stts"]);
      const mdhd = findPath(trak, ["mdia", "mdhd"]);
      const tkhd = findPath(trak, ["tkhd"]);

      if (!stbl || !stsz || !stsc || !offsetBox || !stts || !mdhd || !tkhd) {
        throw new Error("Una pista MP4 tiene tablas incompletas.");
      }

      return {
        trak,
        kind: getTrackKind(data, trak),
        avc: findAVCCodec(data, stbl),

        stbl,
        stsz,
        stsc,
        chunkOffsetsBox: offsetBox,
        stts,
        mdhd,
        tkhd,

        edts: findPath(trak, ["edts"]),
        udta: findPath(trak, ["udta"]),

        sampleSizes: readSampleSizes(data, stsz),
        chunkMap: readChunkMap(data, stsc),
        chunkOffsets: readChunkOffsets(data, offsetBox),
        timeEntries: readTimeEntries(data, stts)
      };
    }

    /* =====================================================
       5. BOX BUILDERS
       ===================================================== */

    function patchMatrix(data, box) {
      const out = data.slice(box.start, box.end);
      if (out[8] === 1) {
        out.fill(0, 12, 28);
      } else {
        out.fill(0, 12, 20);
      }
      return out;
    }

    function buildSTTS(entries) {
      const out = new Uint8Array(8 + 8 * entries.length);
      write32(out, 4, entries.length);
      let p = 8;
      for (const entry of entries) {
        write32(out, p,     entry.sampleCount);
        write32(out, p + 4, entry.sampleDelta);
        p += 8;
      }
      return createBox("stts", out);
    }

    function buildSTSC(entries) {
      const out = new Uint8Array(8 + 12 * entries.length);
      write32(out, 4, entries.length);
      let p = 8;
      for (const entry of entries) {
        write32(out, p,     entry.firstChunk);
        write32(out, p + 4, entry.samplesPerChunk);
        write32(out, p + 8, entry.sampleDescriptionIndex);
        p += 12;
      }
      return createBox("stsc", out);
    }

    function buildSTSZ(sampleSizes) {
      const out = new Uint8Array(12 + 4 * sampleSizes.length);
      write32(out, 4, 0);
      write32(out, 8, sampleSizes.length);
      for (let i = 0; i < sampleSizes.length; i++) {
        write32(out, 12 + 4 * i, sampleSizes[i]);
      }
      return createBox("stsz", out);
    }

    function buildOffsets(offsets, use64) {
      const needs64 = use64 || offsets.some(v => v > 0xffffffff);
      const out = new Uint8Array(8 + offsets.length * (needs64 ? 8 : 4));
      write32(out, 4, offsets.length);
      let p = 8;
      for (const value of offsets) {
        if (needs64) {
          write64(out, p, BigInt(value));
          p += 8;
        } else {
          write32(out, p, value);
          p += 4;
        }
      }
      return createBox(needs64 ? "co64" : "stco", out);
    }

    /* =====================================================
       6. TRACK REBUILDERS
       ===================================================== */

    function rebuildNode(data, node, replacementMap) {
      if (replacementMap.has(node)) {
        return replacementMap.get(node);
      }
      if (!node.children.length) {
        return data.subarray(node.start, node.end);
      }

      const childStart = node.start + node.header + (node.type === "meta" ? 4 : 0);
      const prefix = data.subarray(node.start + node.header, childStart);
      const children = node.children.map(child =>
        rebuildNode(data, child, replacementMap)
      );

      return createBox(node.type, joinBytes([prefix, ...children]));
    }

    function rebuildVideoTrack(data, track, offsetShift, extraOffset, extraCount) {
      const replacements = new Map();

      // Matrix cleanup
      replacements.set(track.tkhd, patchMatrix(data, track.tkhd));
      replacements.set(track.mdhd, patchMatrix(data, track.mdhd));

      // Timestamp adjustment (force last sample delta = 1)
      const timing = track.timeEntries.map(e => ({
        sampleCount: e.sampleCount,
        sampleDelta: e.sampleDelta
      }));

      if (timing.length) {
        const last = timing[timing.length - 1];
        if (last.sampleCount > 1) {
          last.sampleCount -= 1;
          timing.push({ sampleCount: 1, sampleDelta: 1 });
        } else {
          timing[timing.length - 1] = { sampleCount: 1, sampleDelta: 1 };
        }
      }
      replacements.set(track.stts, buildSTTS(timing));

      // Extend sample sizes
      const sizes = track.sampleSizes.concat(
        new Array(extraCount).fill(EXTRA_SAMPLE.byteLength)
      );
      replacements.set(track.stsz, buildSTSZ(sizes));

      // Extend chunk map
      const chunkMap = track.chunkMap.map(e => ({
        firstChunk: e.firstChunk,
        samplesPerChunk: e.samplesPerChunk,
        sampleDescriptionIndex: e.sampleDescriptionIndex
      }));

      const lastDescription = chunkMap.length
        ? chunkMap[chunkMap.length - 1].sampleDescriptionIndex
        : 1;

      chunkMap.push({
        firstChunk: track.chunkOffsets.length + 1,
        samplesPerChunk: 1,
        sampleDescriptionIndex: lastDescription
      });
      replacements.set(track.stsc, buildSTSC(chunkMap));

      // Recalculate offsets
      const offsets = track.chunkOffsets.map(v => v + offsetShift);
      for (let i = 0; i < extraCount; i++) {
        offsets.push(extraOffset);
      }
      replacements.set(
        track.chunkOffsetsBox,
        buildOffsets(offsets, track.chunkOffsetsBox.type === "co64")
      );

      // Remove edts / udta
      if (track.edts) replacements.set(track.edts, new Uint8Array(0));
      if (track.udta) replacements.set(track.udta, new Uint8Array(0));

      // Rebuild trak children
      const parts = [];
      for (const child of track.trak.children) {
        if (child.type === "edts" || child.type === "udta") continue;
        parts.push(rebuildNode(data, child, replacements));
      }

      return createBox("trak", joinBytes(parts));
    }

    function rebuildOtherTrack(data, track, offsetShift) {
      const replacements = new Map();

      replacements.set(track.tkhd, patchMatrix(data, track.tkhd));
      replacements.set(track.mdhd, patchMatrix(data, track.mdhd));

      replacements.set(
        track.chunkOffsetsBox,
        buildOffsets(
          track.chunkOffsets.map(v => v + offsetShift),
          track.chunkOffsetsBox.type === "co64"
        )
      );

      if (track.udta) replacements.set(track.udta, new Uint8Array(0));

      const parts = [];
      for (const child of track.trak.children) {
        if (child.type === "udta") continue;
        parts.push(rebuildNode(data, child, replacements));
      }

      return createBox("trak", joinBytes(parts));
    }

    /* =====================================================
       7. NORMALIZATION HELPERS
       ===================================================== */

    function normalizeFTYP(box) {
      const out = box.slice();
      for (let i = 8; i + 4 <= out.byteLength; i += 4) {
        // mp42 → isom
        if (
          out[i] === 0x6d && out[i + 1] === 0x70 &&
          out[i + 2] === 0x34 && out[i + 3] === 0x32
        ) {
          out[i]     = 0x69; // i
          out[i + 1] = 0x73; // s
          out[i + 2] = 0x6f; // o
          out[i + 3] = 0x6d; // m
        }
      }
      return out;
    }

    function normalizeMVHD(data, box) {
      const raw = data.subarray(box.start, box.end);
      const version = raw[8];

      const timeScaleOffset = version === 1 ? 28 : 20;
      const payloadOffset   = version === 1 ? 40 : 28;
      const payload = raw.subarray(payloadOffset);

      const out = new Uint8Array(32 + payload.byteLength);
      out[0] = 1; // force version 1 style header layout for duration fields

      write32(out, 20, read32(raw, timeScaleOffset));

      // Set duration to max (0xffffffffffffffff style)
      for (let i = 24; i < 32; i++) {
        out[i] = 255;
      }

      out.set(payload, 32);
      return createBox("mvhd", out);
    }

    /* =====================================================
       8. MAIN HQ PATCH ENGINE
       ===================================================== */

    function patchHQ(videoInput) {
      const data = toUint8(videoInput);
      const topLevel = parseBoxes(data, 0, data.byteLength);

      const ftyp = topLevel.find(b => b.type === "ftyp");
      const moov = topLevel.find(b => b.type === "moov");
      const mdats = topLevel.filter(b => b.type === "mdat");

      if (!ftyp) throw new Error("MP4 ftyp atom not found.");
      if (!moov) throw new Error("MP4 moov atom not found.");
      if (mdats.length !== 1) throw new Error("Expected exactly one mdat atom.");

      const mdat = mdats[0];
      const spare = topLevel.find(b => b.type === "free" || b.type === "skip");
      const spareBytes = spare
        ? data.subarray(spare.start, spare.end)
        : new Uint8Array(0);

      // Inspect all tracks
      const tracks = moov.children
        .filter(c => c.type === "trak")
        .map(trak => inspectTrack(data, trak));

      const videoTrack = tracks.find(t => t.kind === "vide" && t.avc);
      if (!videoTrack) {
        throw new Error("An H.264/AVC video track was not found.");
      }

      // Duration & timescale from video mdhd
      const mdhdVersion = data[videoTrack.mdhd.start + 8];
      const timescale = mdhdVersion === 1
        ? read32(data, videoTrack.mdhd.start + 28)
        : read32(data, videoTrack.mdhd.start + 20);

      const duration = mdhdVersion === 1
        ? Number(read64(data, videoTrack.mdhd.start + 32))
        : read32(data, videoTrack.mdhd.start + 24);

      if (!timescale) throw new Error("Invalid video timescale.");

      /*
       * HQ mode targets \~400 samples per second
       * to decide how many extra samples to inject.
       */
      const targetCount = Math.floor((duration / timescale) * 400);
      const currentCount = videoTrack.sampleSizes.length;
      const extraCount = Math.max(0, targetCount - currentCount);

      const originalPayloadStart = mdat.start + mdat.header;
      const payloadLength = mdat.end - originalPayloadStart;

      const normalizedFtyp = normalizeFTYP(
        data.subarray(ftyp.start, ftyp.end)
      );

      // ---- Iterative rebuild until offsets converge ----
      let offsetShift = 0;
      let extraSampleOffset = 0;
      let movieBox = null;

      function buildMovie() {
        const movieParts = [];

        for (const child of moov.children) {
          if (child.type === "mvhd") {
            movieParts.push(normalizeMVHD(data, child));
          } else if (child.type === "trak") {
            const track = tracks.find(t => t.trak === child);
            if (!track) throw new Error("Track mapping failed.");

            if (track === videoTrack) {
              movieParts.push(
                rebuildVideoTrack(
                  data, track, offsetShift, extraSampleOffset, extraCount
                )
              );
            } else {
              movieParts.push(
                rebuildOtherTrack(data, track, offsetShift)
              );
            }
          } else if (child.type !== "udta") {
            movieParts.push(data.subarray(child.start, child.end));
          }
        }

        return createBox("moov", joinBytes(movieParts));
      }

      for (let pass = 0; pass < 8; pass++) {
        movieBox = buildMovie();

        const newPayloadStart =
          normalizedFtyp.byteLength +
          spareBytes.byteLength +
          movieBox.byteLength +
          mdat.header;

        const newOffsetShift = newPayloadStart - originalPayloadStart;
        const newExtraOffset = newPayloadStart + payloadLength;

        if (
          newOffsetShift === offsetShift &&
          newExtraOffset === extraSampleOffset
        ) {
          break;
        }

        offsetShift = newOffsetShift;
        extraSampleOffset = newExtraOffset;

        if (pass === 7) {
          throw new Error("MP4 chunk offset layout did not converge.");
        }
      }

      // Final rebuild with stable offsets
      movieBox = buildMovie();

      return joinBytes([
        normalizedFtyp,
        spareBytes,
        movieBox,
        data.subarray(mdat.start, mdat.end), // original mdat intact
        EXTRA_SAMPLE                          // HQ extra sample
      ]);
    }

    /* =====================================================
       9. PUBLIC API
       ===================================================== */

    return Object.freeze({
      name: "KAYRO_STUDIO_HQ",
      version: "1.0.0",

      patchHQ,

      patchHQWithInfo(file, data) {
        const source = toUint8(data);
        const output = patchHQ(source);

        const originalName = file?.name || "video.mp4";
        const filename =
          originalName.replace(/\.[^/.]+$/, "") + "_kayro_hq_patched.mp4";

        return {
          output,
          filename,
          inputBytes: source.byteLength,
          outputBytes: output.byteLength
        };
      }
    });

  })();

  // Browser / globalThis
  root.KAYRO_STUDIO_HQ = KAYRO_STUDIO_HQ;

  // Node / CommonJS
  if (typeof module === "object" && module.exports) {
    module.exports = KAYRO_STUDIO_HQ;
  }

})(typeof globalThis !== "undefined" ? globalThis : this);