import { Router } from 'express';
import { walletController } from '../controllers/wallet.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rateLimit.middleware';

const router = Router();

router.use(requireAuth);

router.get('/me', (req, res, next) => walletController.getMyWallet(req, res, next));
router.get('/transactions', (req, res, next) => walletController.getMyTransactions(req, res, next));
router.get('/withdrawals', (req, res, next) => walletController.getMyWithdrawals(req, res, next));
router.post('/withdrawals', rateLimit(10, 15, 'wallet_withdrawal'), (req, res, next) =>
  walletController.requestWithdrawal(req, res, next)
);

export const walletRoutes = router;
