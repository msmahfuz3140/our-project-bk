/**
 * One-time migration for commissions that were created before the wallet ledger
 * existed. Dry-run by default; pass --apply to credit wallets.
 *
 * IMPORTANT: If commissions were already paid outside this wallet system,
 * reconcile those payouts before applying this migration. The script is
 * idempotent and never deletes or edits historical commission amounts.
 */
import mongoose from 'mongoose';
import { db } from '../database/connection';
import { ReferralCommissionModel } from '../models/ReferralCommission';
import { WalletTransactionModel } from '../models/WalletTransaction';
import { walletService } from '../services/wallet.service';

async function run() {
  const apply = process.argv.includes('--apply');
  await db.connect();

  const commissions = await ReferralCommissionModel.find({
    status: { $in: ['CREDITED', 'APPROVED'] },
    $or: [
      { walletTransactionId: { $exists: false } },
      { walletTransactionId: null }
    ]
  }).sort({ createdAt: 1 });

  console.log(`Legacy commissions eligible for wallet backfill: ${commissions.length}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (pass --apply to credit wallets)'}`);

  let totalCents = 0;
  let credited = 0;

  for (const commission of commissions) {
    const cents = Math.round(Number(commission.amountUsd || 0) * 100);
    totalCents += cents;
    console.log(
      `- ${commission._id} | referrer ${commission.moderatorId} | $${(cents / 100).toFixed(2)} | ${commission.purchaseId || commission.paymentId}`
    );

    if (!apply) continue;

    try {
      const existing = await WalletTransactionModel.findOne({
        idempotencyKey: `commission-wallet:${commission._id}`
      });

      const transaction =
        existing ||
        (await walletService.credit({
          userId: commission.moderatorId.toString(),
          amountCents: cents,
          countAsCommission: true,
          context: {
            type: 'REFERRAL_COMMISSION',
            idempotencyKey: `commission-wallet:${commission._id}`,
            relatedUserId: commission.referredUserId?.toString(),
            relatedPaymentId: commission.paymentId?.toString(),
            relatedSubscriptionId: commission.subscriptionId?.toString(),
            relatedCommissionId: commission._id.toString(),
            reason: 'Legacy commission wallet backfill'
          }
        }));

      commission.walletTransactionId = transaction._id as mongoose.Types.ObjectId;
      commission.status = 'CREDITED';
      await commission.save();
      credited++;
    } catch (error: any) {
      console.error(`  Failed to backfill ${commission._id}: ${error?.message}`);
    }
  }

  console.log(`\nTotal legacy commission value: $${(totalCents / 100).toFixed(2)}`);
  console.log(`Credited: ${credited}`);
  await db.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await db.disconnect().catch(() => null);
  process.exit(1);
});
