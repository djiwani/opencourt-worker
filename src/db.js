const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { Pool } = require('pg');

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

let pool;

async function getPool() {
  if (pool) return pool;

  const secret = await secretsClient.send(new GetSecretValueCommand({
    SecretId: process.env.DB_SECRET_ARN
  }));

  const creds = JSON.parse(secret.SecretString);

  pool = new Pool({
    host:     creds.host,
    port:     creds.port || 5432,
    database: creds.dbname,
    user:     creds.username,
    password: creds.password,
    max:      5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected DB pool error:', err.message);
  });

  console.log('Database connection pool established');
  return pool;
}

async function query(text, params) {
  const db = await getPool();
  return db.query(text, params);
}

module.exports = { query };
