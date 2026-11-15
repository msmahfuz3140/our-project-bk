import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { dashboardService } from '../services/dashboard.service';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware';

class DashboardController {
  async getMyDashboard(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await dashboardService.getMemberDashboard(req.user!.id);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
}

const controller = new DashboardController();
const router = Router();

router.get('/me', requireAuth, (req, res, next) =>
  controller.getMyDashboard(req as AuthenticatedRequest, res, next)
);

export const dashboardRoutes = router;
