import { getDocumentProxy, renderPageAsImage } from 'unpdf';
import { OCR_CONCURRENCY, OCR_MAX_PAGES } from '../../config/env.js';
import { extractTextFromImage, type TokenUsage } from '../openai/client.js';
import { cleanText, type PageText } from './parser.js';

export type OcrProgress = {
  completedPages: number;
  totalPages: number;
};

export type OcrPagesResult = {
  pages: PageText[];
  usage: TokenUsage;
  pageCount: number;
};

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * OCR fallback for scanned / image-only PDFs.
 * Renders each page and extracts text via the user's OpenAI vision model.
 */
export async function ocrPdfPages(
  buffer: Buffer,
  apiKey: string,
  onProgress?: (progress: OcrProgress) => void | Promise<void>,
): Promise<OcrPagesResult> {
  if (!buffer?.length) {
    throw new Error('Empty PDF file');
  }

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const totalPages = pdf.numPages;

  if (totalPages > OCR_MAX_PAGES) {
    throw new Error(
      `This scanned PDF has ${totalPages} pages. OCR supports up to ${OCR_MAX_PAGES} pages — split the file or upload a text-based PDF.`,
    );
  }

  const pages: PageText[] = new Array(totalPages);
  let nextPage = 1;
  let completedPages = 0;
  let usage = emptyUsage();

  async function worker(): Promise<void> {
    while (nextPage <= totalPages) {
      const pageNumber = nextPage;
      nextPage += 1;

      const dataUrl = await renderPageAsImage(pdf, pageNumber, {
        canvasImport: () => import('@napi-rs/canvas'),
        scale: 1.5,
        toDataURL: true,
      });

      const result = await extractTextFromImage(apiKey, dataUrl);
      usage = {
        promptTokens: usage.promptTokens + result.usage.promptTokens,
        completionTokens: usage.completionTokens + result.usage.completionTokens,
        totalTokens: usage.totalTokens + result.usage.totalTokens,
      };

      const cleaned = cleanText(result.text);
      if (cleaned) {
        pages[pageNumber - 1] = { pageNumber, text: cleaned };
      }

      completedPages += 1;
      await onProgress?.({ completedPages, totalPages });
    }
  }

  const workers = Array.from({ length: Math.min(OCR_CONCURRENCY, totalPages) }, () => worker());
  await Promise.all(workers);

  return {
    pages: pages.filter((page): page is PageText => Boolean(page?.text)),
    usage,
    pageCount: totalPages,
  };
}
