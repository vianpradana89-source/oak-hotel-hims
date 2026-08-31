import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  getTransactions,
  getTransactionById,
  createManualTransaction,
  createPurchaseTransaction,
  createExpenseTransaction,
  createIncomeTransaction,
  verifyTransaction,
  updatePurchaseReceivingStatus,
  settleTransactionPayment,
  getCustomCategories,
  createCustomCategory,
  toggleCustomCategory,
  voidTransaction,
  softDeleteTransaction,
  reconcileHistoricalTransactions,
  addTransactionAttachment,
  deleteTransactionAttachment,
  TRANSACTION_CATEGORIES,
  DEPARTMENTS
} from './transactionService';
import {
  TransactionFilterParams,
  TransactionType,
  TransactionStatus,
  VerificationStatus,
  ReceivingStatus,
  AttachmentPurpose
} from './transactionTypes';

const txUploadDir = path.join(__dirname, '..', '..', '..', 'uploads', 'transactions');
fs.mkdirSync(txUploadDir, { recursive: true });

const txStorage = multer.diskStorage({
  destination: (_req: any, _file: any, cb: (error: Error | null, destination: string) => void) => {
    cb(null, txUploadDir);
  },
  filename: (_req: any, file: any, cb: (error: Error | null, filename: string) => void) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.pdf'].includes(ext) ? ext : '.jpg';
    const safeName = `tx-att-${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`;
    cb(null, safeName);
  }
});

const uploadAttachment = multer({
  storage: txStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req: any, file: any, cb: any) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Tipe file tidak didukung. Harap unggah file JPG, PNG, atau PDF.'));
  }
});

