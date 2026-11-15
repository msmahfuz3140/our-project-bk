import mongoose from 'mongoose';
import { ToolSettingsModel, IToolSettings, ToolAccessPolicy } from '../models/ToolSettings';
import { UserModel } from '../models/User';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { UserRole } from '../shared/roles';
import { logger } from '../utils/logger';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../utils/crypto';

export interface AdminToolSettingsView {
  id: string;
  isToolEnabled: boolean;
  maintenanceMode: boolean;
  publicStatusMessage: string;
  toolVersion: string;
  toolAccessPolicy: ToolAccessPolicy;
  premiumRequirements: string;
  dsApiUrl: string;
  dsApiKeyConfigured: boolean;
  dsApiKeyMasked: string;
  dsLastTestAt?: string;
  dsLastTestSuccess?: boolean;
  dsLastTestMessage?: string;
  dsLastTestLatencyMs?: number;
  dsLastRequestAt?: string;
  dsLastSuccessAt?: string;
  dsLastErrorAt?: string;
  dsLastError?: string;
  dsLastStatusCode?: number;
  dsLastRequestId?: string;
  updatedByAdminEmail?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface DsRequestResult {
  ok: boolean;
  statusCode?: number;
  requestId?: string;
  error?: string;
}

function iso(value?: Date | null): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function normalizePublicApiUrl(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return '';

  // Accept a URL with or without a trailing slash or a /api/v1 suffix.
  value = value.replace(/\/+$/, '');
  if (value.endsWith('/api/v1')) value = value.slice(0, -'/api/v1'.length);
  else if (value.endsWith('/api')) value = value.slice(0, -'/api'.length);
  value = value.replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw ApiError.badRequest(
      'API Public URL must be a valid absolute URL, for example https://api.yourdomain.com'
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw ApiError.badRequest('API Public URL must use http:// or https://');
  }
  if (!parsed.hostname) {
    throw ApiError.badRequest('API Public URL must include a hostname');
  }

  return value;
}

export class ToolSettingsService {
  /**
   * Get public-facing tool operational status. Never includes credentials.
   */
  async getPublicToolStatus(): Promise<{
    isToolEnabled: boolean;
    maintenanceMode: boolean;
    publicStatusMessage: string;
    toolVersion: string;
    toolAccessPolicy: ToolAccessPolicy;
    dsApiConfigured: boolean;
  }> {
    const settings = await ToolSettingsModel.getSettings();
    const credentials = await this.getDsApiCredentials();
    return {
      isToolEnabled: settings.isToolEnabled,
      maintenanceMode: settings.maintenanceMode,
      publicStatusMessage: settings.publicStatusMessage,
      toolVersion: settings.toolVersion,
      toolAccessPolicy: settings.toolAccessPolicy,
      dsApiConfigured: !!(credentials.dsApiKey && credentials.dsApiUrl)
    };
  }

  /**
   * Get sanitized tool settings for the Admin Panel. The plaintext provider key
   * is never returned over the network.
   */
  async getAdminToolSettings(): Promise<AdminToolSettingsView> {
    const settings = await ToolSettingsModel.getSettings();

    // Transparently migrate credentials saved by older builds as plaintext.
    if (settings.dsApiKey && !isEncryptedSecret(settings.dsApiKey)) {
      const legacyPlaintext = settings.dsApiKey;
      settings.dsApiKey = encryptSecret(legacyPlaintext);
      settings.dsApiKeyLast4 = legacyPlaintext.slice(-4);
      await settings.save().catch(() => undefined);
    }

    const plaintextKey = decryptSecret(settings.dsApiKey);
    const keyReadable = !settings.dsApiKey || !!plaintextKey;
    const last4 =
      settings.dsApiKeyLast4 ||
      (plaintextKey ? plaintextKey.slice(-4) : '');

    return {
      id: settings._id.toString(),
      isToolEnabled: settings.isToolEnabled,
      maintenanceMode: settings.maintenanceMode,
      publicStatusMessage: settings.publicStatusMessage,
      toolVersion: settings.toolVersion,
      toolAccessPolicy: settings.toolAccessPolicy,
      premiumRequirements: settings.premiumRequirements,
      dsApiUrl: settings.dsApiUrl || '',
      dsApiKeyConfigured: !!settings.dsApiKey && keyReadable,
      dsApiKeyMasked: settings.dsApiKey
        ? keyReadable
          ? `sk_live_••••••••${last4}`
          : 'sk_live_•••• (decryption failed — re-enter the key)'
        : '',
      dsLastTestAt: iso(settings.dsLastTestAt),
      dsLastTestSuccess: settings.dsLastTestSuccess,
      dsLastTestMessage: settings.dsLastTestMessage || '',
      dsLastTestLatencyMs: settings.dsLastTestLatencyMs,
      dsLastRequestAt: iso(settings.dsLastRequestAt),
      dsLastSuccessAt: iso(settings.dsLastSuccessAt),
      dsLastErrorAt: iso(settings.dsLastErrorAt),
      dsLastError: settings.dsLastError || '',
      dsLastStatusCode: settings.dsLastStatusCode,
      dsLastRequestId: settings.dsLastRequestId || '',
      updatedByAdminEmail: settings.updatedByAdminEmail,
      updatedAt: iso(settings.updatedAt),
      createdAt: iso(settings.createdAt)
    };
  }

