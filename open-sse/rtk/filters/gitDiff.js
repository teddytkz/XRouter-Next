// Port of Rust compact_diff (src/cmds/git/git_cmd.rs). Synced to rtk v0.49.0:
// hunk budgets track additions and deletions separately, combined-diff marker
// columns are charged per parent, and up to three leading context lines per
// hunk (capped at maxLines/10 diff-wide) precede the first change so the body
// reads as contiguous with it.
import { GIT_DIFF_HUNK_MAX_LINES } from "../constants.js";

const MAX_LEADING_CONTEXT = 3;

// `@@` has one marker column, `@@@` two, one per parent.
function parseHunkHeader(line) {
  const atRun = line.length - line.replace(/^@+/, "").length;
  if (atRun < 2) return null;

  const body = line.slice(atRun).split("@")[0];
  const parents = [];
  let newCount = null;

  for (const group of body.split(/\s+/)) {
    if (!group) continue;
    if (group[0] !== "-" && group[0] !== "+") continue;
    const rest = group.slice(1);
    let count;
    const comma = rest.indexOf(",");
    if (comma === -1) count = 1;
    else count = parseInt(rest.slice(comma + 1), 10);
    if (!Number.isFinite(count)) return null;
    if (group[0] === "-") parents.push(count);
    else newCount = count;
  }

  const prefixWidth = atRun - 1;
  // A well-formed header lists one range per marker column. When it does not,
  // trust the columns: an untracked parent would sit at its declared count
  // forever and the hunk would never close. Infinity keeps the hunk open to
  // the next header rather than dropping its body.
  if (parents.length !== prefixWidth) {
    parents.length = prefixWidth;
    for (let i = 0; i < prefixWidth; i++) if (parents[i] === undefined) parents[i] = Infinity;
  }

  return { parents, new: newCount ?? 0, prefixWidth, exhausted: false };
}

function consume(hunk, markers) {
  const isAdd = markers.includes(0x2b); // +
  const isDel = markers.includes(0x2d); // -
  for (let i = 0; i < hunk.parents.length; i++) {
    const column = markers[i];
    // A line shorter than the prefix reads as context, which is what a bare
    // blank line in a unified diff body is.
    const present = isDel ? column === 0x2d : column !== 0x2b;
    if (present && hunk.parents[i] !== Infinity) hunk.parents[i] = Math.max(0, hunk.parents[i] - 1);
  }
  // In the result file unless the line is a pure deletion.
  if ((isAdd || !isDel) && hunk.new !== Infinity) hunk.new = Math.max(0, hunk.new - 1);
  hunk.exhausted = hunk.new === 0 && hunk.parents.every((p) => p === 0);
}

// A diff section header (`--git`, `--cc`, `--combined`) opens a new file and
// closes any open hunk, so the `---` / `+++` headers that follow it are never
// read as hunk content.
function diffHeaderPath(line) {
  const rest = line.split(" ", 3)[2];
  if (rest === undefined) return "unknown";
  if (!line.startsWith("diff --git ")) return unquotePath(rest);

  const same = samePathTwice(rest);
  if (same !== null) return same;

  // A rename names two different paths, and the destination is the second.
  const dst = rest.split(' "b/')[1];
  if (dst !== undefined && dst.endsWith('"')) return unescapePath(dst.slice(0, -1));

  const afterB = rest.split(" b/")[1];
  return afterB !== undefined ? afterB : unquotePath(rest);
}

function samePathTwice(rest) {
  // An even-length header names two paths; an odd one is a path plus a prefix.
  if (rest.length % 2 === 0) return null;
  const mid = Math.floor(rest.length / 2);
  if (rest.charCodeAt(mid) !== 0x20) return null;
  const left = unquotePath(rest.slice(0, mid));
  const right = unquotePath(rest.slice(mid + 1));
  if (left === right) return left;
  const lp = left.split("/")[1];
  const rp = right.split("/")[1];
  return lp !== undefined && lp === rp ? rp : null;
}

function unquotePath(raw) {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
    return unescapePath(raw.slice(1, -1));
  }
  return raw;
}

function unescapePath(quoted) {
  const bytes = Buffer.from(quoted, "utf8");
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    if (bytes[i] !== 0x5c || i + 1 === bytes.length) {
      out.push(bytes[i]);
      i += 1;
      continue;
    }
    const esc = bytes[i + 1];
    if (esc >= 0x30 && esc <= 0x37) {
      const end = Math.min(i + 4, bytes.length);
      const oct = parseInt(bytes.slice(i + 1, end).toString("latin1"), 8);
      if (Number.isFinite(oct)) {
        out.push(oct);
        i = end;
        continue;
      }
      out.push(bytes[i]);
      i += 1;
      continue;
    }
    out.push(
      esc === 0x61 ? 0x07 :
      esc === 0x62 ? 0x08 :
      esc === 0x74 ? 0x09 :
      esc === 0x6e ? 0x0a :
      esc === 0x76 ? 0x0b :
      esc === 0x66 ? 0x0c :
      esc === 0x72 ? 0x0d :
      esc
    );
    i += 2;
  }
  return Buffer.from(out).toString("utf8");
}

