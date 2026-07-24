import { Router } from 'express';
import { checkSlug, createTenant } from '../controllers/tenant.controller.js';

const router = Router();

// Served on the ROOT domain (signup flow) — NOT behind resolveTenant.
router.get('/check-slug/:slug', checkSlug);
router.post('/', createTenant);

export default router;
