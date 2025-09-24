const ScheduledMigrationService = require('./src/services/ScheduledMigrationService');

/**
 * AWS Lambda handler for scheduled migration
 */
exports.handler = async (event, context) => {
  console.log('Scheduled migration Lambda triggered');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const migrationService = new ScheduledMigrationService();
    
    // Check if specific table is requested
    const tableName = event.tableName;
    
    if (tableName) {
      console.log(`Running migration for specific table: ${tableName}`);
      
      // Run migration for specific table
      const result = await migrationService.runTableMigration(tableName);
      
      console.log(`Migration completed for ${tableName}:`, result);

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: `Migration completed successfully for ${tableName}`,
          tableName,
          result
        })
      };
    } else {
      console.log('Running full scheduled migration for all tables');
      
      // Run the full scheduled migration
      const result = await migrationService.runScheduledMigration();

      console.log('Scheduled migration completed:', result);

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'Scheduled migration completed successfully',
          result
        })
      };
    }

  } catch (error) {
    console.error('Scheduled migration failed:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
        stack: error.stack
      })
    };
  }
};
