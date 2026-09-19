import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CHUNK_OVERLAP, CHUNK_SIZE } from '../../config/env.js';

export type PageText = {
  pageNumber: number;
  text: string;
};

export type TextChunk = {
  content: string;
  pageNumber?: number;
  chunkIndex: number;
};

type TextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
};

/**
 * Extract selectable text from a PDF buffer (Node / pdfjs).
 * Does not OCR scanned/image-only PDFs.
 */
export async function extractPdfPages(buffer: Buffer): Promise<PageText[]> {
  if (!buffer?.length) {
    throw new Error('Empty PDF file');
  }

  // Basic PDF magic-byte check (Cloudinary/HTML error pages fail here)
  const header = buffer.subarray(0, 5).toString('utf8');
  if (!header.startsWith('%PDF')) {
    throw new Error(
      'Downloaded file is not a valid PDF. Check Cloudinary URL / access settings.',
    );
  }

  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
  } as Parameters<typeof getDocument>[0]);

  const pdf = await loadingTask.promise;
  const pages: PageText[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: false,
    });

    const text = cleanText(itemsToText(content.items as TextItem[]));
    if (text) {
      pages.push({ pageNumber: pageNum, text });
    }
  }

  return pages;
}

/** Rebuild readable text from pdfjs text items using position + EOL hints. */
function itemsToText(items: TextItem[]): string {
  if (!items.length) return '';

  const lines: string[] = [];
  let currentLine = '';
  let lastY: number | null = null;

  for (const item of items) {
    const str = typeof item.str === 'string' ? item.str : '';
    if (!str && !item.hasEOL) continue;

    const y = item.transform?.[5];
    const sameLine =
      lastY === null || y === undefined || Math.abs(y - lastY) < 2;

    if (!sameLine && currentLine.trim()) {
      lines.push(currentLine.trimEnd());
      currentLine = '';
    }

    if (str) {
      // pdfjs often omits spaces between words; add one when needed
      if (
        currentLine &&
        !currentLine.endsWith(' ') &&
        !str.startsWith(' ') &&
        !/[-–—]$/.test(currentLine)
      ) {
        currentLine += ' ';
      }
      currentLine += str;
    }

    if (item.hasEOL) {
      if (currentLine.trim()) {
        lines.push(currentLine.trimEnd());
      }
      currentLine = '';
      lastY = null;
    } else if (y !== undefined) {
      lastY = y;
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trimEnd());
  }

  return lines.join('\n');
}

export function cleanText(input: string): string {
  return input
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkPages(
  pages: PageText[],
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    if (page.text.length <= size) {
      chunks.push({
        content: page.text,
        pageNumber: page.pageNumber,
        chunkIndex: chunkIndex++,
      });
      continue;
    }

    let start = 0;
    while (start < page.text.length) {
      const end = Math.min(start + size, page.text.length);
      const content = page.text.slice(start, end).trim();
      if (content) {
        chunks.push({
          content,
          pageNumber: page.pageNumber,
          chunkIndex: chunkIndex++,
        });
      }
      if (end >= page.text.length) break;
      start = Math.max(0, end - overlap);
    }
  }

  return chunks;
}
