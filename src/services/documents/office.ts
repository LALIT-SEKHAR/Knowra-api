import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { isExcelMime, isWordMime } from './fileTypes.js';
import { cleanText, type PageText } from './parser.js';

const require = createRequire(import.meta.url);
const WordExtractor = require('word-extractor') as new () => {
  extract(source: Buffer): Promise<{ getBody: () => string }>;
};

function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function isOle(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0
  );
}

function excelCellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value && value.result !== undefined) {
      return excelCellText(value.result);
    }
  }
  return '';
}

function sheetLines(name: string, rows: string[][]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const line = row.map((cell) => cell.trim()).join('\t').trim();
    if (line) lines.push(line);
  }
  if (lines.length === 0) return '';
  return cleanText([`Sheet: ${name}`, ...lines].join('\n'));
}

async function extractDocx(buffer: Buffer): Promise<PageText[]> {
  if (!isZip(buffer)) throw new Error('This Word document could not be read.');
  let text = '';
  try {
    const result = await mammoth.extractRawText({ buffer });
    text = cleanText(result.value);
  } catch {
    throw new Error('This Word document could not be read.');
  }
  return text ? [{ pageNumber: 1, text }] : [];
}

async function extractDoc(buffer: Buffer): Promise<PageText[]> {
  if (!isOle(buffer)) throw new Error('This Word document could not be read.');
  try {
    const extracted = await new WordExtractor().extract(buffer);
    const text = cleanText(extracted.getBody());
    return text ? [{ pageNumber: 1, text }] : [];
  } catch (error) {
    if (error instanceof Error && error.message === 'This Word document could not be read.') throw error;
    throw new Error('This Word document could not be read.');
  }
}

async function extractXlsx(buffer: Buffer): Promise<PageText[]> {
  if (!isZip(buffer)) throw new Error('This spreadsheet could not be read.');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new Error('This spreadsheet could not be read.');
  }

  const pages: PageText[] = [];
  workbook.eachSheet((sheet, index) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = excelCellText(cell.value).trim();
        if (text) cells.push(text);
      });
      if (cells.length > 0) rows.push(cells);
    });
    const text = sheetLines(sheet.name, rows);
    if (text) pages.push({ pageNumber: index, text });
  });
  return pages.map((page, index) => ({ ...page, pageNumber: index + 1 }));
}

function extractXls(buffer: Buffer): PageText[] {
  if (!isOle(buffer)) throw new Error('This spreadsheet could not be read.');
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw new Error('This spreadsheet could not be read.');
  }

  const pages: PageText[] = [];
  workbook.SheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return;
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    const text = sheetLines(
      name,
      rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
    );
    if (text) pages.push({ pageNumber: index + 1, text });
  });
  return pages.map((page, index) => ({ ...page, pageNumber: index + 1 }));
}

export async function extractOfficePages(buffer: Buffer, mimeType: string): Promise<PageText[]> {
  if (!buffer?.length) throw new Error('This file is empty.');
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocx(buffer);
  }
  if (mimeType === 'application/msword') return extractDoc(buffer);
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return extractXlsx(buffer);
  }
  if (mimeType === 'application/vnd.ms-excel') return extractXls(buffer);
  if (isWordMime(mimeType)) return extractDocx(buffer);
  if (isExcelMime(mimeType)) return extractXlsx(buffer);
  throw new Error('This file could not be read.');
}

export type PreviewPage = { pageNumber: number; html: string };

const PREVIEW_MAX_ROWS = 400;
const PREVIEW_MAX_COLS = 40;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphsToHtml(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function tableHtml(name: string, rows: string[][]): string {
  let width = 0;
  for (const row of rows) {
    let end = row.length;
    while (end > 0 && !(row[end - 1] ?? '').trim()) end -= 1;
    width = Math.max(width, end);
  }
  const truncatedCols = width > PREVIEW_MAX_COLS;
  if (truncatedCols) width = PREVIEW_MAX_COLS;
  const used = rows.filter((row) => row.slice(0, width).some((cell) => (cell ?? '').trim()));
  if (width === 0 || used.length === 0) return '';
  const truncatedRows = used.length > PREVIEW_MAX_ROWS;
  const visible = truncatedRows ? used.slice(0, PREVIEW_MAX_ROWS) : used;
  const body = visible
    .map((row) => {
      const cells = Array.from({ length: width }, (_, index) => {
        return `<td>${escapeHtml(row[index] ?? '')}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  const note =
    truncatedRows || truncatedCols
      ? `<p>Showing the first ${visible.length} rows and ${width} columns.</p>`
      : '';
  return `<h2>${escapeHtml(name)}</h2><table>${body}</table>${note}`;
}

function xlsxRows(sheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      const col = typeof cell.col === 'number' ? cell.col : Number(cell.col);
      if (!Number.isFinite(col) || col < 1) return;
      cells[col - 1] = excelCellText(cell.value);
    });
    if (cells.some((cell) => cell?.trim())) rows.push(cells.map((cell) => cell ?? ''));
  });
  return rows;
}

async function previewDocx(buffer: Buffer): Promise<PreviewPage[]> {
  if (!isZip(buffer)) throw new Error('This Word document could not be read.');
  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
        ],
      },
    );
    const html = result.value.trim();
    return html ? [{ pageNumber: 1, html }] : [];
  } catch {
    throw new Error('This Word document could not be read.');
  }
}

async function previewDoc(buffer: Buffer): Promise<PreviewPage[]> {
  const pages = await extractDoc(buffer);
  const html = paragraphsToHtml(pages[0]?.text ?? '');
  return html ? [{ pageNumber: 1, html }] : [];
}

async function previewXlsx(buffer: Buffer): Promise<PreviewPage[]> {
  if (!isZip(buffer)) throw new Error('This spreadsheet could not be read.');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new Error('This spreadsheet could not be read.');
  }
  const pages: PreviewPage[] = [];
  workbook.eachSheet((sheet) => {
    const html = tableHtml(sheet.name, xlsxRows(sheet));
    if (html) pages.push({ pageNumber: pages.length + 1, html });
  });
  return pages;
}

function previewXls(buffer: Buffer): PreviewPage[] {
  if (!isOle(buffer)) throw new Error('This spreadsheet could not be read.');
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw new Error('This spreadsheet could not be read.');
  }
  const pages: PreviewPage[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    const html = tableHtml(
      name,
      rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
    );
    if (html) pages.push({ pageNumber: pages.length + 1, html });
  }
  return pages;
}

export async function previewOfficePages(buffer: Buffer, mimeType: string): Promise<PreviewPage[]> {
  if (!buffer?.length) throw new Error('This file is empty.');
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return previewDocx(buffer);
  }
  if (mimeType === 'application/msword') return previewDoc(buffer);
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return previewXlsx(buffer);
  }
  if (mimeType === 'application/vnd.ms-excel') return previewXls(buffer);
  if (isWordMime(mimeType)) return previewDocx(buffer);
  if (isExcelMime(mimeType)) return previewXlsx(buffer);
  throw new Error('This file could not be read.');
}
