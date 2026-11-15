import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/subscriptionAccess.middleware';
import { dsProxyService, DsProxyError } from '../services/dsProxy.service';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Send a consistent error envelope while preserving the upstream status code
 * where it is meaningful to the browser (rate limit, feed unavailable, etc.).
 */
function handleDsError(err: any, res: Response): void {
  if (err instanceof DsProxyError) {
    res.status(err.httpStatus).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details
      },
      meta: {
        upstream_status: err.upstreamStatus,
        request_id: err.requestId
      }
    });
    return;
  }

  if (err?.message === 'DS_NOT_CONFIGURED') {
    res.status(503).json({
      success: false,
      error: {
        code: 'DS_NOT_CONFIGURED',
        message:
          'Dealer Signature API is not configured. Admin must set the API key and URL in Admin → Settings → API Settings.'
      }
    });
    return;
  }

  logger.error('DS Proxy error:', err);
  res.status(502).json({
    success: false,
    error: {
      code: 'DS_PROXY_ERROR',
      message: err?.message || 'Failed to communicate with the Dealer Signature API'
    }
  });
}

/**
 * GET /ds/config - Public, credential-free readiness check used by the UI.
 */
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const config = await dsProxyService.isConfigured();
    res.json({
      success: true,
      data: {
        // Only readiness is public. The provider URL and key are admin-only.
        configured: config.configured
      }
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: { code: 'DS_CONFIG_CHECK_FAILED', message: err?.message || 'Failed to check API configuration' }
    });
  }
});

// All remaining DS routes require authentication + an active subscription
// (or an administrative role, handled by the subscription access service).
router.use(requireAuth);
router.use(requireActiveSubscription);

/**
 * GET /ds/status - DS API service status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const result = await dsProxyService.getStatus(req.headers.origin);
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * GET /ds/tables - List all live tables
 */
router.get('/tables', async (req: Request, res: Response) => {
  try {
    const { provider, search, filter, sort, window, limit } = req.query;
    const result = await dsProxyService.getTables(
      {
        provider: provider as string,
        search: search as string,
        filter: filter as string,
        sort: sort as string,
        window: window ? Number(window) : undefined,
        limit: limit ? Number(limit) : undefined
      },
      req.headers.origin
    );
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * GET /ds/tables/:tableId - One table with its latest spins
 */
router.get('/tables/:tableId', async (req: Request, res: Response) => {
  try {
    const result = await dsProxyService.getTable(
      String(req.params.tableId),
      req.headers.origin
    );
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * GET /ds/tables/:tableId/prediction - Prediction + W/L + structures + travel
 */
router.get('/tables/:tableId/prediction', async (req: Request, res: Response) => {
  try {
    const tableId = String(req.params.tableId);
    const { direction, window } = req.query;
    const result = await dsProxyService.getTablePrediction(
      tableId,
      direction as string,
      window ? Number(window) : undefined,
      req.headers.origin
    );
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * GET /ds/tables/:tableId/rhythm - Dealer rhythm (direction-independent)
 */
router.get('/tables/:tableId/rhythm', async (req: Request, res: Response) => {
  try {
    const result = await dsProxyService.getTableRhythm(
      String(req.params.tableId),
      req.headers.origin
    );
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * GET /ds/tables/:tableId/travel-chart - Direction-aware travel chart data
 */
router.get('/tables/:tableId/travel-chart', async (req: Request, res: Response) => {
  try {
    const tableId = String(req.params.tableId);
    const { direction, window } = req.query;
    const result = await dsProxyService.getTableTravelChart(
      tableId,
      direction as string,
      window ? Number(window) : undefined,
      req.headers.origin
    );
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * GET /ds/tables/:tableId/pattern - W/L structures and pattern data
 */
router.get('/tables/:tableId/pattern', async (req: Request, res: Response) => {
  try {
    const tableId = String(req.params.tableId);
    const { direction, window } = req.query;
    const result = await dsProxyService.getTablePattern(
      tableId,
      direction as string,
      window ? Number(window) : undefined,
      req.headers.origin
    );
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * GET /ds/tables/:tableId/history - Dealer session history
 */
router.get('/tables/:tableId/history', async (req: Request, res: Response) => {
  try {
    const tableId = String(req.params.tableId);
    const { period, page, limit, window } = req.query;
    const result = await dsProxyService.getTableHistory(
      tableId,
      {
        period: period as string,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        window: window ? Number(window) : undefined
      },
      req.headers.origin
    );
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

/**
 * POST /ds/scanner - Rank all tables
 */
router.post('/scanner', async (req: Request, res: Response) => {
  try {
    const result = await dsProxyService.scanTables(req.body, req.headers.origin);
    res.json(result);
  } catch (err: any) {
    handleDsError(err, res);
  }
});

export const dsProxyRoutes = router;
