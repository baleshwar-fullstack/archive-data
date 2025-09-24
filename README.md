# AWS Lambda Migration Scheduler

A serverless migration scheduler for automatically archiving old data from MySQL to AWS S3 Glacier Instant Retrieval. Supports migration of `weather_reports` and `project_hours` tables.

## 🎯 Features

- **Automatic Data Archiving**: Move old data from MySQL to S3 Glacier Instant Retrieval
- **Multi-Table Support**: Migrates `weather_reports` and `project_hours` tables
- **Scheduled Migration**: Automatic daily migration with 1-hour intervals via AWS Lambda
- **Manual Migration**: Trigger migrations on-demand
- **Parquet Optimization**: Archived data stored in optimized Parquet format
- **AWS Athena Integration**: SQL analytics on archived data via Athena
- **Year-based Partitioning**: Optimized S3 structure for efficient queries
- **Serverless Architecture**: Runs on AWS Lambda with no server management

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│   Recent Data   │    │    Archived Data     │    │   Migration Layer   │
│   (< 2 years)   │    │    (> 2 years)       │    │                     │
│                 │    │                      │    │                     │
│   MySQL DB      │───▶│  S3 Glacier IR       │◀───│  AWS Lambda Scheduler│
│   - Fast access │    │  - Cost effective    │    │  - Scheduled runs    │
│   - Real-time   │    │  - Parquet format    │    │  - Manual triggers   │
│   - Full speed  │    │  - Year partitioned  │    │  - Athena analytics  │
└─────────────────┘    └──────────────────────┘    └─────────────────────┘
```

## 📋 Prerequisites

- Node.js 16+ 
- MySQL 5.7+
- AWS Account with S3 access
- AWS IAM permissions for S3 and Athena

## 🚀 Quick Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Create a `.env` file:
```bash
# Database Configuration
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=root
DB_PASSWORD=P@ssword
DB_NAME=cdr

# AWS Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
S3_BUCKET=your-weather-archive-bucket
S3_ARCHIVE_PREFIX=weather-reports/

# Athena Configuration
ATHENA_OUTPUT_BUCKET=your-weather-archive-bucket
ATHENA_OUTPUT_PREFIX=temp-results/
ATHENA_DATABASE=weather_archive
ATHENA_WORKGROUP=primary
ATHENA_IMMEDIATE_CLEANUP=true

# Application Configuration
PORT=3000
ARCHIVE_THRESHOLD_YEARS=2
MIGRATION_BATCH_SIZE=1000
```

### 3. Start the Application
```bash
# Development mode
npm run dev

# Production mode
npm start
```

## 📊 Supported Tables

The system migrates the following tables:

### Weather Reports Table
```sql
CREATE TABLE weather_reports (
  id bigint NOT NULL AUTO_INCREMENT,
  project_id int NOT NULL,
  quarter enum('0','1','2') NOT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  day_forecast text NOT NULL,
  PRIMARY KEY (id),
  KEY project_id (project_id),
  KEY created_at (created_at)
);
```

### Project Hours Table
```sql
CREATE TABLE project_hours (
  id bigint NOT NULL AUTO_INCREMENT,
  project_id bigint NOT NULL,
  user_id bigint NOT NULL,
  name varchar(255) NOT NULL,
  quantity bigint NOT NULL,
  hours double NOT NULL,
  total_hours double NOT NULL,
  description text,
  submission_date date NOT NULL,
  to_delete int DEFAULT 0,
  has_no_work int DEFAULT 0,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY (id),
  KEY project_id (project_id),
  KEY created_at (created_at)
);
```

## 🔄 Data Migration

### Manual Migration
```bash
# Preview what will be migrated (safe)
npm run migrate:weather:dry
npm run migrate:project_hours:dry

# Execute migration
npm run migrate:weather
npm run migrate:project_hours

# Verify migrated data
npm run verify:weather
npm run verify:project_hours
```

### Scheduled Migration (Daily with 1-Hour Intervals)
```bash
# Enable automatic migration
npm run migration:enable

# Check migration status
npm run migration:status

# View migration logs
npm run migration:logs

# Generate cron job configuration
npm run migration:cron
```

## 🚀 AWS Lambda Deployment

### Deploy to AWS Lambda
```bash
# Deploy to development
npm run lambda:deploy:dev

# Deploy to production
npm run lambda:deploy:prod

# Get deployment information
npm run lambda:info:dev

# View logs
npm run lambda:logs:dev
```

### Lambda Functions
- **weatherReportsMigration**: Runs daily at midnight US/California time (12:00 AM)
- **projectHoursMigration**: Runs daily at 1:00 AM US/California time (1:00 AM)

### Manual Lambda Invocation
```bash
# Trigger weather_reports migration via Lambda
npm run lambda:migrate:weather:dev

# Trigger project_hours migration via Lambda
npm run lambda:migrate:project_hours:dev

# View logs for specific table
npm run lambda:logs:weather:dev
npm run lambda:logs:project_hours:dev
```

## 📈 Analytics with AWS Athena

### Query Archived Data
The system automatically creates Athena tables for archived data:

```sql
-- Count archived records by year (weather_reports)
SELECT archive_year, COUNT(*) as record_count
FROM archive_database.weather_reports_archive
GROUP BY archive_year;

