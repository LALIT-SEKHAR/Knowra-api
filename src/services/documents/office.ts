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