export function createTransactionsRouter(pool: Pool): Router {
  const router = Router();

  /**
   * GET /api/transactions/categories
   * Returns list of transaction categories (system + active custom) and departments for UI dropdowns.
   */
  router.get('/categories', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).propertyId || 1);
      const systemCategories = Object.entries(TRANSACTION_CATEGORIES).map(([code, meta]) => ({
        code,
        name: meta.name,
        type: meta.type,
        default_department: meta.defaultDept,
        allow_manual: meta.allowManual,
        is_custom: false,
        is_active: true
      }));

      const customRows = await getCustomCategories(pool, propertyId);
      const customCategories = customRows
        .filter(c => c.is_active)
        .map(c => ({
          code: c.code,
          name: c.name,
          type: c.transaction_type as TransactionType,
          default_department: c.department_code,
          allow_manual: true,
          is_custom: true,
          is_active: true
        }));

      return res.json({
        success: true,
        data: {
          categories: [...systemCategories, ...customCategories],
          departments: DEPARTMENTS
        }
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/transactions/categories/custom
   * List custom categories.
   */
  router.get('/categories/custom', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).propertyId || 1);
      const type = req.query.type ? (String(req.query.type).toUpperCase() as TransactionType) : undefined;
      const categories = await getCustomCategories(pool, propertyId, type);
      return res.json({ success: true, data: categories });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/transactions/categories/custom
   * Create a new custom category.
   */
  router.post('/categories/custom', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || (req as any).propertyId || 1);
      const { code, name, transaction_type, department_code } = req.body;

      const created = await createCustomCategory(pool, {
        property_id: propertyId,
        code,
        name,
        transaction_type: (transaction_type || 'EXPENSE').toUpperCase(),
        department_code: department_code || 'GENERAL'
      });

      return res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  /**
   * PATCH /api/transactions/categories/custom/:code/toggle
   * Toggle active state of a custom category.
   */
  router.patch('/categories/custom/:code/toggle', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || (req as any).propertyId || 1);
      const updated = await toggleCustomCategory(pool, propertyId, req.params.code, req.body.actor_name);
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/transactions
   * Query transactions with filter params.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).propertyId || 1);
      if (!propertyId || isNaN(propertyId)) {
        return res.status(400).json({ success: false, error: 'property_id is required' });
      }

      const params: TransactionFilterParams = {
        property_id: propertyId,
        transaction_type: req.query.transaction_type ? (String(req.query.transaction_type).toUpperCase() as TransactionType) : undefined,
        source_type: req.query.source_type ? String(req.query.source_type) : undefined,
        category_code: req.query.category_code ? String(req.query.category_code) : undefined,
        department_code: req.query.department_code ? String(req.query.department_code) : undefined,
        payment_status: req.query.payment_status ? String(req.query.payment_status) : undefined,
        payment_method: req.query.payment_method ? String(req.query.payment_method) : undefined,
        transaction_status: req.query.transaction_status ? (String(req.query.transaction_status).toUpperCase() as TransactionStatus) : undefined,
        verification_status: req.query.verification_status ? (String(req.query.verification_status).toUpperCase() as VerificationStatus) : undefined,
        receiving_status: req.query.receiving_status ? (String(req.query.receiving_status).toUpperCase() as ReceivingStatus) : undefined,
        operational_status: req.query.operational_status ? String(req.query.operational_status).toUpperCase() : undefined,
        operational_sheet: req.query.operational_sheet ? String(req.query.operational_sheet).toUpperCase() : undefined,
        start_date: req.query.start_date ? String(req.query.start_date) : undefined,
        end_date: req.query.end_date ? String(req.query.end_date) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
        party_name: req.query.party_name ? String(req.query.party_name) : undefined,
        reservation_id: req.query.reservation_id ? Number(req.query.reservation_id) : undefined,
        booking_id: req.query.booking_id ? String(req.query.booking_id) : undefined,
        supplier_id: req.query.supplier_id ? Number(req.query.supplier_id) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      };

      const result = await getTransactions(pool, params);
      return res.json({
        success: true,
        data: result
      });
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * GET /api/transactions/:id
   * Get detail of a transaction.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.query.property_id || (req as any).propertyId || 1);
      const id = req.params.id;

      const tx = await getTransactionById(pool, propertyId, id);
      return res.json({
        success: true,
        data: tx
      });
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/purchases
   * Dedicated Pembelian (Purchase) creation with multi-line items.
   */
  router.post('/purchases', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const created = await createPurchaseTransaction(pool, {
        property_id: propertyId,
        transaction_date: req.body.transaction_date,
        supplier_id: req.body.supplier_id,
        supplier_name: req.body.supplier_name,
        supplier_phone: req.body.supplier_phone,
        supplier_bank_name: req.body.supplier_bank_name,
        supplier_bank_account: req.body.supplier_bank_account,
        supplier_address: req.body.supplier_address,
        source_reference: req.body.source_reference,
        receiving_status: req.body.receiving_status,
        received_at: req.body.received_at,
        department_code: req.body.department_code,
        description: req.body.description,
        lines: req.body.lines || [],
        transaction_discount: req.body.transaction_discount,
        rounding_amount: req.body.rounding_amount,
        payment_method: req.body.payment_method,
        paid_amount: req.body.paid_amount,
        notes: req.body.notes,
        actor_name: req.body.actor_name || (req as any).user?.name || 'Staff',
        actor_user_id: req.body.actor_user_id || (req as any).user?.id || null
      });

      return res.status(201).json({
        success: true,
        message: 'Transaksi pembelian berhasil dibuat',
        data: created
      });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/expenses
   * Dedicated Pengeluaran (Expense) creation.
   */
  router.post('/expenses', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const created = await createExpenseTransaction(pool, {
        property_id: propertyId,
        transaction_date: req.body.transaction_date,
        category_code: req.body.category_code,
        category_name: req.body.category_name,
        department_code: req.body.department_code,
        supplier_id: req.body.supplier_id,
        party_name: req.body.party_name,
        description: req.body.description,
        amount: Number(req.body.amount),
        payment_method: req.body.payment_method,
        source_reference: req.body.source_reference,
        is_paid: req.body.is_paid !== false,
        notes: req.body.notes,
        actor_name: req.body.actor_name || (req as any).user?.name || 'Staff',
        actor_user_id: req.body.actor_user_id || (req as any).user?.id || null
      });

      return res.status(201).json({
        success: true,
        message: 'Transaksi pengeluaran berhasil dibuat',
        data: created
      });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/incomes
   * Dedicated Pemasukan Manual (Income) creation.
   */
  router.post('/incomes', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const created = await createIncomeTransaction(pool, {
        property_id: propertyId,
        transaction_date: req.body.transaction_date,
        category_code: req.body.category_code,
        category_name: req.body.category_name,
        department_code: req.body.department_code,
        customer_name: req.body.customer_name || req.body.party_name,
        phone: req.body.phone,
        description: req.body.description,
        amount: Number(req.body.amount),
        payment_method: req.body.payment_method || 'CASH',
        source_reference: req.body.source_reference,
        lines: req.body.lines,
        notes: req.body.notes,
        actor_name: req.body.actor_name || (req as any).user?.name || 'Staff',
        actor_user_id: req.body.actor_user_id || (req as any).user?.id || null
      });

      return res.status(201).json({
        success: true,
        message: 'Transaksi pemasukan berhasil dibuat',
        data: created
      });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/:id/verify
   * Verify or reject a transaction.
   */
  router.post('/:id/verify', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const id = req.params.id;
      const { verification_status, verification_note, actor_name, actor_user_id } = req.body;

      const updated = await verifyTransaction(pool, id, {
        property_id: propertyId,
        verification_status,
        verification_note,
        actor_name: actor_name || (req as any).user?.name || 'Supervisor',
        actor_user_id: actor_user_id || (req as any).user?.id || null
      });

      return res.json({
        success: true,
        message: `Status verifikasi transaksi berhasil diubah menjadi ${verification_status}`,
        data: updated
      });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * PATCH /api/transactions/:id/receiving
   * Update purchase physical receiving status.
   */
  router.patch('/:id/receiving', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const id = req.params.id;
      const { receiving_status, received_at, actor_name, actor_user_id } = req.body;

      const updated = await updatePurchaseReceivingStatus(pool, id, {
        property_id: propertyId,
        receiving_status,
        received_at,
        actor_name: actor_name || (req as any).user?.name || 'Staff',
        actor_user_id: actor_user_id || (req as any).user?.id || null
      });

      return res.json({
        success: true,
        message: `Status penerimaan berhasil diubah menjadi ${receiving_status}`,
        data: updated
      });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/:id/settle
   * Record a settlement payment against transaction.
   */
  router.post('/:id/settle', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const id = req.params.id;
      const { amount, payment_method, notes, actor_name, actor_user_id } = req.body;

      const updated = await settleTransactionPayment(pool, id, {
        property_id: propertyId,
        amount: Number(amount),
        payment_method: payment_method || 'TRANSFER',
        notes,
        actor_name: actor_name || (req as any).user?.name || 'Staff',
        actor_user_id: actor_user_id || (req as any).user?.id || null
      });

      return res.json({
        success: true,
        message: 'Pelunasan transaksi berhasil dicatat',
        data: updated
      });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/manual
   * Create a manual transaction (Generic).
   */
  router.post('/manual', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const {
        transaction_type,
        category_code,
        category_name,
        department_code,
        description,
        amount,
        party_name,
        source_reference,
        payment_method,
        notes,
        actor_name,
        actor_user_id
      } = req.body;

      const created = await createManualTransaction(pool, {
        property_id: propertyId,
        transaction_type,
        category_code,
        category_name,
        department_code,
        description,
        amount: Number(amount),
        party_name,
        source_reference,
        payment_method,
        notes,
        actor_name: actor_name || (req as any).user?.name || 'Staff',
        actor_user_id: actor_user_id || (req as any).user?.id || null
      });

      return res.status(201).json({
        success: true,
        message: 'Transaksi berhasil dicatat',
        data: created
      });
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/:id/attachments
   * Upload purpose-aware attachment for a transaction.
   */
  router.post('/:id/attachments', (req: Request, res: Response) => {
    uploadAttachment.single('file')(req as any, res as any, async (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ success: false, error: 'Ukuran file melebihi batas maksimum 10MB' });
        }
        return res.status(400).json({ success: false, error: err.message || 'Gagal mengunggah file' });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'File bukti transaksi wajib disertakan' });
      }

      try {
        const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
        const transactionId = req.params.id;
        const actorName = req.body.actor_name || (req as any).user?.name || 'Staff';
        const purpose: AttachmentPurpose = req.body.attachment_purpose || 'RECEIPT';

        const storagePath = `/uploads/transactions/${req.file.filename}`;

        const createdAttachment = await addTransactionAttachment(pool, propertyId, transactionId, {
          fileName: req.file.filename,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          fileSize: req.file.size,
          storagePath,
          uploadedBy: actorName,
          attachmentPurpose: purpose
        });

        return res.status(201).json({
          success: true,
          message: 'Bukti transaksi berhasil diunggah',
          data: createdAttachment
        });
      } catch (uploadErr: any) {
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        return res.status(uploadErr.statusCode || 500).json({
          success: false,
          error: uploadErr.message
        });
      }
    });
  });

  /**
   * DELETE /api/transactions/:id/attachments/:attachmentId
   * Delete an attachment from a transaction with verification safety.
   */
  router.delete('/:id/attachments/:attachmentId', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const transactionId = req.params.id;
      const attachmentId = req.params.attachmentId;
      const actorName = req.body.actor_name || (req as any).user?.name || 'Staff';

      await deleteTransactionAttachment(pool, propertyId, transactionId, attachmentId, actorName);

      return res.json({
        success: true,
        message: 'Bukti transaksi berhasil dihapus'
      });
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/:id/void
   * Void a transaction with compensating reversal.
   */
  router.post('/:id/void', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const id = req.params.id;
      const { reason, actor_name, actor_user_id } = req.body;

      const result = await voidTransaction(pool, propertyId, id, {
        reason: reason || 'Pembatalan manual oleh pengguna',
        actorName: actor_name || (req as any).user?.name || 'Staff',
        actorUserId: actor_user_id || (req as any).user?.id || null
      });

      return res.json({
        success: true,
        message: 'Transaksi berhasil dibatalkan',
        data: result
      });
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/:id/soft-delete
   * Soft-delete an eligible draft transaction to move it to the HAPUS sheet.
   */
  router.post('/:id/soft-delete', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const id = req.params.id;
      const { delete_reason, actor_name, actor_user_id } = req.body;

      if (!delete_reason || !delete_reason.trim()) {
        return res.status(400).json({ success: false, error: 'Alasan hapus wajib diisi' });
      }

      const result = await softDeleteTransaction(pool, propertyId, id, {
        property_id: propertyId,
        delete_reason: delete_reason.trim(),
        actor_name: actor_name || (req as any).user?.name || 'Staff',
        actor_user_id: actor_user_id || (req as any).user?.id || null
      });

      return res.json({
        success: true,
        message: 'Draft transaksi berhasil dipindahkan ke sheet Hapus',
        data: result
      });
    } catch (err: any) {
      return res.status(err.statusCode || 400).json({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * POST /api/transactions/reconcile
   * Dry-run or active historical projection reconciliation.
   */
  router.post('/reconcile', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.body.property_id || req.query.property_id || (req as any).propertyId || 1);
      const dryRun = req.body.dry_run !== false;

      const result = await reconcileHistoricalTransactions(pool, propertyId, dryRun);
      return res.json({
        success: true,
        data: result
      });
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.message
      });
    }
  });

  return router;
}
