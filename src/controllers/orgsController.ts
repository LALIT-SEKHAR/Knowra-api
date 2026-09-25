import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { Organization } from '../models/Organization.js';
import { Membership } from '../models/Membership.js';
import { User } from '../models/User.js';
import { sendAdminUpgradeEmail } from '../services/mail/mailer.js';
import {
  deleteCloudinaryImage,
  isAllowedAvatarMime,
  uploadAvatarBuffer,
} from '../services/cloudinary/storage.js';
import {
  assertOrgNameAvailable,
  createOrganization,
  joinOrganization,
  listMemberships,
  publicOrg,
  leaveOrganization,
  leavePreview,
  switchWorkspace,
} from '../services/orgs/workspace.js';

const nameSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

const switchSchema = z.object({
  orgId: z.string().nullable(),
});

export const orgAvailabilityHandler = asyncHandler(async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  const result = await assertOrgNameAvailable(name);
  res.json({ available: true, ...result });
});

export const orgInviteHandler = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const org = await Organization.findOne({ slug }).select('name slug joinsEnabled');
  if (!org) throw new AppError('Organization invite not found', 404);
  res.json({
    organization: { name: org.name, slug: org.slug, joinsEnabled: org.joinsEnabled !== false },
  });
});

export const listOrgsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const memberships = await listMemberships(req.user!._id);
  res.json({
    organizations: memberships,
    activeOrgId: req.workspace?.orgId?.toString() ?? null,
  });
});

export const createOrgHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;
  const freshAccount = Date.now() - createdAt < 30 * 60 * 1000;
  const alreadyMember = await Membership.exists({ userId: user._id });
  if (!freshAccount || alreadyMember) {
    throw new AppError('An organization can only be created when you sign up', 403);
  }
  const body = nameSchema.parse(req.body);
  const org = await createOrganization(user, body.name);
  res.status(201).json({ organization: publicOrg(org), role: 'admin' });
});

export const joinOrgHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = await joinOrganization(req.user!, String(req.params.slug || ''));
  const membership = await Membership.findOne({ userId: req.user!._id, orgId: org._id });
  res.json({
    organization: publicOrg(org),
    role: membership?.role ?? 'member',
  });
});

const leaveSchema = z.object({
  successorId: z.string().optional(),
});

export const leavePreviewHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const preview = await leavePreview(req.user!, String(req.params.orgId || ''));
  res.json(preview);
});

export const leaveOrgHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = leaveSchema.parse(req.body ?? {});
  const orgId = String(req.params.orgId || '');
  const org = await Organization.findById(orgId).select('name');
  const result = await leaveOrganization(req.user!, orgId, body.successorId);
  if (result.promotedUserId && org) {
    const person = await User.findById(result.promotedUserId).select('email');
    if (person?.email) {
      const promoter = req.user?.name?.trim() || req.user?.email || null;
      await sendAdminUpgradeEmail({
        email: person.email,
        orgName: org.name,
        promotedBy: promoter,
      });
    }
  }
  res.json({ ok: true, leftActive: result.leftActive });
});

export const switchOrgHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = switchSchema.parse(req.body);
  await switchWorkspace(req.user!, body.orgId);
  res.json({ ok: true, activeOrgId: body.orgId });
});

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

function requireOrgAdmin(req: AuthedRequest) {
  const org = req.workspace?.org;
  if (!org || !req.workspace?.canManage) {
    throw new AppError('Only an organization admin can do that', 403);
  }
  return org;
}

export const uploadOrgLogoHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const file = req.file;
  if (!file) throw new AppError('Image file is required', 400);
  if (!isAllowedAvatarMime(file.mimetype)) {
    throw new AppError('Logo must be a JPEG, PNG, WebP, or GIF image', 400);
  }
  if (file.size > LOGO_MAX_BYTES) throw new AppError('Logo must be 2MB or smaller', 400);

  const previousPublicId = org.logoPublicId;
  const uploaded = await uploadAvatarBuffer(file.buffer, file.originalname, org._id.toString());
  org.logoUrl = uploaded.url;
  org.logoPublicId = uploaded.publicId;
  await org.save();

  if (previousPublicId && previousPublicId !== uploaded.publicId) {
    try {
      await deleteCloudinaryImage(previousPublicId);
    } catch {
      // Best-effort cleanup of the previous logo
    }
  }

  res.json({ organization: { ...publicOrg(org), imageUrl: org.logoUrl } });
});