  /**
   * Get decrypted DS API credentials for internal proxy use only.
   */
  async getDsApiCredentials(): Promise<{ dsApiKey: string; dsApiUrl: string }> {
    const settings = await ToolSettingsModel.getSettings();
    if (settings.dsApiKey && !isEncryptedSecret(settings.dsApiKey)) {
      const legacyPlaintext = settings.dsApiKey;
      settings.dsApiKey = encryptSecret(legacyPlaintext);
      settings.dsApiKeyLast4 = legacyPlaintext.slice(-4);
      await settings.save().catch(() => undefined);
    }
    return {
      dsApiKey: decryptSecret(settings.dsApiKey),
      dsApiUrl: settings.dsApiUrl || ''
    };
  }

  /**
   * Lightweight diagnostics shared by the admin API Settings screen.
   */
  async getDsDiagnostics(): Promise<AdminToolSettingsView> {
    return this.getAdminToolSettings();
  }

  /**
   * Persist the outcome of the latest proxied API request. This powers the
   * "Last Successful Request" and "Last Error" panels in the admin console.
   */
  async recordDsRequest(result: DsRequestResult): Promise<void> {
    const now = new Date();
    const update: Record<string, unknown> = {
      dsLastRequestAt: now,
      dsLastStatusCode: result.statusCode
    };

    if (result.requestId) {
      update.dsLastRequestId = result.requestId;
    }

    if (result.ok) {
      update.dsLastSuccessAt = now;
    } else {
      update.dsLastErrorAt = now;
      update.dsLastError = (result.error || 'Unknown provider error').slice(0, 1000);
    }

    // Fire-and-forget: diagnostics must never break a prediction request.
    ToolSettingsModel.updateOne({}, { $set: update }).catch((err) => {
      logger.debug('Failed to persist DS request diagnostics', err);
    });
  }

  /**
   * Persist the result of an explicit "Test API Connection" action.
   */
  async saveDsTestResult(result: {
    success: boolean;
    message: string;
    latencyMs?: number;
    statusCode?: number;
  }): Promise<void> {
    const now = new Date();
    await ToolSettingsModel.updateOne(
      {},
      {
        $set: {
          dsLastTestAt: now,
          dsLastTestSuccess: result.success,
          dsLastTestMessage: result.message.slice(0, 1000),
          dsLastTestLatencyMs: result.latencyMs,
          dsLastRequestAt: now,
          ...(result.statusCode !== undefined ? { dsLastStatusCode: result.statusCode } : {}),
          ...(result.success
            ? { dsLastSuccessAt: now }
            : { dsLastErrorAt: now, dsLastError: result.message.slice(0, 1000) })
        }
      }
    ).catch((err) => {
      logger.debug('Failed to persist DS connection test result', err);
    });
  }

  /**
   * Update tool settings with mandatory audit trail. Provider credentials are
   * encrypted before persistence; a blank key field means "keep the existing
   * key" so the admin UI never needs to receive the plaintext secret.
   */
  async updateToolSettings(
    adminId: string,
    adminEmail: string,
    updates: {
      isToolEnabled?: boolean;
      maintenanceMode?: boolean;
      publicStatusMessage?: string;
      toolVersion?: string;
      toolAccessPolicy?: ToolAccessPolicy;
      premiumRequirements?: string;
      dsApiKey?: string;
      dsApiUrl?: string;
      clearDsApiKey?: boolean;
    },
    reason: string
  ): Promise<AdminToolSettingsView> {
    if (!reason || reason.trim() === '') {
      throw ApiError.badRequest('Audit reason is strictly required when modifying tool operational settings');
    }

    const admin = await UserModel.findById(adminId);
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Only authorized Main Admins can change tool operational settings');
    }

