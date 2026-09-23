import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config/env.js';
import {
  chatDocumentHandler,
  deleteDocumentHandler,
  downloadDocumentHandler,
  getDocumentHandler,
  listDocumentsHandler,
  renameDocumentHandler,
  previewDocumentHandler,
  retryDocumentHandler,
  abortUploadHandler,
  uploadDocumentHandler,
  uploadSignatureHandler,
} from '../controllers/documentsController.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
});

router.use(requireAuth);
router.get('/', listDocumentsHandler);
router.get('/upload-signature', uploadSignatureHandler);
router.post('/upload-abort', abortUploadHandler);
router.post('/', upload.single('file'), uploadDocumentHandler);
router.get('/:id', getDocumentHandler);
router.get('/:id/file', downloadDocumentHandler);
router.get('/:id/preview', previewDocumentHandler);
router.patch('/:id', renameDocumentHandler);
router.delete('/:id', deleteDocumentHandler);
router.post('/:id/retry', retryDocumentHandler);
router.post('/:id/chat', chatDocumentHandler);

export default router;
