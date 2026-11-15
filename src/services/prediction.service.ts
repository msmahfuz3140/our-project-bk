import { TableAnalysisResponse } from '../shared/predictions';
import { ApiError } from '../utils/apiError';

/**
 * Legacy prediction facade.
 *
 * The original implementation returned hardcoded demo tables and fabricated
 * analysis. The real live product now uses the authenticated Dealer Signature
 * proxy (/api/v1/ds/...). This facade deliberately returns no fabricated data.
 */
export class PredictionService {
  getLobbyTables(): [] {
    return [];
  }

  getTableAnalysis(_tableId: string, _hasPremiumAccess: boolean): TableAnalysisResponse {
    throw ApiError.notFound(
      'Legacy demo analysis is disabled. Use the authenticated /api/v1/ds/tables endpoints for live provider data.',
      'LEGACY_ANALYSIS_DISABLED'
    );
  }
}

export const predictionService = new PredictionService();
