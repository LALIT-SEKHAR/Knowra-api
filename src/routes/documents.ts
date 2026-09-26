import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireManager } from '../middleware/auth.js';
import { env } from '../config/env.js';
import {
  chatDocumentHandler,
  deleteDocumentHandler,
  downloadDocumentHandler,
  getDocumentHandler,
  listDocumentsHandler,
  mentionableFilesHandler,
  renameDocumentHandler,
  previewDocumentHandler,
  retryDocumentHandler,
  abortUploadHandler,
  createFolderHandler,
  deleteFolderHandler,
  ensureFolderHandler,
  listFoldersHandler,
  updateFolderHandler,
  uploadDocumentHandler,
  uploadSignatureHandler,
} from '../controllers/documentsController.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
});

router.use(requireAuth);
router.get('/mentionable', mentionableFilesHandler);
router.use(requireManager);
router.get('/', listDocumentsHandler);
router.get('/upload-signature', uploadSignatureHandler);
router.post('/upload-abort', abortUploadHandler);
router.get('/folders', listFoldersHandler);
router.post('/folders/ensure', ensureFolderHandler);
router.post('/folders', createFolderHandler);
router.patch('/folders/:id', updateFolderHandler);
router.delete('/folders/:id', deleteFolderHandler);
router.post('/', upload.single('file'), uploadDocumentHandler);
router.get('/:id', getDocumentHandler);
router.get('/:id/file', downloadDocumentHandler);
router.get('/:id/preview', previewDocumentHandler);
router.patch('/:id', renameDocumentHandler);
router.delete('/:id', deleteDocumentHandler);
router.post('/:id/retry', retryDocumentHandler);
router.post('/:id/chat', chatDocumentHandler);

export default router;
