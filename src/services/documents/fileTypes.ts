const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

export function mimeFromFilename(filename: string): DocumentMimeType | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  if (!match?.[1]) return null;
  const mime = EXTENSION_MIME[match[1].toLowerCase()];
  return mime ? (mime as DocumentMimeType) : null;
}

export function isDocumentMime(mime: string): mime is DocumentMimeType {
  return (DOCUMENT_MIME_TYPES as readonly string[]).includes(mime);
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

const WORD_MIME = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const EXCEL_MIME = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export function isWordMime(mime: string): boolean {
  return WORD_MIME.has(mime);
}

export function isExcelMime(mime: string): boolean {
  return EXCEL_MIME.has(mime);
}

export function isOfficeMime(mime: string): boolean {
  return isWordMime(mime) || isExcelMime(mime);
}

export function assertImageBytes(buffer: Buffer): void {
  if (buffer.length < 12) {
    throw new Error('This image could not be read.');
  }
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isGif = buffer.subarray(0, 3).toString('ascii') === 'GIF';
  const isWebp =
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isJpeg && !isPng && !isGif && !isWebp) {
    throw new Error('This image could not be read.');
  }
}
