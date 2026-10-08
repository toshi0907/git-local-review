'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Syntax highlighting helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Maps file extensions to highlight.js language identifiers. */
const EXT_TO_LANGUAGE = Object.freeze({
  'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'c++': 'cpp',
  'h': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp',
  'c': 'c',
  'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'rb': 'ruby',
  'go': 'go',
  'rs': 'rust',
  'java': 'java',
  'cs': 'csharp',
  'html': 'html', 'htm': 'html',
  'css': 'css',
  'sh': 'bash', 'bash': 'bash',
  'json': 'json',
  'xml': 'xml',
  'yaml': 'yaml', 'yml': 'yaml',
  'md': 'markdown',
  'sql': 'sql',
  'kt': 'kotlin',
  'swift': 'swift',
  'php': 'php',
  'scala': 'scala',
});

/**
 * Map a file extension to a highlight.js language identifier.
 * Returns null if the extension is not recognised.
 * @param {string} filePath
 * @returns {string|null}
 */
function detectLanguage(filePath) {
  // Extract the filename from the path, then find its extension using the
  // last dot so that dotfiles with extensions (e.g. ".myfile.cpp") work.
  // dotIdx < 0 rejects files with no dot (e.g. "Makefile"); dotIdx = 0
  // is the leading dot of a plain hidden file (e.g. ".gitignore"), which
  // has no meaningful extension — both are correctly rejected by <= 0.
  const fileName = filePath.split('/').pop();
  const dotIdx   = fileName.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const ext = fileName.slice(dotIdx + 1).toLowerCase();
  return EXT_TO_LANGUAGE[ext] || null;
}

/**
 * Split a highlight.js HTML string into individual lines, ensuring that
 * open <span> tags are properly closed at each line boundary and reopened
 * on the next line.  This preserves correct colouring across multi-line
 * constructs (e.g. block comments, string literals).
 * @param {string} html
 * @returns {string[]}
 */
function splitHighlightedLines(html) {
  const openTagStack = []; // stack of full opening tag strings, e.g. '<span class="hljs-comment">'

  // Build closing tags for all currently open spans (innermost first).
  // If a tag in the stack is somehow malformed, the regex returns null and
  // that entry contributes an empty string, which is safe to ignore.
  function buildClosers() {
    return openTagStack.slice().reverse().map(t => {
      const m = t.match(/^<(\w+)/);
      return m ? `</${m[1]}>` : '';
    }).join('');
  }

  const result = [];
  let line = '';
  let i = 0;

  while (i < html.length) {
    if (html[i] === '<') {
      const tagEnd = html.indexOf('>', i);
      if (tagEnd === -1) {
        // Malformed HTML: no closing '>' found. Close open tags to keep the
        // output valid up to this point, then append the remaining raw string
        // as-is. Rendering may be imperfect but won't produce infinite loops.
        line += buildClosers() + html.slice(i);
        break;
      }
      const tag = html.slice(i, tagEnd + 1);
      line += tag;
      if (!tag.startsWith('</') && !tag.endsWith('/>')) {
        openTagStack.push(tag);
      } else if (tag.startsWith('</')) {
        openTagStack.pop();
      }
      i = tagEnd + 1;
    } else if (html[i] === '\n') {
      // Close all open tags before line break, then reopen them on the next line
      result.push(line + buildClosers());
      line = openTagStack.join('');
      i++;
    } else {
      line += html[i];
      i++;
    }
  }

  if (line) result.push(line);
  return result;
}

/**
 * Reusable Range used to convert per-line highlight.js HTML strings into DOM
 * nodes via createContextualFragment (see buildContentCell). Fragment parsing
 * starts directly in the "in body" insertion mode, unlike
 * `DOMParser#parseFromString(html, 'text/html')`, which parses the string as
 * a full document and — per the HTML5 parsing algorithm's "initial"/"before
 * html"/"before head" insertion modes — silently drops any whitespace
 * (spaces/tabs) occurring before the first tag. Diff lines that are
 * highlighted (e.g. a line consisting solely of leading indentation before a
 * keyword span) start with exactly that kind of leading whitespace, so using
 * DOMParser here was silently stripping code indentation from highlighted
 * diff lines.
 */
const htmlFragmentRange = (typeof document !== 'undefined' && document.createRange)
  ? (() => { const r = document.createRange(); r.selectNodeContents(document.body); return r; })()
  : null;

/**
 * Highlight all lines of a hunk using highlight.js.
 * Returns an array of HTML strings (one per line, matching hunk.lines),
 * or null when highlighting is unavailable or the language is not detected.
 * When language is null this function returns immediately (O(1)), so it is
 * safe to call it unconditionally for every hunk.
 * @param {string[]} lines    – raw diff lines (each starts with +, -, or space)
 * @param {string|null} language
 * @param {string} [filePath] – used only in debug messages
 * @returns {string[]|null}
 */
function highlightHunkLines(lines, language, filePath) {
  if (!language || typeof hljs === 'undefined') return null;

  // Strip the diff prefix character (+/-/space). Lines starting with '\'
  // are the "\ No newline at end of file" marker — they contribute an empty
  // placeholder so the returned array index stays aligned with hunk.lines.
  const codeLines = lines.map(l => {
    if (l.startsWith('\\')) return '';
    return l.length > 1 ? l.slice(1) : '';
  });
  const code = codeLines.join('\n');

  let highlighted;
  try {
    highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch (e) {
    console.warn('highlight.js failed for language', language, 'in', filePath || '(unknown file)', e);
    return null;
  }

  return splitHighlightedLines(highlighted);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing (Web Crypto API with non-cryptographic fallback for file:// etc.)
// ─────────────────────────────────────────────────────────────────────────────

// Simple djb2-based fallback used when crypto.subtle is unavailable
function djb2hex(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) + text.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(16).padStart(8, '0');
}

async function sha256hex(text) {
  if (crypto && crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.error('crypto.subtle unavailable, using fallback hash:', err);
    }
  }
  return djb2hex(text);
}

/**
 * Attach a `hash` to each hunk. The hash covers only diff-content lines
 * (NOT the @@ header), so line-number shifts don't alter the hash.
 */
async function computeAllHashes(files) {
  const promises = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      const text = hunk.lines.join('\n');
      promises.push(
        (async () => {
          hunk.hash = await sha256hex(text);
        })()
      );
    }
  }
  await Promise.all(promises);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML escaping
// ─────────────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse @@ header → starting line numbers
// ─────────────────────────────────────────────────────────────────────────────
function parseHunkHeader(header) {
  const m = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return m ? { oldStart: +m[1], newStart: +m[2] } : { oldStart: 1, newStart: 1 };
}
