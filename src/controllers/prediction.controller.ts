import { Request, Response } from 'express';
import { predictionService } from '../services/prediction.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export class PredictionController {
  getLobby(req: Request, res: Response): void {
    const tables = predictionService.getLobbyTables();
    res.status(200).json({
      success: true,
      data: tables
    });
  }

  getTableAnalysis(req: AuthenticatedRequest, res: Response): void {
    const rawTableId = req.params.tableId;
    const tableId = Array.isArray(rawTableId) ? rawTableId[0] : (rawTableId || '');
    const hasPremium = !!req.user?.hasActiveSubscription;
    const analysis = predictionService.getTableAnalysis(tableId, hasPremium);

    res.status(200).json({
      success: true,
      data: analysis
    });
  }
}

export const predictionController = new PredictionController();
