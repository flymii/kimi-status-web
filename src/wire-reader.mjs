import fs from 'node:fs';

/**
 * Bounded incremental reader for the append-only wire.jsonl journals.
 *
 * Everything stays in bytes: the reader advances by the number of bytes it
 * actually read and keeps the trailing partial line as a Buffer, so a read
 * that lands in the middle of a multi-byte character can never shift the
 * offsets. Only complete lines are decoded.
 */

export const FULL_READ_LIMIT_BYTES = 16 * 1024 * 1024;
export const TAIL_READ_BYTES = 4 * 1024 * 1024;
export const TICK_READ_BYTES = 2 * 1024 * 1024;
const MAX_PARTIAL_LINE_BYTES = 4 * 1024 * 1024;

const NEWLINE = 0x0a;

const WANTED = [
  '"type":"usage.record"',
  '"type":"context.append_loop_event"',
  '"type":"llm.request"',
  '"type":"turn.prompt"',
  '"type":"turn.ended"',
  '"type":"turn.cancel"',
  '"type":"token_counting.measured"',
  '"type":"token_counting.truncated"',
];

/** Journal rows worth parsing; everything else (content.part) is skipped cheaply. */
export function isInterestingLine(line) {
  for (const needle of WANTED) {
    if (line.includes(needle)) return true;
  }
  return false;
}

export function createBucket(filePath = null) {
  return {
    path: filePath,
    offset: 0,
    size: 0,
    pending: Buffer.alloc(0),
    discardingLine: false,
    started: false,
    partial: false,
  };
}

/** Split a byte chunk on newlines, returning complete lines plus the tail. */
function splitLines(buffer) {
  const lines = [];
  let start = 0;
  let newline = buffer.indexOf(NEWLINE);
  while (newline >= 0) {
    if (newline > start) lines.push(buffer.subarray(start, newline));
    start = newline + 1;
    newline = buffer.indexOf(NEWLINE, start);
  }
  return { lines, rest: buffer.subarray(start) };
}

/**
 * Read whatever the writer appended since the last call. The first read of an
 * oversized journal starts near the end of the file and flags `partial`.
 */
export function readNewRows(bucket, { limit = TICK_READ_BYTES, reset = false } = {}) {
  const rows = [];
  let changed = false;
  let stat;
  try {
    stat = fs.statSync(bucket.path);
  } catch {
    return { rows, changed, size: 0 };
  }
  if (!stat.isFile()) return { rows, changed, size: 0 };

  if (reset || stat.size < bucket.offset) {
    bucket.offset = 0;
    bucket.pending = Buffer.alloc(0);
    bucket.discardingLine = false;
    bucket.started = false;
    bucket.partial = false;
    changed = true;
  }
  if (!bucket.started) {
    bucket.started = true;
    if (stat.size > FULL_READ_LIMIT_BYTES) {
      // Landing mid-line: drop everything up to the next newline.
      bucket.offset = stat.size - TAIL_READ_BYTES;
      bucket.discardingLine = true;
      bucket.partial = true;
      changed = true;
    }
  }

  const available = stat.size - bucket.offset;
  if (available <= 0) {
    bucket.size = stat.size;
    return { rows, changed, size: stat.size };
  }

  const length = Math.min(available, Math.max(0, Math.floor(limit)));
  let chunk;
  let fd;
  try {
    fd = fs.openSync(bucket.path, 'r');
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, bucket.offset);
    chunk = buffer.subarray(0, read);
    bucket.offset += read;
  } catch {
    return { rows, changed, size: stat.size };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  bucket.size = stat.size;
  changed = true;

  if (bucket.discardingLine) {
    const newline = chunk.indexOf(NEWLINE);
    if (newline < 0) return { rows, changed, size: stat.size };
    bucket.discardingLine = false;
    chunk = chunk.subarray(newline + 1);
  }

  const combined = bucket.pending.length ? Buffer.concat([bucket.pending, chunk]) : chunk;
  const { lines, rest } = splitLines(combined);
  if (rest.length > MAX_PARTIAL_LINE_BYTES) {
    bucket.pending = Buffer.alloc(0);
    bucket.discardingLine = true;
  } else {
    bucket.pending = rest;
  }

  for (const line of lines) {
    let text;
    try {
      text = line.toString('utf8');
    } catch {
      continue;
    }
    if (!isInterestingLine(text)) continue;
    try {
      const row = JSON.parse(text);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      // A single corrupt row must not poison the rest of the stream.
    }
  }
  return { rows, changed, size: stat.size };
}
