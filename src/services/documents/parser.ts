import { extractText, getDocumentProxy } from 'unpdf';
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

/**
 * Extract selectable text from a PDF buffer (serverless-safe via unpdf).
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

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  const pageTexts = Array.isArray(text) ? text : [text];

  const pages: PageText[] = [];
  for (let i = 0; i < pageTexts.length; i += 1) {
    const cleaned = cleanText(pageTexts[i] ?? '');
    if (cleaned) {
      pages.push({ pageNumber: i + 1, text: cleaned });
    }
  }
  return pages;
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
