import { SubscriptionModel } from '../models/Subscription';
import { toolSettingsService } from './toolSettings.service';
import { dsProxyService, DsProxyError } from './dsProxy.service';
import { logger } from '../utils/logger';

export class ToolAdminService {
  /**
   * Get tool telemetry for the admin console. Live table data now comes from
   * the configured Dealer Signature API instead of hardcoded demo tables.
   */
  async getToolTelemetry(): Promise<any> {
    const settings = await toolSettingsService.getAdminToolSettings();
    const now = new Date();

    const [activeSubscribersCount, totalEligibleUsers] = await Promise.all([
      SubscriptionModel.countDocuments({
        status: 'ACTIVE',
        isRevoked: { $ne: true },
        endDate: { $gt: now }
      }),
      SubscriptionModel.distinct('userId', {
        status: 'ACTIVE',
        isRevoked: { $ne: true },
        endDate: { $gt: now }
      })
    ]);

    let tables: any[] = [];
    let liveTablesCount = 0;
    let dsStatus: any = {
      configured: settings.dsApiKeyConfigured && !!settings.dsApiUrl,
      connected: false,
      message: settings.dsApiKeyConfigured
        ? 'Waiting for the first API request'
        : 'API credentials are not configured'
    };

    if (settings.dsApiKeyConfigured && settings.dsApiUrl) {
      try {
        const response = await dsProxyService.getTables({ limit: 200, sort: 'active' });
        const payload = response?.data || {};
        const rows = Array.isArray(payload.tables) ? payload.tables : [];
        liveTablesCount = typeof payload.total === 'number' ? payload.total : rows.length;
        tables = rows.map((t: any) => ({
          id: t.id,
          name: t.name,
          provider: t.provider,
          dealer: t.dealer,
          isLive: true,
          recentNumbers: Array.isArray(t.spins) ? t.spins.slice(0, 12) : [],
          activeStrategy: 'DEALER_SIGNATURE',
          spinCount: t.spin_count ?? (Array.isArray(t.spins) ? t.spins.length : 0),
          accuracyCw: t.accuracy_cw,
          accuracyCcw: t.accuracy_ccw,
          bestAccuracy: t.best_accuracy,
          bestDirection: t.best_direction,
          wlLast10: Array.isArray(t.wl_last_10) ? t.wl_last_10 : [],
          pattern: t.pattern,
          ready: t.ready,
          updatedAt: t.updated_at
        }));
        dsStatus = {
          configured: true,
          connected: true,
          message: `Connected — ${liveTablesCount} live table${liveTablesCount === 1 ? '' : 's'}`,
          feed: payload.feed
        };
      } catch (err: any) {
        const code = err instanceof DsProxyError ? err.code : 'DS_PROXY_ERROR';
        const message = err?.message || 'Unable to load live tables from the provider API';
        dsStatus = { configured: true, connected: false, code, message };
        logger.warn(`Admin tool telemetry could not load live tables: ${code} ${message}`);
      }
    }

    return {
      settings,
      liveTablesCount,
      activeSubscribersWithAccess: activeSubscribersCount,
      uniqueUsersWithAccess: totalEligibleUsers.length,
      dsStatus,
      strategyDistribution: {
        OFFSET: 0,
        TARGET: 0,
        DEALER_SIGNATURE: 0
      },
      tables,
      telemetryNotice: {
        disclaimer:
          'The Roulette Prediction Suite executes deterministic statistical modelling based on verified physical wheel travel and the provider API analysis. No outcome is guaranteed, and no simulator or fabricated win-rate is used.'
      }
    };
  }
}

export const toolAdminService = new ToolAdminService();
