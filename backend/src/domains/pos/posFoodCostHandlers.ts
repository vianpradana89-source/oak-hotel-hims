/**
 * OAK HIMS — MP-04E Express Controllers for Food Cost & Menu Engineering
 */

import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  getProductFoodCostAnalysis,
  getFoodCostOverview,
  getMenuEngineeringReport,
} from './posFoodCostService';

export interface FoodCostHandlerDeps {
  pool: Pool;
  assertPropertyScope?: (req: any, resOrPropId: any, maybePropId?: any) => Promise<void>;
}

async function invokeAssertPropertyScope(
  fn: FoodCostHandlerDeps['assertPropertyScope'],
  req: any,
  res: any,
  propertyId: number
): Promise<void> {
  if (typeof fn !== 'function') return;
  if (fn.length >= 3) {
    await (fn as (req: any, res: any, propertyId: number) => Promise<void>)(req, res, propertyId);
  } else {
    await (fn as (req: any, propertyId: number) => Promise<void>)(req, propertyId);
  }
}

export function createFoodCostHandlers(deps: FoodCostHandlerDeps) {
  const getProductFoodCostHandler = async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).user?.property_id || 1);
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);

      const productId = Number(req.params.id);
      if (!productId || isNaN(productId)) {
        return res.status(400).json({
          status: 'ERROR',
          error: 'Parameter product_id tidak valid',
          code: 'INVALID_PRODUCT_ID',
        });
      }

      const analysis = await getProductFoodCostAnalysis(deps.pool, propertyId, productId);
      return res.status(200).json({ status: 'OK', data: analysis });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({
        status: 'ERROR',
        error: err.message || 'Gagal menghitung food cost produk',
        code: err.code || 'FOOD_COST_CALCULATION_ERROR',
      });
    }
  };

  const getFoodCostOverviewHandler = async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).user?.property_id || 1);
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);

      const categoryId = req.query.category_id ? Number(req.query.category_id) : undefined;
      const status = (req.query.status as any) || undefined;
      const search = req.query.search ? String(req.query.search) : undefined;

      const overview = await getFoodCostOverview(deps.pool, propertyId, {
        categoryId,
        status,
        search,
      });

      return res.status(200).json({ status: 'OK', data: overview });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({
        status: 'ERROR',
        error: err.message || 'Gagal memuat ringkasan food cost',
        code: err.code || 'FOOD_COST_OVERVIEW_ERROR',
      });
    }
  };

  const getMenuEngineeringHandler = async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).user?.property_id || 1);
      await invokeAssertPropertyScope(deps.assertPropertyScope, req, res, propertyId);

      const startDate = req.query.start_date ? String(req.query.start_date) : undefined;
      const endDate = req.query.end_date ? String(req.query.end_date) : undefined;
      const categoryId = req.query.category_id ? Number(req.query.category_id) : undefined;

      const report = await getMenuEngineeringReport(
        deps.pool,
        propertyId,
        startDate,
        endDate,
        categoryId
      );

      return res.status(200).json({ status: 'OK', data: report });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).json({
        status: 'ERROR',
        error: err.message || 'Gagal menyusun laporan menu engineering',
        code: err.code || 'MENU_ENGINEERING_REPORT_ERROR',
      });
    }
  };

  return {
    getProductFoodCostHandler,
    getFoodCostOverviewHandler,
    getMenuEngineeringHandler,
  };
}
