const MARK = '\uE000';
const STASH = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

function displayMath(inner: string): string {
  return `$$\n${inner.trim()}\n$$`;
}

function isLineStart(text: string, index: number) {
  return index === 0 || text[index - 1] === '\n';
}

function endOfLine(text: string, index: number) {
  const next = text.indexOf('\n', index);
  return next === -1 ? text.length : next + 1;
}

function skipLineSpace(text: string, index: number) {
  let cursor = index;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  return cursor;
}

function isLineEnding(text: string, index: number) {
  return index >= text.length || text[index] === '\n' || text[index] === '\r';
}

function onlyIndentBefore(text: string, index: number) {
  let cursor = index;
  while (cursor > 0 && text[cursor - 1] !== '\n') cursor -= 1;
  const indent = text.slice(cursor, index);
  return indent.length <= 3 && /^ *$/.test(indent);
}

/** A line whose only content is a `$$` fence. */
function isBareDollarFence(text: string, index: number) {
  let cursor = index;
  let indent = 0;
  while (text[cursor] === ' ' && indent < 4) {
    cursor += 1;
    indent += 1;
  }
  if (indent > 3 || text[cursor] !== '$' || text[cursor + 1] !== '$') return false;
  while (text[cursor] === '$') cursor += 1;
  return isLineEnding(text, skipLineSpace(text, cursor));
}

/**
 * remark-math keeps a display block open until `$$` is alone on a line.
 * `$$\nE = mc^2\n$$ next sentence` therefore swallows the sentence, and KaTeX
 * paints it as a failed formula. Break that fence onto its own line.
 */
export function repairDisplayMath(input: string): string {
  const out: string[] = [];
  let index = 0;
  let inFence = false;
  let inDisplay = false;

  while (index < input.length) {
    if (!inDisplay && isLineStart(input, index) && input.startsWith('```', index)) {
      inFence = !inFence;
      const end = endOfLine(input, index);
      out.push(input.slice(index, end));
      index = end;
      continue;
    }

    if (inFence) {
      out.push(input[index]);
      index += 1;
      continue;
    }

    if (!inDisplay && input[index] === '`') {
      const close = input.indexOf('`', index + 1);
      const newline = input.indexOf('\n', index + 1);
      if (close !== -1 && (newline === -1 || close < newline)) {
        out.push(input.slice(index, close + 1));
        index = close + 1;
        continue;
      }
    }

    if (input[index] === '\\' && input[index + 1] === '$') {
      out.push('\\$');
      index += 2;
      continue;
    }

    if (!inDisplay && isLineStart(input, index) && isBareDollarFence(input, index)) {
      const end = endOfLine(input, index);
      out.push(input.slice(index, end));
      index = end;
      inDisplay = true;
      continue;
    }

    if (inDisplay && input[index] === '$' && input[index + 1] === '$') {
      let endDollars = index;
      while (input[endDollars] === '$') endDollars += 1;
      const afterSpace = skipLineSpace(input, endDollars);
      if (onlyIndentBefore(input, index) && isLineEnding(input, afterSpace)) {
        const end = endOfLine(input, index);
        out.push(input.slice(index, end));
        index = end;
        inDisplay = false;
        continue;
      }

      if (!onlyIndentBefore(input, index)) out.push('\n');
      out.push('$$\n');
      index = endDollars;
      while (input[index] === ' ' || input[index] === '\t') index += 1;
      inDisplay = false;
      continue;
    }

    out.push(input[index]);
    index += 1;
  }

  return out.join('');
}

function stash(saved: string[], value: string): string {
  saved.push(value);
  return `${MARK}${saved.length - 1}${MARK}`;
}

/**
 * Store math in the form remark-math renders.
 * `\[...\]` and a line that is only `$$...$$` become a display block.
 * `\(...\)` becomes inline `$...$`.
 * Prose, citations, and parentheses are left unchanged.
 */
export function canonicalizeMarkdownMath(input: string): string {
  const saved: string[] = [];
  let text = input.replace(/```[\s\S]*?```|`[^`\n]*`/g, (block) => stash(saved, block));

  text = text.replace(/\$\$\n[\s\S]+?\n\$\$/g, (block) => stash(saved, block));
  text = text.replace(/(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)/g, (block) => stash(saved, block));

  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => displayMath(inner));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => `$${inner.trim()}$`);
  text = text.replace(/^[ \t]*\$\$([^$\n]+)\$\$[ \t]*$/gm, (_, inner: string) => displayMath(inner));

  return repairDisplayMath(text.replace(STASH, (_, index: string) => saved[Number(index)] ?? ''));
}
