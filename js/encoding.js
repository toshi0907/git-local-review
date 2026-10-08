'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Character encoding detection / decoding
//
// diff ファイルは UTF-8 以外に Shift_JIS / EUC-JP で保存されることがあるため、
// バイト列から自動判定して読み込む。判定を誤った場合に備え、プロジェクトごとに
// 明示的な文字コードを指定して読み込み直せるようにしてある（proj.encoding）。
// ─────────────────────────────────────────────────────────────────────────────
const ENCODING_LABELS = {
  auto:       '自動判定',
  'utf-8':    'UTF-8',
  shift_jis:  'Shift_JIS',
  'euc-jp':   'EUC-JP',
};

const VALID_ENCODINGS = ['auto', 'utf-8', 'shift_jis', 'euc-jp'];

/** Coerce any stored/imported encoding value back to 'auto' if it's not one we recognize. */
function normalizeEncoding(value) {
  return VALID_ENCODINGS.includes(value) ? value : 'auto';
}

/** Score how well `bytes` parses as Shift_JIS 2-byte sequences (higher = more plausible). */
function scoreShiftJis(bytes) {
  let score = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      const next = bytes[i + 1];
      if (next !== undefined && next >= 0x40 && next <= 0xfc && next !== 0x7f) {
        score += 2;
        i++;
      } else {
        score -= 3;
      }
    } else if ((b >= 0x80 && b <= 0xa0 && b !== 0x80) || b >= 0xfd) {
      score -= 3; // byte with no valid role as a Shift_JIS lead byte
    }
  }
  return score;
}

/** Score how well `bytes` parses as EUC-JP 2/3-byte sequences (higher = more plausible). */
function scoreEucJp(bytes) {
  let score = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x8e) { // half-width kana lead byte
      const next = bytes[i + 1];
      if (next !== undefined && next >= 0xa1 && next <= 0xdf) { score += 2; i++; }
      else score -= 3;
    } else if (b === 0x8f) { // JIS X 0212 lead byte
      const n1 = bytes[i + 1], n2 = bytes[i + 2];
      if (n1 !== undefined && n1 >= 0xa1 && n1 <= 0xfe && n2 !== undefined && n2 >= 0xa1 && n2 <= 0xfe) { score += 3; i += 2; }
      else score -= 3;
    } else if (b >= 0xa1 && b <= 0xfe) {
      const next = bytes[i + 1];
      if (next !== undefined && next >= 0xa1 && next <= 0xfe) { score += 2; i++; }
      else score -= 3;
    } else if (b >= 0x80 && b <= 0xa0) {
      score -= 3;
    }
  }
  return score;
}

/**
 * Auto-detect and decode `buffer` in a single pass. Strict (fatal) UTF-8
 * decoding is tried first since real Shift_JIS/EUC-JP text essentially
 * never happens to be valid UTF-8 beyond a few bytes; its decoded result is
 * reused directly (most diffs are UTF-8, so this avoids decoding the whole
 * buffer twice). If it fails, the bytes are scored against both legacy
 * Japanese encodings and the higher scorer is decoded.
 * @returns {{text: string, encoding: 'utf-8'|'shift_jis'|'euc-jp'}}
 */
function decodeAuto(buffer) {
  const bytes = new Uint8Array(buffer);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

  if (!hasBom) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { text, encoding: 'utf-8' };
    } catch (e) {
      // Not valid UTF-8 - fall through to legacy Japanese encoding detection.
    }
  }

  if (hasBom) {
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
  }

  const sjisScore = scoreShiftJis(bytes);
  const eucScore  = scoreEucJp(bytes);
  const enc = eucScore > sjisScore ? 'euc-jp' : 'shift_jis';
  try {
    return { text: new TextDecoder(enc).decode(buffer), encoding: enc };
  } catch (e) {
    // Browser lacks this legacy encoding's decoder - fall back to UTF-8
    // rather than letting the RangeError abort the whole load.
    console.error(`Encoding "${enc}" unsupported by this browser, falling back to UTF-8`, e);
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
  }
}

/**
 * Decode `buffer` (an ArrayBuffer) into a string.
 * `encoding` may be 'auto' (or omitted) to auto-detect, or an explicit
 * 'utf-8' | 'shift_jis' | 'euc-jp' override.
 * @returns {{text: string, encoding: string}} the decoded text and the encoding actually used
 */
function decodeBytes(buffer, encoding) {
  if (!encoding || encoding === 'auto') return decodeAuto(buffer);
  try {
    return { text: new TextDecoder(encoding).decode(buffer), encoding };
  } catch (e) {
    console.error(`Unsupported encoding "${encoding}", falling back to UTF-8`, e);
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
  }
}

