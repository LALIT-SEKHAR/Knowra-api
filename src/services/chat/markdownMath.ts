const MARK = '\uE000';
const STASH = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

function displayMath(inner: string): string {
  return `$$\n${inner.trim()}\n$$`;
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

  return text.replace(STASH, (_, index: string) => saved[Number(index)] ?? '');
}
