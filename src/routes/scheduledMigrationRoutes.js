const express = require('express');
const ScheduledMigrationController = require('../controllers/ScheduledMigrationController');

const router = express.Router();
const migrationController = new ScheduledMigrationController();

/**
 * Health check for scheduled migration service
 */
router.get('/health', (req, res) => migrationController.healthCheck(req, res));

/**
 * Get migration status and schedule information
 * GET /api/scheduled-migration/status
 */
router.get('/status', (req, res) => migrationController.getStatus(req, res));

/**
 * Get migration insights and statistics
 * GET /api/scheduled-migration/insights
 */
router.get('/insights', (req, res) => migrationController.getInsights(req, res));

/**
 * Update migration configuration
 * PUT /api/scheduled-migration/config
 */
router.put('/config', (req, res) => migrationController.updateConfig(req, res));

/**
 * Enable or disable scheduled migration
 * POST /api/scheduled-migration/toggle
 */
router.post('/toggle', (req, res) => migrationController.toggleSchedule(req, res));

/**
 * Update schedule interval
 * POST /api/scheduled-migration/interval
 */
router.post('/interval', (req, res) => migrationController.updateInterval(req, res));

/**
 * Trigger migration manually (force run)
 * POST /api/scheduled-migration/trigger
 */
router.post('/trigger', (req, res) => migrationController.triggerMigration(req, res));

/**
 * Get recent migration logs
 * GET /api/scheduled-migration/logs
 */
router.get('/logs', (req, res) => migrationController.getLogs(req, res));

/**
 * Get specific log file content
 * GET /api/scheduled-migration/logs/:filename
 */
router.get('/logs/:filename', (req, res) => migrationController.getLogContent(req, res));

module.exports = router;
