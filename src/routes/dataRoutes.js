const express = require('express');
const DataController = require('../controllers/DataController');

const router = express.Router();
const dataController = new DataController();

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => dataController.healthCheck(req, res));

/**
 * Get performance statistics for a table
 * GET /api/data/:tableName/stats
 */
router.get('/:tableName/stats', (req, res) => dataController.getPerformanceStats(req, res));

/**
 * Get weather reports by specific date
 * GET /api/data/:tableName/date
 * Query params: date (required), timezone, includeTime
 * POST /api/data/:tableName/date (for additional filters in body)
 */
router.get('/:tableName/date', (req, res) => dataController.getByDate(req, res));
router.post('/:tableName/date', (req, res) => dataController.getByDate(req, res));

/**
 * Get count of records for a table
 * GET /api/data/:tableName/count
 * Query params: startDate, endDate
 */
router.get('/:tableName/count', (req, res) => dataController.getCount(req, res));
router.post('/:tableName/count', (req, res) => dataController.getCount(req, res));

/**
 * Query data from a table (supports both GET and POST for complex queries)
 * GET /api/data/:tableName
 * Query params: startDate, endDate, limit, offset, orderBy, orderDirection, useCache
 */
router.get('/:tableName', (req, res) => dataController.queryData(req, res));

/**
 * Query data with POST body for complex filters
 * POST /api/data/:tableName/query
 */
router.post('/:tableName/query', (req, res) => dataController.queryData(req, res));

/**
 * Advanced search with complex filtering
 * POST /api/data/:tableName/search
 */
router.post('/:tableName/search', (req, res) => dataController.advancedSearch(req, res));

/**
 * Clear cache for a specific table
 * DELETE /api/data/:tableName/cache
 */
router.delete('/:tableName/cache', (req, res) => dataController.clearCache(req, res));

module.exports = router;