export const deleteOrgLogoHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const previousPublicId = org.logoPublicId;
  org.logoUrl = undefined;
  org.logoPublicId = undefined;
  await org.save();
  if (previousPublicId) {
    try {
      await deleteCloudinaryImage(previousPublicId);
    } catch {
      // Best-effort cleanup
    }
  }
  res.json({ organization: { ...publicOrg(org), imageUrl: null } });
});

const joinsSchema = z.object({
  enabled: z.boolean(),
});

export const setOrgJoinsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const body = joinsSchema.parse(req.body);
  org.joinsEnabled = body.enabled;
  await org.save();
  res.json({ joinsEnabled: org.joinsEnabled !== false });
});

export const listOrgMembersHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const memberships = await Membership.find({ orgId: org._id }).sort({ createdAt: 1 });
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select(
    'name email avatarUrl',
  );
  const byId = new Map(users.map((user) => [user._id.toString(), user]));
  const members = memberships.flatMap((membership) => {
    const person = byId.get(membership.userId.toString());
    if (!person) return [];
    const name = person.name ?? '';
    const email = person.email ?? '';
    if (q && !name.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) return [];
    return [
      {
        id: person._id.toString(),
        name: name || null,
        email,
        avatarUrl: person.avatarUrl ?? null,
        role: membership.role,
        blocked: Boolean(membership.blocked),
      },
    ];
  });
  res.json({ members });
});

export const makeOrgAdminHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const membership = await Membership.findOne({ orgId: org._id, userId: req.params.userId });
  if (!membership) throw new AppError('That person is not in this organization', 404);
  if (membership.blocked) throw new AppError('Unblock this person before making them an admin', 400);
  const alreadyAdmin = membership.role === 'admin';
  membership.role = 'admin';
  await membership.save();
  if (!alreadyAdmin) {
    const person = await User.findById(membership.userId).select('email name');
    if (person?.email) {
      const promoter = req.user?.name?.trim() || req.user?.email || null;
      await sendAdminUpgradeEmail({
        email: person.email,
        orgName: org.name,
        promotedBy: promoter,
      });
    }
  }
  res.json({ ok: true });
});

export const removeOrgAdminHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const userId = String(req.params.userId);
  if (userId === req.user!._id.toString()) {
    throw new AppError('You cannot remove your own admin access', 400);
  }
  const membership = await Membership.findOne({ orgId: org._id, userId });
  if (!membership) throw new AppError('That person is not in this organization', 404);
  if (membership.role !== 'admin') throw new AppError('That person is not an admin', 400);
  const otherAdmins = await Membership.countDocuments({
    orgId: org._id,
    role: 'admin',
    blocked: { $ne: true },
    userId: { $ne: userId },
  });
  if (otherAdmins === 0) throw new AppError('The organization needs at least one admin', 400);
  membership.role = 'member';
  await membership.save();
  res.json({ ok: true });
});

export const blockOrgMemberHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const userId = String(req.params.userId);
  if (userId === req.user!._id.toString()) {
    throw new AppError('You cannot block yourself', 400);
  }
  const membership = await Membership.findOne({ orgId: org._id, userId });
  if (!membership) throw new AppError('That person is not in this organization', 404);
  if (membership.role === 'admin') {
    const otherAdmins = await Membership.countDocuments({
      orgId: org._id,
      role: 'admin',
      blocked: { $ne: true },
      userId: { $ne: userId },
    });
    if (otherAdmins === 0) throw new AppError('The organization needs at least one admin', 400);
  }
  membership.blocked = true;
  await membership.save();
  await User.updateOne({ _id: userId, activeOrgId: org._id }, { $set: { activeOrgId: null } });
  res.json({ ok: true });
});

export const unblockOrgMemberHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const org = requireOrgAdmin(req);
  const membership = await Membership.findOne({ orgId: org._id, userId: req.params.userId });
  if (!membership) throw new AppError('That person is not in this organization', 404);
  membership.blocked = false;
  await membership.save();
  res.json({ ok: true });
});
