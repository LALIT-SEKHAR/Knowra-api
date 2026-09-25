import mongoose from 'mongoose';
import { Membership } from '../../models/Membership.js';
import { Organization, type OrganizationDocument } from '../../models/Organization.js';
import { User, type UserDocument } from '../../models/User.js';
import { AppError } from '../../utils/errors.js';

export type WorkspaceRole = 'personal' | 'admin' | 'member';

export type Workspace = {
  orgId: mongoose.Types.ObjectId | null;
  role: WorkspaceRole;
  canManage: boolean;
  org: OrganizationDocument | null;
};

export type OrgSummary = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  role: 'admin' | 'member';
};

const NAME_MAX = 80;

export function normalizeOrgName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2 || trimmed.length > NAME_MAX) {
    throw new AppError(`Organization name must be 2–${NAME_MAX} characters`, 400);
  }
  return trimmed;
}

export function nameKeyOf(name: string): string {
  return normalizeOrgName(name).toLowerCase();
}

export function slugifyOrgName(name: string): string {
  const base = nameKeyOf(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return base || 'org';
}

export function libraryFilter(workspace: Workspace, userId: mongoose.Types.ObjectId) {
  if (workspace.orgId) return { orgId: workspace.orgId };
  return { userId, orgId: null };
}

export function conversationFilter(workspace: Workspace, userId: mongoose.Types.ObjectId) {
  return { userId, orgId: workspace.orgId };
}

export async function listMemberships(userId: mongoose.Types.ObjectId): Promise<OrgSummary[]> {
  const memberships = await Membership.find({ userId, blocked: { $ne: true } }).sort({ createdAt: 1 });
  if (memberships.length === 0) return [];
  const orgs = await Organization.find({
    _id: { $in: memberships.map((m) => m.orgId) },
  }).select('name slug logoUrl');
  const byId = new Map(orgs.map((org) => [org._id.toString(), org]));
  return memberships.flatMap((membership) => {
    const org = byId.get(membership.orgId.toString());
    if (!org) return [];
    return [
      {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        imageUrl: org.logoUrl ?? null,
        role: membership.role as 'admin' | 'member',
      },
    ];
  });
}

export async function resolveWorkspace(user: UserDocument): Promise<Workspace> {
  if (!user.activeOrgId) {
    return { orgId: null, role: 'personal', canManage: true, org: null };
  }

  const membership = await Membership.findOne({
    userId: user._id,
    orgId: user.activeOrgId,
  });
  const org = membership ? await Organization.findById(membership.orgId) : null;
  if (!membership || !org || membership.blocked) {
    user.activeOrgId = null;
    await user.save();
    return { orgId: null, role: 'personal', canManage: true, org: null };
  }

  const role = membership.role === 'admin' ? 'admin' : 'member';
  return {
    orgId: org._id,
    role,
    canManage: role === 'admin',
    org,
  };
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 2;
  while (await Organization.exists({ slug })) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

export async function assertOrgNameAvailable(name: string): Promise<{ name: string; slug: string }> {
  const clean = normalizeOrgName(name);
  const taken = await Organization.exists({ nameKey: nameKeyOf(clean) });
  if (taken) throw new AppError('That organization name is already taken', 409);
  return { name: clean, slug: slugifyOrgName(clean) };
}

export async function createOrganization(user: UserDocument, name: string) {
  const clean = normalizeOrgName(name);
  const key = nameKeyOf(clean);
  const existing = await Organization.findOne({ nameKey: key });
  if (existing) throw new AppError('That organization name is already taken', 409);

  const org = await Organization.create({
    name: clean,
    nameKey: key,
    slug: await uniqueSlug(slugifyOrgName(clean)),
    createdBy: user._id,
  });
  await Membership.create({ userId: user._id, orgId: org._id, role: 'admin' });
  user.activeOrgId = org._id;
  await user.save();
  return org;
}

export async function joinOrganization(user: UserDocument, slug: string) {
  const org = await Organization.findOne({ slug: slug.trim().toLowerCase() });
  if (!org) throw new AppError('Organization invite not found', 404);

  const existing = await Membership.findOne({ userId: user._id, orgId: org._id });
  if (existing?.blocked) {
    throw new AppError('You are blocked from this organization', 403);
  }
  if (!existing && org.joinsEnabled === false) {
    throw new AppError('This organization is not accepting new members', 403);
  }
  if (!existing) {
    await Membership.create({ userId: user._id, orgId: org._id, role: 'member' });
  }
  user.activeOrgId = org._id;
  await user.save();
  return org;
}

export async function switchWorkspace(user: UserDocument, orgId: string | null) {
  if (!orgId) {
    user.activeOrgId = null;
    await user.save();
    return;
  }
  if (!mongoose.isValidObjectId(orgId)) throw new AppError('Organization not found', 404);
  const membership = await Membership.findOne({ userId: user._id, orgId });
  if (!membership) throw new AppError('You are not a member of that organization', 403);
  if (membership.blocked) throw new AppError('You are blocked from this organization', 403);
  user.activeOrgId = membership.orgId;
  await user.save();
}

export async function leavePreview(user: UserDocument, orgId: string) {
  if (!mongoose.isValidObjectId(orgId)) throw new AppError('Organization not found', 404);
  const membership = await Membership.findOne({ userId: user._id, orgId });
  if (!membership || membership.blocked) {
    throw new AppError('You are not a member of that organization', 404);
  }
  const needing = await orgsNeedingSuccessor(user._id.toString());
  const needs = needing.find((org) => org.id === String(orgId));
  if (!needs) return { needsSuccessor: false, members: [] as LeaveCandidate[] };

  const others = await Membership.find({
    orgId,
    blocked: { $ne: true },
    userId: { $ne: user._id },
  }).sort({ createdAt: 1 });
  const people = await User.find({ _id: { $in: others.map((row) => row.userId) } }).select(
    'name email avatarUrl',
  );
  const byId = new Map(people.map((person) => [person._id.toString(), person]));
  const members = others.flatMap((row) => {
    const person = byId.get(row.userId.toString());
    if (!person?.email) return [];
    return [
      {
        id: person._id.toString(),
        name: person.name ?? null,
        email: person.email,
        avatarUrl: person.avatarUrl ?? null,
      },
    ];
  });
  return { needsSuccessor: true, members };
}

type LeaveCandidate = {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
};

export async function leaveOrganization(user: UserDocument, orgId: string, successorId?: string) {
  if (!mongoose.isValidObjectId(orgId)) throw new AppError('Organization not found', 404);
  const membership = await Membership.findOne({ userId: user._id, orgId });
  if (!membership || membership.blocked) {
    throw new AppError('You are not a member of that organization', 404);
  }
  const needing = await orgsNeedingSuccessor(user._id.toString());
  const blocked = needing.find((org) => org.id === String(orgId));
  let promotedUserId: string | null = null;
  if (blocked) {
    if (!successorId || !mongoose.isValidObjectId(successorId)) {
      throw new AppError('Choose the next admin before you leave.', 409);
    }
    if (successorId === user._id.toString()) {
      throw new AppError('Choose someone else as the next admin.', 400);
    }
    const successor = await Membership.findOne({
      orgId,
      userId: successorId,
      blocked: { $ne: true },
    });
    if (!successor) throw new AppError('That person is not in this organization', 404);
    if (successor.role !== 'admin') {
      successor.role = 'admin';
      await successor.save();
      promotedUserId = successor.userId.toString();
    }
  }
  await membership.deleteOne();
  const leftActive = user.activeOrgId?.toString() === String(orgId);
  if (leftActive) {
    user.activeOrgId = null;
    await user.save();
  }
  return { leftActive, promotedUserId };
}

/** Orgs where this user is the only admin and someone else could take over. */
export async function orgsNeedingSuccessor(userId: string): Promise<{ id: string; name: string }[]> {
  const adminOf = await Membership.find({ userId, role: 'admin', blocked: { $ne: true } });
  const needing: { id: string; name: string }[] = [];
  for (const membership of adminOf) {
    const otherAdmin = await Membership.exists({
      orgId: membership.orgId,
      role: 'admin',
      blocked: { $ne: true },
      userId: { $ne: userId },
    });
    if (otherAdmin) continue;
    const otherMember = await Membership.exists({
      orgId: membership.orgId,
      blocked: { $ne: true },
      userId: { $ne: userId },
    });
    if (!otherMember) continue;
    const org = await Organization.findById(membership.orgId).select('name');
    if (org) needing.push({ id: org._id.toString(), name: org.name });
  }
  return needing;
}

export function publicOrg(org: OrganizationDocument) {
  return { id: org._id.toString(), name: org.name, slug: org.slug };
}
