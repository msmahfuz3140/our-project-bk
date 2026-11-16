import {
  SubscriptionPlan,
  UpdatePlanInput,
  CreatePlanInput,
  PLANS_ARRAY
} from '../shared/plans';
import { subscriptionRepository } from '../repositories/subscription.repository';
import { PlanModel, seedPlansIfEmpty, IPlanDocument } from '../models/Plan';
import { SubscriptionModel } from '../models/Subscription';
import { UserModel } from '../models/User';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { cacheKeys, memoryCache } from '../utils/cache';
import mongoose from 'mongoose';

export class SubscriptionService {
  private publicPlansCache: { data: SubscriptionPlan[]; expiry: number } | null = null;
  private allPlansCache: { data: SubscriptionPlan[]; expiry: number } | null = null;
  private readonly CACHE_TTL_MS = 30000; // 30 seconds TTL, invalidated immediately on mutation

  private clearPlanCache(): void {
    this.publicPlansCache = null;
    this.allPlansCache = null;
    memoryCache.del(cacheKeys.publicPlans);
    memoryCache.del(cacheKeys.adminAllPlans);
    memoryCache.del(cacheKeys.adminDashboard);
    memoryCache.del(cacheKeys.publicSettings);
  }

  private mapDocToPlan(doc: any): SubscriptionPlan {
    return {
      id: doc.planId,
      name: doc.name,
      badge: doc.badge,
      description: doc.description,
      priceUsd: Math.round(doc.priceCents / 100),
      priceCents: doc.priceCents,
      duration: doc.duration,
      durationDays: doc.durationDays,
      features: doc.features || [],
      isPopular: !!doc.isPopular,
      isActive: doc.isActive,
      isVisible: doc.isVisible,
      displayOrder: doc.displayOrder ?? 0
    };
  }

  private async ensureDatabaseConnection(): Promise<boolean> {
    if (mongoose.connection.readyState === 1) return true;
    try {
      const { db } = require('../database/connection');
      return await db.connect();
    } catch {
      return false;
    }
  }

  async getPublicPlans(): Promise<SubscriptionPlan[]> {
    await this.ensureDatabaseConnection();

    return memoryCache.getOrSet(cacheKeys.publicPlans, 60, async () => {
      try {
        if (mongoose.connection.readyState === 1) {
          await seedPlansIfEmpty().catch(() => {});
          const docs = await PlanModel.find({ isActive: true, isVisible: true })
            .sort({ displayOrder: 1, priceCents: 1 })
            .lean();

          if (docs && docs.length > 0) {
            return docs.map((doc) => this.mapDocToPlan(doc));
          }
        }
      } catch {
        // Fallback to authoritative static catalog
      }

      return PLANS_ARRAY.filter(p => p.isActive);
    });
  }

  async getAllPlans(): Promise<SubscriptionPlan[]> {
    const now = Date.now();
    if (this.allPlansCache && this.allPlansCache.expiry > now) {
      return this.allPlansCache.data;
    }

    await this.ensureDatabaseConnection();

    try {
      if (mongoose.connection.readyState === 1) {
        await seedPlansIfEmpty().catch(() => {});
        const docs = await PlanModel.find()
          .sort({ displayOrder: 1, priceCents: 1 })
          .lean();

        if (docs && docs.length > 0) {
          const plans = docs.map(d => this.mapDocToPlan(d));
          this.allPlansCache = { data: plans, expiry: now + this.CACHE_TTL_MS };
          return plans;
        }
      }
    } catch {
      // Fallback
    }

    const fallback = PLANS_ARRAY;
    this.allPlansCache = { data: fallback, expiry: now + this.CACHE_TTL_MS };
    return fallback;
  }

  async getPlanById(id: string): Promise<SubscriptionPlan | undefined> {
    const normalized = id.startsWith('PLAN_') ? id : `PLAN_${id.toUpperCase()}`;
    await this.ensureDatabaseConnection();

    try {
      if (mongoose.connection.readyState === 1) {
        await seedPlansIfEmpty().catch(() => {});
        const doc = await PlanModel.findOne({
          $or: [{ planId: id }, { planId: normalized }]
        }).lean();

        if (doc) {
          return this.mapDocToPlan(doc);
        }
      }
    } catch {
      // Fallback
    }

    return PLANS_ARRAY.find(p => p.id === id || p.id === normalized);
  }

