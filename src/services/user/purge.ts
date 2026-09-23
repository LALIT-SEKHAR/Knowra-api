import { Chunk } from '../../models/Chunk.js';
import { Conversation } from '../../models/Conversation.js';
import { DocumentModel } from '../../models/Document.js';
import { Job } from '../../models/Job.js';
import { Message } from '../../models/Message.js';
import { Otp } from '../../models/Otp.js';
import { UsageDaily } from '../../models/UsageDaily.js';
import { User } from '../../models/User.js';
import { ACCOUNT_DELETION_GRACE_DAYS } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import {
  cloudinaryIdsOf,
  deleteCloudinaryFile,
  deleteCloudinaryImage,
} from '../cloudinary/storage.js';

export async function clearUserChatHistory(userId: string): Promise<{ deletedConversations: number }> {
  const conversations = await Conversation.find({ userId }).select('_id');
  const ids = conversations.map((c) => c._id);
  if (ids.length > 0) {
    await Message.deleteMany({ conversationId: { $in: ids } });
    await Conversation.deleteMany({ _id: { $in: ids }, userId });
  }
  return { deletedConversations: ids.length };
}

export async function deleteAllUserDocuments(userId: string): Promise<{ deletedDocuments: number }> {
  const documents = await DocumentModel.find({ userId }).select(
    '_id cloudinaryPublicId cloudinaryParts',
  );
  const documentIds = documents.map((d) => d._id);

  for (const doc of documents) {
    for (const publicId of cloudinaryIdsOf(doc)) {
      try {
        await deleteCloudinaryFile(publicId);
      } catch (err) {
        console.error('Cloudinary delete failed during bulk document delete', err);
      }
    }
  }

  if (documentIds.length > 0) {
    await Chunk.deleteMany({ userId, documentId: { $in: documentIds } });

    const scopedConversations = await Conversation.find({
      userId,
      documentId: { $in: documentIds },
    }).select('_id');
    const conversationIds = scopedConversations.map((c) => c._id);
    if (conversationIds.length > 0) {
      await Message.deleteMany({ conversationId: { $in: conversationIds } });
      await Conversation.deleteMany({ _id: { $in: conversationIds }, userId });
    }

    await DocumentModel.deleteMany({ userId, _id: { $in: documentIds } });
  }

  await Job.deleteMany({
    type: { $in: ['process_document', 'delete_document'] },
    'payload.userId': userId,
  });

  return { deletedDocuments: documentIds.length };
}

/** Full wipe of every record tied to this user (DB + Cloudinary). */
export async function purgeUserDataCompletely(userId: string): Promise<void> {
  const user = await User.findById(userId);
  if (!user) return;

  const email = user.email?.toLowerCase();

  const conversations = await Conversation.find({ userId }).select('_id');
  const conversationIds = conversations.map((c) => c._id);
  if (conversationIds.length > 0) {
    await Message.deleteMany({ conversationId: { $in: conversationIds } });
  }
  await Conversation.deleteMany({ userId });

  const documents = await DocumentModel.find({ userId }).select(
    '_id cloudinaryPublicId cloudinaryParts',
  );
  for (const doc of documents) {
    for (const publicId of cloudinaryIdsOf(doc)) {
      try {
        await deleteCloudinaryFile(publicId);
      } catch (err) {
        console.error('Cloudinary delete failed during account purge', err);
      }
    }
  }
  await Chunk.deleteMany({ userId });
  await DocumentModel.deleteMany({ userId });
  await Job.deleteMany({ 'payload.userId': userId });
  await UsageDaily.deleteMany({ userId });

  if (user.avatarPublicId) {
    try {
      await deleteCloudinaryImage(user.avatarPublicId);
    } catch (err) {
      console.error('Avatar delete failed during account purge', err);
    }
  }

  if (email) {
    await Otp.deleteMany({ email });
  }

  await User.deleteOne({ _id: userId });
}

export async function scheduleAccountDeletion(userId: string): Promise<{
  deletionScheduledFor: Date;
  deletionRequestedAt: Date;
  alreadyScheduled: boolean;
}> {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);

  if (user.deletionScheduledFor && user.deletionScheduledFor.getTime() > Date.now()) {
    return {
      deletionScheduledFor: user.deletionScheduledFor,
      deletionRequestedAt: user.deletionRequestedAt ?? user.deletionScheduledFor,
      alreadyScheduled: true,
    };
  }

  const deletionRequestedAt = new Date();
  const deletionScheduledFor = new Date(
    deletionRequestedAt.getTime() + ACCOUNT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
  );

  user.deletionRequestedAt = deletionRequestedAt;
  user.deletionScheduledFor = deletionScheduledFor;
  await user.save();

  await Job.deleteMany({
    type: 'purge_account',
    'payload.userId': userId,
    status: { $in: ['pending', 'failed', 'processing'] },
  });

  return { deletionScheduledFor, deletionRequestedAt, alreadyScheduled: false };
}

export async function cancelAccountDeletion(userId: string): Promise<boolean> {
  const user = await User.findById(userId).select('deletionScheduledFor');
  if (!user) return false;

  const hadPending =
    Boolean(user.deletionScheduledFor) && user.deletionScheduledFor!.getTime() > Date.now();

  await User.updateOne(
    { _id: userId },
    { $unset: { deletionRequestedAt: 1, deletionScheduledFor: 1 } },
  );

  await Job.deleteMany({
    type: 'purge_account',
    'payload.userId': userId,
    status: { $in: ['pending', 'failed'] },
  });

  return hadPending;
}