    const settings = await ToolSettingsModel.getSettings();
    const previousSnapshot = {
      isToolEnabled: settings.isToolEnabled,
      maintenanceMode: settings.maintenanceMode,
      publicStatusMessage: settings.publicStatusMessage,
      toolVersion: settings.toolVersion,
      toolAccessPolicy: settings.toolAccessPolicy,
      premiumRequirements: settings.premiumRequirements,
      dsApiKey: settings.dsApiKey ? '***MASKED***' : '',
      dsApiUrl: settings.dsApiUrl
    };

    if (updates.isToolEnabled !== undefined) {
      settings.isToolEnabled = Boolean(updates.isToolEnabled);
    }
    if (updates.maintenanceMode !== undefined) {
      settings.maintenanceMode = Boolean(updates.maintenanceMode);
    }
    if (updates.publicStatusMessage !== undefined) {
      settings.publicStatusMessage = updates.publicStatusMessage.trim();
    }
    if (updates.toolVersion !== undefined) {
      settings.toolVersion = updates.toolVersion.trim();
    }
    if (updates.toolAccessPolicy !== undefined) {
      settings.toolAccessPolicy = updates.toolAccessPolicy;
    }
    if (updates.premiumRequirements !== undefined) {
      settings.premiumRequirements = updates.premiumRequirements.trim();
    }

    if (updates.clearDsApiKey === true) {
      settings.dsApiKey = '';
      settings.dsApiKeyLast4 = '';
      settings.dsLastTestSuccess = undefined;
      settings.dsLastTestMessage = 'Stored API key removed by administrator';
    } else if (updates.dsApiKey !== undefined) {
      const incoming = updates.dsApiKey.trim();
      const looksMasked = incoming.includes('•') || incoming.includes('***');
      // Blank / masked input keeps the existing key. This is intentional: the
      // admin form never receives the plaintext key back from the server.
      if (incoming && !looksMasked) {
        settings.dsApiKey = encryptSecret(incoming);
        settings.dsApiKeyLast4 = incoming.slice(-4);
        settings.dsLastTestSuccess = undefined;
        settings.dsLastTestMessage = 'Credentials updated. Run Test API Connection.';
        settings.dsLastError = '';
        settings.dsLastErrorAt = undefined;
      }
    }

    if (updates.dsApiUrl !== undefined) {
      const normalizedUrl = normalizePublicApiUrl(updates.dsApiUrl);
      if (normalizedUrl !== settings.dsApiUrl) {
        settings.dsLastTestSuccess = undefined;
        settings.dsLastTestMessage = 'API URL updated. Run Test API Connection.';
      }
      settings.dsApiUrl = normalizedUrl;
    }

    settings.updatedByAdminId = new mongoose.Types.ObjectId(adminId);
    settings.updatedByAdminEmail = adminEmail;
    await settings.save();

    await AuditLogModel.create({
      action: 'TOOL_SETTINGS_UPDATE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      reason: reason.trim(),
      previousValue: previousSnapshot,
      newValue: {
        isToolEnabled: settings.isToolEnabled,
        maintenanceMode: settings.maintenanceMode,
        publicStatusMessage: settings.publicStatusMessage,
        toolVersion: settings.toolVersion,
        toolAccessPolicy: settings.toolAccessPolicy,
        premiumRequirements: settings.premiumRequirements,
        dsApiKey: settings.dsApiKey ? '***MASKED***' : '',
        dsApiUrl: settings.dsApiUrl
      },
      details: {
        note: 'Operational status updated. Authentication and subscriber records remain strictly intact.'
      }
    });

    logger.info(
      `Main Admin ${adminEmail} updated tool settings. Enabled: ${settings.isToolEnabled}, Maintenance: ${settings.maintenanceMode}. Reason: ${reason}`
    );

    return this.getAdminToolSettings();
  }
}

export const toolSettingsService = new ToolSettingsService();