  async createPlan(input: CreatePlanInput, adminId?: string): Promise<SubscriptionPlan> {
    if (mongoose.connection.readyState !== 1) {
      throw ApiError.internal('Database is not currently connected');
    }

    await seedPlansIfEmpty();

    const planId = input.id
      ? input.id.trim().toUpperCase().replace(/\s+/g, '_')
      : `PLAN_${input.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

    const existing = await PlanModel.findOne({ planId });
    if (existing) {
      throw ApiError.badRequest(`Plan with identifier "${planId}" already exists`);
    }

    const durationDays = input.durationUnit === 'DAYS'
      ? input.durationValue
      : input.durationValue * 30;

    const count = await PlanModel.countDocuments();
    const displayOrder = input.displayOrder !== undefined ? input.displayOrder : count;

    const doc = await PlanModel.create({
      planId,
      name: input.name.trim(),
      badge: input.badge?.trim() || undefined,
      description: input.description.trim(),
      priceCents: input.priceCents,
      duration: {
        unit: input.durationUnit,
        value: input.durationValue
      },
      durationDays,
      features: input.features || [],
      isPopular: !!input.isPopular,
      isActive: input.isActive !== false,
      isVisible: input.isVisible !== false,
      displayOrder
    });

    this.clearPlanCache();

    if (adminId) {
      const admin = await UserModel.findById(adminId);
      await AuditLogModel.create({
        action: 'PLAN_CREATED',
        adminId: new mongoose.Types.ObjectId(adminId),
        adminEmail: admin?.email || 'admin@rouletteaccuracy.com',
        targetResourceId: planId,
        resourceType: 'SubscriptionPlan',
        reason: `Admin created new plan ${planId}`,
        newValue: {
          planId,
          name: doc.name,
          priceCents: doc.priceCents,
          durationDays: doc.durationDays
        }
      });
    }

    return this.mapDocToPlan(doc);
  }

  async updatePlan(planId: string, input: UpdatePlanInput, adminId?: string): Promise<SubscriptionPlan> {
    if (mongoose.connection.readyState !== 1) {
      throw ApiError.internal('Database is not currently connected');
    }

    await seedPlansIfEmpty();

    const normalized = planId.startsWith('PLAN_') ? planId : `PLAN_${planId.toUpperCase()}`;
    const planDoc = await PlanModel.findOne({
      $or: [{ planId }, { planId: normalized }]
    });
    if (!planDoc) {
      throw ApiError.notFound(`Plan with id ${planId} was not found`);
    }

    const previousPriceCents = planDoc.priceCents;
    const previousState = {
      priceCents: planDoc.priceCents,
      name: planDoc.name,
      isActive: planDoc.isActive,
      isVisible: planDoc.isVisible
    };

    if (input.priceCents !== undefined) {
      if (!Number.isInteger(input.priceCents) || input.priceCents < 100) {
        throw ApiError.badRequest('Price must be a valid positive integer in cents (minimum 100 cents / $1.00)');
      }
      planDoc.priceCents = input.priceCents;
    }

    if (input.name !== undefined) planDoc.name = input.name.trim();
    if (input.badge !== undefined) planDoc.badge = input.badge?.trim() || undefined;
    if (input.description !== undefined) planDoc.description = input.description.trim();
    if (input.features !== undefined) planDoc.features = input.features;
    if (input.isPopular !== undefined) planDoc.isPopular = !!input.isPopular;
    if (input.isActive !== undefined) planDoc.isActive = !!input.isActive;
    if (input.isVisible !== undefined) planDoc.isVisible = !!input.isVisible;
    if (input.displayOrder !== undefined) planDoc.displayOrder = input.displayOrder;
    if (input.durationUnit && input.durationValue) {
      planDoc.duration = {
        unit: input.durationUnit as any,
        value: Number(input.durationValue)
      };
      planDoc.durationDays = input.durationUnit === 'DAYS' ? Number(input.durationValue) : Number(input.durationValue) * 30;
    }

    await planDoc.save();
    this.clearPlanCache();

    if (adminId) {
      const admin = await UserModel.findById(adminId);
      const isPriceChange = input.priceCents !== undefined && input.priceCents !== previousPriceCents;
      await AuditLogModel.create({
        action: isPriceChange ? 'PLAN_PRICE_UPDATE' : 'PLAN_CONFIG_UPDATE',
        adminId: new mongoose.Types.ObjectId(adminId),
        adminEmail: admin?.email || 'admin@rouletteaccuracy.com',
        targetResourceId: planId,
        resourceType: 'SubscriptionPlan',
        reason: (input as any).reason || `Admin updated plan ${planId} configuration / pricing`,
        previousValue: previousState,
        newValue: {
          priceCents: planDoc.priceCents,
          name: planDoc.name,
          isActive: planDoc.isActive,
          isVisible: planDoc.isVisible,
          displayOrder: planDoc.displayOrder
        }
      });
    }

    return this.mapDocToPlan(planDoc);
  }

  async deletePlan(planId: string, adminId?: string): Promise<{ success: boolean; message: string }> {
    if (mongoose.connection.readyState !== 1) {
      throw ApiError.internal('Database is not currently connected');
    }

    const normalized = planId.startsWith('PLAN_') ? planId : `PLAN_${planId.toUpperCase()}`;
    const planDoc = await PlanModel.findOne({
      $or: [{ planId }, { planId: normalized }]
    });

    if (!planDoc) {
      throw ApiError.notFound(`Plan ${planId} not found`);
    }

    const activeSubsCount = await SubscriptionModel.countDocuments({
      planId: { $in: [planId, normalized] },
      status: 'ACTIVE'
    });

    // Never hard-delete a plan that may be referenced by historical payments or
    // subscriptions. Archive it instead so reports remain stable.
    planDoc.isActive = false;
    planDoc.isVisible = false;
    await planDoc.save();

    this.clearPlanCache();

    if (adminId) {
      const admin = await UserModel.findById(adminId);
      await AuditLogModel.create({
        action: 'PLAN_DELETED',
        adminId: new mongoose.Types.ObjectId(adminId),
        adminEmail: admin?.email || 'admin@rouletteaccuracy.com',
        targetResourceId: planId,
        resourceType: 'SubscriptionPlan',
        reason: `Admin deleted or archived plan ${planId}`
      });
    }

    return { success: true, message: `Plan ${planId} removed/archived successfully` };
  }

  async getUserSubscriptions(userId: string) {
    return subscriptionRepository.findByUserId(userId);
  }

  async getUserActiveSubscription(userId: string) {
    return subscriptionRepository.findActiveByUserId(userId);
  }
}

export const subscriptionService = new SubscriptionService();