/** True if `bytes[start, end)` begins with the ASCII bytes of `str`. */
function bytesStartWithAscii(bytes, start, end, str) {
  if (end - start < str.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (bytes[start + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Split raw `buffer` bytes into line ranges tagged 'message' (a `git log -p`
 * / `git show` commit header and message body — hash, `Author:`, `Date:`,
 * `Merge:` and the indented message text) or 'source' (everything else:
 * the `diff --git` file headers and hunk bodies).
 *
 * Git always writes the commit metadata as its own text (normally UTF-8,
 * per `i18n.commitEncoding`), independently of the encoding the diffed
 * source files themselves happen to be saved in (e.g. legacy Shift_JIS /
 * EUC-JP Japanese source). Both live in the same byte stream, so a single
 * whole-buffer encoding guess garbles whichever half doesn't match it.
 *
 * This classifies *before* decoding, using only the `commit ` / `diff --git
 * ` line-start markers — both pure ASCII, hence byte-identical whichever of
 * UTF-8 / Shift_JIS / EUC-JP either half turns out to be — so each half can
 * later be encoding-detected and decoded on its own (see decodeGitLog()).
 * Plain `git diff` output (no `commit ` lines) yields a single 'source'
 * section spanning the whole buffer.
 * @returns {{bytes: Uint8Array, ranges: Array<{section: 'message'|'source', start: number, end: number}>}}
 */
function splitGitLogByteLines(buffer) {
  const bytes = new Uint8Array(buffer);
  const ranges = [];
  let inMessage = false;

  function endLine(start, end) {
    if (bytesStartWithAscii(bytes, start, end, 'commit ')) inMessage = true;
    else if (bytesStartWithAscii(bytes, start, end, 'diff --git ')) inMessage = false;
    ranges.push({ section: inMessage ? 'message' : 'source', start, end });
  }

  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) { endLine(lineStart, i + 1); lineStart = i + 1; }
  }
  if (lineStart < bytes.length) endLine(lineStart, bytes.length);

  return { bytes, ranges };
}

/** Concatenate the byte ranges in `ranges` (all cut from `bytes`) into one new Uint8Array. */
function concatByteRanges(bytes, ranges) {
  let len = 0;
  for (const r of ranges) len += r.end - r.start;
  const out = new Uint8Array(len);
  let pos = 0;
  for (const r of ranges) { out.set(bytes.subarray(r.start, r.end), pos); pos += r.end - r.start; }
  return out;
}

/**
 * Like decodeBytes(), but for `git log -p` / `git show` output: the commit
 * message section and the diff/source section are split apart (see
 * splitGitLogByteLines()) and encoding-detected independently, so e.g. a
 * UTF-8 commit message on top of an EUC-JP source file decodes correctly
 * instead of one half turning to mojibake.
 *
 * Only applies when `encoding` is 'auto' (or omitted) *and* the input
 * actually contains both a message and a source section — an explicit
 * encoding override forces that single encoding on the whole buffer as
 * before (there is nothing to detect separately), and plain `git diff`
 * input (no `commit ` lines) has no message section to split out.
 * @returns {{text: string, encoding: string, messageEncoding: string|undefined}}
 *   `encoding` is the source/diff section's resolved encoding (shown/stored
 *   as the project's encoding, same as before this split existed);
 *   `messageEncoding` is the commit message section's resolved encoding,
 *   or undefined when no separate detection was performed (see above).
 */
function decodeGitLog(buffer, encoding) {
  if (encoding && encoding !== 'auto') {
    return { ...decodeBytes(buffer, encoding), messageEncoding: undefined };
  }

  const { bytes, ranges } = splitGitLogByteLines(buffer);
  const messageRanges = ranges.filter(r => r.section === 'message');
  const sourceRanges  = ranges.filter(r => r.section === 'source');
  if (messageRanges.length === 0 || sourceRanges.length === 0) {
    return { ...decodeAuto(buffer), messageEncoding: undefined };
  }

  const messageDecoded = decodeAuto(concatByteRanges(bytes, messageRanges).buffer);
  const sourceDecoded  = decodeAuto(concatByteRanges(bytes, sourceRanges).buffer);
  // Both sides' decoded text preserves a literal "\n" at the same relative
  // positions as the original bytes (0x0a decodes identically, unchanged,
  // in all three encodings), so splitting each back on "\n" reconstructs
  // exactly its lines in order; see splitGitLogByteLines() for why slicing
  // to each section's range count is always exactly right.
  const messageLines = messageDecoded.text.split('\n').slice(0, messageRanges.length);
  const sourceLines  = sourceDecoded.text.split('\n').slice(0, sourceRanges.length);

  let mi = 0, si = 0;
  const lines = ranges.map(r => r.section === 'message' ? messageLines[mi++] : sourceLines[si++]);
  // join() alone would drop a real trailing blank line vs. decoding the
  // whole buffer at once, since each bucket's own trailing "\n" (if any)
  // was already accounted for by the slice() above: restore it here so a
  // buffer ending in "\n" still decodes to text ending in "\n".
  let text = lines.join('\n');
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0a) text += '\n';

  return { text, encoding: sourceDecoded.encoding, messageEncoding: messageDecoded.encoding };
}
