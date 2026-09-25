import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import {
  blockOrgMemberHandler,
  createOrgHandler,
  deleteOrgLogoHandler,
  joinOrgHandler,
  leaveOrgHandler,
  leavePreviewHandler,
  listOrgMembersHandler,
  setOrgJoinsHandler,
  listOrgsHandler,
  makeOrgAdminHandler,
  removeOrgAdminHandler,
  orgAvailabilityHandler,
  orgInviteHandler,
  switchOrgHandler,
  unblockOrgMemberHandler,
  uploadOrgLogoHandler,
} from '../controllers/orgsController.js';

const router = Router();

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

router.get('/availability', orgAvailabilityHandler);
router.get('/invite/:slug', orgInviteHandler);
router.get('/', requireAuth, listOrgsHandler);
router.post('/', requireAuth, createOrgHandler);
router.post('/join/:slug', requireAuth, joinOrgHandler);
router.put('/active', requireAuth, switchOrgHandler);
router.get('/:orgId/leave', requireAuth, leavePreviewHandler);
router.post('/:orgId/leave', requireAuth, leaveOrgHandler);
router.get('/members', requireAuth, listOrgMembersHandler);
router.put('/joins', requireAuth, setOrgJoinsHandler);
router.post('/members/:userId/admin', requireAuth, makeOrgAdminHandler);
router.post('/members/:userId/member', requireAuth, removeOrgAdminHandler);
router.post('/members/:userId/block', requireAuth, blockOrgMemberHandler);
router.post('/members/:userId/unblock', requireAuth, unblockOrgMemberHandler);
router.post('/logo', requireAuth, logoUpload.single('logo'), uploadOrgLogoHandler);
router.delete('/logo', requireAuth, deleteOrgLogoHandler);

export default router;
