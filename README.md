# Weather Data Tiered Storage System

A Node.js application for automatically archiving old weather data from MySQL to AWS S3 Glacier Instant Retrieval, with seamless query capabilities across both storage tiers.

## 🎯 Features

- **Automatic Data Archiving**: Move weather data older than 2 years to S3 Glacier
- **Tiered Storage**: Keep recent data in MySQL for fast access, archive old data for cost savings
- **Seamless Querying**: API automatically routes queries to appropriate storage (MySQL or S3)
- **Parquet Optimization**: Archived data stored in optimized Parquet format for analytics
- **AWS Athena Integration**: SQL analytics on archived data via Athena
- **Scheduled Migration**: Automatic 6-month migration cycles
- **Year-based Partitioning**: Optimized S3 structure for efficient queries
- **Direct Results**: No permanent storage of query results - always fresh data

## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│   Recent Data   │    │    Archived Data     │    │    Query Layer      │
│   (< 2 years)   │    │    (> 2 years)       │    │                     │
│                 │    │                      │    │                     │
│   MySQL DB      │───▶│  S3 Glacier IR       │◀───│  Smart Data Router  │
│   - Fast access │    │  - Cost effective    │    │  - Route by date    │
│   - Real-time   │    │  - Parquet format    │    │  - Seamless API     │
│   - Full speed  │    │  - Year partitioned  │    │  - Athena analytics │
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

## 📊 Weather Reports Table Structure

The system works with a `weather_reports` table:
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

## 🔄 Data Migration

### Manual Migration
```bash
# Preview what will be migrated (safe)
npm run migrate:weather:dry

# Execute migration
npm run migrate:weather

# Verify migrated data
npm run verify:weather
```

### Scheduled Migration (Every 6 Months)
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

## 🔍 API Endpoints

### Data Access

#### Get Weather Reports by Specific Date
```bash
# Get all reports for a specific date (simple)
GET /api/data/weather_reports/date?date=2023-01-15

# Get reports with timezone support
GET /api/data/weather_reports/date?date=2023-01-15&timezone=America/New_York

# Get reports with time precision (1-minute window)
GET /api/data/weather_reports/date?date=2023-01-15T14:30:00&includeTime=true

# Complex date query with additional filters (POST)
POST /api/data/weather_reports/date?date=2023-01-15
Content-Type: application/json
{
  "filters": {
    "projectId": 1,
    "quarter": "1"
  },
  "options": {
    "limit": 50,
    "orderBy": "created_at",
    "orderDirection": "ASC"
  }
}

# Supported date formats:
# - YYYY-MM-DD (2023-01-15)
# - YYYY/MM/DD (2023/01/15)  
# - MM/DD/YYYY (01/15/2023)
# - ISO strings (2023-01-15T14:30:00Z)
# - Unix timestamps (1673784600)
```

#### General Data Access
```bash
# Get weather statistics
GET /api/data/weather_reports/stats

# Count records
GET /api/data/weather_reports/count

# Query with filters
POST /api/data/weather_reports/search
Content-Type: application/json
{
  "filters": {
    "startDate": "2020-01-01",
    "endDate": "2023-12-31",
    "projectId": 1
  },
  "options": {
    "limit": 100,
    "orderBy": "created_at"
  }
}
```

### Migration Management
```bash
# Migration status
GET /api/scheduled-migration/status

# Trigger migration
POST /api/scheduled-migration/trigger

# View logs
GET /api/scheduled-migration/logs
```

## 📈 Analytics with AWS Athena

### Query Archived Data
The system automatically creates Athena tables for archived data:

```sql
-- Count archived records by year
SELECT archive_year, COUNT(*) as record_count
FROM weather_archive.weather_reports_archive
GROUP BY archive_year;

-- Weather patterns by quarter
SELECT quarter, COUNT(*) as reports, 
       AVG(LENGTH(day_forecast)) as avg_forecast_length
FROM weather_archive.weather_reports_archive
WHERE archive_year = 2020
GROUP BY quarter;

-- Top projects by forecast volume
SELECT project_id, COUNT(*) as forecasts
FROM weather_archive.weather_reports_archive
WHERE archive_year BETWEEN 2020 AND 2022
GROUP BY project_id
ORDER BY forecasts DESC;
```

## 💾 S3 Storage Structure

Archived data is organized by year for optimal performance:
```
your-weather-archive-bucket/
├── weather-reports/
│   ├── year=2020/
│   │   ├── data_1640995200000.parquet
│   │   └── data_1640995260000.parquet
│   ├── year=2021/
│   │   └── data_1672531200000.parquet
│   └── year=2022/
│       └── data_1704067200000.parquet
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
S3_ARCHIVE_PREFIX=weather-reports/
```

### Athena Settings
```bash
# Database for archived data
ATHENA_DATABASE=weather_archive

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
For 100GB of historical weather data:
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

### Health Check
```bash
curl http://localhost:3000/api/data/health
```

### Migration Status
```bash
curl http://localhost:3000/api/scheduled-migration/status
```

### Performance Stats
```bash
curl http://localhost:3000/api/data/weather_reports/stats
```

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
```

## 🎯 Development

### Project Structure
```
src/
├── app.js                 # Express application
├── config/               # Database and AWS configuration
├── controllers/          # Request handlers
├── routes/              # API route definitions
├── scripts/             # Migration and utility scripts
├── services/            # Business logic
└── utils/               # Logging and utilities
```

### Key Services
- **DataRouterService**: Smart query routing (MySQL vs S3)
- **S3ArchiveService**: Parquet archival and retrieval
- **AthenaService**: SQL analytics on archived data
- **MySQLService**: Database operations
- **ScheduledMigrationService**: Automated migration

## 📝 License

MIT License - See LICENSE file for details

---

## 🎉 Quick Start Summary

1. **Setup**: Create `.env` with your database and AWS credentials
2. **Start**: `npm run dev`
3. **Test**: `curl http://localhost:3000/api/data/health`
4. **Migrate**: `npm run migrate:weather:dry` (preview) then `npm run migrate:weather`
5. **Schedule**: `npm run migration:enable`
6. **Analyze**: Use Athena SQL queries on archived data

**Your weather data is now automatically optimized for cost and performance!** 🌦️💰

For support, check the API documentation at `http://localhost:3000/api` when running.