-- Weather patterns by quarter
SELECT quarter, COUNT(*) as reports, 
       AVG(LENGTH(day_forecast)) as avg_forecast_length
FROM archive_database.weather_reports_archive
WHERE archive_year = 2020
GROUP BY quarter;

-- Count archived records by year (project_hours)
SELECT archive_year, COUNT(*) as record_count
FROM archive_database.project_hours_archive
GROUP BY archive_year;

-- Project hours analysis
SELECT project_id, SUM(total_hours) as total_hours,
       COUNT(*) as entries
FROM archive_database.project_hours_archive
WHERE archive_year BETWEEN 2020 AND 2022
GROUP BY project_id
ORDER BY total_hours DESC;
```

## 💾 S3 Storage Structure

Archived data is organized by table and year for optimal performance:
```
your-archive-bucket/
├── archived-data/
│   ├── weather_reports/
│   │   ├── year=2020/
│   │   │   ├── data_1640995200000.parquet
│   │   │   └── data_1640995260000.parquet
│   │   ├── year=2021/
│   │   └── year=2022/
│   └── project_hours/
│       ├── year=2020/
│       │   ├── data_1640995200000.parquet
│       │   └── data_1640995260000.parquet
│       ├── year=2021/
│       └── year=2022/
└── temp-results/          # Athena query results (auto-deleted)
    ├── query_abc123.csv   # Temporary files
    └── query_def456.csv   # Cleaned up immediately
```

## ⚙️ Configuration Options

### Archive Settings
```bash
# Data older than this gets archived
ARCHIVE_THRESHOLD_YEARS=2

# Number of records to migrate per batch
MIGRATION_BATCH_SIZE=1000

# S3 folder structure
S3_ARCHIVE_PREFIX=archived-data/

# Supported tables for migration
SUPPORTED_TABLES=weather_reports,project_hours
```

### Athena Settings
```bash
# Database for archived data
ATHENA_DATABASE=archive_database

# Temporary query results (auto-cleaned)
ATHENA_OUTPUT_PREFIX=temp-results/

# Immediate cleanup of query results
ATHENA_IMMEDIATE_CLEANUP=true
```

## 💰 Cost Benefits

### Storage Costs
- **MySQL**: ~$0.20/GB/month (fast, expensive)
- **S3 Glacier IR**: ~$0.004/GB/month (96% savings)

### Example Savings
For 100GB of historical data (weather_reports + project_hours):
- **Before**: $20/month (all in MySQL)
- **After**: $0.40/month (in S3 Glacier)
- **Annual Savings**: $235

### Query Costs
- **Athena**: ~$5 per TB of data scanned
- **Parquet**: ~90% compression vs raw data
- **Partitioning**: Query only needed years

## 🔒 Security

- **IAM Policies**: Least-privilege S3 and Athena access
- **Encryption**: S3 Server-Side Encryption (SSE-S3)
- **API Security**: Ready for authentication middleware
- **Data Privacy**: No sensitive data in logs

## 📱 Monitoring

### Lambda Function Logs
```bash
# View migration logs
npm run lambda:logs:dev

# View specific function logs
serverless logs -f scheduledMigration --stage dev --tail
serverless logs -f migrationTrigger --stage dev --tail
```

### Migration Status
```bash
# Check migration status locally
npm run migration:status

# View migration logs
npm run migration:logs
```

### CloudWatch Monitoring
- **Lambda Metrics**: Duration, errors, invocations
- **S3 Metrics**: Storage usage and requests
- **Athena Metrics**: Query performance and costs

## 🚨 Troubleshooting

### Common Issues

**Database Connection Failed**
```bash
# Check MySQL is running
mysql -h 127.0.0.1 -P 3307 -u root -p

# Verify credentials in .env file
```

**AWS Access Denied**
```bash
# Check AWS credentials
aws s3 ls s3://your-bucket --profile default

# Verify IAM permissions for S3 and Athena
```

**Migration Not Working**
```bash
# Check migration status
npm run migration:status

# View detailed logs
npm run migration:logs

# Test Lambda functions
npm run lambda:migrate:dev

# Check CloudWatch logs
npm run lambda:logs:dev
```

## 🎯 Development

### Project Structure
```
src/
├── config/               # Database and AWS configuration
├── scripts/             # Migration and Lambda handlers
├── services/            # Business logic
└── utils/               # Logging and utilities
```

### Key Services
- **DataRouterService**: Migration routing and validation
- **S3ArchiveService**: Parquet archival and retrieval
- **AthenaService**: SQL analytics on archived data
- **MySQLService**: Database operations
- **ScheduledMigrationService**: Automated migration scheduling

## 📝 License

MIT License - See LICENSE file for details

---

## 🎉 Quick Start Summary

1. **Setup**: Create `.env` with your database and AWS credentials
2. **Test Migration**: `npm run migrate:weather:dry` (preview) then `npm run migrate:weather`
3. **Deploy Lambda**: `npm run lambda:deploy:dev`
4. **Schedule**: Enable scheduled migration in `config/migration-schedule.json` (weather_reports at 12:00 AM, project_hours at 1:00 AM US/California)
5. **Monitor**: `npm run lambda:logs:dev` to view CloudWatch logs
6. **Analyze**: Use Athena SQL queries on archived data

**Your data migration system is now running on AWS Lambda!** 🚀💰

For support, check the CloudWatch logs and Lambda function metrics in AWS Console.