function countNoun(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function hunkTruncationNote(deletions, additions) {
  if (deletions === 0 && additions === 0) return null;
  if (deletions === 0) return `  ... (${countNoun(additions, "addition")} truncated)`;
  if (additions === 0) return `  ... (${countNoun(deletions, "deletion")} truncated)`;
  return `  ... (${countNoun(deletions, "deletion")}, ${countNoun(additions, "addition")} truncated)`;
}

export function gitDiff(diff, maxLines = 500) {
  const result = [];
  const leadingContext = [];
  let leadingTotal = 0;
  const leadingCap = Math.max(0, Math.floor(maxLines / 10));

  let currentFile = "";
  let added = 0;
  let removed = 0;
  let hunk = null;
  let hunkShown = 0;
  let skippedAdd = 0;
  let skippedDel = 0;
  let wasTruncated = false;
  const maxHunkLines = GIT_DIFF_HUNK_MAX_LINES;

  const flushCtx = () => {
    const room = Math.max(0, leadingCap - leadingTotal);
    const keep = Math.min(leadingContext.length, room);
    // Upstream drains the whole ring and skips the oldest: keep the LAST `keep`.
    const skip = leadingContext.length - keep;
    for (let i = skip; i < leadingContext.length; i++) result.push(leadingContext[i]);
    leadingContext.length = 0;
    leadingTotal += keep;
  };

  outer: for (const line of diff.split("\n")) {
    if (line.startsWith("diff --")) {
      flushCtx();
      if (hunkTruncationNote(skippedDel, skippedAdd)) {
        result.push(hunkTruncationNote(skippedDel, skippedAdd));
        wasTruncated = true;
      }
      if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
      currentFile = diffHeaderPath(line);
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      hunk = null;
      hunkShown = 0;
      skippedAdd = 0;
      skippedDel = 0;
    } else if (line.startsWith("@@")) {
      flushCtx();
      const note = hunkTruncationNote(skippedDel, skippedAdd);
      if (note) {
        result.push(note);
        wasTruncated = true;
      }
      skippedDel = 0;
      skippedAdd = 0;
      hunk = parseHunkHeader(line);
      hunkShown = 0;
      result.push(line);
    } else if (hunk) {
      if (hunk.exhausted) {
        hunk = null;
        flushCtx();
        continue;
      }
      // "\ No newline at end of file" annotates the line above and occupies no
      // line in either file.
      if (line.startsWith("\\")) continue;

      const width = Math.min(hunk.prefixWidth, line.length);
      const markers = Buffer.from(line, "utf8").slice(0, width);
      const isAdd = markers.includes(0x2b);
      const isDel = markers.includes(0x2d);
      consume(hunk, markers);

      if (isAdd || isDel) {
        if (isAdd) added += 1;
        if (isDel) removed += 1;
        if (hunkShown < maxHunkLines) {
          // The context immediately preceding the change, so the body reads as
          // contiguous with it. The diff-wide budget is charged on emit rather
          // than on buffering, so a line the ring evicted never costs anything.
          flushCtx();
          result.push(line);
          hunkShown += 1;
        } else if (isDel) {
          skippedDel += 1;
        } else {
          skippedAdd += 1;
        }
        leadingContext.length = 0;
      } else if (hunkShown > 0) {
        if (hunkShown < maxHunkLines) {
          result.push(line);
          hunkShown += 1;
        }
      } else if (leadingTotal < leadingCap) {
        // Keep the last three lines rather than the first: with `-U10` the
        // first ones sit ten lines above the change and would imply an
        // adjacency the file does not have.
        if (leadingContext.length === MAX_LEADING_CONTEXT) leadingContext.shift();
        leadingContext.push(line);
      }

      if (hunk.exhausted) {
        hunk = null;
        flushCtx();
      }
    }

    if (result.length - leadingTotal >= maxLines) {
      result.push("\n... (more changes truncated)");
      wasTruncated = true;
      break outer;
    }
  }

  flushCtx();
  const finalNote = hunkTruncationNote(skippedDel, skippedAdd);
  if (finalNote) {
    result.push(finalNote);
    wasTruncated = true;
  }
  if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);

  if (wasTruncated) result.push("[full diff: rtk git diff --no-compact]");

  return result.join("\n");
}

gitDiff.filterName = "git-diff";
