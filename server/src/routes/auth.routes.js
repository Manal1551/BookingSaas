import { Router } from 'express';
import { resolveTenant } from '../middleware/resolveTenant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  register,
  login,
  refresh,
  me,
  logout,
} from '../controllers/auth.controller.js';

const router = Router();

// Every auth route is tenant-scoped: it must run under a tenant subdomain.
router.use(resolveTenant);

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', requireAuth, me);

export default router;
